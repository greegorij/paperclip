import { describe, expect, it } from "vitest";
import { shouldSuppressResolvedDependencyWakeForHistoricalBlockers } from "../services/issue-dependency-wakeups.js";

describe("shouldSuppressResolvedDependencyWakeForHistoricalBlockers", () => {
  const blockedAt = new Date("2026-08-02T16:00:00.000Z");
  const before = new Date("2026-08-02T15:00:00.000Z");
  const after = new Date("2026-08-02T16:30:00.000Z");

  it("suppresses when every blocker completed at or before the blocked episode", () => {
    expect(
      shouldSuppressResolvedDependencyWakeForHistoricalBlockers({
        blockedTransitionAt: blockedAt,
        blockerCompletedAt: [before, blockedAt],
      }),
    ).toBe(true);
  });

  it("does not suppress when any blocker completed after the blocked episode", () => {
    expect(
      shouldSuppressResolvedDependencyWakeForHistoricalBlockers({
        blockedTransitionAt: blockedAt,
        blockerCompletedAt: [before, after],
      }),
    ).toBe(false);
  });

  it("does not suppress when chronology cannot be proven", () => {
    expect(
      shouldSuppressResolvedDependencyWakeForHistoricalBlockers({
        blockedTransitionAt: null,
        blockerCompletedAt: [before],
      }),
    ).toBe(false);
    expect(
      shouldSuppressResolvedDependencyWakeForHistoricalBlockers({
        blockedTransitionAt: blockedAt,
        blockerCompletedAt: [before, null],
      }),
    ).toBe(false);
    expect(
      shouldSuppressResolvedDependencyWakeForHistoricalBlockers({
        blockedTransitionAt: blockedAt,
        blockerCompletedAt: [],
      }),
    ).toBe(false);
  });
});
