import { and, eq, inArray, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

export const ISSUE_BLOCKERS_RESOLVED_WAKE_REASON = "issue_blockers_resolved";

/** Wake dependents when a blocker dies (cancelled / stranded) rather than resolving to done. */
export const ISSUE_BLOCKER_STRANDED_WAKE_REASON = "issue_blocker_stranded";

/** Wake an assignee when an issue is restored onto an actionable status (e.g. blocked→todo). */
export const ISSUE_STATUS_CHANGED_WAKE_REASON = "issue_status_changed";

export type IssueBlockerFate = "cancelled" | "stranded";

const IDEMPOTENT_DEPENDENCY_WAKE_STATUSES = [
  "queued",
  "deferred_issue_execution",
  "claimed",
  "completed",
] as const;

export function buildIssueBlockersResolvedWakeIdempotencyKey(input: {
  dependentIssueId: string;
  resolvedBlockerIssueId: string;
}) {
  return [
    ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
    input.dependentIssueId,
    input.resolvedBlockerIssueId,
  ].join(":");
}

function toEpochMs(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Suppress `issue_blockers_resolved` when the dependent's current blocked
 * episode began after every known blocker completion — historical done edges
 * that predate this wait must not immediately rewake (route restore or
 * liveness backstop).
 *
 * Returns false when chronology cannot be proven (missing
 * `blockedTransitionAt`, empty blocker set, or any blocker lacking
 * `completedAt`) so legacy rows keep the prior heal behavior.
 */
export function shouldSuppressResolvedDependencyWakeForHistoricalBlockers(input: {
  blockedTransitionAt: Date | string | null | undefined;
  blockerCompletedAt: Array<Date | string | null | undefined>;
}): boolean {
  const transitionMs = toEpochMs(input.blockedTransitionAt);
  if (transitionMs == null) return false;
  if (input.blockerCompletedAt.length === 0) return false;

  const completionMs = input.blockerCompletedAt.map(toEpochMs);
  if (completionMs.some((ms) => ms == null)) return false;

  return completionMs.every((ms) => (ms as number) <= transitionMs);
}

/**
 * Idempotency for restore-to-actionable wakes. Bound to the concrete status write
 * (`updatedAt`) so a later legitimate blocked→todo can wake again, while retries
 * of the same mutation do not stack duplicate wakes.
 */
export function buildIssueStatusChangedWakeIdempotencyKey(input: {
  issueId: string;
  fromStatus: string;
  toStatus: string;
  updatedAt: Date | string;
}) {
  const updatedAtMs = input.updatedAt instanceof Date
    ? input.updatedAt.getTime()
    : new Date(input.updatedAt).getTime();
  return [
    ISSUE_STATUS_CHANGED_WAKE_REASON,
    input.issueId,
    `${input.fromStatus}->${input.toStatus}`,
    Number.isFinite(updatedAtMs) ? String(updatedAtMs) : String(input.updatedAt),
  ].join(":");
}

export function buildIssueBlockerStrandedWakeIdempotencyKey(input: {
  dependentIssueId: string;
  deadBlockerIssueId: string;
}) {
  return [
    ISSUE_BLOCKER_STRANDED_WAKE_REASON,
    input.dependentIssueId,
    input.deadBlockerIssueId,
  ].join(":");
}

export function buildIssueBlockerStrandedWakeMessage(blockerFate: IssueBlockerFate) {
  if (blockerFate === "cancelled") {
    return "Your blocker will not reach done (it was cancelled). Decide whether to re-escalate, proceed without it, or call your boss.";
  }
  return "Your blocker will not reach done (recovery stranded it with no live execution path). Decide whether to re-escalate, proceed without it, or call your boss.";
}

export function buildIssueBlockerStrandedWakeRequest(input: {
  dependentIssueId: string;
  deadBlockerIssueId: string;
  blockerIssueIds: string[];
  blockerFate: IssueBlockerFate;
  requestedByActorType: "user" | "agent" | "system";
  requestedByActorId: string | null;
}) {
  const idempotencyKey = buildIssueBlockerStrandedWakeIdempotencyKey({
    dependentIssueId: input.dependentIssueId,
    deadBlockerIssueId: input.deadBlockerIssueId,
  });
  return {
    idempotencyKey,
    wakeup: {
      source: "automation" as const,
      triggerDetail: "system" as const,
      reason: ISSUE_BLOCKER_STRANDED_WAKE_REASON,
      payload: {
        issueId: input.dependentIssueId,
        dependentIssueId: input.dependentIssueId,
        deadBlockerIssueId: input.deadBlockerIssueId,
        blockerFate: input.blockerFate,
        blockerIssueIds: input.blockerIssueIds,
        mutation: input.blockerFate === "cancelled" ? "blocker_cancelled" : "blocker_stranded",
        message: buildIssueBlockerStrandedWakeMessage(input.blockerFate),
      },
      idempotencyKey,
      requestedByActorType: input.requestedByActorType,
      requestedByActorId: input.requestedByActorId,
      contextSnapshot: {
        issueId: input.dependentIssueId,
        taskId: input.dependentIssueId,
        wakeReason: ISSUE_BLOCKER_STRANDED_WAKE_REASON,
        source: "issue.blocker_stranded",
        dependentIssueId: input.dependentIssueId,
        deadBlockerIssueId: input.deadBlockerIssueId,
        blockerFate: input.blockerFate,
        blockerIssueIds: input.blockerIssueIds,
      },
    },
  };
}

type StrandedWakeEnqueue = (
  agentId: string,
  opts: ReturnType<typeof buildIssueBlockerStrandedWakeRequest>["wakeup"],
) => Promise<unknown>;

/**
 * Active (still-blocking) blockers: same predicate as recovery
 * `existingUnresolvedBlockerIssueIds` — status not in done/cancelled.
 * Cancelled and done do not keep a dependent blocked after a dead blocker is removed.
 */
export async function listActiveBlockerIssueIds(
  db: Db,
  companyId: string,
  blockerIssueIds: string[],
): Promise<string[]> {
  const uniqueIds = [...new Set(blockerIssueIds.filter(Boolean))];
  if (uniqueIds.length === 0) return [];
  return db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        inArray(issues.id, uniqueIds),
        notInArray(issues.status, ["done", "cancelled"]),
      ),
    )
    .then((rows) => rows.map((row) => row.id));
}

type ReleaseDeadBlockerUpdate = (
  id: string,
  data: { blockedByIssueIds: string[]; status?: "todo" },
) => Promise<unknown>;

/**
 * After a blocker dies (cancelled / recovery-stranded), remove it from the
 * dependent's blockedByIssueIds. If the dependent was `blocked` and no other
 * active blockers remain, move it to `todo` so planners can actually run it
 * after the stranded wake (isDependencyReady requires blocker.status==='done').
 */
export async function releaseDependentFromDeadBlocker(
  db: Db,
  updateIssue: ReleaseDeadBlockerUpdate,
  input: {
    companyId: string;
    dependentIssueId: string;
    deadBlockerIssueId: string;
    blockerIssueIds: string[];
  },
): Promise<{ remainingBlockerIssueIds: string[]; releasedToTodo: boolean }> {
  const remainingBlockerIssueIds = input.blockerIssueIds.filter(
    (id) => id !== input.deadBlockerIssueId,
  );
  const [dependent, liveBlockerIds] = await Promise.all([
    db
      .select({ status: issues.status })
      .from(issues)
      .where(and(eq(issues.id, input.dependentIssueId), eq(issues.companyId, input.companyId)))
      .then((rows) => rows[0] ?? null),
    listActiveBlockerIssueIds(db, input.companyId, remainingBlockerIssueIds),
  ]);
  const releasedToTodo = dependent?.status === "blocked" && liveBlockerIds.length === 0;
  await updateIssue(input.dependentIssueId, {
    blockedByIssueIds: remainingBlockerIssueIds,
    ...(releasedToTodo ? { status: "todo" as const } : {}),
  });
  return { remainingBlockerIssueIds, releasedToTodo };
}

/** Idempotent stranded-blocker wake shared by issue routes and recovery escalation. */
export async function addDependencyStrandedWakeup(
  db: Db,
  enqueueWakeup: StrandedWakeEnqueue,
  input: {
    companyId: string;
    agentId: string;
    dependentIssueId: string;
    deadBlockerIssueId: string;
    blockerIssueIds: string[];
    blockerFate: IssueBlockerFate;
    requestedByActorType: "user" | "agent" | "system";
    requestedByActorId: string | null;
  },
) {
  const { idempotencyKey, wakeup } = buildIssueBlockerStrandedWakeRequest(input);
  try {
    const existingWake = await findExistingIssueBlockerStrandedWake(db, {
      companyId: input.companyId,
      idempotencyKey,
    });
    if (existingWake) return;
  } catch (err) {
    logger.warn(
      { err, issueId: input.dependentIssueId, idempotencyKey },
      "failed to check existing stranded-blocker wake before enqueue",
    );
  }
  await enqueueWakeup(input.agentId, wakeup);
}

export async function findExistingIssueBlockersResolvedWake(
  db: Db,
  input: {
    companyId: string;
    idempotencyKey: string;
  },
) {
  return db
    .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.idempotencyKey, input.idempotencyKey),
        inArray(agentWakeupRequests.status, [...IDEMPOTENT_DEPENDENCY_WAKE_STATUSES]),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

/** Same idempotency lookup as resolved wakes; shared statuses apply to stranded wakes too. */
export async function findExistingIssueBlockerStrandedWake(
  db: Db,
  input: {
    companyId: string;
    idempotencyKey: string;
  },
) {
  return findExistingIssueBlockersResolvedWake(db, input);
}

/** Same idempotency lookup for restore-to-actionable status-change wakes. */
export async function findExistingIssueStatusChangedWake(
  db: Db,
  input: {
    companyId: string;
    idempotencyKey: string;
  },
) {
  return findExistingIssueBlockersResolvedWake(db, input);
}

export async function findExistingIssueBlockersResolvedWakeForAnyKey(
  db: Db,
  input: {
    companyId: string;
    idempotencyKeys: string[];
  },
) {
  const idempotencyKeys = [...new Set(input.idempotencyKeys.filter(Boolean))];
  if (idempotencyKeys.length === 0) return null;

  return db
    .select({
      id: agentWakeupRequests.id,
      status: agentWakeupRequests.status,
      idempotencyKey: agentWakeupRequests.idempotencyKey,
    })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        inArray(agentWakeupRequests.idempotencyKey, idempotencyKeys),
        inArray(agentWakeupRequests.status, [...IDEMPOTENT_DEPENDENCY_WAKE_STATUSES]),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}
