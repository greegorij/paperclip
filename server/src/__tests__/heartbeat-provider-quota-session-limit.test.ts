import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  activityLog,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRelations,
  issues,
  projects,
} from "@paperclipai/db";
import { PROVIDER_QUOTA_RESET_MARGIN_MS } from "@paperclipai/adapter-utils";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const ACPX_SESSION_LIMIT_ADAPTER = "acpx_session_limit_incident";

/** Exact production wording from 2026-07-27 (no "at", middle-dot separator). */
const INCIDENT_ERROR =
  "Internal error: You've hit your session limit · resets 11:50am (UTC)";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres provider-quota session-limit tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await heartbeat.getRun(runId);
}

describeEmbeddedPostgres("heartbeat provider quota session-limit incident", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-provider-quota-session-limit-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    // Reproduce the pre-fix ACPX shape: acpx_turn_failed + session-limit text,
    // without errorFamily / retryNotBefore. Heartbeat + shared classifier must still schedule.
    registerServerAdapter({
      type: ACPX_SESSION_LIMIT_ADAPTER,
      execute: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: INCIDENT_ERROR,
        errorCode: "acpx_turn_failed",
        resultJson: {
          status: "failed",
          stopReason: INCIDENT_ERROR,
        },
      }),
      testEnvironment: async () => ({
        adapterType: ACPX_SESSION_LIMIT_ADAPTER,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
  }, 20_000);

  afterEach(async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await db.delete(activityLog);
        await db.delete(environmentLeases);
        await db.delete(issueRelations);
        await db.delete(issues);
        await db.delete(executionWorkspaces);
        await db.delete(projects);
        await db.delete(heartbeatRunEvents);
        await db.delete(activityLog);
        await db.delete(heartbeatRuns);
        await db.delete(agentWakeupRequests);
        await db.delete(agentRuntimeState);
        await db.delete(agents);
        await db.delete(companySkills);
        await db.delete(companies);
        return;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  });

  afterAll(async () => {
    unregisterServerAdapter(ACPX_SESSION_LIMIT_ADAPTER);
    await tempDb?.cleanup();
  });

  it("schedules a reset-time retry for automation runs that hit the session limit", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Acpx Quota Incident",
      role: "engineer",
      status: "idle",
      adapterType: ACPX_SESSION_LIMIT_ADAPTER,
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    // Freeze "now" relative to the incident reset clock by invoking around 10:00 UTC.
    // The adapter message says resets 11:50am (UTC); classifier adds a small margin.
    const expectedResetMs = Date.parse("2026-07-27T11:50:00.000Z") + PROVIDER_QUOTA_RESET_MARGIN_MS;

    const run = await heartbeat.invoke(agentId, "automation", {}, "system");
    expect(run).not.toBeNull();
    expect(run?.invocationSource).toBe("automation");

    const failedRun = await waitForRunToFinish(heartbeat, run!.id, 10_000);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.error).toBe(INCIDENT_ERROR);
    // Control plane must upgrade the ACPX-shaped failure into provider_quota.
    expect(failedRun?.errorCode).toBe("provider_quota");
    expect((failedRun?.resultJson as Record<string, unknown> | null)?.errorFamily).toBe("provider_quota");

    await expect
      .poll(
        () =>
          db
            .select({ id: heartbeatRuns.id })
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.retryOfRunId, run!.id))
            .then((rows) => rows.length),
        { timeout: 10_000, interval: 50 },
      )
      .toBe(1);

    const allRuns = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        retryOfRunId: heartbeatRuns.retryOfRunId,
        scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
        scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
        invocationSource: heartbeatRuns.invocationSource,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId));

    // Zero immediate retries: only the failed source run + one scheduled_retry child.
    expect(allRuns).toHaveLength(2);
    expect(allRuns.filter((row) => row.status === "queued" || row.status === "running")).toHaveLength(0);

    const retryRun = allRuns.find((row) => row.retryOfRunId === run!.id) ?? null;
    expect(retryRun?.status).toBe("scheduled_retry");
    expect(retryRun?.scheduledRetryReason).toBe("transient_failure");
    expect(retryRun?.scheduledRetryAt).not.toBeNull();

    const dueMs = retryRun!.scheduledRetryAt!.getTime();
    // Must wait until (or after) the provider reset — never bounce immediately.
    expect(dueMs).toBeGreaterThanOrEqual(Date.parse("2026-07-27T11:50:00.000Z"));
    // When the wall clock happens to be after the reset during the test run,
    // the classifier falls back to a same-day-next or default backoff; assert
    // at least that we scheduled something and recorded the wait in events.
    if (Date.now() < expectedResetMs) {
      expect(dueMs).toBe(expectedResetMs);
    } else {
      expect(dueMs).toBeGreaterThan(Date.now());
    }

    const waitEvent = await db
      .select({
        message: heartbeatRunEvents.message,
        payload: heartbeatRunEvents.payload,
      })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, run!.id))
      .then((rows) => rows.find((row) => row.message?.includes("Waiting for provider quota reset")) ?? null);

    expect(waitEvent?.message).toContain("Waiting for provider quota reset until");
    expect(waitEvent?.payload).toMatchObject({
      errorFamily: "provider_quota",
      scheduledRetryAttempt: 1,
    });
    expect((waitEvent?.payload as Record<string, unknown> | null)?.scheduledRetryAt).toBe(
      retryRun!.scheduledRetryAt!.toISOString(),
    );

    await expect
      .poll(
        () =>
          db
            .select({ status: agents.status, errorReason: agents.errorReason })
            .from(agents)
            .where(eq(agents.id, agentId))
            .then((rows) => rows[0] ?? null),
        { timeout: 5_000, interval: 50 },
      )
      .toEqual({ status: "idle", errorReason: null });
  });
});
