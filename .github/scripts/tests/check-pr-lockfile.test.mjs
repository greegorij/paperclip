import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkLockfile,
  isLockfileRefreshBot,
  LOCKFILE_REFRESH_BRANCHES,
} from '../check-pr-lockfile.mjs';

const makeFiles = (filenames) => filenames.map(f => ({ filename: f, status: 'modified' }));

test('passes when lockfile is not changed', () => {
  assert.equal(checkLockfile(makeFiles(['src/foo.ts']), 'someuser', 'fix/bug').passed, true);
});

test('passes when lockfile changed by refresh bot on master refresh branch', () => {
  const result = checkLockfile(
    makeFiles(['pnpm-lock.yaml']),
    'github-actions[bot]',
    'chore/refresh-lockfile'
  );
  assert.equal(result.passed, true);
});

test('passes when lockfile changed by refresh bot on production refresh branch', () => {
  const result = checkLockfile(
    makeFiles(['pnpm-lock.yaml']),
    'github-actions[bot]',
    'chore/refresh-lockfile-production'
  );
  assert.equal(result.passed, true);
});

test('fails when lockfile changed by regular user', () => {
  const result = checkLockfile(makeFiles(['pnpm-lock.yaml']), 'someuser', 'fix/bug');
  assert.equal(result.passed, false);
  assert.ok(result.failures[0].includes('pnpm-lock.yaml'));
});

test('fails when lockfile changed by bot on wrong branch', () => {
  const result = checkLockfile(
    makeFiles(['pnpm-lock.yaml']),
    'github-actions[bot]',
    'fix/something-else'
  );
  assert.equal(result.passed, false);
});

test('production refresh branch is allowed only for github-actions[bot]', () => {
  assert.equal(
    checkLockfile(
      makeFiles(['pnpm-lock.yaml']),
      'github-actions[bot]',
      'chore/refresh-lockfile-production'
    ).passed,
    true
  );
  assert.equal(
    checkLockfile(
      makeFiles(['pnpm-lock.yaml']),
      'someuser',
      'chore/refresh-lockfile-production'
    ).passed,
    false,
    'author must not be loosened for the production bot branch'
  );
  assert.equal(
    checkLockfile(
      makeFiles(['pnpm-lock.yaml']),
      'dependabot[bot]',
      'chore/refresh-lockfile-production'
    ).passed,
    false
  );
  assert.equal(
    isLockfileRefreshBot('someuser', 'chore/refresh-lockfile-production'),
    false
  );
  assert.ok(LOCKFILE_REFRESH_BRANCHES.includes('chore/refresh-lockfile-production'));
});

test('manual lockfile edits remain blocked on ordinary branches', () => {
  for (const author of ['alice', 'dependabot[bot]', 'github-actions[bot]']) {
    const result = checkLockfile(
      makeFiles(['pnpm-lock.yaml', 'README.md']),
      author,
      'feature/update-deps-manually'
    );
    if (author === 'github-actions[bot]') {
      assert.equal(result.passed, false, 'bot on non-refresh branch is still blocked');
    } else {
      assert.equal(result.passed, false, `${author} must be blocked for manual lockfile edits`);
    }
  }
});
