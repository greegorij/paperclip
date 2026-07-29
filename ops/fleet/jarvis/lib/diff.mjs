import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { loadDesired, loadPackage } from "./load.mjs";
import {
  SUMMARIZER_CHEAP_CLAIM_RE,
  planSummarizerInstructionPatch,
} from "./summarizer-patch.mjs";

function sameStringArray(a, b) {
  const left = [...(a ?? [])].map(String).sort();
  const right = [...(b ?? [])].map(String).sort();
  return JSON.stringify(left) === JSON.stringify(right);
}

function builtInKey(agent) {
  return agent?.metadata?.paperclipBuiltInAgent?.key ?? null;
}

/**
 * Resolve a live routine strictly by desired id, then confirm title + trigger id.
 * No name-only fallback for mutations.
 */
export function matchRoutineStrict(routineDesired, liveRoutines = []) {
  const live = liveRoutines.find((r) => r.id === routineDesired.id) ?? null;
  if (!live) {
    return {
      ok: false,
      blocking: true,
      code: "routine-id-missing",
      detail: `Routine id ${routineDesired.id} not found in live snapshot`,
    };
  }
  if (live.title !== routineDesired.title) {
    return {
      ok: false,
      blocking: true,
      code: "routine-title-mismatch",
      detail: `Routine ${routineDesired.id}: live title "${live.title}" != desired "${routineDesired.title}"`,
      live,
    };
  }
  const trigger =
    (live.triggers ?? []).find((t) => t.id === routineDesired.triggerId) ?? null;
  if (!trigger) {
    return {
      ok: false,
      blocking: true,
      code: "routine-trigger-id-missing",
      detail: `Routine ${routineDesired.id}: trigger id ${routineDesired.triggerId} not found`,
      live,
    };
  }
  // Detect name collision without using it for apply
  const sameTitleOtherId = liveRoutines.find(
    (r) => r.title === routineDesired.title && r.id !== routineDesired.id,
  );
  if (sameTitleOtherId) {
    return {
      ok: false,
      blocking: true,
      code: "routine-title-duplicate",
      detail: `Title "${routineDesired.title}" also exists as ${sameTitleOtherId.id}; refuse ambiguous apply`,
      live,
      trigger,
    };
  }
  return { ok: true, live, trigger };
}

/**
 * Diff desired package/overlays against a live snapshot.
 * Never mutates. Does not log secrets.
 */
export function diffFleet({ packageDir, desiredDir, liveSnapshot }) {
  const desired = loadDesired(desiredDir);
  const pkg = loadPackage(packageDir);
  const changes = [];

  const liveBySlug = new Map();
  for (const agent of liveSnapshot.agents ?? []) {
    const slug = agent.slug ?? agent.urlKey ?? null;
    if (slug) liveBySlug.set(slug, agent);
  }

  for (const agent of desired.agents?.agents ?? []) {
    const live = liveBySlug.get(agent.slug) ?? null;
    if (!live) {
      changes.push({
        kind: "agent-missing",
        target: agent.slug,
        detail: "Portable agent not found in live snapshot (match by slug only)",
        blocking: true,
      });
      continue;
    }

    const liveModel = live.adapterConfig?.model ?? live.model ?? null;
    if ((agent.model ?? null) !== (liveModel ?? null)) {
      changes.push({
        kind: "agent-model",
        target: agent.slug,
        agentId: live.id,
        from: liveModel,
        to: agent.model,
        api: {
          method: "PATCH",
          path: `/api/agents/${live.id}`,
          bodyKeys: ["adapterConfig.model", "replaceAdapterConfig"],
        },
      });
    }

    // Status changes only when explicitly managed (default false). Codex is the only managed pause.
    if (agent.manageStatus === true && agent.status === "paused" && live.status !== "paused") {
      changes.push({
        kind: "agent-pause",
        target: agent.slug,
        agentId: live.id,
        from: live.status,
        to: "paused",
        api: { method: "POST", path: `/api/agents/${live.id}/pause` },
      });
    }

    const pkgAgent = pkg.agentBySlug[agent.slug];
    if (pkgAgent && live.instructionsHash && pkgAgent.instructions) {
      const hash = createHash("sha256").update(pkgAgent.instructions).digest("hex");
      if (hash !== live.instructionsHash) {
        changes.push({
          kind: "agent-instructions",
          target: agent.slug,
          agentId: live.id,
          from: live.instructionsHash,
          to: hash,
          api: {
            method: "PUT",
            path: `/api/agents/${live.id}/instructions-bundle/file`,
            bodyKeys: ["path", "content"],
          },
        });
      }
    } else if (pkgAgent && live.instructions != null) {
      if (live.instructions !== pkgAgent.instructions) {
        changes.push({
          kind: "agent-instructions",
          target: agent.slug,
          agentId: live.id,
          api: {
            method: "PUT",
            path: `/api/agents/${live.id}/instructions-bundle/file`,
            bodyKeys: ["path", "content"],
          },
        });
      }
    }

    // Full skillKeys vs full live desiredSkills for ALL portable agents (not short-name / overrides-only).
    if (Array.isArray(agent.skillKeys) && Array.isArray(live.desiredSkills)) {
      if (!sameStringArray(agent.skillKeys, live.desiredSkills)) {
        changes.push({
          kind: "agent-skills",
          target: agent.slug,
          agentId: live.id,
          from: [...live.desiredSkills],
          to: [...agent.skillKeys],
          skillKeys: [...agent.skillKeys],
          api: {
            method: "POST",
            path: `/api/agents/${live.id}/skills/sync`,
            bodyKeys: ["desiredSkills"],
          },
        });
      }
    } else if (Array.isArray(agent.skillKeys) && !Array.isArray(live.desiredSkills)) {
      changes.push({
        kind: "agent-skills",
        target: agent.slug,
        agentId: live.id,
        from: null,
        to: [...agent.skillKeys],
        skillKeys: [...agent.skillKeys],
        api: {
          method: "POST",
          path: `/api/agents/${live.id}/skills/sync`,
          bodyKeys: ["desiredSkills"],
        },
      });
    }
  }

  // Built-ins: model + skills + controlled Summarizer instructions patch.
  // Canonical live truth is the agent bound by metadata.paperclipBuiltInAgent.key
  // (after completeness has verified builtIns[key].agentId === that agent.id).
  // Do not trust duplicated builtIns row fields for mutate targeting.
  for (const biDesired of desired.builtIns?.builtIns ?? []) {
    const liveAgent =
      (liveSnapshot.agents ?? []).find((a) => builtInKey(a) === biDesired.key) ?? null;
    if (!liveAgent?.id) continue;

    const agentId = liveAgent.id;

    const wantModel =
      biDesired.expectedModel ??
      desired.models?.builtIns?.[biDesired.key]?.model ??
      null;
    if (wantModel != null) {
      const got = liveAgent.adapterConfig?.model ?? liveAgent.model ?? null;
      // Diff when live is wrong OR null (missing)
      if (got !== wantModel) {
        changes.push({
          kind: "builtin-model",
          target: biDesired.key,
          agentId,
          from: got,
          to: wantModel,
          api: {
            method: "PATCH",
            path: `/api/agents/${agentId}`,
            bodyKeys: ["adapterConfig.model", "replaceAdapterConfig"],
            note: "Built-in model correction; package does not own built-in files",
          },
        });
      }
    }

    const wantSkills = biDesired.skillKeys ?? null;
    if (Array.isArray(wantSkills)) {
      const liveSkills = Array.isArray(liveAgent.desiredSkills)
        ? liveAgent.desiredSkills
        : null;
      if (!Array.isArray(liveSkills) || !sameStringArray(wantSkills, liveSkills)) {
        changes.push({
          kind: "builtin-skills",
          target: biDesired.key,
          agentId,
          from: liveSkills,
          to: [...wantSkills],
          skillKeys: [...wantSkills],
          api: {
            method: "POST",
            path: `/api/agents/${agentId}/skills/sync`,
            bodyKeys: ["desiredSkills"],
          },
        });
      }
    }

    if (biDesired.key === "summarizer") {
      const instructions = liveAgent.instructions ?? null;
      if (instructions != null) {
        const plan = planSummarizerInstructionPatch(instructions);
        if (plan.ok) {
          changes.push({
            kind: "summarizer-instructions-patch",
            target: "summarizer",
            agentId,
            detail: "Exact cheap-lane fragment present; controlled AGENTS.md replace planned",
            api: {
              method: "PUT",
              path: `/api/agents/${agentId}/instructions-bundle/file`,
              bodyKeys: ["path", "content"],
            },
          });
        } else if (plan.code === "unexpected-drift" || plan.code === "replace-failed") {
          changes.push({
            kind: "summarizer-instructions-drift",
            target: "summarizer",
            agentId,
            detail: plan.detail,
            blocking: true,
          });
        } else if (SUMMARIZER_CHEAP_CLAIM_RE.test(instructions) && plan.code !== "already-patched") {
          changes.push({
            kind: "summarizer-instructions-drift",
            target: "summarizer",
            agentId,
            detail: plan.detail,
            blocking: true,
          });
        }
      }
    }
  }

  for (const routineDesired of desired.routines.routines) {
    const matched = matchRoutineStrict(routineDesired, liveSnapshot.routines ?? []);
    if (!matched.ok) {
      changes.push({
        kind: matched.code,
        target: routineDesired.title,
        routineId: routineDesired.id,
        triggerId: routineDesired.triggerId,
        detail: matched.detail,
        blocking: true,
      });
      continue;
    }
    const { live, trigger } = matched;
    if (live.status !== routineDesired.status) {
      changes.push({
        kind: "routine-status",
        target: routineDesired.title,
        routineId: live.id,
        triggerId: trigger.id,
        from: live.status,
        to: routineDesired.status,
        api: { method: "PATCH", path: `/api/routines/${live.id}`, bodyKeys: ["status"] },
      });
    }
    if (trigger.enabled !== routineDesired.scheduleTriggerEnabled) {
      changes.push({
        kind: "routine-trigger",
        target: routineDesired.title,
        routineId: live.id,
        triggerId: trigger.id,
        from: trigger.enabled,
        to: routineDesired.scheduleTriggerEnabled,
        api: {
          method: "PATCH",
          path: `/api/routine-triggers/${trigger.id}`,
          bodyKeys: ["enabled"],
        },
      });
    }
  }

  return {
    changeCount: changes.length,
    blocking: changes.filter((c) => c.blocking).length,
    changes,
  };
}

export function loadSnapshotFile(filePath) {
  if (!existsSync(filePath)) throw new Error(`Snapshot not found: ${filePath}`);
  return JSON.parse(readFileSync(filePath, "utf8"));
}
