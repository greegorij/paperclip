import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderQuotaResult, QuotaWindow } from "@paperclipai/adapter-utils";
import {
  createQuotaWindowCache,
  isProviderRateLimitError,
  resetClaudeQuotaCacheForTests,
} from "./quota.js";

const SAMPLE_WINDOWS: QuotaWindow[] = [
  {
    label: "Current session",
    usedPercent: 42,
    resetsAt: "2026-08-07T23:00:00.000Z",
    valueLabel: null,
    detail: null,
  },
  {
    label: "Current week (all models)",
    usedPercent: 71,
    resetsAt: "2026-08-14T00:00:00.000Z",
    valueLabel: null,
    detail: null,
  },
];

function okResult(windows: QuotaWindow[] = SAMPLE_WINDOWS): ProviderQuotaResult {
  return {
    provider: "anthropic",
    source: "anthropic-oauth",
    ok: true,
    windows,
  };
}

describe("quota window cache", () => {
  beforeEach(() => {
    resetClaudeQuotaCacheForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T12:00:00.000Z"));
  });

  afterEach(() => {
    resetClaudeQuotaCacheForTests();
    vi.useRealTimers();
  });

  it("two calls within the success TTL hit the provider once (counter)", async () => {
    const cache = createQuotaWindowCache();
    let providerCalls = 0;
    const fetchFn = vi.fn(async () => {
      providerCalls += 1;
      return okResult();
    });

    const first = await cache.read("anthropic", fetchFn);
    const second = await cache.read("anthropic", fetchFn);

    expect(providerCalls).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.windows).toEqual(SAMPLE_WINDOWS);
    expect(second.windows).toEqual(SAMPLE_WINDOWS);
    expect(first.fetchedAt).toBe("2026-08-07T12:00:00.000Z");
    expect(second.fetchedAt).toBe("2026-08-07T12:00:00.000Z");
  });

  it("a call after the success TTL expires issues a new provider query", async () => {
    const cache = createQuotaWindowCache();
    let providerCalls = 0;
    const fetchFn = vi.fn(async () => {
      providerCalls += 1;
      return okResult([
        {
          ...SAMPLE_WINDOWS[0]!,
          usedPercent: providerCalls === 1 ? 10 : 90,
        },
      ]);
    });

    const first = await cache.read("anthropic", fetchFn);
    expect(providerCalls).toBe(1);

    vi.advanceTimersByTime(60_001);

    const second = await cache.read("anthropic", fetchFn);
    expect(providerCalls).toBe(2);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(first.windows[0]?.usedPercent).toBe(10);
    expect(second.windows[0]?.usedPercent).toBe(90);
    expect(second.fetchedAt).toBe("2026-08-07T12:01:00.001Z");
  });

  it("five concurrent calls share one in-flight provider query", async () => {
    const cache = createQuotaWindowCache();
    let providerCalls = 0;
    let resolveFetch!: (value: ProviderQuotaResult) => void;
    const fetchFn = vi.fn(
      () =>
        new Promise<ProviderQuotaResult>((resolve) => {
          providerCalls += 1;
          resolveFetch = resolve;
        }),
    );

    const pending = Promise.all([
      cache.read("anthropic", fetchFn),
      cache.read("anthropic", fetchFn),
      cache.read("anthropic", fetchFn),
      cache.read("anthropic", fetchFn),
      cache.read("anthropic", fetchFn),
    ]);

    // Allow the first fetchFn invocation to start.
    await Promise.resolve();
    expect(providerCalls).toBe(1);

    resolveFetch(okResult());
    const results = await pending;

    expect(providerCalls).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(5);
    for (const result of results) {
      expect(result.windows).toEqual(SAMPLE_WINDOWS);
      expect(result.fetchedAt).toBe("2026-08-07T12:00:00.000Z");
    }
  });

  it("after a 429, the next call in the backoff window does not hit the provider and returns the last good read marked stale", async () => {
    const cache = createQuotaWindowCache();
    let providerCalls = 0;
    const fetchFn = vi.fn(async () => {
      providerCalls += 1;
      if (providerCalls === 1) return okResult();
      throw new Error("anthropic usage api returned 429");
    });

    const good = await cache.read("anthropic", fetchFn);
    expect(good.ok).toBe(true);
    expect(good.degraded).toBeFalsy();
    expect(providerCalls).toBe(1);

    // Expire the success cache so the next read attempts the provider.
    vi.advanceTimersByTime(60_001);

    const rateLimited = await cache.read("anthropic", fetchFn);
    expect(providerCalls).toBe(2);
    expect(rateLimited.ok).toBe(true);
    expect(rateLimited.windows).toEqual(SAMPLE_WINDOWS);
    expect(rateLimited.fetchedAt).toBe(good.fetchedAt);
    expect(rateLimited.degraded).toMatch(/stale|nieśwież|rate.?limit|429/i);

    // Still inside the 60s backoff — must not call the provider again.
    vi.advanceTimersByTime(30_000);
    const duringBackoff = await cache.read("anthropic", fetchFn);
    expect(providerCalls).toBe(2);
    expect(duringBackoff.ok).toBe(true);
    expect(duringBackoff.windows).toEqual(SAMPLE_WINDOWS);
    expect(duringBackoff.windows).not.toEqual([]);
    expect(duringBackoff.degraded).toMatch(/stale|nieśwież|rate.?limit|429/i);
    expect(duringBackoff.fetchedAt).toBe(good.fetchedAt);
  });

  it("three consecutive 429s grow the backoff and stop at the 300s ceiling", async () => {
    const cache = createQuotaWindowCache();
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return okResult();
      throw new Error("anthropic usage api returned 429");
    });

    await cache.read("anthropic", fetch); // seed last-good
    expect(calls).toBe(1);

    // 1st 429 → 60s backoff
    vi.advanceTimersByTime(60_001);
    await cache.read("anthropic", fetch);
    expect(calls).toBe(2);
    vi.advanceTimersByTime(59_999);
    await cache.read("anthropic", fetch);
    expect(calls).toBe(2);
    vi.advanceTimersByTime(1);
    await cache.read("anthropic", fetch);
    expect(calls).toBe(3); // 2nd 429 → 120s

    vi.advanceTimersByTime(119_999);
    await cache.read("anthropic", fetch);
    expect(calls).toBe(3);
    vi.advanceTimersByTime(1);
    await cache.read("anthropic", fetch);
    expect(calls).toBe(4); // 3rd 429 → 300s ceiling

    vi.advanceTimersByTime(299_999);
    await cache.read("anthropic", fetch);
    expect(calls).toBe(4);
    vi.advanceTimersByTime(1);
    await cache.read("anthropic", fetch);
    expect(calls).toBe(5); // 4th 429 → still 300s

    vi.advanceTimersByTime(299_999);
    await cache.read("anthropic", fetch);
    expect(calls).toBe(5);
    vi.advanceTimersByTime(1);
    await cache.read("anthropic", fetch);
    expect(calls).toBe(6);

    expect(isProviderRateLimitError(new Error("anthropic usage api returned 429"))).toBe(true);
  });

  it("429 with no prior good read returns an explicit error, not empty windows pretending success", async () => {
    const cache = createQuotaWindowCache();
    const fetchFn = vi.fn(async () => {
      throw new Error("anthropic usage api returned 429");
    });

    const result = await cache.read("anthropic", fetchFn);

    expect(result.ok).toBe(false);
    expect(result.windows).toEqual([]);
    expect(result.error).toMatch(/429|rate.?limit/i);
    // Must not look like a successful empty reading.
    expect(result.ok && result.windows.length === 0).toBe(false);
  });

  it("failed non-429 reads are cached briefly (15s) so a burst does not stampede the provider", async () => {
    const cache = createQuotaWindowCache();
    let providerCalls = 0;
    const fetchFn = vi.fn(async () => {
      providerCalls += 1;
      throw new Error("anthropic usage api returned 500");
    });

    const first = await cache.read("anthropic", fetchFn);
    const second = await cache.read("anthropic", fetchFn);
    expect(providerCalls).toBe(1);
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);

    vi.advanceTimersByTime(15_001);
    await cache.read("anthropic", fetchFn);
    expect(providerCalls).toBe(2);
  });
});
