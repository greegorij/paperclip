import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  approvals,
  budgetIncidents,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
  projects,
} from "@paperclipai/db";
import { budgetService, clearBudgetPolicySkipWarningsForTests } from "../services/budgets.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockLoggerWarn = vi.hoisted(() => vi.fn());

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn: mockLoggerWarn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => ({
      warn: mockLoggerWarn,
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  },
}));

type SelectResult = unknown[];

function createDbStub(selectResults: SelectResult[]) {
  const pendingSelects = [...selectResults];
  const selectWhere = vi.fn(async () => pendingSelects.shift() ?? []);
  const selectThen = vi.fn((resolve: (value: unknown[]) => unknown) => Promise.resolve(resolve(pendingSelects.shift() ?? [])));
  const selectOrderBy = vi.fn(async () => pendingSelects.shift() ?? []);
  const selectFrom = vi.fn(() => ({
    where: selectWhere,
    then: selectThen,
    orderBy: selectOrderBy,
  }));
  const select = vi.fn(() => ({
    from: selectFrom,
  }));

  const insertValues = vi.fn();
  const insertReturning = vi.fn(async () => pendingInserts.shift() ?? []);
  const insert = vi.fn(() => ({
    values: insertValues.mockImplementation(() => ({
      returning: insertReturning,
    })),
  }));

  const updateSet = vi.fn();
  const updateWhere = vi.fn(async () => pendingUpdates.shift() ?? []);
  const update = vi.fn(() => ({
    set: updateSet.mockImplementation(() => ({
      where: updateWhere,
    })),
  }));

  const pendingInserts: unknown[][] = [];
  const pendingUpdates: unknown[][] = [];

  return {
    db: {
      select,
      insert,
      update,
    },
    queueInsert: (rows: unknown[]) => {
      pendingInserts.push(rows);
    },
    queueUpdate: (rows: unknown[] = []) => {
      pendingUpdates.push(rows);
    },
    selectWhere,
    insertValues,
    updateSet,
  };
}

describe("budgetService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearBudgetPolicySkipWarningsForTests();
  });

  it("creates a hard-stop incident and pauses an agent when spend exceeds a budget", async () => {
    const policy = {
      id: "policy-1",
      companyId: "company-1",
      scopeType: "agent",
      scopeId: "agent-1",
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 100,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: false,
      isActive: true,
    };

    const dbStub = createDbStub([
      [policy],
      [{ total: 150 }],
      [],
      [{
        companyId: "company-1",
        name: "Budget Agent",
        status: "running",
        pauseReason: null,
      }],
    ]);

    dbStub.queueInsert([{
      id: "approval-1",
      companyId: "company-1",
      status: "pending",
    }]);
    dbStub.queueInsert([{
      id: "incident-1",
      companyId: "company-1",
      policyId: "policy-1",
      approvalId: "approval-1",
    }]);
    dbStub.queueUpdate([]);
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);

    const service = budgetService(dbStub.db as any, { cancelWorkForScope });
    await service.evaluateCostEvent({
      companyId: "company-1",
      agentId: "agent-1",
      projectId: null,
    } as any);

    expect(dbStub.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        type: "budget_override_required",
        status: "pending",
      }),
    );
    expect(dbStub.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        policyId: "policy-1",
        thresholdType: "hard",
        amountLimit: 100,
        amountObserved: 150,
        approvalId: "approval-1",
      }),
    );
    expect(dbStub.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "paused",
        pauseReason: "budget",
        pausedAt: expect.any(Date),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "budget.hard_threshold_crossed",
        entityId: "incident-1",
      }),
    );
    expect(cancelWorkForScope).toHaveBeenCalledWith({
      companyId: "company-1",
      scopeType: "agent",
      scopeId: "agent-1",
    });
  });

  it("creates a hard-stop incident for total_tokens policies", async () => {
    const policy = {
      id: "policy-tokens-1",
      companyId: "company-1",
      scopeType: "agent",
      scopeId: "agent-1",
      metric: "total_tokens",
      windowKind: "calendar_month_utc",
      amount: 1_000,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: false,
      isActive: true,
    };

    const dbStub = createDbStub([
      [policy],
      [{ total: 1_250 }],
      [],
      [{
        companyId: "company-1",
        name: "Budget Agent",
        status: "running",
        pauseReason: null,
      }],
    ]);

    dbStub.queueInsert([{
      id: "approval-tokens-1",
      companyId: "company-1",
      status: "pending",
    }]);
    dbStub.queueInsert([{
      id: "incident-tokens-1",
      companyId: "company-1",
      policyId: "policy-tokens-1",
      approvalId: "approval-tokens-1",
    }]);
    dbStub.queueUpdate([]);
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);

    const service = budgetService(dbStub.db as any, { cancelWorkForScope });
    await service.evaluateCostEvent({
      companyId: "company-1",
      agentId: "agent-1",
      projectId: null,
    } as any);

    expect(dbStub.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        policyId: "policy-tokens-1",
        thresholdType: "hard",
        amountLimit: 1_000,
        amountObserved: 1_250,
        metric: "total_tokens",
      }),
    );
    expect(cancelWorkForScope).toHaveBeenCalledWith({
      companyId: "company-1",
      scopeType: "agent",
      scopeId: "agent-1",
    });
  });

  it("blocks new work when an agent hard-stop remains exceeded even if the agent is not paused yet", async () => {
    const agentPolicy = {
      id: "policy-agent-1",
      companyId: "company-1",
      scopeType: "agent",
      scopeId: "agent-1",
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 100,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    };

    const dbStub = createDbStub([
      [{
        status: "running",
        pauseReason: null,
        companyId: "company-1",
        name: "Budget Agent",
      }],
      [{
        status: "active",
        name: "Paperclip",
      }],
      [],
      [agentPolicy],
      [{ total: 120 }],
    ]);

    const service = budgetService(dbStub.db as any);
    const block = await service.getInvocationBlock("company-1", "agent-1");

    expect(block).toEqual({
      scopeType: "agent",
      scopeId: "agent-1",
      scopeName: "Budget Agent",
      reason: "Agent cannot start because its budget hard-stop is still exceeded.",
    });
  });

  it("surfaces a budget-owned company pause distinctly from a manual pause", async () => {
    const dbStub = createDbStub([
      [{
        status: "idle",
        pauseReason: null,
        companyId: "company-1",
        name: "Budget Agent",
      }],
      [{
        status: "paused",
        pauseReason: "budget",
        name: "Paperclip",
      }],
    ]);

    const service = budgetService(dbStub.db as any);
    const block = await service.getInvocationBlock("company-1", "agent-1");

    expect(block).toEqual({
      scopeType: "company",
      scopeId: "company-1",
      scopeName: "Paperclip",
      reason: "Company is paused because its budget hard-stop was reached.",
    });
  });

  it("uses live observed spend when raising a budget incident", async () => {
    const dbStub = createDbStub([
      [{
        id: "incident-1",
        companyId: "company-1",
        policyId: "policy-1",
        amountObserved: 120,
        approvalId: "approval-1",
      }],
      [{
        id: "policy-1",
        companyId: "company-1",
        scopeType: "company",
        scopeId: "company-1",
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
      }],
      [{ total: 150 }],
    ]);

    const service = budgetService(dbStub.db as any);

    await expect(
      service.resolveIncident(
        "company-1",
        "incident-1",
        { action: "raise_budget_and_resume", amount: 140 },
        "board-user",
      ),
    ).rejects.toThrow("New budget must exceed current observed spend");
  });

  it("syncs company monthly budget when raising and resuming a company incident", async () => {
    const now = new Date();
    const dbStub = createDbStub([
      [{
        id: "incident-1",
        companyId: "company-1",
        policyId: "policy-1",
        scopeType: "company",
        scopeId: "company-1",
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        windowStart: now,
        windowEnd: now,
        thresholdType: "hard",
        amountLimit: 100,
        amountObserved: 120,
        status: "open",
        approvalId: "approval-1",
        resolvedAt: null,
        createdAt: now,
        updatedAt: now,
      }],
      [{
        id: "policy-1",
        companyId: "company-1",
        scopeType: "company",
        scopeId: "company-1",
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        amount: 100,
      }],
      [{ total: 120 }],
      [{ id: "approval-1", status: "approved" }],
      [{
        companyId: "company-1",
        name: "Paperclip",
        status: "paused",
        pauseReason: "budget",
        pausedAt: now,
      }],
    ]);

    const service = budgetService(dbStub.db as any);
    await service.resolveIncident(
      "company-1",
      "incident-1",
      { action: "raise_budget_and_resume", amount: 175 },
      "board-user",
    );

    expect(dbStub.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        budgetMonthlyCents: 175,
        updatedAt: expect.any(Date),
      }),
    );
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("budgetService release gate enforcement", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-budgets-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(budgetIncidents);
    await db.delete(approvals);
    await db.delete(budgetPolicies);
    await db.delete(costEvents);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
    mockLogActivity.mockClear();
    mockLoggerWarn.mockClear();
    clearBudgetPolicySkipWarningsForTests();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createBudgetFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Budget Agent SECRET_TOKEN_SHOULD_NOT_LEAK",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Budget Project",
      status: "in_progress",
    });

    return { companyId, agentId, projectId };
  }

  async function insertCostEvent(input: {
    companyId: string;
    agentId: string;
    projectId?: string | null;
    costCents: number;
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    occurredAt?: Date;
  }) {
    const [event] = await db
      .insert(costEvents)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        projectId: input.projectId ?? null,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5-release-gate",
        inputTokens: input.inputTokens ?? 100,
        cachedInputTokens: input.cachedInputTokens ?? 10,
        outputTokens: input.outputTokens ?? 20,
        costCents: input.costCents,
        occurredAt: input.occurredAt ?? new Date(),
      })
      .returning();

    return event!;
  }

  it("raises one soft incident per window before hard-stopping and safely logging agent telemetry", async () => {
    const { companyId, agentId } = await createBudgetFixture();
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const service = budgetService(db, { cancelWorkForScope });
    const [policy] = await db
      .insert(budgetPolicies)
      .values({
        companyId,
        scopeType: "agent",
        scopeId: agentId,
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        amount: 100,
        warnPercent: 80,
        hardStopEnabled: true,
        notifyEnabled: true,
        isActive: true,
      })
      .returning();

    const softEvent = await insertCostEvent({ companyId, agentId, costCents: 80 });
    await service.evaluateCostEvent(softEvent);
    await service.evaluateCostEvent(softEvent);

    let incidentRows = await db
      .select()
      .from(budgetIncidents);
    expect(incidentRows.filter((incident) => incident.thresholdType === "soft")).toHaveLength(1);
    expect(incidentRows[0]).toMatchObject({
      companyId,
      policyId: policy!.id,
      scopeType: "agent",
      scopeId: agentId,
      thresholdType: "soft",
      amountLimit: 100,
      amountObserved: 80,
      approvalId: null,
      status: "open",
    });

    const [agentBeforeHardStop] = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents);
    expect(agentBeforeHardStop).toEqual({ status: "active", pauseReason: null });

    const hardEvent = await insertCostEvent({ companyId, agentId, costCents: 25 });
    await service.evaluateCostEvent(hardEvent);
    await service.evaluateCostEvent(hardEvent);

    incidentRows = await db
      .select()
      .from(budgetIncidents);
    expect(incidentRows.filter((incident) => incident.thresholdType === "soft")).toHaveLength(1);
    expect(incidentRows.filter((incident) => incident.thresholdType === "hard")).toHaveLength(1);
    expect(incidentRows.find((incident) => incident.thresholdType === "soft")).toMatchObject({
      status: "resolved",
    });
    expect(incidentRows.find((incident) => incident.thresholdType === "hard")).toMatchObject({
      amountLimit: 100,
      amountObserved: 105,
      status: "open",
    });

    const [approval] = await db.select().from(approvals);
    expect(approval).toMatchObject({
      companyId,
      type: "budget_override_required",
      status: "pending",
    });

    const [agentAfterHardStop] = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason, pausedAt: agents.pausedAt })
      .from(agents);
    expect(agentAfterHardStop).toMatchObject({ status: "paused", pauseReason: "budget" });
    expect(agentAfterHardStop?.pausedAt).toBeInstanceOf(Date);
    expect(cancelWorkForScope).toHaveBeenCalledTimes(2);
    expect(cancelWorkForScope).toHaveBeenCalledWith({ companyId, scopeType: "agent", scopeId: agentId });

    const block = await service.getInvocationBlock(companyId, agentId);
    expect(block).toEqual({
      scopeType: "agent",
      scopeId: agentId,
      scopeName: "Budget Agent SECRET_TOKEN_SHOULD_NOT_LEAK",
      reason: "Agent is paused because its budget hard-stop was reached.",
    });

    const telemetryCalls = mockLogActivity.mock.calls.map(([, input]) => input);
    expect(telemetryCalls.filter((call) => call.action === "budget.soft_threshold_crossed")).toHaveLength(1);
    expect(telemetryCalls.filter((call) => call.action === "budget.hard_threshold_crossed")).toHaveLength(1);
    expect(telemetryCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "budget.soft_threshold_crossed",
          entityType: "budget_incident",
          details: expect.objectContaining({
            scopeType: "agent",
            scopeId: agentId,
            amountObserved: 80,
            amountLimit: 100,
          }),
        }),
        expect.objectContaining({
          action: "budget.hard_threshold_crossed",
          entityType: "budget_incident",
          details: expect.objectContaining({
            scopeType: "agent",
            scopeId: agentId,
            amountObserved: 105,
            amountLimit: 100,
            approvalId: approval!.id,
          }),
        }),
      ]),
    );
    for (const call of telemetryCalls) {
      expect(JSON.stringify(call.details)).not.toContain("SECRET_TOKEN_SHOULD_NOT_LEAK");
      expect(call.details).not.toHaveProperty("prompt");
      expect(call.details).not.toHaveProperty("message");
    }
  });

  it("hard-stops project work until a valid budget raise resumes it and overview reconciles ledger spend", async () => {
    const { companyId, agentId, projectId } = await createBudgetFixture();
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const service = budgetService(db, { cancelWorkForScope });
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "project",
      scopeId: projectId,
      metric: "billed_cents",
      windowKind: "lifetime",
      amount: 100,
      warnPercent: 75,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    });

    const event = await insertCostEvent({ companyId, agentId, projectId, costCents: 125 });
    await service.evaluateCostEvent(event);
    await service.evaluateCostEvent(event);

    const incidentRows = await db
      .select()
      .from(budgetIncidents);
    expect(incidentRows.filter((incident) => incident.thresholdType === "hard")).toHaveLength(1);
    const hardIncident = incidentRows.find((incident) => incident.thresholdType === "hard")!;
    expect(hardIncident).toMatchObject({
      companyId,
      scopeType: "project",
      scopeId: projectId,
      amountLimit: 100,
      amountObserved: 125,
      status: "open",
    });

    const [projectAfterHardStop] = await db
      .select({ pauseReason: projects.pauseReason, pausedAt: projects.pausedAt })
      .from(projects);
    expect(projectAfterHardStop?.pauseReason).toBe("budget");
    expect(projectAfterHardStop?.pausedAt).toBeInstanceOf(Date);
    expect(cancelWorkForScope).toHaveBeenCalledWith({ companyId, scopeType: "project", scopeId: projectId });

    const overviewWhileBlocked = await service.overview(companyId);
    expect(overviewWhileBlocked.pausedProjectCount).toBe(1);
    expect(overviewWhileBlocked.pendingApprovalCount).toBe(1);
    expect(overviewWhileBlocked.policies[0]).toMatchObject({
      scopeType: "project",
      scopeId: projectId,
      amount: 100,
      observedAmount: 125,
      remainingAmount: 0,
      utilizationPercent: 125,
      status: "hard_stop",
      paused: true,
      pauseReason: "budget",
    });
    expect(overviewWhileBlocked.activeIncidents).toHaveLength(1);

    await expect(
      service.resolveIncident(
        companyId,
        hardIncident.id,
        { action: "raise_budget_and_resume", amount: 125 },
        "board-user",
      ),
    ).rejects.toThrow("New budget must exceed current observed spend");

    expect(await service.getInvocationBlock(companyId, agentId, { projectId })).toEqual({
      scopeType: "project",
      scopeId: projectId,
      scopeName: "Budget Project",
      reason: "Project cannot start work because its budget hard-stop is still exceeded.",
    });

    const resolved = await service.resolveIncident(
      companyId,
      hardIncident.id,
      { action: "raise_budget_and_resume", amount: 175, decisionNote: "Approved release-gate budget raise." },
      "board-user",
    );
    expect(resolved).toMatchObject({ status: "resolved", approvalStatus: "approved" });

    const [projectAfterResume] = await db
      .select({ pauseReason: projects.pauseReason, pausedAt: projects.pausedAt })
      .from(projects);
    expect(projectAfterResume).toEqual({ pauseReason: null, pausedAt: null });
    expect(await service.getInvocationBlock(companyId, agentId, { projectId })).toBeNull();

    const overviewAfterResume = await service.overview(companyId);
    expect(overviewAfterResume.pausedProjectCount).toBe(0);
    expect(overviewAfterResume.pendingApprovalCount).toBe(0);
    expect(overviewAfterResume.policies[0]).toMatchObject({
      scopeType: "project",
      scopeId: projectId,
      amount: 175,
      observedAmount: 125,
      remainingAmount: 50,
      utilizationPercent: expect.closeTo(71.43, 2),
      status: "ok",
      paused: false,
      pauseReason: null,
    });
    expect(overviewAfterResume.activeIncidents).toHaveLength(0);
  });

  it("does not surface open incidents from an expired budget window as active", async () => {
    const { companyId, agentId } = await createBudgetFixture();
    const service = budgetService(db);
    const now = new Date();
    const previousMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const [policy] = await db
      .insert(budgetPolicies)
      .values({
        companyId,
        scopeType: "agent",
        scopeId: agentId,
        metric: "total_tokens",
        windowKind: "calendar_month_utc",
        amount: 100,
        warnPercent: 80,
        hardStopEnabled: true,
        notifyEnabled: true,
        isActive: true,
      })
      .returning();
    await db.insert(budgetIncidents).values({
      companyId,
      policyId: policy!.id,
      scopeType: "agent",
      scopeId: agentId,
      metric: "total_tokens",
      windowKind: "calendar_month_utc",
      windowStart: previousMonthStart,
      windowEnd: currentMonthStart,
      thresholdType: "hard",
      amountLimit: 100,
      amountObserved: 125,
      status: "open",
    });

    const overview = await service.overview(companyId);

    expect(overview.activeIncidents).toEqual([]);
    expect(overview.pendingApprovalCount).toBe(0);
  });

  it("enforces total_tokens hard-stop for agent and company scopes and ignores cached_input_tokens", async () => {
    const { companyId, agentId } = await createBudgetFixture();
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const service = budgetService(db, { cancelWorkForScope });

    const [agentPolicy] = await db
      .insert(budgetPolicies)
      .values({
        companyId,
        scopeType: "agent",
        scopeId: agentId,
        metric: "total_tokens",
        windowKind: "calendar_month_utc",
        amount: 200,
        warnPercent: 80,
        hardStopEnabled: true,
        notifyEnabled: true,
        isActive: true,
      })
      .returning();

    // 100 input + 0 output = 100 observed; 10_000 cached must not inflate the metric.
    const softEvent = await insertCostEvent({
      companyId,
      agentId,
      costCents: 0,
      inputTokens: 100,
      cachedInputTokens: 10_000,
      outputTokens: 60,
    });
    await service.evaluateCostEvent(softEvent);

    let incidentRows = await db.select().from(budgetIncidents);
    expect(incidentRows).toHaveLength(1);
    expect(incidentRows[0]).toMatchObject({
      policyId: agentPolicy!.id,
      metric: "total_tokens",
      thresholdType: "soft",
      amountLimit: 200,
      amountObserved: 160,
      status: "open",
    });

    const hardEvent = await insertCostEvent({
      companyId,
      agentId,
      costCents: 0,
      inputTokens: 30,
      cachedInputTokens: 50_000,
      outputTokens: 20,
    });
    await service.evaluateCostEvent(hardEvent);

    incidentRows = await db.select().from(budgetIncidents);
    expect(incidentRows.filter((incident) => incident.thresholdType === "hard")).toHaveLength(1);
    expect(incidentRows.find((incident) => incident.thresholdType === "hard")).toMatchObject({
      metric: "total_tokens",
      amountLimit: 200,
      amountObserved: 210,
      status: "open",
    });
    expect(incidentRows.find((incident) => incident.thresholdType === "soft")).toMatchObject({
      status: "resolved",
    });

    const [agentAfterHardStop] = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents);
    expect(agentAfterHardStop).toEqual({ status: "paused", pauseReason: "budget" });
    expect(cancelWorkForScope).toHaveBeenCalledWith({ companyId, scopeType: "agent", scopeId: agentId });

    expect(await service.getInvocationBlock(companyId, agentId)).toEqual({
      scopeType: "agent",
      scopeId: agentId,
      scopeName: "Budget Agent SECRET_TOKEN_SHOULD_NOT_LEAK",
      reason: "Agent is paused because its budget hard-stop was reached.",
    });

    // Company-scoped token policy can also block before pause is applied.
    await db.update(agents).set({ status: "idle", pauseReason: null, pausedAt: null });
    await db.delete(budgetIncidents);
    await db.delete(approvals);
    await db.delete(budgetPolicies);

    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "company",
      scopeId: companyId,
      metric: "total_tokens",
      windowKind: "calendar_month_utc",
      amount: 200,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: false,
      isActive: true,
    });

    // Existing cost events already sum to 210 tokens for the company.
    expect(await service.getInvocationBlock(companyId, agentId)).toEqual({
      scopeType: "company",
      scopeId: companyId,
      scopeName: "Paperclip",
      reason: "Company cannot start new work because its budget hard-stop is exceeded.",
    });
  });

  it("keeps billed_cents enforcement unchanged alongside a total_tokens policy on the same agent", async () => {
    const { companyId, agentId } = await createBudgetFixture();
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const service = budgetService(db, { cancelWorkForScope });

    await db.insert(budgetPolicies).values([
      {
        companyId,
        scopeType: "agent",
        scopeId: agentId,
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        amount: 100,
        warnPercent: 80,
        hardStopEnabled: true,
        notifyEnabled: true,
        isActive: true,
      },
      {
        companyId,
        scopeType: "agent",
        scopeId: agentId,
        metric: "total_tokens",
        windowKind: "calendar_month_utc",
        amount: 1_000_000,
        warnPercent: 80,
        hardStopEnabled: true,
        notifyEnabled: true,
        isActive: true,
      },
    ]);

    const event = await insertCostEvent({
      companyId,
      agentId,
      costCents: 125,
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 5,
    });
    await service.evaluateCostEvent(event);

    const incidentRows = await db.select().from(budgetIncidents);
    expect(incidentRows.filter((incident) => incident.metric === "billed_cents" && incident.thresholdType === "hard")).toHaveLength(1);
    expect(incidentRows.filter((incident) => incident.metric === "total_tokens")).toHaveLength(0);

    const [agentAfterHardStop] = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents);
    expect(agentAfterHardStop).toEqual({ status: "paused", pauseReason: "budget" });
  });

  it("warns once and skips enforcement for an active policy with an unrecognized metric", async () => {
    const { companyId, agentId } = await createBudgetFixture();
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const service = budgetService(db, { cancelWorkForScope });

    const [brokenPolicy] = await db
      .insert(budgetPolicies)
      .values({
        companyId,
        scopeType: "agent",
        scopeId: agentId,
        metric: "legacy_spend_units",
        windowKind: "calendar_month_utc",
        amount: 50,
        warnPercent: 80,
        hardStopEnabled: true,
        notifyEnabled: true,
        isActive: true,
      })
      .returning();

    const [validPolicy] = await db
      .insert(budgetPolicies)
      .values({
        companyId,
        scopeType: "agent",
        scopeId: agentId,
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        amount: 100,
        warnPercent: 80,
        hardStopEnabled: true,
        notifyEnabled: false,
        isActive: true,
      })
      .returning();

    const event = await insertCostEvent({
      companyId,
      agentId,
      costCents: 150,
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 5,
    });
    await service.evaluateCostEvent(event);
    await service.evaluateCostEvent(event);
    await service.evaluateCostEvent(event);

    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        budgetPolicySkip: true,
        reason: "unsupported_metric",
        policyId: brokenPolicy!.id,
        scopeType: "agent",
        scopeId: agentId,
        metric: "legacy_spend_units",
        amount: 50,
      }),
      "budget_policy_skipped_unenforcable: active budget policy cannot be enforced",
    );

    const incidentRows = await db.select().from(budgetIncidents);
    expect(incidentRows.filter((incident) => incident.policyId === brokenPolicy!.id)).toHaveLength(0);
    expect(incidentRows.filter((incident) => incident.policyId === validPolicy!.id && incident.thresholdType === "hard")).toHaveLength(1);
    expect(cancelWorkForScope).toHaveBeenCalledWith({ companyId, scopeType: "agent", scopeId: agentId });
  });

  it("warns once and skips enforcement for an active policy with a non-positive amount", async () => {
    const { companyId, agentId } = await createBudgetFixture();
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const service = budgetService(db, { cancelWorkForScope });

    const [zeroPolicy] = await db
      .insert(budgetPolicies)
      .values({
        companyId,
        scopeType: "agent",
        scopeId: agentId,
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        amount: 0,
        warnPercent: 80,
        hardStopEnabled: true,
        notifyEnabled: true,
        isActive: true,
      })
      .returning();

    const event = await insertCostEvent({
      companyId,
      agentId,
      costCents: 999,
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 5,
    });
    await service.evaluateCostEvent(event);
    await service.evaluateCostEvent(event);

    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        budgetPolicySkip: true,
        reason: "non_positive_amount",
        policyId: zeroPolicy!.id,
        scopeType: "agent",
        scopeId: agentId,
        metric: "billed_cents",
        amount: 0,
      }),
      "budget_policy_skipped_unenforcable: active budget policy cannot be enforced",
    );

    const incidentRows = await db.select().from(budgetIncidents);
    expect(incidentRows).toHaveLength(0);
    expect(cancelWorkForScope).not.toHaveBeenCalled();

    const [agentAfter] = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents);
    expect(agentAfter).toEqual({ status: "active", pauseReason: null });
  });
});
