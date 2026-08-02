import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderQuotaResult } from "@paperclipai/shared";
import {
  clearProviderBudgetPacingCacheForTests,
  computeProviderBudgetPacing,
  getProviderBudgetPacing,
  loadRecentProviderTokenBurn,
  PROVIDER_BUDGET_PACING_CACHE_TTL_MS,
  recentProviderTokenBurnRange,
} from "../services/provider-budget-pacing.js";

const mockFetchAllQuotaWindows = vi.fn<() => Promise<ProviderQuotaResult[]>>();

function createDbStub(tokenRows: Array<{ provider: string; recentTokens: number }>) {
  const groupBy = vi.fn(async () =>
    tokenRows.map((row) => ({
      provider: row.provider,
      recentTokens: row.recentTokens,
    })),
  );
  const where = vi.fn(() => ({ groupBy }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { db: { select } as never, where };
}

describe("provider budget pacing service", () => {
  afterEach(() => {
    clearProviderBudgetPacingCacheForTests();
    vi.restoreAllMocks();
    mockFetchAllQuotaWindows.mockReset();
  });

  it("aggregates quota windows with recent token burn and excludes secrets from the snapshot", async () => {
    mockFetchAllQuotaWindows.mockResolvedValue([
      {
        provider: "anthropic",
        source: "claude-cli",
        ok: true,
        windows: [
          {
            label: "5h",
            usedPercent: 95,
            resetsAt: "2026-08-01T16:00:00.000Z",
            valueLabel: null,
          },
        ],
      },
      {
        provider: "openai",
        source: "codex-rpc",
        ok: false,
        error: "quota polling timed out after 20s",
        windows: [],
      },
    ]);

    const { db } = createDbStub([
      { provider: "anthropic", recentTokens: 2400 },
      { provider: "openai", recentTokens: 120 },
    ]);

    const snapshot = await computeProviderBudgetPacing(db, "company-1", {
      now: new Date("2026-08-01T12:00:00.000Z"),
      fetchQuotaWindows: mockFetchAllQuotaWindows,
    });

    expect(snapshot.companyId).toBe("company-1");
    expect(snapshot.fetchedAt).toBe("2026-08-01T12:00:00.000Z");
    expect(snapshot.source).toContain("claude-cli");
    expect(JSON.stringify(snapshot)).not.toMatch(/sk-|api[_-]?key|secret|token_value/i);

    const anthropic = snapshot.providers.find((row) => row.provider === "anthropic");
    expect(anthropic).toMatchObject({
      mode: "throttle",
      usedPercent: 95,
      recentTokens: 2400,
      burnRatePerHour: 100,
    });

    const openai = snapshot.providers.find((row) => row.provider === "openai");
    expect(openai).toMatchObject({
      mode: "unknown",
      recentTokens: 120,
    });
    expect(openai?.warning).toMatch(/timed out/i);
  });

  it("bounds recent burn history to [now-24h, now) so future timestamps cannot inflate pace", async () => {
    const now = new Date("2026-08-01T12:00:00.000Z");
    expect(recentProviderTokenBurnRange(now)).toEqual({
      since: new Date("2026-07-31T12:00:00.000Z"),
      until: now,
    });

    const { db, where } = createDbStub([]);
    await loadRecentProviderTokenBurn(db, "company-1", now);

    // Range bounds are covered by recentProviderTokenBurnRange above;
    // only assert the query applies a where clause (avoid inspecting Drizzle trees).
    expect(where).toHaveBeenCalledTimes(1);
  });

  it("reuses the short cache and does not re-fetch quota windows within the TTL", async () => {
    mockFetchAllQuotaWindows.mockResolvedValue([
      {
        provider: "anthropic",
        source: "claude-cli",
        ok: true,
        windows: [
          {
            label: "5h",
            usedPercent: 10,
            resetsAt: "2026-08-01T16:00:00.000Z",
            valueLabel: null,
          },
        ],
      },
    ]);
    const { db } = createDbStub([{ provider: "anthropic", recentTokens: 24 }]);
    const now = new Date("2026-08-01T12:00:00.000Z");

    const first = await getProviderBudgetPacing(db, "company-cache", {
      now,
      fetchQuotaWindows: mockFetchAllQuotaWindows,
    });
    const second = await getProviderBudgetPacing(db, "company-cache", {
      now: new Date(now.getTime() + PROVIDER_BUDGET_PACING_CACHE_TTL_MS - 1),
      fetchQuotaWindows: mockFetchAllQuotaWindows,
    });

    expect(second).toBe(first);
    expect(mockFetchAllQuotaWindows).toHaveBeenCalledTimes(1);

    await getProviderBudgetPacing(db, "company-cache", {
      now: new Date(now.getTime() + PROVIDER_BUDGET_PACING_CACHE_TTL_MS + 1),
      fetchQuotaWindows: mockFetchAllQuotaWindows,
    });
    expect(mockFetchAllQuotaWindows).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent getProviderBudgetPacing calls into one quota fetch with the same snapshot", async () => {
    let resolveFetch!: (value: ProviderQuotaResult[]) => void;
    mockFetchAllQuotaWindows.mockImplementation(
      () =>
        new Promise<ProviderQuotaResult[]>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const { db } = createDbStub([{ provider: "anthropic", recentTokens: 24 }]);
    const now = new Date("2026-08-01T12:00:00.000Z");
    const companyId = "company-concurrent";

    const pending = [
      getProviderBudgetPacing(db, companyId, { now, fetchQuotaWindows: mockFetchAllQuotaWindows }),
      getProviderBudgetPacing(db, companyId, { now, fetchQuotaWindows: mockFetchAllQuotaWindows }),
      getProviderBudgetPacing(db, companyId, { now, fetchQuotaWindows: mockFetchAllQuotaWindows }),
    ];

    await vi.waitFor(() => {
      expect(mockFetchAllQuotaWindows).toHaveBeenCalledTimes(1);
    });

    resolveFetch([
      {
        provider: "anthropic",
        source: "claude-cli",
        ok: true,
        windows: [
          {
            label: "5h",
            usedPercent: 10,
            resetsAt: "2026-08-01T16:00:00.000Z",
            valueLabel: null,
          },
        ],
      },
    ]);

    const [first, second, third] = await Promise.all(pending);
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(mockFetchAllQuotaWindows).toHaveBeenCalledTimes(1);
  });

  it("bypassCache skips settled cache but joins an already-running computation", async () => {
    mockFetchAllQuotaWindows.mockResolvedValue([
      {
        provider: "anthropic",
        source: "claude-cli",
        ok: true,
        windows: [
          {
            label: "5h",
            usedPercent: 10,
            resetsAt: "2026-08-01T16:00:00.000Z",
            valueLabel: null,
          },
        ],
      },
    ]);
    const { db } = createDbStub([{ provider: "anthropic", recentTokens: 24 }]);
    const now = new Date("2026-08-01T12:00:00.000Z");
    const companyId = "company-force-refresh";

    await getProviderBudgetPacing(db, companyId, {
      now,
      fetchQuotaWindows: mockFetchAllQuotaWindows,
    });
    expect(mockFetchAllQuotaWindows).toHaveBeenCalledTimes(1);

    let resolveFetch!: (value: ProviderQuotaResult[]) => void;
    mockFetchAllQuotaWindows.mockImplementation(
      () =>
        new Promise<ProviderQuotaResult[]>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const firstRefresh = getProviderBudgetPacing(db, companyId, {
      now,
      fetchQuotaWindows: mockFetchAllQuotaWindows,
      bypassCache: true,
    });
    const secondRefresh = getProviderBudgetPacing(db, companyId, {
      now,
      fetchQuotaWindows: mockFetchAllQuotaWindows,
      bypassCache: true,
    });

    await vi.waitFor(() => {
      expect(mockFetchAllQuotaWindows).toHaveBeenCalledTimes(2);
    });

    resolveFetch([
      {
        provider: "anthropic",
        source: "claude-cli",
        ok: true,
        windows: [
          {
            label: "5h",
            usedPercent: 42,
            resetsAt: "2026-08-01T16:00:00.000Z",
            valueLabel: null,
          },
        ],
      },
    ]);

    const [a, b] = await Promise.all([firstRefresh, secondRefresh]);
    expect(b).toBe(a);
    expect(a.providers[0]?.usedPercent).toBe(42);
    expect(mockFetchAllQuotaWindows).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed in-flight computation; concurrent callers share the rejection and a retry fetches fresh", async () => {
    let rejectFetch!: (reason?: unknown) => void;
    mockFetchAllQuotaWindows.mockImplementation(
      () =>
        new Promise<ProviderQuotaResult[]>((_, reject) => {
          rejectFetch = reject;
        }),
    );
    const { db } = createDbStub([{ provider: "anthropic", recentTokens: 24 }]);
    const now = new Date("2026-08-01T12:00:00.000Z");
    const companyId = "company-failed-inflight";

    const pending = [
      getProviderBudgetPacing(db, companyId, { now, fetchQuotaWindows: mockFetchAllQuotaWindows }),
      getProviderBudgetPacing(db, companyId, { now, fetchQuotaWindows: mockFetchAllQuotaWindows }),
    ];

    await vi.waitFor(() => {
      expect(mockFetchAllQuotaWindows).toHaveBeenCalledTimes(1);
    });

    const failure = new Error("quota fetch failed");
    rejectFetch(failure);

    await expect(Promise.all(pending)).rejects.toThrow("quota fetch failed");
    expect(mockFetchAllQuotaWindows).toHaveBeenCalledTimes(1);

    mockFetchAllQuotaWindows.mockResolvedValue([
      {
        provider: "anthropic",
        source: "claude-cli",
        ok: true,
        windows: [
          {
            label: "5h",
            usedPercent: 10,
            resetsAt: "2026-08-01T16:00:00.000Z",
            valueLabel: null,
          },
        ],
      },
    ]);

    const retry = await getProviderBudgetPacing(db, companyId, {
      now,
      fetchQuotaWindows: mockFetchAllQuotaWindows,
    });
    expect(retry.providers[0]?.usedPercent).toBe(10);
    expect(mockFetchAllQuotaWindows).toHaveBeenCalledTimes(2);
  });
});
