import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type MockRunProcessOptions = {
  localProcessSandbox?: {
    networkAllowlist?: string[];
    networkTrustedUrls?: string[];
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
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "claude"),
  runAdapterExecutionTargetProcess: vi.fn<
    (
      command: string,
      args: string[],
      cwd: string,
      env: Record<string, string>,
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
  resolveClaudeExecutionEngineForRun: async () => ({ engine: "cli", explicit: true }),
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

  afterEach(async () => {
    vi.clearAllMocks();
    if (typeof previousRuntimeApiUrl === "string") {
      process.env.PAPERCLIP_RUNTIME_API_URL = previousRuntimeApiUrl;
    } else {
      delete process.env.PAPERCLIP_RUNTIME_API_URL;
    }
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
});
