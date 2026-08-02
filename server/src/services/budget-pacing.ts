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
/** Keep this fraction of the subscription window unused through reset. */
const RESERVE_PERCENT = 5;
const SAFE_USED_TARGET_PERCENT = 100 - RESERVE_PERCENT;
/**
 * Throttle never collapses to a hard zero via the smooth coefficient alone —
 * stop mode is the only path to admissionRate 0 (aside from explicit 100%+reset).
 */
const THROTTLE_ADMISSION_FLOOR = 0.05;
/** Before this fraction of the window has elapsed, prefer fail-open unless already throttling/stopping. */
const EARLY_WINDOW_ELAPSED_FRACTION = 0.05;

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

function projectUsedPercentAt(
  window: BudgetPacingWindowInput,
  now: Date,
  targetPercent: number,
): string | null {
  const usedPercent = window.usedPercent;
  if (usedPercent == null || usedPercent >= targetPercent) return null;
  if (!window.resetsAt) return null;

  const resetMs = Date.parse(window.resetsAt);
  if (!Number.isFinite(resetMs) || resetMs <= now.getTime()) return null;

  const durationMs = parseWindowDurationMs(window.label);
  if (durationMs == null || durationMs <= 0) return null;

  const elapsedMs = durationMs - (resetMs - now.getTime());
  if (elapsedMs <= 0 || usedPercent <= 0) return null;

  const percentPerMs = usedPercent / elapsedMs;
  if (!(percentPerMs > 0)) return null;

  const remainingPercent = targetPercent - usedPercent;
  const msToExhaust = remainingPercent / percentPerMs;
  if (!Number.isFinite(msToExhaust) || msToExhaust < 0) return null;

  return new Date(now.getTime() + msToExhaust).toISOString();
}

function projectExhaustionAt(
  window: BudgetPacingWindowInput,
  now: Date,
): string | null {
  return projectUsedPercentAt(window, now, 100);
}

function confidenceFor(window: BudgetPacingWindowInput | null): BudgetPacingConfidence {
  if (!window || window.usedPercent == null) return "none";
  if (window.resetsAt) return "high";
  return "medium";
}

/**
 * Deterministic work-admission coefficient in percentage space.
 * Compares observed window burn (usedPercent / elapsed) to the safe burn rate
 * that would land at most at 95% used at reset. Token telemetry is intentionally unused.
 */
export function computeAdmissionRate(input: {
  mode: BudgetPacingMode;
  usedPercent: number | null;
  resetAt: string | null;
  windowLabel: string | null;
  now?: Date;
}): number {
  const now = input.now ?? new Date();
  if (input.mode === "unknown") return 1;
  if (input.usedPercent == null || !Number.isFinite(input.usedPercent)) return 1;

  const resetMs = input.resetAt ? Date.parse(input.resetAt) : Number.NaN;
  const hasFutureReset = Number.isFinite(resetMs) && resetMs > now.getTime();

  if (input.usedPercent >= 100 && hasFutureReset) return 0;
  if (input.mode === "stop") return 0;
  if (!hasFutureReset) return 1;

  const durationMs = input.windowLabel ? parseWindowDurationMs(input.windowLabel) : null;
  if (durationMs == null || durationMs <= 0) return 1;

  const remainingMs = resetMs - now.getTime();
  const elapsedMs = durationMs - remainingMs;
  if (remainingMs <= 0 || elapsedMs <= 0) return 1;

  const elapsedFraction = elapsedMs / durationMs;
  if (
    elapsedFraction < EARLY_WINDOW_ELAPSED_FRACTION &&
    input.mode !== "throttle" &&
    input.usedPercent < THROTTLE_USED_PERCENT_MIN
  ) {
    return 1;
  }

  const observedRate = input.usedPercent / elapsedMs;
  if (!(observedRate > 0)) return 1;

  const safeRemaining = SAFE_USED_TARGET_PERCENT - input.usedPercent;
  const raw =
    safeRemaining <= 0
      ? 0
      : Math.min(1, (safeRemaining / remainingMs) / observedRate);

  if (!Number.isFinite(raw) || raw < 0) return input.mode === "throttle" ? THROTTLE_ADMISSION_FLOOR : 1;

  if (input.mode === "throttle") {
    return Math.max(THROTTLE_ADMISSION_FLOOR, Math.min(1, raw));
  }
  // accelerate / normal: never exceed 1.0 (no above-ceiling boost).
  return Math.min(1, raw);
}

/**
 * Map admissionRate onto a provider-wide concurrency ceiling.
 * Always 0 for stop; at least 1 for throttle; never above the ceiling.
 */
export function providerAdmissionCap(input: {
  ceiling: number;
  admissionRate: number;
  mode: BudgetPacingMode;
}): number {
  const ceiling = Math.max(0, Math.floor(Number(input.ceiling) || 0));
  if (ceiling <= 0) return 0;
  if (input.mode === "stop") return 0;

  const factor = Number(input.admissionRate);
  if (!Number.isFinite(factor) || factor <= 0) {
    return input.mode === "throttle" ? 1 : 0;
  }

  const clampedFactor = Math.min(1, Math.max(0, factor));
  const scaled = ceiling * clampedFactor;
  // Conservative floor for the scaled product; ceil only when floor would
  // incorrectly collapse a positive throttle factor to zero before the min-1 rule.
  let cap = Math.floor(scaled);
  if (cap < 1 && clampedFactor > 0 && scaled > 0) {
    cap = Math.ceil(scaled);
  }
  if (input.mode === "throttle") {
    cap = Math.max(1, cap);
  }
  return Math.min(ceiling, Math.max(0, cap));
}

/** Combine per-agent slots with the provider-wide admission cap. */
export function resolveProviderAdmissionSlots(input: {
  agentMaxConcurrent: number;
  agentRunning: number;
  providerCeiling: number;
  providerRunning: number;
  admissionRate: number;
  mode: BudgetPacingMode;
}): { availableSlots: number; providerCap: number; agentSlots: number } {
  const agentSlots = Math.max(0, Math.floor(input.agentMaxConcurrent) - Math.max(0, Math.floor(input.agentRunning)));
  const providerCap = providerAdmissionCap({
    ceiling: input.providerCeiling,
    admissionRate: input.admissionRate,
    mode: input.mode,
  });
  const providerSlots = Math.max(0, providerCap - Math.max(0, Math.floor(input.providerRunning)));
  return {
    agentSlots,
    providerCap,
    availableSlots: Math.min(agentSlots, providerSlots),
  };
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
 * (advisory only — callers must not auto-stop) with admissionRate 1.0.
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
      admissionRate: 1,
      admissionCeiling: null,
      admissionCap: null,
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
      admissionRate: 1,
      admissionCeiling: null,
      admissionCap: null,
    });
  }

  const usedPercent = window.usedPercent;
  const resetAt = window.resetsAt ?? null;
  const resetMs = resetAt ? Date.parse(resetAt) : NaN;
  const hasFutureReset = Number.isFinite(resetMs) && resetMs > now.getTime();
  // Percent-space projection only (see module comment on recentTokens).
  const projectedExhaustionAt = projectExhaustionAt(window, now);
  const projectedMs = projectedExhaustionAt ? Date.parse(projectedExhaustionAt) : NaN;
  const projectsExhaustionBeforeReset =
    hasFutureReset && Number.isFinite(projectedMs) && projectedMs < resetMs;
  const projectedSafeTargetAt = projectUsedPercentAt(window, now, SAFE_USED_TARGET_PERCENT);
  const projectedSafeTargetMs = projectedSafeTargetAt ? Date.parse(projectedSafeTargetAt) : NaN;
  const projectsSafeTargetBeforeReset =
    hasFutureReset && Number.isFinite(projectedSafeTargetMs) && projectedSafeTargetMs < resetMs;
  const hoursToReset = hasFutureReset ? (resetMs - now.getTime()) / HOUR_MS : null;
  const confidence = confidenceFor(window);

  let mode: BudgetPacingMode;
  let reason: string;

  if (usedPercent >= 100 && hasFutureReset) {
    mode = "stop";
    reason = `Most constraining window "${window.label}" is exhausted until reset.`;
  } else if (usedPercent >= THROTTLE_USED_PERCENT_MIN || projectsSafeTargetBeforeReset) {
    mode = "throttle";
    reason = projectsExhaustionBeforeReset && usedPercent < THROTTLE_USED_PERCENT_MIN
      ? `Window-percent burn projects exhaustion of "${window.label}" before reset.`
      : projectsSafeTargetBeforeReset && usedPercent < THROTTLE_USED_PERCENT_MIN
        ? `Window-percent burn projects exceeding the ${SAFE_USED_TARGET_PERCENT}% reserve target for "${window.label}" before reset.`
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

  const admissionRate = computeAdmissionRate({
    mode,
    usedPercent,
    resetAt,
    windowLabel: window.label,
    now,
  });

  return buildResult(input, {
    mode,
    usedPercent,
    resetAt,
    projectedExhaustionAt,
    reason,
    confidence,
    constrainingWindowLabel: window.label,
    warning: null,
    admissionRate,
    admissionCeiling: null,
    admissionCap: null,
  });
}

/** @internal exported for unit tests */
export const __testing = {
  pickMostConstrainingWindow,
  projectExhaustionAt,
  projectUsedPercentAt,
  parseWindowDurationMs,
  ACCELERATE_USED_PERCENT_MAX,
  THROTTLE_USED_PERCENT_MIN,
  RESERVE_PERCENT,
  SAFE_USED_TARGET_PERCENT,
  THROTTLE_ADMISSION_FLOOR,
  EARLY_WINDOW_ELAPSED_FRACTION,
  computeAdmissionRate,
};
