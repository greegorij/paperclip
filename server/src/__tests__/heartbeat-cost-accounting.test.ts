import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agentRuntimeState,
  agents,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  hasLedgerUsage,
  heartbeatService,
  resolveLedgerCostStatus,
} from "../services/heartbeat.js";
import { costService } from "../services/costs.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

describe("heartbeat cost accounting", () => {
  it("marks token-bearing CLI usage without a reported cost as unpriced", () => {
    expect(resolveLedgerCostStatus({
      costUsd: null,
      inputTokens: 2_732_577,
      cachedInputTokens: 2_632_998,
      outputTokens: 32_644,
    })).toBe("unpriced");
  });

  it("marks reported CLI cost as priced", () => {
    expect(resolveLedgerCostStatus({
      costUsd: 1.25,
      inputTokens: 2_090,
      cachedInputTokens: 300_000,
      outputTokens: 77_000,
    })).toBe("reported");
  });

  it("detects ledger-worthy token usage for failed/cancelled runs", () => {
    expect(hasLedgerUsage({
      inputTokens: 1_200,
      cachedInputTokens: 800,
      outputTokens: 90,
      costUsd: null,
      billingType: "subscription_included",
    })).toBe(true);
  });

  it("skips empty runs with no tokens and no billed cost", () => {
    expect(hasLedgerUsage({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      costUsd: null,
      billingType: "subscription_included",
    })).toBe(false);
  });

  it("keeps billed API cost ledger-worthy even without tokens", () => {
    expect(hasLedgerUsage({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      costUsd: 0.42,
      billingType: "metered_api",
    })).toBe(true);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres failed-run cost ledger tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("cost_events for failed and cancelled heartbeat runs", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const costs = () => costService(db);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-failed-run-costs-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
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
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Ledger Agent",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedRun(input: {
    companyId: string;
    agentId: string;
    status: "succeeded" | "failed" | "cancelled";
    usageJson?: Record<string, unknown> | null;
  }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      status: input.status,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      startedAt: new Date("2026-07-27T10:00:00.000Z"),
      finishedAt: new Date("2026-07-27T10:05:00.000Z"),
      usageJson: input.usageJson ?? null,
      contextSnapshot: {},
    });
    return runId;
  }

  async function recordRunCost(input: {
    companyId: string;
    agentId: string;
    runId: string;
    tokens: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
    costUsd?: number | null;
  }) {
    const { inputTokens, cachedInputTokens, outputTokens } = input.tokens;
    if (!hasLedgerUsage({ ...input.tokens, costUsd: input.costUsd, billingType: "subscription_included" })) {
      return null;
    }
    return costs().createEvent(input.companyId, {
      heartbeatRunId: input.runId,
      agentId: input.agentId,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "subscription_included",
      costStatus: resolveLedgerCostStatus({
        costUsd: input.costUsd,
        inputTokens,
        cachedInputTokens,
        outputTokens,
      }),
      model: "claude-fable-5",
      inputTokens,
      cachedInputTokens,
      outputTokens,
      costCents: 0,
      occurredAt: new Date("2026-07-27T10:05:00.000Z"),
    }).then((result) => result.event);
  }

  it("records a cost event for a succeeded run with the same values as today", async () => {
    const { companyId, agentId } = await seedAgent();
    const runId = await seedRun({
      companyId,
      agentId,
      status: "succeeded",
      usageJson: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 40, costUsd: 1.25 },
    });

    const { event } = await costs().createEvent(companyId, {
      heartbeatRunId: runId,
      agentId,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "metered_api",
      costStatus: "reported",
      model: "claude-fable-5",
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 40,
      costCents: 125,
      occurredAt: new Date("2026-07-27T10:05:00.000Z"),
    });

    expect(event.inputTokens).toBe(100);
    expect(event.cachedInputTokens).toBe(20);
    expect(event.outputTokens).toBe(40);
    expect(event.costCents).toBe(125);
    expect(event.costStatus).toBe("reported");
  });

  it("records a cost event for a failed run that consumed tokens", async () => {
    const { companyId, agentId } = await seedAgent();
    const runId = await seedRun({
      companyId,
      agentId,
      status: "failed",
      usageJson: { inputTokens: 2_000, cachedInputTokens: 500, outputTokens: 300 },
    });

    const event = await recordRunCost({
      companyId,
      agentId,
      runId,
      tokens: { inputTokens: 2_000, cachedInputTokens: 500, outputTokens: 300 },
      costUsd: null,
    });

    expect(event).not.toBeNull();
    expect(event?.inputTokens).toBe(2_000);
    expect(event?.cachedInputTokens).toBe(500);
    expect(event?.outputTokens).toBe(300);
    expect(event?.costStatus).toBe("unpriced");

    const [joined] = await db
      .select({
        runStatus: heartbeatRuns.status,
        costEventId: costEvents.id,
        outputTokens: costEvents.outputTokens,
      })
      .from(costEvents)
      .innerJoin(heartbeatRuns, eq(costEvents.heartbeatRunId, heartbeatRuns.id))
      .where(and(eq(costEvents.companyId, companyId), eq(costEvents.heartbeatRunId, runId)));

    // Distinguishability: cost_status is pricing completeness (reported|unpriced);
    // failed vs succeeded is heartbeat_runs.status via heartbeat_run_id.
    expect(joined?.runStatus).toBe("failed");
    expect(joined?.outputTokens).toBe(300);
  });

  it("does not create a cost event for a failed run with zero usage", async () => {
    const { companyId, agentId } = await seedAgent();
    const runId = await seedRun({ companyId, agentId, status: "failed", usageJson: null });

    const event = await recordRunCost({
      companyId,
      agentId,
      runId,
      tokens: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      costUsd: null,
    });

    expect(event).toBeNull();
    const rows = await db
      .select()
      .from(costEvents)
      .where(eq(costEvents.heartbeatRunId, runId));
    expect(rows).toHaveLength(0);
  });

  it("records a cost event for a cancelled run that consumed tokens", async () => {
    const { companyId, agentId } = await seedAgent();
    const runId = await seedRun({
      companyId,
      agentId,
      status: "cancelled",
      usageJson: { inputTokens: 900, cachedInputTokens: 100, outputTokens: 50 },
    });

    const event = await recordRunCost({
      companyId,
      agentId,
      runId,
      tokens: { inputTokens: 900, cachedInputTokens: 100, outputTokens: 50 },
      costUsd: null,
    });

    expect(event).not.toBeNull();
    const [joined] = await db
      .select({ runStatus: heartbeatRuns.status })
      .from(costEvents)
      .innerJoin(heartbeatRuns, eq(costEvents.heartbeatRunId, heartbeatRuns.id))
      .where(eq(costEvents.heartbeatRunId, runId));
    expect(joined?.runStatus).toBe("cancelled");
  });

  it("does not double-count when createEvent is called twice for the same run", async () => {
    const { companyId, agentId } = await seedAgent();
    const runId = await seedRun({
      companyId,
      agentId,
      status: "failed",
      usageJson: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 },
    });

    const first = await recordRunCost({
      companyId,
      agentId,
      runId,
      tokens: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 },
    });
    const second = await recordRunCost({
      companyId,
      agentId,
      runId,
      tokens: { inputTokens: 99, cachedInputTokens: 0, outputTokens: 99 },
    });

    expect(first?.id).toBe(second?.id);
    expect(second?.inputTokens).toBe(10);
    const rows = await db
      .select()
      .from(costEvents)
      .where(eq(costEvents.heartbeatRunId, runId));
    expect(rows).toHaveLength(1);
  });

  it("allows multiple cost events when heartbeat_run_id is null", async () => {
    const { companyId, agentId } = await seedAgent();

    const first = await costs().createEvent(companyId, {
      agentId,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "metered_api",
      costStatus: "reported",
      model: "claude-fable-5",
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      costCents: 1,
      occurredAt: new Date("2026-07-27T10:05:00.000Z"),
    });
    const second = await costs().createEvent(companyId, {
      agentId,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "metered_api",
      costStatus: "reported",
      model: "claude-fable-5",
      inputTokens: 2,
      cachedInputTokens: 0,
      outputTokens: 2,
      costCents: 2,
      occurredAt: new Date("2026-07-27T10:06:00.000Z"),
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(first.event.id).not.toBe(second.event.id);
    const rows = await db
      .select()
      .from(costEvents)
      .where(eq(costEvents.companyId, companyId));
    expect(rows).toHaveLength(2);
  });
});

describeEmbeddedPostgres("concurrent heartbeat run cost ledger race", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-cost-race-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("two parallel finalize paths for the same run write one cost_events row and bump totals once", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Race Agent",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agentRuntimeState).values({
      agentId,
      companyId,
      adapterType: "claude_local",
      stateJson: {},
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCachedInputTokens: 0,
      totalCostCents: 0,
    });
    const [run] = await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "failed",
      invocationSource: "on_demand",
      triggerDetail: "manual",
      startedAt: new Date("2026-07-27T10:00:00.000Z"),
      finishedAt: new Date("2026-07-27T10:05:00.000Z"),
      usageJson: { inputTokens: 1_000, cachedInputTokens: 200, outputTokens: 50 },
      contextSnapshot: {},
    }).returning();

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    const heartbeat = heartbeatService(db);
    const adapterResult = {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "provider rate limit",
      usage: { inputTokens: 1_000, cachedInputTokens: 200, outputTokens: 50 },
      provider: "anthropic",
      biller: "anthropic",
      billingType: "subscription_included" as const,
      costUsd: null,
      model: "claude-fable-5",
    };

    // Simulate cancel-path + late-execute-return both closing the same run.
    const results = await Promise.allSettled([
      heartbeat.updateRuntimeState(agent!, run!, adapterResult, { legacySessionId: null }),
      heartbeat.updateRuntimeState(agent!, run!, adapterResult, { legacySessionId: null }),
    ]);

    expect(results.every((result) => result.status === "fulfilled")).toBe(true);

    const ledgerRows = await db
      .select()
      .from(costEvents)
      .where(and(eq(costEvents.companyId, companyId), eq(costEvents.heartbeatRunId, runId)));
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]?.inputTokens).toBe(1_000);
    expect(ledgerRows[0]?.cachedInputTokens).toBe(200);
    expect(ledgerRows[0]?.outputTokens).toBe(50);

    const [runtime] = await db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId));
    expect(runtime?.totalInputTokens).toBe(1_000);
    expect(runtime?.totalCachedInputTokens).toBe(200);
    expect(runtime?.totalOutputTokens).toBe(50);
    expect(runtime?.totalCostCents).toBe(0);
    expect(runtime?.lastRunId).toBe(runId);
  });

  it("createEvent fans in under a burst of parallel inserts for the same run", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Burst Agent",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "cancelled",
      invocationSource: "on_demand",
      triggerDetail: "manual",
      startedAt: new Date("2026-07-27T10:00:00.000Z"),
      finishedAt: new Date("2026-07-27T10:05:00.000Z"),
      usageJson: { inputTokens: 40, cachedInputTokens: 0, outputTokens: 10 },
      contextSnapshot: {},
    });

    const costs = costService(db);
    const burst = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        costs.createEvent(companyId, {
          heartbeatRunId: runId,
          agentId,
          provider: "anthropic",
          biller: "anthropic",
          billingType: "subscription_included",
          costStatus: "unpriced",
          model: "claude-fable-5",
          inputTokens: 40 + index,
          cachedInputTokens: 0,
          outputTokens: 10,
          costCents: 0,
          occurredAt: new Date("2026-07-27T10:05:00.000Z"),
        }),
      ),
    );

    expect(burst.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(burst.map((result) => result.event.id)).size).toBe(1);
    const rows = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, runId));
    expect(rows).toHaveLength(1);
  });
});
