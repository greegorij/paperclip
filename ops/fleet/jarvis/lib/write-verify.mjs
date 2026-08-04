import { createHash } from "node:crypto";
import { skillShortName } from "./load.mjs";

function sameStringArray(a, b) {
  const left = [...(a ?? [])].map(String).sort();
  const right = [...(b ?? [])].map(String).sort();
  return JSON.stringify(left) === JSON.stringify(right);
}

function sha256(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function hashPrefix(value) {
  return sha256(value).slice(0, 12);
}

function expectedActiveSkillState(adapterType) {
  switch (adapterType) {
    case "opencode_local":
    case "cursor":
      return "installed";
    case "claude_local":
    case "codex_local":
      return "configured";
    default:
      return null;
  }
}

/**
 * After a successful write, GET and confirm the expected live state.
 * Missing or mismatched verification is a hard failure.
 */
export async function verifyAgentModel(client, { agentId, expectedModel }) {
  const res = await client.get(`/api/agents/${agentId}`);
  if (!res.ok) {
    return { ok: false, error: `model verify GET failed HTTP ${res.status}` };
  }
  const got = res.data?.adapterConfig?.model ?? res.data?.model ?? null;
  if (got !== expectedModel) {
    return {
      ok: false,
      error: `model verify mismatch: live=${got} expected=${expectedModel}`,
    };
  }
  return { ok: true, got };
}

export async function verifyAgentSkills(client, { agentId, expectedKeys, expectedAdapterType = null }) {
  const res = await client.get(`/api/agents/${agentId}/skills`);
  if (!res.ok) {
    return { ok: false, error: `skills verify GET failed HTTP ${res.status}` };
  }
  const liveAdapterType = res.data?.adapterType ?? null;
  if (
    expectedAdapterType != null &&
    liveAdapterType != null &&
    liveAdapterType !== expectedAdapterType
  ) {
    return {
      ok: false,
      error: `skills verify adapterType mismatch: live=${liveAdapterType} expected=${expectedAdapterType}`,
    };
  }
  const got = res.data?.desiredSkills ?? null;
  if (!Array.isArray(got)) {
    return { ok: false, error: "skills verify missing desiredSkills array" };
  }
  if (!sameStringArray(got, expectedKeys)) {
    return {
      ok: false,
      error: `skills verify mismatch: live=${JSON.stringify(got)} expected=${JSON.stringify(expectedKeys)}`,
      liveShort: got.map(skillShortName),
    };
  }
  const adapterType = liveAdapterType ?? expectedAdapterType;
  const activeState = expectedActiveSkillState(adapterType);
  if (!activeState) {
    return {
      ok: false,
      error: `skills verify unsupported adapterType for state checks: ${String(adapterType)}`,
    };
  }
  const entries = Array.isArray(res.data?.entries) ? res.data.entries : null;
  if (!entries) {
    return { ok: false, error: "skills verify missing entries array" };
  }
  const expectedSet = new Set((expectedKeys ?? []).map(String));
  const desiredTrueEntries = entries.filter((entry) => entry?.desired === true);
  const desiredTrueKeys = desiredTrueEntries.map((entry) => String(entry?.key));
  if (!sameStringArray(desiredTrueKeys, [...expectedSet])) {
    return {
      ok: false,
      error:
        `skills verify desired:true key set mismatch: live=${JSON.stringify(desiredTrueKeys)} ` +
        `expected=${JSON.stringify([...expectedSet])}`,
    };
  }
  for (const key of expectedSet) {
    const entry = desiredTrueEntries.find((item) => item?.key === key) ?? null;
    if (!entry) {
      return { ok: false, error: `skills verify missing desired entry for ${key}` };
    }
    if (entry.state !== activeState) {
      return {
        ok: false,
        error:
          `skills verify invalid state for ${key}: live=${String(entry.state)} ` +
          `expected=${activeState}`,
      };
    }
  }
  return { ok: true, got };
}

/**
 * After empty-bundle repair PUT, confirm live AGENTS.md is byte-equivalent to what was written.
 * Reports stay redacted: only length + digest (never instruction body).
 */
export async function verifyAgentInstructionsContent(client, { agentId, expectedContent }) {
  if (typeof expectedContent !== "string") {
    return {
      ok: false,
      error: `instructions verify missing expectedContent for agent ${agentId}`,
    };
  }
  const expectedSha256 = sha256(expectedContent);
  const res = await client.get(`/api/agents/${agentId}/instructions-bundle/file?path=AGENTS.md`);
  if (!res.ok) {
    return { ok: false, error: `instructions verify GET failed HTTP ${res.status}` };
  }
  const content = res.data?.content ?? res.data?.file?.content ?? null;
  if (typeof content !== "string") {
    return {
      ok: false,
      error: `instructions verify missing content after empty-bundle repair for agent ${agentId}`,
    };
  }
  const liveSha256 = sha256(content);
  // Exact string match and digest must both agree (fail closed on wrong-but-nonempty).
  if (content !== expectedContent || liveSha256 !== expectedSha256) {
    return {
      ok: false,
      error:
        `instructions verify content mismatch after empty-bundle repair for agent ${agentId}: ` +
        `expected=${hashPrefix(expectedContent)} got=${hashPrefix(content)}`,
    };
  }
  if (content.trim().length === 0) {
    return {
      ok: false,
      error: `instructions verify still empty after empty-bundle repair for agent ${agentId}`,
    };
  }
  return {
    ok: true,
    contentLength: content.length,
    contentSha256: liveSha256,
  };
}

export async function verifyRoutine(client, { routineId, title, triggerId, status, triggerEnabled }) {
  const res = await client.get(`/api/routines/${routineId}`);
  if (!res.ok) {
    return { ok: false, error: `routine verify GET failed HTTP ${res.status}` };
  }
  const live = res.data;
  if (!live || live.id !== routineId) {
    return { ok: false, error: `routine verify id mismatch` };
  }
  if (live.title !== title) {
    return {
      ok: false,
      error: `routine verify title mismatch: live="${live.title}" expected="${title}"`,
    };
  }
  if (status != null && live.status !== status) {
    return {
      ok: false,
      error: `routine verify status mismatch: live=${live.status} expected=${status}`,
    };
  }
  const trigger = (live.triggers ?? []).find((t) => t.id === triggerId) ?? null;
  if (!trigger) {
    return { ok: false, error: `routine verify missing triggerId ${triggerId}` };
  }
  if (triggerEnabled != null && trigger.enabled !== triggerEnabled) {
    return {
      ok: false,
      error: `routine verify trigger.enabled mismatch: live=${trigger.enabled} expected=${triggerEnabled}`,
    };
  }
  // nextRunAt is intentionally ignored — paused/disabled routines may retain a stale value.
  return {
    ok: true,
    id: live.id,
    title: live.title,
    triggerId: trigger.id,
    status: live.status,
    triggerEnabled: trigger.enabled,
    nextRunAt: live.nextRunAt ?? null,
  };
}
