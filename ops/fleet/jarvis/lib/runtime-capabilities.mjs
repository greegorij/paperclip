import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DESIRED_DIR } from "./paths.mjs";

export const RUNTIME_CAPABILITIES_FILENAME = "runtime-capabilities.json";
export const RUNTIME_CAPABILITIES_SCHEMA_VERSION = 1;

const ALLOWED_TOP_LEVEL_KEYS = Object.freeze(["schemaVersion", "agents"]);
const ALLOWED_ENTRY_KEYS = Object.freeze([
  "filesystemExtraPaths",
  "networkAllowlistAdditions",
]);
/** Fields this file must never set — profile/model ownership stays elsewhere. */
const FORBIDDEN_ENTRY_KEYS = Object.freeze([
  "model",
  "adapter",
  "adapterType",
  "adapterConfig",
  "networkAllowlist",
  "networkScope",
  "filesystemScope",
  "filesystemWorkspaceAccess",
  "engine",
  "extraArgs",
  "chrome",
  "env",
]);

const HOSTNAME_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

function asRecord(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}

function isNonEmptyAbsolutePath(value) {
  if (typeof value !== "string") return false;
  const normalized = value.trim();
  if (normalized === "") return false;
  return path.isAbsolute(normalized);
}

function normalizeHostname(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "") return null;
  if (trimmed.includes("/") || trimmed.includes(":") || trimmed.includes("*")) return null;
  if (!HOSTNAME_RE.test(trimmed)) return null;
  return trimmed;
}

/**
 * Parse a filesystemExtraPaths entry into a read-only absolute path string.
 * Rejects rw access — this document may only grant read-only host paths.
 */
function parseReadOnlyExtraPath(entry, label, errors) {
  if (typeof entry === "string") {
    if (!isNonEmptyAbsolutePath(entry)) {
      errors.push(`${label}: filesystemExtraPaths entries must be non-empty absolute paths`);
      return null;
    }
    return entry.trim();
  }
  const record = asRecord(entry);
  if (!record) {
    errors.push(`${label}: filesystemExtraPaths entries must be strings or { path, access }`);
    return null;
  }
  const unknown = Object.keys(record).filter((key) => key !== "path" && key !== "access");
  if (unknown.length > 0) {
    errors.push(`${label}: filesystemExtraPaths entry has unexpected fields ${unknown.join(", ")}`);
  }
  if (!isNonEmptyAbsolutePath(record.path)) {
    errors.push(`${label}: filesystemExtraPaths.path must be a non-empty absolute path`);
    return null;
  }
  if (record.access !== undefined && record.access !== "ro") {
    errors.push(`${label}: filesystemExtraPaths may only grant read-only access (access must be "ro")`);
    return null;
  }
  return String(record.path).trim();
}

export function runtimeCapabilitiesPath(desiredDir = DESIRED_DIR) {
  return path.join(desiredDir, RUNTIME_CAPABILITIES_FILENAME);
}

export function readRuntimeCapabilitiesFile(desiredDir = DESIRED_DIR, errors = []) {
  const filePath = runtimeCapabilitiesPath(desiredDir);
  if (!existsSync(filePath)) {
    errors.push(`${RUNTIME_CAPABILITIES_FILENAME} not found: ${filePath}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    errors.push(
      `${RUNTIME_CAPABILITIES_FILENAME}: failed to parse (${err instanceof Error ? err.message : String(err)})`,
    );
    return null;
  }
}

/**
 * Fail-closed validation of desired/runtime-capabilities.json.
 * Additive-only: no model/adapter/base-provider-domain overrides.
 */
export function validateRuntimeCapabilitiesDocument(doc, { knownSlugs = null } = {}) {
  const errors = [];
  if (doc == null || typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, errors: [`${RUNTIME_CAPABILITIES_FILENAME}: document must be an object`] };
  }
  const unknownTop = Object.keys(doc).filter((key) => !ALLOWED_TOP_LEVEL_KEYS.includes(key));
  if (unknownTop.length > 0) {
    errors.push(
      `${RUNTIME_CAPABILITIES_FILENAME}: unexpected top-level fields ${unknownTop.join(", ")}`,
    );
  }
  if (doc.schemaVersion !== RUNTIME_CAPABILITIES_SCHEMA_VERSION) {
    errors.push(
      `${RUNTIME_CAPABILITIES_FILENAME}: schemaVersion must equal ${RUNTIME_CAPABILITIES_SCHEMA_VERSION}`,
    );
  }
  const agents = asRecord(doc.agents);
  if (!agents) {
    errors.push(`${RUNTIME_CAPABILITIES_FILENAME}: agents must be an object keyed by slug`);
    return { ok: false, errors };
  }
  const knownSet = knownSlugs == null ? null : new Set(knownSlugs);
  for (const [slug, rawEntry] of Object.entries(agents)) {
    if (typeof slug !== "string" || slug.trim() === "") {
      errors.push(`${RUNTIME_CAPABILITIES_FILENAME}: agent slug must be a non-empty string`);
      continue;
    }
    if (knownSet && !knownSet.has(slug)) {
      errors.push(`${RUNTIME_CAPABILITIES_FILENAME}: unknown agent slug ${slug}`);
    }
    const entry = asRecord(rawEntry);
    const label = `${RUNTIME_CAPABILITIES_FILENAME} ${slug}`;
    if (!entry) {
      errors.push(`${label}: entry must be an object`);
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (FORBIDDEN_ENTRY_KEYS.includes(key)) {
        errors.push(
          `${label}: field "${key}" is forbidden (cannot override model, adapter, or provider base allowlist)`,
        );
      } else if (!ALLOWED_ENTRY_KEYS.includes(key)) {
        errors.push(`${label}: unexpected field ${key}`);
      }
    }
    if (entry.filesystemExtraPaths !== undefined) {
      if (!Array.isArray(entry.filesystemExtraPaths)) {
        errors.push(`${label}: filesystemExtraPaths must be an array`);
      } else {
        const seen = new Set();
        for (const item of entry.filesystemExtraPaths) {
          const normalized = parseReadOnlyExtraPath(item, label, errors);
          if (normalized == null) continue;
          if (seen.has(normalized)) {
            errors.push(`${label}: duplicate filesystemExtraPaths entry ${normalized}`);
          }
          seen.add(normalized);
        }
      }
    }
    if (entry.networkAllowlistAdditions !== undefined) {
      if (!Array.isArray(entry.networkAllowlistAdditions)) {
        errors.push(`${label}: networkAllowlistAdditions must be an array`);
      } else {
        const seen = new Set();
        for (const item of entry.networkAllowlistAdditions) {
          const host = normalizeHostname(item);
          if (!host) {
            errors.push(
              `${label}: networkAllowlistAdditions entries must be hostnames (no URL, port, or wildcard)`,
            );
            continue;
          }
          if (seen.has(host)) {
            errors.push(`${label}: duplicate networkAllowlistAdditions entry ${host}`);
          }
          seen.add(host);
        }
      }
    }
    const hasPaths = Array.isArray(entry.filesystemExtraPaths) && entry.filesystemExtraPaths.length > 0;
    const hasNets =
      Array.isArray(entry.networkAllowlistAdditions) && entry.networkAllowlistAdditions.length > 0;
    if (!hasPaths && !hasNets) {
      errors.push(
        `${label}: must declare filesystemExtraPaths and/or networkAllowlistAdditions`,
      );
    }
  }
  return { ok: errors.length === 0, errors };
}

export function loadValidatedRuntimeCapabilities(desiredDir = DESIRED_DIR, { knownSlugs = null } = {}) {
  const errors = [];
  const doc = readRuntimeCapabilitiesFile(desiredDir, errors);
  if (!doc) return { ok: false, errors, doc: null, bySlug: new Map() };
  const validated = validateRuntimeCapabilitiesDocument(doc, { knownSlugs });
  if (!validated.ok) return { ok: false, errors: validated.errors, doc, bySlug: new Map() };
  const bySlug = new Map();
  for (const [slug, rawEntry] of Object.entries(doc.agents ?? {})) {
    const entry = asRecord(rawEntry) ?? {};
    const filesystemExtraPaths = [];
    const pathErrors = [];
    for (const item of entry.filesystemExtraPaths ?? []) {
      const normalized = parseReadOnlyExtraPath(item, slug, pathErrors);
      if (normalized != null) filesystemExtraPaths.push(normalized);
    }
    const networkAllowlistAdditions = [];
    for (const item of entry.networkAllowlistAdditions ?? []) {
      const host = normalizeHostname(item);
      if (host) networkAllowlistAdditions.push(host);
    }
    bySlug.set(slug, {
      filesystemExtraPaths,
      networkAllowlistAdditions,
    });
  }
  return { ok: true, errors: [], doc, bySlug };
}

/** Merge provider-safe allowlist with additive hostnames; preserve order, drop duplicates. */
export function mergeNetworkAllowlist(baseAllowlist, additions) {
  const out = [];
  const seen = new Set();
  for (const item of [...(baseAllowlist ?? []), ...(additions ?? [])]) {
    if (typeof item !== "string") continue;
    const normalized = item.trim().toLowerCase();
    if (normalized === "" || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

/**
 * Apply validated per-agent runtime capabilities onto a profile-built adapterConfig.
 * Never mutates model/adapterType; only additive paths + allowlist merge.
 */
export function applyRuntimeCapabilitiesToAdapterConfig(adapterConfig, capabilities) {
  if (!capabilities) return adapterConfig;
  const out = { ...adapterConfig };
  const paths = capabilities.filesystemExtraPaths ?? [];
  if (paths.length > 0) {
    out.filesystemExtraPaths = [...paths];
  }
  const additions = capabilities.networkAllowlistAdditions ?? [];
  if (additions.length > 0 || Array.isArray(out.networkAllowlist)) {
    out.networkAllowlist = mergeNetworkAllowlist(out.networkAllowlist ?? [], additions);
  }
  return out;
}
