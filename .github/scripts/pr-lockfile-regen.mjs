#!/usr/bin/env node
/**
 * pr-lockfile-regen.mjs
 * After `pnpm install --lockfile-only`, decide whether the working-tree
 * lockfile differs from checkout and should be uploaded as a CI artifact.
 *
 * Export: decideLockfileRegen(checkoutContent, afterInstallContent)
 * CLI:    node pr-lockfile-regen.mjs write-github-output
 *         reads pnpm-lock.yaml vs `git show HEAD:pnpm-lock.yaml` (or empty)
 *         and appends regenerated=0|1 to $GITHUB_OUTPUT
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function decideLockfileRegen(checkoutContent, afterInstallContent) {
  return {
    regenerated: checkoutContent === afterInstallContent ? '0' : '1',
  };
}

function readCheckoutLockfile() {
  try {
    return execFileSync('git', ['show', 'HEAD:pnpm-lock.yaml'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return '';
  }
}

function writeGithubOutput() {
  const out = process.env.GITHUB_OUTPUT;
  if (!out) {
    throw new Error('GITHUB_OUTPUT is not set');
  }
  const after = existsSync('pnpm-lock.yaml')
    ? readFileSync('pnpm-lock.yaml', 'utf8')
    : '';
  const { regenerated } = decideLockfileRegen(readCheckoutLockfile(), after);
  appendFileSync(out, `regenerated=${regenerated}\n`);
  return regenerated;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2] ?? 'write-github-output';
  if (cmd !== 'write-github-output') {
    console.error(`Unknown command: ${cmd}`);
    process.exit(2);
  }
  const regenerated = writeGithubOutput();
  console.log(`lockfile regenerated=${regenerated}`);
}
