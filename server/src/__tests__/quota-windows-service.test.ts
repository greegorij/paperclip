import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../adapters/registry.js", () => ({
  listServerAdapters: vi.fn(),
}));

import { listServerAdapters } from "../adapters/registry.js";
import {
  PAPERCLIP_DISABLE_EXTERNAL_QUOTA_PROBES,
  fetchAllQuotaWindows,
} from "../services/quota-windows.js";

describe("fetchAllQuotaWindows", () => {
  const previousDisableProbes = process.env[PAPERCLIP_DISABLE_EXTERNAL_QUOTA_PROBES];

  beforeEach(() => {
    vi.useFakeTimers();
    // Aggregator behavior tests need probes enabled; harness setup disables them globally.
    delete process.env[PAPERCLIP_DISABLE_EXTERNAL_QUOTA_PROBES];
  });

  afterEach(() => {
    if (previousDisableProbes === undefined) {
      delete process.env[PAPERCLIP_DISABLE_EXTERNAL_QUOTA_PROBES];
    } else {
      process.env[PAPERCLIP_DISABLE_EXTERNAL_QUOTA_PROBES] = previousDisableProbes;
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns empty results without probing when external quota probes are disabled", async () => {
    process.env[PAPERCLIP_DISABLE_EXTERNAL_QUOTA_PROBES] = "1";
    const getQuotaWindows = vi.fn().mockResolvedValue({
      provider: "anthropic",
      ok: true,
      windows: [],
    });
    vi.mocked(listServerAdapters).mockReturnValue([
      {
        type: "claude_local",
        getQuotaWindows,
      },
    ] as never);

    await expect(fetchAllQuotaWindows()).resolves.toEqual([]);
    expect(listServerAdapters).not.toHaveBeenCalled();
    expect(getQuotaWindows).not.toHaveBeenCalled();
  });

  it("returns adapter results without waiting for a slower provider to finish forever", async () => {
    vi.mocked(listServerAdapters).mockReturnValue([
      {
        type: "codex_local",
        getQuotaWindows: vi.fn().mockResolvedValue({
          provider: "openai",
          source: "codex-rpc",
          ok: true,
          windows: [{ label: "5h limit", usedPercent: 2, resetsAt: null, valueLabel: null, detail: null }],
        }),
      },
      {
        type: "claude_local",
        getQuotaWindows: vi.fn(() => new Promise(() => {})),
      },
    ] as never);

    const promise = fetchAllQuotaWindows();
    await vi.advanceTimersByTimeAsync(20_001);
    const results = await promise;

    expect(results).toEqual([
      {
        provider: "openai",
        source: "codex-rpc",
        ok: true,
        windows: [{ label: "5h limit", usedPercent: 2, resetsAt: null, valueLabel: null, detail: null }],
      },
      {
        provider: "anthropic",
        ok: false,
        error: "quota polling timed out after 20s",
        windows: [],
      },
    ]);
  });
});
