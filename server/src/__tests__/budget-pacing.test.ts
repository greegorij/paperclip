import { describe, expect, it } from "vitest";
import {
  evaluateBudgetPacing,
  providerAdmissionCap,
  resolveProviderAdmissionSlots,
} from "../services/budget-pacing.js";

const now = new Date("2026-08-01T12:00:00.000Z");

describe("evaluateBudgetPacing", () => {
  it("returns unknown when there are no reliable windows", () => {
    const result = evaluateBudgetPacing({
      provider: "anthropic",
      windows: [{ label: "5h", usedPercent: null, resetsAt: null }],
      recentTokens: 100,
      burnRatePerHour: 4,
      now,
    });
    expect(result.mode).toBe("unknown");
    expect(result.resetAt).toBeNull();
    expect(result.warning).toMatch(/without auto-stop|no automatic stop/i);
  });

  it("returns unknown on fetch error without stopping", () => {
    const result = evaluateBudgetPacing({
      provider: "openai",
      windows: [],
      recentTokens: 0,
      burnRatePerHour: 0,
      now,
      fetchError: "quota polling timed out after 20s",
    });
    expect(result.mode).toBe("unknown");
    expect(result.warning).toContain("timed out");
  });

  it("returns stop when used >= 100 and reset is in the future", () => {
    const resetAt = "2026-08-01T17:00:00.000Z";
    const result = evaluateBudgetPacing({
      provider: "anthropic",
      windows: [{ label: "5h", usedPercent: 100, resetsAt: resetAt }],
      recentTokens: 500,
      burnRatePerHour: 20,
      now,
    });
    expect(result).toMatchObject({
      mode: "stop",
      usedPercent: 100,
      resetAt,
      confidence: "high",
    });
  });

  it("does not invent stop when used is 100 but reset is unknown", () => {
    const result = evaluateBudgetPacing({
      provider: "anthropic",
      windows: [{ label: "5h", usedPercent: 100, resetsAt: null }],
      recentTokens: 500,
      burnRatePerHour: 20,
      now,
    });
    expect(result.mode).toBe("throttle");
    expect(result.resetAt).toBeNull();
    expect(result.reason).toMatch(/reset time is unknown/i);
  });

  it("returns throttle when used >= 90", () => {
    const result = evaluateBudgetPacing({
      provider: "openai",
      windows: [
        { label: "5h", usedPercent: 91, resetsAt: "2026-08-01T16:00:00.000Z" },
        { label: "7d", usedPercent: 40, resetsAt: "2026-08-08T12:00:00.000Z" },
      ],
      recentTokens: 200,
      burnRatePerHour: 8,
      now,
    });
    expect(result.mode).toBe("throttle");
    expect(result.constrainingWindowLabel).toBe("5h");
    expect(result.usedPercent).toBe(91);
  });

  it("returns throttle when window-percent burn projects exhaustion before reset", () => {
    // 5h window, 2h elapsed (3h to reset), already at 70% → exhausts before reset.
    // recentTokens/burnRatePerHour are ignored for mode (no shared token denominator).
    const result = evaluateBudgetPacing({
      provider: "anthropic",
      windows: [{ label: "5h", usedPercent: 70, resetsAt: "2026-08-01T15:00:00.000Z" }],
      recentTokens: 0,
      burnRatePerHour: 0,
      now,
    });
    expect(result.mode).toBe("throttle");
    expect(result.reason).toMatch(/window-percent burn projects exhaustion/i);
    expect(result.projectedExhaustionAt).not.toBeNull();
    expect(Date.parse(result.projectedExhaustionAt!)).toBeLessThan(
      Date.parse("2026-08-01T15:00:00.000Z"),
    );
  });

  it("does not let raw token burnRate change mode (no shared capacity denominator)", () => {
    const windows = [{ label: "5h", usedPercent: 55, resetsAt: "2026-08-01T14:00:00.000Z" }];
    const baseline = evaluateBudgetPacing({
      provider: "openai",
      windows,
      recentTokens: 0,
      burnRatePerHour: 0,
      now,
    });
    const extreme = evaluateBudgetPacing({
      provider: "openai",
      windows,
      recentTokens: 50_000_000,
      burnRatePerHour: 10_000_000,
      now,
    });
    expect(baseline.mode).toBe("normal");
    expect(extreme.mode).toBe(baseline.mode);
    expect(extreme.projectedExhaustionAt).toBe(baseline.projectedExhaustionAt);
    expect(extreme.recentTokens).toBe(50_000_000);
    expect(extreme.burnRatePerHour).toBe(10_000_000);
  });

  it("throttles to preserve the reserve when burn would exceed the target by reset", () => {
    const result = evaluateBudgetPacing({
      provider: "openai",
      windows: [{ label: "5h", usedPercent: 20, resetsAt: "2026-08-01T16:00:00.000Z" }],
      recentTokens: 50,
      burnRatePerHour: 2,
      now,
    });
    expect(result).toMatchObject({
      mode: "throttle",
      usedPercent: 20,
      resetAt: "2026-08-01T16:00:00.000Z",
      constrainingWindowLabel: "5h",
    });
    expect(result.admissionRate).toBeCloseTo(0.9375, 12);
  });

  it("derives a smooth throttle admission rate in percentage space", () => {
    const result = evaluateBudgetPacing({
      provider: "openai",
      windows: [{ label: "5h", usedPercent: 70, resetsAt: "2026-08-01T15:00:00.000Z" }],
      recentTokens: 1,
      burnRatePerHour: 999_999,
      now,
    });
    expect(result.mode).toBe("throttle");
    expect(result.admissionRate).toBeGreaterThan(0.05);
    expect(result.admissionRate).toBeLessThan(1);
  });

  it("fails open without a trustworthy reset and stops at 100% with a future reset", () => {
    const missingReset = evaluateBudgetPacing({
      provider: "openai",
      windows: [{ label: "5h", usedPercent: 100, resetsAt: null }],
      recentTokens: 0,
      burnRatePerHour: 0,
      now,
    });
    const exhausted = evaluateBudgetPacing({
      provider: "openai",
      windows: [{ label: "5h", usedPercent: 100, resetsAt: "2026-08-01T17:00:00.000Z" }],
      recentTokens: 0,
      burnRatePerHour: 0,
      now,
    });
    expect(missingReset.admissionRate).toBe(1);
    expect(exhausted.admissionRate).toBe(0);
  });

  it("maps admission rate to a hard provider ceiling without exceeding it", () => {
    expect(providerAdmissionCap({ ceiling: 5, admissionRate: 0.4, mode: "normal" })).toBe(2);
    expect(providerAdmissionCap({ ceiling: 5, admissionRate: 0, mode: "stop" })).toBe(0);
    expect(providerAdmissionCap({ ceiling: 5, admissionRate: 0.01, mode: "throttle" })).toBe(1);
    expect(resolveProviderAdmissionSlots({
      agentMaxConcurrent: 4,
      agentRunning: 1,
      providerCeiling: 5,
      providerRunning: 2,
      admissionRate: 0.4,
      mode: "normal",
    })).toEqual({ agentSlots: 3, providerCap: 2, availableSlots: 0 });
  });

  it("returns normal for mid-band usage", () => {
    const result = evaluateBudgetPacing({
      provider: "openai",
      windows: [{ label: "5h", usedPercent: 55, resetsAt: "2026-08-01T14:00:00.000Z" }],
      recentTokens: 80,
      burnRatePerHour: 3,
      now,
    });
    expect(result.mode).toBe("normal");
    expect(result.admissionRate).toBeLessThanOrEqual(1);
  });

  it("reopens admission after the reported reset and keeps providers independent", () => {
    const afterReset = evaluateBudgetPacing({
      provider: "openai",
      windows: [{ label: "5h", usedPercent: 100, resetsAt: "2026-08-01T11:59:00.000Z" }],
      recentTokens: 0,
      burnRatePerHour: 0,
      now,
    });
    expect(afterReset.admissionRate).toBe(1);
    expect(providerAdmissionCap({ ceiling: 7, admissionRate: 1, mode: "normal" })).toBe(7);
    expect(providerAdmissionCap({ ceiling: 3, admissionRate: 1, mode: "normal" })).toBe(3);
  });

  it("picks the most constraining window by highest usedPercent", () => {
    const result = evaluateBudgetPacing({
      provider: "anthropic",
      windows: [
        { label: "7d", usedPercent: 30, resetsAt: "2026-08-08T12:00:00.000Z" },
        { label: "5h", usedPercent: 88, resetsAt: "2026-08-01T15:00:00.000Z" },
      ],
      recentTokens: 10,
      burnRatePerHour: 1,
      now,
    });
    expect(result.constrainingWindowLabel).toBe("5h");
    expect(result.usedPercent).toBe(88);
  });
});
