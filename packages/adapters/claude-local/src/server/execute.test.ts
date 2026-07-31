import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type MockRunProcessOptions = {
  env?: Record<string, string>;
  localProcessSandbox?: {
    workspaceDir?: string;
    filesystemScope?: string | null;
    filesystemWorkspaceAccess?: "ro" | "rw" | null;
    managedPaths?: Array<{ path: string; access: "ro" | "rw" }>;
    extraPaths?: unknown[];
    networkAllowlist?: string[];
    networkTrustedUrls?: string[];
    networkScope?: string | null;
    homeDir?: string | null;
  } | null;
};

type MockRunProcessResult = {
  exitCode: number;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  pid: number;
  startedAt: string;
};

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  resolveClaudeExecutionEngineForRun,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "claude"),
  resolveClaudeExecutionEngineForRun: vi.fn(async (ctx: { config?: Record<string, unknown> }) =>
    ctx?.config?.engine === "acp"
      ? { engine: "acp" as const, explicit: true }
      : { engine: "cli" as const, explicit: true },
  ),
  runAdapterExecutionTargetProcess: vi.fn<
    (
      runId: string,
      target: unknown,
      command: string,
      args: string[],
      options?: MockRunProcessOptions,
    ) => Promise<MockRunProcessResult>
  >(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
      JSON.stringify({
        type: "assistant",
        session_id: "claude-session-1",
        message: { content: [{ type: "text", text: "hello" }] },
      }),
      JSON.stringify({
        type: "result",
        session_id: "claude-session-1",
        result: "hello",
        usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
      }),
    ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
}));

vi.mock("./acp.js", () => ({
  createClaudeAcpExecutor: () => vi.fn(async () => {
    throw new Error("ACP should not run in CLI test.");
  }),
  formatClaudeAcpFallbackMessage: (reason: string) => reason,
  resolveClaudeExecutionEngineForRun,
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable,
    ensureAdapterExecutionTargetRuntimeCommandInstalled,
    resolveAdapterExecutionTargetCommandForLogs,
    runAdapterExecutionTargetProcess,
  };
});

import { execute } from "./execute.js";

describe("claude local sandbox network trusted urls", () => {
  const cleanupDirs: string[] = [];
  let previousRuntimeApiUrl: string | undefined;
  let previousApiKey: string | undefined;

  afterEach(async () => {
    vi.clearAllMocks();
    if (typeof previousRuntimeApiUrl === "string") {
      process.env.PAPERCLIP_RUNTIME_API_URL = previousRuntimeApiUrl;
    } else {
      delete process.env.PAPERCLIP_RUNTIME_API_URL;
    }
    previousRuntimeApiUrl = undefined;
    if (typeof previousApiKey === "string") {
      process.env.PAPERCLIP_API_KEY = previousApiKey;
    } else {
      delete process.env.PAPERCLIP_API_KEY;
    }
    previousApiKey = undefined;
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("trusts Paperclip API and runtime MCP URLs without trusting unrelated hosts", async () => {
    previousRuntimeApiUrl = process.env.PAPERCLIP_RUNTIME_API_URL;
    process.env.PAPERCLIP_RUNTIME_API_URL = "http://paperclip.internal:4310/api";
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-local-network-"));
    cleanupDirs.push(workspaceDir);

    await execute({
      runId: "run-local-network-sandbox",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "claude",
        cwd: workspaceDir,
        networkScope: "allowlist",
        networkAllowlist: ["api.anthropic.com"],
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      runtimeMcp: {
        getServers: () => [
          {
            name: "runtime-mcp",
            url: "https://mcp.runtime.example:8443/gateway",
            token: "token-1",
            connectionId: "connection-1",
          },
          {
            name: "runtime-mcp-invalid",
            url: "not-a-url",
            token: "token-2",
            connectionId: "connection-2",
          },
        ],
      },
      onLog: async () => {},
    });

    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    const processOptions = runAdapterExecutionTargetProcess.mock.calls[0]?.[4];

    expect(processOptions?.localProcessSandbox?.networkAllowlist).toEqual(["api.anthropic.com"]);
    expect(processOptions?.localProcessSandbox?.networkTrustedUrls).toEqual([
      "http://paperclip.internal:4310/api",
      "https://mcp.runtime.example:8443/gateway",
    ]);
    expect(processOptions?.localProcessSandbox?.networkTrustedUrls).not.toContain("https://outside.example");
    expect(processOptions?.localProcessSandbox?.networkTrustedUrls).not.toContain("not-a-url");
  });

  it("uses an isolated read-only shadow sandbox without Paperclip credentials or MCP", async () => {
    previousRuntimeApiUrl = process.env.PAPERCLIP_RUNTIME_API_URL;
    previousApiKey = process.env.PAPERCLIP_API_KEY;
    process.env.PAPERCLIP_RUNTIME_API_URL = "http://paperclip.internal:4310/api";
    process.env.PAPERCLIP_API_KEY = "inherited-paperclip-secret";

    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-shadow-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const claudeConfigDir = path.join(rootDir, "claude-config");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(claudeConfigDir, { recursive: true });
    await writeFile(path.join(claudeConfigDir, ".credentials.json"), JSON.stringify({ key: "cred" }), {
      mode: 0o600,
    });
    await writeFile(path.join(claudeConfigDir, "settings.json"), JSON.stringify({ theme: "dark" }), {
      mode: 0o600,
    });

    let disposableConfigDir: string | null = null;
    const getServers = vi.fn(() => [
      {
        name: "runtime-mcp",
        url: "https://mcp.runtime.example:8443/gateway",
        token: "token-1",
        connectionId: "connection-1",
      },
    ]);

    runAdapterExecutionTargetProcess.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[4] as MockRunProcessOptions;
      const sandbox = options.localProcessSandbox;
      disposableConfigDir = options.env?.CLAUDE_CONFIG_DIR ?? null;
      expect(disposableConfigDir).toBeTruthy();
      expect(disposableConfigDir).not.toBe(claudeConfigDir);
      expect(disposableConfigDir).toContain("paperclip-claude-disposable-");
      expect(Object.keys(options.env ?? {}).filter((key) => /^PAPERCLIP_/.test(key))).toEqual([]);
      expect(options.env?.CLAUDE_CONFIG_DIR).toBe(disposableConfigDir);
      expect(sandbox?.workspaceDir).toBe(workspaceDir);
      expect(sandbox?.filesystemScope).toBe("workspace");
      expect(sandbox?.filesystemWorkspaceAccess).toBe("ro");
      expect(sandbox?.managedPaths).toEqual([
        { path: disposableConfigDir, access: "rw" },
        expect.objectContaining({ access: "ro" }),
      ]);
      expect(sandbox?.extraPaths).toEqual([]);
      expect(sandbox?.networkScope).toBe("allowlist");
      expect(sandbox?.networkAllowlist).toEqual(["api.anthropic.com"]);
      expect(sandbox?.networkTrustedUrls).toEqual([]);
      expect((args[3] as string[])).not.toContain("--mcp-config");
      await writeFile(path.join(disposableConfigDir as string, ".credentials.json"), "sandbox-mutated");
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: [
          JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
          JSON.stringify({
            type: "result",
            session_id: "claude-session-1",
            result: "hello",
            usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
          }),
        ].join("\n"),
        stderr: "",
        pid: 321,
        startedAt: new Date().toISOString(),
      };
    });

    await execute({
      runId: "run-shadow-readonly",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "11111111-1111-1111-1111-111111111111",
        sessionParams: {
          sessionId: "11111111-1111-1111-1111-111111111111",
          cwd: workspaceDir,
        },
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "claude",
        engine: "cli",
        cwd: workspaceDir,
        shadowReadOnly: true,
        networkScope: "allowlist",
        networkAllowlist: ["api.anthropic.com"],
        env: { CLAUDE_CONFIG_DIR: claudeConfigDir },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      authToken: "paperclip-run-token",
      runtimeMcp: { getServers },
      onLog: async () => {},
    });

    expect(getServers).not.toHaveBeenCalled();
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    const commandArgs = runAdapterExecutionTargetProcess.mock.calls[0]?.[3] as string[];
    expect(commandArgs).not.toContain("--mcp-config");
    expect(commandArgs).not.toContain("--resume");
    expect(await readFile(path.join(claudeConfigDir, ".credentials.json"), "utf8")).not.toBe("sandbox-mutated");
    if (!disposableConfigDir) throw new Error("Expected disposable Claude config dir.");
    await expect(lstat(disposableConfigDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes disposable Claude config when shadow process launch rejects", async () => {
    previousApiKey = process.env.PAPERCLIP_API_KEY;
    process.env.PAPERCLIP_API_KEY = "inherited-paperclip-secret";

    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-shadow-launch-reject-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const claudeConfigDir = path.join(rootDir, "claude-config");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(claudeConfigDir, { recursive: true });
    const originalCredentials = JSON.stringify({ key: "cred" });
    await writeFile(path.join(claudeConfigDir, ".credentials.json"), originalCredentials, {
      mode: 0o600,
    });
    await writeFile(path.join(claudeConfigDir, "settings.json"), JSON.stringify({ theme: "dark" }), {
      mode: 0o600,
    });

    let disposableConfigDir: string | null = null;
    runAdapterExecutionTargetProcess.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[4] as MockRunProcessOptions;
      disposableConfigDir = options.env?.CLAUDE_CONFIG_DIR ?? null;
      expect(disposableConfigDir).toBeTruthy();
      expect(disposableConfigDir).not.toBe(claudeConfigDir);
      throw new Error("spawn failed: simulated launch rejection");
    });

    await expect(
      execute({
        runId: "run-shadow-launch-reject",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Claude Coder",
          adapterType: "claude_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: "claude",
          engine: "cli",
          cwd: workspaceDir,
          shadowReadOnly: true,
          networkScope: "allowlist",
          networkAllowlist: ["api.anthropic.com"],
          env: { CLAUDE_CONFIG_DIR: claudeConfigDir },
        },
        context: {
          paperclipWorkspace: {
            cwd: workspaceDir,
            source: "project_primary",
          },
        },
        authToken: "paperclip-run-token",
        onLog: async () => {},
      }),
    ).rejects.toThrow("spawn failed: simulated launch rejection");

    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    expect(await readFile(path.join(claudeConfigDir, ".credentials.json"), "utf8")).toBe(originalCredentials);
    if (!disposableConfigDir) throw new Error("Expected disposable Claude config dir.");
    await expect(lstat(disposableConfigDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unsafe shadow configuration before spawn", async () => {
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-shadow-reject-"));
    cleanupDirs.push(workspaceDir);

    await expect(
      execute({
        runId: "run-shadow-reject",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Claude Coder",
          adapterType: "claude_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: "claude",
          engine: "cli",
          cwd: workspaceDir,
          shadowReadOnly: true,
          networkScope: "allowlist",
          networkAllowlist: [],
        },
        context: {
          paperclipWorkspace: {
            cwd: workspaceDir,
            source: "project_primary",
          },
        },
        onLog: async () => {},
      }),
    ).rejects.toThrow("nonempty networkAllowlist");
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  it("rejects ACP shadow configuration before spawn", async () => {
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-shadow-reject-acp-"));
    cleanupDirs.push(workspaceDir);

    await expect(
      execute({
        runId: "run-shadow-reject-acp",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Claude Coder",
          adapterType: "claude_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: "claude",
          engine: "acp",
          cwd: workspaceDir,
          shadowReadOnly: true,
          networkScope: "allowlist",
          networkAllowlist: ["api.anthropic.com"],
        },
        context: {
          paperclipWorkspace: {
            cwd: workspaceDir,
            source: "project_primary",
          },
        },
        onLog: async () => {},
      }),
    ).rejects.toThrow("ACP is not permitted");
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  it("rejects remote shadow configuration before spawn", async () => {
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-shadow-reject-remote-"));
    cleanupDirs.push(workspaceDir);

    await expect(
      execute({
        runId: "run-shadow-reject-remote",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Claude Coder",
          adapterType: "claude_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: "claude",
          engine: "cli",
          cwd: workspaceDir,
          shadowReadOnly: true,
          networkScope: "allowlist",
          networkAllowlist: ["api.anthropic.com"],
        },
        context: {
          paperclipWorkspace: {
            cwd: workspaceDir,
            source: "project_primary",
          },
        },
        executionTransport: {
          remoteExecution: {
            host: "127.0.0.1",
            port: 2222,
            username: "fixture",
            remoteWorkspacePath: "/remote/workspace",
            remoteCwd: "/remote/workspace",
            privateKey: "PRIVATE KEY",
            knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
            strictHostKeyChecking: true,
          },
        },
        onLog: async () => {},
      }),
    ).rejects.toThrow("remote execution is not permitted");
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  it("rejects filesystemExtraPaths shadow configuration before spawn", async () => {
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-shadow-reject-extra-"));
    cleanupDirs.push(workspaceDir);

    await expect(
      execute({
        runId: "run-shadow-reject-extra",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Claude Coder",
          adapterType: "claude_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: "claude",
          engine: "cli",
          cwd: workspaceDir,
          shadowReadOnly: true,
          networkScope: "allowlist",
          networkAllowlist: ["api.anthropic.com"],
          filesystemExtraPaths: ["/tmp"],
        },
        context: {
          paperclipWorkspace: {
            cwd: workspaceDir,
            source: "project_primary",
          },
        },
        onLog: async () => {},
      }),
    ).rejects.toThrow("filesystemExtraPaths");
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });
});
