import path from "node:path";
import { assertSafeManagedPathSegment } from "./safe-path-segment.js";
import { GIT_ARCHIVE_EXCLUDES } from "./git-workspace-sync.js";
import {
  type SshRemoteExecutionSpec,
  prepareWorkspaceForSshExecution,
  runSshCommand,
  restoreWorkspaceFromSshExecution,
  syncDirectoryToSsh,
} from "./ssh.js";
import type {
  SandboxAdditionalSource,
  SandboxManagedRuntimeAssetRestoreContext,
} from "./sandbox-managed-runtime.js";
import { captureDirectorySnapshot } from "./workspace-restore-merge.js";
import type { RuntimeProgressSink } from "./runtime-progress.js";

const REMOTE_ADDITIONAL_SOURCE_HEAVY_DIR_EXCLUDES = [
  "node_modules",
  "vendor",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  ".git",
].flatMap((entry) => [entry, `${entry}/*`, `*/${entry}`, `*/${entry}/*`]);

export interface RemoteManagedRuntimeAsset {
  key: string;
  localDir: string;
  followSymlinks?: boolean;
  exclude?: string[];
  restore?: (ctx: SandboxManagedRuntimeAssetRestoreContext) => Promise<void>;
}

export interface PreparedRemoteManagedRuntime {
  spec: SshRemoteExecutionSpec;
  workspaceLocalDir: string;
  workspaceRemoteDir: string;
  runtimeRootDir: string;
  assetDirs: Record<string, string>;
  /**
   * Remote directory of each additional (referenced) project that staged
   * successfully, keyed by `projectId`. A project whose staging failed is
   * absent (per-project failure isolation).
   */
  additionalSourceDirs: Record<string, string>;
  restoreWorkspace(onProgress?: RuntimeProgressSink): Promise<void>;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function buildRemoteRunCleanupCommand(input: {
  baseWorkspaceRemoteDir: string;
  workspaceRemoteDir: string;
  runtimeRootDir: string;
  adapterKey: string;
  runId: string;
  syncWorkspace: boolean;
}): string {
  if (
    !path.posix.isAbsolute(input.baseWorkspaceRemoteDir) ||
    path.posix.normalize(input.baseWorkspaceRemoteDir) !== input.baseWorkspaceRemoteDir
  ) {
    throw new Error("Remote managed-runtime base must be a normalized absolute path");
  }
  const expectedTarget = input.syncWorkspace
    ? path.posix.join(input.baseWorkspaceRemoteDir, ".paperclip-runtime", "runs", input.runId)
    : path.posix.join(input.baseWorkspaceRemoteDir, ".paperclip-runtime", input.adapterKey, "runs", input.runId);
  const actualTarget = input.syncWorkspace ? path.posix.dirname(input.workspaceRemoteDir) : input.runtimeRootDir;
  if (
    actualTarget !== expectedTarget ||
    actualTarget === "/" ||
    actualTarget.includes("/../") ||
    !actualTarget.endsWith(`/runs/${input.runId}`)
  ) {
    throw new Error("Refusing to clean an unowned remote managed-runtime path");
  }
  const managedComponents = input.syncWorkspace
    ? [
        path.posix.join(input.baseWorkspaceRemoteDir, ".paperclip-runtime"),
        path.posix.join(input.baseWorkspaceRemoteDir, ".paperclip-runtime", "runs"),
        actualTarget,
      ]
    : [
        path.posix.join(input.baseWorkspaceRemoteDir, ".paperclip-runtime"),
        path.posix.join(input.baseWorkspaceRemoteDir, ".paperclip-runtime", input.adapterKey),
        path.posix.join(input.baseWorkspaceRemoteDir, ".paperclip-runtime", input.adapterKey, "runs"),
        actualTarget,
      ];
  const guards = managedComponents.map((component) =>
    `if [ -L ${shellQuote(component)} ] || { [ -e ${shellQuote(component)} ] && [ ! -d ${shellQuote(component)} ]; }; then ` +
      `echo ${shellQuote(`Refusing unsafe managed path: ${component}`)} >&2; exit 73; fi`,
  );
  return `${guards.join(" && ")} && rm -rf -- ${shellQuote(actualTarget)}`;
}

async function cleanupRemoteRun(input: {
  spec: SshRemoteExecutionSpec;
  baseWorkspaceRemoteDir: string;
  workspaceRemoteDir: string;
  runtimeRootDir: string;
  adapterKey: string;
  runId: string;
  syncWorkspace: boolean;
}): Promise<void> {
  await runSshCommand(input.spec, buildRemoteRunCleanupCommand(input));
}

async function readRemoteFile(spec: SshRemoteExecutionSpec, remotePath: string): Promise<Buffer> {
  const result = await runSshCommand(spec, `base64 < ${shellQuote(remotePath)}`, {
    maxBuffer: 1024 * 1024,
  });
  return Buffer.from(result.stdout.replace(/\s+/g, ""), "base64");
}

export function buildRemoteExecutionSessionIdentity(spec: SshRemoteExecutionSpec | null) {
  if (!spec) return null;
  return {
    transport: "ssh",
    host: spec.host,
    port: spec.port,
    username: spec.username,
    remoteCwd: spec.remoteCwd,
  } as const;
}

export function remoteExecutionSessionMatches(saved: unknown, current: SshRemoteExecutionSpec | null): boolean {
  const currentIdentity = buildRemoteExecutionSessionIdentity(current);
  if (!currentIdentity) return false;

  const parsedSaved = asObject(saved);
  return (
    asString(parsedSaved.transport) === currentIdentity.transport &&
    asString(parsedSaved.host) === currentIdentity.host &&
    asNumber(parsedSaved.port) === currentIdentity.port &&
    asString(parsedSaved.username) === currentIdentity.username &&
    asString(parsedSaved.remoteCwd) === currentIdentity.remoteCwd
  );
}

export async function prepareRemoteManagedRuntime(input: {
  spec: SshRemoteExecutionSpec;
  runId: string;
  adapterKey: string;
  workspaceLocalDir: string;
  workspaceRemoteDir?: string;
  syncWorkspace?: boolean;
  assets?: RemoteManagedRuntimeAsset[];
  /** Referenced (additional) projects to stage as plain, read-only trees. */
  additionalSources?: SandboxAdditionalSource[];
  // Upload progress sink. Threaded for the byte-counting transport rewrite; the
  // child task wires it into the workspace/asset transfers.
  onProgress?: RuntimeProgressSink;
  /** @internal deterministic failure seam for ownership/cleanup tests. */
  _captureDirectorySnapshot?: typeof captureDirectorySnapshot;
}): Promise<PreparedRemoteManagedRuntime> {
  const adapterKey = assertSafeManagedPathSegment(
    input.adapterKey,
    "Remote managed runtime adapterKey",
  );
  if (!/^[A-Za-z0-9_-]+$/.test(input.runId)) {
    throw new Error("Remote managed runtime runId must be a safe path segment");
  }
  const rawBaseWorkspaceRemoteDir = input.workspaceRemoteDir ?? input.spec.remoteCwd;
  if (
    !path.posix.isAbsolute(rawBaseWorkspaceRemoteDir) ||
    rawBaseWorkspaceRemoteDir.includes("\0") ||
    rawBaseWorkspaceRemoteDir.split("/").includes("..")
  ) {
    throw new Error("Remote managed runtime cwd must be an absolute path without traversal");
  }
  // Canonicalize lexical aliases (notably `/app/`) before the first remote
  // mutation. Every derived path and cleanup guard uses this exact root.
  const baseWorkspaceRemoteDir = path.posix.normalize(rawBaseWorkspaceRemoteDir);
  if (baseWorkspaceRemoteDir === "/") {
    throw new Error("Remote managed runtime cwd cannot be the filesystem root");
  }
  const syncWorkspace = input.syncWorkspace !== false;
  const workspaceRemoteDir = syncWorkspace
    ? path.posix.join(
        baseWorkspaceRemoteDir,
        ".paperclip-runtime",
        "runs",
        input.runId,
        "workspace",
      )
    : baseWorkspaceRemoteDir;
  const runtimeRootDir = path.posix.join(
    workspaceRemoteDir,
    ".paperclip-runtime",
    adapterKey,
    "runs",
    input.runId,
  );

  let preparedWorkspace: Awaited<ReturnType<typeof prepareWorkspaceForSshExecution>> | null = null;
  try {
    preparedWorkspace = syncWorkspace
      ? await prepareWorkspaceForSshExecution({
          spec: input.spec,
          localDir: input.workspaceLocalDir,
          remoteDir: workspaceRemoteDir,
          onProgress: input.onProgress,
        })
      : null;
  } catch (error) {
    await cleanupRemoteRun({
      spec: input.spec,
      baseWorkspaceRemoteDir,
      workspaceRemoteDir,
      runtimeRootDir,
      adapterKey,
      runId: input.runId,
      syncWorkspace,
    }).catch((cleanupError) => {
      console.warn(`[paperclip] Remote run cleanup also failed after workspace preparation failure: ${String(cleanupError)}`);
    });
    throw error;
  }
  let baselineSnapshot: Awaited<ReturnType<typeof captureDirectorySnapshot>> | null = null;
  try {
    baselineSnapshot = preparedWorkspace
      ? await (input._captureDirectorySnapshot ?? captureDirectorySnapshot)(input.workspaceLocalDir, {
          exclude: preparedWorkspace.gitBacked
            ? [...GIT_ARCHIVE_EXCLUDES, ".paperclip-runtime"]
            : [".paperclip-runtime"],
        })
      : null;
  } catch (error) {
    await cleanupRemoteRun({
      spec: input.spec,
      baseWorkspaceRemoteDir,
      workspaceRemoteDir,
      runtimeRootDir,
      adapterKey,
      runId: input.runId,
      syncWorkspace,
    }).catch((cleanupError) => {
      console.warn(`[paperclip] Remote run cleanup also failed after snapshot failure: ${String(cleanupError)}`);
    });
    throw error;
  }

  const assetDirs: Record<string, string> = {};
  try {
    for (const asset of input.assets ?? []) {
      const remoteDir = path.posix.join(runtimeRootDir, asset.key);
      assetDirs[asset.key] = remoteDir;
      await syncDirectoryToSsh({
        spec: input.spec,
        localDir: asset.localDir,
        remoteDir,
        followSymlinks: asset.followSymlinks,
        exclude: asset.exclude,
        onProgress: input.onProgress,
        progressLabel: asset.key,
      });
    }
  } catch (error) {
    try {
      if (preparedWorkspace && baselineSnapshot) {
        await restoreWorkspaceFromSshExecution({
          spec: input.spec,
          localDir: input.workspaceLocalDir,
          remoteDir: workspaceRemoteDir,
          baselineSnapshot,
          restoreGitHistory: preparedWorkspace.gitBacked,
          onProgress: input.onProgress,
        });
      }
    } finally {
      await cleanupRemoteRun({
        spec: input.spec,
        baseWorkspaceRemoteDir,
        workspaceRemoteDir,
        runtimeRootDir,
        adapterKey,
        runId: input.runId,
        syncWorkspace,
      }).catch((cleanupError) => {
        console.warn(`[paperclip] Remote run cleanup also failed after asset transfer failure: ${String(cleanupError)}`);
      });
    }
    throw error;
  }

  // Stage each referenced (additional) project as a plain, read-only tree in its
  // OWN isolated remote directory (`project-<projectId>`). Additional sources
  // never get the anchor's git-history/overlay semantics. Per-project failure
  // isolation: one project's failure logs a warning and is skipped; the run and
  // the other projects continue (no workspace restore, unlike an asset failure).
  const additionalSourceDirs: Record<string, string> = {};
  for (const source of input.additionalSources ?? []) {
    const { localPath, projectId } = source;
    try {
      if (!path.posix.isAbsolute(localPath)) {
        throw new Error(`additional source localPath is not an absolute path: ${localPath}`);
      }
      if (
        projectId.length === 0 ||
        projectId.includes("/") ||
        projectId.includes("\\") ||
        projectId.includes("..")
      ) {
        throw new Error(`additional source projectId is not a simple path segment: ${projectId}`);
      }
      const remoteDir = path.posix.join(runtimeRootDir, `project-${projectId}`);
      await syncDirectoryToSsh({
        spec: input.spec,
        localDir: localPath,
        remoteDir,
        exclude: REMOTE_ADDITIONAL_SOURCE_HEAVY_DIR_EXCLUDES,
        onProgress: input.onProgress,
        progressLabel: `project-${projectId}`,
      });
      additionalSourceDirs[projectId] = remoteDir;
    } catch (error) {
      console.warn(
        `[paperclip] Failed to stage referenced project ${projectId}; skipping it. ${String(error)}`,
      );
    }
  }

  return {
    spec: input.spec,
    workspaceLocalDir: input.workspaceLocalDir,
    workspaceRemoteDir,
    runtimeRootDir,
    assetDirs,
    additionalSourceDirs,
    restoreWorkspace: async (onProgress?: RuntimeProgressSink) => {
      let restoreError: unknown = null;
      try {
        if (preparedWorkspace && baselineSnapshot) {
          await restoreWorkspaceFromSshExecution({
            spec: input.spec,
            localDir: input.workspaceLocalDir,
            remoteDir: workspaceRemoteDir,
            baselineSnapshot,
            restoreGitHistory: preparedWorkspace.gitBacked,
            onProgress,
          });
        }
        for (const asset of input.assets ?? []) {
          if (!asset.restore) continue;
          await asset.restore({
            assetDir: path.posix.join(runtimeRootDir, asset.key),
            readFile: (remotePath) => readRemoteFile(input.spec, remotePath),
          });
        }
      } catch (error) {
        restoreError = error;
        throw error;
      } finally {
        try {
          await cleanupRemoteRun({
            spec: input.spec,
            baseWorkspaceRemoteDir,
            workspaceRemoteDir,
            runtimeRootDir,
            adapterKey,
            runId: input.runId,
            syncWorkspace,
          });
        } catch (cleanupError) {
          if (restoreError === null) throw cleanupError;
          console.warn(`[paperclip] Remote run cleanup also failed after restore failure: ${String(cleanupError)}`);
        }
      }
    },
  };
}
