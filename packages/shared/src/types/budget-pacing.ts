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
