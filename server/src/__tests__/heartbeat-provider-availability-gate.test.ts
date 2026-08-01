import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
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
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import type { ProviderAvailabilityService } from "../services/provider-availability.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const TEST_ADAPTER_TYPE = "provider_availability_gate_adapter";
const BLOCKED_RESET_AT = "2026-08-01T12:00:00.000Z";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres provider-availability gate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await heartbeat.getRun(runId);
}

async function waitForRuntimeState(
  inputDb: ReturnType<typeof createDb>,
  agentId: string,
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const state = await inputDb
      .select({ lastRunId: agentRuntimeState.lastRunId })
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    if (state?.lastRunId === runId) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`runtime state was not finalized for ${agentId}`);
}

describeEmbeddedPostgres("heartbeat provider-availability gate", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let executeCalls = 0;
  let gateMode: "blocked" | "unknown" = "blocked";

  const providerAvailability: ProviderAvailabilityService = {
    getSnapshot: async () => ({
      source: "quota_windows",
      observedAt: "2026-08-01T10:00:00.000Z",
      expiresAt: "2026-08-01T10:00:30.000Z",
      providers: [
        {
          provider: "provider_availability_gate_adapter",
          laneId: "provider_availability_gate_adapter_base",
          state: gateMode,
          reason: gateMode === "blocked"
            ? "Base quota window is exhausted."
            : "Provider quota telemetry is incomplete.",
          source: "test",
          observedAt: "2026-08-01T10:00:00.000Z",
          earliestResetAt: gateMode === "blocked" ? BLOCKED_RESET_AT : null,
          windows: gateMode === "blocked"
            ? [
              {
                label: "5h limit",
                usedPercent: 100,
                resetsAt: BLOCKED_RESET_AT,
                valueLabel: null,
                detail: null,
                requiredByBaseLane: true,
                namedWindow: false,
              },
            ]
            : [],
        },
      ],
    }),
    evaluateAdapterAvailability: async () => ({
      adapterType: TEST_ADAPTER_TYPE,
      provider: "provider_availability_gate_adapter",
      laneId: "provider_availability_gate_adapter_base",
      state: gateMode,
      reason: gateMode === "blocked"
        ? "Base quota window is exhausted."
        : "Provider quota telemetry is incomplete.",
      observedAt: "2026-08-01T10:00:00.000Z",
      earliestResetAt: gateMode === "blocked" ? BLOCKED_RESET_AT : null,
    }),
    getEarliestResetForAdapter: async () =>
      gateMode === "blocked" ? new Date(BLOCKED_RESET_AT) : null,
    clearCache: () => {},
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-provider-availability-gate-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, { providerAvailability });
    registerServerAdapter({
      type: TEST_ADAPTER_TYPE,
      execute: async () => {
        executeCalls += 1;
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          label: "Provider availability gate test adapter",
        };
      },
      testEnvironment: async () => ({
        adapterType: TEST_ADAPTER_TYPE,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
  }, 20_000);

  beforeEach(() => {
    executeCalls = 0;
    gateMode = "blocked";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-01T10:00:00.000Z"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await db.delete(environmentLeases);
        await db.delete(issueRelations);
        await db.delete(issues);
        await db.delete(executionWorkspaces);
        await db.delete(projects);
        await db.delete(activityLog);
        await db.delete(heartbeatRunEvents);
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
    unregisterServerAdapter(TEST_ADAPTER_TYPE);
    await tempDb?.cleanup();
  });

  async function seedAgent() {
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
      name: "Provider availability gate",
      role: "engineer",
      status: "idle",
      adapterType: TEST_ADAPTER_TYPE,
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

  it("does not start a new run when provider availability is blocked and persists provider_quota retry semantics", async () => {
    const { companyId, agentId } = await seedAgent();
    const run = await heartbeat.invoke(agentId, "automation", {}, "system");
    expect(run).not.toBeNull();

    const settled = await waitForRunToFinish(heartbeat, run!.id, 10_000);
    expect(settled?.status).toBe("cancelled");
    expect(settled?.errorCode).toBe("provider_quota");
    expect((settled?.resultJson as Record<string, unknown> | null)?.errorFamily).toBe("provider_quota");
    expect(Date.parse(String((settled?.resultJson as Record<string, unknown> | null)?.providerQuotaRetryNotBefore)))
      .toBeGreaterThan(Date.parse(BLOCKED_RESET_AT));
    expect(executeCalls).toBe(0);

    const retryRun = await db
      .select({
        status: heartbeatRuns.status,
        scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, run!.id))
      .then((rows) => rows[0] ?? null);

    expect(retryRun?.status).toBe("scheduled_retry");
    expect(retryRun?.scheduledRetryAt?.getTime()).toBeGreaterThan(new Date(BLOCKED_RESET_AT).getTime());

    const companyRuns = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId));
    expect(companyRuns).toHaveLength(2);
  });

  it("does not block work when provider availability is unknown", async () => {
    gateMode = "unknown";
    const { agentId } = await seedAgent();
    const run = await heartbeat.invoke(agentId, "automation", {}, "system");
    expect(run).not.toBeNull();

    const settled = await waitForRunToFinish(heartbeat, run!.id, 10_000);
    expect(settled?.status).toBe("succeeded");
    expect(settled?.errorCode ?? null).toBeNull();
    expect(executeCalls).toBe(1);
    await waitForRuntimeState(db, agentId, run!.id);
  });
});
