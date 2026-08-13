import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";
import { rewritePaperclipRuntimeMcpServersForBridge } from "@paperclipai/adapter-utils/execution-target";
import { identifyAcpRuntimeMcpServers, renderAcpRuntimeMcpServers } from "@paperclipai/adapter-utils/acpx-engine/execute";
import { cleanupPaperclipClaudeMcpRun, writePaperclipClaudeMcpConfig } from "../../../packages/adapters/claude-local/src/server/claude-config.js";
import { codexMcpBearerEnvVar, writeManagedCodexMcpConfig } from "../../../packages/adapters/codex-local/src/server/codex-home.js";
import { prepareOpenCodeRuntimeConfig } from "../../../packages/adapters/opencode-local/src/server/runtime-config.js";

const mandatory: AdapterRuntimeMcpServer = {
  name: "Paperclip", url: "http://control.example/api/mcp", token: "run-jwt",
  connectionId: "paperclip-control-plane",
};
const optional: AdapterRuntimeMcpServer = {
  name: "Vault", url: "http://control.example/api/tool-gateway/gateways/vault/mcp?connection=one",
  token: "pcgw-vault", connectionId: "vault-connection",
};
const canonicalIdentity = (servers: AdapterRuntimeMcpServer[]) =>
  servers.map(({ name, url, connectionId }) => ({ name, url, connectionId }));

describe("runtime MCP real renderer matrix", () => {
  const roots: string[] = [];
  afterEach(async () => {
    while (roots.length) await fs.rm(roots.pop()!, { recursive: true, force: true });
  });

  async function renderSet(servers: AdapterRuntimeMcpServer[], suffix: string) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `paperclip-mcp-matrix-${suffix}-`));
    roots.push(root);
    const claudeState = path.join(root, "claude");
    const claudePath = await writePaperclipClaudeMcpConfig({ stateDir: claudeState, runId: `run-${suffix}`, servers });
    const claude = JSON.parse(await fs.readFile(claudePath, "utf8")) as { mcpServers: Record<string, unknown> };

    const codexHome = path.join(root, "codex");
    const bearerEnv = Object.fromEntries(servers.map((server) => {
      const envName = codexMcpBearerEnvVar({ name: server.name, endpointPath: server.url });
      return [envName, server.token];
    }));
    await writeManagedCodexMcpConfig({
      codexHome,
      apiBaseUrl: "http://control.example/api",
      gateways: servers.map((server) => ({
        name: server.name,
        endpointPath: server.url,
        bearerToken: server.token,
        bearerTokenEnvVar: codexMcpBearerEnvVar({ name: server.name, endpointPath: server.url }),
      })),
    });
    const codex = await fs.readFile(path.join(codexHome, "config.toml"), "utf8");

    const opencode = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: path.join(root, "xdg") },
      config: { dangerouslySkipPermissions: false },
      runtimeMcpServers: servers,
    });
    const opencodeJson = JSON.parse(await fs.readFile(
      path.join(opencode.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8",
    )) as { mcp: Record<string, unknown> };

    return {
      root, claudeState, claude, codex, bearerEnv, opencode, opencodeJson,
      acp: renderAcpRuntimeMcpServers(servers),
      acpIdentity: identifyAcpRuntimeMcpServers(servers),
    };
  }

  it("renders mandatory-only and mandatory-plus-optional through every real renderer", async () => {
    for (const [suffix, servers] of [["zero", [mandatory]], ["optional", [mandatory, optional]]] as const) {
      const rendered = await renderSet([...servers], suffix);
      const names = servers.map((server) => server.name);
      expect(Object.keys(rendered.claude.mcpServers)).toEqual(names);
      expect(names.every((name) => rendered.codex.includes(`[mcp_servers."${name.toLowerCase()}"]`))).toBe(true);
      expect(rendered.codex).not.toContain("run-jwt");
      expect(rendered.codex).not.toContain("pcgw-vault");
      expect(Object.values(rendered.bearerEnv)).toEqual(servers.map((server) => server.token));
      expect(Object.keys(rendered.opencodeJson.mcp)).toEqual(names);
      expect(rendered.acp.map((entry) => entry.name)).toEqual(names);
      expect(rendered.acpIdentity).toEqual(canonicalIdentity([...servers]));
      await cleanupPaperclipClaudeMcpRun(rendered.claudeState, `run-${suffix}`);
      await rendered.opencode.cleanup();
    }
  });

  it("keeps canonical identity stable across Claude/Codex switching, token rotation, and bridge ports", () => {
    const original = [mandatory, optional];
    const rotated = original.map((server) => ({ ...server, token: `${server.token}-rotated` }));
    const firstBridge = rewritePaperclipRuntimeMcpServersForBridge(original, {
      env: { PAPERCLIP_API_URL: "http://bridge-one", PAPERCLIP_API_KEY: "bridge-one-token" },
      runLogTail: null, stop: async () => {},
    });
    const secondBridge = rewritePaperclipRuntimeMcpServersForBridge(original, {
      env: { PAPERCLIP_API_URL: "http://bridge-two", PAPERCLIP_API_KEY: "bridge-two-token" },
      runLogTail: null, stop: async () => {},
    });

    expect(canonicalIdentity(rotated)).toEqual(canonicalIdentity(original));
    expect(identifyAcpRuntimeMcpServers(original)).toEqual(canonicalIdentity(original));
    expect(firstBridge.map((server) => new URL(server.url).pathname + new URL(server.url).search)).toEqual([
      "/api/mcp", "/api/tool-gateway/gateways/vault/mcp?connection=one",
    ]);
    expect(secondBridge.map(({ name, connectionId }) => ({ name, connectionId }))).toEqual(
      firstBridge.map(({ name, connectionId }) => ({ name, connectionId })),
    );
    expect(codexMcpBearerEnvVar({ name: mandatory.name, endpointPath: mandatory.url }))
      .toBe(codexMcpBearerEnvVar({ name: mandatory.name, endpointPath: mandatory.url }));
  });
});
