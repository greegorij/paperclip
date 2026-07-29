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
