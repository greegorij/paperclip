import { FLEET_INVARIANTS } from "./fleet-invariants.mjs";

function builtInKey(agent) {
  return agent?.metadata?.paperclipBuiltInAgent?.key ?? null;
}

function nonEmptyInstructions(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function sameStringArray(a, b) {
  const left = [...(a ?? [])].map(String).sort();
  const right = [...(b ?? [])].map(String).sort();
  return JSON.stringify(left) === JSON.stringify(right);
}

function agentModel(agent) {
  return agent?.adapterConfig?.model ?? agent?.model ?? null;
}

/**
 * Fail-closed completeness gate for live and fixture snapshots.
 * Missing completeness object, wrong counters, empty instructions, or missing
 * desiredSkills / skillSnapshots are ERRORS.
 * Built-in rows must bind agentId to the unique agent whose metadata key matches.
 */
export function assertSnapshotCompleteness(snap, {
  expectedLiveAgentCount = FLEET_INVARIANTS.expectedLiveAgentCount,
  expectedPortableCount = FLEET_INVARIANTS.portableAgentCount,
  expectedBuiltInCount = FLEET_INVARIANTS.managedBuiltInCount,
  requiredBuiltInKeys = FLEET_INVARIANTS.requiredBuiltInKeys,
  allowEmptyInstructionsRepair = false,
} = {}) {
  const errors = [];
  const warnings = [];
  const agents = snap?.agents ?? [];
  const builtIns = snap?.builtIns ?? [];
  const skillSnapshots = snap?.skillSnapshots ?? [];
  const skillLibrary = snap?.skillLibrary;
  const completeness = snap?.completeness;

  if (!completeness || typeof completeness !== "object") {
    errors.push({
      code: "completeness-missing",
      message: "Snapshot missing completeness object — refuse incomplete snapshot",
    });
  } else if (completeness.complete !== true) {
    errors.push({
      code: "completeness-incomplete",
      message: "Snapshot completeness.complete is not true — refuse incomplete snapshot",
    });
  }

  if (agents.length !== expectedLiveAgentCount) {
    errors.push({
      code: "agent-count",
      message: `agents.length=${agents.length} expected ${expectedLiveAgentCount}`,
    });
  }

  const portableAgents = agents.filter((a) => !builtInKey(a));
  const builtInAgents = agents.filter((a) => builtInKey(a));
  if (portableAgents.length !== expectedPortableCount) {
    errors.push({
      code: "portable-count",
      message: `portable agents=${portableAgents.length} expected ${expectedPortableCount}`,
    });
  }
  if (builtInAgents.length !== expectedBuiltInCount) {
    errors.push({
      code: "builtin-agent-count",
      message: `built-in agents via metadata=${builtInAgents.length} expected ${expectedBuiltInCount}`,
    });
  }
  if (builtIns.length !== expectedBuiltInCount) {
    errors.push({
      code: "builtin-rows-count",
      message: `builtIns.length=${builtIns.length} expected ${expectedBuiltInCount}`,
    });
  }

  const boundAgentIds = [];

  for (const key of requiredBuiltInKeys) {
    const biRows = builtIns.filter((b) => b.key === key);
    const metaAgents = builtInAgents.filter((a) => builtInKey(a) === key);

    if (biRows.length !== 1) {
      errors.push({
        code: biRows.length === 0 ? "builtin-key-missing" : "builtin-key-duplicate",
        message:
          biRows.length === 0
            ? `missing required built-in key ${key} in builtIns`
            : `builtIns has ${biRows.length} rows for key ${key}; expected exactly 1`,
      });
    }
    if (metaAgents.length !== 1) {
      errors.push({
        code:
          metaAgents.length === 0
            ? "builtin-agent-key-missing"
            : "builtin-agent-key-duplicate",
        message:
          metaAgents.length === 0
            ? `missing required built-in key ${key} in agents metadata`
            : `agents metadata has ${metaAgents.length} agents for key ${key}; expected exactly 1`,
      });
    }

    if (biRows.length !== 1 || metaAgents.length !== 1) continue;

    const bi = biRows[0];
    const agent = metaAgents[0];
    const agentId = typeof bi.agentId === "string" ? bi.agentId.trim() : "";

    if (!agentId) {
      errors.push({
        code: "builtin-agent-id-empty",
        message: `built-in ${key}: agentId missing/empty`,
      });
    } else if (agentId !== agent.id) {
      errors.push({
        code: "builtin-agent-id-mismatch",
        message: `built-in ${key}: agentId=${agentId} != metadata agent id=${agent.id}`,
      });
    } else {
      boundAgentIds.push(agentId);
    }

    const biModel = bi.model ?? bi.adapterConfig?.model ?? null;
    const liveModel = agentModel(agent);
    if (biModel !== liveModel) {
      errors.push({
        code: "builtin-model-divergence",
        message: `built-in ${key}: builtIns.model=${biModel} != agent.model=${liveModel}`,
      });
    }

    if ((bi.instructions ?? null) !== (agent.instructions ?? null)) {
      errors.push({
        code: "builtin-instructions-divergence",
        message: `built-in ${key}: builtIns.instructions diverge from linked agent`,
      });
    }

    if (!Array.isArray(bi.desiredSkills)) {
      errors.push({
        code: "builtin-desired-skills-missing",
        message: `built-in ${key}: desiredSkills must be an array on builtIns row`,
      });
    } else if (!Array.isArray(agent.desiredSkills)) {
      errors.push({
        code: "agent-desired-skills-missing",
        message: `${agent.slug ?? agent.id}: desiredSkills must be an array`,
      });
    } else if (!sameStringArray(bi.desiredSkills, agent.desiredSkills)) {
      errors.push({
        code: "builtin-desired-skills-divergence",
        message: `built-in ${key}: builtIns.desiredSkills diverge from linked agent`,
      });
    }

    if (!nonEmptyInstructions(bi.instructions)) {
      errors.push({
        code: "builtin-instructions-missing",
        message: `built-in ${key} instructions missing/empty after trim`,
      });
    }
  }

  if (boundAgentIds.length >= 2) {
    const unique = new Set(boundAgentIds);
    if (unique.size !== boundAgentIds.length) {
      errors.push({
        code: "builtin-agent-id-collision",
        message: `built-in agentIds must be distinct; got [${boundAgentIds.join(", ")}]`,
      });
    }
  }

  for (const bi of builtIns) {
    if (!requiredBuiltInKeys.includes(bi.key)) {
      errors.push({
        code: "builtin-key-unexpected",
        message: `unexpected built-in key ${bi.key}`,
      });
    }
  }

  const skillSnapByAgent = new Map(
    skillSnapshots.filter((s) => s?.agentId).map((s) => [s.agentId, s]),
  );

  for (const agent of agents) {
    const label = agent.slug ?? agent.name ?? agent.id;
    const slug = typeof agent.slug === "string" && agent.slug.trim() !== ""
      ? agent.slug
      : null;
    const isBuiltIn = Boolean(builtInKey(agent));
    if (!nonEmptyInstructions(agent.instructions)) {
      // Built-ins are never repairable via empty-bundle seed — always errors.
      const repairable = allowEmptyInstructionsRepair && !isBuiltIn;
      const item = {
        code: "agent-instructions-empty",
        ...(slug ? { slug } : {}),
        message: repairable
          ? `${label}: AGENTS.md missing/empty after trim (repairable via apply empty-bundle seed)`
          : `${label}: AGENTS.md missing/empty after trim`,
      };
      if (repairable) warnings.push(item);
      else errors.push(item);
    }
    if (!Array.isArray(agent.desiredSkills)) {
      errors.push({
        code: "agent-desired-skills-missing",
        message: `${label}: desiredSkills must be an array`,
      });
    }
    if (!skillSnapByAgent.has(agent.id)) {
      errors.push({
        code: "agent-skill-snapshot-missing",
        message: `${label}: skill snapshot missing for agent id ${agent.id}`,
      });
    }
  }

  if (!Array.isArray(skillLibrary)) {
    errors.push({
      code: "skill-library-absent",
      message: "skillLibrary missing — refuse incomplete snapshot",
    });
  } else if (skillLibrary.length === 0) {
    errors.push({
      code: "skill-library-empty",
      message: "skillLibrary is empty — refuse incomplete snapshot",
    });
  }

  if (completeness && typeof completeness === "object" && completeness.complete === true) {
    const checks = [
      ["agentCount", agents.length],
      ["portableCount", portableAgents.length],
      ["builtInCount", builtIns.length],
      ["instructionsFetched", agents.length],
      ["skillsFetched", skillSnapshots.length],
    ];
    for (const [field, actual] of checks) {
      if (completeness[field] !== actual) {
        errors.push({
          code: "completeness-counter-mismatch",
          message: `completeness.${field}=${completeness[field]} != actual ${actual}`,
        });
      }
    }
    if (Array.isArray(skillLibrary) && completeness.skillLibraryCount !== skillLibrary.length) {
      errors.push({
        code: "completeness-counter-mismatch",
        message: `completeness.skillLibraryCount=${completeness.skillLibraryCount} != actual ${skillLibrary.length}`,
      });
    }
    if (completeness.skillLibraryPresent !== true) {
      errors.push({
        code: "completeness-library-flag",
        message: "completeness.skillLibraryPresent must be true",
      });
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    portableCount: portableAgents.length,
    builtInCount: builtIns.length,
  };
}
