#!/usr/bin/env node
/**
 * check-pr-lockfile.mjs
 * Checks that pnpm-lock.yaml was not manually edited.
 * Export: checkLockfile(files, prAuthor, prBranch) → { passed, failures }
 *
 * Allowed lockfile commits: github-actions[bot] on dedicated refresh branches
 * only (`chore/refresh-lockfile` for master, `chore/refresh-lockfile-production`
 * for production). Author check is never loosened for those branches.
 */
import { fileURLToPath } from 'node:url';

export const LOCKFILE_REFRESH_BRANCHES = Object.freeze([
  'chore/refresh-lockfile',
  'chore/refresh-lockfile-production',
]);

export function isLockfileRefreshBot(prAuthor, prBranch) {
  return (
    prAuthor === 'github-actions[bot]' &&
    LOCKFILE_REFRESH_BRANCHES.includes(prBranch)
  );
}

export function checkLockfile(files, prAuthor, prBranch) {
  const lockfileChanged = files.some(f => f.filename === 'pnpm-lock.yaml');
  if (!lockfileChanged) return { passed: true, failures: [] };

  const allowed = isLockfileRefreshBot(prAuthor, prBranch);

  return {
    passed: allowed,
    failures: allowed ? [] : [
      'You have changes to `pnpm-lock.yaml` — `pr.yml` will hard-fail this PR with a confusing message about lockfile edits. ' +
      'To fix: run `pnpm install` locally, exclude the lockfile from your commit, push again. ' +
      'The lockfile is regenerated automatically by the refresh bot on a schedule.',
    ],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = JSON.parse(process.env.PR_FILES ?? '[]');
  const result = checkLockfile(files, process.env.PR_AUTHOR ?? '', process.env.PR_BRANCH ?? '');
  console.log(JSON.stringify(result));
  process.exit(result.passed ? 0 : 1);
}
