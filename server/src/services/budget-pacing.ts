import type {
  BudgetPacingConfidence,
  BudgetPacingMode,
  ProviderBudgetPacing,
  QuotaWindow,
} from "@paperclipai/shared";

const HOUR_MS = 60 * 60 * 1000;
const ACCELERATE_USED_PERCENT_MAX = 40;
const THROTTLE_USED_PERCENT_MIN = 90;
const ACCELERATE_MIN_HOURS_TO_RESET = 2;

export type BudgetPacingWindowInput = Pick<QuotaWindow, "label" | "usedPercent" | "resetsAt">;

export type EvaluateBudgetPacingInput = {
  provider: string;
  windows: BudgetPacingWindowInput[];
  recentTokens: number;
  burnRatePerHour: number;
  now?: Date;
  /** When the provider fetch itself failed. */
  fetchError?: string | null;
};

function parseWindowDurationMs(label: string): number | null {
  const match = label.trim().match(/(?:^|\s)(\d+)\s*(h|d|hr|hrs|hour|hours|day|days)\b/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = match[2]!.toLowerCase();
  if (unit.startsWith("h")) return amount * HOUR_MS;
  if (unit.startsWith("d")) return amount * 24 * HOUR_MS;
  return null;
}

function pickMostConstrainingWindow(
  windows: BudgetPacingWindowInput[],
  _now: Date,
): BudgetPacingWindowInput | null {
  const usable = windows.filter(
    (window) => typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent),
  );
  if (usable.length === 0) return null;

  return usable.reduce((best, candidate) => {
    const bestUsed = best.usedPercent ?? -1;
    const candidateUsed = candidate.usedPercent ?? -1;
    if (candidateUsed > bestUsed) return candidate;
    if (candidateUsed < bestUsed) return best;

    const bestReset = best.resetsAt ? Date.parse(best.resetsAt) : Number.POSITIVE_INFINITY;
    const candidateReset = candidate.resetsAt ? Date.parse(candidate.resetsAt) : Number.POSITIVE_INFINITY;
    if (candidateReset < bestReset) return candidate;
    if (candidateReset > bestReset) return best;

    // Prefer shorter labeled windows when percent and reset tie.
    const bestDuration = parseWindowDurationMs(best.label) ?? Number.POSITIVE_INFINITY;
    const candidateDuration = parseWindowDurationMs(candidate.label) ?? Number.POSITIVE_INFINITY;
    return candidateDuration < bestDuration ? candidate : best;
  });
}

function projectExhaustionAt(
  window: BudgetPacingWindowInput,
  now: Date,
): string | null {
  const usedPercent = window.usedPercent;
  if (usedPercent == null || usedPercent >= 100) return null;
  if (!window.resetsAt) return null;

  const resetMs = Date.parse(window.resetsAt);
  if (!Number.isFinite(resetMs) || resetMs <= now.getTime()) return null;

  const durationMs = parseWindowDurationMs(window.label);
  if (durationMs == null || durationMs <= 0) return null;

  const elapsedMs = durationMs - (resetMs - now.getTime());
  if (elapsedMs <= 0 || usedPercent <= 0) return null;

  const percentPerMs = usedPercent / elapsedMs;
  if (!(percentPerMs > 0)) return null;

  const remainingPercent = 100 - usedPercent;
  const msToExhaust = remainingPercent / percentPerMs;
  if (!Number.isFinite(msToExhaust) || msToExhaust < 0) return null;

  return new Date(now.getTime() + msToExhaust).toISOString();
}

function confidenceFor(window: BudgetPacingWindowInput | null): BudgetPacingConfidence {
  if (!window || window.usedPercent == null) return "none";
  if (window.resetsAt) return "high";
  return "medium";
}

function buildResult(
  input: EvaluateBudgetPacingInput,
  partial: Omit<ProviderBudgetPacing, "provider" | "recentTokens" | "burnRatePerHour">,
): ProviderBudgetPacing {
  return {
    provider: input.provider,
    recentTokens: Math.max(0, Math.floor(input.recentTokens)),
    burnRatePerHour: Math.max(0, Number(input.burnRatePerHour) || 0),
    ...partial,
  };
}

/**
 * Pure pacing decision from provider quota windows.
 *
 * `recentTokens` / `burnRatePerHour` are echoed for UI/telemetry only. They must
 * not change mode: quota windows expose usedPercent (and sometimes reset), not
 * absolute token capacity, so there is no shared denominator that can convert
 * token burn into a percent-safe projection without inventing an arbitrary
 * threshold. Doing so would risk false throttle/stop of the fleet.
 *
 * Projection (`projectedExhaustionAt` / throttle-via-projection) uses only the
 * window's own percent-elapsed rate over its labeled duration — still a
 * percentage-space signal, never raw token history.
 *
 * Never invents reset timestamps. Missing/unreliable data yields `unknown`
 * (advisory only — callers must not auto-stop).
 */
export function evaluateBudgetPacing(input: EvaluateBudgetPacingInput): ProviderBudgetPacing {
  const now = input.now ?? new Date();

  if (input.fetchError) {
    return buildResult(input, {
      mode: "unknown",
      usedPercent: null,
      resetAt: null,
      projectedExhaustionAt: null,
      reason: "Provider quota fetch failed; no automatic stop.",
      confidence: "none",
      constrainingWindowLabel: null,
      warning: input.fetchError,
    });
  }

  const window = pickMostConstrainingWindow(input.windows, now);
  if (!window || window.usedPercent == null) {
    return buildResult(input, {
      mode: "unknown",
      usedPercent: null,
      resetAt: null,
      projectedExhaustionAt: null,
      reason: "No reliable provider quota windows; no automatic stop.",
      confidence: "none",
      constrainingWindowLabel: null,
      warning: "Quota windows are missing or lack usedPercent; work continues without auto-stop.",
    });
  }

  const usedPercent = window.usedPercent;
  const resetAt = window.resetsAt ?? null;
  const resetMs = resetAt ? Date.parse(resetAt) : NaN;
  const hasFutureReset = Number.isFinite(resetMs) && resetMs > now.getTime();
  // Percent-space projection only (see module comment on recentTokens).
  const projectedExhaustionAt = projectExhaustionAt(window, now);
  const projectedMs = projectedExhaustionAt ? Date.parse(projectedExhaustionAt) : NaN;
  const projectsBeforeReset =
    hasFutureReset && Number.isFinite(projectedMs) && projectedMs < resetMs;
  const hoursToReset = hasFutureReset ? (resetMs - now.getTime()) / HOUR_MS : null;
  const confidence = confidenceFor(window);

  let mode: BudgetPacingMode;
  let reason: string;

  if (usedPercent >= 100 && hasFutureReset) {
    mode = "stop";
    reason = `Most constraining window "${window.label}" is exhausted until reset.`;
  } else if (usedPercent >= THROTTLE_USED_PERCENT_MIN || projectsBeforeReset) {
    mode = "throttle";
    reason = projectsBeforeReset && usedPercent < THROTTLE_USED_PERCENT_MIN
      ? `Window-percent burn projects exhaustion of "${window.label}" before reset.`
      : `Most constraining window "${window.label}" is at ${usedPercent}% used.`;
  } else if (
    usedPercent <= ACCELERATE_USED_PERCENT_MAX &&
    hoursToReset != null &&
    hoursToReset >= ACCELERATE_MIN_HOURS_TO_RESET
  ) {
    mode = "accelerate";
    reason = `Headroom on "${window.label}" (${usedPercent}% used, ~${hoursToReset.toFixed(1)}h to reset).`;
  } else {
    mode = "normal";
    reason = `Most constraining window "${window.label}" is within normal bounds.`;
  }

  // Exhausted without a future reset: recommend throttle, never invent stop.
  if (usedPercent >= 100 && !hasFutureReset && mode !== "stop") {
    mode = "throttle";
    reason = `Window "${window.label}" reports 100% used but reset time is unknown; no automatic stop.`;
  }

  return buildResult(input, {
    mode,
    usedPercent,
    resetAt,
    projectedExhaustionAt,
    reason,
    confidence,
    constrainingWindowLabel: window.label,
    warning: null,
  });
}

/** @internal exported for unit tests */
export const __testing = {
  pickMostConstrainingWindow,
  projectExhaustionAt,
  parseWindowDurationMs,
  ACCELERATE_USED_PERCENT_MAX,
  THROTTLE_USED_PERCENT_MIN,
};
