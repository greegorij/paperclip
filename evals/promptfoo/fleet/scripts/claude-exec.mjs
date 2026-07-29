#!/usr/bin/env node
/**
 * claude-exec.mjs — Promptfoo custom exec provider for Claude Code subscription CLI
 *
 * Promptfoo custom exec providers pass the rendered prompt as the first
 * script argument. In Node ESM: process.argv[0]=node, process.argv[1]=script,
 * so process.argv[2] is the prompt string.
 *
 * Invokes the real Claude Code CLI (claude) with model claude-sonnet-5 inside
 * a fresh mkdtemp directory. Using a subscription CLI rather than the direct
 * Anthropic API allows comparing actual subscription harness behavior.
 *
 * --bare is intentionally omitted so that local subscription or keychain auth
 * remains possible. The model call requires network; this harness does NOT
 * claim network isolation. What IS claimed:
 *   - No repo exposure  (cwd is a fresh mkdtemp, never the repo)
 *   - No tools          (--permission-mode plan + --tools "" disables all tool use)
 *   - No persisted session  (--no-session-persistence)
 *   - No settings/MCP inheritance  (--setting-sources "" + --strict-mcp-config +
 *                                   --mcp-config '{"mcpServers":{}}')
 *   - No slash commands (--disable-slash-commands)
 *
 * Resolver: CLAUDE_CODE_PATH env var → claude on PATH.
 *
 * Safety invariants:
 *   1. Working directory is a fresh mkdtemp dir — never the repo.
 *   2. Hard timeout via child_process spawnSync `timeout` option
 *      (CLAUDE_EVAL_TIMEOUT_MS, default 120000 ms).
 *   3. Temp dir is cleaned on every exit path including timeout.
 *   4. No env vars or credentials printed in output.
 *
 * Unit tests (no paid calls): claude-exec.test.js
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const _rawTimeout = process.env.CLAUDE_EVAL_TIMEOUT_MS;
const TIMEOUT_MS = (() => {
  if (_rawTimeout !== undefined && _rawTimeout !== "") {
    const parsed = Number(_rawTimeout);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(
        `CLAUDE_EVAL_TIMEOUT_MS must be a positive integer, got: ${JSON.stringify(_rawTimeout)}`
      );
    }
    return parsed;
  }
  return 120_000;
})();

/**
 * Locate the claude executable.
 * Priority: CLAUDE_CODE_PATH env var → claude on PATH.
 */
function resolveClaudeCode() {
  const envPath = process.env.CLAUDE_CODE_PATH;
  if (envPath) return envPath;
  return "claude";
}

/**
 * Emit a valid Promptfoo provider JSON object to stdout.
 */
function emit(output, error = false) {
  process.stdout.write(JSON.stringify({ output, error }) + "\n");
}

function main() {
  // Promptfoo passes the prompt as the first script argument → process.argv[2].
  const prompt = process.argv[2] ?? "";

  const executable = resolveClaudeCode();
  const workDir = mkdtempSync(join(tmpdir(), "paperclip-fleet-eval-"));

  let exitCode = 0;
  let stdout = "";

  try {
    const result = spawnSync(
      executable,
      [
        "-p",
        "--output-format", "text",
        "--model", "claude-sonnet-5",
        "--no-session-persistence",
        "--permission-mode", "plan",
        "--tools", "",
        "--setting-sources", "",
        "--disable-slash-commands",
        "--no-chrome",
        "--strict-mcp-config",
        "--mcp-config", JSON.stringify({ mcpServers: {} }),
        prompt,
      ],
      {
        encoding: "utf8",
        cwd: workDir,
        timeout: TIMEOUT_MS,
      }
    );

    exitCode = result.status ?? 1;
    stdout = result.stdout ?? "";

    if (result.error) {
      const errName = result.error.name ?? "";
      if (errName === "AbortError" || result.error.code === "ETIMEDOUT") {
        emit(`[CLAUDE_TIMEOUT] claude exceeded ${TIMEOUT_MS} ms timeout.`, true);
        return;
      }
      if (result.error.code === "ENOENT" || result.error.code === "ENOTDIR") {
        emit(
          "[CLAUDE_NOT_AVAILABLE] claude not found. " +
            "Set CLAUDE_CODE_PATH or add claude to PATH.",
          false
        );
        return;
      }
      emit(`[CLAUDE_ERROR] spawn error: ${result.error.message}`, true);
      return;
    }
  } finally {
    // Always clean temp dir.
    try {
      if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup — do not re-throw.
    }
  }

  if (exitCode !== 0) {
    emit(`[CLAUDE_ERROR] claude exited with code ${exitCode}.`, true);
    return;
  }

  emit(stdout.trim());
}

main();
