import { loadDesired, skillShortName, redactSecrets } from "./load.mjs";
import { assertBackupGate } from "./backup-gate.mjs";
import { diffFleet } from "./diff.mjs";
import { validateFleet } from "./validate.mjs";
import { createApiClient } from "./api-client.mjs";
import { preflightSkillKeyResolutions } from "./skill-keys.mjs";
import {
  verifyAgentModel,
  verifyAgentSkills,
  verifyRoutine,
} from "./write-verify.mjs";

function finish(report) {
  report.finishedAt = new Date().toISOString();
  report.ok = report.failed.length === 0;
  // partial=true if any write succeeded (including write-ok/verify-fail before completed push)
  report.partial =
    report.failed.length > 0 &&
    (report.completed.length > 0 || (report.writesSucceeded ?? 0) > 0);
  report.summary = {
    planned: report.planned.length,
    completed: report.completed.length,
    failed: report.failed.length,
    skipped: report.skipped.length,
    writesSucceeded: report.writesSucceeded ?? 0,
  };
  return redactSecrets(report);
}

export function validateApplyChanges(changes) {
  if (!Array.isArray(changes)) {
    return {
      ok: false,
      error: "preflight requires an array of diff changes",
      items: [],
    };
  }
  const forbiddenInstructionChanges = changes.filter(
    (c) => c?.kind === "agent-instructions" || c?.kind === "summarizer-instructions-patch",
  );
  if (forbiddenInstructionChanges.length > 0) {
    return {
      ok: false,
      error:
        "instruction changes are forbidden: live instructions are outside automated reconciliation",
      items: forbiddenInstructionChanges,
    };
  }
  return { ok: true, items: [] };
}

/**
 * Apply desired state via Paperclip APIs.
 * Default is dry-run (offline — no API client). Mutations require --apply AND backup gate.
 * Fail-fast after the first mutation/verify error; partial=true if anything already wrote.
 */
export async function applyFleet({
  packageDir,
  desiredDir,
  liveSnapshot,
  apply = false,
  backupGate = {},
  api = null,
} = {}) {
  const gate = assertBackupGate(backupGate);
  const report = {
    mode: apply ? "apply" : "dry-run",
    startedAt: new Date().toISOString(),
    backupGate: gate,
    completed: [],
    failed: [],
    skipped: [],
    planned: [],
    writesSucceeded: 0,
  };

  const markWriteOk = () => {
    report.writesSucceeded += 1;
  };

  if (apply && !gate.ok) {
    report.failed.push({ step: "backup-gate", error: gate.detail });
    report.partial = false;
    return finish(report);
  }

  const desired = loadDesired(desiredDir);

  const validation = validateFleet({
    packageDir,
    desiredDir,
    liveSnapshot,
    forApply: true,
  });
  if (!validation.ok) {
    report.failed.push({
      step: "validate",
      error: `${validation.errors.length} validation error(s); refuse apply`,
      items: validation.errors,
    });
    report.partial = false;
    return finish(report);
  }

  const plan = diffFleet({ packageDir, desiredDir, liveSnapshot });
  report.planned = plan.changes;

  const changePreflight = validateApplyChanges(plan.changes);
  if (!changePreflight.ok) {
    report.failed.push({
      step: "preflight",
      error: changePreflight.error,
      items: changePreflight.items,
    });
    report.partial = false;
    return finish(report);
  }

  if (plan.blocking > 0) {
    report.failed.push({
      step: "preflight",
      error: `${plan.blocking} blocking diff item(s); refuse apply`,
      items: plan.changes.filter((c) => c.blocking),
    });
    report.partial = false;
    return finish(report);
  }

  const skillPreflight = preflightSkillKeyResolutions(
    plan.changes,
    liveSnapshot.skillLibrary,
  );
  if (!skillPreflight.ok) {
    report.failed.push({ step: "skill-keys", error: skillPreflight.error });
    report.partial = false;
    return finish(report);
  }

  // Dry-run stays fully offline — no API client, no write-verify GETs.
  if (!apply) {
    report.ok = true;
    report.partial = false;
    return finish(report);
  }

  const client =
    api ??
    createApiClient({
      baseUrl: process.env.PAPERCLIP_API_URL,
      apiKey: process.env.PAPERCLIP_API_KEY,
      dryRun: false,
    });

  const liveBySlug = new Map();
  for (const agent of liveSnapshot.agents ?? []) {
    if (agent.slug) liveBySlug.set(agent.slug, agent);
  }

  const desiredRoutineById = new Map(
    (desired.routines.routines ?? []).map((r) => [r.id, r]),
  );

  for (const change of plan.changes) {
    const step = {
      kind: change.kind,
      target: change.target,
      api: change.api ?? null,
      routineId: change.routineId,
      triggerId: change.triggerId,
      agentId: change.agentId,
    };
    try {
      if (!change.api) {
        report.skipped.push({ ...step, reason: change.detail ?? "no api action" });
        continue;
      }

      if (change.kind === "agent-model") {
        const live = liveBySlug.get(change.target);
        const body = {
          adapterConfig: { model: change.to },
          replaceAdapterConfig: false,
        };
        const res = await client.patch(`/api/agents/${live.id}`, body);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        markWriteOk();
        const verified = await verifyAgentModel(client, {
          agentId: live.id,
          expectedModel: change.to,
        });
        if (!verified.ok) throw new Error(verified.error);
        report.completed.push({
          ...step,
          result: "applied",
          requestBody: body,
          verified,
        });
        continue;
      }

      if (change.kind === "agent-pause") {
        const live = liveBySlug.get(change.target);
        const desiredAgent = desired.agents.agents.find((a) => a.slug === change.target);
        if (desiredAgent?.manageStatus !== true) {
          report.skipped.push({
            ...step,
            reason: "manageStatus is not true — refusing status mutation",
          });
          continue;
        }
        const res = await client.post(`/api/agents/${live.id}/pause`, {});
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        markWriteOk();
        const verify = await client.get(`/api/agents/${live.id}`);
        if (!verify.ok || verify.data?.status !== "paused") {
          throw new Error(
            `pause verify failed: status=${verify.data?.status ?? "?"} HTTP ${verify.status}`,
          );
        }
        report.completed.push({ ...step, result: "applied", verified: { status: "paused" } });
        continue;
      }

      if (change.kind === "agent-skills" || change.kind === "builtin-skills") {
        const agentId =
          change.agentId ??
          liveBySlug.get(change.target)?.id ??
          null;
        if (!agentId) throw new Error(`missing agentId for skills sync ${change.target}`);
        const resolutionKey =
          change.kind === "builtin-skills" ? `builtin:${change.target}` : change.target;
        const keys = skillPreflight.resolutions.get(resolutionKey);
        if (!keys) {
          throw new Error(`internal: no preflight skill resolution for ${resolutionKey}`);
        }
        const res = await client.post(`/api/agents/${agentId}/skills/sync`, {
          desiredSkills: keys,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        markWriteOk();
        const verified = await verifyAgentSkills(client, {
          agentId,
          expectedKeys: keys,
        });
        if (!verified.ok) throw new Error(verified.error);
        report.completed.push({
          ...step,
          result: "applied",
          desiredSkills: keys,
          desiredSkillsShort: keys.map(skillShortName),
          verified,
        });
        continue;
      }

      if (change.kind === "routine-status") {
        if (!change.routineId) throw new Error("routine-status missing routineId");
        const desiredRoutine = desiredRoutineById.get(change.routineId);
        const res = await client.patch(`/api/routines/${change.routineId}`, {
          status: change.to,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        markWriteOk();
        const verified = await verifyRoutine(client, {
          routineId: change.routineId,
          title: desiredRoutine?.title ?? change.target,
          triggerId: change.triggerId ?? desiredRoutine?.triggerId,
          status: change.to,
          triggerEnabled: null,
        });
        if (!verified.ok) throw new Error(verified.error);
        report.completed.push({ ...step, result: "applied", verified });
        continue;
      }

      if (change.kind === "routine-trigger") {
        if (!change.triggerId) throw new Error("routine-trigger missing triggerId");
        const desiredRoutine = desiredRoutineById.get(change.routineId);
        const res = await client.patch(`/api/routine-triggers/${change.triggerId}`, {
          enabled: change.to,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        markWriteOk();
        const verified = await verifyRoutine(client, {
          routineId: change.routineId,
          title: desiredRoutine?.title ?? change.target,
          triggerId: change.triggerId,
          status: desiredRoutine?.status ?? null,
          triggerEnabled: change.to,
        });
        if (!verified.ok) throw new Error(verified.error);
        report.completed.push({ ...step, result: "applied", verified });
        continue;
      }

      if (change.kind === "builtin-model") {
        const body = {
          adapterConfig: { model: change.to },
          replaceAdapterConfig: false,
        };
        const res = await client.patch(`/api/agents/${change.agentId}`, body);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        markWriteOk();
        const verified = await verifyAgentModel(client, {
          agentId: change.agentId,
          expectedModel: change.to,
        });
        if (!verified.ok) throw new Error(verified.error);
        report.completed.push({
          ...step,
          result: "applied",
          requestBody: body,
          verified,
        });
        continue;
      }

      report.skipped.push({ ...step, reason: `unhandled kind ${change.kind}` });
    } catch (err) {
      report.failed.push({
        ...step,
        error: err instanceof Error ? err.message : String(err),
      });
      break;
    }
  }

  return finish(report);
}
