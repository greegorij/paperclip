import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const HEARTBEAT_RUN_SCRATCH_MARKER = ".paperclip-run-scratch.json";

export interface HeartbeatRunScratchMetadata {
  version: 1;
  companyId: string;
  agentId: string;
  runId: string;
  issueId: string | null;
  issueIdentifier: string | null;
  createdAt: string;
}

export interface HeartbeatRunScratch {
  dir: string;
  /** Owner-only runtime dir for the whole run (XDG_RUNTIME_DIR). */
  runtimeDir: string;
  markerPath: string;
  metadata: HeartbeatRunScratchMetadata;
}

/** Subdir under run scratch used as stable XDG_RUNTIME_DIR for the heartbeat. */
export const HEARTBEAT_RUN_XDG_RUNTIME_SEGMENT = "xdg-runtime";

export interface HeartbeatRunScratchEnvResult {
  env: Record<string, string>;
  tempKeysApplied: string[];
}

export type HeartbeatRunScratchCleanupResult =
  | { removed: true; dir: string }
  | { removed: false; dir: string; reason: "missing" | "unmarked" | "owner_mismatch" | "process_group_alive" };

const TEMP_ENV_KEYS = ["TMPDIR", "TEMP", "TMP"] as const;
const ISSUE_SEGMENT_MAX_CHARS = 32;

function sanitizePathSegment(value: string | null | undefined, fallback: string): string {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, ISSUE_SEGMENT_MAX_CHARS)
    .replace(/[.-]+$/g, "");
  return normalized || fallback;
}

/** Stable agent-browser session id scoped to one run (no cross-run collisions). */
export function buildHeartbeatRunBrowserSession(runId: string): string {
  const normalized = runId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `paperclip-${normalized || "run"}`;
}

/**
 * POSIX path for the browser XDG runtime directory inside a remote execution
 * target. Never points at the Paperclip host filesystem.
 */
export function buildRemoteHeartbeatXdgRuntimeDir(remoteCwd: string, runId: string): string {
  const cwd = remoteCwd.trim();
  if (!cwd.startsWith("/")) {
    throw new Error(`Remote browser runtime requires an absolute POSIX cwd; got "${remoteCwd}"`);
  }
  const runSegment =
    runId
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 96) || "run";
  return path.posix.join(cwd, ".paperclip-runtime", HEARTBEAT_RUN_XDG_RUNTIME_SEGMENT, runSegment);
}

/** Harness env that keeps agent-browser on one daemon for the whole heartbeat. */
export function buildHeartbeatBrowserRuntimeEnv(
  runId: string,
  runtimeDir: string,
): Pick<Record<string, string>, "XDG_RUNTIME_DIR" | "AGENT_BROWSER_SESSION"> {
  return {
    XDG_RUNTIME_DIR: runtimeDir,
    AGENT_BROWSER_SESSION: buildHeartbeatRunBrowserSession(runId),
  };
}

/**
 * Materialize a target-local browser runtime dir, then return harness env.
 * On materialization failure this throws before returning any env overlay, so
 * callers never dispatch the adapter with an unreachable host path.
 */
export async function prepareRemoteHeartbeatBrowserRuntimeEnv(input: {
  runId: string;
  remoteCwd: string;
  materialize: (runtimeDir: string) => Promise<void>;
}): Promise<{ runtimeDir: string; env: Record<string, string> }> {
  const runtimeDir = buildRemoteHeartbeatXdgRuntimeDir(input.remoteCwd, input.runId);
  try {
    await input.materialize(runtimeDir);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not materialize browser runtime directory on remote execution target at "${runtimeDir}": ${detail}. ` +
        "Refusing to launch the adapter with an unreachable XDG_RUNTIME_DIR. " +
        "Fix remote filesystem permissions or sandbox volume mounts, then retry the run.",
    );
  }
  return {
    runtimeDir,
    env: buildHeartbeatBrowserRuntimeEnv(input.runId, runtimeDir),
  };
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function readMarker(markerPath: string): Promise<HeartbeatRunScratchMetadata | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(markerPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const rec = parsed as Record<string, unknown>;
    if (
      rec.version !== 1 ||
      typeof rec.companyId !== "string" ||
      typeof rec.agentId !== "string" ||
      typeof rec.runId !== "string" ||
      typeof rec.createdAt !== "string"
    ) {
      return null;
    }
    return {
      version: 1,
      companyId: rec.companyId,
      agentId: rec.agentId,
      runId: rec.runId,
      issueId: typeof rec.issueId === "string" ? rec.issueId : null,
      issueIdentifier: typeof rec.issueIdentifier === "string" ? rec.issueIdentifier : null,
      createdAt: rec.createdAt,
    };
  } catch {
    return null;
  }
}

export async function prepareHeartbeatRunScratch(input: {
  companyId: string;
  agentId: string;
  runId: string;
  issueId?: string | null;
  issueIdentifier?: string | null;
  now?: Date;
}): Promise<HeartbeatRunScratch> {
  const issueSegment = sanitizePathSegment(input.issueIdentifier, "unassigned");
  const runSegment = sanitizePathSegment(input.runId.slice(0, 12), "run");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `paperclip-run-${issueSegment}-${runSegment}-`));
  const runtimeDir = path.join(dir, HEARTBEAT_RUN_XDG_RUNTIME_SEGMENT);
  // Explicit chmod: mkdir mode is masked by umask; agent-browser expects owner-only runtime.
  await fs.mkdir(runtimeDir, { recursive: false, mode: 0o700 });
  await fs.chmod(runtimeDir, 0o700);
  const markerPath = path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER);
  const metadata: HeartbeatRunScratchMetadata = {
    version: 1,
    companyId: input.companyId,
    agentId: input.agentId,
    runId: input.runId,
    issueId: input.issueId ?? null,
    issueIdentifier: input.issueIdentifier ?? null,
    createdAt: (input.now ?? new Date()).toISOString(),
  };
  await fs.writeFile(markerPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  return { dir, runtimeDir, markerPath, metadata };
}

/**
 * Prepare host-local run scratch and project harness env.
 * On scratch failure this throws before returning any env overlay, so callers
 * never dispatch the adapter with a stale inherited XDG_RUNTIME_DIR.
 */
export async function prepareLocalHeartbeatRunScratchEnv(input: {
  companyId: string;
  agentId: string;
  runId: string;
  issueId?: string | null;
  issueIdentifier?: string | null;
  existingEnv?: Record<string, unknown>;
  now?: Date;
  /** Optional prepare seam (tests); production uses prepareHeartbeatRunScratch. */
  prepare?: (input: {
    companyId: string;
    agentId: string;
    runId: string;
    issueId?: string | null;
    issueIdentifier?: string | null;
    now?: Date;
  }) => Promise<HeartbeatRunScratch>;
}): Promise<{
  scratch: HeartbeatRunScratch;
  env: Record<string, string>;
  tempKeysApplied: string[];
}> {
  const prepare = input.prepare ?? prepareHeartbeatRunScratch;
  let scratch: HeartbeatRunScratch;
  try {
    scratch = await prepare({
      companyId: input.companyId,
      agentId: input.agentId,
      runId: input.runId,
      issueId: input.issueId,
      issueIdentifier: input.issueIdentifier,
      now: input.now,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not prepare heartbeat run scratch directory: ${detail}. ` +
        "Refusing to launch the adapter with an unreachable XDG_RUNTIME_DIR. " +
        "Fix local temp-directory permissions, then retry the run.",
    );
  }
  const scratchEnv = buildHeartbeatRunScratchEnv(input.existingEnv ?? {}, scratch);
  return {
    scratch,
    env: scratchEnv.env,
    tempKeysApplied: scratchEnv.tempKeysApplied,
  };
}

export function buildHeartbeatRunScratchEnv(
  existingEnv: Record<string, unknown>,
  scratch: HeartbeatRunScratch,
): HeartbeatRunScratchEnvResult {
  const env: Record<string, string> = {
    PAPERCLIP_RUN_SCRATCH_DIR: scratch.dir,
    PAPERCLIP_TASK_SCRATCH_DIR: scratch.dir,
    PAPERCLIP_SCRATCH_DIR: scratch.dir,
    PAPERCLIP_TMPDIR: scratch.dir,
    // Stable for the whole run so separate shell invocations share one agent-browser daemon.
    XDG_RUNTIME_DIR: scratch.runtimeDir,
    AGENT_BROWSER_SESSION: buildHeartbeatRunBrowserSession(scratch.metadata.runId),
  };
  const tempKeysApplied: string[] = [];
  for (const key of TEMP_ENV_KEYS) {
    const existing = existingEnv[key];
    if (typeof existing === "string" && existing.trim().length > 0) continue;
    env[key] = scratch.dir;
    tempKeysApplied.push(key);
  }
  return { env, tempKeysApplied };
}

export async function cleanupHeartbeatRunScratch(input: {
  scratch: HeartbeatRunScratch;
  processGroupId?: number | null;
  isProcessGroupAlive?: (processGroupId: number | null | undefined) => boolean;
}): Promise<HeartbeatRunScratchCleanupResult> {
  const tmpRoot = path.resolve(os.tmpdir());
  const dir = path.resolve(input.scratch.dir);
  if (!isPathInside(tmpRoot, dir) || !path.basename(dir).startsWith("paperclip-run-")) {
    return { removed: false, dir, reason: "unmarked" };
  }
  try {
    const stats = await fs.stat(dir);
    if (!stats.isDirectory()) return { removed: false, dir, reason: "missing" };
  } catch {
    return { removed: false, dir, reason: "missing" };
  }

  const marker = await readMarker(path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER));
  if (!marker) return { removed: false, dir, reason: "unmarked" };
  if (
    marker.companyId !== input.scratch.metadata.companyId ||
    marker.agentId !== input.scratch.metadata.agentId ||
    marker.runId !== input.scratch.metadata.runId
  ) {
    return { removed: false, dir, reason: "owner_mismatch" };
  }
  if (input.isProcessGroupAlive?.(input.processGroupId) === true) {
    return { removed: false, dir, reason: "process_group_alive" };
  }

  await fs.rm(dir, { recursive: true, force: true });
  return { removed: true, dir };
}
