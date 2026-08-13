import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  runSshCommand,
  syncDirectoryToSsh,
} = vi.hoisted(() => ({
  prepareWorkspaceForSshExecution: vi.fn(async () => ({ gitBacked: false })),
  restoreWorkspaceFromSshExecution: vi.fn(async () => undefined),
  runSshCommand: vi.fn(async () => ({
    stdout: Buffer.from('{"token":"remote"}\n').toString("base64"),
    stderr: "",
  })),
  syncDirectoryToSsh: vi.fn(async (_input: { localDir: string }) => undefined),
}));

vi.mock("./ssh.js", () => ({
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  runSshCommand,
  syncDirectoryToSsh,
}));

import { buildRemoteRunCleanupCommand, prepareRemoteManagedRuntime } from "./remote-managed-runtime.js";

const execFileAsync = promisify(execFile);

describe("remote managed runtime", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it.each(["../escape", "/absolute", "nested/name"])(
    "rejects unsafe adapterKey %s before any SSH mutation",
    async (adapterKey) => {
      await expect(prepareRemoteManagedRuntime({
        spec: {
          host: "127.0.0.1", port: 2222, username: "fixture", remoteWorkspacePath: "/app",
          remoteCwd: "/app", privateKey: "PRIVATE KEY", knownHosts: "KNOWN HOSTS",
          strictHostKeyChecking: true,
        },
        runId: "run-safe",
        adapterKey,
        workspaceLocalDir: "/tmp/workspace",
      })).rejects.toThrow(/adapterKey must be a safe path segment/);
      expect(prepareWorkspaceForSshExecution).not.toHaveBeenCalled();
      expect(runSshCommand).not.toHaveBeenCalled();
      expect(syncDirectoryToSsh).not.toHaveBeenCalled();
    },
  );

  it.each(["claude", "codex_local", "acp-engine"])("accepts legal adapterKey %s", (adapterKey) => {
    expect(() => buildRemoteRunCleanupCommand({
      baseWorkspaceRemoteDir: "/app",
      workspaceRemoteDir: "/app/.paperclip-runtime/runs/run-safe/workspace",
      runtimeRootDir: `/app/.paperclip-runtime/${adapterKey}/runs/run-safe`,
      adapterKey,
      runId: "run-safe",
      syncWorkspace: false,
    })).not.toThrow();
  });

  it("uses the same trimmed adapterKey for staging and exact cleanup", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-trim-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    const prepared = await prepareRemoteManagedRuntime({
      spec: {
        host: "127.0.0.1", port: 2222, username: "fixture", remoteWorkspacePath: "/app",
        remoteCwd: "/app", privateKey: "PRIVATE KEY", knownHosts: "KNOWN HOSTS",
        strictHostKeyChecking: true,
      },
      runId: "run-trim",
      adapterKey: " codex ",
      workspaceLocalDir: workspaceDir,
      syncWorkspace: false,
    });

    expect(prepared.runtimeRootDir).toBe("/app/.paperclip-runtime/codex/runs/run-trim");
    await prepared.restoreWorkspace();
    expect(runSshCommand).toHaveBeenCalledWith(expect.anything(), expect.stringContaining(
      "rm -rf -- '/app/.paperclip-runtime/codex/runs/run-trim'",
    ));
  });

  it("restores runtime assets without restoring an in-place SSH workspace", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-assets-only-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const homeDir = path.join(rootDir, "home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await writeFile(path.join(homeDir, "auth.json"), '{"token":"host"}\n', "utf8");

    let restoredAuth = "";
    const prepared = await prepareRemoteManagedRuntime({
      spec: {
        host: "127.0.0.1",
        port: 2222,
        username: "fixture",
        remoteWorkspacePath: "/app",
        remoteCwd: "/app",
        privateKey: "PRIVATE KEY",
        knownHosts: "KNOWN HOSTS",
        strictHostKeyChecking: true,
      },
      runId: "run-in-place",
      adapterKey: "codex",
      workspaceLocalDir: workspaceDir,
      workspaceRemoteDir: "/app",
      syncWorkspace: false,
      assets: [
        {
          key: "home",
          localDir: homeDir,
          restore: async ({ assetDir, readFile }) => {
            restoredAuth = (await readFile(path.posix.join(assetDir, "auth.json"))).toString("utf8");
          },
        },
      ],
    });

    expect(prepareWorkspaceForSshExecution).not.toHaveBeenCalled();
    expect(syncDirectoryToSsh).toHaveBeenCalledWith(expect.objectContaining({
      localDir: homeDir,
      remoteDir: "/app/.paperclip-runtime/codex/runs/run-in-place/home",
    }));

    await prepared.restoreWorkspace();

    expect(restoreWorkspaceFromSshExecution).not.toHaveBeenCalled();
    expect(runSshCommand).toHaveBeenCalledWith(
      expect.anything(),
      "base64 < '/app/.paperclip-runtime/codex/runs/run-in-place/home/auth.json'",
      { maxBuffer: 1024 * 1024 },
    );
    expect(restoredAuth).toBe('{"token":"remote"}\n');
  });

  it("isolates in-place asset homes by run id", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-run-isolation-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const homeDir = path.join(rootDir, "home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    const common = {
      spec: {
        host: "127.0.0.1", port: 2222, username: "fixture", remoteWorkspacePath: "/app",
        remoteCwd: "/app", privateKey: "PRIVATE KEY", knownHosts: "KNOWN HOSTS",
        strictHostKeyChecking: true,
      },
      adapterKey: "codex",
      workspaceLocalDir: workspaceDir,
      workspaceRemoteDir: "/app",
      syncWorkspace: false,
      assets: [{ key: "home", localDir: homeDir }],
    };

    const first = await prepareRemoteManagedRuntime({ ...common, runId: "run-one" });
    const second = await prepareRemoteManagedRuntime({ ...common, runId: "run-two" });

    expect(first.assetDirs.home).toBe("/app/.paperclip-runtime/codex/runs/run-one/home");
    expect(second.assetDirs.home).toBe("/app/.paperclip-runtime/codex/runs/run-two/home");
    expect(first.assetDirs.home).not.toBe(second.assetDirs.home);
  });

  it("canonicalizes a trailing-slash remote cwd before staging and cleanup", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-trailing-slash-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    const prepared = await prepareRemoteManagedRuntime({
      spec: {
        host: "127.0.0.1", port: 2222, username: "fixture", remoteWorkspacePath: "/app/",
        remoteCwd: "/app/", privateKey: "PRIVATE KEY", knownHosts: "KNOWN HOSTS",
        strictHostKeyChecking: true,
      },
      runId: "run-trailing",
      adapterKey: "claude",
      workspaceLocalDir: workspaceDir,
    });

    expect(prepared.workspaceRemoteDir).toBe("/app/.paperclip-runtime/runs/run-trailing/workspace");
    expect(prepareWorkspaceForSshExecution).toHaveBeenCalledWith(expect.objectContaining({
      remoteDir: "/app/.paperclip-runtime/runs/run-trailing/workspace",
    }));
    await prepared.restoreWorkspace();
    expect(runSshCommand).toHaveBeenCalledWith(expect.anything(), expect.stringContaining(
      "rm -rf -- '/app/.paperclip-runtime/runs/run-trailing'",
    ));
  });

  it("removes the generated run workspace only after a successful restore", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-cleanup-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    const prepared = await prepareRemoteManagedRuntime({
      spec: {
        host: "127.0.0.1", port: 2222, username: "fixture", remoteWorkspacePath: "/app",
        remoteCwd: "/app", privateKey: "PRIVATE KEY", knownHosts: "KNOWN HOSTS",
        strictHostKeyChecking: true,
      },
      runId: "run-cleanup",
      adapterKey: "claude",
      workspaceLocalDir: workspaceDir,
    });

    await prepared.restoreWorkspace();

    const restoreOrder = restoreWorkspaceFromSshExecution.mock.invocationCallOrder[0]!;
    const sshCalls = runSshCommand.mock.calls as unknown as Array<[unknown, string]>;
    const cleanupCall = sshCalls.find(([, command]) => command.includes("rm -rf --"));
    expect(cleanupCall?.[1]).toContain("rm -rf -- '/app/.paperclip-runtime/runs/run-cleanup'");
    expect(runSshCommand.mock.invocationCallOrder.at(-1)).toBeGreaterThan(restoreOrder);
  });

  it("cleans a partially staged generated workspace after an asset transfer error", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-error-cleanup-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const assetDir = path.join(rootDir, "asset");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(assetDir, { recursive: true });
    syncDirectoryToSsh.mockRejectedValueOnce(new Error("transfer failed"));

    await expect(prepareRemoteManagedRuntime({
      spec: {
        host: "127.0.0.1", port: 2222, username: "fixture", remoteWorkspacePath: "/app",
        remoteCwd: "/app", privateKey: "PRIVATE KEY", knownHosts: "KNOWN HOSTS",
        strictHostKeyChecking: true,
      },
      runId: "run-error",
      adapterKey: "claude",
      workspaceLocalDir: workspaceDir,
      assets: [{ key: "config", localDir: assetDir }],
    })).rejects.toThrow("transfer failed");

    expect(runSshCommand).toHaveBeenCalledWith(expect.anything(), expect.stringContaining(
      "rm -rf -- '/app/.paperclip-runtime/runs/run-error'",
    ));
  });

  it("cleans the exact run root and preserves a sync-back failure", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-restore-error-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    const prepared = await prepareRemoteManagedRuntime({
      spec: {
        host: "127.0.0.1", port: 2222, username: "fixture", remoteWorkspacePath: "/app",
        remoteCwd: "/app", privateKey: "PRIVATE KEY", knownHosts: "KNOWN HOSTS",
        strictHostKeyChecking: true,
      },
      runId: "run-restore-error",
      adapterKey: "claude",
      workspaceLocalDir: workspaceDir,
    });
    restoreWorkspaceFromSshExecution.mockRejectedValueOnce(new Error("sync-back failed"));

    await expect(prepared.restoreWorkspace()).rejects.toThrow("sync-back failed");
    expect(runSshCommand).toHaveBeenCalledWith(expect.anything(), expect.stringContaining(
      "rm -rf -- '/app/.paperclip-runtime/runs/run-restore-error'",
    ));
  });

  it("never removes an authoritative in-place workspace", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-in-place-cleanup-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    const prepared = await prepareRemoteManagedRuntime({
      spec: {
        host: "127.0.0.1", port: 2222, username: "fixture", remoteWorkspacePath: "/app",
        remoteCwd: "/app", privateKey: "PRIVATE KEY", knownHosts: "KNOWN HOSTS",
        strictHostKeyChecking: true,
      },
      runId: "run-in-place-cleanup",
      adapterKey: "claude",
      workspaceLocalDir: workspaceDir,
      syncWorkspace: false,
    });

    await prepared.restoreWorkspace();

    expect(runSshCommand).toHaveBeenCalledWith(expect.anything(), expect.stringContaining(
      "rm -rf -- '/app/.paperclip-runtime/claude/runs/run-in-place-cleanup'",
    ));
    const sshCalls = runSshCommand.mock.calls as unknown as Array<[unknown, string]>;
    expect(sshCalls.some(([, command]) => command.endsWith("rm -rf -- '/app'"))).toBe(false);
  });

  it("refuses cleanup through an intermediate managed symlink", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-symlink-"));
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-outside-"));
    cleanupDirs.push(rootDir, outsideDir);
    await writeFile(path.join(outsideDir, "sentinel"), "keep");
    await symlink(outsideDir, path.join(rootDir, ".paperclip-runtime"), "dir");
    const command = buildRemoteRunCleanupCommand({
      baseWorkspaceRemoteDir: rootDir,
      workspaceRemoteDir: path.join(rootDir, ".paperclip-runtime", "runs", "run-link", "workspace"),
      runtimeRootDir: path.join(rootDir, ".paperclip-runtime", "runs", "run-link", "workspace", ".paperclip-runtime", "claude", "runs", "run-link"),
      adapterKey: "claude",
      runId: "run-link",
      syncWorkspace: true,
    });

    await expect(execFileAsync("sh", ["-c", command])).rejects.toBeDefined();
    await expect(access(path.join(outsideDir, "sentinel"))).resolves.toBeUndefined();
  });

  it("surfaces cleanup failure after an otherwise successful restore", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-cleanup-failure-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    const prepared = await prepareRemoteManagedRuntime({
      spec: {
        host: "127.0.0.1", port: 2222, username: "fixture", remoteWorkspacePath: "/app",
        remoteCwd: "/app", privateKey: "PRIVATE KEY", knownHosts: "KNOWN HOSTS",
        strictHostKeyChecking: true,
      },
      runId: "run-cleanup-failure",
      adapterKey: "claude",
      workspaceLocalDir: workspaceDir,
    });
    runSshCommand.mockRejectedValueOnce(new Error("cleanup refused"));

    await expect(prepared.restoreWorkspace()).rejects.toThrow("cleanup refused");
  });

  it("cleans the owned run after snapshot capture fails post-upload", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-snapshot-failure-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    await expect(prepareRemoteManagedRuntime({
      spec: {
        host: "127.0.0.1", port: 2222, username: "fixture", remoteWorkspacePath: "/app",
        remoteCwd: "/app", privateKey: "PRIVATE KEY", knownHosts: "KNOWN HOSTS",
        strictHostKeyChecking: true,
      },
      runId: "run-snapshot-failure",
      adapterKey: "claude",
      workspaceLocalDir: workspaceDir,
      _captureDirectorySnapshot: async () => { throw new Error("snapshot failed"); },
    })).rejects.toThrow("snapshot failed");
    expect(runSshCommand).toHaveBeenCalledWith(expect.anything(), expect.stringContaining(
      "rm -rf -- '/app/.paperclip-runtime/runs/run-snapshot-failure'",
    ));
  });

  it("reports cleanup failure without masking workspace preparation failure", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-prepare-cleanup-log-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    prepareWorkspaceForSshExecution.mockRejectedValueOnce(new Error("prepare failed"));
    runSshCommand.mockRejectedValueOnce(new Error("cleanup failed"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(prepareRemoteManagedRuntime({
      spec: {
        host: "127.0.0.1", port: 2222, username: "fixture", remoteWorkspacePath: "/app",
        remoteCwd: "/app", privateKey: "PRIVATE KEY", knownHosts: "KNOWN HOSTS",
        strictHostKeyChecking: true,
      },
      runId: "run-prepare-log",
      adapterKey: "claude",
      workspaceLocalDir: workspaceDir,
    })).rejects.toThrow("prepare failed");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("cleanup also failed after workspace preparation failure"));
    warn.mockRestore();
  });

  it("reports cleanup failure without masking asset transfer failure", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-asset-cleanup-log-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const assetDir = path.join(rootDir, "asset");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(assetDir, { recursive: true });
    syncDirectoryToSsh.mockRejectedValueOnce(new Error("asset failed"));
    runSshCommand.mockRejectedValueOnce(new Error("cleanup failed"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(prepareRemoteManagedRuntime({
      spec: {
        host: "127.0.0.1", port: 2222, username: "fixture", remoteWorkspacePath: "/app",
        remoteCwd: "/app", privateKey: "PRIVATE KEY", knownHosts: "KNOWN HOSTS",
        strictHostKeyChecking: true,
      },
      runId: "run-asset-log",
      adapterKey: "claude",
      workspaceLocalDir: workspaceDir,
      assets: [{ key: "config", localDir: assetDir }],
    })).rejects.toThrow("asset failed");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("cleanup also failed after asset transfer failure"));
    warn.mockRestore();
  });

  it("stages each additional project into its own isolated SSH dir, isolating one failure", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-additional-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const firstDir = path.join(rootDir, "referenced-first");
    const secondDir = path.join(rootDir, "referenced-second");
    const brokenDir = path.join(rootDir, "referenced-broken");
    await mkdir(workspaceDir, { recursive: true });

    // The transfer rejects only for the broken project's directory.
    syncDirectoryToSsh.mockImplementation(async (input: { localDir: string }) => {
      if (input.localDir === brokenDir) throw new Error("ssh transfer failed");
      return undefined;
    });

    const prepared = await prepareRemoteManagedRuntime({
      spec: {
        host: "127.0.0.1",
        port: 2222,
        username: "fixture",
        remoteWorkspacePath: "/app",
        remoteCwd: "/app",
        privateKey: "PRIVATE KEY",
        knownHosts: "KNOWN HOSTS",
        strictHostKeyChecking: true,
      },
      runId: "run-additional",
      adapterKey: "codex",
      workspaceLocalDir: workspaceDir,
      workspaceRemoteDir: "/app",
      syncWorkspace: false,
      additionalSources: [
        { localPath: firstDir, projectId: "first" },
        { localPath: brokenDir, projectId: "broken" },
        { localPath: secondDir, projectId: "second" },
      ],
    });

    // Each healthy project staged into its OWN isolated dir under the runtime
    // root; the broken one is skipped, not fatal.
    expect(Object.keys(prepared.additionalSourceDirs).sort()).toEqual(["first", "second"]);
    expect(prepared.additionalSourceDirs.first).toBe("/app/.paperclip-runtime/codex/runs/run-additional/project-first");
    expect(prepared.additionalSourceDirs.second).toBe("/app/.paperclip-runtime/codex/runs/run-additional/project-second");
    expect(prepared.additionalSourceDirs.broken).toBeUndefined();
    expect(syncDirectoryToSsh).toHaveBeenCalledWith(expect.objectContaining({
      localDir: firstDir,
      remoteDir: "/app/.paperclip-runtime/codex/runs/run-additional/project-first",
    }));
    expect(syncDirectoryToSsh).toHaveBeenCalledWith(expect.objectContaining({
      localDir: secondDir,
      remoteDir: "/app/.paperclip-runtime/codex/runs/run-additional/project-second",
    }));
  });

  it("skips an additional project whose localPath is not absolute", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-relative-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const healthyDir = path.join(rootDir, "referenced-healthy");
    await mkdir(workspaceDir, { recursive: true });

    const prepared = await prepareRemoteManagedRuntime({
      spec: {
        host: "127.0.0.1",
        port: 2222,
        username: "fixture",
        remoteWorkspacePath: "/app",
        remoteCwd: "/app",
        privateKey: "PRIVATE KEY",
        knownHosts: "KNOWN HOSTS",
        strictHostKeyChecking: true,
      },
      runId: "run-relative",
      adapterKey: "codex",
      workspaceLocalDir: workspaceDir,
      workspaceRemoteDir: "/app",
      syncWorkspace: false,
      additionalSources: [
        { localPath: "relative/referenced", projectId: "relative" },
        { localPath: healthyDir, projectId: "healthy" },
      ],
    });

    // The relative-path project never reaches the transfer and is skipped; the
    // absolute-path project still stages.
    expect(Object.keys(prepared.additionalSourceDirs)).toEqual(["healthy"]);
    expect(syncDirectoryToSsh).not.toHaveBeenCalledWith(expect.objectContaining({
      localDir: "relative/referenced",
    }));
  });
});
