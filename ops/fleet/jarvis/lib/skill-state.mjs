/**
 * Skill catalog vs assignment rules.
 *
 * entries.length may be ~39 (full catalog). That is NOT assignment.
 * Exactly N desired skills must be in the adapter's active state; remainder available.
 */

export function countActiveSkills(entries, activeState) {
  return (entries ?? []).filter((e) => e.state === activeState && e.desired === true).length;
}

export function countDesiredFlag(entries) {
  return (entries ?? []).filter((e) => e.desired === true).length;
}

/**
 * @param {{ adapterType: string, entries: Array<{state:string, desired?:boolean}>, desiredCount?: number }} snapshot
 * @param {Record<string, {desiredMin:number, desiredMax:number, activeState:string}>} policy
 */
export function validateSkillRuntime(snapshot, policy) {
  const findings = [];
  const adapterType = snapshot.adapterType;
  const rule = policy[adapterType];
  if (!rule) {
    findings.push({
      severity: "info",
      code: "skill-policy-unscoped",
      message: `No skill runtime policy for adapterType=${adapterType}`,
    });
    return findings;
  }

  const entries = snapshot.entries ?? [];
  const desiredCount =
    snapshot.desiredCount ??
    snapshot.desiredSkills?.length ??
    countDesiredFlag(entries);
  const activeDesired = entries.filter(
    (e) => e.desired === true && e.state === rule.activeState,
  ).length;
  const activeAll = entries.filter((e) => e.state === rule.activeState).length;

  if (desiredCount < rule.desiredMin || desiredCount > rule.desiredMax) {
    findings.push({
      severity: "error",
      code: "skill-desired-count-out-of-range",
      message: `${adapterType}: desiredCount=${desiredCount} outside ${rule.desiredMin}-${rule.desiredMax}`,
      desiredCount,
      activeState: rule.activeState,
    });
  }

  // False-positive trap: 39 catalog entries all marked configured/installed
  if (entries.length >= 39 && activeAll >= 39) {
    findings.push({
      severity: "error",
      code: "skill-catalog-treated-as-assignment",
      message: `${adapterType}: ${entries.length} entries with ${activeAll} in state=${rule.activeState} — catalog length is not assignment`,
    });
  }

  // Healthy case: catalog can be large, but only desiredCount are active
  if (
    entries.length >= 39 &&
    desiredCount >= rule.desiredMin &&
    desiredCount <= rule.desiredMax &&
    activeDesired === desiredCount &&
    activeAll === desiredCount
  ) {
    findings.push({
      severity: "ok",
      code: "skill-catalog-ok",
      message: `${adapterType}: ${entries.length} catalog entries with exactly ${desiredCount} ${rule.activeState}`,
    });
  } else if (
    desiredCount >= rule.desiredMin &&
    desiredCount <= rule.desiredMax &&
    activeDesired !== desiredCount
  ) {
    findings.push({
      severity: "error",
      code: "skill-active-mismatch",
      message: `${adapterType}: expected ${desiredCount} desired skills in state=${rule.activeState}, found ${activeDesired}`,
    });
  }

  return findings;
}

export function assertSkillShortNamesMatch(actualKeys, expectedShortNames) {
  const actualShort = new Set((actualKeys ?? []).map((k) => {
    const parts = String(k).split("/");
    return parts[parts.length - 1];
  }));
  const expected = new Set(expectedShortNames);
  const missing = [...expected].filter((s) => !actualShort.has(s));
  const extra = [...actualShort].filter((s) => !expected.has(s));
  return { ok: missing.length === 0 && extra.length === 0, missing, extra };
}
