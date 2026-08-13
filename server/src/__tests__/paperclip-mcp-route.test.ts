import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { paperclipMcpRoutes } from "../routes/paperclip-mcp.js";
import type { Db } from "@paperclipai/db";
import { normalizeApiUrl } from "@paperclipai/mcp-server";

describe("mandatory Paperclip MCP route", () => {
  const originalApiUrl = process.env.PAPERCLIP_API_URL;
  beforeEach(() => { process.env.PAPERCLIP_API_URL = "http://127.0.0.1:3100"; });
  afterEach(() => {
    if (originalApiUrl === undefined) delete process.env.PAPERCLIP_API_URL;
    else process.env.PAPERCLIP_API_URL = originalApiUrl;
  });

  it("normalizes an origin runtime URL to the canonical API base used by tool calls", () => {
    expect(normalizeApiUrl("http://127.0.0.1:3100")).toBe("http://127.0.0.1:3100/api");
  });

  function app(actor: Record<string, unknown>, activeRun = true) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    const db = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve(activeRun ? [{ id: actor.runId }] : []),
        }),
      }),
    } as unknown as Db;
    instance.use("/api", paperclipMcpRoutes(db));
    return instance;
  }

  it("rejects callers that are not authenticated agents", async () => {
    await request(app({ type: "none", source: "none" }))
      .post("/api/mcp")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
      .expect(401);
  });

  it("rejects long-lived agent keys and JWTs without an active matching run", async () => {
    const base = {
      type: "agent",
      agentId: "11111111-1111-4111-8111-111111111111",
      companyId: "22222222-2222-4222-8222-222222222222",
      runId: "33333333-3333-4333-8333-333333333333",
    };
    await request(app({ ...base, source: "agent_key" }))
      .post("/api/mcp").set("Authorization", "Bearer long-lived-key")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }).expect(401);
    await request(app({ ...base, source: "agent_jwt" }, false))
      .post("/api/mcp").set("Authorization", "Bearer expired-or-finished-run")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }).expect(401);
  });

  it("lists real Paperclip control-plane tools without any gateway record", async () => {
    const response = await request(app({
      type: "agent",
      source: "agent_jwt",
      agentId: "11111111-1111-4111-8111-111111111111",
      companyId: "22222222-2222-4222-8222-222222222222",
      runId: "33333333-3333-4333-8333-333333333333",
    }))
      .post("/api/mcp")
      .set("Authorization", "Bearer run-scoped-agent-token")
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
      .expect(200);

    const tools = response.body?.result?.tools ?? [];
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining([
      "paperclipMe",
      "paperclipGetHeartbeatContext",
      "paperclipUpdateIssue",
      "paperclipAddComment",
    ]));
  });
});
