import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { HttpError } from "../errors.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue agent creation guard tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("issueService.create agent creation quantitative guards", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-agent-guard-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `G${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Guarded creator",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function createHumanRoot(companyId: string, title: string) {
    return svc.create(companyId, {
      title,
      createdByUserId: randomUUID(),
    });
  }

  function expectGuardError(
    error: unknown,
    dimension: "per_run" | "agent_wave_30m" | "root_wave_30m" | "tree_depth" | "root_descendants",
    limit: number,
    observed: number,
  ) {
    expect(error).toBeInstanceOf(HttpError);
    const httpError = error as HttpError;
    expect(httpError.status).toBe(422);
    expect(httpError.details).toEqual({
      code: "agent_issue_creation_guard",
      dimension,
      limit,
      observed,
      retryable: false,
      remediation: expect.any(String),
    });
  }

  async function countAgentRunIssues(companyId: string, agentId: string, originRunId: string) {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(issues)
      .where(and(
        eq(issues.companyId, companyId),
        eq(issues.createdByAgentId, agentId),
        eq(issues.originRunId, originRunId),
      ));
    return count;
  }

  it("rejects the 7th agent-created child in one creation run with per_run details", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const runId = randomUUID();
    const root = await createHumanRoot(companyId, "Human root for per-run guard");

    for (let index = 0; index < 6; index += 1) {
      await svc.create(companyId, {
        parentId: root.id,
        title: `Per-run child ${index + 1} ${randomUUID()}`,
        createdByAgentId: agentId,
        originRunId: runId,
        allowDuplicate: true,
      });
    }

    await expect(
      svc.create(companyId, {
        parentId: root.id,
        title: `Per-run child 7 ${randomUUID()}`,
        createdByAgentId: agentId,
        originRunId: runId,
        allowDuplicate: true,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectGuardError(error, "per_run", 6, 7);
      return true;
    });
  });

  it("rejects the 13th agent-created issue in a 30-minute wave with agent_wave_30m details", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const runA = randomUUID();
    const runB = randomUUID();
    const roots = await Promise.all([
      createHumanRoot(companyId, "Human root A"),
      createHumanRoot(companyId, "Human root B"),
      createHumanRoot(companyId, "Human root C"),
    ]);

    for (let index = 0; index < 12; index += 1) {
      await svc.create(companyId, {
        parentId: roots[index % roots.length].id,
        title: `Agent wave child ${index + 1} ${randomUUID()}`,
        createdByAgentId: agentId,
        originRunId: index < 6 ? runA : runB,
        allowDuplicate: true,
      });
    }

    await expect(
      svc.create(companyId, {
        parentId: roots[0].id,
        title: `Agent wave child 13 ${randomUUID()}`,
        createdByAgentId: agentId,
        originRunId: randomUUID(),
        allowDuplicate: true,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectGuardError(error, "agent_wave_30m", 12, 13);
      return true;
    });
  });

  it("rejects the 5th agent-created root in 30 minutes with root_wave_30m details", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();

    for (let index = 0; index < 4; index += 1) {
      await svc.create(companyId, {
        title: `Agent root ${index + 1} ${randomUUID()}`,
        createdByAgentId: agentId,
        originRunId: randomUUID(),
        allowDuplicate: true,
      });
    }

    await expect(
      svc.create(companyId, {
        title: `Agent root 5 ${randomUUID()}`,
        createdByAgentId: agentId,
        originRunId: randomUUID(),
        allowDuplicate: true,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectGuardError(error, "root_wave_30m", 4, 5);
      return true;
    });
  });

  it("rejects an agent-created child under depth-4 parent even when requestDepth is forged to 0", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const root = await createHumanRoot(companyId, "Human root for depth guard");
    const depth1 = await svc.create(companyId, {
      parentId: root.id,
      title: `Human depth 1 ${randomUUID()}`,
      createdByUserId: randomUUID(),
    });
    const depth2 = await svc.create(companyId, {
      parentId: depth1.id,
      title: `Human depth 2 ${randomUUID()}`,
      createdByUserId: randomUUID(),
    });
    const depth3 = await svc.create(companyId, {
      parentId: depth2.id,
      title: `Human depth 3 ${randomUUID()}`,
      createdByUserId: randomUUID(),
    });
    const depth4 = await svc.create(companyId, {
      parentId: depth3.id,
      title: `Human depth 4 ${randomUUID()}`,
      createdByUserId: randomUUID(),
    });

    await expect(
      svc.create(companyId, {
        parentId: depth4.id,
        title: `Agent depth 5 candidate ${randomUUID()}`,
        createdByAgentId: agentId,
        originRunId: randomUUID(),
        requestDepth: 0,
        allowDuplicate: true,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectGuardError(error, "tree_depth", 4, 5);
      return true;
    });
  });

  it("rejects the 13th descendant under one root for an agent-created insert", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const freshAgentId = randomUUID();
    const freshRunId = randomUUID();
    await db.insert(agents).values({
      id: freshAgentId,
      companyId,
      name: "Fresh descendant guard agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const root = await createHumanRoot(companyId, "Human root for descendant guard");

    for (let index = 0; index < 12; index += 1) {
      await svc.create(companyId, {
        parentId: root.id,
        title: `Human descendant ${index + 1} ${randomUUID()}`,
        createdByUserId: randomUUID(),
      });
    }

    await expect(
      svc.create(companyId, {
        parentId: root.id,
        title: `Agent descendant 13 ${randomUUID()}`,
        createdByAgentId: freshAgentId,
        originRunId: freshRunId,
        allowDuplicate: true,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectGuardError(error, "root_descendants", 12, 13);
      return true;
    });
  });

  it("does not throttle human-created issues even above all agent guard thresholds", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const root = await createHumanRoot(companyId, "Human root for unlimited human children");

    for (let index = 0; index < 13; index += 1) {
      await svc.create(companyId, {
        parentId: root.id,
        title: `Human child ${index + 1} ${randomUUID()}`,
        createdByUserId: randomUUID(),
      });
    }

    const createdChildren = await db
      .select()
      .from(issues)
      .where(and(
        eq(issues.companyId, companyId),
        eq(issues.parentId, root.id),
      ));
    expect(createdChildren).toHaveLength(13);
  });

  it("deduplicates agent-created siblings by default without consuming per-run quota on replay", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const runId = randomUUID();
    const root = await createHumanRoot(companyId, "Human root for dedupe default");
    const sharedTitle = `Agent dedupe title ${randomUUID()}`;

    const first = await svc.create(companyId, {
      parentId: root.id,
      title: sharedTitle,
      createdByAgentId: agentId,
      allowDuplicate: true,
    });
    const replay = await svc.create(companyId, {
      parentId: root.id,
      title: sharedTitle,
      createdByAgentId: agentId,
      originRunId: runId,
    });
    expect(replay.id).toBe(first.id);
    expect(await countAgentRunIssues(companyId, agentId, runId)).toBe(0);

    for (let index = 0; index < 6; index += 1) {
      await svc.create(companyId, {
        parentId: root.id,
        title: `Post-replay unique ${index + 1} ${randomUUID()}`,
        createdByAgentId: agentId,
        originRunId: runId,
      });
    }

    await expect(
      svc.create(companyId, {
        parentId: root.id,
        title: `Post-replay unique 7 ${randomUUID()}`,
        createdByAgentId: agentId,
        originRunId: runId,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectGuardError(error, "per_run", 6, 7);
      return true;
    });
  });

  it("allows exactly one of two concurrent creates when run quota has one slot left", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const runId = randomUUID();
    const root = await createHumanRoot(companyId, "Human root for concurrent guard");
    const dbB = createDb(tempDb!.connectionString);
    const svcA = issueService(db);
    const svcB = issueService(dbB);

    for (let index = 0; index < 5; index += 1) {
      await svc.create(companyId, {
        parentId: root.id,
        title: `Existing run item ${index + 1} ${randomUUID()}`,
        createdByAgentId: agentId,
        originRunId: runId,
        allowDuplicate: true,
      });
    }

    const settled = await Promise.allSettled([
      svcA.create(companyId, {
        parentId: root.id,
        title: `Concurrent candidate A ${randomUUID()}`,
        createdByAgentId: agentId,
        originRunId: runId,
        allowDuplicate: true,
      }),
      svcB.create(companyId, {
        parentId: root.id,
        title: `Concurrent candidate B ${randomUUID()}`,
        createdByAgentId: agentId,
        originRunId: runId,
        allowDuplicate: true,
      }),
    ]);

    const fulfilled = settled.filter((result) => result.status === "fulfilled");
    const rejected = settled.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expectGuardError(rejected[0].reason, "per_run", 6, 7);
    expect(await countAgentRunIssues(companyId, agentId, runId)).toBe(6);
  });
});
