import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    companyService: () => mockCompanyService,
  }));
}

async function createApp(
  actor: Record<string, unknown>,
  options: {
    loadProjection?: () => Promise<unknown>;
  } = {},
) {
  const [{ fleetModelPolicyRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/fleet-model-policy.js")>(
      "../routes/fleet-model-policy.js",
    ),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use(
    "/api",
    fleetModelPolicyRoutes(
      {} as any,
      options.loadProjection
        ? { loadProjection: options.loadProjection as () => Promise<any> }
        : {},
    ),
  );
  app.use(errorHandler);
  return app;
}

const boardActor = {
  type: "board",
  userId: "board-user",
  source: "local_implicit",
  companyIds: ["company-1"],
};

describe("fleet model policy routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/fleet-model-policy.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockCompanyService.getById.mockResolvedValue({
      id: "company-1",
      name: "Paperclip",
    });
  });

  it("returns a narrowed board-readable projection for an authorized company", async () => {
    const app = await createApp(boardActor);
    const res = await request(app).get("/api/companies/company-1/fleet-model-policy");

    expect(res.status).toBe(200);
    expect(mockCompanyService.getById).toHaveBeenCalledWith("company-1");
    expect(res.body.policyId).toBe("jarvis-shadow-model-policy");
    expect(res.body.mode).toBe("shadow");
    expect(typeof res.body.version).toBe("string");
    expect(res.body.profiles).toEqual(
      expect.objectContaining({
        "openai-first": expect.objectContaining({ version: expect.any(String), agents: expect.any(Array) }),
        "anthropic-first": expect.objectContaining({ version: expect.any(String), agents: expect.any(Array) }),
      }),
    );
    expect(Object.keys(res.body).sort()).toEqual([
      "mode",
      "policyId",
      "profiles",
      "roles",
      "version",
    ]);
    expect(res.body).not.toHaveProperty("providers");
    expect(res.body).not.toHaveProperty("modelCatalog");
    expect(res.body).not.toHaveProperty("schemaVersion");

    const sampleRole = Object.values(res.body.roles)[0] as Record<string, unknown>;
    expect(sampleRole).toEqual(
      expect.objectContaining({
        primary: expect.objectContaining({ model: expect.any(String) }),
        fallback: expect.any(Array),
      }),
    );
    expect(sampleRole).not.toHaveProperty("adapterType");
    expect(JSON.stringify(sampleRole)).not.toMatch(/pricing|quotaSource|apiKey|credentials/i);

    const sampleProfile = Object.values(res.body.profiles)[0] as {
      version: string;
      agents: Array<Record<string, unknown>>;
    };
    expect(sampleProfile.version).toEqual(expect.any(String));
    expect(sampleProfile.agents.length).toBeGreaterThan(0);
    for (const agent of sampleProfile.agents) {
      expect(Object.keys(agent).every((key) =>
        ["slug", "model", "modelReasoningEffort"].includes(key),
      )).toBe(true);
      expect(agent).not.toHaveProperty("adapterType");
      expect(agent).not.toHaveProperty("maxDailyRuns");
      expect(agent).not.toHaveProperty("maxTurnsPerRun");
      expect(agent).not.toHaveProperty("claudeConfigProfile");
      expect(agent).not.toHaveProperty("filesystemWorkspaceAccess");
    }

    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("ops/fleet");
    expect(serialized).not.toContain("model-policy.shadow.v1.json");
    expect(serialized).not.toContain("profiles.json");
    expect(serialized).not.toMatch(/[/\\]Users[/\\]|[/\\]home[/\\]/);
  });

  it("rejects unauthorized non-board access", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
    });
    const res = await request(app).get("/api/companies/company-1/fleet-model-policy");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Board access required" });
    expect(mockCompanyService.getById).not.toHaveBeenCalled();
  });

  it("rejects board actors outside the company", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-2"],
    });
    const res = await request(app).get("/api/companies/company-1/fleet-model-policy");

    expect(res.status).toBe(403);
    expect(mockCompanyService.getById).not.toHaveBeenCalled();
  });

  it("returns a generic 503 when committed inputs are missing or invalid", async () => {
    const leak = "/secret/ops/fleet/jarvis/desired/model-policy.shadow.v1.json";
    const app = await createApp(boardActor, {
      loadProjection: async () => {
        throw Object.assign(new Error(`ENOENT: ${leak}`), { code: "ENOENT", path: leak });
      },
    });
    const res = await request(app).get("/api/companies/company-1/fleet-model-policy");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "Fleet model policy unavailable" });
    expect(JSON.stringify(res.body)).not.toContain(leak);
    expect(JSON.stringify(res.body)).not.toContain("ENOENT");
    expect(JSON.stringify(res.body)).not.toContain("ops/fleet");
  });

  it("returns a generic 503 when projection parsing fails", async () => {
    const { loadFleetModelPolicyProjection } = await vi.importActual<
      typeof import("../routes/fleet-model-policy.js")
    >("../routes/fleet-model-policy.js");

    const app = await createApp(boardActor, {
      loadProjection: () =>
        loadFleetModelPolicyProjection(async () =>
          JSON.stringify({
            policyId: "broken",
            version: "broken",
            mode: "shadow",
            roles: { badacz: { primary: { model: "x" } } },
          }),
        ),
    });
    const res = await request(app).get("/api/companies/company-1/fleet-model-policy");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "Fleet model policy unavailable" });
    expect(JSON.stringify(res.body)).not.toContain("invalid");
    expect(JSON.stringify(res.body)).not.toContain("badacz");
  });
});
