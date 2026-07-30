import { validateFleet } from "./validate.mjs";
import { diffFleet } from "./diff.mjs";

/**
 * Kinds that verify may ignore as remaining (manual / informational only).
 * builtin-model and builtin-skills MUST remain and fail verify.
 */
const VERIFY_IGNORE_KINDS = new Set([
  // none currently — built-in model/skills are required for verify ok
]);

/**
 * Post-apply verification: re-validate desired vs (new) live snapshot and require empty diff
 * for mutable targets including built-in model and skills.
 */
export function verifyFleet({ packageDir, desiredDir, liveSnapshot, includeBuiltInInstructions }) {
  const validation = validateFleet({
    packageDir,
    desiredDir,
    liveSnapshot,
    includeBuiltInInstructions,
  });
  const diff = diffFleet({ packageDir, desiredDir, liveSnapshot });
  const remainingMutable = diff.changes.filter(
    (c) => !c.blocking && !VERIFY_IGNORE_KINDS.has(c.kind),
  );
  const remainingBlocking = diff.changes.filter((c) => c.blocking);

  return {
    ok: validation.ok && remainingMutable.length === 0 && remainingBlocking.length === 0,
    validation,
    diff,
    remainingMutable,
    remainingBlocking,
  };
}
