import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { costEvents } from "@paperclipai/db";
import type { CompanyBudgetPacingSnapshot, ProviderBudgetPacing } from "@paperclipai/shared";
import { evaluateBudgetPacing } from "./budget-pacing.js";
import { fetchAllQuotaWindows, providerSlugForAdapterType } from "./quota-windows.js";

const CACHE_TTL_MS = 30_000;
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

type CacheEntry = {
  expiresAt: number;
  value: CompanyBudgetPacingSnapshot;
};

const pacingCache = new Map<string, CacheEntry>();
const pacingInFlight = new Map<string, Promise<CompanyBudgetPacingSnapshot>>();

export { providerSlugForAdapterType };

export type ProviderTokenBurn = {
  provider: string;
  recentTokens: number;
  burnRatePerHour: number;
};

/** Half-open historical window for burn aggregation: [now-24h, now). */
export function recentProviderTokenBurnRange(now: Date): { since: Date; until: Date } {
  return {
    since: new Date(now.getTime() - RECENT_WINDOW_MS),
    until: now,
  };
}

/**
 * Sum input+output tokens from cost_events in [now-24h, now), grouped by provider.
 * Upper-bound (occurredAt < now) excludes future timestamps that would inflate burn rate.
 * Cached input tokens are excluded (same rule as total_tokens budget metric).
 */
export async function loadRecentProviderTokenBurn(
  db: Db,
  companyId: string,
  now = new Date(),
): Promise<Map<string, ProviderTokenBurn>> {
  const { since, until } = recentProviderTokenBurnRange(now);
  const rows = await db
    .select({
      provider: costEvents.provider,
      recentTokens: sql<number>`coalesce(sum(${costEvents.inputTokens} + ${costEvents.outputTokens}), 0)::double precision`,
    })
    .from(costEvents)
    .where(
      and(
        eq(costEvents.companyId, companyId),
        gte(costEvents.occurredAt, since),
        lt(costEvents.occurredAt, until),
      ),
    )
    .groupBy(costEvents.provider);

  const map = new Map<string, ProviderTokenBurn>();
  for (const row of rows) {
    const recentTokens = Math.max(0, Math.floor(Number(row.recentTokens) || 0));
    map.set(row.provider, {
      provider: row.provider,
      recentTokens,
      burnRatePerHour: recentTokens / 24,
    });
  }
  return map;
}

function sourcesFromQuotaResults(
  results: Awaited<ReturnType<typeof fetchAllQuotaWindows>>,
): string {
  const sources = results
    .map((result) => (typeof result.source === "string" && result.source.length > 0 ? result.source : null))
    .filter((value): value is string => Boolean(value));
  if (sources.length === 0) return "provider-quota-adapters";
  return [...new Set(sources)].join(",");
}

export async function computeProviderBudgetPacing(
  db: Db,
  companyId: string,
  options?: {
    now?: Date;
    fetchQuotaWindows?: typeof fetchAllQuotaWindows;
  },
): Promise<CompanyBudgetPacingSnapshot> {
  const now = options?.now ?? new Date();
  const fetchQuotaWindows = options?.fetchQuotaWindows ?? fetchAllQuotaWindows;
  const [quotaResults, burnByProvider] = await Promise.all([
    fetchQuotaWindows(),
    loadRecentProviderTokenBurn(db, companyId, now),
  ]);

  const providers: ProviderBudgetPacing[] = quotaResults.map((result) => {
    const burn = burnByProvider.get(result.provider) ?? {
      provider: result.provider,
      recentTokens: 0,
      burnRatePerHour: 0,
    };
    return evaluateBudgetPacing({
      provider: result.provider,
      windows: result.ok ? result.windows : [],
      recentTokens: burn.recentTokens,
      burnRatePerHour: burn.burnRatePerHour,
      now,
      fetchError: result.ok ? null : (result.error ?? "quota fetch failed"),
    });
  });

  // Include burn-only providers that had recent tokens but no quota adapter result.
  for (const [provider, burn] of burnByProvider) {
    if (providers.some((entry) => entry.provider === provider)) continue;
    providers.push(
      evaluateBudgetPacing({
        provider,
        windows: [],
        recentTokens: burn.recentTokens,
        burnRatePerHour: burn.burnRatePerHour,
        now,
        fetchError: null,
      }),
    );
  }

  return {
    companyId,
    fetchedAt: now.toISOString(),
    source: sourcesFromQuotaResults(quotaResults),
    providers,
  };
}

/**
 * Cached company pacing snapshot. Cache stores only pacing fields — never credentials.
 * Concurrent callers for the same companyId share one in-flight computation (single-flight).
 * bypassCache skips a settled TTL entry but still joins an already-running fetch.
 */
export async function getProviderBudgetPacing(
  db: Db,
  companyId: string,
  options?: {
    now?: Date;
    fetchQuotaWindows?: typeof fetchAllQuotaWindows;
    bypassCache?: boolean;
  },
): Promise<CompanyBudgetPacingSnapshot> {
  const now = options?.now ?? new Date();
  const forceRefresh = options?.bypassCache === true;
  if (!forceRefresh) {
    const cached = pacingCache.get(companyId);
    if (cached && cached.expiresAt > now.getTime()) {
      return cached.value;
    }
  }

  const existing = pacingInFlight.get(companyId);
  if (existing) {
    return existing;
  }

  const request = (async () => {
    const value = await computeProviderBudgetPacing(db, companyId, {
      now,
      fetchQuotaWindows: options?.fetchQuotaWindows,
    });
    pacingCache.set(companyId, {
      expiresAt: now.getTime() + CACHE_TTL_MS,
      value,
    });
    return value;
  })();

  pacingInFlight.set(companyId, request);
  try {
    return await request;
  } finally {
    if (pacingInFlight.get(companyId) === request) {
      pacingInFlight.delete(companyId);
    }
  }
}

/** Find pacing for the provider behind an agent adapter type. */
export function pacingForAdapterType(
  snapshot: CompanyBudgetPacingSnapshot,
  adapterType: string,
): ProviderBudgetPacing | null {
  const provider = providerSlugForAdapterType(adapterType);
  return snapshot.providers.find((entry) => entry.provider === provider) ?? null;
}

/** @internal test-only */
export function clearProviderBudgetPacingCacheForTests() {
  pacingCache.clear();
  pacingInFlight.clear();
}

/** @internal test-only */
export const PROVIDER_BUDGET_PACING_CACHE_TTL_MS = CACHE_TTL_MS;
