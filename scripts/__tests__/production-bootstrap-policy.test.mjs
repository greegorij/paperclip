/**
 * Regression tests for the production-branch bootstrap policy.
 * Ensures CI configuration invariants are preserved across future edits.
 *
 * Uses plain text checks — no YAML parser required, so the suite runs before
 * pnpm install.
 *
 * Invariants:
 *   1. The privileged pull_request_target workflow (commitperclip-review.yml):
 *      - checks out exactly the base SHA — never a mutable branch name
 *      - has exactly one actions/checkout usage
 *      - has no second checkout that could pull PR code
 *      - carries only `contents: read` permissions (no write grants)
 *   2. The main PR workflow (pr.yml):
 *      - triggers on both master and production
 *      - declares `contents: read` at the workflow level
 *      - has no write permissions of any kind
 *      - `verify` is the authoritative aggregate over policy + cost-aware lanes
 *        (always(); intentional lane omissions may be skipped)
 *      - workflow `steps` never list two adjacent `- name:` entries without a
 *        step body (`run`/`uses`/…) between them (malformed / duplicate-key steps)
 *      - verify_build never double-builds: plain Build and canary dry-run are
 *        mutually exclusive on run_canary
 *   3. Dependabot version-update PRs are disabled (limit 0) on both ecosystems.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

function readFile(relPath) {
  return readFileSync(path.join(repoRoot, relPath), "utf8");
}

// ---------------------------------------------------------------------------
// commitperclip-review.yml — privileged workflow
// ---------------------------------------------------------------------------

test("privileged workflow checks out base SHA, not a branch name", () => {
  const wf = readFile(".github/workflows/commitperclip-review.yml");

  assert.match(
    wf,
    /ref:\s+\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\}\}/,
    "checkout must use github.event.pull_request.base.sha",
  );
});

test("privileged workflow does not check out ref: master", () => {
  const wf = readFile(".github/workflows/commitperclip-review.yml");

  assert.doesNotMatch(
    wf,
    /^\s+ref:\s+master\s*$/m,
    "checkout must not use a hard-coded branch name",
  );
});

test("privileged workflow has exactly one actions/checkout usage", () => {
  const wf = readFile(".github/workflows/commitperclip-review.yml");

  const checkoutMatches = wf.match(/uses:\s+actions\/checkout/g) ?? [];
  assert.equal(
    checkoutMatches.length,
    1,
    `expected exactly 1 actions/checkout, found ${checkoutMatches.length}`,
  );
});

test("privileged workflow has only contents: read permission (no write grants)", () => {
  const wf = readFile(".github/workflows/commitperclip-review.yml");

  // Must have contents: read.
  assert.match(wf, /contents:\s+read/, "contents: read must be present");

  // Must NOT have any write permissions via GITHUB_TOKEN.
  assert.doesNotMatch(
    wf,
    /pull-requests:\s+write/,
    "pull-requests: write must be removed — comments use the app GH_TOKEN",
  );
  assert.doesNotMatch(
    wf,
    /security-events:\s+write/,
    "security-events: write is not needed and must be removed",
  );
  assert.doesNotMatch(
    wf,
    /checks:\s+write/,
    "checks: write is not needed and must be removed",
  );
  assert.doesNotMatch(
    wf,
    /issues:\s+write/,
    "issues: write is not needed and must be removed",
  );
});

test("dependency-review step is pinned to a full SHA", () => {
  const wf = readFile(".github/workflows/commitperclip-review.yml");

  // The line using dependency-review-action must reference a 40-char SHA.
  assert.match(
    wf,
    /uses:\s+actions\/dependency-review-action@[0-9a-f]{40}/,
    "dependency-review-action must be pinned to a full commit SHA",
  );
});

test("privileged job is guarded at job level for private repositories", () => {
  const wf = readFile(".github/workflows/commitperclip-review.yml");

  // The review job block (from `review:` up to the next top-level job or end of file)
  // must carry the private-repo guard as a job-level `if:` condition.
  const jobBlock = wf.match(/\breview:\s*\n([\s\S]*?)(?=\n\S|\n  \w+:\s*\n|$)/);
  assert.ok(jobBlock, "review job block not found");
  assert.match(
    jobBlock[0],
    /if:\s+github\.event\.repository\.private\s*==\s*false/,
    "review job must have: if: github.event.repository.private == false at the job level",
  );
});

test("dependency-review step does not carry a redundant private-repo guard", () => {
  const wf = readFile(".github/workflows/commitperclip-review.yml");

  // The step block for Dependency Review must NOT have its own if: condition —
  // the job-level guard makes it redundant.
  const stepBlock = wf.match(
    /- name: Dependency Review[\s\S]*?(?=\n      - name:|\n  \w|$)/,
  );
  assert.ok(stepBlock, "Dependency Review step not found");
  assert.doesNotMatch(
    stepBlock[0],
    /^\s+if:/m,
    "Dependency Review step must not carry a redundant if: condition — the job-level guard is sufficient",
  );
});

// ---------------------------------------------------------------------------
// pr.yml — regular PR workflow (runs untrusted PR code)
// ---------------------------------------------------------------------------

test("PR workflow triggers on master branch", () => {
  const wf = readFile(".github/workflows/pr.yml");
  assert.match(wf, /branches:[^]*?-\s+master/s);
});

test("PR workflow triggers on production branch", () => {
  const wf = readFile(".github/workflows/pr.yml");
  assert.match(wf, /branches:[^]*?-\s+production/s);
});

test("PR workflow declares pull_request types needed for full-track and label re-runs", () => {
  const wf = readFile(".github/workflows/pr.yml");
  const jobsIdx = wf.indexOf("\njobs:");
  assert.ok(jobsIdx > 0, "jobs: section not found");
  const preamble = wf.slice(0, jobsIdx);

  // Without an explicit types list GitHub only fires opened/synchronize/reopened,
  // so ready_for_review and ci:full labeled events would never start the full track.
  const typesBlock = preamble.match(
    /pull_request:\s*\n([\s\S]*?)(?=\npermissions:|\nconcurrency:)/,
  );
  assert.ok(typesBlock, "pull_request trigger block not found");
  assert.match(typesBlock[0], /^\s+types:\s*$/m, "pull_request.types must be declared explicitly");

  const requiredTypes = [
    "opened",
    "synchronize",
    "reopened",
    "ready_for_review",
    "converted_to_draft",
    "labeled",
    "unlabeled",
  ];
  for (const eventType of requiredTypes) {
    assert.match(
      typesBlock[0],
      new RegExp(String.raw`^\s+-\s+${eventType}\s*$`, "m"),
      `pull_request.types must include ${eventType}`,
    );
  }
});

test("PR workflow declares contents: read at workflow level", () => {
  const wf = readFile(".github/workflows/pr.yml");

  // The permissions block must appear before the first `jobs:` line.
  const jobsIdx = wf.indexOf("\njobs:");
  assert.ok(jobsIdx > 0, "jobs: section not found");
  const preamble = wf.slice(0, jobsIdx);

  assert.match(
    preamble,
    /^permissions:/m,
    "workflow-level permissions block must be present",
  );
  assert.match(
    preamble,
    /contents:\s+read/,
    "contents: read must be declared at workflow level",
  );
});

test("PR workflow has no write permissions", () => {
  const wf = readFile(".github/workflows/pr.yml");

  // The preamble (before jobs:) is where workflow-level permissions live.
  const jobsIdx = wf.indexOf("\njobs:");
  const preamble = wf.slice(0, jobsIdx);

  assert.doesNotMatch(
    preamble,
    /:\s+write/,
    "PR workflow preamble must not contain any write permissions",
  );
});

// ---------------------------------------------------------------------------
// pr.yml — verify aggregate (cost-aware critical-lane gate)
// ---------------------------------------------------------------------------

/** Consolidated heavy lanes gated by classify-pr-ci outputs. */
const VERIFY_HEAVY_LANES = Object.freeze({
  verify_server_general: "SERVER_GENERAL_RESULT",
  verify_server_serialized: "SERVER_SERIALIZED_RESULT",
  verify_workspaces: "WORKSPACES_RESULT",
  verify_build: "BUILD_RESULT",
  e2e_shards: "E2E_SHARDS_RESULT",
});

/** Isolate top-level job bodies from a workflow file (no YAML parser). */
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

/** Extract job ids from a conventional `needs:` YAML block sequence (`- job_id`). */
function parseNeedsBlockSequence(jobBody) {
  const block = /^ {4}needs:\s*\n((?: {6}- [A-Za-z0-9_-]+\n?)+)/m.exec(jobBody);
  assert.ok(block, "verify job must declare needs: as a YAML block sequence");
  return [...block[1].matchAll(/^ {6}- ([A-Za-z0-9_-]+)\s*$/gm)].map((m) => m[1]);
}

/**
 * Find workflow steps whose `- name:` is immediately followed by another
 * `- name:` with no step-body keys (`run`/`uses`/`if`/…) in between.
 * Blank lines and comments do not count as step body.
 */
function findAdjacentStepNamesWithoutBody(workflowSource) {
  const stepName = /^ {6}- name:\s*(.*?)\s*$/;
  const stepBodyKey =
    /^ {8}(?:if|uses|run|with|env|id|continue-on-error|working-directory|shell|timeout-minutes):/;
  const lines = workflowSource.split("\n");
  const problems = [];

  for (let i = 0; i < lines.length; i++) {
    const match = stepName.exec(lines[i]);
    if (!match) continue;

    let sawBody = false;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (stepName.test(line)) {
        if (!sawBody) {
          problems.push({
            line: i + 1,
            name: match[1],
            nextLine: j + 1,
            nextName: stepName.exec(line)?.[1] ?? "",
          });
        }
        break;
      }
      // Left the steps list (job key or top-level).
      if (/^ {0,5}\S/.test(line) || /^ {4}\S/.test(line)) break;
      if (stepBodyKey.test(line)) sawBody = true;
    }
  }
  return problems;
}

test("PR verify job is the authoritative cost-aware aggregate", () => {
  const jobs = parseWorkflowJobs(readFile(".github/workflows/pr.yml"));
  const verify = jobs.get("verify");
  assert.ok(verify, "pr.yml must define a `verify` job");
  assert.match(
    verify,
    /^ {4}if: \$\{\{ always\(\) \}\}$/m,
    "verify must use exact if: ${{ always() }}",
  );

  const expectedNeeds = ["policy", ...Object.keys(VERIFY_HEAVY_LANES)];
  const needs = parseNeedsBlockSequence(verify);
  assert.deepEqual(
    [...needs].sort(),
    [...expectedNeeds].sort(),
    "verify needs must be policy plus the consolidated heavy lanes",
  );

  assert.match(
    verify,
    /test "\$POLICY_RESULT" = "success"/,
    "verify must require policy success",
  );
  assert.match(
    verify,
    /node \.\/scripts\/classify-pr-ci\.mjs check-verify/,
    "verify must gate heavy lanes through classify-pr-ci check-verify",
  );

  for (const [lane, envName] of Object.entries(VERIFY_HEAVY_LANES)) {
    assert.ok(jobs.has(lane), `heavy lane \`${lane}\` must exist as a job`);
    assert.match(
      verify,
      new RegExp(
        String.raw`^\s+${envName}:\s*\$\{\{\s*needs\.${lane}\.result\s*\}\}\s*$`,
        "m",
      ),
      `verify must bind ${envName} to needs.${lane}.result`,
    );
  }

  const policy = jobs.get("policy");
  assert.ok(policy, "pr.yml must define a `policy` job");
  assert.match(
    policy,
    /node \.\/scripts\/classify-pr-ci\.mjs classify/,
    "policy must classify the PR CI track",
  );
  assert.match(
    policy,
    /--github-output "\$GITHUB_OUTPUT"/,
    "Classify PR CI track must pass --github-output \"$GITHUB_OUTPUT\" so lane outputs are not empty",
  );
  assert.match(
    policy,
    /node --test \.\/scripts\/__tests__\/classify-pr-ci\.test\.mjs/,
    "policy must run classifier unit tests before install",
  );

  for (const lane of [
    "verify_server_general",
    "verify_server_serialized",
    "verify_workspaces",
    "verify_build",
  ]) {
    const body = jobs.get(lane);
    assert.match(
      body,
      /needs\.policy\.outputs\.run_/,
      `${lane} must be gated by classifier outputs`,
    );
    assert.match(body, /pnpm install --frozen-lockfile/, `${lane} installs when selected`);
  }

  const e2eShards = jobs.get("e2e_shards");
  assert.match(
    e2eShards,
    /needs\.policy\.outputs\.run_e2e == '1'/,
    "e2e_shards must not start when the classifier omits e2e",
  );
});

test("PR verify_server_* and verify_workspaces split historical core with sequential shards", () => {
  const jobs = parseWorkflowJobs(readFile(".github/workflows/pr.yml"));
  const policy = jobs.get("policy");
  const serverGeneral = jobs.get("verify_server_general");
  const serverSerialized = jobs.get("verify_server_serialized");
  const workspaces = jobs.get("verify_workspaces");
  assert.ok(policy, "pr.yml must define a `policy` job");
  assert.ok(serverGeneral, "pr.yml must define a `verify_server_general` job");
  assert.ok(serverSerialized, "pr.yml must define a `verify_server_serialized` job");
  assert.ok(workspaces, "pr.yml must define a `verify_workspaces` job");
  assert.equal(jobs.has("verify_core"), false, "legacy verify_core job must be removed");
  assert.equal(jobs.has("verify_server"), false, "unsharded verify_server job must be removed");

  assert.match(
    policy,
    /run_workspaces:\s*\$\{\{\s*steps\.classify\.outputs\.run_workspaces\s*\}\}/,
    "policy must export classifier output run_workspaces",
  );
  for (const flag of ["run_server", "run_ui", "run_packages", "run_cli"]) {
    assert.match(
      policy,
      new RegExp(String.raw`${flag}:\s*\$\{\{\s*steps\.classify\.outputs\.${flag}\s*\}\}`),
      `policy must export classifier output ${flag}`,
    );
  }

  // Job-level gates: selective must not start the wrong install job.
  for (const [id, body] of [
    ["verify_server_general", serverGeneral],
    ["verify_server_serialized", serverSerialized],
  ]) {
    assert.match(
      body,
      /needs\.policy\.outputs\.run_server == '1'/,
      `${id} must start only when run_server=1`,
    );
    assert.match(
      body,
      /timeout-minutes:\s*30/,
      `${id} timeout must be 30 minutes`,
    );
    assert.match(
      body,
      /node \.\/scripts\/classify-pr-ci\.mjs check-server-lanes/,
      `${id} must fail-closed validate server lane flags`,
    );
  }
  assert.match(
    workspaces,
    /needs\.policy\.outputs\.run_workspaces == '1'/,
    "verify_workspaces must start only when run_workspaces=1",
  );
  assert.match(
    workspaces,
    /timeout-minutes:\s*30/,
    "verify_workspaces timeout must be 30 minutes",
  );
  assert.match(
    workspaces,
    /node \.\/scripts\/classify-pr-ci\.mjs check-workspaces-lanes/,
    "verify_workspaces must fail-closed validate workspaces sub-lane flags",
  );

  // Canonical general-server partition: shards 0..2 of 3, sequential, one install.
  assert.match(
    serverGeneral,
    /--group general-server/,
    "verify_server_general must run general-server",
  );
  assert.match(
    serverGeneral,
    /--shard-count 3/,
    "verify_server_general must use shard-count 3",
  );
  assert.match(
    serverGeneral,
    /for shard_index in 0 1 2/,
    "verify_server_general must run shards 0..2 sequentially",
  );
  assert.match(
    serverGeneral,
    /mode == 'selective'[\s\S]*--filter @paperclipai\/server typecheck/,
    "selective server typecheck must live on verify_server_general exactly once",
  );
  assert.equal(
    (serverGeneral.match(/--filter @paperclipai\/server typecheck/g) ?? []).length,
    1,
    "server typecheck must run exactly once across server jobs (on general)",
  );
  assert.doesNotMatch(
    serverSerialized,
    /--filter @paperclipai\/server typecheck/,
    "verify_server_serialized must not duplicate selective server typecheck",
  );
  assert.doesNotMatch(
    serverGeneral,
    /test:run:serialized/,
    "verify_server_general must not run serialized suites",
  );
  assert.doesNotMatch(
    serverGeneral,
    /typecheck:build-gaps|test:release-registry|general-workspaces-[ab]/,
    "verify_server_general must not duplicate workspaces-lane commands",
  );

  // Canonical serialized partition: shards 0..3 of 4, sequential, one install.
  assert.match(
    serverSerialized,
    /test:run:serialized/,
    "verify_server_serialized must run serialized suites",
  );
  assert.match(
    serverSerialized,
    /--shard-count 4/,
    "verify_server_serialized must use shard-count 4",
  );
  assert.match(
    serverSerialized,
    /for shard_index in 0 1 2 3/,
    "verify_server_serialized must run shards 0..3 sequentially",
  );
  assert.doesNotMatch(
    serverSerialized,
    /--group general-server|typecheck:build-gaps|test:release-registry|general-workspaces-[ab]/,
    "verify_server_serialized must not duplicate general-server or workspaces commands",
  );

  // No unsharded server commands on either job (every suite invocation carries shard flags).
  for (const [id, body] of [
    ["verify_server_general", serverGeneral],
    ["verify_server_serialized", serverSerialized],
  ]) {
    assert.doesNotMatch(
      body,
      /pnpm test:run:general -- --group general-server\s*$/m,
      `${id} must not run unsharded general-server`,
    );
    assert.doesNotMatch(
      body,
      /^\s*pnpm test:run:serialized\s*$/m,
      `${id} must not run unsharded serialized suites`,
    );
  }

  // Full historical non-server core surface lives only on verify_workspaces.
  assert.match(
    workspaces,
    /needs\.policy\.outputs\.mode == 'full'[\s\S]*typecheck:build-gaps/,
    "full track must still run typecheck:build-gaps on verify_workspaces",
  );
  assert.match(
    workspaces,
    /needs\.policy\.outputs\.mode == 'full'[\s\S]*test:release-registry/,
    "full track must still run release-registry coverage on verify_workspaces",
  );
  assert.match(
    workspaces,
    /run_ui == '1'[\s\S]*--filter @paperclipai\/ui typecheck/,
    "selective ui must typecheck @paperclipai/ui",
  );
  assert.match(
    workspaces,
    /run_packages == '1'[\s\S]*--filter "\.\/packages\/\*\*" typecheck/,
    "selective packages must typecheck packages/**",
  );
  assert.match(
    workspaces,
    /run_cli == '1'[\s\S]*--filter paperclipai typecheck/,
    "selective cli must typecheck paperclipai",
  );
  assert.match(
    workspaces,
    /run_ui == '1'[\s\S]*run_cli == '1'[\s\S]*--group general-workspaces-a/,
    "ui/cli sub-lanes must run general-workspaces-a",
  );
  assert.match(
    workspaces,
    /run_packages == '1'[\s\S]*--group general-workspaces-b/,
    "packages sub-lane must run general-workspaces-b",
  );
  assert.doesNotMatch(
    workspaces,
    /general-server|test:run:serialized|--filter @paperclipai\/server typecheck/,
    "verify_workspaces must not duplicate server-lane commands",
  );

  // Each heavy core job installs exactly once (single Install dependencies step).
  for (const [id, body] of [
    ["verify_server_general", serverGeneral],
    ["verify_server_serialized", serverSerialized],
    ["verify_workspaces", workspaces],
  ]) {
    const installs = body.match(/pnpm install --frozen-lockfile/g) ?? [];
    assert.equal(installs.length, 1, `${id} must have exactly one frozen install`);
  }

  // Release-registry stays gated (not an unconditional step).
  assert.doesNotMatch(
    workspaces,
    /^ {6}- name: Verify release registry test coverage\n {8}run:/m,
    "release-registry must stay gated (not an unconditional step)",
  );
});

test("PR workflow steps never have adjacent - name: entries without a step body", () => {
  // Fixture mirrors the verify_build duplicate-key failure mode: two consecutive
  // `- name:` lines with nothing that constitutes a step body between them.
  const malformedFixture = [
    "    steps:",
    "      - name: Build",
    "        if: needs.policy.outputs.run_canary != '1'",
    "        run: pnpm build",
    "      - name: Release canary dry run via release.sh internal build",
    "      - name: Release canary dry run via release.sh internal build",
    "        if: needs.policy.outputs.run_canary == '1'",
    "        run: ./scripts/release.sh canary --skip-verify --dry-run",
    "",
  ].join("\n");
  const fixtureProblems = findAdjacentStepNamesWithoutBody(malformedFixture);
  assert.equal(
    fixtureProblems.length,
    1,
    "fixture must expose exactly one adjacent empty-named step",
  );
  assert.equal(
    fixtureProblems[0].name,
    "Release canary dry run via release.sh internal build",
  );

  const wf = readFile(".github/workflows/pr.yml");
  const problems = findAdjacentStepNamesWithoutBody(wf);
  assert.deepEqual(
    problems,
    [],
    problems.length === 0
      ? "pr.yml steps are well-formed"
      : `pr.yml has adjacent - name: without step body at line ${problems[0].line} (${problems[0].name}) → line ${problems[0].nextLine} (${problems[0].nextName})`,
  );
});

test("PR verify_build Build and canary dry-run are mutually exclusive on run_canary", () => {
  const jobs = parseWorkflowJobs(readFile(".github/workflows/pr.yml"));
  const build = jobs.get("verify_build");
  assert.ok(build, "pr.yml must define a `verify_build` job");

  // Extract the Build step block (name → next top-level step name).
  const buildStep = build.match(
    /^ {6}- name: Build\n((?: {8}.+\n)*)/m,
  );
  assert.ok(buildStep, "verify_build must have a Build step");
  assert.match(
    buildStep[0],
    /if:\s*needs\.policy\.outputs\.run_canary\s*!=\s*'1'/,
    "plain Build must run only when run_canary != 1",
  );
  assert.match(buildStep[0], /^\s+run:\s*pnpm build\s*$/m, "Build must still invoke pnpm build");

  const canaryStep = build.match(
    /^ {6}- name: Release canary dry run via release\.sh internal build\n((?: {8}.+\n| {10}.+\n)*)/m,
  );
  assert.ok(canaryStep, "verify_build must have the canary dry-run step");
  assert.match(
    canaryStep[0],
    /if:\s*needs\.policy\.outputs\.run_canary\s*==\s*'1'/,
    "canary dry-run must run only when run_canary == 1",
  );
  assert.match(
    canaryStep[0],
    /\.\/scripts\/release\.sh canary --skip-verify --dry-run/,
    "canary dry-run must still invoke release.sh (which builds internally)",
  );

  // Conditions are logical complements on the same flag → full/canary never
  // executes both workspace builds in the required verify_build job.
  const buildIf = /if:\s*(needs\.policy\.outputs\.run_canary\s*!=\s*'1')/.exec(
    buildStep[0],
  )?.[1];
  const canaryIf = /if:\s*(needs\.policy\.outputs\.run_canary\s*==\s*'1')/.exec(
    canaryStep[0],
  )?.[1];
  assert.equal(
    buildIf,
    "needs.policy.outputs.run_canary != '1'",
    "Build gate must be exactly run_canary != '1'",
  );
  assert.equal(
    canaryIf,
    "needs.policy.outputs.run_canary == '1'",
    "canary gate must be exactly run_canary == '1'",
  );
  assert.notEqual(buildIf, canaryIf, "Build and canary if-conditions must be disjoint");
});

// ---------------------------------------------------------------------------
// dependabot.yml
// ---------------------------------------------------------------------------

test("Dependabot npm ecosystem has open-pull-requests-limit: 0", () => {
  const cfg = readFile(".github/dependabot.yml");

  const npmBlock = cfg.match(
    /package-ecosystem:\s+npm[\s\S]*?(?=\n\s*-\s+package-ecosystem:|$)/,
  );
  assert.ok(npmBlock, "npm ecosystem block not found");
  assert.match(
    npmBlock[0],
    /open-pull-requests-limit:\s+0/,
    "npm open-pull-requests-limit must be 0",
  );
});

test("Dependabot github-actions ecosystem has open-pull-requests-limit: 0", () => {
  const cfg = readFile(".github/dependabot.yml");

  const actionsBlock = cfg.match(
    /package-ecosystem:\s+github-actions[\s\S]*?(?=\n\s*-\s+package-ecosystem:|$)/,
  );
  assert.ok(actionsBlock, "github-actions ecosystem block not found");
  assert.match(
    actionsBlock[0],
    /open-pull-requests-limit:\s+0/,
    "github-actions open-pull-requests-limit must be 0",
  );
});
