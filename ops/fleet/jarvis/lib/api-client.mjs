import { redactSecrets } from "./load.mjs";

/**
 * Minimal Paperclip API client. Never logs Authorization headers or token values.
 */
export function createApiClient({
  baseUrl,
  apiKey,
  fetchImpl = globalThis.fetch,
  dryRun = true,
} = {}) {
  if (!baseUrl) throw new Error("PAPERCLIP_API_URL / --api-url required for live operations");

  async function request(method, pathName, body) {
    const url = `${String(baseUrl).replace(/\/$/, "")}${pathName}`;
    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (apiKey) headers.Authorization = "Bearer [redacted-in-logs]";

    const logSafe = {
      method,
      path: pathName,
      body: body ? redactSecrets(body) : undefined,
      dryRun,
    };

    if (dryRun) {
      return { ok: true, dryRun: true, status: 0, data: null, request: logSafe };
    }

    const realHeaders = { ...headers };
    if (apiKey) realHeaders.Authorization = `Bearer ${apiKey}`;

    const res = await fetchImpl(url, {
      method,
      headers: realHeaders,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text.slice(0, 200) };
    }
    return {
      ok: res.ok,
      dryRun: false,
      status: res.status,
      data: redactSecrets(data),
      request: logSafe,
    };
  }

  return {
    dryRun,
    get: (p) => request("GET", p),
    patch: (p, body) => request("PATCH", p, body),
    post: (p, body) => request("POST", p, body),
    put: (p, body) => request("PUT", p, body),
  };
}

/**
 * Build a live snapshot shape from API responses (or fixtures).
 * Skill entry values are preserved without secrets.
 */
export function normalizeLiveSnapshot(raw) {
  const agentsRaw = raw.agents ?? [];
  const builtIns = (raw.builtIns ?? []).map((b) => {
    const agentId = b.agentId ?? b.agent?.id ?? null;
    const linked =
      (agentId && agentsRaw.find((a) => a.id === agentId)) ||
      b.agent ||
      null;
    let desiredSkills;
    if (Array.isArray(b.desiredSkills)) {
      desiredSkills = [...b.desiredSkills];
    } else if (Array.isArray(linked?.desiredSkills)) {
      desiredSkills = [...linked.desiredSkills];
    } else if (Array.isArray(linked?.skills)) {
      desiredSkills = [...linked.skills];
    } else {
      desiredSkills = [];
    }
    return {
      key: b.key,
      displayName: b.displayName ?? b.key,
      agentId,
      model: b.model ?? linked?.adapterConfig?.model ?? linked?.model ?? null,
      adapterConfig: b.adapterConfig ? redactSecrets(b.adapterConfig) : null,
      instructions: b.instructions ?? null,
      status: b.status ?? null,
      desiredSkills,
    };
  });

  return {
    capturedAt: raw.capturedAt ?? new Date().toISOString(),
    companyId: raw.companyId ?? null,
    agents: (raw.agents ?? []).map((a) => ({
      maxConcurrentRuns:
        a.runtimeConfig?.heartbeat?.maxConcurrentRuns ?? a.maxConcurrentRuns ?? null,
      id: a.id,
      name: a.name,
      slug: a.slug ?? a.urlKey ?? null,
      status: a.status,
      adapterType: a.adapterType,
      adapterConfig: redactSecrets(a.adapterConfig ?? {}),
      model: a.adapterConfig?.model ?? a.model ?? null,
      instructions: a.instructions ?? null,
      instructionsHash: a.instructionsHash ?? null,
      desiredSkills: a.desiredSkills ?? a.skills ?? null,
      metadata: a.metadata
        ? { paperclipBuiltInAgent: a.metadata.paperclipBuiltInAgent ?? null }
        : null,
    })),
    builtIns,
    routines: (raw.routines ?? []).map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      // nextRunAt may be stale when status=paused / trigger disabled — not executive truth
      nextRunAt: r.nextRunAt ?? null,
      triggers: (r.triggers ?? []).map((t) => ({
        id: t.id,
        kind: t.kind,
        enabled: t.enabled,
        // never keep webhook secrets
      })),
    })),
    skillSnapshots: raw.skillSnapshots ?? [],
    skillLibrary: Array.isArray(raw.skillLibrary)
      ? raw.skillLibrary.map((s) => (typeof s === "string" ? { key: s } : { key: s.key }))
      : raw.skillLibrary === undefined
        ? undefined
        : [],
    completeness: raw.completeness ?? null,
    warnings: raw.warnings ?? [],
  };
}
