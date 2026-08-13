import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext, AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";
import {
  runAdapterExecutionTargetShellCommand,
  type AdapterExecutionTarget,
  type AdapterExecutionTargetShellOptions,
} from "@paperclipai/adapter-utils/execution-target";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";
import { shellQuote } from "@paperclipai/adapter-utils/ssh";
import { buildRemotePrivateStoreProvision } from "@paperclipai/adapter-utils/remote-private-store";

const SEEDED_SHARED_FILES = ["settings.json", "CLAUDE.md"] as const;
const MCP_RUN_OWNER_MARKER = ".paperclip-mcp-run";
const MCP_SWEEP_MAX_ENTRIES = 128;
const mcpSweepCursorByStateDir = new Map<string, number>();

type McpRunOwner = { owner: "paperclip-claude-mcp"; runId: string; pid: number; createdAt: string };

function assertSafeRunId(runId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error("Claude MCP runId must be a safe path segment");
}

export async function cleanupPaperclipClaudeMcpRun(stateDir: string, runId: string): Promise<void> {
  assertSafeRunId(runId);
  const runDir = path.join(stateDir, "runs", runId);
  const marker = await fs.readFile(path.join(runDir, MCP_RUN_OWNER_MARKER), "utf8").catch(() => null);
  if (!marker) return;
  let owned = marker.trim() === runId; // cleanup compatibility for pre-lease markers
  try {
    const parsed = JSON.parse(marker) as Partial<McpRunOwner>;
    owned = parsed.owner === "paperclip-claude-mcp" && parsed.runId === runId;
  } catch {}
  if (!owned) return;
  await fs.rm(runDir, { recursive: true, force: true });
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}

/**
 * Recover bearer-bearing configs left by SIGKILL/reboot. Only new-format,
 * Paperclip-owned directories whose owner process is provably gone are
 * removed. Live leases, foreign entries, legacy markers and symlinks fail
 * closed. The bounded scan prevents an operator-controlled state directory
 * from turning adapter startup into unbounded filesystem work.
 */
export async function sweepAbandonedPaperclipClaudeMcpRuns(
  stateDir: string,
  options: {
    isProcessAlive?: (pid: number) => boolean;
    onWarning?: (message: string) => void;
    removeRun?: (runDir: string) => Promise<void>;
  } = {},
): Promise<void> {
  const runsDir = path.join(stateDir, "runs");
  let entries: Dirent[];
  try {
    const runsStat = await fs.lstat(runsDir).catch(() => null);
    if (!runsStat || !runsStat.isDirectory() || runsStat.isSymbolicLink()) return;
    entries = await fs.readdir(runsDir, { withFileTypes: true });
  } catch (error) {
    options.onWarning?.(`Claude MCP residue scan skipped: ${String(error)}`);
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const start = mcpSweepCursorByStateDir.get(stateDir) ?? 0;
  const batch = Array.from(
    { length: Math.min(MCP_SWEEP_MAX_ENTRIES, entries.length) },
    (_, offset) => entries[(start + offset) % entries.length]!,
  );
  mcpSweepCursorByStateDir.set(stateDir, entries.length === 0 ? 0 : (start + batch.length) % entries.length);
  for (const entry of batch) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[A-Za-z0-9_-]+$/.test(entry.name)) continue;
    const runDir = path.join(runsDir, entry.name);
    const markerPath = path.join(runDir, MCP_RUN_OWNER_MARKER);
    const markerStat = await fs.lstat(markerPath).catch(() => null);
    if (!markerStat?.isFile() || markerStat.isSymbolicLink()) continue;
    let owner: Partial<McpRunOwner>;
    try {
      owner = JSON.parse(await fs.readFile(markerPath, "utf8")) as Partial<McpRunOwner>;
    } catch {
      continue;
    }
    if (
      owner.owner !== "paperclip-claude-mcp" ||
      owner.runId !== entry.name ||
      typeof owner.pid !== "number" ||
      typeof owner.createdAt !== "string" ||
      !Number.isFinite(Date.parse(owner.createdAt)) ||
      (options.isProcessAlive ?? processIsAlive)(owner.pid)
    ) continue;
    // Re-check the owned directory itself immediately before recursive removal.
    const finalStat = await fs.lstat(runDir).catch(() => null);
    if (!finalStat?.isDirectory() || finalStat.isSymbolicLink()) continue;
    try {
      await (options.removeRun ?? ((candidate) => fs.rm(candidate, { recursive: true, force: true })))(runDir);
    } catch (error) {
      options.onWarning?.(`Claude MCP residue cleanup skipped for ${entry.name}: ${String(error)}`);
    }
  }
}

/** Whitelist for disposable shadow/read-only Claude config staging. */
const DISPOSABLE_CLAUDE_CONFIG_FILES = [
  ".credentials.json",
  "credentials.json",
  "settings.json",
  "CLAUDE.md",
] as const;

interface SeedFile {
  name: string;
  sourcePath: string;
  contents: Buffer;
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

function isAlreadyExistsError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? error.code : null;
  return code === "EEXIST" || code === "ENOTEMPTY";
}

function sanitizeRemoteClaudeSettings(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return JSON.stringify({ permissions: { defaultMode: "default" } });
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return JSON.stringify({ permissions: { defaultMode: "default" } });
  }

  const settings = { ...(parsed as Record<string, unknown>) };
  settings.permissions = { defaultMode: "default" };
  delete settings.hooks;
  delete settings.mcpServers;
  delete settings.permissionMode;
  delete settings.skipDangerousModePermissionPrompt;
  return JSON.stringify(settings);
}

async function collectSeedFiles(sourceDir: string): Promise<SeedFile[]> {
  const files: SeedFile[] = [];
  for (const name of SEEDED_SHARED_FILES) {
    const sourcePath = path.join(sourceDir, name);
    if (!(await pathExists(sourcePath))) continue;
    const rawContents = await fs.readFile(sourcePath);
    const contents = name === "settings.json"
      ? Buffer.from(sanitizeRemoteClaudeSettings(rawContents.toString("utf8")), "utf8")
      : rawContents;
    files.push({ name, sourcePath, contents });
  }
  return files;
}

async function buildSeedSnapshotKey(files: SeedFile[]): Promise<string> {
  if (files.length === 0) return "empty";
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.name);
    hash.update("\0");
    hash.update(file.contents);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

async function materializeSeedSnapshot(input: {
  rootDir: string;
  snapshotKey: string;
  files: SeedFile[];
}): Promise<string> {
  const targetDir = path.join(input.rootDir, input.snapshotKey);
  if (await pathExists(targetDir)) {
    return targetDir;
  }

  await fs.mkdir(input.rootDir, { recursive: true });
  const stagingDir = await fs.mkdtemp(path.join(input.rootDir, ".tmp-"));
  try {
    for (const file of input.files) {
      await fs.writeFile(path.join(stagingDir, file.name), file.contents);
    }
    try {
      await fs.rename(stagingDir, targetDir);
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
      await fs.rm(stagingDir, { recursive: true, force: true });
    }
  } catch (error) {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  return targetDir;
}

export function resolveSharedClaudeConfigDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = nonEmpty(env.CLAUDE_CONFIG_DIR);
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), ".claude");
}

/**
 * Create a unique disposable Claude config directory for shadow/read-only lanes.
 * Copies only provider auth files plus settings.json and CLAUDE.md from `sourceDir`,
 * sanitizes settings with remote-settings safety rules, and applies private permissions.
 * On unexpected copy error the partial temp directory is removed and the error is rethrown.
 * The caller owns removing the returned directory when finished.
 */
export async function createDisposableClaudeConfigDir(sourceDir: string): Promise<string> {
  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-disposable-"));
  try {
    await fs.chmod(stagingDir, 0o700);
    for (const name of DISPOSABLE_CLAUDE_CONFIG_FILES) {
      const sourcePath = path.join(sourceDir, name);
      if (!(await pathExists(sourcePath))) continue;
      const rawContents = await fs.readFile(sourcePath);
      const contents = name === "settings.json"
        ? Buffer.from(sanitizeRemoteClaudeSettings(rawContents.toString("utf8")), "utf8")
        : rawContents;
      await fs.writeFile(path.join(stagingDir, name), contents, { mode: 0o600 });
    }
    return stagingDir;
  } catch (error) {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export function resolveManagedClaudeConfigSeedDir(
  env: NodeJS.ProcessEnv,
  companyId?: string,
): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  return companyId
    ? path.resolve(instanceRoot, "companies", companyId, "claude-config-seed")
    : path.resolve(instanceRoot, "claude-config-seed");
}

export function resolveManagedClaudeRuntimeStateDir(
  env: NodeJS.ProcessEnv,
  companyId: string,
  agentId: string,
): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  return path.join(instanceRoot, "companies", companyId, "agents", agentId, "claude-runtime");
}

/** Profile MCP servers re-injected under --strict-mcp-config. Default: cockpit only. */
export const PROFILE_MCP_SERVER_ALLOWLIST: readonly string[] = ["paperclip"];

function isStringMap(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}

/**
 * Rewrite an allowlisted profile MCP entry with known fields only.
 * Rejects network transports and malformed types that would invalidate the whole config file.
 */
function sanitizeAllowlistedProfileMcpEntry(entry: unknown): Record<string, unknown> | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;

  if (typeof record.url === "string") return null;
  const type = typeof record.type === "string" ? record.type.trim().toLowerCase() : "";
  if (type === "http" || type === "sse") return null;
  if (type && type !== "stdio") return null;

  if (typeof record.command !== "string" || record.command.trim().length === 0) return null;

  const sanitized: Record<string, unknown> = { command: record.command };
  if ("args" in record) {
    if (!Array.isArray(record.args) || !record.args.every((arg) => typeof arg === "string")) {
      return null;
    }
    sanitized.args = record.args;
  }
  if ("env" in record) {
    if (!isStringMap(record.env)) return null;
    sanitized.env = record.env;
  }
  if ("cwd" in record) {
    if (typeof record.cwd !== "string") return null;
    sanitized.cwd = record.cwd;
  }
  if (type === "stdio") sanitized.type = "stdio";
  return sanitized;
}

/**
 * Candidate paths for the Claude user profile `.claude.json`, in preference order:
 * 1. Inside `CLAUDE_CONFIG_DIR` — common when that env var is set explicitly
 *    (e.g. `~/.claude-jarvis/.claude.json`).
 * 2. Sibling of `CLAUDE_CONFIG_DIR` — default Claude Code layout
 *    (`$HOME/.claude` + `$HOME/.claude.json`).
 */
function resolveClaudeProfileJsonCandidates(claudeConfigDir: string): string[] {
  const inside = path.join(claudeConfigDir, ".claude.json");
  const sibling = path.join(path.dirname(claudeConfigDir), ".claude.json");
  return inside === sibling ? [inside] : [inside, sibling];
}

function extractAllowlistedProfileMcpServers(
  parsed: Record<string, unknown>,
  allowlist: readonly string[],
): Record<string, unknown> | null {
  const mcpServers = parsed.mcpServers;
  if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers)) {
    return null;
  }
  const entries = mcpServers as Record<string, unknown>;
  if (Object.keys(entries).length === 0) return null;

  const allowSet = new Set(allowlist);
  const allowed: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(entries)) {
    if (!allowSet.has(name)) continue;
    const sanitized = sanitizeAllowlistedProfileMcpEntry(entry);
    if (!sanitized) continue;
    allowed[name] = sanitized;
  }
  // Prefer the first profile that yields ≥1 allowlisted entry after filtering —
  // a network-only inside profile must not block the sibling that holds cockpit.
  return Object.keys(allowed).length > 0 ? allowed : null;
}

async function readAllowlistedMcpServersFromProfile(
  claudeConfigDir: string,
  allowlist: readonly string[],
  readFile: (profilePath: string) => Promise<string> = (profilePath) =>
    fs.readFile(profilePath, "utf8"),
): Promise<Record<string, unknown>> {
  for (const profilePath of resolveClaudeProfileJsonCandidates(claudeConfigDir)) {
    let raw: string;
    try {
      raw = await readFile(profilePath);
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const allowed = extractAllowlistedProfileMcpServers(
      parsed as Record<string, unknown>,
      allowlist,
    );
    if (allowed === null) continue;
    return allowed;
  }
  return {};
}

export async function writePaperclipClaudeMcpConfig(input: {
  stateDir: string;
  runId: string;
  servers: AdapterRuntimeMcpServer[];
  /**
   * When set (local runs only), merge allowlisted MCP servers from the Claude profile.
   * Under --strict-mcp-config the CLI ignores the profile; this re-injects cockpit.
   */
  claudeConfigDir?: string;
  /** Defaults to PROFILE_MCP_SERVER_ALLOWLIST (`["paperclip"]`). */
  profileMcpServerAllowlist?: readonly string[];
  /** @internal test seam — override profile file reads. */
  _readProfileFile?: (profilePath: string) => Promise<string>;
}): Promise<string> {
  assertSafeRunId(input.runId);
  const configDir = path.join(input.stateDir, "runs", input.runId, "mcp");
  const configPath = path.join(configDir, "mcp-config.json");
  const usedNames = new Set<string>();
  const mcpServers: Record<string, unknown> = {};
  for (const server of input.servers) {
    let name = server.name;
    if (usedNames.has(name)) name = `${name}-${server.connectionId.slice(0, 8)}`;
    let suffix = 2;
    while (usedNames.has(name)) {
      name = `${server.name}-${server.connectionId.slice(0, 8)}-${suffix}`;
      suffix += 1;
    }
    usedNames.add(name);
    mcpServers[name] = {
      type: "http",
      url: server.url,
      headers: { Authorization: `Bearer ${server.token}` },
    };
  }

  // Profile merge is only useful when --strict-mcp-config is used (servers.length > 0).
  // Allowlist-only: never copy arbitrary local stdio (e.g. mcp-remote proxies).
  if (input.claudeConfigDir && input.servers.length > 0) {
    const allowlist = input.profileMcpServerAllowlist ?? PROFILE_MCP_SERVER_ALLOWLIST;
    const profileServers = await readAllowlistedMcpServersFromProfile(
      input.claudeConfigDir,
      allowlist,
      input._readProfileFile,
    );
    for (const [name, entry] of Object.entries(profileServers)) {
      if (usedNames.has(name)) continue;
      usedNames.add(name);
      mcpServers[name] = entry;
    }
  }

  await fs.mkdir(configDir, { recursive: true });
  await fs.chmod(path.dirname(configDir), 0o700);
  const owner: McpRunOwner = {
    owner: "paperclip-claude-mcp",
    runId: input.runId,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(path.dirname(configDir), MCP_RUN_OWNER_MARKER), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  await fs.writeFile(configPath, JSON.stringify({ mcpServers }), { mode: 0o600 });
  return configPath;
}

export async function prepareClaudeConfigSeed(
  env: NodeJS.ProcessEnv,
  onLog: AdapterExecutionContext["onLog"],
  companyId?: string,
): Promise<string> {
  const sourceDir = resolveSharedClaudeConfigDir(env);
  const targetRootDir = resolveManagedClaudeConfigSeedDir(env, companyId);

  if (path.resolve(sourceDir) === path.resolve(targetRootDir)) {
    return targetRootDir;
  }

  const copiedFiles = await collectSeedFiles(sourceDir);
  const snapshotKey = await buildSeedSnapshotKey(copiedFiles);
  const targetDir = await materializeSeedSnapshot({
    rootDir: targetRootDir,
    snapshotKey,
    files: copiedFiles,
  });

  if (copiedFiles.length > 0) {
    await onLog(
      "stdout",
      `[paperclip] Prepared Claude config seed "${targetDir}" from "${sourceDir}" (${copiedFiles.map((file) => file.name).join(", ")}).\n`,
    );
  } else {
    await onLog(
      "stdout",
      `[paperclip] No local Claude config seed files were found in "${sourceDir}". Remote Claude auth may still require login.\n`,
    );
  }

  return targetDir;
}

export function buildRemoteClaudeConfigMaterializationCommand(input: {
  remoteClaudeConfigDir: string;
  remoteClaudeConfigSeedDir: string;
  persistentProjectsDir?: string;
  persistentProjectsRemoteCwd?: string;
}): string {
  const projectsLink = input.persistentProjectsDir
    ? `${buildRemotePrivateStoreProvision({
        remoteCwd: input.persistentProjectsRemoteCwd ?? "",
        adapterKey: "claude",
        storeDir: input.persistentProjectsDir,
      })} && ` +
      `rm -rf ${shellQuote(path.posix.join(input.remoteClaudeConfigDir, "projects"))} && ` +
      `ln -s ${shellQuote(input.persistentProjectsDir)} ${shellQuote(path.posix.join(input.remoteClaudeConfigDir, "projects"))} && `
    : "";
  return `mkdir -p ${shellQuote(input.remoteClaudeConfigDir)} && ` +
    `if [ -d ${shellQuote(input.remoteClaudeConfigSeedDir)} ]; then ` +
    `cp -R ${shellQuote(`${input.remoteClaudeConfigSeedDir}/.`)} ${shellQuote(input.remoteClaudeConfigDir)}/; ` +
    `fi; ` +
    `for file in .credentials.json credentials.json; do ` +
    `if [ -n "\${HOME:-}" ] && [ -f "\${HOME}/.claude/\${file}" ] && [ ! -f ${shellQuote(input.remoteClaudeConfigDir)}/"\${file}" ]; then ` +
    `cp "\${HOME}/.claude/\${file}" ${shellQuote(input.remoteClaudeConfigDir)}/"\${file}"; ` +
    `fi; ` +
    `done; ` + projectsLink + `:`;
}

export async function materializeRemoteClaudeConfig(input: {
  runId: string;
  target: AdapterExecutionTarget | null | undefined;
  remoteClaudeConfigDir: string;
  remoteClaudeConfigSeedDir: string;
  persistentProjectsDir?: string;
  persistentProjectsRemoteCwd?: string;
  options: AdapterExecutionTargetShellOptions;
}): Promise<void> {
  await runAdapterExecutionTargetShellCommand(
    input.runId,
    input.target,
    buildRemoteClaudeConfigMaterializationCommand({
      remoteClaudeConfigDir: input.remoteClaudeConfigDir,
      remoteClaudeConfigSeedDir: input.remoteClaudeConfigSeedDir,
      persistentProjectsDir: input.persistentProjectsDir,
      persistentProjectsRemoteCwd: input.persistentProjectsRemoteCwd,
    }),
    input.options,
  );
}
