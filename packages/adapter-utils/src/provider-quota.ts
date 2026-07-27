/**
 * Shared provider-quota / session-limit detection used by adapters (including ACPX)
 * and by the heartbeat control plane as a safety net.
 *
 * Covers Anthropic-style wording such as:
 * - "You've hit your session limit - resets at 4pm (America/Chicago)."
 * - "You've hit your session limit · resets 11:50am (UTC)"
 */

export const PROVIDER_QUOTA_DEFAULT_BACKOFF_MS = 60 * 60 * 1000;
export const PROVIDER_QUOTA_RESET_MARGIN_MS = 60 * 1000;

const PROVIDER_QUOTA_RE =
  /(?:you(?:'|’)ve\s+hit\s+your\s+(?:session|usage)\s+limit|session\s+limit\s+(?:reached|exceeded)|usage\s+limit(?:\s+reached|\s+exceeded)?|out\s+of\s+extra\s+usage|extra\s+usage\b|claude\s+usage\s+limit\s+reached|5[-\s]?hour\s+limit\s+reached|weekly\s+limit\s+reached|usage\s+cap\s+reached|provider\s+quota|quota\s+(?:limit\s+)?exceeded|servicequotaexceededexception|model\s+(?:is\s+)?at\s+capacity)/i;

const PROVIDER_QUOTA_RESET_RE =
  /(?:you(?:'|’)ve\s+hit\s+your\s+(?:session|usage)\s+limit|session\s+limit\s+(?:reached|exceeded)|out\s+of\s+extra\s+usage|extra\s+usage|usage\s+limit\s+reached|usage\s+cap\s+reached|5[-\s]?hour\s+limit\s+reached|weekly\s+limit\s+reached|claude\s+usage\s+limit\s+reached)[\s\S]{0,160}?\bresets?\s+(?:at\s+)?([^\n()]+?)(?:\s*\(([^)]+)\))?(?:[.!]|\n|$)/i;

const PROVIDER_QUOTA_TRY_AGAIN_RE =
  /try again at\s+(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?\s*m\.?)?(?:\s*\(([^)]+)\)|\s+([A-Z]{2,5}))?/i;

function readTimeZoneParts(date: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function normalizeResetTimeZone(hint: string): string | null {
  const trimmed = hint.trim();
  if (!trimmed) return null;
  try {
    // Throws RangeError for invalid IANA zones.
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format(new Date());
    return trimmed;
  } catch {
    return null;
  }
}

function dateFromTimeZoneWallClock(input: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timeZone: string;
}): Date | null {
  let candidate = new Date(Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0, 0));
  const targetUtc = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0, 0);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = readTimeZoneParts(candidate, input.timeZone);
    const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, 0, 0);
    const offsetMs = targetUtc - actualUtc;
    if (offsetMs === 0) break;
    candidate = new Date(candidate.getTime() + offsetMs);
  }

  const verified = readTimeZoneParts(candidate, input.timeZone);
  if (
    verified.year !== input.year ||
    verified.month !== input.month ||
    verified.day !== input.day ||
    verified.hour !== input.hour ||
    verified.minute !== input.minute
  ) {
    return null;
  }

  return candidate;
}

function nextClockTimeInTimeZone(input: {
  now: Date;
  hour: number;
  minute: number;
  timeZoneHint: string;
}): Date | null {
  const timeZone = normalizeResetTimeZone(input.timeZoneHint);
  if (!timeZone) return null;

  const nowParts = readTimeZoneParts(input.now, timeZone);
  let retryAt = dateFromTimeZoneWallClock({
    year: nowParts.year,
    month: nowParts.month,
    day: nowParts.day,
    hour: input.hour,
    minute: input.minute,
    timeZone,
  });
  if (!retryAt) return null;

  if (retryAt.getTime() <= input.now.getTime()) {
    const nextDay = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day + 1, 0, 0, 0, 0));
    retryAt = dateFromTimeZoneWallClock({
      year: nextDay.getUTCFullYear(),
      month: nextDay.getUTCMonth() + 1,
      day: nextDay.getUTCDate(),
      hour: input.hour,
      minute: input.minute,
      timeZone,
    });
  }

  return retryAt;
}

function parseResetClockTime(clockText: string, now: Date, timeZoneHint?: string | null): Date | null {
  const normalized = clockText.trim().replace(/\s+/g, " ");
  const match = normalized.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?/i);
  if (!match) return null;

  const hour12 = Number.parseInt(match[1] ?? "", 10);
  const minute = Number.parseInt(match[2] ?? "0", 10);
  if (!Number.isInteger(hour12) || hour12 < 1 || hour12 > 12) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

  let hour24 = hour12 % 12;
  if ((match[3] ?? "").toLowerCase() === "p") hour24 += 12;

  if (timeZoneHint) {
    const explicitRetryAt = nextClockTimeInTimeZone({
      now,
      hour: hour24,
      minute,
      timeZoneHint,
    });
    if (explicitRetryAt) return explicitRetryAt;
  }

  const retryAt = new Date(now);
  retryAt.setHours(hour24, minute, 0, 0);
  if (retryAt.getTime() <= now.getTime()) {
    retryAt.setDate(retryAt.getDate() + 1);
  }
  return retryAt;
}

function parseTryAgainClock(error: string, now: Date): Date | null {
  const match = error.match(PROVIDER_QUOTA_TRY_AGAIN_RE);
  if (!match) return null;

  const hourValue = Number.parseInt(match[1] ?? "", 10);
  const minute = Number.parseInt(match[2] ?? "0", 10);
  const meridiem = (match[3] ?? "").toLowerCase();
  if (!Number.isInteger(hourValue)) return null;
  if (meridiem ? hourValue < 1 || hourValue > 12 : hourValue < 0 || hourValue > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

  let hour = meridiem ? hourValue % 12 : hourValue;
  if (meridiem === "p") hour += 12;
  const timeZone = (match[4] ?? match[5])?.trim();
  if (!timeZone) {
    const retryAt = new Date(now);
    retryAt.setUTCHours(hour, minute, 0, 0);
    if (retryAt.getTime() <= now.getTime()) retryAt.setUTCDate(retryAt.getUTCDate() + 1);
    return retryAt;
  }

  return nextClockTimeInTimeZone({ now, hour, minute, timeZoneHint: timeZone });
}

export function isProviderQuotaErrorMessage(text: string | null | undefined): boolean {
  if (!text || !text.trim()) return false;
  return PROVIDER_QUOTA_RE.test(text);
}

export function extractProviderQuotaRetryNotBefore(
  text: string | null | undefined,
  now = new Date(),
): Date | null {
  if (!text || !text.trim()) return null;

  const resetMatch = text.match(PROVIDER_QUOTA_RESET_RE);
  if (resetMatch) {
    const parsed = parseResetClockTime(resetMatch[1] ?? "", now, resetMatch[2]);
    if (parsed) return new Date(parsed.getTime() + PROVIDER_QUOTA_RESET_MARGIN_MS);
  }

  const tryAgain = parseTryAgainClock(text, now);
  if (tryAgain) return new Date(tryAgain.getTime() + PROVIDER_QUOTA_RESET_MARGIN_MS);

  return null;
}

export type ProviderQuotaClassification = {
  errorCode: "provider_quota";
  errorFamily: "provider_quota";
  retryNotBefore: string | null;
};

/**
 * Classify a provider session/usage-limit failure. When the reset clock cannot
 * be parsed, `retryNotBefore` is set to a conservative fixed backoff so callers
 * never treat the failure as immediately retryable.
 */
export function classifyProviderQuotaFailure(
  text: string | null | undefined,
  now = new Date(),
): ProviderQuotaClassification | null {
  if (!isProviderQuotaErrorMessage(text)) return null;
  const parsed = extractProviderQuotaRetryNotBefore(text, now);
  const retryNotBefore = parsed ?? new Date(now.getTime() + PROVIDER_QUOTA_DEFAULT_BACKOFF_MS);
  return {
    errorCode: "provider_quota",
    errorFamily: "provider_quota",
    retryNotBefore: retryNotBefore.toISOString(),
  };
}
