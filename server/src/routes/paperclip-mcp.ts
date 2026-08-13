import { Router, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createPaperclipMcpServer, normalizeApiUrl } from "@paperclipai/mcp-server";
import { and, eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";

function bearerToken(req: Request): string | null {
  const value = req.header("authorization")?.trim() ?? "";
  return value.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || null;
}

function apiUrl(): string {
  const configured = process.env.PAPERCLIP_API_URL?.trim();
  if (!configured) throw new Error("PAPERCLIP_API_URL is required for the Paperclip MCP endpoint");
  return normalizeApiUrl(configured);
}

async function handlePaperclipMcp(db: Db, req: Request, res: Response): Promise<void> {
  if (req.actor.type !== "agent" || req.actor.source !== "agent_jwt" || !req.actor.runId) {
    res.status(401).json({ error: "Run-scoped agent JWT authentication is required" });
    return;
  }
  const companyId = req.actor.companyId;
  const agentId = req.actor.agentId;
  const runId = req.actor.runId;
  if (!companyId || !agentId) {
    res.status(401).json({ error: "Complete signed agent identity is required" });
    return;
  }
  const apiKey = bearerToken(req);
  if (!apiKey) {
    res.status(401).json({ error: "Bearer token is required" });
    return;
  }
  const activeRun = await db.select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.id, runId),
      eq(heartbeatRuns.companyId, companyId),
      eq(heartbeatRuns.agentId, agentId),
      eq(heartbeatRuns.status, "running"),
    ))
    .then((rows) => rows[0] ?? null);
  if (!activeRun) {
    res.status(401).json({ error: "An active matching heartbeat run is required" });
    return;
  }

  const { server } = createPaperclipMcpServer({
    apiUrl: apiUrl(),
    apiKey,
    companyId,
    agentId,
    runId,
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

export function paperclipMcpRoutes(db: Db) {
  const router = Router();
  router.post("/mcp", (req, res, next) => {
    void handlePaperclipMcp(db, req, res).catch(next);
  });
  return router;
}
