import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  approvals,
  companies,
  createDb,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueApprovals,
  issueRelations,
  issueThreadInteractions,
  issueWorkProducts,
  issues,
  issueWatchdogs,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { taskWatchdogService } from "../services/task-watchdogs.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres task watchdog scheduler tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("task watchdog scheduler", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-task-watchdogs-scheduler-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issueThreadInteractions);
    await db.delete(issueWorkProducts);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issueComments);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueRelations);
    await db.delete(issueWatchdogs);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Watchdog Co",
      issuePrefix: `WD${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      issueCounter: 0,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, overrides: Partial<typeof agents.$inferInsert> = {}) {
    const id = overrides.id ?? randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name: overrides.name ?? "Watchdog Agent",
      role: overrides.role ?? "engineer",
      status: overrides.status ?? "active",
      adapterType: overrides.adapterType ?? "codex_local",
      adapterConfig: overrides.adapterConfig ?? {},
      runtimeConfig: overrides.runtimeConfig ?? {},
      permissions: overrides.permissions ?? {},
      reportsTo: overrides.reportsTo,
    });
    return id;
  }

  async function seedIssue(companyId: string, overrides: Partial<typeof issues.$inferInsert> = {}) {
    const id = overrides.id ?? randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: overrides.title ?? "Watched issue",
      status: overrides.status ?? "done",
      priority: overrides.priority ?? "medium",
      identifier: overrides.identifier ?? `WDOG-${Math.floor(Math.random() * 10_000)}`,
      issueNumber: overrides.issueNumber ?? Math.floor(Math.random() * 10_000),
      parentId: overrides.parentId,
      assigneeAgentId: overrides.assigneeAgentId,
      originKind: overrides.originKind,
      originId: overrides.originId,
      originFingerprint: overrides.originFingerprint,
      updatedAt: overrides.updatedAt,
      // Default to an "established" issue (created well before the first-run
      // grace window) so the pending-first-run guard does not defer it. Tests
      // exercising the create-race pass an explicit recent `createdAt`.
      createdAt: overrides.createdAt ?? new Date(Date.now() - 60 * 60 * 1000),
    });
    return id;
  }

  async function seedIssueDocument(companyId: string, issueId: string, updatedAt: Date) {
    const [document] = await db.insert(documents).values({
      companyId,
      title: "Plan",
      latestBody: "Plan body",
      updatedAt,
    }).returning();
    await db.insert(issueDocuments).values({
      companyId,
      issueId,
      documentId: document!.id,
      key: "plan",
      updatedAt,
    });
  }

  async function seedIssueWorkProduct(companyId: string, issueId: string, updatedAt: Date) {
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId,
      type: "artifact",
      provider: "test",
      title: "Report",
      status: "ready",
      updatedAt,
    });
  }

  async function seedWatchdog(companyId: string, issueId: string, agentId: string) {
    const [row] = await db.insert(issueWatchdogs).values({
      companyId,
      issueId,
      watchdogAgentId: agentId,
      instructions: "Verify stopped work.",
      status: "active",
    }).returning();
    return row;
  }

  function createService() {
    const wakes: Array<{ agentId: string; opts: Record<string, unknown> | undefined }> = [];
    const service = taskWatchdogService(db, {
      enqueueWakeup: async (agentId, opts) => {
        wakes.push({ agentId, opts });
        return { id: randomUUID() };
      },
    });
    return { service, wakes };
  }

  const expectedTaskWatchdogAssigneeAdapterOverrides = {
    modelProfile: "cheap",
    adapterConfig: {
      timeoutSec: 300,
      graceSec: 15,
    },
  };

  it("creates one reusable watchdog issue and wakes the watchdog on the initial stopped state", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-1", status: "done" });
    const agentId = await seedAgent(companyId);
    await seedWatchdog(companyId, sourceId, agentId);
    const { service, wakes } = createService();

    const result = await service.reconcileTaskWatchdogs({ companyId });

    expect(result).toMatchObject({ checked: 1, triggered: 1 });
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.agentId).toBe(agentId);
    expect(wakes[0]?.opts?.reason).toBe("task_watchdog_stopped_subtree");
    expect(wakes[0]?.opts?.idempotencyKey).toMatch(/^task_watchdog:[^:]+:task_watchdog_stop:/);
    expect(wakes[0]?.opts?.contextSnapshot).toMatchObject({
      taskWatchdog: {
        watchedIssueId: sourceId,
        watchedIssueIdentifier: "WDOG-1",
        capabilities: {
          targetScope: {
            watchedIssueId: sourceId,
            includeNonWatchdogDescendants: true,
            excludedOriginKinds: ["task_watchdog"],
          },
          operations: expect.arrayContaining([
            "comment_on_watched_subtree_issues",
            "create_child_issues_under_non_watchdog_watched_subtree",
            "create_product_bug_followups_outside_watched_subtree",
            "update_reusable_watchdog_issue",
          ]),
          deniedOperations: expect.arrayContaining([
            "create_visible_probe_issues_or_throwaway_tasks",
            "create_product_bug_followups_as_source_tree_children",
            "mutate_task_watchdog_descendants",
          ]),
        },
      },
    });

    const watchdogIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "task_watchdog")));
    expect(watchdogIssues).toHaveLength(1);
    expect(watchdogIssues[0]).toMatchObject({
      parentId: sourceId,
      originId: sourceId,
      assigneeAgentId: agentId,
      status: "todo",
      assigneeAdapterOverrides: expectedTaskWatchdogAssigneeAdapterOverrides,
    });
    expect(watchdogIssues[0]?.description).toContain("Produce one evidence-based disposition");
    expect(watchdogIssues[0]?.description).toContain(
      "Do not perform broad API or documentation exploration when the heartbeat wake context and stopped snapshot already answer the question.",
    );

    const [watchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    expect(watchdog?.watchdogIssueId).toBe(watchdogIssues[0]?.id);
    expect(watchdog?.lastObservedFingerprint).toMatch(/^task_watchdog_stop:/);
    expect(watchdog?.lastObservedStopSnapshot).toMatchObject({
      version: 2,
      fingerprint: watchdog?.lastObservedFingerprint,
      materialLeaves: [],
      waitsByIssueId: {},
    });
    expect(watchdog?.triggerCount).toBe(1);
  });

  it("sets assigneeAdapterOverrides when creating a task-watchdog issue", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-OVERRIDE-CREATE", status: "done" });
    const agentId = await seedAgent(companyId);
    await seedWatchdog(companyId, sourceId, agentId);
    const { service } = createService();

    const result = await service.reconcileTaskWatchdogs({ companyId });

    expect(result).toMatchObject({ checked: 1, triggered: 1 });
    const [watchdogIssue] = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "task_watchdog")));
    expect(watchdogIssue?.assigneeAdapterOverrides).toEqual(expectedTaskWatchdogAssigneeAdapterOverrides);
  });

  it("sets assigneeAdapterOverrides when reopening a task-watchdog issue", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-OVERRIDE-REOPEN", status: "done" });
    const childId = await seedIssue(companyId, { parentId: sourceId, status: "done" });
    const agentId = await seedAgent(companyId);
    await seedWatchdog(companyId, sourceId, agentId);
    const { service } = createService();

    await service.reconcileTaskWatchdogs({ companyId });
    const [firstWatchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    const watchdogIssueId = firstWatchdog!.watchdogIssueId!;
    await db.update(issues).set({
      status: "done",
      assigneeAdapterOverrides: null,
      updatedAt: new Date(),
    }).where(eq(issues.id, watchdogIssueId));

    const reviewed = await service.reconcileTaskWatchdogs({ companyId });
    expect(reviewed).toMatchObject({ checked: 1, triggered: 0, alreadyReviewed: 1 });

    await db
      .update(issues)
      .set({ status: "blocked", updatedAt: new Date(Date.now() + 60_000) })
      .where(eq(issues.id, childId));
    const retriggered = await service.reconcileTaskWatchdogs({ companyId });

    expect(retriggered).toMatchObject({ checked: 1, triggered: 1 });
    const [reopened] = await db.select().from(issues).where(eq(issues.id, watchdogIssueId));
    expect(reopened).toMatchObject({
      status: "todo",
      assigneeAdapterOverrides: expectedTaskWatchdogAssigneeAdapterOverrides,
    });
  });

  it("does not append duplicate review comments for an already-open same-fingerprint review", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-DUPE", status: "done" });
    const agentId = await seedAgent(companyId);
    await seedWatchdog(companyId, sourceId, agentId);
    const { service, wakes } = createService();

    const first = await service.reconcileTaskWatchdogs({ companyId });
    expect(first).toMatchObject({ checked: 1, triggered: 1 });

    const [firstWatchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    const watchdogIssueId = firstWatchdog!.watchdogIssueId!;
    const initialComments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, watchdogIssueId));
    expect(initialComments).toHaveLength(1);

    const second = await service.reconcileTaskWatchdogs({ companyId });

    expect(second).toMatchObject({ checked: 1, triggered: 0, live: 1 });
    expect(wakes).toHaveLength(1);
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, watchdogIssueId));
    expect(comments).toHaveLength(1);
    const [watchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    expect(watchdog?.lastObservedFingerprint).toBe(firstWatchdog?.lastObservedFingerprint);
    expect(watchdog?.triggerCount).toBe(1);
  });

  it("re-wakes a same-fingerprint watchdog review stuck in stale in_review", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-STALE", status: "done" });
    const agentId = await seedAgent(companyId);
    await seedWatchdog(companyId, sourceId, agentId);
    const { service, wakes } = createService();

    const first = await service.reconcileTaskWatchdogs({ companyId });
    expect(first).toMatchObject({ checked: 1, triggered: 1 });

    const [firstWatchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    const watchdogIssueId = firstWatchdog!.watchdogIssueId!;
    await db
      .update(issues)
      .set({
        status: "in_review",
        assigneeAgentId: null,
        assigneeUserId: null,
        executionState: null,
        monitorNextCheckAt: null,
      })
      .where(eq(issues.id, watchdogIssueId));

    const second = await service.reconcileTaskWatchdogs({ companyId });

    expect(second).toMatchObject({ checked: 1, triggered: 1 });
    expect(wakes).toHaveLength(2);
    const [watchdogIssue] = await db.select().from(issues).where(eq(issues.id, watchdogIssueId));
    expect(watchdogIssue).toMatchObject({
      status: "todo",
      assigneeAgentId: agentId,
      originFingerprint: firstWatchdog?.lastObservedFingerprint,
    });
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, watchdogIssueId));
    expect(comments).toHaveLength(2);
    const [watchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    expect(watchdog?.triggerCount).toBe(2);
  });

  it("recovers a previously reviewed blocked watchdog only after its agent is invokable again", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-BLOCK-RECOVER", status: "done" });
    const agentId = await seedAgent(companyId);
    await seedWatchdog(companyId, sourceId, agentId);
    const { service, wakes } = createService();

    const first = await service.reconcileTaskWatchdogs({ companyId });
    expect(first).toMatchObject({ checked: 1, triggered: 1 });

    const [firstWatchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    const watchdogIssueId = firstWatchdog!.watchdogIssueId!;
    const stopFingerprint = firstWatchdog!.lastObservedFingerprint!;

    // Simulate a skipped wake (e.g. heartbeat.daily_run_limit / budget pause):
    // generated watchdog is blocked with no explicit issue blocker, no live
    // path, and a stale lastReviewedFingerprint that would otherwise make
    // later reconciles exit as already_reviewed forever.
    await db
      .update(issues)
      .set({
        status: "blocked",
        assigneeAgentId: agentId,
        executionRunId: null,
        checkoutRunId: null,
        executionState: null,
        monitorNextCheckAt: null,
      })
      .where(eq(issues.id, watchdogIssueId));
    await db
      .update(issueWatchdogs)
      .set({
        lastReviewedFingerprint: stopFingerprint,
        lastReviewedStopSnapshot: firstWatchdog!.lastObservedStopSnapshot,
        lastCompletedAt: new Date(),
      })
      .where(eq(issueWatchdogs.issueId, sourceId));
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agentId));
    wakes.length = 0;

    // While the agent limit/pause remains active, keep strict no-retry behavior.
    const whilePaused = await service.reconcileTaskWatchdogs({ companyId });
    expect(whilePaused).toMatchObject({ checked: 1, triggered: 0, alreadyReviewed: 1 });
    expect(wakes).toHaveLength(0);
    const [stillBlocked] = await db.select().from(issues).where(eq(issues.id, watchdogIssueId));
    expect(stillBlocked).toMatchObject({
      status: "blocked",
      originFingerprint: stopFingerprint,
    });
    const [stillReviewed] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    expect(stillReviewed?.lastReviewedFingerprint).toBe(stopFingerprint);
    expect(stillReviewed?.triggerCount).toBe(1);

    // Effective availability returns → clear the stale reviewed stamp and resume.
    await db.update(agents).set({ status: "active" }).where(eq(agents.id, agentId));
    const recovered = await service.reconcileTaskWatchdogs({ companyId });

    expect(recovered).toMatchObject({ checked: 1, triggered: 1 });
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.agentId).toBe(agentId);
    expect(wakes[0]?.opts?.idempotencyKey).toBe(`task_watchdog:${firstWatchdog!.id}:${stopFingerprint}`);
    const [watchdogIssue] = await db.select().from(issues).where(eq(issues.id, watchdogIssueId));
    expect(watchdogIssue).toMatchObject({
      status: "todo",
      assigneeAgentId: agentId,
      originFingerprint: stopFingerprint,
    });
    const [watchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    expect(watchdog?.triggerCount).toBe(2);
    expect(watchdog?.lastReviewedFingerprint).toBeNull();

    // Once reopened to todo, the same fingerprint stays an open review and does
    // not stack another wake (idempotent recovery).
    const third = await service.reconcileTaskWatchdogs({ companyId });
    expect(third).toMatchObject({ checked: 1, triggered: 0, live: 1 });
    expect(wakes).toHaveLength(1);
  });

  it("keeps a maxDailyRuns-capped agent blocked/reviewed until the daily cap is lifted", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-BLOCK-DAILY-CAP", status: "done" });
    const agentId = await seedAgent(companyId, {
      runtimeConfig: {
        heartbeat: {
          maxDailyRuns: 1,
        },
      },
    });
    await seedWatchdog(companyId, sourceId, agentId);
    const { service, wakes } = createService();

    const first = await service.reconcileTaskWatchdogs({ companyId });
    expect(first).toMatchObject({ checked: 1, triggered: 1 });

    const [firstWatchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    const watchdogIssueId = firstWatchdog!.watchdogIssueId!;
    const stopFingerprint = firstWatchdog!.lastObservedFingerprint!;

    // Same skipped-wake stall as production: blocked + stale reviewed stamp,
    // agent remains org-invokable but heartbeat.daily_run_limit is already hit.
    await db
      .update(issues)
      .set({
        status: "blocked",
        assigneeAgentId: agentId,
        executionRunId: null,
        checkoutRunId: null,
        executionState: null,
        monitorNextCheckAt: null,
      })
      .where(eq(issues.id, watchdogIssueId));
    await db
      .update(issueWatchdogs)
      .set({
        lastReviewedFingerprint: stopFingerprint,
        lastReviewedStopSnapshot: firstWatchdog!.lastObservedStopSnapshot,
        lastCompletedAt: new Date(),
      })
      .where(eq(issueWatchdogs.issueId, sourceId));
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "succeeded",
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: {},
    });
    wakes.length = 0;

    const whileCapped = await service.reconcileTaskWatchdogs({ companyId });
    expect(whileCapped).toMatchObject({ checked: 1, triggered: 0, alreadyReviewed: 1 });
    expect(wakes).toHaveLength(0);
    const [stillBlocked] = await db.select().from(issues).where(eq(issues.id, watchdogIssueId));
    expect(stillBlocked).toMatchObject({
      status: "blocked",
      originFingerprint: stopFingerprint,
    });
    const [stillReviewed] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    expect(stillReviewed?.lastReviewedFingerprint).toBe(stopFingerprint);
    expect(stillReviewed?.triggerCount).toBe(1);

    // Lift the UTC-day run cap → recovery becomes eligible without changing org status.
    await db
      .update(agents)
      .set({
        runtimeConfig: {
          heartbeat: {},
        },
      })
      .where(eq(agents.id, agentId));
    const recovered = await service.reconcileTaskWatchdogs({ companyId });

    expect(recovered).toMatchObject({ checked: 1, triggered: 1 });
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.agentId).toBe(agentId);
    expect(wakes[0]?.opts?.idempotencyKey).toBe(`task_watchdog:${firstWatchdog!.id}:${stopFingerprint}`);
    const [watchdogIssue] = await db.select().from(issues).where(eq(issues.id, watchdogIssueId));
    expect(watchdogIssue).toMatchObject({
      status: "todo",
      assigneeAgentId: agentId,
      originFingerprint: stopFingerprint,
    });
    const [watchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    expect(watchdog?.triggerCount).toBe(2);
    expect(watchdog?.lastReviewedFingerprint).toBeNull();
  });

  it("keeps a normal reviewed disposition closed after a completed watchdog review", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-REVIEW-CLOSED", status: "done" });
    const agentId = await seedAgent(companyId);
    await seedWatchdog(companyId, sourceId, agentId);
    const { service, wakes } = createService();

    const first = await service.reconcileTaskWatchdogs({ companyId });
    expect(first).toMatchObject({ checked: 1, triggered: 1 });

    const [firstWatchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    const watchdogIssueId = firstWatchdog!.watchdogIssueId!;
    await db.update(issues).set({ status: "done", updatedAt: new Date() }).where(eq(issues.id, watchdogIssueId));
    wakes.length = 0;

    const reviewed = await service.reconcileTaskWatchdogs({ companyId });
    expect(reviewed).toMatchObject({ checked: 1, triggered: 0, alreadyReviewed: 1 });
    expect(wakes).toHaveLength(0);
    const [reviewedWatchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    expect(reviewedWatchdog?.lastReviewedFingerprint).toBe(firstWatchdog?.lastObservedFingerprint);

    const again = await service.reconcileTaskWatchdogs({ companyId });
    expect(again).toMatchObject({ checked: 1, triggered: 0, alreadyReviewed: 1 });
    expect(wakes).toHaveLength(0);
  });

  it("blocks an ineffective todo review for the same fingerprint and retries a material change once", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-ACTION", status: "todo" });
    const agentId = await seedAgent(companyId);
    await seedWatchdog(companyId, sourceId, agentId);
    const { service, wakes } = createService();

    const first = await service.reconcileTaskWatchdogs({ companyId });
    expect(first).toMatchObject({ checked: 1, triggered: 1 });
    const [firstWatchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    const watchdogIssueId = firstWatchdog!.watchdogIssueId!;
    const firstFingerprint = firstWatchdog!.lastObservedFingerprint!;

    // Control wake must not target the watched subtree — a queued wake on the
    // source would make the classifier report `live` and skip the reopen path.
    const unrelatedIssueId = await seedIssue(companyId, { identifier: "WDOG-UNRELATED", status: "todo" });
    await db.update(issues).set({
      status: "done",
      completedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      updatedAt: new Date(),
    }).where(eq(issues.id, watchdogIssueId));
    await db.insert(agentWakeupRequests).values([
      {
        companyId,
        agentId,
        source: "on_demand",
        reason: "stale watchdog wake",
        payload: { issueId: watchdogIssueId },
        status: "queued",
      },
      {
        companyId,
        agentId,
        source: "on_demand",
        reason: "deferred stale watchdog wake",
        payload: { _paperclipWakeContext: { taskId: watchdogIssueId } },
        status: "deferred_issue_execution",
      },
      {
        companyId,
        agentId,
        source: "on_demand",
        reason: "unrelated wake must remain",
        payload: { issueId: unrelatedIssueId },
        status: "queued",
      },
    ]);
    const reviewed = await service.reconcileTaskWatchdogs({ companyId });

    expect(reviewed).toMatchObject({ checked: 1, triggered: 0, alreadyReviewed: 1 });
    const [actionRequired] = await db.select().from(issues).where(eq(issues.id, watchdogIssueId));
    expect(actionRequired).toMatchObject({ status: "blocked", originFingerprint: firstFingerprint });
    expect(actionRequired?.description).toContain(
      `Task watchdog action-required fingerprint: ${firstFingerprint}`,
    );
    const wakeRows = await db
      .select({ status: agentWakeupRequests.status, payload: agentWakeupRequests.payload, error: agentWakeupRequests.error })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId));
    expect(wakeRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "cancelled",
        payload: { issueId: watchdogIssueId },
        error: "Cancelled because task-watchdog review requires board action",
      }),
      expect.objectContaining({
        status: "cancelled",
        payload: { _paperclipWakeContext: { taskId: watchdogIssueId } },
      }),
      expect.objectContaining({ status: "queued", payload: { issueId: unrelatedIssueId }, error: null }),
    ]));
    expect(wakeRows.filter((wake) => wake.status === "queued").map((wake) => wake.payload)).toEqual([
      { issueId: unrelatedIssueId },
    ]);

    await db.update(issues).set({ updatedAt: new Date(Date.now() + 60_000) }).where(eq(issues.id, sourceId));
    const unchanged = await service.reconcileTaskWatchdogs({ companyId });
    expect(unchanged).toMatchObject({ checked: 1, triggered: 0, alreadyReviewed: 1 });
    expect(wakes).toHaveLength(1);

    await db.update(issues).set({ assigneeAgentId: agentId, updatedAt: new Date(Date.now() + 120_000) })
      .where(eq(issues.id, sourceId));
    const changed = await service.reconcileTaskWatchdogs({ companyId });
    expect(changed).toMatchObject({ checked: 1, triggered: 1 });
    const [reopened] = await db.select().from(issues).where(eq(issues.id, watchdogIssueId));
    expect(reopened).toMatchObject({ status: "todo", assigneeAgentId: agentId });
    expect(reopened?.originFingerprint).not.toBe(firstFingerprint);
    expect(wakes).toHaveLength(2);

    const sameChangedState = await service.reconcileTaskWatchdogs({ companyId });
    expect(sameChangedState).toMatchObject({ checked: 1, triggered: 0, live: 1 });
    expect(wakes).toHaveLength(2);
  });

  it("leaves a long-completed same-fingerprint review done with a one-shot abandon annotation", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-ABANDON", status: "todo" });
    const agentId = await seedAgent(companyId);
    await seedWatchdog(companyId, sourceId, agentId);
    const { service, wakes } = createService();

    const first = await service.reconcileTaskWatchdogs({ companyId });
    expect(first).toMatchObject({ checked: 1, triggered: 1 });
    const [firstWatchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    const watchdogIssueId = firstWatchdog!.watchdogIssueId!;
    const firstFingerprint = firstWatchdog!.lastObservedFingerprint!;
    wakes.length = 0;

    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await db.update(issues).set({
      status: "done",
      completedAt: eightDaysAgo,
      updatedAt: eightDaysAgo,
    }).where(eq(issues.id, watchdogIssueId));

    const abandoned = await service.reconcileTaskWatchdogs({ companyId });
    expect(abandoned).toMatchObject({ checked: 1, triggered: 0, alreadyReviewed: 1 });
    expect(wakes).toHaveLength(0);

    const [afterFirst] = await db.select().from(issues).where(eq(issues.id, watchdogIssueId));
    expect(afterFirst).toMatchObject({ status: "done", originFingerprint: firstFingerprint });
    expect(afterFirst?.description).toContain(`Task watchdog abandoned fingerprint: ${firstFingerprint}`);
    expect(afterFirst?.description).toMatch(/7 days/i);
    const abandonMatches = afterFirst?.description?.match(/Task watchdog abandoned fingerprint:/g) ?? [];
    expect(abandonMatches).toHaveLength(1);

    const abandonedAgain = await service.reconcileTaskWatchdogs({ companyId });
    expect(abandonedAgain).toMatchObject({ checked: 1, triggered: 0, alreadyReviewed: 1 });
    const [afterSecond] = await db.select().from(issues).where(eq(issues.id, watchdogIssueId));
    expect(afterSecond?.status).toBe("done");
    expect(afterSecond?.description).toBe(afterFirst?.description);
    const abandonMatchesAgain = afterSecond?.description?.match(/Task watchdog abandoned fingerprint:/g) ?? [];
    expect(abandonMatchesAgain).toHaveLength(1);
  });

  it("does not abandon-annotate when a long-completed review fingerprint has changed", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-ABANDON-CHANGE", status: "todo" });
    const agentId = await seedAgent(companyId);
    await seedWatchdog(companyId, sourceId, agentId);
    const { service, wakes } = createService();

    const first = await service.reconcileTaskWatchdogs({ companyId });
    expect(first).toMatchObject({ checked: 1, triggered: 1 });
    const [firstWatchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    const watchdogIssueId = firstWatchdog!.watchdogIssueId!;
    const firstFingerprint = firstWatchdog!.lastObservedFingerprint!;

    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await db.update(issues).set({
      status: "done",
      completedAt: eightDaysAgo,
      updatedAt: eightDaysAgo,
    }).where(eq(issues.id, watchdogIssueId));
    await db.update(issues).set({
      assigneeAgentId: agentId,
      updatedAt: new Date(Date.now() + 120_000),
    }).where(eq(issues.id, sourceId));
    wakes.length = 0;

    const changed = await service.reconcileTaskWatchdogs({ companyId });
    expect(changed).toMatchObject({ checked: 1, triggered: 1 });
    const [reopened] = await db.select().from(issues).where(eq(issues.id, watchdogIssueId));
    expect(reopened).toMatchObject({ status: "todo", assigneeAgentId: agentId });
    expect(reopened?.originFingerprint).not.toBe(firstFingerprint);
    expect(reopened?.description ?? "").not.toContain("Task watchdog abandoned fingerprint:");
    expect(wakes).toHaveLength(1);
  });

  async function seedTrapBlockedWatchdogReview(input: {
    identifier: string;
    completedAt: Date | null;
    actionRequiredFingerprint?: string | null;
    descriptionExtra?: string;
  }) {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: input.identifier, status: "todo" });
    const agentId = await seedAgent(companyId);
    await seedWatchdog(companyId, sourceId, agentId);
    const { service, wakes } = createService();

    const first = await service.reconcileTaskWatchdogs({ companyId });
    expect(first).toMatchObject({ checked: 1, triggered: 1 });
    const [firstWatchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    const watchdogIssueId = firstWatchdog!.watchdogIssueId!;
    const firstFingerprint = firstWatchdog!.lastObservedFingerprint!;
    wakes.length = 0;

    // Age past the reopen window while still done so part 1 would abandon —
    // then force the production trap state: already blocked with the marker.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await db.update(issues).set({
      status: "done",
      completedAt: yesterday,
      updatedAt: yesterday,
    }).where(eq(issues.id, watchdogIssueId));
    await service.reconcileTaskWatchdogs({ companyId });

    const actionRequiredFingerprint = input.actionRequiredFingerprint === undefined
      ? firstFingerprint
      : input.actionRequiredFingerprint;
    const baseDescription = [
      "Task watchdog review issue.",
      input.descriptionExtra,
      actionRequiredFingerprint
        ? `Task watchdog action-required fingerprint: ${actionRequiredFingerprint}`
        : null,
    ].filter((line): line is string => Boolean(line)).join("\n\n");

    await db.update(issues).set({
      status: "blocked",
      completedAt: input.completedAt,
      description: baseDescription,
      originFingerprint: firstFingerprint,
      updatedAt: new Date(),
    }).where(eq(issues.id, watchdogIssueId));
    await db.update(issueWatchdogs).set({
      lastReviewedFingerprint: firstFingerprint,
      lastReviewedStopSnapshot: firstWatchdog!.lastObservedStopSnapshot,
      updatedAt: new Date(),
    }).where(eq(issueWatchdogs.issueId, sourceId));
    // Suppress stale-blocked wake recovery so these cases exercise the healing
    // branch (and its refusal paths) rather than the skipped-wake reopen path.
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: { issueId: watchdogIssueId },
    });
    wakes.length = 0;

    return { companyId, sourceId, agentId, service, wakes, watchdogIssueId, firstFingerprint };
  }

  it("releases a long-blocked action-required review to done with a one-shot abandon annotation", async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const { service, wakes, watchdogIssueId, firstFingerprint, companyId, agentId } =
      await seedTrapBlockedWatchdogReview({
        identifier: "WDOG-HEAL",
        completedAt: tenDaysAgo,
      });

    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "on_demand",
      reason: "stale watchdog wake after trap",
      payload: { issueId: watchdogIssueId },
      status: "queued",
    });

    const healed = await service.reconcileTaskWatchdogs({ companyId });
    expect(healed).toMatchObject({ checked: 1, triggered: 0, alreadyReviewed: 1 });
    expect(wakes).toHaveLength(0);

    const [afterHeal] = await db.select().from(issues).where(eq(issues.id, watchdogIssueId));
    expect(afterHeal).toMatchObject({ status: "done", originFingerprint: firstFingerprint });
    expect(afterHeal?.description).toContain(`Task watchdog abandoned fingerprint: ${firstFingerprint}`);
    expect(afterHeal?.description).not.toContain("Task watchdog action-required fingerprint:");
    expect(afterHeal?.description).toMatch(/7 days/i);
    const abandonMatches = afterHeal?.description?.match(/Task watchdog abandoned fingerprint:/g) ?? [];
    expect(abandonMatches).toHaveLength(1);

    const wakeRows = await db
      .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId));
    expect(wakeRows).toEqual([
      expect.objectContaining({
        status: "cancelled",
        error: "Cancelled because task-watchdog review requires board action",
      }),
    ]);
  });

  it("does not re-annotate after healing a long-blocked action-required review", async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const { service, watchdogIssueId, companyId } = await seedTrapBlockedWatchdogReview({
      identifier: "WDOG-HEAL-ONCE",
      completedAt: tenDaysAgo,
    });

    await service.reconcileTaskWatchdogs({ companyId });
    const [afterFirst] = await db.select().from(issues).where(eq(issues.id, watchdogIssueId));
    expect(afterFirst?.status).toBe("done");
    expect(afterFirst?.description).toContain("Task watchdog abandoned fingerprint:");

    const again = await service.reconcileTaskWatchdogs({ companyId });
    expect(again).toMatchObject({ checked: 1, triggered: 0, alreadyReviewed: 1 });
    const [afterSecond] = await db.select().from(issues).where(eq(issues.id, watchdogIssueId));
    expect(afterSecond?.status).toBe("done");
    expect(afterSecond?.description).toBe(afterFirst?.description);
    const abandonMatches = afterSecond?.description?.match(/Task watchdog abandoned fingerprint:/g) ?? [];
    expect(abandonMatches).toHaveLength(1);
  });

  it("keeps a recently blocked action-required review blocked", async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const { service, wakes, watchdogIssueId, companyId, firstFingerprint } =
      await seedTrapBlockedWatchdogReview({
        identifier: "WDOG-HEAL-FRESH",
        completedAt: yesterday,
      });

    const result = await service.reconcileTaskWatchdogs({ companyId });
    expect(result).toMatchObject({ checked: 1, triggered: 0, alreadyReviewed: 1 });
    expect(wakes).toHaveLength(0);

    const [stillBlocked] = await db.select().from(issues).where(eq(issues.id, watchdogIssueId));
    expect(stillBlocked).toMatchObject({ status: "blocked", originFingerprint: firstFingerprint });
    expect(stillBlocked?.description).toContain(`Task watchdog action-required fingerprint: ${firstFingerprint}`);
    expect(stillBlocked?.description ?? "").not.toContain("Task watchdog abandoned fingerprint:");
  });

  it("does not heal a long-blocked review whose action-required fingerprint no longer matches", async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const staleFingerprint = "task_watchdog_stop:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const { service, wakes, watchdogIssueId, companyId, firstFingerprint } =
      await seedTrapBlockedWatchdogReview({
        identifier: "WDOG-HEAL-MISMATCH",
        completedAt: tenDaysAgo,
        actionRequiredFingerprint: staleFingerprint,
      });

    const result = await service.reconcileTaskWatchdogs({ companyId });
    expect(result).toMatchObject({ checked: 1, triggered: 0, alreadyReviewed: 1 });
    expect(wakes).toHaveLength(0);

    const [stillBlocked] = await db.select().from(issues).where(eq(issues.id, watchdogIssueId));
    expect(stillBlocked).toMatchObject({ status: "blocked", originFingerprint: firstFingerprint });
    expect(stillBlocked?.description).toContain(`Task watchdog action-required fingerprint: ${staleFingerprint}`);
    expect(stillBlocked?.description ?? "").not.toContain("Task watchdog abandoned fingerprint:");
  });

  it("does not heal a long-blocked action-required review without a completion date", async () => {
    const { service, wakes, watchdogIssueId, companyId, firstFingerprint } =
      await seedTrapBlockedWatchdogReview({
        identifier: "WDOG-HEAL-NO-DATE",
        completedAt: null,
      });

    const result = await service.reconcileTaskWatchdogs({ companyId });
    expect(result).toMatchObject({ checked: 1, triggered: 0, alreadyReviewed: 1 });
    expect(wakes).toHaveLength(0);

    const [stillBlocked] = await db.select().from(issues).where(eq(issues.id, watchdogIssueId));
    expect(stillBlocked).toMatchObject({
      status: "blocked",
      originFingerprint: firstFingerprint,
      completedAt: null,
    });
    expect(stillBlocked?.description).toContain(`Task watchdog action-required fingerprint: ${firstFingerprint}`);
    expect(stillBlocked?.description ?? "").not.toContain("Task watchdog abandoned fingerprint:");
  });

  it("does not heal a blocked review that lacks the action-required marker", async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const { service, wakes, watchdogIssueId, companyId, firstFingerprint } =
      await seedTrapBlockedWatchdogReview({
        identifier: "WDOG-HEAL-FOREIGN",
        completedAt: tenDaysAgo,
        actionRequiredFingerprint: null,
        descriptionExtra: "Blocked by a human for an unrelated reason.",
      });

    const [before] = await db.select().from(issues).where(eq(issues.id, watchdogIssueId));
    const result = await service.reconcileTaskWatchdogs({ companyId });
    expect(result).toMatchObject({ checked: 1, triggered: 0, alreadyReviewed: 1 });
    expect(wakes).toHaveLength(0);

    const [after] = await db.select().from(issues).where(eq(issues.id, watchdogIssueId));
    expect(after).toMatchObject({
      status: "blocked",
      originFingerprint: firstFingerprint,
      description: before?.description,
    });
    expect(after?.description ?? "").not.toContain("Task watchdog action-required fingerprint:");
    expect(after?.description ?? "").not.toContain("Task watchdog abandoned fingerprint:");
  });

  it("keeps completed watchdog reviews legal for terminal, live, and human-waiting sources", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const terminalId = await seedIssue(companyId, { identifier: "WDOG-LEGAL-DONE", status: "done" });
    const liveId = await seedIssue(companyId, { identifier: "WDOG-LEGAL-LIVE", status: "todo" });
    const waitingId = await seedIssue(companyId, { identifier: "WDOG-LEGAL-WAIT", status: "in_review" });
    await seedWatchdog(companyId, terminalId, agentId);
    await seedWatchdog(companyId, liveId, agentId);
    await seedWatchdog(companyId, waitingId, agentId);
    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId: waitingId,
      kind: "request_confirmation",
      status: "pending",
      payload: { version: 1, prompt: "Choose the next step." },
      createdByAgentId: agentId,
    });
    const { service } = createService();

    await service.reconcileTaskWatchdogs({ companyId });
    const watchdogRows = await db.select().from(issueWatchdogs);
    const watchdogBySource = new Map(watchdogRows.map((row) => [row.issueId, row]));
    const liveWatchdogId = watchdogBySource.get(liveId)!.watchdogIssueId!;
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      contextSnapshot: { issueId: liveId },
    });
    for (const sourceId of [terminalId, liveId, waitingId]) {
      const watchdogIssueId = watchdogBySource.get(sourceId)!.watchdogIssueId!;
      await db.update(issues).set({ status: "done", updatedAt: new Date() }).where(eq(issues.id, watchdogIssueId));
    }

    await service.reconcileTaskWatchdogs({ companyId });

    const legalWatchdogIssues = await db.select().from(issues).where(inArray(issues.id, [
      watchdogBySource.get(terminalId)!.watchdogIssueId!,
      liveWatchdogId,
      watchdogBySource.get(waitingId)!.watchdogIssueId!,
    ]));
    expect(legalWatchdogIssues).toHaveLength(3);
    expect(legalWatchdogIssues.every((issue) => issue.status === "done")).toBe(true);
  });

  it("does not reopen a blocked watchdog that still has an unresolved issue blocker", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-BLOCK-REAL", status: "done" });
    const agentId = await seedAgent(companyId);
    await seedWatchdog(companyId, sourceId, agentId);
    const { service, wakes } = createService();

    const first = await service.reconcileTaskWatchdogs({ companyId });
    expect(first).toMatchObject({ checked: 1, triggered: 1 });

    const [firstWatchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    const watchdogIssueId = firstWatchdog!.watchdogIssueId!;
    const stopFingerprint = firstWatchdog!.lastObservedFingerprint!;
    const blockerId = await seedIssue(companyId, {
      identifier: "WDOG-BLOCKER",
      status: "in_progress",
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: watchdogIssueId,
      type: "blocks",
    });
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: agentId })
      .where(eq(issues.id, watchdogIssueId));
    // Even with a stale reviewed stamp, an explicit blocker must stay closed.
    await db
      .update(issueWatchdogs)
      .set({
        lastReviewedFingerprint: stopFingerprint,
        lastReviewedStopSnapshot: firstWatchdog!.lastObservedStopSnapshot,
      })
      .where(eq(issueWatchdogs.issueId, sourceId));
    wakes.length = 0;

    const second = await service.reconcileTaskWatchdogs({ companyId });

    expect(second).toMatchObject({ checked: 1, triggered: 0, alreadyReviewed: 1 });
    expect(wakes).toHaveLength(0);
    const [stillBlocked] = await db.select().from(issues).where(eq(issues.id, watchdogIssueId));
    expect(stillBlocked?.status).toBe("blocked");
    const [watchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    expect(watchdog?.triggerCount).toBe(1);
    expect(watchdog?.lastReviewedFingerprint).toBe(stopFingerprint);
  });

  it("does not trigger while a non-watchdog descendant has live work", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-2", status: "in_progress" });
    const childId = await seedIssue(companyId, { parentId: sourceId, status: "in_progress" });
    const agentId = await seedAgent(companyId);
    await seedWatchdog(companyId, sourceId, agentId);
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "queued",
      invocationSource: "assignment",
      contextSnapshot: { issueId: childId },
    });
    const { service, wakes } = createService();

    const result = await service.reconcileTaskWatchdogs({ companyId });

    expect(result).toMatchObject({ checked: 1, triggered: 0, live: 1 });
    expect(wakes).toHaveLength(0);
    const watchdogIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "task_watchdog")));
    expect(watchdogIssues).toHaveLength(0);
  });

  it("does not trigger while a descendant has a queued assignment wake", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-WAKE", status: "in_progress" });
    const childId = await seedIssue(companyId, { parentId: sourceId, status: "todo" });
    const agentId = await seedAgent(companyId);
    await seedWatchdog(companyId, sourceId, agentId);
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      status: "queued",
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: childId },
    });
    const { service, wakes } = createService();

    const result = await service.reconcileTaskWatchdogs({ companyId });

    expect(result).toMatchObject({ checked: 1, triggered: 0, live: 1 });
    expect(wakes).toHaveLength(0);
    const watchdogIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "task_watchdog")));
    expect(watchdogIssues).toHaveLength(0);
  });

  it("does not keep the source live for runs under a nested task-watchdog issue", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-NEST", status: "done" });
    const agentId = await seedAgent(companyId);
    const nestedWatchdogIssueId = await seedIssue(companyId, {
      parentId: sourceId,
      status: "in_progress",
      originKind: "task_watchdog",
      originId: sourceId,
      originFingerprint: `task_watchdog:${companyId}:${sourceId}`,
    });
    const nestedChildId = await seedIssue(companyId, {
      parentId: nestedWatchdogIssueId,
      status: "in_progress",
    });
    await seedWatchdog(companyId, sourceId, agentId);
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      contextSnapshot: { issueId: nestedChildId },
    });
    const { service, wakes } = createService();

    const result = await service.reconcileTaskWatchdogs({ companyId });

    expect(result).toMatchObject({ checked: 1, triggered: 1, live: 0 });
    expect(wakes).toHaveLength(1);
  });

  it("reconciles ancestor watchdogs for a descendant issue mutation", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-ANCESTOR", status: "done" });
    const childId = await seedIssue(companyId, { parentId: sourceId, status: "done" });
    const agentId = await seedAgent(companyId);
    await seedWatchdog(companyId, sourceId, agentId);
    const { service, wakes } = createService();

    const result = await service.reconcileForIssueAndAncestors(companyId, childId);

    expect(result).toMatchObject({ checked: 1, triggered: 1 });
    expect(wakes).toHaveLength(1);
  });

  it("marks a completed watchdog fingerprint reviewed, then reuses the same issue for a later stopped state", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-3", status: "done" });
    const childId = await seedIssue(companyId, { parentId: sourceId, status: "done" });
    const agentId = await seedAgent(companyId);
    await seedWatchdog(companyId, sourceId, agentId);
    const { service, wakes } = createService();

    await service.reconcileTaskWatchdogs({ companyId });
    const [firstWatchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    const watchdogIssueId = firstWatchdog!.watchdogIssueId!;
    const [firstWatchdogIssue] = await db.select().from(issues).where(eq(issues.id, watchdogIssueId));
    expect(firstWatchdogIssue?.originFingerprint).toBe(firstWatchdog?.lastObservedFingerprint);
    await db.update(issues).set({ status: "done", updatedAt: new Date() }).where(eq(issues.id, watchdogIssueId));

    const reviewed = await service.reconcileTaskWatchdogs({ companyId });
    expect(reviewed).toMatchObject({ checked: 1, triggered: 0, alreadyReviewed: 1 });
    const [reviewedWatchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    expect(reviewedWatchdog?.lastReviewedFingerprint).toBe(firstWatchdog?.lastObservedFingerprint);
    expect(reviewedWatchdog?.lastReviewedStopSnapshot).toEqual(firstWatchdog?.lastObservedStopSnapshot);

    await db
      .update(issues)
      .set({ status: "blocked", updatedAt: new Date(Date.now() + 60_000) })
      .where(eq(issues.id, childId));
    const retriggered = await service.reconcileTaskWatchdogs({ companyId });

    expect(retriggered).toMatchObject({ checked: 1, triggered: 1 });
    const watchdogIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "task_watchdog")));
    expect(watchdogIssues).toHaveLength(1);
    expect(watchdogIssues[0]).toMatchObject({ id: watchdogIssueId, status: "todo" });
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, watchdogIssueId));
    expect(comments.some((comment) => comment.body.includes("Stopped fingerprint"))).toBe(true);
    expect(wakes.length).toBe(2);
  });

  it("suppresses a shrink-only stop after review when the snapshot round-trips through jsonb", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-SHRINK", status: "in_review" });
    const waitingLeafId = await seedIssue(companyId, { parentId: sourceId, status: "in_review" });
    const siblingLeafId = await seedIssue(companyId, { parentId: sourceId, status: "in_progress" });
    const agentId = await seedAgent(companyId);
    await db.insert(issueThreadInteractions).values({
      id: randomUUID(),
      companyId,
      issueId: waitingLeafId,
      kind: "request_confirmation",
      status: "pending",
      payload: { version: 1, prompt: "Confirm the stop." },
      createdByAgentId: agentId,
    });
    await seedWatchdog(companyId, sourceId, agentId);
    const { service, wakes } = createService();

    const first = await service.reconcileTaskWatchdogs({ companyId });
    expect(first).toMatchObject({ checked: 1, triggered: 1 });

    const [triggeredWatchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    await db
      .update(issues)
      .set({ status: "done", updatedAt: new Date() })
      .where(eq(issues.id, triggeredWatchdog!.watchdogIssueId!));
    const reviewed = await service.reconcileTaskWatchdogs({ companyId });
    expect(reviewed).toMatchObject({ checked: 1, triggered: 0, alreadyReviewed: 1 });
    const [reviewedWatchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    expect(reviewedWatchdog?.lastReviewedStopSnapshot).not.toBeNull();

    // The sibling completing shrinks the material leaf set while the wait set
    // is unchanged; the reviewed snapshot loaded back from jsonb (which does
    // not preserve object key order) must still suppress the wake.
    await db
      .update(issues)
      .set({ status: "done", updatedAt: new Date(Date.now() + 60_000) })
      .where(eq(issues.id, siblingLeafId));
    const afterShrink = await service.reconcileTaskWatchdogs({ companyId });

    expect(afterShrink).toMatchObject({ checked: 1, triggered: 0, alreadyReviewed: 1 });
    expect(wakes).toHaveLength(1);
  });

  it.each([
    ["cancelled", 1, 0, 1],
    ["succeeded", 0, 1, 0],
  ] as const)(
    "treats only a succeeded watchdog review as completed when the snapshot shrinks (%s)",
    async (runStatus, expectedTriggered, expectedAlreadyReviewed, expectedWakeCount) => {
      const companyId = await seedCompany();
      const sourceId = await seedIssue(companyId, { identifier: "WDOG-COMPLETED-RECOVERY", status: "in_review" });
      const waitingLeafId = await seedIssue(companyId, { parentId: sourceId, status: "in_review" });
      const siblingLeafId = await seedIssue(companyId, { parentId: sourceId, status: "in_progress" });
      const agentId = await seedAgent(companyId);
      await db.insert(issueThreadInteractions).values({
        id: randomUUID(),
        companyId,
        issueId: waitingLeafId,
        kind: "request_confirmation",
        status: "pending",
        payload: { version: 1, prompt: "Confirm the stop." },
        createdByAgentId: agentId,
      });
      await seedWatchdog(companyId, sourceId, agentId);
      const { service, wakes } = createService();

      const first = await service.reconcileTaskWatchdogs({ companyId });
      expect(first).toMatchObject({ checked: 1, triggered: 1 });

      const [firstWatchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
      const watchdogIssueId = firstWatchdog!.watchdogIssueId!;
      await db
        .update(issues)
        .set({ status: "done", updatedAt: new Date() })
        .where(eq(issues.id, watchdogIssueId));
      const reviewed = await service.reconcileTaskWatchdogs({ companyId });
      expect(reviewed).toMatchObject({ checked: 1, triggered: 0, alreadyReviewed: 1 });

      // The completed review's recovery activity shrinks the stopped snapshot.
      await db
        .update(issues)
        .set({ status: "done", updatedAt: new Date(Date.now() + 60_000) })
        .where(eq(issues.id, siblingLeafId));
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: runStatus,
        startedAt: new Date(),
        finishedAt: new Date(),
        contextSnapshot: { issueId: watchdogIssueId },
      });
      await db
        .update(issues)
        .set({
          status: "blocked",
          assigneeAgentId: agentId,
          executionRunId: null,
          checkoutRunId: null,
          executionState: null,
          monitorNextCheckAt: null,
        })
        .where(eq(issues.id, watchdogIssueId));
      wakes.length = 0;

      const startup = await service.reconcileTaskWatchdogs({ companyId });

      expect(startup).toMatchObject({
        checked: 1,
        triggered: expectedTriggered,
        alreadyReviewed: expectedAlreadyReviewed,
      });
      expect(wakes).toHaveLength(expectedWakeCount);
    },
  );

  it("does not let an old terminal watchdog review mark a newer observed fingerprint reviewed", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-STALE", status: "done" });
    const childId = await seedIssue(companyId, { parentId: sourceId, status: "done" });
    const agentId = await seedAgent(companyId);
    await seedWatchdog(companyId, sourceId, agentId);
    const { service, wakes } = createService();

    await service.reconcileTaskWatchdogs({ companyId });
    const [firstWatchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    const oldFingerprint = firstWatchdog!.lastObservedFingerprint!;
    const watchdogIssueId = firstWatchdog!.watchdogIssueId!;
    const watchdogRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: watchdogRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      contextSnapshot: { issueId: watchdogIssueId },
    });

    await db
      .update(issues)
      .set({ status: "blocked", updatedAt: new Date(Date.now() + 60_000) })
      .where(eq(issues.id, childId));
    const changedWhileReviewLive = await service.reconcileTaskWatchdogs({ companyId });
    expect(changedWhileReviewLive).toMatchObject({ checked: 1, triggered: 0, live: 1 });

    const [observedWhileLive] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    const newerFingerprint = observedWhileLive!.lastObservedFingerprint!;
    expect(newerFingerprint).not.toBe(oldFingerprint);
    const [stillBoundReview] = await db.select().from(issues).where(eq(issues.id, watchdogIssueId));
    expect(stillBoundReview?.originFingerprint).toBe(oldFingerprint);

    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, watchdogRunId));
    await db.update(issues).set({ status: "done", updatedAt: new Date() }).where(eq(issues.id, watchdogIssueId));
    const afterOldReviewCompletes = await service.reconcileTaskWatchdogs({ companyId });

    expect(afterOldReviewCompletes).toMatchObject({ checked: 1, triggered: 1 });
    const [reviewedWatchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    expect(reviewedWatchdog?.lastReviewedFingerprint).toBe(oldFingerprint);
    expect(reviewedWatchdog?.lastReviewedFingerprint).not.toBe(newerFingerprint);
    expect(reviewedWatchdog?.lastReviewedStopSnapshot).toBeNull();
    const [reopenedWatchdogIssue] = await db.select().from(issues).where(eq(issues.id, watchdogIssueId));
    expect(reopenedWatchdogIssue).toMatchObject({
      status: "todo",
      originFingerprint: newerFingerprint,
    });
    const reviewActivities = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, sourceId), eq(activityLog.action, "issue.task_watchdog_fingerprint_reviewed")));
    expect(reviewActivities).toHaveLength(1);
    expect(reviewActivities[0]?.details).toMatchObject({
      reviewedFingerprint: oldFingerprint,
      lastObservedFingerprint: newerFingerprint,
    });
    expect(wakes.length).toBe(2);
  });

  it("keeps watchdog mutation scope valid across metadata-only source evidence", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-REVALIDATE", status: "blocked" });
    const agentId = await seedAgent(companyId);
    await seedWatchdog(companyId, sourceId, agentId);
    const { service } = createService();

    await service.reconcileTaskWatchdogs({ companyId });
    const [watchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    const originalFingerprint = watchdog!.lastObservedFingerprint!;
    expect(originalFingerprint).toMatch(/^task_watchdog_stop:/);

    const later = new Date(Date.now() + 60_000);
    await db.insert(issueComments).values({
      companyId,
      issueId: sourceId,
      authorType: "agent",
      body: "Fresh source evidence.",
      updatedAt: later,
      createdAt: later,
    });
    await seedIssueDocument(companyId, sourceId, new Date(later.getTime() + 1_000));
    await seedIssueWorkProduct(companyId, sourceId, new Date(later.getTime() + 2_000));

    const revalidated = await service.revalidateMutationScope({
      kind: "watchdog",
      watchdogId: watchdog!.id,
      companyId,
      watchedIssueId: sourceId,
      stopFingerprint: originalFingerprint,
    });

    expect(revalidated.allowed).toBe(true);
    expect(revalidated.classification?.state).toBe("stopped");
    if (revalidated.classification?.state !== "stopped") throw new Error("Expected stopped classification");
    expect(revalidated.classification.stopFingerprint).toBe(originalFingerprint);
    expect(revalidated.classification.stoppedLeaves[0]).toMatchObject({
      latestCommentAt: later.toISOString(),
      latestDocumentAt: new Date(later.getTime() + 1_000).toISOString(),
      latestWorkProductAt: new Date(later.getTime() + 2_000).toISOString(),
    });
  });

  it("surfaces pending interaction kinds and approval ids in the wake and watchdog comment", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-WAITS", status: "in_review" });
    const agentId = await seedAgent(companyId);
    await seedWatchdog(companyId, sourceId, agentId);
    const interactionId = randomUUID();
    const approvalId = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId: sourceId,
      kind: "request_confirmation",
      status: "pending",
      payload: { version: 1, prompt: "Confirm the reviewed stop." },
      createdByAgentId: agentId,
    });
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "request_board_approval",
      requestedByAgentId: agentId,
      status: "pending",
      payload: { summary: "Approve the reviewed stop." },
    });
    await db.insert(issueApprovals).values({
      companyId,
      issueId: sourceId,
      approvalId,
      linkedByAgentId: agentId,
    });
    const { service, wakes } = createService();

    const result = await service.reconcileTaskWatchdogs({ companyId });

    expect(result).toMatchObject({ checked: 1, triggered: 1 });
    expect(wakes[0]?.opts?.contextSnapshot).toMatchObject({
      taskWatchdog: {
        pendingInteractions: {
          [sourceId]: [{ id: interactionId, kind: "request_confirmation" }],
        },
        pendingApprovals: {
          [sourceId]: [approvalId],
        },
      },
    });
    const [watchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    expect(watchdog?.lastObservedStopSnapshot).toMatchObject({
      waitsByIssueId: {
        [sourceId]: {
          pendingInteractionIds: [interactionId],
          pendingApprovalIds: [approvalId],
        },
      },
    });
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, watchdog!.watchdogIssueId!));
    expect(comments.at(-1)?.body).toContain(`pending request_confirmation ${interactionId.slice(0, 8)}…`);
    expect(comments.at(-1)?.body).toContain(`approval ${approvalId.slice(0, 8)}…`);
    const metadata = comments.at(-1)?.metadata as { sections?: Array<{ rows?: unknown[] }> } | null;
    expect(metadata?.sections?.[0]?.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Pending waits", text: "2" }),
    ]));
  });

  it("revalidates a stale watchdog review as live when the source gets a fresh run path", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-LIVE-REVALIDATE", status: "blocked" });
    const agentId = await seedAgent(companyId);
    await seedWatchdog(companyId, sourceId, agentId);
    const { service } = createService();

    await service.reconcileTaskWatchdogs({ companyId });
    const [watchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    const originalFingerprint = watchdog!.lastObservedFingerprint!;
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      contextSnapshot: { issueId: sourceId },
    });

    const revalidated = await service.revalidateMutationScope({
      kind: "watchdog",
      watchdogId: watchdog!.id,
      companyId,
      watchedIssueId: sourceId,
      stopFingerprint: originalFingerprint,
    });

    expect(revalidated.allowed).toBe(false);
    expect(revalidated.reason).toContain("now has a live");
    expect(revalidated.classification?.state).toBe("live");
  });

  it("does not raise a stopped-subtree review while a freshly-created assigned issue's first run is starting", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    // Issue + watchdog created in the same flow; the assignment run row is not
    // yet visible to this evaluation (create-race).
    const sourceId = await seedIssue(companyId, {
      identifier: "WDOG-RACE",
      status: "todo",
      assigneeAgentId: agentId,
      createdAt: new Date(),
    });
    await seedWatchdog(companyId, sourceId, agentId);
    const { service, wakes } = createService();

    const result = await service.reconcileTaskWatchdogs({ companyId });

    expect(result).toMatchObject({ checked: 1, triggered: 0, pendingFirstRun: 1 });
    expect(wakes).toHaveLength(0);
    const watchdogIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "task_watchdog")));
    expect(watchdogIssues).toHaveLength(0);
    const [watchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    expect(watchdog?.triggerCount).toBe(0);
  });

  it("still triggers a genuinely idle assigned issue once it is past the first-run grace window", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    // Established issue (default createdAt is an hour ago), assigned, non-terminal,
    // with no live run or queued wake.
    const sourceId = await seedIssue(companyId, {
      identifier: "WDOG-IDLE",
      status: "todo",
      assigneeAgentId: agentId,
    });
    await seedWatchdog(companyId, sourceId, agentId);
    const { service, wakes } = createService();

    const result = await service.reconcileTaskWatchdogs({ companyId });

    expect(result).toMatchObject({ checked: 1, triggered: 1 });
    expect(wakes).toHaveLength(1);
  });

  it("does not defer once the freshly-created issue has a terminal run on record", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const sourceId = await seedIssue(companyId, {
      identifier: "WDOG-RAN",
      status: "blocked",
      assigneeAgentId: agentId,
      createdAt: new Date(),
    });
    await seedWatchdog(companyId, sourceId, agentId);
    // A run for this issue already reached a terminal status, so the stop is
    // genuine even though the issue was just created.
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "succeeded",
      invocationSource: "assignment",
      contextSnapshot: { issueId: sourceId },
    });
    const { service, wakes } = createService();

    const result = await service.reconcileTaskWatchdogs({ companyId });

    expect(result).toMatchObject({ checked: 1, triggered: 1 });
    expect(wakes).toHaveLength(1);
  });

  it("does not recursively trigger a watchdog configured on a task-watchdog issue", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-4", status: "done" });
    const watchdogIssueId = await seedIssue(companyId, {
      parentId: sourceId,
      status: "done",
      originKind: "task_watchdog",
      originId: sourceId,
      originFingerprint: `task_watchdog:${companyId}:${sourceId}`,
    });
    await seedIssue(companyId, { parentId: watchdogIssueId, status: "done" });
    await seedWatchdog(companyId, watchdogIssueId, agentId);
    const { service, wakes } = createService();

    const result = await service.reconcileTaskWatchdogs({ companyId });

    expect(result).toMatchObject({ checked: 1, triggered: 0 });
    expect(wakes).toHaveLength(0);
    const watchdogIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "task_watchdog")));
    expect(watchdogIssues).toHaveLength(1);
  });

  it("handles an armed cutoff when no watchdogs are active", async () => {
    const companyId = await seedCompany();
    const { service } = createService();

    const result = await service.reconcileTaskWatchdogs({
      companyId,
      issueCreatedAtGte: new Date(),
    });

    expect(result).toMatchObject({ checked: 0, triggered: 0 });
  });
});
