import { and, eq, gte, isNull, lt, ne, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { costEvents, heartbeatRuns } from "@paperclipai/db";
import { asNumber, parseObject } from "../adapters/utils.js";

/** Preflight workspace failures never reach adapter/model invocation; exclude from run caps. */
const PREFLIGHT_WORKSPACE_VALIDATION_FAILURE_CODE = "workspace_validation_failed";

export type HeartbeatDailyCapPolicy = {
  maxDailyRuns: number | null;
  maxDailyCostCents: number | null;
};

export type HeartbeatDailyCapBlock = {
  reason: "heartbeat.daily_run_limit" | "heartbeat.daily_cost_limit";
  observed: number;
  limit: number;
};

export type HeartbeatDailyCapAgent = {
  id: string;
  companyId: string;
};

function normalizeOptionalNonNegativeInteger(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = Math.floor(asNumber(value, 0));
  return normalized >= 0 ? normalized : null;
}

/** Exact UTC calendar-day window used by heartbeat daily run/cost gates. */
export function currentUtcDayWindow(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
  return { start, end };
}

/**
 * Minimal heartbeat daily-cap fields from agent.runtimeConfig.heartbeat.
 * Alias keys match heartbeat.parseHeartbeatPolicy.
 */
export function parseHeartbeatDailyCapPolicy(runtimeConfig: unknown): HeartbeatDailyCapPolicy {
  const heartbeat = parseObject(parseObject(runtimeConfig).heartbeat);
  return {
    maxDailyRuns: normalizeOptionalNonNegativeInteger(
      heartbeat.maxDailyRuns ?? heartbeat.dailyRunLimit ?? heartbeat.dailyRunCap ?? heartbeat.maxRunsPerDay,
    ),
    maxDailyCostCents: normalizeOptionalNonNegativeInteger(
      heartbeat.maxDailyCostCents ??
        heartbeat.dailyCostCentsLimit ??
        heartbeat.dailySpendCentsLimit ??
        heartbeat.dailyBudgetCents,
    ),
  };
}

/**
 * Same effective daily run/cost gate heartbeat uses before queueing / claiming a wake.
 * Shared so watchdog recovery can avoid reopening into an immediately skipped wake
 * without importing the heartbeat service (cycle: heartbeat → task-watchdogs).
 */
export async function getHeartbeatDailyCapBlock(
  agent: HeartbeatDailyCapAgent,
  policy: HeartbeatDailyCapPolicy,
  options: { checkRunCap?: boolean; checkCostCap?: boolean; excludeRunId?: string | null } = {},
  client: Pick<Db, "select">,
): Promise<HeartbeatDailyCapBlock | null> {
  const checkRunCap = options.checkRunCap ?? true;
  const checkCostCap = options.checkCostCap ?? true;
  const { start, end } = currentUtcDayWindow();
  if (checkRunCap && policy.maxDailyRuns !== null) {
    const conditions = [
      eq(heartbeatRuns.companyId, agent.companyId),
      eq(heartbeatRuns.agentId, agent.id),
      gte(heartbeatRuns.startedAt, start),
      lt(heartbeatRuns.startedAt, end),
      notInArray(heartbeatRuns.status, ["queued", "scheduled_retry"]),
      // Preflight workspace_validation_failed dies before adapter/model start and
      // must not consume maxDailyRuns. Started cancelled runs still count.
      or(
        isNull(heartbeatRuns.errorCode),
        ne(heartbeatRuns.errorCode, PREFLIGHT_WORKSPACE_VALIDATION_FAILURE_CODE),
      ),
    ];
    if (options.excludeRunId) {
      conditions.push(sql`${heartbeatRuns.id} <> ${options.excludeRunId}`);
    }
    const [row] = await client
      .select({ total: sql<number>`count(*)::integer` })
      .from(heartbeatRuns)
      .where(and(...conditions));
    const observed = Number(row?.total ?? 0);
    if (observed >= policy.maxDailyRuns) {
      return {
        reason: "heartbeat.daily_run_limit",
        observed,
        limit: policy.maxDailyRuns,
      };
    }
  }

  if (checkCostCap && policy.maxDailyCostCents !== null) {
    const [row] = await client
      .select({ total: sql<number>`coalesce(sum(${costEvents.costCents})::bigint, 0)` })
      .from(costEvents)
      .where(
        and(
          eq(costEvents.companyId, agent.companyId),
          eq(costEvents.agentId, agent.id),
          gte(costEvents.occurredAt, start),
          lt(costEvents.occurredAt, end),
        ),
      );
    const observed = Number(row?.total ?? 0);
    if (observed >= policy.maxDailyCostCents) {
      return {
        reason: "heartbeat.daily_cost_limit",
        observed,
        limit: policy.maxDailyCostCents,
      };
    }
  }

  return null;
}
