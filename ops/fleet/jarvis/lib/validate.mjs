import { existsSync } from "node:fs";
import path from "node:path";
import { loadDesired, loadPackage, skillShortName } from "./load.mjs";
import { checkAllContradictions } from "./contradictions.mjs";
import { assertSkillShortNamesMatch, validateSkillRuntime } from "./skill-state.mjs";
import { matchRoutineStrict } from "./diff.mjs";
import {
  FLEET_INVARIANTS,
  assertDesiredFleetMatchesInvariants,
} from "./fleet-invariants.mjs";
import { assertSnapshotCompleteness } from "./snapshot-completeness.mjs";

function expectedModelForAgent(slug, adapterType, modelsDesired) {
  const explicit = modelsDesired.agents[slug];
  if (explicit) return explicit.model ?? null;
  if (adapterType === "claude_local") return modelsDesired.defaultClaudeLocalModel;
  return undefined;
}

function collectDesiredSkillKeys(desired) {
  const keys = new Set();
  for (const agent of desired.agents?.agents ?? []) {
    for (const key of agent.skillKeys ?? []) keys.add(key);
  }
  for (const bi of desired.builtIns?.builtIns ?? []) {
    for (const key of bi.skillKeys ?? []) keys.add(key);
  }
  return [...keys];
}

function builtInKey(agent) {
  return agent?.metadata?.paperclipBuiltInAgent?.key ?? null;
}

function resolveAgentInstructions(agent, liveSnapshot) {
  if (typeof agent.instructions === "string" && agent.instructions.trim().length > 0) {
    return agent.instructions;
  }
  const key = builtInKey(agent);
  if (!key) return null;
  const bi = (liveSnapshot.builtIns ?? []).find((b) => b.key === key);
  if (typeof bi?.instructions === "string" && bi.instructions.trim().length > 0) {
    return bi.instructions;
  }
  return null;
}

function canonicalLiveModel(agent) {
  return agent?.adapterConfig?.model ?? agent?.model ?? null;
}

function sameStringArray(a, b) {
  const left = [...(a ?? [])].map(String).sort();
  const right = [...(b ?? [])].map(String).sort();
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameStringArrayInOrder(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (String(a[i]) !== String(b[i])) return false;
  }
  return true;
}

function sameStringSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  const left = new Set(a.map(String));
  const right = new Set(b.map(String));
  if (left.size !== right.size) return false;
  for (const item of left) {
    if (!right.has(item)) return false;
  }
  return true;
}

function isScalar(value) {
  return value == null || ["string", "number", "boolean"].includes(typeof value);
}

function hasExactObjectKeys(value, expectedKeys) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return JSON.stringify(actual) === JSON.stringify(expected);
}

const REQUIRED_RUNTIME_POLICY_EXTRA_ARGS = Object.freeze([
  "--sandbox",
  "danger-full-access",
  "--skip-git-repo-check",
]);

const MANAGED_RUNTIME_POLICY_KEYS = Object.freeze([
  "status",
  "maxConcurrentRuns",
  "adapterType",
  "model",
  "adapterConfig",
  "heartbeat",
]);

const MANAGED_RUNTIME_ADAPTER_CONFIG_KEYS = Object.freeze([
  "engine",
  "model",
  "modelReasoningEffort",
  "fastMode",
  "search",
  "dangerouslyBypassApprovalsAndSandbox",
  "filesystemScope",
  "filesystemWorkspaceAccess",
  "networkScope",
  "networkAllowlist",
  "extraArgs",
]);

const MANAGED_RUNTIME_HEARTBEAT_KEYS = Object.freeze([
  "enabled",
  "wakeOnDemand",
  "maxDailyRuns",
]);

function validateExpectedRuntimePolicyShape(agent, errors) {
  const policy = agent.expectedRuntimePolicy;
  if (!policy) return;
  if (policy == null || typeof policy !== "object" || Array.isArray(policy)) {
    errors.push({
      code: "runtime-policy-structure",
      message: `${agent.slug}: expectedRuntimePolicy must be an object`,
    });
    return;
  }

  const isManagedOpenAiPolicy =
    "status" in policy || "adapterType" in policy || "model" in policy || "heartbeat" in policy;

  if (isManagedOpenAiPolicy) {
    if (!hasExactObjectKeys(policy, MANAGED_RUNTIME_POLICY_KEYS)) {
      errors.push({
        code: "runtime-policy-structure",
        message: `${agent.slug}: expectedRuntimePolicy must include exactly ${MANAGED_RUNTIME_POLICY_KEYS.join(", ")}`,
      });
    }
    if (agent.manageStatus !== true || agent.status !== "paused") {
      errors.push({
        code: "runtime-policy-managed-status",
        message: `${agent.slug}: manageStatus:true and status:paused are required when expectedRuntimePolicy manages runtime`,
      });
    }
    if (policy.status !== "paused") {
      errors.push({
        code: "runtime-policy-status",
        message: `${agent.slug}: expectedRuntimePolicy.status must equal paused`,
      });
    }
    if (policy.adapterType !== agent.adapterType) {
      errors.push({
        code: "runtime-policy-adapter-type",
        message: `${agent.slug}: expectedRuntimePolicy.adapterType must match desired adapterType`,
      });
    }
    if (policy.model !== (agent.model ?? null)) {
      errors.push({
        code: "runtime-policy-model",
        message: `${agent.slug}: expectedRuntimePolicy.model must match desired model`,
      });
    }
  }

  if (typeof policy.maxConcurrentRuns === "number" && policy.maxConcurrentRuns !== 1) {
    errors.push({
      code: "runtime-policy-max-concurrent",
      message: `${agent.slug}: expectedRuntimePolicy.maxConcurrentRuns must equal 1`,
    });
  }

  const adapterConfig = policy.adapterConfig;
  if (adapterConfig == null || typeof adapterConfig !== "object" || Array.isArray(adapterConfig)) {
    errors.push({
      code: "runtime-policy-adapter-config",
      message: `${agent.slug}: expectedRuntimePolicy.adapterConfig must be an object`,
    });
  } else {
    if (isManagedOpenAiPolicy && !hasExactObjectKeys(adapterConfig, MANAGED_RUNTIME_ADAPTER_CONFIG_KEYS)) {
      errors.push({
        code: "runtime-policy-adapter-config-structure",
        message: `${agent.slug}: expectedRuntimePolicy.adapterConfig must include exactly ${MANAGED_RUNTIME_ADAPTER_CONFIG_KEYS.join(", ")}`,
      });
    }
    if (adapterConfig.filesystemScope !== "workspace") {
      errors.push({
        code: "runtime-policy-filesystem-scope",
        message: `${agent.slug}: adapterConfig.filesystemScope must equal workspace`,
      });
    }
    if (!["ro", "rw"].includes(adapterConfig.filesystemWorkspaceAccess)) {
      errors.push({
        code: "runtime-policy-workspace-access",
        message: `${agent.slug}: adapterConfig.filesystemWorkspaceAccess must be ro or rw`,
      });
    }
    if (adapterConfig.networkScope !== "allowlist") {
      errors.push({
        code: "runtime-policy-network-scope",
        message: `${agent.slug}: adapterConfig.networkScope must equal allowlist`,
      });
    }
    if (adapterConfig.dangerouslyBypassApprovalsAndSandbox !== false) {
      errors.push({
        code: "runtime-policy-bypass",
        message: `${agent.slug}: adapterConfig.dangerouslyBypassApprovalsAndSandbox must equal false`,
      });
    }
    if (!sameStringArrayInOrder(adapterConfig.extraArgs, REQUIRED_RUNTIME_POLICY_EXTRA_ARGS)) {
      errors.push({
        code: "runtime-policy-extra-args",
        message: `${agent.slug}: adapterConfig.extraArgs must pin --sandbox danger-full-access --skip-git-repo-check`,
      });
    }
    if (!Array.isArray(adapterConfig.networkAllowlist) || adapterConfig.networkAllowlist.length === 0) {
      errors.push({
        code: "runtime-policy-network-allowlist",
        message: `${agent.slug}: adapterConfig.networkAllowlist must be a non-empty array`,
      });
    }
  }

  if (policy.heartbeat !== undefined) {
    if (
      policy.heartbeat == null ||
      typeof policy.heartbeat !== "object" ||
      Array.isArray(policy.heartbeat)
    ) {
      errors.push({
        code: "runtime-policy-heartbeat",
        message: `${agent.slug}: expectedRuntimePolicy.heartbeat must be an object`,
      });
    } else {
      if (!hasExactObjectKeys(policy.heartbeat, MANAGED_RUNTIME_HEARTBEAT_KEYS)) {
        errors.push({
          code: "runtime-policy-heartbeat-structure",
          message: `${agent.slug}: expectedRuntimePolicy.heartbeat must include exactly ${MANAGED_RUNTIME_HEARTBEAT_KEYS.join(", ")}`,
        });
      }
      if (policy.heartbeat.enabled !== false) {
        errors.push({
          code: "runtime-policy-heartbeat-enabled",
          message: `${agent.slug}: expectedRuntimePolicy.heartbeat.enabled must equal false`,
        });
      }
      if (policy.heartbeat.wakeOnDemand !== true) {
        errors.push({
          code: "runtime-policy-heartbeat-wake",
          message: `${agent.slug}: expectedRuntimePolicy.heartbeat.wakeOnDemand must equal true`,
        });
      }
      if (
        !Number.isInteger(policy.heartbeat.maxDailyRuns) ||
        policy.heartbeat.maxDailyRuns < 1
      ) {
        errors.push({
          code: "runtime-policy-heartbeat-max-daily-runs",
          message: `${agent.slug}: expectedRuntimePolicy.heartbeat.maxDailyRuns must be an integer >= 1`,
        });
      }
    }
  }
}

/**
 * Validate portable package + desired overlays (+ optional live snapshot).
 *
 * @param {{ forApply?: boolean }} [options]
 *   When forApply=true, mutable live drifts (routine status/trigger, Codex pause)
 *   become warnings so apply can repair them; structural incompleteness stays ERROR.
 */
export function validateFleet({
  packageDir,
  desiredDir,
  liveSnapshot = null,
  includeBuiltInInstructions = null,
  forApply = false,
} = {}) {
  const desired = loadDesired(desiredDir);
  const pkg = loadPackage(packageDir);
  const errors = [];
  const warnings = [];
  const ok = [];

  const invariantCheck = assertDesiredFleetMatchesInvariants(desired.fleet);
  if (!invariantCheck.ok) {
    for (const message of invariantCheck.errors) {
      errors.push({ code: "fleet-invariant", message });
    }
  } else {
    ok.push({
      code: "fleet-invariant",
      message: `29 = ${FLEET_INVARIANTS.portableAgentCount} portable + ${FLEET_INVARIANTS.managedBuiltInCount} built-ins`,
    });
  }

  if (pkg.agents.length !== FLEET_INVARIANTS.portableAgentCount) {
    errors.push({
      code: "portable-agent-count",
      message: `Expected ${FLEET_INVARIANTS.portableAgentCount} portable agents, found ${pkg.agents.length}`,
    });
  } else {
    ok.push({ code: "portable-agent-count", message: `${pkg.agents.length} portable agents` });
  }

  const desiredBuiltInKeys = (desired.builtIns?.builtIns ?? []).map((b) => b.key).sort();
  const requiredKeys = [...FLEET_INVARIANTS.requiredBuiltInKeys].sort();
  if (JSON.stringify(desiredBuiltInKeys) !== JSON.stringify(requiredKeys)) {
    errors.push({
      code: "built-in-keys",
      message: `desired built-ins keys [${desiredBuiltInKeys}] != required [${requiredKeys}]`,
    });
  }

  for (const bi of desired.builtIns.builtIns) {
    if (pkg.agentBySlug[bi.key] || pkg.agentBySlug[bi.displayName]) {
      errors.push({
        code: "built-in-in-package",
        message: `Managed built-in ${bi.key} must not appear in portable package`,
      });
    }
    if (!Array.isArray(bi.skillKeys) || bi.skillKeys.length === 0) {
      errors.push({
        code: "built-in-skills-missing",
        message: `Built-in ${bi.key} must declare non-empty skillKeys`,
      });
    }
  }

  const skillsRoot = path.join(packageDir, "skills");
  if (existsSync(skillsRoot)) {
    errors.push({
      code: "vendored-skills",
      message: "package/skills must not exist — skill keys are validated against the live library",
    });
  } else {
    ok.push({ code: "no-vendored-skills", message: "package/skills absent" });
  }

  if (desired.agents?.meta?.warnings) {
    errors.push({
      code: "raw-export-warnings",
      message: "desired/agents.json must not store raw export warnings (use exportWarnings categories)",
    });
  }
  if (desired.agents?.meta?.exportWarnings) {
    ok.push({ code: "export-warnings-summarized", message: "export warnings anonymized" });
  }

  for (const [slug, expected] of Object.entries(desired.skills.overrides)) {
    const agent = pkg.agentBySlug[slug];
    if (!agent) {
      errors.push({ code: "missing-agent", message: `Package missing agent ${slug}` });
      continue;
    }
    const match = assertSkillShortNamesMatch(agent.skills, expected);
    if (!match.ok) {
      errors.push({
        code: "skill-override-mismatch",
        message: `${slug}: missing=${match.missing.join(",")} extra=${match.extra.join(",")}`,
      });
    } else {
      ok.push({ code: "skill-override", message: `${slug} skills match override` });
    }
    for (const forbidden of desired.skills.forbiddenOnOverrides[slug] ?? []) {
      if (agent.skills.map(skillShortName).includes(forbidden)) {
        errors.push({
          code: "forbidden-skill",
          message: `${slug} still has forbidden skill ${forbidden}`,
        });
      }
    }
  }

  // Every portable agent must declare full skillKeys in desired/agents.json
  if (desired.agents?.agents) {
    for (const agent of desired.agents.agents) {
      if (!Array.isArray(agent.skillKeys) || agent.skillKeys.length === 0) {
        errors.push({
          code: "agent-skill-keys-missing",
          message: `${agent.slug}: desired skillKeys must be a non-empty array of full keys`,
        });
      }
      const want = expectedModelForAgent(agent.slug, agent.adapterType, desired.models);
      if (want !== undefined && agent.model !== want) {
        if (!(want == null && agent.model == null)) {
          errors.push({
            code: "model-mismatch",
            message: `${agent.slug}: desired agents.json model=${agent.model} expected=${want}`,
          });
        }
      }
      if (agent.expectedRuntimePolicy) {
        validateExpectedRuntimePolicyShape(agent, errors);
      } else if (agent.slug === "mi-sie-kodu-codex" || agent.slug === "recenzent") {
        if (agent.manageStatus !== true || agent.status !== "paused") {
          errors.push({
            code: "codex-not-paused",
            message: `${agent.slug} must have manageStatus:true and status:paused`,
          });
        }
      } else if (agent.manageStatus === true) {
        warnings.push({
          code: "unexpected-manage-status",
          message: `${agent.slug} has manageStatus:true — only Codex and Recenzent are expected`,
        });
      }
    }
    const vault = desired.agents.agents.find((a) => a.slug === "mi-sie-vault");
    if (vault && vault.model !== "claude-haiku-4-5") {
      errors.push({
        code: "vault-model-alias",
        message: `mi-sie-vault model must be normalized to claude-haiku-4-5, got ${vault.model}`,
      });
    } else if (vault) {
      ok.push({ code: "vault-model-alias", message: "mi-sie-vault normalized to claude-haiku-4-5" });
    }
  }

  // Routines must declare id + triggerId + title
  for (const routine of desired.routines.routines) {
    if (!routine.id || !routine.triggerId || !routine.title) {
      errors.push({
        code: "routine-incomplete",
        message: `Routine missing id/triggerId/title: ${JSON.stringify(routine)}`,
      });
    }
  }

  const ctx = {};
  for (const agent of pkg.agents) {
    ctx[agent.slug] = {
      instructions: agent.instructions,
      model: desired.agents?.agents?.find((a) => a.slug === agent.slug)?.model ?? null,
    };
  }
  if (includeBuiltInInstructions) {
    for (const [slug, instructions] of Object.entries(includeBuiltInInstructions)) {
      ctx[slug] = {
        instructions,
        model: desired.models.builtIns[slug]?.model ?? null,
      };
    }
  }

  const packageContradictionResults = checkAllContradictions(
    desired.contradictions.contradictions,
    ctx,
  );
  for (const result of packageContradictionResults) {
    if (result.agentSlug === "summarizer" && !ctx.summarizer) {
      warnings.push({
        code: "summarizer-check-deferred",
        message: "Summarizer contradiction check needs live/built-in instructions overlay",
      });
      continue;
    }
    if (!result.ok) {
      errors.push({
        code: `contradiction:${result.id}`,
        message: `${result.id}: ${result.hits.map((h) => h.message).join("; ")}`,
      });
    } else {
      ok.push({ code: `contradiction:${result.id}`, message: result.description });
    }
  }

  let liveContradictionResults = [];

  if (liveSnapshot) {
    const completeness = assertSnapshotCompleteness(liveSnapshot);
    if (!completeness.ok) {
      for (const item of completeness.errors) {
        errors.push(item);
      }
    } else {
      ok.push({
        code: "snapshot-completeness",
        message: "Snapshot completeness object and counters match arrays",
      });
    }

    const liveAgents = liveSnapshot.agents ?? [];
    const portableLiveBySlug = new Map(
      liveAgents
        .filter((a) => !builtInKey(a))
        .map((a) => [a.slug, a]),
    );
    if (liveAgents.length !== FLEET_INVARIANTS.expectedLiveAgentCount) {
      errors.push({
        code: "live-agent-count",
        message: `Live has ${liveAgents.length} agents, expected ${FLEET_INVARIANTS.expectedLiveAgentCount}`,
      });
    } else {
      ok.push({ code: "live-agent-count", message: "29 live agents" });
    }

    const skillSnapByAgent = new Map(
      (liveSnapshot.skillSnapshots ?? [])
        .filter((s) => s.agentId)
        .map((s) => [s.agentId, s]),
    );

    for (const agent of liveAgents) {
      const label = agent.slug ?? agent.name ?? agent.id;
      const isBuiltIn = Boolean(builtInKey(agent));
      if (!Array.isArray(agent.desiredSkills)) {
        errors.push({
          code: "agent-desired-skills-missing",
          message: `${label}: desiredSkills missing from snapshot`,
        });
      }
      const instructions = resolveAgentInstructions(agent, liveSnapshot);
      if (instructions == null || String(instructions).trim() === "") {
        errors.push({
          code: "agent-instructions-missing",
          message: `${label}: instructions missing/empty from snapshot`,
        });
      }
      if (!skillSnapByAgent.has(agent.id)) {
        errors.push({
          code: "agent-skill-snapshot-missing",
          message: `${label}: skill snapshot missing for agent id ${agent.id}`,
        });
      }

      // Portable: full skillKeys must match live desiredSkills
      if (!isBuiltIn && agent.slug) {
        const desiredAgent = desired.agents?.agents?.find((a) => a.slug === agent.slug);
        if (desiredAgent?.skillKeys && Array.isArray(agent.desiredSkills)) {
          if (!sameStringArray(desiredAgent.skillKeys, agent.desiredSkills)) {
            const item = {
              code: "agent-skills-drift",
              message: `${agent.slug}: live desiredSkills != desired skillKeys`,
            };
            if (forApply) warnings.push(item);
            else errors.push(item);
          }
        }
      }
    }

    for (const desiredAgent of desired.agents?.agents ?? []) {
      const liveAgent = portableLiveBySlug.get(desiredAgent.slug) ?? null;
      if (!liveAgent) {
        errors.push({
          code: "live-portable-agent-missing",
          message: `${desiredAgent.slug}: portable agent missing from live snapshot`,
        });
        continue;
      }

      if (liveAgent.adapterType !== desiredAgent.adapterType) {
        errors.push({
          code: "live-adapter-type-mismatch",
          message: `${desiredAgent.slug}: adapterType mismatch (live=${liveAgent.adapterType}, desired=${desiredAgent.adapterType})`,
        });
      }

      const policy = desiredAgent.expectedRuntimePolicy;
      if (!policy) continue;

      const liveConfig = liveAgent.adapterConfig ?? {};
      if (typeof policy.status === "string" && liveAgent.status !== policy.status) {
        errors.push({
          code: "runtime-policy-status-mismatch",
          message: `${desiredAgent.slug}: status mismatch (live=${liveAgent.status}, desired=${policy.status})`,
        });
      }
      if (typeof policy.adapterType === "string" && liveAgent.adapterType !== policy.adapterType) {
        errors.push({
          code: "runtime-policy-adapter-type-mismatch",
          message: `${desiredAgent.slug}: runtime adapterType mismatch`,
        });
      }
      if (typeof policy.model === "string" && canonicalLiveModel(liveAgent) !== policy.model) {
        errors.push({
          code: "runtime-policy-model-mismatch",
          message: `${desiredAgent.slug}: runtime model mismatch`,
        });
      }
      if (typeof policy.cwdSuffix === "string") {
        const liveCwd = typeof liveConfig.cwd === "string" ? liveConfig.cwd : "";
        if (!liveCwd.endsWith(policy.cwdSuffix)) {
          errors.push({
            code: "runtime-policy-cwd-mismatch",
            message: `${desiredAgent.slug}: runtime cwd does not match expected policy suffix`,
          });
        }
      }
      if (typeof policy.maxConcurrentRuns === "number") {
        if (liveAgent.maxConcurrentRuns !== policy.maxConcurrentRuns) {
          errors.push({
            code: "runtime-policy-max-concurrent-mismatch",
            message: `${desiredAgent.slug}: maxConcurrentRuns mismatch`,
          });
        }
      }
      const heartbeatPolicy = policy.heartbeat ?? null;
      if (heartbeatPolicy) {
        const liveHeartbeat = liveAgent.heartbeat ?? {};
        if (liveHeartbeat.enabled !== heartbeatPolicy.enabled) {
          errors.push({
            code: "runtime-policy-heartbeat-enabled-mismatch",
            message: `${desiredAgent.slug}: heartbeat.enabled mismatch`,
          });
        }
        if (liveHeartbeat.wakeOnDemand !== heartbeatPolicy.wakeOnDemand) {
          errors.push({
            code: "runtime-policy-heartbeat-wake-mismatch",
            message: `${desiredAgent.slug}: heartbeat.wakeOnDemand mismatch`,
          });
        }
        if (liveHeartbeat.maxDailyRuns !== heartbeatPolicy.maxDailyRuns) {
          errors.push({
            code: "runtime-policy-heartbeat-max-daily-runs-mismatch",
            message: `${desiredAgent.slug}: heartbeat.maxDailyRuns mismatch`,
          });
        }
      }

      const expectedConfig = policy.adapterConfig ?? {};
      for (const [key, expectedValue] of Object.entries(expectedConfig)) {
        const liveValue = liveConfig[key];
        if (key === "extraArgs") {
          if (!sameStringArrayInOrder(expectedValue, liveValue)) {
            errors.push({
              code: "runtime-policy-extra-args-mismatch",
              message: `${desiredAgent.slug}: adapterConfig.extraArgs mismatch`,
            });
          }
          continue;
        }
        if (key === "networkAllowlist") {
          if (!sameStringSet(expectedValue, liveValue)) {
            errors.push({
              code: "runtime-policy-network-allowlist-mismatch",
              message: `${desiredAgent.slug}: adapterConfig.networkAllowlist mismatch`,
            });
          }
          continue;
        }
        if (!isScalar(expectedValue)) continue;
        if (liveValue !== expectedValue) {
          errors.push({
            code: "runtime-policy-adapter-config-mismatch",
            message: `${desiredAgent.slug}: adapterConfig.${key} mismatch`,
          });
        }
      }
    }

    const liveCtx = {};
    for (const agent of liveAgents) {
      const key = builtInKey(agent) ?? agent.slug ?? null;
      if (!key) continue;
      liveCtx[key] = {
        instructions: resolveAgentInstructions(agent, liveSnapshot),
        model: canonicalLiveModel(agent),
      };
    }
    liveContradictionResults = checkAllContradictions(
      desired.contradictions.contradictions,
      liveCtx,
    );
    for (const result of liveContradictionResults) {
      if (!result.ok) {
        errors.push({
          code: `live-contradiction:${result.id}`,
          message: `${result.id}: ${result.hits.map((h) => h.message).join("; ")}`,
        });
      } else {
        ok.push({
          code: `live-contradiction:${result.id}`,
          message: result.description,
        });
      }
    }

    for (const biDesired of desired.builtIns?.builtIns ?? []) {
      // Canonical live truth: agent whose metadata key matches (id/key binding
      // already enforced by assertSnapshotCompleteness). Ignore builtIns row fields.
      const biAgent =
        liveAgents.find((a) => builtInKey(a) === biDesired.key) ?? null;
      if (!biAgent) {
        errors.push({
          code: "builtin-missing",
          message: `Built-in ${biDesired.key} missing from live snapshot`,
        });
        continue;
      }
      const instructions =
        typeof biAgent.instructions === "string" && biAgent.instructions.trim()
          ? biAgent.instructions
          : null;
      if (!instructions) {
        errors.push({
          code: "builtin-instructions-missing",
          message: `${biDesired.key} instructions missing from live snapshot`,
        });
      } else {
        ok.push({
          code: "builtin-instructions-present",
          message: `${biDesired.key} present with instructions`,
        });
      }
      if (Array.isArray(biDesired.skillKeys)) {
        const liveSkills = Array.isArray(biAgent.desiredSkills)
          ? biAgent.desiredSkills
          : null;
        if (!Array.isArray(liveSkills) || !sameStringArray(biDesired.skillKeys, liveSkills)) {
          const item = {
            code: "builtin-skills-drift",
            message: `${biDesired.key}: live desiredSkills != desired skillKeys`,
          };
          if (forApply) warnings.push(item);
          else errors.push(item);
        }
      }
      if (biDesired.expectedModel != null) {
        const got = biAgent.adapterConfig?.model ?? biAgent.model ?? null;
        if (got !== biDesired.expectedModel) {
          const item = {
            code: "builtin-model-drift",
            message: `${biDesired.key}: model=${got} desired=${biDesired.expectedModel}`,
          };
          if (forApply) warnings.push(item);
          else errors.push(item);
        }
      }
    }

    const summarizerLive = liveAgents.find(
      (a) => builtInKey(a) === "summarizer" || a.slug === "summarizer",
    );
    if (!summarizerLive) {
      errors.push({
        code: "summarizer-missing",
        message: "Summarizer built-in missing from live snapshot",
      });
    } else {
      ok.push({ code: "summarizer-present", message: "Summarizer present with instructions" });
    }

    const builtInCount = (liveSnapshot.builtIns ?? []).length;
    const portableLive = liveAgents.filter((a) => !builtInKey(a)).length;
    if (
      liveAgents.length === FLEET_INVARIANTS.expectedLiveAgentCount &&
      (builtInCount !== FLEET_INVARIANTS.managedBuiltInCount ||
        portableLive !== FLEET_INVARIANTS.portableAgentCount)
    ) {
      errors.push({
        code: "portable-builtin-split",
        message: `Expected ${FLEET_INVARIANTS.portableAgentCount} portable + ${FLEET_INVARIANTS.managedBuiltInCount} built-ins; live portable=${portableLive} builtIns=${builtInCount}`,
      });
    }

    const codex = liveAgents.find((a) => a.slug === "mi-sie-kodu-codex");
    if (codex && codex.status !== "paused") {
      const item = {
        code: "codex-live-not-paused",
        message: "Live Codex agent is not paused",
      };
      if (forApply) warnings.push(item);
      else errors.push(item);
    }

    for (const skillSnap of liveSnapshot.skillSnapshots ?? []) {
      const agent = liveAgents.find((a) => a.id === skillSnap.agentId);
      if (agent && builtInKey(agent)) continue; // built-ins may use dedicated skill policy
      for (const finding of validateSkillRuntime(skillSnap, desired.skills.skillRuntimePolicy)) {
        if (finding.severity === "error") errors.push(finding);
        else if (finding.severity === "ok") ok.push(finding);
        else warnings.push(finding);
      }
    }

    if (!Array.isArray(liveSnapshot.skillLibrary)) {
      errors.push({
        code: "skill-library-absent",
        message: "Live snapshot missing skillLibrary — refuse validate/apply",
      });
    } else {
      const libraryKeys = new Set(
        liveSnapshot.skillLibrary.map((s) => (typeof s === "string" ? s : s.key)).filter(Boolean),
      );
      if (libraryKeys.size === 0) {
        errors.push({
          code: "skill-library-empty",
          message: "Live snapshot skillLibrary is empty",
        });
      } else {
        for (const key of collectDesiredSkillKeys(desired)) {
          if (!libraryKeys.has(key)) {
            errors.push({
              code: "skill-missing-from-library",
              message: `Desired skill key not in live library: ${key}`,
            });
          }
        }
        if (!errors.some((e) => e.code === "skill-missing-from-library")) {
          ok.push({
            code: "skill-library-complete",
            message: "All desired skill keys present in live library",
          });
        }
      }
    }

    for (const routineDesired of desired.routines.routines) {
      const matched = matchRoutineStrict(routineDesired, liveSnapshot.routines ?? []);
      if (!matched.ok) {
        errors.push({ code: matched.code, message: matched.detail });
        continue;
      }
      // Executive truth for routines is status + trigger.enabled.
      // Stale nextRunAt on paused/disabled triggers is an observability limitation — not validated.
      if (matched.live.status !== routineDesired.status) {
        const item = {
          code: "routine-status",
          message: `${routineDesired.title}: status=${matched.live.status} desired=${routineDesired.status}`,
        };
        if (forApply) warnings.push(item);
        else errors.push(item);
      }
      if (matched.trigger.enabled !== routineDesired.scheduleTriggerEnabled) {
        const item = {
          code: "routine-trigger",
          message: `${routineDesired.title}: trigger ${routineDesired.triggerId} enabled=${matched.trigger.enabled} desired=${routineDesired.scheduleTriggerEnabled}`,
        };
        if (forApply) warnings.push(item);
        else errors.push(item);
      } else if (matched.live.status === routineDesired.status) {
        ok.push({
          code: "routine-id-title-trigger",
          message: `${routineDesired.title}: id+title+triggerId match`,
        });
      } else {
        ok.push({
          code: "routine-id-title-trigger",
          message: `${routineDesired.title}: id+title+triggerId match (status drift deferred to apply)`,
        });
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    okItems: ok,
    contradictionResults: packageContradictionResults,
    liveContradictionResults,
    portableAgentCount: pkg.agents.length,
  };
}
