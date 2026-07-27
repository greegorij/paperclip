import { describe, expect, it } from "vitest";
import {
  PROVIDER_QUOTA_DEFAULT_BACKOFF_MS,
  PROVIDER_QUOTA_RESET_MARGIN_MS,
  classifyProviderQuotaFailure,
  extractProviderQuotaRetryNotBefore,
  isProviderQuotaErrorMessage,
} from "./provider-quota.js";

describe("provider-quota classification", () => {
  it("recognizes the production session-limit wording without the word 'at'", () => {
    const errorMessage =
      "Internal error: You've hit your session limit · resets 11:50am (UTC)";
    expect(isProviderQuotaErrorMessage(errorMessage)).toBe(true);

    const now = new Date("2026-07-27T10:00:00.000Z");
    const retryAt = extractProviderQuotaRetryNotBefore(errorMessage, now);
    expect(retryAt?.toISOString()).toBe(
      new Date(Date.parse("2026-07-27T11:50:00.000Z") + PROVIDER_QUOTA_RESET_MARGIN_MS).toISOString(),
    );
  });

  it("still recognizes the Claude CLI form with 'resets at' and a named zone", () => {
    const errorMessage = "You've hit your session limit - resets at 4pm (America/Chicago).";
    expect(isProviderQuotaErrorMessage(errorMessage)).toBe(true);

    const now = new Date("2026-04-22T15:15:00.000Z");
    const retryAt = extractProviderQuotaRetryNotBefore(errorMessage, now);
    expect(retryAt?.toISOString()).toBe(
      new Date(Date.parse("2026-04-22T21:00:00.000Z") + PROVIDER_QUOTA_RESET_MARGIN_MS).toISOString(),
    );
  });

  it("falls back to a fixed backoff when the reset clock cannot be parsed", () => {
    const now = new Date("2026-07-27T10:00:00.000Z");
    const classified = classifyProviderQuotaFailure("You've hit your session limit.", now);
    expect(classified).toEqual({
      errorCode: "provider_quota",
      errorFamily: "provider_quota",
      retryNotBefore: new Date(now.getTime() + PROVIDER_QUOTA_DEFAULT_BACKOFF_MS).toISOString(),
    });
  });

  it("does not classify unrelated adapter failures", () => {
    expect(isProviderQuotaErrorMessage("acpx_turn_failed: network unreachable")).toBe(false);
    expect(classifyProviderQuotaFailure("Maximum turns reached")).toBeNull();
  });
});
