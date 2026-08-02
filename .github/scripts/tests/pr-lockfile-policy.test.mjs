/**
 * Contract + decision tests for PR lockfile policy and refresh-lockfile workflow.
 * Runs without pnpm install / YAML parser — plain text + decideLockfileRegen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideLockfileRegen } from '../pr-lockfile-regen.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);

function readWorkflow(name) {
  return readFileSync(path.join(repoRoot, '.github', 'workflows', name), 'utf8');
}

function policyRegenStep(prYml) {
  const match = prYml.match(
    /- name: Validate dependency resolution \(always regenerate check\)[\s\S]*?(?=\n      - name:|\n  [a-z_]+:|$)/,
  );
  assert.ok(match, 'pr.yml must define the always-regenerate lockfile step');
  return match[0];
}

// ---------------------------------------------------------------------------
// decideLockfileRegen — stale base vs clean lock
// ---------------------------------------------------------------------------

test('stale base lockfile without manifest change marks regenerated=1 (artifact)', () => {
  // Simulates: PR touches only app code; base production lockfile is stale
  // relative to current manifests, so install --lockfile-only rewrites it.
  const checkout = "lockfileVersion: '9.0'\nimporters:\n  .: {}\n";
  const afterInstall = "lockfileVersion: '9.0'\nimporters:\n  .: {}\npackages:\n  foo@1.0.0: {}\n";
  assert.notEqual(checkout, afterInstall);
  assert.deepEqual(decideLockfileRegen(checkout, afterInstall), { regenerated: '1' });
});

test('clean lockfile matching install result marks regenerated=0 (no artifact)', () => {
  const lock = "lockfileVersion: '9.0'\nimporters:\n  .: {}\n";
  assert.deepEqual(decideLockfileRegen(lock, lock), { regenerated: '0' });
});

// ---------------------------------------------------------------------------
// pr.yml wiring
// ---------------------------------------------------------------------------

test('pr.yml always runs lockfile-only install (not gated on manifest changes)', () => {
  const step = policyRegenStep(readWorkflow('pr.yml'));
  assert.match(
    step,
    /pnpm install --lockfile-only --ignore-scripts --no-frozen-lockfile/,
  );
  assert.doesNotMatch(
    step,
    /manifest_pattern|package\\.json\$/,
    'regen must not be conditional on manifest path changes',
  );
  assert.match(step, /pr-lockfile-regen\.mjs write-github-output/);
});

test('pr.yml uploads lockfile artifact only when regenerated=1 and never commits it', () => {
  const wf = readWorkflow('pr.yml');
  assert.match(
    wf,
    /if:\s+steps\.regen_lockfile\.outputs\.regenerated == '1'/,
  );
  assert.match(wf, /name:\s+pr-lockfile/);
  assert.doesNotMatch(
    policyRegenStep(wf),
    /git commit|git add pnpm-lock/,
    'policy must not commit the regenerated lockfile',
  );
});

test('pr.yml allows lockfile only on bot refresh branches including production', () => {
  const wf = readWorkflow('pr.yml');
  const block = wf.match(
    /- name: Block manual lockfile edits[\s\S]*?(?=\n      - name:|\n  [a-z_]+:|$)/,
  );
  assert.ok(block, 'Block manual lockfile edits step missing');
  assert.match(block[0], /chore\/refresh-lockfile/);
  assert.match(block[0], /chore\/refresh-lockfile-production/);
  assert.match(block[0], /github-actions\[bot\]/);
});

// ---------------------------------------------------------------------------
// refresh-lockfile.yml — production target
// ---------------------------------------------------------------------------

test('refresh-lockfile.yml runs on push to master and production and manually', () => {
  const wf = readWorkflow('refresh-lockfile.yml');
  assert.match(wf, /branches:\s*\n\s+- master\s*\n\s+- production/);
  assert.match(wf, /workflow_dispatch:/);
});

test('refresh-lockfile.yml concurrency is per target ref (does not mix targets)', () => {
  const wf = readWorkflow('refresh-lockfile.yml');
  assert.match(
    wf,
    /group:\s+refresh-lockfile-\$\{\{\s*github\.ref_name\s*\}\}/,
  );
  assert.doesNotMatch(wf, /group:\s+refresh-lockfile-master\b/);
});

test('refresh-lockfile.yml explicitly targets production with base, bot branch, and PR search', () => {
  const wf = readWorkflow('refresh-lockfile.yml');
  assert.match(wf, /TARGET_BRANCH:\s+\$\{\{\s*github\.ref_name\s*\}\}/);
  assert.match(wf, /chore\/refresh-lockfile-\$\{TARGET_BRANCH\}/);
  assert.match(wf, /--base "\$TARGET_BRANCH"/);
  assert.match(
    wf,
    /gh pr list --state open --head "\$BRANCH" --base "\$TARGET_BRANCH"/,
  );
  assert.match(wf, /gh pr create \\/);
  assert.match(wf, /--base "\$TARGET_BRANCH" \\/);
  assert.match(wf, /gh pr merge --auto --squash --delete-branch/);
});
