import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SandboxManagedRuntimeAsset } from "@paperclipai/adapter-utils/sandbox-managed-runtime";

// Captured Codex `home` asset descriptor + the sandbox `auth.json` fixture the
// mocked runtime hands back during teardown. Mutated per-test so a single
// harness drives every round-trip case through the REAL `execute()` wiring.
const captured: { assets: SandboxManagedRuntimeAsset[] } = { assets: [] };
const sandboxAuthFixture: { bytes: Buffer } = { bytes: Buffer.from("{}") };
const REMOTE_RUNTIME_ROOT = "/remote/workspace/.paperclip-runtime/codex";

const {
  runChildProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
  prepareAdapterExecutionTargetRuntime,
  startAdapterExecutionTargetPaperclipBridge,
} = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    pid: 321,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "/usr/bin/codex"),
  prepareAdapterExecutionTargetRuntime: vi.fn(),
  startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => null),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    ensureCommandResolvable,
    resolveCommandForLogs,
    runChildProcess,
  };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    prepareAdapterExecutionTargetRuntime,
    startAdapterExecutionTargetPaperclipBridge,
  };
});

import { execute } from "./execute.js";

// Mirror the sandbox core's restore closure: capture the assets `execute()`
// declares, then during teardown invoke each asset's `restore` with an injected
// `readFile` (returns the sandbox fixture) and the remote asset dir. This drives
// the exact `restore` contribution the Codex adapter wires in production without
// needing a live sandbox.
prepareAdapterExecutionTargetRuntime.mockImplementation(async (input: { assets?: SandboxManagedRuntimeAsset[] }) => {
  captured.assets = input.assets ?? [];
  return {
    target: { kind: "remote", transport: "ssh" },
    workspaceRemoteDir: "/remote/workspace",
    runtimeRootDir: REMOTE_RUNTIME_ROOT,
    assetDirs: { home: `${REMOTE_RUNTIME_ROOT}/home` },
    restoreWorkspace: async () => {
      for (const asset of captured.assets) {
        if (!asset.restore) continue;
        await asset.restore({
          assetDir: `${REMOTE_RUNTIME_ROOT}/home`,
          readFile: async () => sandboxAuthFixture.bytes,
        });
      }
    },
  };
});

describe("codex execute — outbound auth copy-back restore contribution", () => {
  const cleanupDirs: string[] = [];
  let savedCodexHomeEnv: string | undefined;

  afterEach(async () => {
    vi.clearAllMocks();
    if (savedCodexHomeEnv === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = savedCodexHomeEnv;
    }
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  function subscriptionAuth(input: { accountId: string; lastRefresh?: string; marker: string }): string {
    return JSON.stringify(
      {
        tokens: {
          id_token: `id-token-${input.marker}`,
          access_token: `access-token-${input.marker}`,
          refresh_token: `refresh-token-${input.marker}`,
          account_id: input.accountId,
        },
        ...(input.lastRefresh ? { last_refresh: input.lastRefresh } : {}),
      },
      null,
      2,
    );
  }

  async function runTeardown(input: {
    sandboxAuth: string;
    sharedHostAuth: string;
    externalOverrideAuth?: string;
  }): Promise<{
    finalSharedHostAuth: string;
    finalSharedHostMode: number;
    finalConfiguredHomeAuth: string;
    finalConfiguredHomeMode: number;
  }> {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-copyback-e2e-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    // The shared host home is what `resolveSharedCodexHomeDir` returns
    // (process.env.CODEX_HOME) — the copy-back target. Point it at a tmp dir so
    // the round-trip never touches the real host credential.
    const sharedHostHome = path.join(rootDir, "shared-codex-home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(sharedHostHome, { recursive: true });
    const sharedHostAuthPath = path.join(sharedHostHome, "auth.json");
    await writeFile(sharedHostAuthPath, input.sharedHostAuth, { mode: 0o600 });
    const configuredCodexHome =
      input.externalOverrideAuth == null ? sharedHostHome : path.join(rootDir, "external-codex-home");
    if (input.externalOverrideAuth != null) {
      await mkdir(configuredCodexHome, { recursive: true });
      await writeFile(path.join(configuredCodexHome, "auth.json"), input.externalOverrideAuth, { mode: 0o600 });
    }

    savedCodexHomeEnv = process.env.CODEX_HOME;
    process.env.CODEX_HOME = sharedHostHome;
    sandboxAuthFixture.bytes = Buffer.from(input.sandboxAuth, "utf8");

    await execute({
      runId: "run-copyback-e2e",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: "codex",
        engine: "cli",
        // External CODEX_HOME (outside the managed company tree) so no managed
        // seeding rewrites auth.json before teardown.
        env: { CODEX_HOME: configuredCodexHome },
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
    });

    return {
      finalSharedHostAuth: await readFile(sharedHostAuthPath, "utf8"),
      finalSharedHostMode: (await lstat(sharedHostAuthPath)).mode & 0o777,
      finalConfiguredHomeAuth: await readFile(path.join(configuredCodexHome, "auth.json"), "utf8"),
      finalConfiguredHomeMode: (await lstat(path.join(configuredCodexHome, "auth.json"))).mode & 0o777,
    };
  }

  it("declares a Codex `home` asset carrying both inbound provision and outbound restore contributions", async () => {
    await runTeardown({
      sandboxAuth: subscriptionAuth({ accountId: "acct", lastRefresh: "2026-07-09T01:00:00Z", marker: "s" }),
      sharedHostAuth: subscriptionAuth({ accountId: "acct", lastRefresh: "2026-07-09T02:00:00Z", marker: "h" }),
    });

    const homeAsset = captured.assets.find((asset) => asset.key === "home");
    expect(homeAsset).toBeDefined();
    expect(homeAsset?.provision).toBeTruthy();
    expect(typeof homeAsset?.restore).toBe("function");
  });

  it("round-trips a strictly-newer same-identity sandbox auth.json to the shared host at 0600 on teardown", async () => {
    const sandboxAuth = subscriptionAuth({
      accountId: "acct-same",
      lastRefresh: "2026-07-09T02:00:00Z",
      marker: "sandbox-newer",
    });
    const sharedHostAuth = subscriptionAuth({
      accountId: "acct-same",
      lastRefresh: "2026-07-09T01:00:00Z",
      marker: "host-older",
    });

    const result = await runTeardown({ sandboxAuth, sharedHostAuth });

    expect(result.finalConfiguredHomeAuth).toBe(sandboxAuth);
    expect(result.finalConfiguredHomeMode).toBe(0o600);
    expect(result.finalSharedHostAuth).toBe(sandboxAuth);
    expect(result.finalSharedHostMode).toBe(0o600);
  });

  it("keeps the host auth.json when the sandbox copy is a tie or older on teardown", async () => {
    const cases = [
      {
        name: "tie",
        sandboxAuth: subscriptionAuth({ accountId: "acct-same", lastRefresh: "2026-07-09T02:00:00Z", marker: "s-tie" }),
        sharedHostAuth: subscriptionAuth({ accountId: "acct-same", lastRefresh: "2026-07-09T02:00:00Z", marker: "h-tie" }),
      },
      {
        name: "older",
        sandboxAuth: subscriptionAuth({ accountId: "acct-same", lastRefresh: "2026-07-09T01:00:00Z", marker: "s-old" }),
        sharedHostAuth: subscriptionAuth({ accountId: "acct-same", lastRefresh: "2026-07-09T02:00:00Z", marker: "h-new" }),
      },
    ];

    for (const entry of cases) {
      const result = await runTeardown({ sandboxAuth: entry.sandboxAuth, sharedHostAuth: entry.sharedHostAuth });
      expect(result.finalConfiguredHomeAuth, entry.name).toBe(entry.sharedHostAuth);
      expect(result.finalConfiguredHomeMode, entry.name).toBe(0o600);
      expect(result.finalSharedHostAuth, entry.name).toBe(entry.sharedHostAuth);
      expect(result.finalSharedHostMode, entry.name).toBe(0o600);
    }
  });

  it("for external CODEX_HOME override copies back into override home and leaves shared host auth unchanged", async () => {
    const sandboxAuth = subscriptionAuth({
      accountId: "acct-external",
      lastRefresh: "2026-07-10T03:00:00Z",
      marker: "sandbox-newer",
    });
    const sharedHostAuth = subscriptionAuth({
      accountId: "acct-shared",
      lastRefresh: "2026-07-10T02:30:00Z",
      marker: "shared-should-stay",
    });
    const externalOverrideAuth = subscriptionAuth({
      accountId: "acct-external",
      lastRefresh: "2026-07-10T02:00:00Z",
      marker: "external-older",
    });

    const result = await runTeardown({
      sandboxAuth,
      sharedHostAuth,
      externalOverrideAuth,
    });

    expect(result.finalConfiguredHomeAuth).toBe(sandboxAuth);
    expect(result.finalConfiguredHomeMode).toBe(0o600);
    expect(result.finalSharedHostAuth).toBe(sharedHostAuth);
    expect(result.finalSharedHostMode).toBe(0o600);
  });
});

describe("codex execute — local filesystem sandbox staged CODEX_HOME", () => {
  const cleanupDirs: string[] = [];
  let savedCodexHomeEnv: string | undefined;
  let savedPaperclipHomeEnv: string | undefined;
  let savedPaperclipInstanceIdEnv: string | undefined;

  afterEach(async () => {
    vi.clearAllMocks();
    if (savedCodexHomeEnv === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedCodexHomeEnv;
    if (savedPaperclipHomeEnv === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = savedPaperclipHomeEnv;
    if (savedPaperclipInstanceIdEnv === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = savedPaperclipInstanceIdEnv;
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  function subscriptionAuth(input: { accountId: string; lastRefresh: string; marker: string }): string {
    return JSON.stringify(
      {
        tokens: {
          id_token: `id-token-${input.marker}`,
          access_token: `access-token-${input.marker}`,
          refresh_token: `refresh-token-${input.marker}`,
          account_id: input.accountId,
        },
        last_refresh: input.lastRefresh,
      },
      null,
      2,
    );
  }

  async function setupLocalSandboxFixture(input: { hostAuth: string }) {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-local-bwrap-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const sharedHostHome = path.join(rootDir, "shared-codex-home");
    const paperclipHome = path.join(rootDir, "paperclip-home");
    const managedCodexHome = path.join(
      paperclipHome,
      "instances",
      "default",
      "companies",
      "company-1",
      "codex-home",
    );
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(sharedHostHome, { recursive: true });
    const hostAuthPath = path.join(sharedHostHome, "auth.json");
    await writeFile(hostAuthPath, input.hostAuth, { mode: 0o600 });

    savedCodexHomeEnv = process.env.CODEX_HOME;
    savedPaperclipHomeEnv = process.env.PAPERCLIP_HOME;
    savedPaperclipInstanceIdEnv = process.env.PAPERCLIP_INSTANCE_ID;
    process.env.CODEX_HOME = sharedHostHome;
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "default";

    return { workspaceDir, sharedHostHome, managedCodexHome, hostAuthPath };
  }

  it("stages a dereferenced auth.json for local bubblewrap and never mounts the shared host home", async () => {
    const hostAuth = subscriptionAuth({
      accountId: "acct-same",
      lastRefresh: "2026-07-30T10:00:00Z",
      marker: "host-old",
    });
    const sandboxNewerAuth = subscriptionAuth({
      accountId: "acct-same",
      lastRefresh: "2026-07-30T10:05:00Z",
      marker: "sandbox-new",
    });
    const fixture = await setupLocalSandboxFixture({ hostAuth });
    let stagedHomePath: string | null = null;

    runChildProcess.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[3] as {
        env: Record<string, string>;
        onLogBackpressure?: "pause" | "queue";
        localProcessSandbox?: {
          homeDir?: string | null;
          filesystemWorkspaceAccess?: "ro" | "rw" | null;
          managedPaths?: Array<{ path: string; access: "ro" | "rw" }>;
        } | null;
      };
      stagedHomePath = options.localProcessSandbox?.homeDir ?? null;
      expect(options.onLogBackpressure).toBe("queue");
      expect(stagedHomePath).toBeTruthy();
      expect(stagedHomePath).toContain("paperclip-codex-home-sync-");
      expect(options.env.CODEX_HOME).toBe(stagedHomePath);
      const managedPaths = options.localProcessSandbox?.managedPaths ?? [];
      expect(options.localProcessSandbox?.filesystemWorkspaceAccess).toBe("ro");
      expect(managedPaths).toEqual([{ path: stagedHomePath as string, access: "rw" }]);
      expect(managedPaths.some((entry) => entry.path === fixture.sharedHostHome)).toBe(false);
      expect(managedPaths.some((entry) => entry.path === fixture.managedCodexHome)).toBe(false);
      const stagedAuthPath = path.join(stagedHomePath as string, "auth.json");
      const stagedAuthStat = await lstat(stagedAuthPath);
      expect(stagedAuthStat.isSymbolicLink()).toBe(false);
      expect(await readFile(stagedAuthPath, "utf8")).toBe(hostAuth);
      await writeFile(stagedAuthPath, sandboxNewerAuth, { mode: 0o600 });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        pid: 321,
        startedAt: new Date().toISOString(),
      };
    });

    await execute({
      runId: "run-local-bwrap-stage",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: "codex",
        cwd: fixture.workspaceDir,
        filesystemScope: "workspace",
        filesystemWorkspaceAccess: "ro",
        env: { CODEX_HOME: fixture.managedCodexHome },
      },
      context: {
        paperclipWorkspace: {
          cwd: fixture.workspaceDir,
          source: "project_primary",
        },
      },
      onLog: async () => {},
    });

    expect(await readFile(fixture.hostAuthPath, "utf8")).toBe(sandboxNewerAuth);
    expect(stagedHomePath).toBeTruthy();
    if (!stagedHomePath) throw new Error("Expected staged CODEX_HOME path to be captured.");
    await expect(lstat(stagedHomePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("copies back before cleanup and still removes staged home when the local sandbox run errors", async () => {
    const hostAuth = subscriptionAuth({
      accountId: "acct-same",
      lastRefresh: "2026-07-30T10:00:00Z",
      marker: "host-old",
    });
    const sandboxNewerAuth = subscriptionAuth({
      accountId: "acct-same",
      lastRefresh: "2026-07-30T10:06:00Z",
      marker: "sandbox-newer-on-error",
    });
    const fixture = await setupLocalSandboxFixture({ hostAuth });
    let stagedHomePath: string | null = null;

    runChildProcess.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[3] as {
        localProcessSandbox?: {
          homeDir?: string | null;
        } | null;
      };
      stagedHomePath = options.localProcessSandbox?.homeDir ?? null;
      if (!stagedHomePath) throw new Error("Expected staged CODEX_HOME path before write.");
      await writeFile(path.join(stagedHomePath, "auth.json"), sandboxNewerAuth, { mode: 0o600 });
      throw new Error("local sandbox spawn failed");
    });

    await expect(
      execute({
        runId: "run-local-bwrap-error",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "CodexCoder",
          adapterType: "codex_local",
          adapterConfig: {},
        },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command: "codex",
          cwd: fixture.workspaceDir,
          filesystemScope: "workspace",
          filesystemWorkspaceAccess: "ro",
          env: { CODEX_HOME: fixture.managedCodexHome },
        },
        context: {
          paperclipWorkspace: {
            cwd: fixture.workspaceDir,
            source: "project_primary",
          },
        },
        onLog: async () => {},
      }),
    ).rejects.toThrow("local sandbox spawn failed");

    expect(await readFile(fixture.hostAuthPath, "utf8")).toBe(sandboxNewerAuth);
    expect(stagedHomePath).toBeTruthy();
    if (!stagedHomePath) throw new Error("Expected staged CODEX_HOME path to be captured.");
    await expect(lstat(stagedHomePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
