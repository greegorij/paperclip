/**
 * claude-exec.test.js
 *
 * Unit tests for claude-exec.mjs (Node ESM Promptfoo exec provider).
 * Uses mock executables — no paid API calls, no real claude invocation.
 *
 * Run:
 *   node --test evals/promptfoo/fleet/scripts/claude-exec.test.js
 *
 * All tests pass under `node --check` and `node --test`.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WRAPPER = resolve(__dirname, "claude-exec.mjs");

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

describe("claude-exec.mjs wrapper", () => {
  // ── CLAUDE_CODE_PATH resolution ──────────────────────────────────────────

  test("CLAUDE_CODE_PATH env var is preferred over PATH lookup", () => {
    const { exe } = makeMockBin("claude", 'echo "from-env-path"');
    const result = runWrapper("hello", {
      CLAUDE_CODE_PATH: exe,
    });
    assert.equal(result.status, 0);
    const out = parseOutput(result.stdout);
    assert.ok(typeof out.output === "string");
    assert.ok(out.output.includes("from-env-path"), `got: ${out.output}`);
  });

  test("falls back to claude on PATH when CLAUDE_CODE_PATH is unset", () => {
    const { binDir } = makeMockBin("claude", 'echo "from-path"');
    const result = runWrapper("hello", {
      CLAUDE_CODE_PATH: "",
      PATH: `${binDir}:${process.env.PATH}`,
    });
    assert.equal(result.status, 0);
    const out = parseOutput(result.stdout);
    assert.ok(out.output.includes("from-path"), `got: ${out.output}`);
  });

  test("returns CLAUDE_NOT_AVAILABLE when claude is not found", () => {
    const result = runWrapper("hello", {
      CLAUDE_CODE_PATH: "",
      PATH: "/dev/null",
    });
    assert.equal(result.status, 0, "should exit 0 on graceful degradation");
    const out = parseOutput(result.stdout);
    assert.ok(
      out.output.includes("CLAUDE_NOT_AVAILABLE"),
      `expected CLAUDE_NOT_AVAILABLE, got: ${out.output}`
    );
    assert.equal(out.error, false);
  });

  // ── Exact argument passing ────────────────────────────────────────────────

  test("passes exact required arguments to claude", () => {
    const { binDir } = makeMockBin(
      "claude",
      `for arg in "$@"; do printf '%s\n' "$arg"; done`
    );
    const result = runWrapper("my-prompt-text", {
      CLAUDE_CODE_PATH: join(binDir, "claude"),
    });
    assert.equal(result.status, 0);
    const out = parseOutput(result.stdout);
    const args = out.output.split("\n").map((s) => s.trim()).filter(Boolean);
    assert.ok(args.includes("-p"), `must pass -p; got args: ${JSON.stringify(args)}`);
    assert.ok(args.includes("--output-format"), `must pass --output-format; got: ${JSON.stringify(args)}`);
    assert.ok(args.includes("text"), `output-format value must be text; got: ${JSON.stringify(args)}`);
    assert.ok(args.includes("--model"), `must pass --model; got: ${JSON.stringify(args)}`);
    assert.ok(args.includes("claude-sonnet-5"), `model must be claude-sonnet-5; got: ${JSON.stringify(args)}`);
    assert.ok(args.includes("--no-session-persistence"), `must pass --no-session-persistence; got: ${JSON.stringify(args)}`);
    assert.ok(args.includes("--permission-mode"), `must pass --permission-mode; got: ${JSON.stringify(args)}`);
    assert.ok(args.includes("plan"), `permission-mode must be plan; got: ${JSON.stringify(args)}`);
    assert.ok(args.includes("--tools"), `must pass --tools; got: ${JSON.stringify(args)}`);
    assert.ok(args.includes("--setting-sources"), `must pass --setting-sources; got: ${JSON.stringify(args)}`);
    assert.ok(args.includes("--disable-slash-commands"), `must pass --disable-slash-commands; got: ${JSON.stringify(args)}`);
    assert.ok(args.includes("--no-chrome"), `must pass --no-chrome; got: ${JSON.stringify(args)}`);
    assert.ok(args.includes("--strict-mcp-config"), `must pass --strict-mcp-config; got: ${JSON.stringify(args)}`);
    assert.ok(args.includes("--mcp-config"), `must pass --mcp-config; got: ${JSON.stringify(args)}`);
    // Verify --bare is NOT passed (local subscription/keychain auth must remain possible).
    assert.ok(!args.includes("--bare"), `must NOT pass --bare; got: ${JSON.stringify(args)}`);
    assert.ok(args.includes("my-prompt-text"), `prompt must be last arg; got: ${JSON.stringify(args)}`);
  });

  test("mcp-config value is empty mcpServers JSON object", () => {
    const { binDir } = makeMockBin(
      "claude",
      // Print the arg after --mcp-config.
      `prev=""; for arg in "$@"; do
        if [ "$prev" = "--mcp-config" ]; then printf '%s' "$arg"; fi
        prev="$arg"
      done`
    );
    const result = runWrapper("mcp test", {
      CLAUDE_CODE_PATH: join(binDir, "claude"),
    });
    assert.equal(result.status, 0);
    const out = parseOutput(result.stdout);
    let mcpVal;
    try {
      mcpVal = JSON.parse(out.output.trim());
    } catch {
      assert.fail(`--mcp-config value is not valid JSON: ${out.output}`);
    }
    assert.ok(
      typeof mcpVal === "object" && mcpVal !== null && "mcpServers" in mcpVal,
      `--mcp-config must have mcpServers key; got: ${JSON.stringify(mcpVal)}`
    );
    assert.deepEqual(
      mcpVal.mcpServers,
      {},
      `mcpServers must be empty object; got: ${JSON.stringify(mcpVal.mcpServers)}`
    );
  });

  test("--tools and --setting-sources are passed with empty string values", () => {
    const { binDir } = makeMockBin(
      "claude",
      // Print each arg on its own line, including empty strings.
      `for arg in "$@"; do printf '%s\n' "$arg"; done`
    );
    const result = runWrapper("tools test", {
      CLAUDE_CODE_PATH: join(binDir, "claude"),
    });
    assert.equal(result.status, 0);
    const out = parseOutput(result.stdout);
    // The raw args list includes "--tools" followed by "" (empty string).
    // In the shell output each arg is on its own line; an empty arg prints as a blank line.
    const rawLines = out.output.split("\n");
    const toolsIdx = rawLines.indexOf("--tools");
    assert.ok(toolsIdx !== -1, `--tools not found in args: ${JSON.stringify(rawLines)}`);
    assert.equal(
      rawLines[toolsIdx + 1],
      "",
      `value after --tools must be empty string; got: ${JSON.stringify(rawLines[toolsIdx + 1])}`
    );
    const settingIdx = rawLines.indexOf("--setting-sources");
    assert.ok(settingIdx !== -1, `--setting-sources not found in args: ${JSON.stringify(rawLines)}`);
    assert.equal(
      rawLines[settingIdx + 1],
      "",
      `value after --setting-sources must be empty string; got: ${JSON.stringify(rawLines[settingIdx + 1])}`
    );
  });

  // ── Prompt as argv ─────────────────────────────────────────────────────────

  test("prompt string is passed as argv argument (not stdin)", () => {
    const { binDir } = makeMockBin(
      "claude",
      `for arg in "$@"; do printf '%s\n' "$arg"; done`
    );
    const prompt = "check argv not stdin";
    const result = runWrapper(prompt, {
      CLAUDE_CODE_PATH: join(binDir, "claude"),
    });
    assert.equal(result.status, 0);
    const out = parseOutput(result.stdout);
    assert.ok(out.output.includes(prompt), `prompt not found in output: ${out.output}`);
  });

  // ── Temp working directory ─────────────────────────────────────────────────

  test("cwd is set to a temp directory (not the repo)", () => {
    // The wrapper passes cwd to spawnSync; the mock script can inspect PWD.
    const { binDir } = makeMockBin("claude", 'printf "%s" "$PWD"');
    const result = runWrapper("cwd test", {
      CLAUDE_CODE_PATH: join(binDir, "claude"),
    });
    assert.equal(result.status, 0);
    const out = parseOutput(result.stdout);
    const workDir = out.output.trim();
    // The temp dir might already be deleted by the time we check (that is correct cleanup).
    // What we can assert is that it was in tmpdir() at the time of invocation.
    // On macOS tmpdir() returns /var/folders/... but the real path is /private/var/folders/...
    const tmpdirResolved = tmpdir().replace(/^\/var\//, "/private/var/");
    assert.ok(
      workDir.startsWith(tmpdir()) ||
        workDir.startsWith(tmpdirResolved) ||
        workDir.startsWith("/tmp") ||
        workDir.startsWith("/private/tmp"),
      `cwd must be under tmpdir, got: ${workDir}`
    );
    assert.ok(
      !workDir.includes("paperclip-flota-evale"),
      "cwd must not be inside the repo"
    );
  });

  test("temp directory is cleaned up after successful run", () => {
    const { binDir } = makeMockBin("claude", 'printf "%s" "$PWD"');
    const result = runWrapper("cleanup test", {
      CLAUDE_CODE_PATH: join(binDir, "claude"),
    });
    assert.equal(result.status, 0);
    const out = parseOutput(result.stdout);
    const capturedWorkDir = out.output.trim();
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

  test("nonzero exit from claude returns CLAUDE_ERROR", () => {
    const { binDir } = makeMockBin("claude", "exit 1");
    const result = runWrapper("error test", {
      CLAUDE_CODE_PATH: join(binDir, "claude"),
    });
    assert.equal(result.status, 0, "wrapper must exit 0 even on agent error");
    const out = parseOutput(result.stdout);
    assert.ok(
      out.output.includes("CLAUDE_ERROR"),
      `expected CLAUDE_ERROR, got: ${out.output}`
    );
    assert.equal(out.error, true);
  });

  // ── Timeout ───────────────────────────────────────────────────────────────

  test("timeout: wrapper returns CLAUDE_TIMEOUT and cleans temp dir when claude hangs", () => {
    const { binDir } = makeMockBin("claude", "sleep 200");
    const isolatedTmpParent = mkdtempSync(join(tmpdir(), "claude-exec-timeout-parent-"));
    const result = spawnSync(
      process.execPath,
      [WRAPPER, "timeout test"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CLAUDE_CODE_PATH: join(binDir, "claude"),
          CLAUDE_EVAL_TIMEOUT_MS: "800",
          TMPDIR: isolatedTmpParent,
        },
        timeout: 10_000,
      }
    );
    assert.ok(
      result.error?.code !== "ETIMEDOUT" && result.status !== null,
      `outer harness killed the wrapper — CLAUDE_EVAL_TIMEOUT_MS override did not fire. ` +
        `error=${result.error?.code} status=${result.status}`
    );
    assert.equal(result.status, 0, "wrapper must exit 0 even on timeout");
    const out = parseOutput(result.stdout);
    assert.ok(
      out.output?.includes("CLAUDE_TIMEOUT"),
      `expected CLAUDE_TIMEOUT in output, got: ${JSON.stringify(out)}`
    );
    assert.equal(out.error, true, "timeout must set error:true");
    const remaining = readdirSync(isolatedTmpParent);
    assert.deepEqual(
      remaining,
      [],
      `temp dir not cleaned up after CLAUDE_TIMEOUT; leftover entries: ${JSON.stringify(remaining)}`
    );
    rmSync(isolatedTmpParent, { recursive: true, force: true });
  });

  // ── Missing executable ────────────────────────────────────────────────────

  test("explicit missing path returns CLAUDE_NOT_AVAILABLE without error:true", () => {
    const result = runWrapper("missing exe test", {
      CLAUDE_CODE_PATH: "/nonexistent/path/to/claude",
    });
    assert.equal(result.status, 0, "wrapper must exit 0 on missing executable");
    const out = parseOutput(result.stdout);
    assert.ok(
      out.output.includes("CLAUDE_NOT_AVAILABLE"),
      `expected CLAUDE_NOT_AVAILABLE, got: ${out.output}`
    );
    assert.equal(out.error, false, "missing executable is soft-degradation, not hard error");
  });

  // ── Output safety ─────────────────────────────────────────────────────────

  test("output JSON does not contain auth-like tokens", () => {
    const { binDir } = makeMockBin(
      "claude",
      'echo "Normal response without sk- keys or Bearer tokens"'
    );
    const result = runWrapper("auth safety", {
      CLAUDE_CODE_PATH: join(binDir, "claude"),
    });
    assert.equal(result.status, 0);
    const raw = result.stdout;
    assert.ok(!raw.includes("sk-ant-"), "must not leak Anthropic key");
    assert.ok(!raw.includes("sk-or-"), "must not leak OpenRouter key");
  });

  test("output is valid Promptfoo provider JSON (has output field)", () => {
    const { binDir } = makeMockBin("claude", 'echo "hello world"');
    const result = runWrapper("json structure", {
      CLAUDE_CODE_PATH: join(binDir, "claude"),
    });
    assert.equal(result.status, 0);
    const out = parseOutput(result.stdout);
    assert.ok("output" in out, `missing output field: ${JSON.stringify(out)}`);
    assert.ok(typeof out.output === "string", "output must be a string");
  });
});
