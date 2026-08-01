import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderQuotaResult } from "@paperclipai/shared";
import {
  PROVIDER_AVAILABILITY_BLOCKED_THRESHOLD_PERCENT,
  PROVIDER_AVAILABILITY_CONSTRAINED_THRESHOLD_PERCENT,
  createProviderAvailabilityService,
} from "./provider-availability.js";

function quotaResult(input: ProviderQuotaResult): ProviderQuotaResult {
  return input;
}

function createDeferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("provider availability service", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("treats OpenAI named model windows as non-blocking for the base lane", async () => {
    const service = createProviderAvailabilityService({
      fetchQuotaWindows: async () => [
        quotaResult({
          provider: "openai",
          source: "codex-rpc",
          ok: true,
          windows: [
            { label: "5h limit", usedPercent: 20, resetsAt: "2026-08-01T11:00:00.000Z", valueLabel: null, detail: null },
            { label: "Weekly limit", usedPercent: 40, resetsAt: "2026-08-05T11:00:00.000Z", valueLabel: null, detail: null },
            {
              label: "GPT-5.3-Codex-Spark · Weekly limit",
              usedPercent: PROVIDER_AVAILABILITY_BLOCKED_THRESHOLD_PERCENT,
              resetsAt: "2026-08-07T11:00:00.000Z",
              valueLabel: null,
              detail: null,
            },
          ],
        }),
      ],
    });

    const gate = await service.evaluateAdapterAvailability("codex_local");
    expect(gate.state).toBe("available");

    const snapshot = await service.getSnapshot();
    const openai = snapshot.providers.find((provider) => provider.provider === "openai");
    expect(openai).toBeTruthy();
    const namedWindow = openai?.windows.find((window) => window.label.includes(" · "));
    expect(namedWindow?.requiredByBaseLane).toBe(false);
  });

  it("blocks OpenAI when a base lane window reaches 100% and keeps earliest reset", async () => {
    const service = createProviderAvailabilityService({
      fetchQuotaWindows: async () => [
        quotaResult({
          provider: "openai",
          source: "codex-rpc",
          ok: true,
          windows: [
            {
              label: "5h limit",
              usedPercent: PROVIDER_AVAILABILITY_BLOCKED_THRESHOLD_PERCENT,
              resetsAt: "2026-08-01T09:15:00.000Z",
              valueLabel: null,
              detail: null,
            },
            {
              label: "Weekly limit",
              usedPercent: PROVIDER_AVAILABILITY_BLOCKED_THRESHOLD_PERCENT,
              resetsAt: "2026-08-03T09:15:00.000Z",
              valueLabel: null,
              detail: null,
            },
          ],
        }),
      ],
    });

    const gate = await service.evaluateAdapterAvailability("codex_local");
    expect(gate.state).toBe("blocked");
    expect(gate.earliestResetAt).toBe("2026-08-01T09:15:00.000Z");
  });

  it("blocks Anthropic when session or weekly base windows are exhausted", async () => {
    const service = createProviderAvailabilityService({
      fetchQuotaWindows: async () => [
        quotaResult({
          provider: "anthropic",
          source: "anthropic-usage-api",
          ok: true,
          windows: [
            {
              label: "Current session",
              usedPercent: PROVIDER_AVAILABILITY_BLOCKED_THRESHOLD_PERCENT,
              resetsAt: "2026-08-01T12:00:00.000Z",
              valueLabel: null,
              detail: null,
            },
            {
              label: "Current week (all models)",
              usedPercent: 45,
              resetsAt: "2026-08-06T12:00:00.000Z",
              valueLabel: null,
              detail: null,
            },
            {
              label: "Current week (Sonnet only)",
              usedPercent: PROVIDER_AVAILABILITY_BLOCKED_THRESHOLD_PERCENT,
              resetsAt: "2026-08-06T12:00:00.000Z",
              valueLabel: null,
              detail: null,
            },
          ],
        }),
      ],
    });

    const gate = await service.evaluateAdapterAvailability("claude_local");
    expect(gate.state).toBe("blocked");
  });

  it("returns unknown for incomplete telemetry and does not auto-block", async () => {
    const service = createProviderAvailabilityService({
      fetchQuotaWindows: async () => [
        quotaResult({
          provider: "anthropic",
          source: "anthropic-usage-api",
          ok: true,
          windows: [
            { label: "Current session", usedPercent: null, resetsAt: null, valueLabel: null, detail: null },
          ],
        }),
      ],
    });

    const gate = await service.evaluateAdapterAvailability("claude_local");
    expect(gate.state).toBe("unknown");
    expect(gate.reason).toContain("incomplete");
  });

  it("marks high usage as constrained at the documented threshold", async () => {
    const service = createProviderAvailabilityService({
      fetchQuotaWindows: async () => [
        quotaResult({
          provider: "openai",
          source: "codex-rpc",
          ok: true,
          windows: [
            {
              label: "5h limit",
              usedPercent: PROVIDER_AVAILABILITY_CONSTRAINED_THRESHOLD_PERCENT,
              resetsAt: "2026-08-01T11:00:00.000Z",
              valueLabel: null,
              detail: null,
            },
          ],
        }),
      ],
    });

    const gate = await service.evaluateAdapterAvailability("codex_local");
    expect(gate.state).toBe("constrained");
  });

  it("shares one in-flight quota fetch and respects TTL cache", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T10:00:00.000Z"));

    const firstFetch = createDeferred<ProviderQuotaResult[]>();
    const fetchQuotaWindows = vi
      .fn<() => Promise<ProviderQuotaResult[]>>()
      .mockImplementationOnce(() => firstFetch.promise)
      .mockResolvedValue([
        quotaResult({
          provider: "openai",
          source: "codex-rpc",
          ok: true,
          windows: [
            { label: "5h limit", usedPercent: 10, resetsAt: null, valueLabel: null, detail: null },
          ],
        }),
      ]);

    const service = createProviderAvailabilityService({
      ttlMs: 1_000,
      fetchQuotaWindows,
    });

    const snapshotA = service.getSnapshot();
    const snapshotB = service.getSnapshot();
    expect(fetchQuotaWindows).toHaveBeenCalledTimes(1);

    firstFetch.resolve([
      quotaResult({
        provider: "openai",
        source: "codex-rpc",
        ok: true,
        windows: [
          { label: "5h limit", usedPercent: 10, resetsAt: null, valueLabel: null, detail: null },
        ],
      }),
    ]);
    await Promise.all([snapshotA, snapshotB]);

    await service.getSnapshot();
    expect(fetchQuotaWindows).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-08-01T10:00:01.001Z"));
    await service.getSnapshot();
    expect(fetchQuotaWindows).toHaveBeenCalledTimes(2);
  });
});
