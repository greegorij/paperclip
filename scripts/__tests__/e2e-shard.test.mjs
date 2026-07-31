import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { loadShardDurations } from "../general-server-shard.mjs";
import { IGNORED_SPECS, listE2eSpecs, selectE2eShard } from "../e2e-shard.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = path.join(repoRoot, "scripts", "e2e-shard.mjs");
const durationsManifest = path.join(repoRoot, "scripts", "e2e-shard-durations.json");
const playwrightConfig = path.join(repoRoot, "tests", "e2e", "playwright.config.ts");
const prWorkflow = path.join(repoRoot, ".github", "workflows", "pr.yml");

const SHARD_COUNT = 2;

function runShard(args) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, `expected success for ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim().split(/\s+/).filter(Boolean);
}

test("the e2e shards form a complete, non-overlapping partition", () => {
  const specs = listE2eSpecs();
  assert.ok(specs.length > 0, "expected a non-empty e2e spec set");

  const shards = Array.from({ length: SHARD_COUNT }, (_, index) =>
    runShard(["--shard-index", String(index), "--shard-count", String(SHARD_COUNT)]),
  );

  const combined = shards.flat();
  assert.equal(combined.length, specs.length, "every spec must land on exactly one shard");
  assert.deepEqual([...combined].sort(), [...specs].sort());
  for (const shard of shards) {
    assert.ok(shard.length > 0, "no shard may be empty — Playwright fails a run with no matching specs");
  }
});

test("the ignored spec list matches playwright.config.ts testIgnore", () => {
  const config = readFileSync(playwrightConfig, "utf8");
  const match = config.match(/testIgnore:\s*\[([^\]]*)\]/);
  assert.ok(match, "expected a testIgnore array in playwright.config.ts");
  const configured = [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
  assert.deepEqual([...configured].sort(), [...IGNORED_SPECS].sort());
});

test("playwright e2e retries once in CI only and keeps trace on-first-retry", () => {
  // Flaky signoff-policy checkout races are cheaper to absorb with one CI
  // retry than with quarantines. Local stays retries:0; trace stays
  // on-first-retry so the retry path still captures diagnostics.
  const config = readFileSync(playwrightConfig, "utf8");
  const retriesMatch = config.match(/retries:\s*(process\.env\.CI\s*\?\s*1\s*:\s*0)/);
  assert.ok(retriesMatch, "expected retries: process.env.CI ? 1 : 0 in playwright.config.ts");
  assert.match(config, /trace:\s*"on-first-retry"/, "expected trace: on-first-retry");

  const resolveRetries = new Function("process", `return (${retriesMatch[1]});`);
  assert.equal(resolveRetries({ env: { CI: "1" } }), 1, "CI must enable exactly one retry");
  assert.equal(resolveRetries({ env: {} }), 0, "local runs must keep retries at 0");
});

test("the duration manifest only names specs that still exist", () => {
  const durations = loadShardDurations(durationsManifest);
  assert.ok(Object.keys(durations).length > 0, "expected a populated duration manifest");
  const specs = new Set(listE2eSpecs());
  for (const file of Object.keys(durations)) {
    assert.ok(specs.has(file), `duration manifest names a spec that no longer runs: ${file}`);
  }
});

test("the weighted partition keeps the shards close to balanced", () => {
  const durations = loadShardDurations(durationsManifest);
  const specs = listE2eSpecs();
  const weights = Array.from({ length: SHARD_COUNT }, (_, index) =>
    selectE2eShard(specs, index, SHARD_COUNT, durations).reduce((sum, file) => sum + (durations[file] ?? 0), 0),
  );

  const heaviest = Math.max(...weights);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  // Round-robin/count-based sharding would strand the ~168s smoke-lab spec on
  // one runner. Assert the weighted split stays within 15% of an even cut so a
  // future spec-time regression surfaces here instead of on the PR critical path.
  assert.ok(
    heaviest <= (total / SHARD_COUNT) * 1.15,
    `heaviest shard ${heaviest}ms exceeds 115% of the even cut (${total / SHARD_COUNT}ms)`,
  );
});

test("shard arguments are validated", () => {
  for (const args of [
    ["--shard-index", "2", "--shard-count", "2"],
    ["--shard-index", "-1", "--shard-count", "2"],
    ["--shard-index", "0", "--shard-count", "0"],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: repoRoot, encoding: "utf8" });
    assert.notEqual(result.status, 0, `expected failure for ${args.join(" ")}`);
  }
});

function parseWorkflowJobs(workflowSource) {
  const jobs = new Map();
  let current = null;
  for (const line of workflowSource.split("\n")) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      current = header[1];
      jobs.set(current, []);
      continue;
    }
    if (current && /^\S/.test(line)) current = null;
    if (current) jobs.get(current).push(line);
  }
  for (const [id, lines] of jobs) jobs.set(id, lines.join("\n"));
  return jobs;
}

test("pr.yml keeps a stable aggregate check named e2e over the shard matrix", () => {
  // Branch protection requires a check literally named `e2e`. The shards run
  // as `e2e shard (n/2)`, so the aggregate job below is what keeps the
  // required-check contract intact — same pattern as the `verify` aggregate.
  const jobs = parseWorkflowJobs(readFileSync(prWorkflow, "utf8"));

  const aggregate = jobs.get("e2e");
  assert.ok(aggregate, "pr.yml must define an `e2e` job to satisfy branch protection");
  assert.match(aggregate, /^ {4}name: e2e$/m, "the aggregate job must be named exactly `e2e`");
  assert.match(aggregate, /^ {4}if: \$\{\{ always\(\) \}\}$/m, "the aggregate must run even when a shard fails");
  assert.match(
    aggregate,
    /^ {4}needs:\n {6}- policy\n {6}- e2e_shards$/m,
    "the aggregate must depend on policy and the shard matrix",
  );
  assert.match(
    aggregate,
    /node \.\/scripts\/classify-pr-ci\.mjs check-e2e/,
    "the aggregate must accept intentional e2e omission via classify-pr-ci",
  );
  assert.match(
    aggregate,
    /test "\$POLICY_RESULT" = "success"/,
    "the aggregate must still require policy success",
  );

  const shards = jobs.get("e2e_shards");
  assert.ok(shards, "pr.yml must define the `e2e_shards` matrix job");
  assert.match(shards, /shard_count: 2/, "the shard matrix must match SHARD_COUNT");
  assert.match(
    shards,
    /needs\.policy\.outputs\.run_e2e == '1'/,
    "shards must stay skipped on docs/selective tracks without e2e",
  );
});

test("pr.yml forwards the computed e2e shard specs without a literal -- filter", () => {
  // pnpm 9.15.4 turns `pnpm run test:e2e -- $specs` into
  // `npx playwright test … "--" "<spec>" …`. Playwright treats that bare `--`
  // as a test-filter token and then runs the entire suite on every shard.
  const jobs = parseWorkflowJobs(readFileSync(prWorkflow, "utf8"));
  const shards = jobs.get("e2e_shards");
  assert.ok(shards, "pr.yml must define the `e2e_shards` matrix job");

  assert.match(
    shards,
    /specs="\$\(node \.\/scripts\/e2e-shard\.mjs/,
    "the shard job must compute its spec list via e2e-shard.mjs",
  );
  assert.match(
    shards,
    /^\s+pnpm run test:e2e \$specs$/m,
    "the shard job must pass $specs straight to test:e2e",
  );
  assert.doesNotMatch(
    shards,
    /pnpm run test:e2e -- /,
    "an extra `--` before $specs discards the computed shard list under pnpm 9.15.4",
  );
});

test("pnpm 9 forwards a literal -- before script args while direct args do not", () => {
  // Hermetic regression for the CI failure mode above: pnpm 9.15.4 turns
  // `pnpm run <script> -- <spec>` into a child argv that starts with `--`,
  // which Playwright then treats as a filter token and runs the full suite.
  // Prove the forwarding difference without network or repo node_modules —
  // policy runs this file before `pnpm install`.
  const sampleSpec = "tests/e2e/onboarding.spec.ts";
  const fixtureDir = mkdtempSync(path.join(tmpdir(), "e2e-shard-pnpm-argv-"));
  try {
    writeFileSync(
      path.join(fixtureDir, "capture.mjs"),
      "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
    );
    writeFileSync(
      path.join(fixtureDir, "package.json"),
      `${JSON.stringify(
        {
          name: "e2e-shard-pnpm-argv-fixture",
          private: true,
          scripts: {
            capture: `${JSON.stringify(process.execPath)} ./capture.mjs`,
          },
        },
        null,
        2,
      )}\n`,
    );

    const runCapture = (args) => {
      const result = spawnSync("pnpm", ["--reporter=silent", "run", "capture", ...args], {
        cwd: fixtureDir,
        encoding: "utf8",
        env: { ...process.env },
      });
      assert.equal(result.status, 0, `pnpm run capture ${args.join(" ")} failed: ${result.stderr}`);
      return JSON.parse(result.stdout.trim());
    };

    const brokenArgs = runCapture(["--", sampleSpec]);
    const correctArgs = runCapture([sampleSpec]);

    assert.deepEqual(brokenArgs, ["--", sampleSpec], "broken form must forward a leading literal --");
    assert.deepEqual(correctArgs, [sampleSpec], "correct form must forward only the sample spec");
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
