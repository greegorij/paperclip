import type { ProviderQuotaResult, QuotaWindow } from "@paperclipai/shared";
import { fetchAllQuotaWindows, providerSlugForAdapterType } from "./quota-windows.js";

export const PROVIDER_AVAILABILITY_CACHE_TTL_MS = 30_000;
export const PROVIDER_AVAILABILITY_CONSTRAINED_THRESHOLD_PERCENT = 85;
export const PROVIDER_AVAILABILITY_BLOCKED_THRESHOLD_PERCENT = 100;
const OPENAI_NAMED_WINDOW_SEPARATOR = " · ";

export type ProviderAvailabilityState = "available" | "constrained" | "blocked" | "unknown";

export interface ProviderAvailabilityWindow extends QuotaWindow {
  requiredByBaseLane: boolean;
  namedWindow: boolean;
}

export interface ProviderAvailabilityEntry {
  provider: string;
  laneId: string | null;
  state: ProviderAvailabilityState;
  reason: string;
  source: string | null;
  observedAt: string;
  earliestResetAt: string | null;
  windows: ProviderAvailabilityWindow[];
}

export interface ProviderAvailabilitySnapshot {
  source: "quota_windows";
  observedAt: string;
  expiresAt: string;
  providers: ProviderAvailabilityEntry[];
}

export interface AdapterAvailabilityGate {
  adapterType: string;
  provider: string;
  laneId: string | null;
  state: ProviderAvailabilityState;
  reason: string;
  observedAt: string;
  earliestResetAt: string | null;
}

export interface ProviderAvailabilityService {
  getSnapshot(options?: { forceRefresh?: boolean }): Promise<ProviderAvailabilitySnapshot>;
  evaluateAdapterAvailability(
    adapterType: string,
    options?: { forceRefresh?: boolean; laneId?: string },
  ): Promise<AdapterAvailabilityGate>;
  getEarliestResetForAdapter(adapterType: string): Promise<Date | null>;
  clearCache(): void;
}

type ProviderLaneDefinition = {
  laneId: string;
  provider: string;
  classify: (windows: QuotaWindow[]) => {
    state: ProviderAvailabilityState;
    reason: string;
    earliestResetAt: string | null;
    requiredByLabel: Set<string>;
  };
};

function parseIsoDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function earliestResetIso(windows: QuotaWindow[]): string | null {
  const resets = windows
    .map((window) => parseIsoDate(window.resetsAt))
    .filter((value): value is Date => value != null)
    .sort((left, right) => left.getTime() - right.getTime());
  return resets[0] ? resets[0].toISOString() : null;
}

function isOpenAiBaseWindow(window: QuotaWindow): boolean {
  if (window.label.includes(OPENAI_NAMED_WINDOW_SEPARATOR)) return false;
  if (!window.label.toLowerCase().endsWith("limit")) return false;
  return window.label.trim().toLowerCase() !== "credits";
}

function classifyOpenAiBaseLane(windows: QuotaWindow[]) {
  const required = windows.filter((window) => isOpenAiBaseWindow(window));
  const blockedWindows = required.filter((window) =>
    typeof window.usedPercent === "number" && window.usedPercent >= PROVIDER_AVAILABILITY_BLOCKED_THRESHOLD_PERCENT
  );
  if (blockedWindows.length > 0) {
    return {
      state: "blocked" as const,
      reason: "OpenAI base quota window is exhausted.",
      earliestResetAt: earliestResetIso(blockedWindows),
      requiredByLabel: new Set(required.map((window) => window.label)),
    };
  }
  if (required.length === 0) {
    return {
      state: "unknown" as const,
      reason: "OpenAI quota telemetry has no base-lane windows.",
      earliestResetAt: null,
      requiredByLabel: new Set<string>(),
    };
  }
  if (required.some((window) => window.usedPercent == null)) {
    return {
      state: "unknown" as const,
      reason: "OpenAI base-lane quota telemetry is incomplete.",
      earliestResetAt: null,
      requiredByLabel: new Set(required.map((window) => window.label)),
    };
  }
  if (
    required.some((window) =>
      typeof window.usedPercent === "number" &&
      window.usedPercent >= PROVIDER_AVAILABILITY_CONSTRAINED_THRESHOLD_PERCENT
    )
  ) {
    return {
      state: "constrained" as const,
      reason: `OpenAI base quota usage is at or above ${PROVIDER_AVAILABILITY_CONSTRAINED_THRESHOLD_PERCENT}%.`,
      earliestResetAt: earliestResetIso(required),
      requiredByLabel: new Set(required.map((window) => window.label)),
    };
  }
  return {
    state: "available" as const,
    reason: "OpenAI base quota windows are below constrained thresholds.",
    earliestResetAt: earliestResetIso(required),
    requiredByLabel: new Set(required.map((window) => window.label)),
  };
}

function classifyAnthropicBaseLane(windows: QuotaWindow[]) {
  const requiredMatchers = [
    { key: "current_session", label: "Current session", matcher: /^current session$/i },
    { key: "current_week_all_models", label: "Current week (all models)", matcher: /^current week \(all models\)$/i },
  ] as const;
  const matchedByKey = new Map<string, QuotaWindow>();
  for (const window of windows) {
    const normalizedLabel = window.label.trim();
    for (const required of requiredMatchers) {
      if (required.matcher.test(normalizedLabel)) {
        matchedByKey.set(required.key, window);
      }
    }
  }
  const required = [...matchedByKey.values()];
  const blockedWindows = required.filter((window) =>
    typeof window.usedPercent === "number" && window.usedPercent >= PROVIDER_AVAILABILITY_BLOCKED_THRESHOLD_PERCENT
  );
  if (blockedWindows.length > 0) {
    return {
      state: "blocked" as const,
      reason: "Anthropic session or weekly base quota window is exhausted.",
      earliestResetAt: earliestResetIso(blockedWindows),
      requiredByLabel: new Set(required.map((window) => window.label)),
    };
  }
  const missingAnyRequired = requiredMatchers.some((required) => !matchedByKey.has(required.key));
  if (missingAnyRequired || required.some((window) => window.usedPercent == null)) {
    return {
      state: "unknown" as const,
      reason: "Anthropic session/weekly base quota telemetry is incomplete.",
      earliestResetAt: earliestResetIso(required),
      requiredByLabel: new Set(required.map((window) => window.label)),
    };
  }
  if (
    required.some((window) =>
      typeof window.usedPercent === "number" &&
      window.usedPercent >= PROVIDER_AVAILABILITY_CONSTRAINED_THRESHOLD_PERCENT
    )
  ) {
    return {
      state: "constrained" as const,
      reason: `Anthropic base quota usage is at or above ${PROVIDER_AVAILABILITY_CONSTRAINED_THRESHOLD_PERCENT}%.`,
      earliestResetAt: earliestResetIso(required),
      requiredByLabel: new Set(required.map((window) => window.label)),
    };
  }
  return {
    state: "available" as const,
    reason: "Anthropic session/weekly base quota windows are below constrained thresholds.",
    earliestResetAt: earliestResetIso(required),
    requiredByLabel: new Set(required.map((window) => window.label)),
  };
}

const PROVIDER_LANES: ProviderLaneDefinition[] = [
  {
    laneId: "openai_base",
    provider: "openai",
    classify: classifyOpenAiBaseLane,
  },
  {
    laneId: "anthropic_base",
    provider: "anthropic",
    classify: classifyAnthropicBaseLane,
  },
];

const PROVIDER_LANE_BY_ID = new Map(
  PROVIDER_LANES.map((lane) => [lane.laneId, lane]),
);
const DEFAULT_LANE_ID_BY_ADAPTER_TYPE = new Map<string, string>([
  ["codex_local", "openai_base"],
  ["claude_local", "anthropic_base"],
]);

function coerceError(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function mergeProviderQuotaResults(results: ProviderQuotaResult[]) {
  const merged = new Map<string, ProviderQuotaResult>();
  for (const result of results) {
    const existing = merged.get(result.provider);
    if (!existing) {
      merged.set(result.provider, {
        provider: result.provider,
        source: result.source ?? null,
        ok: result.ok,
        errorFamily: result.errorFamily ?? null,
        error: result.error,
        windows: [...result.windows],
      });
      continue;
    }
    existing.source = existing.source ?? result.source ?? null;
    existing.windows = [...existing.windows, ...result.windows];
    existing.ok = existing.ok || result.ok;
    if (!existing.error && result.error) existing.error = result.error;
    if (!existing.errorFamily && result.errorFamily) existing.errorFamily = result.errorFamily;
  }
  return [...merged.values()];
}

function buildUnavailableEntry(input: {
  provider: string;
  laneId: string | null;
  observedAt: string;
  reason: string;
  source?: string | null;
}): ProviderAvailabilityEntry {
  return {
    provider: input.provider,
    laneId: input.laneId,
    state: "unknown",
    reason: input.reason,
    source: input.source ?? null,
    observedAt: input.observedAt,
    earliestResetAt: null,
    windows: [],
  };
}

export function createProviderAvailabilityService(options: {
  ttlMs?: number;
  fetchQuotaWindows?: () => Promise<ProviderQuotaResult[]>;
  now?: () => Date;
} = {}): ProviderAvailabilityService {
  const ttlMs = options.ttlMs ?? PROVIDER_AVAILABILITY_CACHE_TTL_MS;
  const fetchQuotaWindows = options.fetchQuotaWindows ?? fetchAllQuotaWindows;
  const now = options.now ?? (() => new Date());
  let cache: { snapshot: ProviderAvailabilitySnapshot; expiresAtMs: number } | null = null;
  let inFlight: Promise<ProviderAvailabilitySnapshot> | null = null;

  async function computeSnapshot(): Promise<ProviderAvailabilitySnapshot> {
    let quotaResults: ProviderQuotaResult[];
    try {
      quotaResults = mergeProviderQuotaResults(await fetchQuotaWindows());
    } catch (error) {
      const observedAt = now().toISOString();
      const providers = PROVIDER_LANES.map((lane) =>
        buildUnavailableEntry({
          provider: lane.provider,
          laneId: lane.laneId,
          observedAt,
          reason: `Provider quota telemetry failed: ${coerceError(error)}`,
        })
      );
      return {
        source: "quota_windows",
        observedAt,
        expiresAt: new Date(now().getTime() + ttlMs).toISOString(),
        providers,
      };
    }

    const observedAt = now().toISOString();
    const quotaByProvider = new Map(quotaResults.map((result) => [result.provider, result]));
    const providers: ProviderAvailabilityEntry[] = [];
    for (const lane of PROVIDER_LANES) {
      const quota = quotaByProvider.get(lane.provider);
      if (!quota) {
        providers.push(
          buildUnavailableEntry({
            provider: lane.provider,
            laneId: lane.laneId,
            observedAt,
            reason: "No provider quota telemetry available.",
          }),
        );
        continue;
      }
      if (!quota.ok) {
        providers.push(
          buildUnavailableEntry({
            provider: lane.provider,
            laneId: lane.laneId,
            observedAt,
            source: quota.source ?? null,
            reason: quota.error
              ? `Provider quota telemetry error: ${quota.error}`
              : "Provider quota telemetry failed.",
          }),
        );
        continue;
      }

      const classified = lane.classify(quota.windows);
      providers.push({
        provider: lane.provider,
        laneId: lane.laneId,
        state: classified.state,
        reason: classified.reason,
        source: quota.source ?? null,
        observedAt,
        earliestResetAt: classified.earliestResetAt,
        windows: quota.windows.map((window) => ({
          ...window,
          requiredByBaseLane: classified.requiredByLabel.has(window.label),
          namedWindow: window.label.includes(OPENAI_NAMED_WINDOW_SEPARATOR),
        })),
      });
    }
    for (const quota of quotaResults) {
      const knownLaneForProvider = PROVIDER_LANES.some((lane) => lane.provider === quota.provider);
      if (knownLaneForProvider) continue;
      providers.push({
        provider: quota.provider,
        laneId: null,
        state: "unknown",
        reason: "No base quota lane is defined for this provider.",
        source: quota.source ?? null,
        observedAt,
        earliestResetAt: null,
        windows: quota.windows.map((window) => ({
          ...window,
          requiredByBaseLane: false,
          namedWindow: window.label.includes(OPENAI_NAMED_WINDOW_SEPARATOR),
        })),
      });
    }

    const expiresAt = new Date(now().getTime() + ttlMs).toISOString();
    providers.sort((left, right) => `${left.provider}:${left.laneId ?? ""}`.localeCompare(`${right.provider}:${right.laneId ?? ""}`));
    return {
      source: "quota_windows",
      observedAt,
      expiresAt,
      providers,
    };
  }

  async function getSnapshot(optionsInput: { forceRefresh?: boolean } = {}): Promise<ProviderAvailabilitySnapshot> {
    const nowMs = now().getTime();
    const forceRefresh = optionsInput.forceRefresh === true;
    if (!forceRefresh && cache && nowMs < cache.expiresAtMs) {
      return cache.snapshot;
    }
    if (!forceRefresh && inFlight) {
      return inFlight;
    }
    const request = computeSnapshot();
    inFlight = request;
    try {
      const snapshot = await request;
      cache = {
        snapshot,
        expiresAtMs: parseIsoDate(snapshot.expiresAt)?.getTime() ?? (now().getTime() + ttlMs),
      };
      return snapshot;
    } finally {
      if (inFlight === request) inFlight = null;
    }
  }

  async function evaluateAdapterAvailability(
    adapterType: string,
    optionsInput: { forceRefresh?: boolean; laneId?: string } = {},
  ): Promise<AdapterAvailabilityGate> {
    const laneId = optionsInput.laneId ?? DEFAULT_LANE_ID_BY_ADAPTER_TYPE.get(adapterType) ?? null;
    const lane = laneId ? PROVIDER_LANE_BY_ID.get(laneId) ?? null : null;
    const provider = lane?.provider ?? providerSlugForAdapterType(adapterType);
    if (!lane) {
      return {
        adapterType,
        provider,
        laneId: null,
        state: "unknown",
        reason: "No provider quota lane applies to this adapter.",
        observedAt: now().toISOString(),
        earliestResetAt: null,
      };
    }

    const snapshot = await getSnapshot({ forceRefresh: optionsInput.forceRefresh });
    const providerEntry = snapshot.providers.find((entry) => entry.provider === provider);
    const laneEntry = providerEntry?.laneId === lane.laneId
      ? providerEntry
      : snapshot.providers.find(
        (entry) => entry.provider === provider && entry.laneId === lane.laneId,
      ) ?? null;
    if (!laneEntry) {
      return {
        adapterType,
        provider,
        laneId: lane.laneId,
        state: "unknown",
        reason: "Provider quota telemetry did not include this provider.",
        observedAt: snapshot.observedAt,
        earliestResetAt: null,
      };
    }
    return {
      adapterType,
      provider,
      laneId: laneEntry.laneId,
      state: laneEntry.state,
      reason: laneEntry.reason,
      observedAt: laneEntry.observedAt,
      earliestResetAt: laneEntry.earliestResetAt,
    };
  }

  async function getEarliestResetForAdapter(adapterType: string): Promise<Date | null> {
    const gate = await evaluateAdapterAvailability(adapterType);
    return parseIsoDate(gate.earliestResetAt);
  }

  function clearCache() {
    cache = null;
    inFlight = null;
  }

  return {
    getSnapshot,
    evaluateAdapterAvailability,
    getEarliestResetForAdapter,
    clearCache,
  };
}

const sharedProviderAvailabilityService = createProviderAvailabilityService();

export function getProviderAvailabilityService(): ProviderAvailabilityService {
  return sharedProviderAvailabilityService;
}

export function clearProviderAvailabilityCacheForTests() {
  sharedProviderAvailabilityService.clearCache();
}
