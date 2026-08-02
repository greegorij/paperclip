import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureClaudeCliUsageText } from "./quota.js";

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isPidAlive(pid);
}

async function waitForPidFile(pidFile: string, timeoutMs = 2_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = (await fs.readFile(pidFile, "utf8")).trim();
      const pid = Number(raw);
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      // Not written yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for fake claude child pid file at ${pidFile}`);
}

describe("captureClaudeCliUsageText process cleanup", () => {
  const originalPath = process.env.PATH;
  const originalPidFileEnv = process.env.PAPERCLIP_TEST_QUOTA_CHILD_PID_FILE;
  let tempDir: string | null = null;
  let childPidFile: string | null = null;
  let leakedChildPid: number | null = null;

  afterEach(async () => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;

    if (originalPidFileEnv === undefined) delete process.env.PAPERCLIP_TEST_QUOTA_CHILD_PID_FILE;
    else process.env.PAPERCLIP_TEST_QUOTA_CHILD_PID_FILE = originalPidFileEnv;

    if (leakedChildPid != null && isPidAlive(leakedChildPid)) {
      try {
        process.kill(leakedChildPid, "SIGKILL");
      } catch {
        // Best-effort cleanup for a failed assertion.
      }
    }
    leakedChildPid = null;

    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
    tempDir = null;
    childPidFile = null;
  });

  it.skipIf(process.platform === "win32")(
    "kills long-lived probe descendants when the usage capture times out",
    async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-quota-"));
      childPidFile = path.join(tempDir, "child.pid");
      const fakeClaudePath = path.join(tempDir, "claude");

      // Worst-case orphan: detached into its own session/group (when the platform
      // allows), ignores SIGTERM, and only dies on SIGKILL. After the fake parent
      // exits on SIGTERM the child is reparented, so a fresh PPID walk from the
      // probe root would miss it — teardown must remember the earlier snapshot.
      const fakeClaudeSource = `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const pidFile = process.env.PAPERCLIP_TEST_QUOTA_CHILD_PID_FILE;
const child = spawn(
  process.execPath,
  [
    "-e",
    [
      "try { process.chdir('/'); } catch {}",
      "process.on('SIGTERM', () => {});",
      "process.on('SIGHUP', () => {});",
      "setInterval(() => {}, 1000);",
    ].join(""),
  ],
  {
    stdio: "ignore",
    // New process group + session on POSIX so group teardown of the probe root
    // cannot reach this descendant; only remembered-PID SIGKILL should.
    detached: true,
  },
);
child.unref();
if (pidFile) fs.writeFileSync(pidFile, String(child.pid), "utf8");
setInterval(() => {}, 1000);
`;
      await fs.writeFile(fakeClaudePath, fakeClaudeSource, { mode: 0o755 });

      process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ""}`;
      process.env.PAPERCLIP_TEST_QUOTA_CHILD_PID_FILE = childPidFile;

      const capturePromise = captureClaudeCliUsageText(800);
      leakedChildPid = await waitForPidFile(childPidFile, 2_000);
      expect(isPidAlive(leakedChildPid)).toBe(true);

      await expect(capturePromise).rejects.toThrow(/timed out|before rendering usage|without usable output/i);

      expect(await waitForPidExit(leakedChildPid, 3_000)).toBe(true);
      expect(isPidAlive(leakedChildPid)).toBe(false);
      leakedChildPid = null;
    },
  );
});
