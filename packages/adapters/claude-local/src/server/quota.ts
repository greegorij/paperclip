import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ProviderQuotaResult, QuotaWindow } from "@paperclipai/adapter-utils";

const execFileAsync = promisify(execFile);

/** Hard cap on captured probe stdout+stderr so a noisy CLI cannot OOM the host. */
const CLAUDE_USAGE_CAPTURE_MAX_BYTES = 8 * 1024 * 1024;
/** Grace between SIGTERM and SIGKILL when tearing down a usage probe tree. */
const CLAUDE_USAGE_PROBE_KILL_GRACE_MS = 1_000;

const CLAUDE_USAGE_SOURCE_OAUTH = "anthropic-oauth";
const CLAUDE_USAGE_SOURCE_CLI = "claude-cli";

export function claudeConfigDir(): string {
  const fromEnv = process.env.CLAUDE_CONFIG_DIR;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return fromEnv.trim();
  return path.join(os.homedir(), ".claude");
}

function hasNonEmptyProcessEnv(key: string): boolean {
  const value = process.env[key];
  return typeof value === "string" && value.trim().length > 0;
}

function createClaudeQuotaEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== "string") continue;
    if (key.startsWith("ANTHROPIC_")) continue;
    env[key] = value;
  }
  return env;
}

function stripBackspaces(text: string): string {
  let out = "";
  for (const char of text) {
    if (char === "\b") {
      out = out.slice(0, -1);
    } else {
      out += char;
    }
  }
  return out;
}

function stripAnsi(text: string): string {
  return text
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function cleanTerminalText(text: string): string {
  return stripAnsi(stripBackspaces(text))
    .replace(/\u0000/g, "")
    .replace(/\r/g, "\n");
}

function normalizeForLabelSearch(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function trimToLatestUsagePanel(text: string): string | null {
  const lower = text.toLowerCase();
  const settingsIndex = lower.lastIndexOf("settings:");
  if (settingsIndex < 0) return null;
  let tail = text.slice(settingsIndex);
  const tailLower = tail.toLowerCase();
  if (!tailLower.includes("usage")) return null;
  if (!tailLower.includes("current session") && !tailLower.includes("loading usage")) return null;
  const stopMarkers = [
    "status dialog dismissed",
    "checking for updates",
    "press ctrl-c again to exit",
  ];
  let stopIndex = -1;
  for (const marker of stopMarkers) {
    const markerIndex = tailLower.indexOf(marker);
    if (markerIndex >= 0 && (stopIndex === -1 || markerIndex < stopIndex)) {
      stopIndex = markerIndex;
    }
  }
  if (stopIndex >= 0) {
    tail = tail.slice(0, stopIndex);
  }
  return tail;
}

async function readClaudeTokenFromFile(credPath: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await fs.readFile(credPath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const oauth = obj["claudeAiOauth"];
  if (typeof oauth !== "object" || oauth === null) return null;
  const token = (oauth as Record<string, unknown>)["accessToken"];
  return typeof token === "string" && token.length > 0 ? token : null;
}

interface ClaudeAuthStatus {
  loggedIn: boolean;
  authMethod: string | null;
  subscriptionType: string | null;
}

export async function readClaudeAuthStatus(): Promise<ClaudeAuthStatus | null> {
  try {
    const { stdout } = await execFileAsync("claude", ["auth", "status"], {
      env: process.env,
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    return {
      loggedIn: parsed.loggedIn === true,
      authMethod: typeof parsed.authMethod === "string" ? parsed.authMethod : null,
      subscriptionType: typeof parsed.subscriptionType === "string" ? parsed.subscriptionType : null,
    };
  } catch {
    return null;
  }
}

function describeClaudeSubscriptionAuth(status: ClaudeAuthStatus | null): string | null {
  if (!status?.loggedIn || status.authMethod !== "claude.ai") return null;
  return status.subscriptionType
    ? `Claude is logged in via claude.ai (${status.subscriptionType})`
    : "Claude is logged in via claude.ai";
}

export async function readClaudeToken(): Promise<string | null> {
  const configDir = claudeConfigDir();
  for (const filename of [".credentials.json", "credentials.json"]) {
    const token = await readClaudeTokenFromFile(path.join(configDir, filename));
    if (token) return token;
  }
  return null;
}

interface AnthropicUsageWindow {
  utilization?: number | null;
  resets_at?: string | null;
}

interface AnthropicExtraUsage {
  is_enabled?: boolean | null;
  monthly_limit?: number | null;
  used_credits?: number | null;
  utilization?: number | null;
  currency?: string | null;
}

interface AnthropicUsageResponse {
  five_hour?: AnthropicUsageWindow | null;
  seven_day?: AnthropicUsageWindow | null;
  seven_day_sonnet?: AnthropicUsageWindow | null;
  seven_day_opus?: AnthropicUsageWindow | null;
  extra_usage?: AnthropicExtraUsage | null;
}

function formatCurrencyAmount(value: number, currency: string | null | undefined): string {
  const code = typeof currency === "string" && currency.trim().length > 0 ? currency.trim().toUpperCase() : "USD";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: code,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatExtraUsageLabel(extraUsage: AnthropicExtraUsage): string | null {
  const monthlyLimit = extraUsage.monthly_limit;
  const usedCredits = extraUsage.used_credits;
  if (
    typeof monthlyLimit !== "number" ||
    !Number.isFinite(monthlyLimit) ||
    typeof usedCredits !== "number" ||
    !Number.isFinite(usedCredits)
  ) {
    return null;
  }
  // API returns values in cents — convert to dollars for display
  return `${formatCurrencyAmount(usedCredits / 100, extraUsage.currency)} / ${formatCurrencyAmount(monthlyLimit / 100, extraUsage.currency)}`;
}

/** Convert a utilization value to a 0-100 integer percent. Returns null for null/undefined input.
 *  Handles both 0-1 fractions (legacy) and 0-100 percentages (current API). */
export function toPercent(utilization: number | null | undefined): number | null {
  if (utilization == null) return null;
  return Math.min(100, Math.round(utilization < 1 ? utilization * 100 : utilization));
}

/** fetch with an abort-based timeout so a hanging provider api doesn't block the response indefinitely */
export async function fetchWithTimeout(url: string, init: RequestInit, ms = 8000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchClaudeQuota(token: string): Promise<QuotaWindow[]> {
  const resp = await fetchWithTimeout("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
    },
  });
  if (!resp.ok) throw new Error(`anthropic usage api returned ${resp.status}`);
  const body = (await resp.json()) as AnthropicUsageResponse;
  const windows: QuotaWindow[] = [];

  if (body.five_hour != null) {
    windows.push({
      label: "Current session",
      usedPercent: toPercent(body.five_hour.utilization),
      resetsAt: body.five_hour.resets_at ?? null,
      valueLabel: null,
      detail: null,
    });
  }
  if (body.seven_day != null) {
    windows.push({
      label: "Current week (all models)",
      usedPercent: toPercent(body.seven_day.utilization),
      resetsAt: body.seven_day.resets_at ?? null,
      valueLabel: null,
      detail: null,
    });
  }
  if (body.seven_day_sonnet != null) {
    windows.push({
      label: "Current week (Sonnet only)",
      usedPercent: toPercent(body.seven_day_sonnet.utilization),
      resetsAt: body.seven_day_sonnet.resets_at ?? null,
      valueLabel: null,
      detail: null,
    });
  }
  if (body.seven_day_opus != null) {
    windows.push({
      label: "Current week (Opus only)",
      usedPercent: toPercent(body.seven_day_opus.utilization),
      resetsAt: body.seven_day_opus.resets_at ?? null,
      valueLabel: null,
      detail: null,
    });
  }
  if (body.extra_usage != null) {
    windows.push({
      label: "Extra usage",
      usedPercent: body.extra_usage.is_enabled === false ? null : toPercent(body.extra_usage.utilization),
      resetsAt: null,
      valueLabel:
        body.extra_usage.is_enabled === false
          ? "Not enabled"
          : formatExtraUsageLabel(body.extra_usage),
      detail:
        body.extra_usage.is_enabled === false
          ? "Extra usage not enabled"
          : "Monthly extra usage pool",
    });
  }
  return windows;
}

function usageOutputLooksRelevant(text: string): boolean {
  const normalized = normalizeForLabelSearch(text);
  return normalized.includes("currentsession")
    || normalized.includes("currentweek")
    || normalized.includes("loadingusage")
    || normalized.includes("failedtoloadusagedata")
    || normalized.includes("tokenexpired")
    || normalized.includes("authenticationerror")
    || normalized.includes("ratelimited");
}

function usageOutputLooksComplete(text: string): boolean {
  const normalized = normalizeForLabelSearch(text);
  if (
    normalized.includes("failedtoloadusagedata")
    || normalized.includes("tokenexpired")
    || normalized.includes("authenticationerror")
    || normalized.includes("ratelimited")
  ) {
    return true;
  }
  return normalized.includes("currentsession")
    && (normalized.includes("currentweek") || normalized.includes("extrausage"))
    && /[0-9]{1,3}(?:\.[0-9]+)?%/i.test(text);
}

function extractUsageError(text: string): string | null {
  const lower = text.toLowerCase();
  const compact = lower.replace(/\s+/g, "");
  if (lower.includes("token_expired") || lower.includes("token has expired")) {
    return "Claude CLI token expired. Run `claude login` to refresh.";
  }
  if (lower.includes("authentication_error")) {
    return "Claude CLI authentication error. Run `claude login`.";
  }
  if (lower.includes("rate_limit_error") || lower.includes("rate limited") || compact.includes("ratelimited")) {
    return "Claude CLI usage endpoint is rate limited right now. Please try again later.";
  }
  if (lower.includes("failed to load usage data") || compact.includes("failedtoloadusagedata")) {
    return "Claude CLI could not load usage data. Open the CLI and retry `/usage`.";
  }
  return null;
}

function percentFromLine(line: string): number | null {
  const match = line.match(/([0-9]{1,3}(?:\.[0-9]+)?)\s*%/i);
  if (!match) return null;
  const rawValue = Number(match[1]);
  if (!Number.isFinite(rawValue)) return null;
  const clamped = Math.min(100, Math.max(0, rawValue));
  const lower = line.toLowerCase();
  if (lower.includes("remaining") || lower.includes("left") || lower.includes("available")) {
    return Math.max(0, Math.min(100, Math.round(100 - clamped)));
  }
  return Math.round(clamped);
}

function isQuotaLabel(line: string): boolean {
  const normalized = normalizeForLabelSearch(line);
  return normalized === "currentsession"
    || normalized === "currentweekallmodels"
    || normalized === "currentweeksonnetonly"
    || normalized === "currentweeksonnet"
    || normalized === "currentweekopusonly"
    || normalized === "currentweekopus"
    || normalized === "extrausage";
}

function canonicalQuotaLabel(line: string): string {
  switch (normalizeForLabelSearch(line)) {
    case "currentsession":
      return "Current session";
    case "currentweekallmodels":
      return "Current week (all models)";
    case "currentweeksonnetonly":
    case "currentweeksonnet":
      return "Current week (Sonnet only)";
    case "currentweekopusonly":
    case "currentweekopus":
      return "Current week (Opus only)";
    case "extrausage":
      return "Extra usage";
    default:
      return line;
  }
}

function formatClaudeCliDetail(label: string, lines: string[]): string | null {
  const normalizedLabel = normalizeForLabelSearch(label);
  if (normalizedLabel === "extrausage") {
    const compact = lines.join(" ").replace(/\s+/g, "").toLowerCase();
    if (compact.includes("extrausagenotenabled")) {
      return "Extra usage not enabled • /extra-usage to enable";
    }
    const firstLine = lines.find((line) => line.trim().length > 0) ?? null;
    return firstLine;
  }

  const resetLine = lines.find((line) => /^resets/i.test(line) || normalizeForLabelSearch(line).startsWith("resets"));
  if (!resetLine) return null;
  return resetLine
    .replace(/^Resets/i, "Resets ")
    .replace(/([A-Z][a-z]{2})(\d)/g, "$1 $2")
    .replace(/(\d)at(\d)/g, "$1 at $2")
    .replace(/(am|pm)\(/gi, "$1 (")
    .replace(/([A-Za-z])\(/g, "$1 (")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseClaudeCliUsageText(text: string): QuotaWindow[] {
  const cleaned = trimToLatestUsagePanel(cleanTerminalText(text)) ?? cleanTerminalText(text);
  const usageError = extractUsageError(cleaned);
  if (usageError) throw new Error(usageError);

  const lines = cleaned
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const sections: Array<{ label: string; lines: string[] }> = [];
  let current: { label: string; lines: string[] } | null = null;

  for (const line of lines) {
    if (isQuotaLabel(line)) {
      if (current) sections.push(current);
      current = { label: canonicalQuotaLabel(line), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) sections.push(current);

  const windows = sections.map<QuotaWindow>((section) => {
    const usedPercent = section.lines.map(percentFromLine).find((value) => value != null) ?? null;
    return {
      label: section.label,
      usedPercent,
      resetsAt: null,
      valueLabel: null,
      detail: formatClaudeCliDetail(section.label, section.lines),
    };
  });

  if (!windows.some((window) => normalizeForLabelSearch(window.label) === "currentsession")) {
    throw new Error("Could not parse Claude CLI usage output.");
  }
  return windows;
}

function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildClaudeCliShellProbeCommand(): string {
  const feed = "(sleep 2; printf '/usage\\r'; sleep 6; printf '\\033'; sleep 1; printf '\\003')";
  const claudeCommand = "claude --tools \"\"";
  if (process.platform === "darwin") {
    return `${feed} | script -q /dev/null ${claudeCommand}`;
  }
  return `${feed} | script -q -e -f -c ${quoteForShell(claudeCommand)} /dev/null`;
}

function listPosixPidPpidPairs(): Array<{ pid: number; ppid: number }> {
  try {
    const stdout = execFileSync("ps", ["-A", "-o", "pid=,ppid="], {
      encoding: "utf8",
      timeout: 3_000,
      maxBuffer: 1024 * 1024,
    });
    const pairs: Array<{ pid: number; ppid: number }> = [];
    for (const line of stdout.split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s*$/);
      if (!match) continue;
      pairs.push({ pid: Number(match[1]), ppid: Number(match[2]) });
    }
    return pairs;
  } catch {
    return [];
  }
}

function collectDescendantPids(rootPid: number): number[] {
  const childrenByParent = new Map<number, number[]>();
  for (const row of listPosixPidPpidPairs()) {
    const siblings = childrenByParent.get(row.ppid);
    if (siblings) siblings.push(row.pid);
    else childrenByParent.set(row.ppid, [row.pid]);
  }
  const descendants: number[] = [];
  const stack = [rootPid];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    for (const childPid of childrenByParent.get(pid) ?? []) {
      descendants.push(childPid);
      stack.push(childPid);
    }
  }
  return descendants;
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already exited or not signalable.
  }
}

/**
 * Tear down a usage-probe process tree.
 * POSIX: prefer the detached process group, then signal any PPID-descendants
 * that may have left the group (e.g. `script` / `claude` after setsid).
 * `rememberedPids` accumulates every PID seen across snapshots so a child that
 * survives SIGTERM, leaves the session, and gets reparented is still targeted
 * by the later SIGKILL pass. The SIGTERM→SIGKILL grace stays short/bounded to
 * limit PID-reuse risk for those remembered IDs.
 * Windows: signal only the direct child (safe fallback; no process groups).
 */
function signalProbeProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
  useProcessGroup: boolean,
  rememberedPids?: Set<number>,
): void {
  const rootPid = child.pid;
  if (rootPid == null || rootPid <= 0) return;

  if (useProcessGroup) {
    const descendants = collectDescendantPids(rootPid);
    if (rememberedPids) {
      for (const pid of descendants) {
        rememberedPids.add(pid);
      }
    }
    try {
      process.kill(-rootPid, signal);
    } catch {
      // Group may already be gone; fall through to direct signals.
    }
    const targets = rememberedPids && rememberedPids.size > 0
      ? rememberedPids
      : descendants;
    for (const pid of targets) {
      if (pid === rootPid) continue;
      signalPid(pid, signal);
    }
  }

  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill(signal);
    } catch {
      signalPid(rootPid, signal);
    }
  }
}

function resolveProbeOutputOrThrow(input: {
  stdout: string;
  stderr: string;
  timedOut: boolean;
  overflowed: boolean;
  spawnError: Error | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}): string {
  const output = `${input.stdout}${input.stderr}`;
  const cleaned = cleanTerminalText(output);
  if (usageOutputLooksComplete(cleaned)) return output;
  if (usageOutputLooksRelevant(cleaned)) {
    throw new Error("Claude CLI usage probe ended before rendering usage.");
  }
  if (input.overflowed) {
    throw new Error(
      `Claude CLI usage probe exceeded the ${CLAUDE_USAGE_CAPTURE_MAX_BYTES}-byte output limit.`,
    );
  }
  if (input.timedOut) {
    throw new Error("Claude CLI usage probe timed out.");
  }
  if (input.spawnError) {
    throw input.spawnError;
  }
  throw new Error(
    `Claude CLI usage probe exited without usable output (code=${input.exitCode ?? "null"} signal=${input.signal ?? "null"}).`,
  );
}

export async function captureClaudeCliUsageText(timeoutMs = 12_000): Promise<string> {
  const command = buildClaudeCliShellProbeCommand();
  const useProcessGroup = process.platform !== "win32";

  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let overflowed = false;
    let spawnError: Error | null = null;
    let stdout = "";
    let stderr = "";
    let capturedBytes = 0;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    let killFailsafeTimer: NodeJS.Timeout | null = null;
    let terminationStarted = false;
    // PIDs observed at each tree snapshot (SIGTERM + SIGKILL). Survives
    // reparenting between the two passes; kept only for the short kill grace.
    const rememberedDescendantPids = new Set<number>();

    const child = spawn("sh", ["-c", command], {
      env: createClaudeQuotaEnv(),
      // Own process group on POSIX so timeout can signal the whole probe tree.
      detached: useProcessGroup,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const clearTimers = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (killFailsafeTimer) clearTimeout(killFailsafeTimer);
      timeoutTimer = null;
      killTimer = null;
      killFailsafeTimer = null;
    };

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      // Root may exit during the SIGTERM grace (pipeline drained) while a
      // detached, SIGTERM-ignoring descendant was reparented. Clear timers only
      // after a final SIGKILL pass over every PID remembered from snapshots.
      if (terminationStarted && useProcessGroup && rememberedDescendantPids.size > 0) {
        signalProbeProcessTree(child, "SIGKILL", useProcessGroup, rememberedDescendantPids);
      }
      clearTimers();
      rememberedDescendantPids.clear();
      try {
        fn();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };

    const settleFromCollectedOutput = () => {
      finish(() => {
        resolve(
          resolveProbeOutputOrThrow({
            stdout,
            stderr,
            timedOut,
            overflowed,
            spawnError,
            exitCode: child.exitCode,
            signal: child.signalCode,
          }),
        );
      });
    };

    const terminateProbeTree = () => {
      if (terminationStarted) return;
      terminationStarted = true;
      signalProbeProcessTree(child, "SIGTERM", useProcessGroup, rememberedDescendantPids);
      // Bounded grace: long enough for polite exit, short enough that remembered
      // PIDs are unlikely to be reused by an unrelated process before SIGKILL.
      killTimer = setTimeout(() => {
        signalProbeProcessTree(child, "SIGKILL", useProcessGroup, rememberedDescendantPids);
        // Direct child should emit `close` after SIGKILL; fail-safe if the handle stalls.
        // Re-check settled: SIGKILL may synchronously deliver `close` before we schedule.
        if (settled) return;
        killFailsafeTimer = setTimeout(() => settleFromCollectedOutput(), CLAUDE_USAGE_PROBE_KILL_GRACE_MS);
      }, CLAUDE_USAGE_PROBE_KILL_GRACE_MS);
    };

    const appendChunk = (stream: "stdout" | "stderr", chunk: Buffer | string) => {
      if (settled || overflowed) return;
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const nextBytes = Buffer.byteLength(text, "utf8");
      if (capturedBytes + nextBytes > CLAUDE_USAGE_CAPTURE_MAX_BYTES) {
        const remaining = Math.max(0, CLAUDE_USAGE_CAPTURE_MAX_BYTES - capturedBytes);
        if (remaining > 0) {
          const partial = Buffer.from(text, "utf8").subarray(0, remaining).toString("utf8");
          if (stream === "stdout") stdout += partial;
          else stderr += partial;
          capturedBytes += Buffer.byteLength(partial, "utf8");
        }
        overflowed = true;
        terminateProbeTree();
        return;
      }
      capturedBytes += nextBytes;
      if (stream === "stdout") stdout += text;
      else stderr += text;
    };

    child.stdout?.on("data", (chunk: Buffer | string) => appendChunk("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => appendChunk("stderr", chunk));

    child.once("error", (error) => {
      spawnError = error instanceof Error ? error : new Error(String(error));
      // `error` without a later `close` still needs settlement.
      settleFromCollectedOutput();
    });

    child.once("close", () => {
      settleFromCollectedOutput();
    });

    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        terminateProbeTree();
      }, timeoutMs);
    }
  });
}

export async function fetchClaudeCliQuota(): Promise<QuotaWindow[]> {
  const rawText = await captureClaudeCliUsageText();
  return parseClaudeCliUsageText(rawText);
}

function formatProviderError(source: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${source}: ${message}`;
}

export async function getQuotaWindows(): Promise<ProviderQuotaResult> {
  if (
    process.env.CLAUDE_CODE_USE_BEDROCK === "1" ||
    process.env.CLAUDE_CODE_USE_BEDROCK === "true" ||
    hasNonEmptyProcessEnv("ANTHROPIC_BEDROCK_BASE_URL")
  ) {
    return { provider: "anthropic", source: "bedrock", ok: true, windows: [] };
  }

  const authStatus = await readClaudeAuthStatus();
  const authDescription = describeClaudeSubscriptionAuth(authStatus);
  const token = await readClaudeToken();

  const errors: string[] = [];

  if (token) {
    try {
      const windows = await fetchClaudeQuota(token);
      return { provider: "anthropic", source: CLAUDE_USAGE_SOURCE_OAUTH, ok: true, windows };
    } catch (error) {
      errors.push(formatProviderError("Anthropic OAuth usage", error));
    }
  }

  try {
    const windows = await fetchClaudeCliQuota();
    return { provider: "anthropic", source: CLAUDE_USAGE_SOURCE_CLI, ok: true, windows };
  } catch (error) {
    errors.push(formatProviderError("Claude CLI /usage", error));
  }

  if (hasNonEmptyProcessEnv("ANTHROPIC_API_KEY") && !authDescription) {
    return {
      provider: "anthropic",
      ok: false,
      error:
        errors[0]
        ?? "ANTHROPIC_API_KEY is set and no local Claude subscription session is available for quota polling",
      windows: [],
    };
  }

  if (authDescription) {
    return {
      provider: "anthropic",
      ok: false,
      error:
        errors.length > 0
          ? `${authDescription}, but quota polling failed (${errors.join("; ")})`
          : `${authDescription}, but Paperclip could not load subscription quota data`,
      windows: [],
    };
  }

  return {
    provider: "anthropic",
    ok: false,
    error: errors[0] ?? "no local claude auth token",
    windows: [],
  };
}
