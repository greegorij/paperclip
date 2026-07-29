import { createHash } from "node:crypto";
import { skillShortName } from "./load.mjs";

function extractFileContent(data) {
  if (typeof data === "string") return data;
  return data?.content ?? data?.file?.content ?? null;
}

function sameStringArray(a, b) {
  const left = [...(a ?? [])].map(String).sort();
  const right = [...(b ?? [])].map(String).sort();
  return JSON.stringify(left) === JSON.stringify(right);
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

export async function verifyAgentInstructions(client, { agentId, expectedContent }) {
  const res = await client.get(
    `/api/agents/${agentId}/instructions-bundle/file?path=${encodeURIComponent("AGENTS.md")}`,
  );
  if (!res.ok) {
    return { ok: false, error: `instructions verify GET failed HTTP ${res.status}` };
  }
  const got = extractFileContent(res.data);
  if (got == null) {
    return { ok: false, error: "instructions verify GET returned empty content" };
  }
  if (got !== expectedContent) {
    const gotHash = createHash("sha256").update(got).digest("hex");
    const wantHash = createHash("sha256").update(expectedContent).digest("hex");
    return {
      ok: false,
      error: `instructions verify content mismatch (liveHash=${gotHash} expectedHash=${wantHash})`,
    };
  }
  return {
    ok: true,
    hash: createHash("sha256").update(got).digest("hex"),
  };
}

export async function verifyAgentSkills(client, { agentId, expectedKeys }) {
  const res = await client.get(`/api/agents/${agentId}/skills`);
  if (!res.ok) {
    return { ok: false, error: `skills verify GET failed HTTP ${res.status}` };
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
  return { ok: true, got };
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
