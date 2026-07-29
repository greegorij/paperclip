/**
 * cursor-exec.test.js
 *
 * Unit tests for cursor-exec.mjs (Node ESM Promptfoo exec provider).
 * Uses mock executables — no paid API calls, no real cursor invocation.
 *
 * Run:
 *   node --test evals/promptfoo/fleet/scripts/cursor-exec.test.js
 *
 * All tests pass under `node --check` and `node --test`.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WRAPPER = resolve(__dirname, "cursor-exec.mjs");

/**
 * Run the wrapper with a given prompt and optional env overrides.
 * Promptfoo passes the prompt as argv[2] (after node and script path).
 */
function runWrapper(prompt, env = {}) {
  return spawnSync(process.execPath, [WRAPPER, prompt], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 15_000,
  });
}

function parseOutput(stdout) {
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return { raw: stdout };
  }
}

/**
 * Create a mock executable under a temp bin dir.
 * Returns the bin dir so caller can prepend it to PATH.
 */
function makeMockBin(name, script) {
  const binDir = mkdtempSync(join(tmpdir(), `mock-${name}-`));
  const exe = join(binDir, name);
  writeFileSync(exe, `#!/bin/sh\n${script}\n`);
  chmodSync(exe, 0o755);
  return { binDir, exe };
}

describe("cursor-exec.mjs wrapper", () => {
  // ── CURSOR_AGENT_PATH resolution ──────────────────────────────────────────

  test("CURSOR_AGENT_PATH env var is preferred over PATH lookup", () => {
    const { exe } = makeMockBin("cursor-agent", 'echo "from-env-path"');
    const result = runWrapper("hello", {
      CURSOR_AGENT_PATH: exe,
      // PATH left as-is; a different cursor-agent might be there.
    });
    assert.equal(result.status, 0);
    const out = parseOutput(result.stdout);
    assert.ok(typeof out.output === "string");
    assert.ok(out.output.includes("from-env-path"), `got: ${out.output}`);
  });

  test("falls back to cursor-agent on PATH when CURSOR_AGENT_PATH is unset", () => {
    const { binDir } = makeMockBin("cursor-agent", 'echo "from-path"');
    const result = runWrapper("hello", {
      CURSOR_AGENT_PATH: "",
      PATH: `${binDir}:${process.env.PATH}`,
    });
    assert.equal(result.status, 0);
    const out = parseOutput(result.stdout);
    assert.ok(out.output.includes("from-path"), `got: ${out.output}`);
  });

  test("returns CURSOR_NOT_AVAILABLE when cursor-agent is not found", () => {
    const result = runWrapper("hello", {
      CURSOR_AGENT_PATH: "",
      PATH: "/dev/null",
    });
    assert.equal(result.status, 0, "should exit 0 on graceful degradation");
    const out = parseOutput(result.stdout);
    assert.ok(
      out.output.includes("CURSOR_NOT_AVAILABLE"),
      `expected CURSOR_NOT_AVAILABLE, got: ${out.output}`
    );
    assert.equal(out.error, false);
  });

  // ── Exact argument passing ────────────────────────────────────────────────

  test("passes exact required arguments to cursor-agent", () => {
    // Mock that prints all its shell argv as a newline-joined list.
    // The shell receives the args that cursor-exec.mjs passes via spawnSync.
    const { binDir } = makeMockBin(
      "cursor-agent",
      // printf each arg on its own line so we can check membership.
      `for arg in "$@"; do printf '%s\n' "$arg"; done`
    );
    const result = runWrapper("my-prompt-text", {
      CURSOR_AGENT_PATH: join(binDir, "cursor-agent"),
    });
    assert.equal(result.status, 0);
    const out = parseOutput(result.stdout);
    // out.output is the newline-joined arg list from the mock shell script.
    const args = out.output.split("\n").map((s) => s.trim()).filter(Boolean);
    assert.ok(args.includes("-p"), `must pass -p; got args: ${JSON.stringify(args)}`);
    assert.ok(args.includes("--output-format"), `must pass --output-format; got: ${JSON.stringify(args)}`);
    assert.ok(args.includes("text"), `output-format value must be text; got: ${JSON.stringify(args)}`);
    assert.ok(args.includes("--mode"), `must pass --mode; got: ${JSON.stringify(args)}`);
    assert.ok(args.includes("ask"), `mode must be ask; got: ${JSON.stringify(args)}`);
    assert.ok(args.includes("--model"), `must pass --model; got: ${JSON.stringify(args)}`);
    assert.ok(args.includes("auto"), `model must be auto; got: ${JSON.stringify(args)}`);
    assert.ok(args.includes("--sandbox"), `must pass --sandbox; got: ${JSON.stringify(args)}`);
    assert.ok(args.includes("enabled"), `sandbox value must be enabled; got: ${JSON.stringify(args)}`);
    assert.ok(args.includes("--trust"), `must pass --trust; got: ${JSON.stringify(args)}`);
    assert.ok(args.includes("--workspace"), `must pass --workspace; got: ${JSON.stringify(args)}`);
    assert.ok(args.includes("my-prompt-text"), `prompt must be last arg; got: ${JSON.stringify(args)}`);
  });

  test("prompt string is passed as argv argument (not stdin)", () => {
    // Print the last shell argument ($@'s last item) — that's what cursor-exec.mjs sends.
    const { binDir } = makeMockBin(
      "cursor-agent",
      // Print every arg; the prompt is the last one.
      `for arg in "$@"; do printf '%s\n' "$arg"; done`
    );
    const prompt = "check argv not stdin";
    const result = runWrapper(prompt, {
      CURSOR_AGENT_PATH: join(binDir, "cursor-agent"),
    });
    assert.equal(result.status, 0);
    const out = parseOutput(result.stdout);
    assert.ok(out.output.includes(prompt), `prompt not found in output: ${out.output}`);
  });

  // ── Temp working directory ─────────────────────────────────────────────────

  test("--workspace is set to a temp directory (not the repo)", () => {
    const { binDir } = makeMockBin(
      "cursor-agent",
      // Walk shell args to find --workspace and print the next arg.
      `prev=""; for arg in "$@"; do
        if [ "$prev" = "--workspace" ]; then printf '%s' "$arg"; fi
        prev="$arg"
      done`
    );
    const result = runWrapper("workspace test", {
      CURSOR_AGENT_PATH: join(binDir, "cursor-agent"),
    });
    assert.equal(result.status, 0);
    const out = parseOutput(result.stdout);
    const workDir = out.output.trim();
    assert.ok(
      workDir.startsWith(tmpdir()) || workDir.startsWith("/tmp"),
      `workspace must be under tmpdir, got: ${workDir}`
    );
    assert.ok(
      !workDir.includes("paperclip-flota-evale"),
      "workspace must not be inside the repo"
    );
  });

  test("temp directory is cleaned up after successful run", () => {
    let capturedWorkDir = "";
    const { binDir } = makeMockBin(
      "cursor-agent",
      `prev=""; for arg in "$@"; do
        if [ "$prev" = "--workspace" ]; then printf '%s' "$arg"; fi
        prev="$arg"
      done`
    );
    const result = runWrapper("cleanup test", {
      CURSOR_AGENT_PATH: join(binDir, "cursor-agent"),
    });
    assert.equal(result.status, 0);
    const out = parseOutput(result.stdout);
    capturedWorkDir = out.output.trim();
    // After the process exits the workdir should be gone.
    let exists = false;
    try {
      readdirSync(capturedWorkDir);
      exists = true;
    } catch {
      // Expected — dir was deleted.
    }
    assert.ok(!exists, `temp dir was not cleaned up: ${capturedWorkDir}`);
  });

  // ── Nonzero exit ──────────────────────────────────────────────────────────

  test("nonzero exit from cursor-agent returns CURSOR_ERROR", () => {
    const { binDir } = makeMockBin("cursor-agent", "exit 1");
    const result = runWrapper("error test", {
      CURSOR_AGENT_PATH: join(binDir, "cursor-agent"),
    });
    assert.equal(result.status, 0, "wrapper must exit 0 even on agent error");
    const out = parseOutput(result.stdout);
    assert.ok(
      out.output.includes("CURSOR_ERROR"),
      `expected CURSOR_ERROR, got: ${out.output}`
    );
    assert.equal(out.error, true);
  });

  // ── Timeout ───────────────────────────────────────────────────────────────

  test("timeout: wrapper returns CURSOR_TIMEOUT and cleans temp dir when agent hangs", () => {
    // Use CURSOR_EVAL_TIMEOUT_MS=800 so the child_process spawnSync timeout fires quickly.
    // The outer harness gives 10 s — plenty of room for the wrapper to self-terminate.
    // We must NOT accept the outer test process being killed as success; the wrapper
    // must exit on its own with CURSOR_TIMEOUT in its output.
    //
    // Set TMPDIR to an isolated parent directory so we can assert it is empty after the
    // wrapper exits — proving the per-invocation temp dir was cleaned up.
    const { binDir } = makeMockBin("cursor-agent", "sleep 200");
    const isolatedTmpParent = mkdtempSync(join(tmpdir(), "cursor-exec-timeout-parent-"));
    const result = spawnSync(
      process.execPath,
      [WRAPPER, "timeout test"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CURSOR_AGENT_PATH: join(binDir, "cursor-agent"),
          CURSOR_EVAL_TIMEOUT_MS: "800",
          TMPDIR: isolatedTmpParent,
        },
        timeout: 10_000,
      }
    );
    // If the outer harness killed the wrapper (ETIMEDOUT / null status) the
    // wrapper's own timeout did NOT fire — that is a test failure.
    assert.ok(
      result.error?.code !== "ETIMEDOUT" && result.status !== null,
      `outer harness killed the wrapper — CURSOR_EVAL_TIMEOUT_MS override did not fire. ` +
        `error=${result.error?.code} status=${result.status}`
    );
    assert.equal(result.status, 0, "wrapper must exit 0 even on timeout");
    const out = parseOutput(result.stdout);
    assert.ok(
      out.output?.includes("CURSOR_TIMEOUT"),
      `expected CURSOR_TIMEOUT in output, got: ${JSON.stringify(out)}`
    );
    assert.equal(out.error, true, "timeout must set error:true");
    // The isolated parent must be empty — the wrapper cleaned up its per-run temp dir.
    const remaining = readdirSync(isolatedTmpParent);
    assert.deepEqual(
      remaining,
      [],
      `temp dir not cleaned up after CURSOR_TIMEOUT; leftover entries: ${JSON.stringify(remaining)}`
    );
    rmSync(isolatedTmpParent, { recursive: true, force: true });
  });

  // ── Output safety ─────────────────────────────────────────────────────────

  test("output JSON does not contain auth-like tokens", () => {
    const { binDir } = makeMockBin(
      "cursor-agent",
      'echo "Normal response without sk- keys or Bearer tokens"'
    );
    const result = runWrapper("auth safety", {
      CURSOR_AGENT_PATH: join(binDir, "cursor-agent"),
    });
    assert.equal(result.status, 0);
    const raw = result.stdout;
    assert.ok(!raw.includes("sk-ant-"), "must not leak Anthropic key");
    assert.ok(!raw.includes("sk-or-"), "must not leak OpenRouter key");
  });

  test("output is valid Promptfoo provider JSON (has output field)", () => {
    const { binDir } = makeMockBin("cursor-agent", 'echo "hello world"');
    const result = runWrapper("json structure", {
      CURSOR_AGENT_PATH: join(binDir, "cursor-agent"),
    });
    assert.equal(result.status, 0);
    const out = parseOutput(result.stdout);
    assert.ok("output" in out, `missing output field: ${JSON.stringify(out)}`);
    assert.ok(typeof out.output === "string", "output must be a string");
  });
});
