import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import {
  PROVIDER_QUOTA_DEFAULT_BACKOFF_MS,
  PROVIDER_QUOTA_RESET_MARGIN_MS,
} from "@paperclipai/adapter-utils";
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

/** Same family of message, but without a parseable reset clock. */
const INCIDENT_ERROR_WITHOUT_RESET = "You've hit your session limit.";

/** Frozen wall clock: morning of the incident, before the stated 11:50am UTC reset. */
const FROZEN_NOW = new Date("2026-07-27T10:00:00.000Z");
const EXPECTED_RESET_WITH_MARGIN_MS =
  Date.parse("2026-07-27T11:50:00.000Z") + PROVIDER_QUOTA_RESET_MARGIN_MS;
const EXPECTED_DEFAULT_BACKOFF_MS = FROZEN_NOW.getTime() + PROVIDER_QUOTA_DEFAULT_BACKOFF_MS;

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
  // Use performance.now() so fake Date timers do not disable the wait deadline.
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
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
  let adapterErrorMessage = INCIDENT_ERROR;

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
        errorMessage: adapterErrorMessage,
        errorCode: "acpx_turn_failed",
        resultJson: {
          status: "failed",
          stopReason: adapterErrorMessage,
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

  beforeEach(() => {
    adapterErrorMessage = INCIDENT_ERROR;
    // Freeze only Date so setTimeout / expect.poll keep real timers for async waits.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FROZEN_NOW);
  });

  afterEach(async () => {
    vi.useRealTimers();
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

  async function seedAutomationAgent() {
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

    return { companyId, agentId };
  }

  async function invokeUntilScheduledRetry(agentId: string, companyId: string, expectedError: string) {
    const run = await heartbeat.invoke(agentId, "automation", {}, "system");
    expect(run).not.toBeNull();
    expect(run?.invocationSource).toBe("automation");

    const failedRun = await waitForRunToFinish(heartbeat, run!.id, 10_000);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.error).toBe(expectedError);
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

    return { run: run!, retryRun: retryRun! };
  }

  it("schedules a reset-time retry for automation runs that hit the session limit", async () => {
    const { companyId, agentId } = await seedAutomationAgent();
    const { run, retryRun } = await invokeUntilScheduledRetry(agentId, companyId, INCIDENT_ERROR);

    // Exact due time: stated reset clock + margin. No wall-clock branching.
    expect(retryRun.scheduledRetryAt!.getTime()).toBe(EXPECTED_RESET_WITH_MARGIN_MS);

    await expect
      .poll(
        () =>
          db
            .select({
              message: heartbeatRunEvents.message,
              payload: heartbeatRunEvents.payload,
            })
            .from(heartbeatRunEvents)
            .where(eq(heartbeatRunEvents.runId, run.id))
            .then(
              (rows) =>
                rows.find((row) => row.message?.includes("Waiting for provider quota reset")) ?? null,
            ),
        { timeout: 5_000, interval: 50 },
      )
      .toMatchObject({
        message: expect.stringContaining("Waiting for provider quota reset until"),
        payload: expect.objectContaining({
          errorFamily: "provider_quota",
          scheduledRetryAttempt: 1,
          scheduledRetryAt: retryRun.scheduledRetryAt!.toISOString(),
        }),
      });

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

  it("schedules the default one-hour backoff when the session-limit message has no readable reset clock", async () => {
    adapterErrorMessage = INCIDENT_ERROR_WITHOUT_RESET;
    const { companyId, agentId } = await seedAutomationAgent();
    const { run, retryRun } = await invokeUntilScheduledRetry(
      agentId,
      companyId,
      INCIDENT_ERROR_WITHOUT_RESET,
    );

    expect(retryRun.scheduledRetryAt!.getTime()).toBe(EXPECTED_DEFAULT_BACKOFF_MS);

    await expect
      .poll(
        () =>
          db
            .select({
              message: heartbeatRunEvents.message,
              payload: heartbeatRunEvents.payload,
            })
            .from(heartbeatRunEvents)
            .where(eq(heartbeatRunEvents.runId, run.id))
            .then(
              (rows) =>
                rows.find((row) => row.message?.includes("Waiting for provider quota reset")) ?? null,
            ),
        { timeout: 5_000, interval: 50 },
      )
      .toMatchObject({
        message: expect.stringContaining("Waiting for provider quota reset until"),
        payload: expect.objectContaining({
          errorFamily: "provider_quota",
          scheduledRetryAttempt: 1,
          scheduledRetryAt: retryRun.scheduledRetryAt!.toISOString(),
        }),
      });

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
