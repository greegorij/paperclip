import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentApiKeys,
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import { createApp } from "../app.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres Paperclip MCP route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function expiredAgentJwt(input: { secret: string; companyId: string; agentId: string; runId: string }): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    sub: input.agentId,
    company_id: input.companyId,
    adapter_type: "codex_local",
    run_id: input.runId,
    iat: now - 120,
    exp: now - 60,
    iss: "paperclip",
    aud: "paperclip-api",
    instance_id: "default",
  })).toString("base64url");
  const signingKey = createHmac("sha256", input.secret)
    .update(`jwt:default:${input.companyId}`)
    .digest("hex");
  const signature = createHmac("sha256", signingKey).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

async function mcpRequest(baseUrl: string, token: string, runId: string | null, body: unknown) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  };
  if (runId) headers["X-Paperclip-Run-Id"] = runId;
  const response = await fetch(`${baseUrl}/api/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const responseBody = await response.json().catch(() => null) as Record<string, unknown> | null;
  return { status: response.status, body: responseBody };
}

describeEmbeddedPostgres("Paperclip MCP route through createApp, actor middleware, and Postgres", () => {
  const secret = "paperclip-mcp-route-integration-secret";
  const companyId = randomUUID();
  const agentId = randomUUID();
  const otherAgentId = randomUUID();
  const activeRunId = randomUUID();
  const finishedRunId = randomUUID();
  const mismatchedRunId = randomUUID();
  const longLivedKey = "pcp_test_long_lived_agent_key";
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let storageRoot = "";
  let server: import("node:http").Server | null = null;
  let baseUrl = "";
  let previousSecret: string | undefined;
  let previousApiUrl: string | undefined;
  let previousInstanceId: string | undefined;

  beforeAll(async () => {
    previousSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    previousApiUrl = process.env.PAPERCLIP_API_URL;
    previousInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = secret;
    process.env.PAPERCLIP_INSTANCE_ID = "default";

    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mcp-route-");
    const db = createDb(tempDb.connectionString);
    storageRoot = await mkdtemp(path.join(tmpdir(), "paperclip-mcp-storage-"));

    await db.insert(companies).values({
      id: companyId,
      name: "MCP integration company",
      issuePrefix: `M${companyId.replace(/-/g, "").slice(0, 7).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "MCP agent",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId,
        name: "Other agent",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(heartbeatRuns).values([
      { id: activeRunId, companyId, agentId, status: "running", invocationSource: "on_demand" },
      { id: finishedRunId, companyId, agentId, status: "succeeded", invocationSource: "on_demand" },
      { id: mismatchedRunId, companyId, agentId: otherAgentId, status: "running", invocationSource: "on_demand" },
    ]);
    await db.insert(agentApiKeys).values({
      companyId,
      agentId,
      name: "long lived test key",
      keyHash: hashToken(longLivedKey),
      responsibleUserId: "integration-user",
    });

    const app = await createApp(db, {
      uiMode: "none",
      serverPort: 0,
      storageService: createStorageService(createLocalDiskStorageProvider(storageRoot)),
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      allowedHostnames: [],
      bindHost: "127.0.0.1",
      authReady: true,
      companyDeletionEnabled: false,
      decisionServiceOptions: { wakeOriginAgent: async () => undefined },
      resolveSession: async () => null,
      managedPluginAutoInstall: [],
    });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server!.once("listening", resolve);
      server!.once("error", reject);
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    process.env.PAPERCLIP_API_URL = baseUrl;
  }, 60_000);

  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    await tempDb?.cleanup();
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
    if (previousSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = previousSecret;
    if (previousApiUrl === undefined) delete process.env.PAPERCLIP_API_URL;
    else process.env.PAPERCLIP_API_URL = previousApiUrl;
    if (previousInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = previousInstanceId;
  });

  it("lists and calls a real control-plane tool for an active signed run", async () => {
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", activeRunId, "integration-user");
    expect(token).not.toBeNull();
    const listed = await mcpRequest(baseUrl, token!, activeRunId, {
      jsonrpc: "2.0", id: 1, method: "tools/list", params: {},
    });
    expect(listed.status).toBe(200);
    const tools = ((listed.body?.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? []);
    expect(tools.map((tool) => tool.name)).toContain("paperclipMe");

    const called = await mcpRequest(baseUrl, token!, activeRunId, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "paperclipMe", arguments: {} },
    });
    expect(called.status).toBe(200);
    expect(JSON.stringify(called.body)).toContain(agentId);
  });

  it("renews an expired active-run JWT and rejects inactive, mismatched, long-lived, and spoofed credentials", async () => {
    const finishedToken = createLocalAgentJwt(agentId, companyId, "codex_local", finishedRunId, "integration-user")!;
    const mismatchToken = createLocalAgentJwt(agentId, companyId, "codex_local", mismatchedRunId, "integration-user")!;
    const activeToken = createLocalAgentJwt(agentId, companyId, "codex_local", activeRunId, "integration-user")!;
    const expiredToken = expiredAgentJwt({ secret, companyId, agentId, runId: activeRunId });
    const listBody = { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} };

    expect((await mcpRequest(baseUrl, finishedToken, finishedRunId, listBody)).status).toBe(401);
    expect((await mcpRequest(baseUrl, mismatchToken, mismatchedRunId, listBody)).status).toBe(401);
    expect((await mcpRequest(baseUrl, longLivedKey, activeRunId, listBody)).status).toBe(401);
    const renewed = await mcpRequest(baseUrl, expiredToken, activeRunId, listBody);
    expect(renewed.status).toBe(200);
    expect(JSON.stringify(renewed.body)).toContain("paperclipMe");
    expect((await mcpRequest(baseUrl, activeToken, finishedRunId, listBody)).status).toBe(422);
  });
});
