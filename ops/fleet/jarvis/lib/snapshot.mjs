import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createApiClient, normalizeLiveSnapshot } from "./api-client.mjs";
import { redactSecrets } from "./load.mjs";
import { FLEET_INVARIANTS } from "./fleet-invariants.mjs";
import { assertSnapshotCompleteness } from "./snapshot-completeness.mjs";

const BUILTIN_KEYS = new Set(FLEET_INVARIANTS.requiredBuiltInKeys);

function agentLabel(agent) {
  return agent?.slug ?? agent?.name ?? agent?.id ?? "<unknown>";
}

function builtInKey(agent) {
  return agent?.metadata?.paperclipBuiltInAgent?.key ?? null;
}

function finalizeSnapshot(snap, { outPath = null, internalCapture = false } = {}) {
  const gate = assertSnapshotCompleteness(snap);
  if (!gate.ok) {
    const detail = gate.errors.map((e) => e.message ?? e.code).join("; ");
    throw new Error(`snapshot completeness failed: ${detail}`);
  }
  if (internalCapture && outPath) {
    throw new Error("internalCapture forbids writing unredacted snapshot to outPath");
  }
  if (outPath) {
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(redactSecrets(snap), null, 2)}\n`);
  }
  return snap;
}

/**
 * Snapshot live company state for offline diff/validate/verify.
 * Reads only; never mutates. Redacts secrets by default.
 * Fail-closed: missing instructions/skills/library or wrong agent counts abort.
 * Fixture path runs the same completeness gate as live capture.
 */
export async function snapshotFleet({
  companyId,
  apiUrl = process.env.PAPERCLIP_API_URL,
  apiKey = process.env.PAPERCLIP_API_KEY,
  outPath = null,
  fetchImpl = globalThis.fetch,
  fixture = null,
  internalCapture = false,
  expectedLiveAgentCount = FLEET_INVARIANTS.expectedLiveAgentCount,
  expectedPortableCount = FLEET_INVARIANTS.portableAgentCount,
  expectedBuiltInCount = FLEET_INVARIANTS.managedBuiltInCount,
} = {}) {
  if (fixture) {
    const snap = normalizeLiveSnapshot(fixture, { redact: !internalCapture });
    return finalizeSnapshot(snap, { outPath, internalCapture });
  }

  const client = createApiClient({
    baseUrl: apiUrl,
    apiKey,
    fetchImpl,
    dryRun: false,
    redactResponseData: !internalCapture,
  });

  if (!companyId) throw new Error("--company-id required for live snapshot");

  const agentsRes = await client.get(`/api/companies/${companyId}/agents`);
  if (!agentsRes.ok) throw new Error(`agents list failed: HTTP ${agentsRes.status}`);
  const agentsList = agentsRes.data ?? [];
  if (agentsList.length !== expectedLiveAgentCount) {
    throw new Error(
      `agents list returned ${agentsList.length} agents, expected exactly ${expectedLiveAgentCount}`,
    );
  }

  const routinesRes = await client.get(`/api/companies/${companyId}/routines`);
  if (!routinesRes.ok) throw new Error(`routines list failed: HTTP ${routinesRes.status}`);

  const skillsLibRes = await client.get(`/api/companies/${companyId}/skills`);
  if (!skillsLibRes.ok) {
    throw new Error(`skills library failed: HTTP ${skillsLibRes.status}`);
  }
  const rawLibrary = skillsLibRes.data;
  const libraryRows = Array.isArray(rawLibrary)
    ? rawLibrary
    : Array.isArray(rawLibrary?.skills)
      ? rawLibrary.skills
      : Array.isArray(rawLibrary?.entries)
        ? rawLibrary.entries
        : null;
  if (!libraryRows) {
    throw new Error("skills library response missing list — refuse incomplete snapshot");
  }
  const skillLibrary = libraryRows
    .map((s) => {
      const key = typeof s === "string" ? s : s?.key;
      return key ? { key } : null;
    })
    .filter(Boolean);
  if (skillLibrary.length === 0) {
    throw new Error("skills library is empty — refuse incomplete snapshot");
  }

  // Built-in endpoint is optional (404 when experimental.enableBuiltInAgents=false).
  const builtInsRes = await client.get(`/api/companies/${companyId}/built-in-agents`);
  const builtInEndpointRows = builtInsRes.ok ? (builtInsRes.data ?? []) : [];
  const warnings = [];
  if (!builtInsRes.ok) {
    warnings.push({
      code: "built-in-agents-endpoint-unavailable",
      message: `GET /built-in-agents returned HTTP ${builtInsRes.status}; deriving built-ins from agent metadata`,
    });
  }

  const agents = [];
  const skillSnapshots = [];
  for (const listAgent of agentsList) {
    const label = agentLabel(listAgent);
    const detail = await client.get(`/api/agents/${listAgent.id}`);
    if (!detail.ok) {
      throw new Error(
        `agent detail GET failed for ${label} (id=${listAgent.id}): HTTP ${detail.status}`,
      );
    }
    if (!detail.data || typeof detail.data !== "object") {
      throw new Error(`agent detail payload missing for ${label} (id=${listAgent.id})`);
    }
    // Full detail record is the source of runtime policy fields.
    const agent = { ...listAgent, ...detail.data };

    const bundle = await client.get(
      `/api/agents/${agent.id}/instructions-bundle/file?path=${encodeURIComponent("AGENTS.md")}`,
    );
    if (!bundle.ok) {
      throw new Error(
        `instructions GET failed for ${label} (id=${agent.id}): HTTP ${bundle.status}`,
      );
    }
    const instructions =
      typeof bundle.data === "string"
        ? bundle.data
        : (bundle.data?.content ?? bundle.data?.file?.content ?? null);
    if (typeof instructions !== "string" || instructions.trim() === "") {
      throw new Error(`instructions missing/empty for ${label} (id=${agent.id})`);
    }

    const skills = await client.get(`/api/agents/${agent.id}/skills`);
    if (!skills.ok) {
      throw new Error(`skills GET failed for ${label} (id=${agent.id}): HTTP ${skills.status}`);
    }
    if (!Array.isArray(skills.data?.desiredSkills)) {
      throw new Error(`desiredSkills missing for ${label} (id=${agent.id})`);
    }
    const desiredSkills = skills.data.desiredSkills;
    skillSnapshots.push({
      agentId: agent.id,
      adapterType: agent.adapterType,
      desiredSkills,
      desiredCount: desiredSkills.length,
      entries: skills.data?.entries ?? [],
    });

    agents.push({
      ...agent,
      instructions,
      desiredSkills,
    });
  }

  const builtInsFromAgents = [];
  for (const agent of agents) {
    const key = builtInKey(agent);
    if (!key) continue;
    if (!BUILTIN_KEYS.has(key)) {
      warnings.push({
        code: "unexpected-built-in-key",
        message: `Agent ${agentLabel(agent)} has unexpected built-in key ${key}`,
      });
    }
    const endpointRow = builtInEndpointRows.find(
      (b) => (b.definition?.key ?? b.key) === key,
    );
    builtInsFromAgents.push({
      key,
      displayName:
        endpointRow?.definition?.displayName ??
        endpointRow?.displayName ??
        agent.name ??
        key,
      agentId: agent.id,
      model: agent.adapterConfig?.model ?? agent.model ?? null,
      adapterConfig: agent.adapterConfig ?? null,
      instructions: agent.instructions,
      status: agent.status,
      desiredSkills: agent.desiredSkills,
    });
  }

  if (builtInsFromAgents.length !== expectedBuiltInCount) {
    throw new Error(
      `expected ${expectedBuiltInCount} built-ins via metadata.paperclipBuiltInAgent.key, found ${builtInsFromAgents.length}`,
    );
  }
  for (const required of BUILTIN_KEYS) {
    if (!builtInsFromAgents.some((b) => b.key === required)) {
      throw new Error(`missing required built-in ${required} in agent list metadata`);
    }
  }

  const portableCount = agents.length - builtInsFromAgents.length;
  if (portableCount !== expectedPortableCount) {
    throw new Error(
      `expected ${expectedPortableCount} portable agents, found ${portableCount}`,
    );
  }

  const completeness = {
    complete: true,
    agentCount: agents.length,
    portableCount,
    builtInCount: builtInsFromAgents.length,
    skillLibraryCount: skillLibrary.length,
    instructionsFetched: agents.length,
    skillsFetched: skillSnapshots.length,
    skillLibraryPresent: true,
  };

  const snap = normalizeLiveSnapshot({
    companyId,
    agents,
    routines: routinesRes.data ?? [],
    builtIns: builtInsFromAgents,
    skillSnapshots,
    skillLibrary,
    completeness,
    warnings,
  }, { redact: !internalCapture });

  return finalizeSnapshot(snap, { outPath, internalCapture });
}
