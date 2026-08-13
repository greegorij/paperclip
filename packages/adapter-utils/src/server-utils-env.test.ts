import { describe, expect, it } from "vitest";
import { buildAgentProcessEnv, sanitizeInheritedPaperclipEnv } from "./server-utils.js";
import {
  buildPaperclipBridgeCleanupCommand,
  resolvePaperclipBridgeRuntimeDir,
  resolvePaperclipBridgeUpstreamToken,
  rewritePaperclipRuntimeMcpServersForBridge,
} from "./execution-target.js";
import { authorizeSandboxCallbackBridgeRequestWithRoutes } from "./sandbox-callback-bridge.js";

describe("sanitizeInheritedPaperclipEnv", () => {
  it("drops host-only Paperclip service variables", () => {
    expect(sanitizeInheritedPaperclipEnv({
      PAPERCLIPAI_CMD: "node /missing/paperclipai/dist/index.js",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    })).toEqual({ PATH: "/usr/bin" });
  });

  it("inherits only OS identity while preserving explicitly resolved adapter values", () => {
    expect(buildAgentProcessEnv({ PAPERCLIP_RUN_ID: "run-1", CUSTOM_PROJECT_VALUE: "kept" }, {
      PATH: "/usr/bin",
      HOME: "/home/agent",
      LANG: "pl_PL.UTF-8",
      LC_ALL: "C",
      OPENAI_API_KEY: "server-openai-auth",
      ANTHROPIC_API_KEY: "server-anthropic-auth",
      SSH_AUTH_SOCK: "/run/server-ssh-agent.sock",
      DATABASE_URL: "postgresql://db-user:db-password@db/paperclip",
      PAPERCLIP_SECRETS_MASTER_KEY: "master-secret",
      BETTER_AUTH_SECRET: "signing-secret",
      AWS_SECRET_ACCESS_KEY: "infrastructure-secret",
      GOOGLE_API_KEY: "server-google-secret",
      JARVIS_API_KEY: "server-jarvis-secret",
      SMTP_PASSWORD: "mail-secret",
    })).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/agent",
      LANG: "pl_PL.UTF-8",
      LC_ALL: "C",
      PAPERCLIP_RUN_ID: "run-1",
      CUSTOM_PROJECT_VALUE: "kept",
    });
  });

  it("keeps Windows bootstrap variables without inheriting profile credentials", () => {
    expect(buildAgentProcessEnv({}, {
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".EXE;.CMD;.BAT;.COM",
      APPDATA: "C:\\Users\\svc\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\svc\\AppData\\Local",
      OPENAI_API_KEY: "host-provider-key",
      DATABASE_URL: "postgresql://host-db",
    })).toEqual({
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".EXE;.CMD;.BAT;.COM",
    });
  });
});

describe("remote Paperclip MCP bridge mapping", () => {
  const servers = [
    { name: "Paperclip", url: "http://host/api/mcp", token: "agent-jwt", connectionId: "paperclip-control-plane" },
    { name: "Vault", url: "http://host/api/tool-gateway/gateways/vault/mcp", token: "pcgw-vault", connectionId: "vault" },
  ];
  const bridge = {
    env: { PAPERCLIP_API_URL: "http://remote-bridge", PAPERCLIP_API_KEY: "bridge-token" },
    stop: async () => {},
  };

  it("rewrites mandatory and optional URLs to the bridge", () => {
    expect(rewritePaperclipRuntimeMcpServersForBridge(servers, bridge)).toEqual([
      { ...servers[0], url: "http://remote-bridge/api/mcp", token: "bridge-token" },
      { ...servers[1], url: "http://remote-bridge/api/tool-gateway/gateways/vault/mcp", token: "bridge-token" },
    ]);
  });

  it("selects the correct host-side credential for mandatory and optional paths", () => {
    expect(resolvePaperclipBridgeUpstreamToken("/api/mcp", servers, "fallback")).toBe("agent-jwt");
    expect(resolvePaperclipBridgeUpstreamToken("/api/tool-gateway/gateways/vault/mcp", servers, "fallback")).toBe("pcgw-vault");
  });

  it("round-trips every rewritten URL path to its original upstream credential", () => {
    const rewritten = rewritePaperclipRuntimeMcpServersForBridge(servers, bridge);
    expect(rewritten.map((server) => {
      const parsed = new URL(server.url);
      return resolvePaperclipBridgeUpstreamToken(`${parsed.pathname}${parsed.search}`, servers, "fallback");
    })).toEqual(["agent-jwt", "pcgw-vault"]);
  });

  it("allows only exact POST MCP bridge routes and rejects near misses", () => {
    expect(authorizeSandboxCallbackBridgeRequestWithRoutes({ method: "POST", path: "/api/mcp" })).toBeNull();
    expect(authorizeSandboxCallbackBridgeRequestWithRoutes({
      method: "POST",
      path: "/api/tool-gateway/gateways/vault/mcp",
    })).toBeNull();
    expect(authorizeSandboxCallbackBridgeRequestWithRoutes({ method: "GET", path: "/api/mcp" })).not.toBeNull();
    expect(authorizeSandboxCallbackBridgeRequestWithRoutes({
      method: "POST",
      path: "/api/tool-gateway/gateways/vault/mcp/extra",
    })).not.toBeNull();
    expect(authorizeSandboxCallbackBridgeRequestWithRoutes({
      method: "POST",
      path: "/api/tool-gateway/gateways/vault/delete",
    })).not.toBeNull();
  });
});

describe("per-run bridge directory safety", () => {
  it("isolates runs and quotes hostile remote paths literally for cleanup", () => {
    const first = resolvePaperclipBridgeRuntimeDir({
      remoteCwd: "/srv/work $(touch /tmp/pwned) `id`",
      adapterKey: "codex",
      runId: "run-one",
    });
    const second = resolvePaperclipBridgeRuntimeDir({
      remoteCwd: "/srv/work $(touch /tmp/pwned) `id`",
      adapterKey: "codex",
      runId: "run-two",
    });
    expect(first).not.toBe(second);
    expect(first).toContain("/runs/run-one/paperclip-bridge");
    const cleanup = buildPaperclipBridgeCleanupCommand(first);
    expect(cleanup).toBe(`rm -rf -- '${first}'`);
  });

  it("removes the exact owned run root without leaving a bridge parent residue", () => {
    const bridge = resolvePaperclipBridgeRuntimeDir({
      remoteCwd: "/srv/work",
      adapterKey: "claude",
      runId: "run-owned",
    });
    const cleanup = buildPaperclipBridgeCleanupCommand(bridge, { removeOwnedRunRoot: true });
    expect(cleanup).toContain("rm -rf -- '/srv/work/.paperclip-runtime/claude/runs/run-owned'");
    expect(cleanup).not.toContain("rm -rf -- '/srv/work/.paperclip-runtime/claude/runs/run-owned/paperclip-bridge'");
    expect(cleanup).toContain("[ -L '/srv/work/.paperclip-runtime/claude/runs/run-owned' ]");
  });

  it("refuses unsafe identities and broad cleanup targets", () => {
    expect(() => resolvePaperclipBridgeRuntimeDir({ remoteCwd: "/srv", adapterKey: "codex", runId: "../escape" }))
      .toThrow(/safe path segments/);
    expect(() => buildPaperclipBridgeCleanupCommand("/srv/.paperclip-runtime/codex"))
      .toThrow(/broad/);
  });
});
