import { skillShortName } from "./load.mjs";

/**
 * Resolve skillKeys against the live skill library.
 * Full keys that appear exactly once are accepted even when another full key
 * shares the same short-name suffix. Short names are refused (apply never
 * accepts shortcuts).
 *
 * @param {string[]} skillKeys
 * @param {Array<string|{key:string}>} skillLibrary
 */
export function resolveFullSkillKeys(skillKeys, skillLibrary) {
  if (!Array.isArray(skillKeys) || skillKeys.length === 0) {
    return { ok: false, error: "skillKeys must be a non-empty array of full keys" };
  }
  if (!Array.isArray(skillLibrary)) {
    return { ok: false, error: "skillLibrary missing — cannot resolve skill keys" };
  }

  const libraryKeys = skillLibrary.map((s) => (typeof s === "string" ? s : s?.key)).filter(Boolean);
  const counts = new Map();
  for (const key of libraryKeys) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const resolved = [];
  for (const want of skillKeys) {
    const key = String(want);
    if (!key.includes("/")) {
      return {
        ok: false,
        error: `Refusing short skill name "${key}" — provide a full library key`,
      };
    }
    const n = counts.get(key) ?? 0;
    if (n === 0) {
      return { ok: false, error: `skill key missing from live skillLibrary: ${key}` };
    }
    if (n > 1) {
      return { ok: false, error: `duplicate skill key in live skillLibrary: ${key}` };
    }
    // Unique full key wins even if other keys share the short-name suffix.
    resolved.push(key);
  }

  return { ok: true, keys: resolved };
}

/**
 * Preflight every agent-skills / builtin-skills change before the first mutation.
 */
export function preflightSkillKeyResolutions(changes, skillLibrary) {
  const resolutions = new Map();
  for (const change of changes) {
    if (change.kind !== "agent-skills" && change.kind !== "builtin-skills") continue;
    if (!Array.isArray(change.skillKeys) || change.skillKeys.length === 0) {
      return {
        ok: false,
        error: `${change.kind} for ${change.target}: missing full skillKeys on change (no short-name / live desiredSkills fallback)`,
      };
    }
    const resolved = resolveFullSkillKeys(change.skillKeys, skillLibrary);
    if (!resolved.ok) {
      return { ok: false, error: `${change.target}: ${resolved.error}` };
    }
    const mapKey =
      change.kind === "builtin-skills" ? `builtin:${change.target}` : change.target;
    resolutions.set(mapKey, resolved.keys);
  }
  return { ok: true, resolutions };
}

/**
 * Bootstrap resolver: exact full key wins; short/pseudo input with 0 or >1
 * short-name matches fails closed (never matches[0]).
 */
export function resolveBootstrapSkillKey(shortOrFull, catalogKeys) {
  const key = String(shortOrFull);
  if (catalogKeys.has(key)) return { ok: true, key };
  const short = skillShortName(key);
  const matches = [...catalogKeys].filter((k) => skillShortName(k) === short);
  if (matches.length === 1) return { ok: true, key: matches[0] };
  if (matches.length === 0) {
    return {
      ok: false,
      error: `skill key unresolved (0 matches): ${key}`,
    };
  }
  return {
    ok: false,
    error: `skill key ambiguous (${matches.length} matches for short "${short}"): ${key}`,
  };
}
