/**
 * Detect named instruction/model contradictions.
 */

export function checkContradiction(rule, { instructions = "", model = null } = {}) {
  const hits = [];
  for (const pattern of rule.forbidPatterns ?? []) {
    const re = new RegExp(pattern, "i");
    if (re.test(instructions)) {
      hits.push({
        kind: "forbid",
        pattern,
        message: `Forbidden pattern matched: ${pattern}`,
      });
    }
  }
  for (const pattern of rule.requirePatterns ?? []) {
    const re = new RegExp(pattern, "i");
    if (!re.test(instructions)) {
      hits.push({
        kind: "require",
        pattern,
        message: `Required pattern missing: ${pattern}`,
      });
    }
  }
  if (rule.expectedModel && model != null && model !== rule.expectedModel) {
    hits.push({
      kind: "model",
      pattern: rule.expectedModel,
      message: `Expected model ${rule.expectedModel}, got ${model}`,
    });
  }
  return {
    id: rule.id,
    agentSlug: rule.agentSlug,
    ok: hits.length === 0,
    hits,
    description: rule.description,
  };
}

export function checkAllContradictions(rules, contextBySlug) {
  return rules.map((rule) => {
    const ctx = contextBySlug[rule.agentSlug] ?? { instructions: "", model: null };
    return checkContradiction(rule, ctx);
  });
}
