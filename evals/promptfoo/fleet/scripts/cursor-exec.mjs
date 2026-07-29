#!/usr/bin/env node
/**
 * cursor-exec.mjs — Promptfoo custom exec provider for Cursor auto
 *
 * Promptfoo custom exec providers pass the rendered prompt as the first
 * script argument. In Node ESM: process.argv[0]=node, process.argv[1]=script,
 * so process.argv[2] is the prompt string.
 *
 * Invokes cursor-agent in ask mode inside a fresh mkdtemp directory.
 * The temp directory is always deleted on exit (success, error, or timeout).
 *
 * Resolver: CURSOR_AGENT_PATH env var → cursor-agent on PATH.
 *
 * Safety invariants:
 *   1. Working directory is a fresh mkdtemp dir — never the repo.
 *   2. --mode ask prevents any file writes.
 *   3. Hard timeout via child_process spawnSync `timeout` option (CURSOR_EVAL_TIMEOUT_MS, default 120 s).
 *   4. Temp dir is cleaned on every exit path.
 *   5. No auth data printed in output.
 *
 * Unit tests (no paid calls): cursor-exec.test.js
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const _rawTimeout = process.env.CURSOR_EVAL_TIMEOUT_MS;
const TIMEOUT_MS = (() => {
  if (_rawTimeout !== undefined && _rawTimeout !== "") {
    const parsed = Number(_rawTimeout);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(
        `CURSOR_EVAL_TIMEOUT_MS must be a positive integer, got: ${JSON.stringify(_rawTimeout)}`
      );
    }
    return parsed;
  }
  return 120_000;
})();

/**
 * Locate the cursor-agent executable.
 * Priority: CURSOR_AGENT_PATH env var → cursor-agent on PATH.
 */
function resolveCursorAgent() {
  const envPath = process.env.CURSOR_AGENT_PATH;
  if (envPath) return envPath;
  // Fall back to cursor-agent on PATH — spawnSync will resolve it.
  return "cursor-agent";
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

  const executable = resolveCursorAgent();
  const workDir = mkdtempSync(join(tmpdir(), "paperclip-fleet-eval-"));

  let exitCode = 0;
  let stdout = "";

  try {
    const result = spawnSync(
      executable,
      [
        "-p",
        "--output-format", "text",
        "--mode", "ask",
        "--model", "auto",
        "--sandbox", "enabled",
        "--trust",
        "--workspace", workDir,
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
        emit(`[CURSOR_TIMEOUT] cursor-agent exceeded ${TIMEOUT_MS} ms timeout.`, true);
        return;
      }
      if (result.error.code === "ENOENT" || result.error.code === "ENOTDIR") {
        emit(
          "[CURSOR_NOT_AVAILABLE] cursor-agent not found. " +
            "Set CURSOR_AGENT_PATH or add cursor-agent to PATH.",
          false
        );
        return;
      }
      emit(`[CURSOR_ERROR] spawn error: ${result.error.message}`, true);
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
    emit(`[CURSOR_ERROR] cursor-agent exited with code ${exitCode}.`, true);
    return;
  }

  emit(stdout.trim());
}

main();
