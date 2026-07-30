import { describe, expect, it } from "vitest";
import {
  mapCodexRpcQuota,
  minutesToWindowLabel,
  toCodexAuthProbeDiagnostics,
  type CodexAuthInfo,
} from "./quota.js";

describe("minutesToWindowLabel", () => {
  it("maps 300 minutes to 5h limit and 10080 to Weekly limit", () => {
    expect(minutesToWindowLabel(300, "fallback")).toBe("5h limit");
    expect(minutesToWindowLabel(10_080, "fallback")).toBe("Weekly limit");
  });

  it("uses truthful deterministic labels for other durations", () => {
    expect(minutesToWindowLabel(60, "fallback")).toBe("1h limit");
    expect(minutesToWindowLabel(1_440, "fallback")).toBe("1d limit");
    expect(minutesToWindowLabel(90, "fallback")).toBe("90m limit");
    expect(minutesToWindowLabel(20_160, "fallback")).toBe("14d limit");
  });

  it("falls back when duration is missing or invalid", () => {
    expect(minutesToWindowLabel(null, "5h limit")).toBe("5h limit");
    expect(minutesToWindowLabel(undefined, "Weekly limit")).toBe("Weekly limit");
    expect(minutesToWindowLabel(0, "5h limit")).toBe("5h limit");
    expect(minutesToWindowLabel(Number.NaN, "Weekly limit")).toBe("Weekly limit");
  });
});

describe("mapCodexRpcQuota", () => {
  it("labels windows from windowDurationMins and preserves model-specific prefixes", () => {
    const snapshot = mapCodexRpcQuota({
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 1_763_500_000 },
        secondary: { usedPercent: 27, windowDurationMins: 10_080 },
        planType: "pro",
      },
      rateLimitsByLimitId: {
        codex_bengalfox: {
          limitId: "codex_bengalfox",
          limitName: "GPT-5.3-Codex-Spark",
          primary: { usedPercent: 8, windowDurationMins: 300 },
          secondary: { usedPercent: 20, windowDurationMins: 10_080 },
        },
      },
    });

    expect(snapshot.windows.map((window) => window.label)).toEqual([
      "5h limit",
      "Weekly limit",
      "GPT-5.3-Codex-Spark · 5h limit",
      "GPT-5.3-Codex-Spark · Weekly limit",
    ]);
  });

  it("does not assume primary is 5h when duration says otherwise", () => {
    const snapshot = mapCodexRpcQuota({
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 12, windowDurationMins: 10_080 },
        secondary: { usedPercent: 4, windowDurationMins: 300 },
      },
    });

    expect(snapshot.windows.map((window) => window.label)).toEqual([
      "Weekly limit",
      "5h limit",
    ]);
  });

  it("includes Credits only when hasCredits is true and unlimited is not true", () => {
    const withCredits = mapCodexRpcQuota({
      rateLimits: {
        limitId: "codex",
        credits: {
          hasCredits: true,
          unlimited: false,
          balance: "12.34",
        },
      },
    });
    expect(withCredits.windows).toEqual([
      {
        label: "Credits",
        usedPercent: null,
        resetsAt: null,
        valueLabel: "$12.34 remaining",
        detail: null,
      },
    ]);

    const subscriptionNoCredits = mapCodexRpcQuota({
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 3, windowDurationMins: 300 },
        credits: {
          hasCredits: false,
          unlimited: false,
          balance: 0,
        },
      },
    });
    expect(subscriptionNoCredits.windows).toEqual([
      {
        label: "5h limit",
        usedPercent: 3,
        resetsAt: null,
        valueLabel: null,
        detail: null,
      },
    ]);
    expect(subscriptionNoCredits.windows.some((window) => window.label === "Credits")).toBe(false);
    expect(JSON.stringify(subscriptionNoCredits)).not.toContain("$0.00 remaining");
  });

  it("omits Credits when unlimited is true even if hasCredits is true", () => {
    const snapshot = mapCodexRpcQuota({
      rateLimits: {
        limitId: "codex",
        credits: {
          hasCredits: true,
          unlimited: true,
          balance: "99.00",
        },
      },
    });
    expect(snapshot.windows).toEqual([]);
  });

  it("preserves Credits for legacy payloads with absent hasCredits and finite balance", () => {
    const snapshot = mapCodexRpcQuota({
      rateLimits: {
        limitId: "codex",
        credits: {
          unlimited: false,
          balance: "7.50",
        },
      },
    });
    expect(snapshot.windows).toEqual([
      {
        label: "Credits",
        usedPercent: null,
        resetsAt: null,
        valueLabel: "$7.50 remaining",
        detail: null,
      },
    ]);
  });
});

describe("toCodexAuthProbeDiagnostics", () => {
  it("exposes only non-secret auth metadata and never serializes token material", () => {
    const accessToken = "sk-access-token-SECRET-aaa111";
    const refreshToken = "rt-refresh-token-SECRET-bbb222";
    const idToken = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.id-token-SECRET-ccc333.sig";
    const accountId = "acct-account-id-SECRET-ddd444";

    const auth: CodexAuthInfo = {
      accessToken,
      refreshToken,
      idToken,
      accountId,
      email: "codex@example.com",
      planType: "pro",
      lastRefresh: "2026-07-30T00:00:00.000Z",
    };

    const diagnostics = toCodexAuthProbeDiagnostics(auth);
    const serialized = JSON.stringify({
      ok: true,
      auth: diagnostics,
      tokenAvailable: true,
    });

    expect(diagnostics).toEqual({
      present: true,
      hasAccessToken: true,
      hasRefreshToken: true,
      hasIdToken: true,
      hasAccountId: true,
      email: "codex@example.com",
      planType: "pro",
      lastRefresh: "2026-07-30T00:00:00.000Z",
    });
    expect(serialized).not.toContain(accessToken);
    expect(serialized).not.toContain(refreshToken);
    expect(serialized).not.toContain(idToken);
    expect(serialized).not.toContain(accountId);
    expect(serialized).not.toContain("accessToken");
    expect(serialized).not.toContain("refreshToken");
    expect(serialized).not.toContain("idToken");
    expect(serialized).not.toContain("accountId");
  });

  it("returns null when auth is absent", () => {
    expect(toCodexAuthProbeDiagnostics(null)).toBeNull();
  });
});
