import type { BudgetPacingConfidence, BudgetPacingMode } from "../constants.js";

/** One provider's pacing recommendation derived from quota windows + recent burn. */
export interface ProviderBudgetPacing {
  mode: BudgetPacingMode;
  provider: string;
  usedPercent: number | null;
  resetAt: string | null;
  recentTokens: number;
  burnRatePerHour: number;
  projectedExhaustionAt: string | null;
  reason: string;
  confidence: BudgetPacingConfidence;
  /**
   * Auditable work-admission coefficient in [0, 1], derived in percentage space
   * (observed window burn vs safe rate that preserves a 5% reserve until reset).
   * Token burn fields remain telemetry only and do not feed this value.
   */
  admissionRate: number;
  /**
   * Absolute provider-wide concurrency ceiling for this company: sum of configured
   * hard maxConcurrentRuns across agents whose adapter maps to this provider.
   * Null when the ceiling was not resolved for this snapshot.
   */
  admissionCeiling?: number | null;
  /**
   * Effective concurrent-run cap after applying admissionRate to admissionCeiling
   * (0 for stop; at least 1 for throttle; never above the ceiling).
   */
  admissionCap?: number | null;
  /** Window label that drove the decision, when available. */
  constrainingWindowLabel?: string | null;
  /** Soft warning when data is incomplete; never implies an automatic stop. */
  warning?: string | null;
}

/** Company-scoped read model for GET .../costs/budget-pacing */
export interface CompanyBudgetPacingSnapshot {
  companyId: string;
  fetchedAt: string;
  /** Where quota windows came from (adapter aggregate), never credentials. */
  source: string;
  providers: ProviderBudgetPacing[];
}
