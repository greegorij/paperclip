/** a single rate-limit or usage window returned by a provider quota API */
export interface QuotaWindow {
  /** human label, e.g. "5h", "7d", "Sonnet 7d", "Credits" */
  label: string;
  /** percent of the window already consumed (0-100), null when not reported */
  usedPercent: number | null;
  /** iso timestamp when this window resets, null when not reported */
  resetsAt: string | null;
  /** free-form value label for credit-style windows, e.g. "$4.20 remaining" */
  valueLabel: string | null;
  /** optional supporting text, e.g. reset details or provider-specific notes */
  detail?: string | null;
}

/** result for one provider from the quota-windows endpoint */
export interface ProviderQuotaResult {
  /** provider slug, e.g. "anthropic", "openai" */
  provider: string;
  /** source label when the provider reports where the quota data came from */
  source?: string | null;
  /** true when the fetch succeeded and windows is populated */
  ok: boolean;
  /** machine-readable error family when ok is false */
  errorFamily?: string | null;
  /** error message when ok is false */
  error?: string;
  /**
   * Set when ok is true but the reading came from a degraded/fallback source.
   * Carries why the primary source was skipped, so a silent downgrade stays visible.
   */
  degraded?: string | null;
  /** ISO timestamp when this reading was originally fetched from the provider */
  fetchedAt?: string | null;
  windows: QuotaWindow[];
}

export type ProviderAvailabilityState = "available" | "constrained" | "blocked" | "unknown";

export interface ProviderAvailabilityWindow extends QuotaWindow {
  required: boolean;
  matched: boolean;
  blocking: boolean;
}

export interface ProviderAvailabilityLaneStatus {
  provider: string;
  lane: string;
  source: string | null;
  observedAt: string;
  state: ProviderAvailabilityState;
  reason: string;
  nextResetAt: string | null;
  windows: ProviderAvailabilityWindow[];
}

export interface ProviderAvailabilitySnapshot {
  observedAt: string;
  ttlMs: number;
  lanes: ProviderAvailabilityLaneStatus[];
}

export interface LocalBudgetAvailabilityStatus {
  /** Local policies limit runaway work or paid usage; provider windows measure subscription availability. */
  purpose: "safety_guardrail";
  /** True: subscription admission is decided by the provider lanes above, never by local token estimates. */
  subscriptionAvailabilityIsProviderManaged: true;
  state: "ok" | "warning" | "blocked" | "unknown";
  activeIncidentCount: number;
  advisoryWarningCount: number;
  hardStopCount: number;
  pausedAgentCount: number;
  pausedProjectCount: number;
  pendingApprovalCount: number;
}

export interface CompanyProviderAvailability {
  companyId: string;
  observedAt: string;
  ttlMs: number;
  lanes: ProviderAvailabilityLaneStatus[];
  localBudgets: LocalBudgetAvailabilityStatus;
}
