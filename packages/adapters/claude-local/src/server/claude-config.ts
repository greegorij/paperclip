import { createHash } from "node:crypto";
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

const SEEDED_SHARED_FILES = ["settings.json", "CLAUDE.md"] as const;

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
}): string {
  return `mkdir -p ${shellQuote(input.remoteClaudeConfigDir)} && ` +
    `if [ -d ${shellQuote(input.remoteClaudeConfigSeedDir)} ]; then ` +
    `cp -R ${shellQuote(`${input.remoteClaudeConfigSeedDir}/.`)} ${shellQuote(input.remoteClaudeConfigDir)}/; ` +
    `fi; ` +
    `for file in .credentials.json credentials.json; do ` +
    `if [ -n "\${HOME:-}" ] && [ -f "\${HOME}/.claude/\${file}" ] && [ ! -f ${shellQuote(input.remoteClaudeConfigDir)}/"\${file}" ]; then ` +
    `cp "\${HOME}/.claude/\${file}" ${shellQuote(input.remoteClaudeConfigDir)}/"\${file}"; ` +
    `fi; ` +
    `done`;
}

export async function materializeRemoteClaudeConfig(input: {
  runId: string;
  target: AdapterExecutionTarget | null | undefined;
  remoteClaudeConfigDir: string;
  remoteClaudeConfigSeedDir: string;
  options: AdapterExecutionTargetShellOptions;
}): Promise<void> {
  await runAdapterExecutionTargetShellCommand(
    input.runId,
    input.target,
    buildRemoteClaudeConfigMaterializationCommand({
      remoteClaudeConfigDir: input.remoteClaudeConfigDir,
      remoteClaudeConfigSeedDir: input.remoteClaudeConfigSeedDir,
    }),
    input.options,
  );
}
