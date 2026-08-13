import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HEARTBEAT_RUN_SCRATCH_MARKER,
  HEARTBEAT_RUN_XDG_RUNTIME_SEGMENT,
  buildHeartbeatBrowserRuntimeEnv,
  buildHeartbeatRunBrowserSession,
  buildHeartbeatRunScratchEnv,
  buildRemoteHeartbeatXdgRuntimeDir,
  cleanupHeartbeatRunScratch,
  prepareHeartbeatRunScratch,
  prepareLocalHeartbeatRunScratchEnv,
  prepareRemoteHeartbeatBrowserRuntimeEnv,
  type HeartbeatRunScratch,
} from "./run-scratch.js";

const cleanupDirs = new Set<string>();

async function trackScratch(scratch: HeartbeatRunScratch) {
  cleanupDirs.add(scratch.dir);
  return scratch;
}

afterEach(async () => {
  await Promise.all(
    Array.from(cleanupDirs, (dir) =>
      fs.rm(dir, { recursive: true, force: true }).catch(() => undefined),
    ),
  );
  cleanupDirs.clear();
});

describe("heartbeat run scratch cleanup", () => {
  it("removes only a marked run-owned scratch directory", async () => {
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
      issueId: "issue-1",
      issueIdentifier: "PAP-13071",
      now: new Date("2026-07-08T00:00:00.000Z"),
    }));
    await fs.writeFile(path.join(scratch.dir, "tool-cache.txt"), "cache");

    const result = await cleanupHeartbeatRunScratch({ scratch });

    expect(result).toEqual({ removed: true, dir: scratch.dir });
    await expect(fs.stat(scratch.dir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves paperclip-named directories without the ownership marker", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-unmarked-"));
    cleanupDirs.add(dir);
    const runtimeDir = path.join(dir, HEARTBEAT_RUN_XDG_RUNTIME_SEGMENT);
    await fs.mkdir(runtimeDir, { mode: 0o700 });
    const scratch: HeartbeatRunScratch = {
      dir,
      runtimeDir,
      markerPath: path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER),
      metadata: {
        version: 1,
        companyId: "company-1",
        agentId: "agent-1",
        runId: "run-1",
        issueId: null,
        issueIdentifier: null,
        createdAt: new Date("2026-07-08T00:00:00.000Z").toISOString(),
      },
    };

    const result = await cleanupHeartbeatRunScratch({ scratch });

    expect(result).toEqual({ removed: false, dir, reason: "unmarked" });
    await expect(fs.stat(dir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("preserves marked scratch when the marker owner does not match the run", async () => {
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    }));
    const mismatched = {
      ...scratch,
      metadata: {
        ...scratch.metadata,
        runId: "run-2",
      },
    };

    const result = await cleanupHeartbeatRunScratch({ scratch: mismatched });

    expect(result).toEqual({ removed: false, dir: scratch.dir, reason: "owner_mismatch" });
    await expect(fs.stat(scratch.dir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("skips cleanup while the run process group is still alive", async () => {
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    }));

    const result = await cleanupHeartbeatRunScratch({
      scratch,
      processGroupId: 123,
      isProcessGroupAlive: () => true,
    });

    expect(result).toEqual({ removed: false, dir: scratch.dir, reason: "process_group_alive" });
    await expect(fs.stat(scratch.dir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("builds explicit scratch env without clobbering configured temp dirs", async () => {
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    }));

    const result = buildHeartbeatRunScratchEnv({ TMPDIR: "/custom/tmp" }, scratch);

    expect(result.env.PAPERCLIP_RUN_SCRATCH_DIR).toBe(scratch.dir);
    expect(result.env.PAPERCLIP_TASK_SCRATCH_DIR).toBe(scratch.dir);
    expect(result.env.PAPERCLIP_SCRATCH_DIR).toBe(scratch.dir);
    expect(result.env.PAPERCLIP_TMPDIR).toBe(scratch.dir);
    expect(result.env.TMPDIR).toBeUndefined();
    expect(result.env.TEMP).toBe(scratch.dir);
    expect(result.env.TMP).toBe(scratch.dir);
    expect(result.tempKeysApplied).toEqual(["TEMP", "TMP"]);
  });
});

describe("heartbeat run browser runtime env", () => {
  it("creates an owner-only XDG runtime dir under the run scratch", async () => {
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-abc-123",
    }));

    expect(scratch.runtimeDir).toBe(path.join(scratch.dir, HEARTBEAT_RUN_XDG_RUNTIME_SEGMENT));
    const stats = await fs.stat(scratch.runtimeDir);
    expect(stats.isDirectory()).toBe(true);
    expect(stats.mode & 0o777).toBe(0o700);

    const env = buildHeartbeatRunScratchEnv({}, scratch).env;
    expect(env.XDG_RUNTIME_DIR).toBe(scratch.runtimeDir);
    expect(env.AGENT_BROWSER_SESSION).toBe(buildHeartbeatRunBrowserSession("run-abc-123"));
    expect(env.AGENT_BROWSER_SESSION).toBe("pc-run-abc-123");
  });

  it("keeps XDG_RUNTIME_DIR and AGENT_BROWSER_SESSION identical across two child processes of one run", async () => {
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-shared-session",
    }));
    const env = buildHeartbeatRunScratchEnv({}, scratch).env;
    const probe = [
      "process.stdout.write(JSON.stringify({",
      "xdg: process.env.XDG_RUNTIME_DIR,",
      "session: process.env.AGENT_BROWSER_SESSION,",
      "scratch: process.env.PAPERCLIP_RUN_SCRATCH_DIR",
      "}))",
    ].join("");

    const runProbe = () =>
      spawnSync(process.execPath, ["-e", probe], {
        env: { ...process.env, ...env },
        encoding: "utf8",
      });

    const first = runProbe();
    const second = runProbe();
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(JSON.parse(first.stdout)).toEqual(JSON.parse(second.stdout));
    expect(JSON.parse(first.stdout)).toEqual({
      xdg: scratch.runtimeDir,
      session: "pc-run-shared-sessio",
      scratch: scratch.dir,
    });
  });

  it("isolates XDG_RUNTIME_DIR and AGENT_BROWSER_SESSION across different runs", async () => {
    const scratchA = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa",
    }));
    const scratchB = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb",
    }));

    const envA = buildHeartbeatRunScratchEnv({}, scratchA).env;
    const envB = buildHeartbeatRunScratchEnv({}, scratchB).env;

    expect(envA.XDG_RUNTIME_DIR).not.toBe(envB.XDG_RUNTIME_DIR);
    expect(envA.AGENT_BROWSER_SESSION).not.toBe(envB.AGENT_BROWSER_SESSION);
    expect(envA.PAPERCLIP_RUN_SCRATCH_DIR).not.toBe(envB.PAPERCLIP_RUN_SCRATCH_DIR);
    expect(envA.XDG_RUNTIME_DIR.startsWith(scratchA.dir + path.sep)).toBe(true);
    expect(envB.XDG_RUNTIME_DIR.startsWith(scratchB.dir + path.sep)).toBe(true);
  });

  it("overrides operator XDG_RUNTIME_DIR / AGENT_BROWSER_SESSION with run-owned values", async () => {
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-override",
    }));

    const result = buildHeartbeatRunScratchEnv(
      {
        XDG_RUNTIME_DIR: "/tmp/agent-browser-runtime.stale",
        AGENT_BROWSER_SESSION: "shared-default",
      },
      scratch,
    );

    expect(result.env.XDG_RUNTIME_DIR).toBe(scratch.runtimeDir);
    expect(result.env.AGENT_BROWSER_SESSION).toBe("pc-run-override");
  });

  it("fails closed before returning env when local scratch cannot be prepared", async () => {
    let returnedEnv: Record<string, string> | null = null;
    await expect(
      prepareLocalHeartbeatRunScratchEnv({
        companyId: "company-1",
        agentId: "agent-1",
        runId: "run-local-fail",
        existingEnv: { XDG_RUNTIME_DIR: "/tmp/agent-browser-runtime.stale" },
        prepare: async () => {
          throw new Error("ENOSPC: no space left on device");
        },
      }).then((prepared) => {
        returnedEnv = prepared.env;
        return prepared;
      }),
    ).rejects.toThrow(
      /Could not prepare heartbeat run scratch directory[\s\S]*Refusing to launch the adapter with an unreachable XDG_RUNTIME_DIR/,
    );
    expect(returnedEnv).toBeNull();
  });
});

describe("remote heartbeat browser runtime env", () => {
  it("builds a target-local XDG path under remote cwd, never a host tmp path", () => {
    const runtimeDir = buildRemoteHeartbeatXdgRuntimeDir("/workspace/agent", "Run_ABC-123");
    expect(runtimeDir).toBe(`/workspace/agent/.paperclip-runtime/xdg-runtime/run_abc-123`);
    expect(runtimeDir.startsWith("/tmp/")).toBe(false);
    expect(runtimeDir.includes(os.tmpdir())).toBe(false);
  });

  it("returns harness env only after materialize succeeds", async () => {
    const materialized: string[] = [];
    const prepared = await prepareRemoteHeartbeatBrowserRuntimeEnv({
      runId: "run-remote-1",
      remoteCwd: "/sandbox/workspace",
      materialize: async (runtimeDir) => {
        materialized.push(runtimeDir);
      },
    });

    expect(materialized).toEqual([prepared.runtimeDir]);
    expect(prepared.env).toEqual(
      buildHeartbeatBrowserRuntimeEnv("run-remote-1", prepared.runtimeDir),
    );
    expect(prepared.env.XDG_RUNTIME_DIR).toBe(
      `/sandbox/workspace/.paperclip-runtime/xdg-runtime/run-remote-1`,
    );
    expect(prepared.env.AGENT_BROWSER_SESSION).toBe(buildHeartbeatRunBrowserSession("run-remote-1"));
  });

  it("fails closed before returning env when materialization cannot be proven", async () => {
    let returnedEnv: Record<string, string> | null = null;
    await expect(
      prepareRemoteHeartbeatBrowserRuntimeEnv({
        runId: "run-remote-fail",
        remoteCwd: "/sandbox/workspace",
        materialize: async () => {
          throw new Error("permission denied creating runtime dir");
        },
      }).then((prepared) => {
        returnedEnv = prepared.env;
        return prepared;
      }),
    ).rejects.toThrow(
      /Could not materialize browser runtime directory on remote execution target[\s\S]*Refusing to launch the adapter with an unreachable XDG_RUNTIME_DIR/,
    );
    expect(returnedEnv).toBeNull();
  });
});
