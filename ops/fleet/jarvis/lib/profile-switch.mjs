import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { assertBackupGate } from "./backup-gate.mjs";
import { createApiClient } from "./api-client.mjs";
import {
  generateCodexJarvisArtifacts,
  JARVIS_CODEX_COMPACT_ENTRY_FILE,
  JARVIS_CODEX_FULL_ENTRY_FILE,
} from "./codex-jarvis-instructions.mjs";
import { loadDesired, loadPackage, redactSecrets, SECRET_REDACTION_MARKER } from "./load.mjs";
import {
  applyRuntimeCapabilitiesToAdapterConfig,
  loadValidatedRuntimeCapabilities,
} from "./runtime-capabilities.mjs";
import { DESIRED_DIR, PACKAGE_DIR } from "./paths.mjs";
import { snapshotFleet } from "./snapshot.mjs";

const MODEL_POLICY_FILENAME = "model-policy.shadow.v1.json";

const OPENAI_SAFE_ALLOWLIST = Object.freeze([
  "chatgpt.com",
  "api.openai.com",
  "auth.openai.com",
]);
const ANTHROPIC_SAFE_ALLOWLIST = Object.freeze([
  "api.anthropic.com",
  "statsig.anthropic.com",
  "sentry.io",
]);
const SAFE_CODEX_EXTRA_ARGS = Object.freeze([
  "--sandbox",
  "danger-full-access",
  "--skip-git-repo-check",
]);
const PRESERVED_ADAPTER_CONFIG_KEYS = Object.freeze([
  "instructionsBundleMode",
  "instructionsRootPath",
  "instructionsEntryFile",
  "instructionsFilePath",
  "agentsMdPath",
  "paperclipSkillSync",
]);
/** Mirrors packages/shared envBindingSecretRefSchema / envBindingUserSecretRefSchema (local, no package dep). */
const SECRET_REF_ALLOWED_KEYS = Object.freeze([
  "type",
  "secretId",
  "version",
  "projectionClass",
  "projectionAllowlistKey",
]);
const USER_SECRET_REF_ALLOWED_KEYS = Object.freeze([
  "type",
  "key",
  "version",
  "required",
  "allowMissingOverride",
]);
const SECRET_PROJECTION_CLASSES = Object.freeze(["unclassified", "class_3_static_lease"]);
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USER_SECRET_KEY_RE = /^[a-zA-Z0-9_.-]{1,120}$/;
const REQUIRED_PROFILES = Object.freeze(["openai-first", "anthropic-first"]);
const PATCH_TIMEOUT_SEC = 1200;
const PATCH_INACTIVITY_TIMEOUT_MS = 600000;
const PATCH_GRACE_SEC = 15;
const BACKUP_SCHEMA_VERSION = 2;
const EXPECTED_SWITCHABLE_COUNT = 22;
const ANTHROPIC_WORKER_CONFIG_ENV = "JARVIS_CLAUDE_WORKER_CONFIG_DIR";
const ANTHROPIC_BOSS_CONFIG_ENV = "JARVIS_CLAUDE_BOSS_CONFIG_DIR";
const BOSS_INSTRUCTIONS_SOURCE_ENV = "JARVIS_CLAUDE_BOSS_INSTRUCTIONS_FILE";
const JARVIS_SLUG = "jarvis";
/** Audit/reference full harness — parity-checked, not the openai-first runtime entry. */
const JARVIS_CODEX_FULL_AGENTS_FILE = JARVIS_CODEX_FULL_ENTRY_FILE;
/** Runtime entrypoint materialized + pointed by openai-first instructionsEntryFile. */
const JARVIS_CODEX_AGENTS_FILE = JARVIS_CODEX_COMPACT_ENTRY_FILE;
const JARVIS_ANTHROPIC_AGENTS_FILE = "AGENTS.md";
const JARVIS_CODEX_FULL_ARTIFACT_RELATIVE = path.join(
  "package",
  "agents",
  "jarvis",
  JARVIS_CODEX_FULL_AGENTS_FILE,
);
const JARVIS_CODEX_ARTIFACT_RELATIVE = path.join(
  "package",
  "agents",
  "jarvis",
  JARVIS_CODEX_AGENTS_FILE,
);
const OPENAI_PROFILE_ENTRY_KEYS = Object.freeze([
  "slug",
  "adapterType",
  "model",
  "modelReasoningEffort",
  "filesystemWorkspaceAccess",
  "maxDailyRuns",
]);
const ANTHROPIC_PROFILE_ENTRY_KEYS = Object.freeze([
  "slug",
  "adapterType",
  "model",
  "maxTurnsPerRun",
  "maxDailyRuns",
  "claudeConfigProfile",
]);

const ANTHROPIC_EXPECTED_MAX_TURNS = Object.freeze({
  jarvis: 20,
  "szef-komercyjny": 40,
  "senior-programista": 40,
  "analityk-biznesowy": 40,
  "designer-ui": 40,
  "konfigurator-systemu": 40,
  "modelarz-procesow": 40,
  "specjalista-deck-w": 40,
  "specjalista-komunikacji-klienckiej": 40,
  "specjalista-ofert": 40,
  badacz: 30,
  krytyk: 30,
  "czytacz-transkryptow": 30,
  "in-ynier-wdro-e": 30,
  "kurator-crm": 30,
  "kurator-vaultu": 30,
  "zwiadowca-vaultu": 30,
  "obserwator-upstream": 20,
  "reflection-coach": 20,
  kronikarz: 20,
  "mi-sie-vault": 20,
  summarizer: 10,
});
const EXPECTED_SWITCHABLE_SLUGS = Object.freeze(
  Object.keys(ANTHROPIC_EXPECTED_MAX_TURNS).sort(),
);

function asRecord(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}

function sha256(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function hashPrefix(value) {
  return sha256(value).slice(0, 12);
}

function readProfilesFile(desiredDir) {
  const filePath = path.join(desiredDir, "profiles.json");
  if (!existsSync(filePath)) {
    throw new Error(`profiles.json not found: ${filePath}`);
  }
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function readModelPolicyFile(desiredDir, errors) {
  const filePath = path.join(desiredDir, MODEL_POLICY_FILENAME);
  if (!existsSync(filePath)) {
    errors.push(`${MODEL_POLICY_FILENAME} not found: ${filePath}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    errors.push(
      `${MODEL_POLICY_FILENAME}: failed to parse (${err instanceof Error ? err.message : String(err)})`,
    );
    return null;
  }
}

function firstAnthropicFallbackModel(role, catalog) {
  if (!Array.isArray(role?.fallback)) return null;
  for (const entry of role.fallback) {
    const modelId = entry?.model;
    if (typeof modelId !== "string" || modelId.trim() === "") continue;
    if (asRecord(catalog?.[modelId])?.provider === "anthropic") return modelId;
  }
  return null;
}

/**
 * Derive openai-first / anthropic-first field expectations from shadow model policy.
 * Fail-closed: missing roles, primary fields, catalog provider/adapter contracts,
 * anthropic fallback, or limits produce errors.
 */
function deriveProfileExpectationsFromPolicy({ slugs, policy, errors }) {
  const expectations = new Map();
  if (!policy) return expectations;
  const catalog = asRecord(policy.modelCatalog) ?? {};
  const roles = asRecord(policy.roles);
  if (!roles) {
    errors.push("model-policy: roles must be an object");
    return expectations;
  }
  for (const slug of slugs) {
    const role = asRecord(roles[slug]);
    if (!role) {
      errors.push(`model-policy: missing role ${slug}`);
      continue;
    }
    const primary = asRecord(role.primary);
    if (!primary || typeof primary.model !== "string" || primary.model.trim() === "") {
      errors.push(`model-policy ${slug}: primary.model is required`);
      continue;
    }
    if (primary.workspaceAccess !== "ro" && primary.workspaceAccess !== "rw") {
      errors.push(`model-policy ${slug}: primary.workspaceAccess must be ro or rw`);
      continue;
    }
    if (!["low", "medium", "high"].includes(role.effort)) {
      errors.push(`model-policy ${slug}: effort must be low, medium, or high`);
      continue;
    }
    const maxDailyRuns = asRecord(role.limits)?.maxDailyRuns;
    if (!Number.isInteger(maxDailyRuns) || maxDailyRuns < 1) {
      errors.push(`model-policy ${slug}: limits.maxDailyRuns must be integer >= 1`);
      continue;
    }
    const primaryEntry = asRecord(catalog[primary.model]);
    if (!primaryEntry) {
      errors.push(`model-policy ${slug}: primary.model must exist in modelCatalog`);
      continue;
    }
    if (primaryEntry.provider !== "openai") {
      errors.push(`model-policy ${slug}: primary modelCatalog provider must be openai`);
      continue;
    }
    if (primaryEntry.adapterType !== "codex_local") {
      errors.push(`model-policy ${slug}: primary modelCatalog adapterType must be codex_local`);
      continue;
    }
    const anthropicModel = firstAnthropicFallbackModel(role, catalog);
    if (!anthropicModel) {
      errors.push(
        `model-policy ${slug}: fallback must include a model with modelCatalog provider anthropic`,
      );
      continue;
    }
    const anthropicEntry = asRecord(catalog[anthropicModel]);
    if (anthropicEntry?.provider !== "anthropic") {
      errors.push(
        `model-policy ${slug}: anthropic fallback modelCatalog provider must be anthropic`,
      );
      continue;
    }
    if (anthropicEntry?.adapterType !== "claude_local") {
      errors.push(
        `model-policy ${slug}: anthropic fallback modelCatalog adapterType must be claude_local`,
      );
      continue;
    }
    expectations.set(slug, {
      openAi: {
        model: primary.model,
        modelReasoningEffort: role.effort,
        filesystemWorkspaceAccess: primary.workspaceAccess,
        maxDailyRuns,
      },
      anthropic: {
        model: anthropicModel,
        maxDailyRuns,
      },
    });
  }
  return expectations;
}

function resolveJarvisPath(desiredDir, relativePath) {
  return path.resolve(desiredDir, "..", relativePath);
}

function ensureNonEmptyAbsoluteExistingFile({ runtimeEnv, envName }) {
  const rawValue = runtimeEnv?.[envName];
  if (!isNonEmptyAbsolutePath(rawValue)) {
    throw new Error(`${envName} must be a non-empty absolute path`);
  }
  const fullPath = String(rawValue).trim();
  if (!existsSync(fullPath)) {
    throw new Error(`${envName} does not exist: ${fullPath}`);
  }
  return fullPath;
}

function buildOpenAiJarvisArtifact({ desiredDir, runtimeEnv = process.env }) {
  const sourcePath = ensureNonEmptyAbsoluteExistingFile({
    runtimeEnv,
    envName: BOSS_INSTRUCTIONS_SOURCE_ENV,
  });
  const cockpitPath = resolveJarvisPath(desiredDir, path.join("package", "agents", JARVIS_SLUG, "AGENTS.md"));
  const fullPath = resolveJarvisPath(desiredDir, JARVIS_CODEX_FULL_ARTIFACT_RELATIVE);
  const compactPath = resolveJarvisPath(desiredDir, JARVIS_CODEX_ARTIFACT_RELATIVE);
  if (!existsSync(cockpitPath)) {
    throw new Error(`cockpit AGENTS.md not found: ${cockpitPath}`);
  }
  if (!existsSync(fullPath)) {
    throw new Error(`committed ${JARVIS_CODEX_FULL_AGENTS_FILE} not found: ${fullPath}`);
  }
  if (!existsSync(compactPath)) {
    throw new Error(`committed ${JARVIS_CODEX_AGENTS_FILE} not found: ${compactPath}`);
  }
  const source = readFileSync(sourcePath, "utf8");
  const cockpit = readFileSync(cockpitPath, "utf8");
  const committedFull = readFileSync(fullPath, "utf8");
  const committedCompact = readFileSync(compactPath, "utf8");
  const generated = generateCodexJarvisArtifacts({
    headlessBossClaude: source,
    cockpitAgentsMd: cockpit,
  });
  if (generated.full.content !== committedFull) {
    throw new Error(
      `${JARVIS_CODEX_FULL_AGENTS_FILE} mismatch (generated=${hashPrefix(generated.full.content)} committed=${hashPrefix(committedFull)})`,
    );
  }
  if (generated.compact.content !== committedCompact) {
    throw new Error(
      `${JARVIS_CODEX_AGENTS_FILE} mismatch (generated=${hashPrefix(generated.compact.content)} committed=${hashPrefix(committedCompact)})`,
    );
  }
  return {
    sourcePath,
    sourceSha256: generated.full.sourceSha256,
    cockpitSha256: generated.full.cockpitSha256,
    content: committedCompact,
    contentHashPrefix: hashPrefix(committedCompact),
    fullContent: committedFull,
    fullContentHashPrefix: hashPrefix(committedFull),
    entryFile: JARVIS_CODEX_AGENTS_FILE,
  };
}

function deriveExpectedSwitchableSlugs(desired) {
  const portable = (desired.agents?.agents ?? [])
    .filter((agent) => agent.adapterType === "claude_local")
    .map((agent) => agent.slug);
  return [...portable, "summarizer", "reflection-coach"].sort();
}

function validateSlugSet({ label, slugs, expectedSet, errors }) {
  const seen = new Set();
  for (const slug of slugs) {
    if (seen.has(slug)) {
      errors.push(`${label}: duplicate slug ${slug}`);
      continue;
    }
    seen.add(slug);
    if (!expectedSet.has(slug)) {
      errors.push(`${label}: unknown slug ${slug}`);
    }
  }
  for (const slug of expectedSet) {
    if (!seen.has(slug)) errors.push(`${label}: missing slug ${slug}`);
  }
}

function validateUnexpectedEntryKeys({ profileName, slug, got, allowedKeys, errors }) {
  const unknownKeys = Object.keys(got ?? {}).filter((key) => !allowedKeys.includes(key));
  if (unknownKeys.length > 0) {
    errors.push(`${profileName} ${slug}: unexpected fields ${unknownKeys.join(", ")}`);
  }
}

function isNonEmptyAbsolutePath(value) {
  if (typeof value !== "string") return false;
  const normalized = value.trim();
  if (normalized === "") return false;
  return path.isAbsolute(normalized);
}

function expectedAnthropicConfigProfile(slug) {
  return slug === JARVIS_SLUG ? "boss" : "worker";
}

export function validateProviderProfilesDocument({
  desired,
  profilesDoc,
  desiredDir = DESIRED_DIR,
  modelPolicy = null,
}) {
  const errors = [];
  if (!Number.isInteger(profilesDoc?.schemaVersion)) {
    errors.push("profiles.json: schemaVersion must be an integer");
  }
  const expectedSwitchable = deriveExpectedSwitchableSlugs(desired);
  if (expectedSwitchable.length !== EXPECTED_SWITCHABLE_COUNT) {
    errors.push(
      `profiles.json: expected exactly ${EXPECTED_SWITCHABLE_COUNT} switchable slugs from desired state, got ${expectedSwitchable.length}`,
    );
  }
  const expectedSet = new Set(expectedSwitchable);
  const configuredSwitchable = Array.isArray(profilesDoc?.switchableAgents)
    ? profilesDoc.switchableAgents.map(String)
    : [];
  validateSlugSet({
    label: "profiles.json switchableAgents",
    slugs: configuredSwitchable,
    expectedSet,
    errors,
  });

  const policy = modelPolicy ?? readModelPolicyFile(desiredDir, errors);
  const policyVersion = typeof policy?.version === "string" && policy.version.trim() !== ""
    ? policy.version
    : null;
  if (policy && !policyVersion) {
    errors.push("model-policy: version is required");
  }

  for (const profileName of REQUIRED_PROFILES) {
    if (!profilesDoc?.profiles?.[profileName]) {
      errors.push(`profiles.json: missing profile ${profileName}`);
      continue;
    }
    const profile = profilesDoc.profiles[profileName];
    if (typeof profile.version !== "string" || profile.version.trim() === "") {
      errors.push(`profiles.json ${profileName}: version is required`);
    } else if (policyVersion && profile.version !== policyVersion) {
      errors.push(
        `profiles.json ${profileName}: version must equal model-policy version ${policyVersion}`,
      );
    }
    if (!Array.isArray(profile.agents)) {
      errors.push(`profiles.json ${profileName}: agents must be an array`);
      continue;
    }
    validateSlugSet({
      label: `profiles.json ${profileName}`,
      slugs: profile.agents.map((item) => String(item?.slug ?? "")),
      expectedSet,
      errors,
    });
  }

  const policyExpectations = deriveProfileExpectationsFromPolicy({
    slugs: expectedSwitchable,
    policy,
    errors,
  });

  const openAiBySlug = new Map(
    (profilesDoc?.profiles?.["openai-first"]?.agents ?? []).map((item) => [item.slug, item]),
  );
  for (const slug of expectedSwitchable) {
    const got = openAiBySlug.get(slug);
    if (!got) continue;
    validateUnexpectedEntryKeys({
      profileName: "openai-first",
      slug,
      got,
      allowedKeys: OPENAI_PROFILE_ENTRY_KEYS,
      errors,
    });
    if (got.adapterType !== "codex_local") {
      errors.push(`openai-first ${slug}: adapterType must be codex_local`);
    }
    const expected = policyExpectations.get(slug)?.openAi;
    if (!expected) continue;
    if (got.model !== expected.model) {
      errors.push(`openai-first ${slug}: model must be ${expected.model}`);
    }
    if (got.modelReasoningEffort !== expected.modelReasoningEffort) {
      errors.push(
        `openai-first ${slug}: modelReasoningEffort must be ${expected.modelReasoningEffort}`,
      );
    }
    if (got.filesystemWorkspaceAccess !== expected.filesystemWorkspaceAccess) {
      errors.push(
        `openai-first ${slug}: filesystemWorkspaceAccess must be ${expected.filesystemWorkspaceAccess}`,
      );
    }
    if (got.maxDailyRuns !== expected.maxDailyRuns) {
      errors.push(`openai-first ${slug}: maxDailyRuns must be ${expected.maxDailyRuns}`);
    }
  }

  const anthropicBySlug = new Map(
    (profilesDoc?.profiles?.["anthropic-first"]?.agents ?? []).map((item) => [item.slug, item]),
  );
  for (const slug of expectedSwitchable) {
    const got = anthropicBySlug.get(slug);
    if (!got) continue;
    validateUnexpectedEntryKeys({
      profileName: "anthropic-first",
      slug,
      got,
      allowedKeys: ANTHROPIC_PROFILE_ENTRY_KEYS,
      errors,
    });
    if (got.adapterType !== "claude_local") {
      errors.push(`anthropic-first ${slug}: adapterType must be claude_local`);
    }
    const expected = policyExpectations.get(slug)?.anthropic;
    if (expected) {
      if (got.model !== expected.model) {
        errors.push(`anthropic-first ${slug}: model must be ${expected.model}`);
      }
      if (got.maxDailyRuns !== expected.maxDailyRuns) {
        errors.push(`anthropic-first ${slug}: maxDailyRuns must be ${expected.maxDailyRuns}`);
      }
    }
    const expectedMaxTurns = ANTHROPIC_EXPECTED_MAX_TURNS[slug];
    if (got.maxTurnsPerRun !== expectedMaxTurns) {
      errors.push(`anthropic-first ${slug}: maxTurnsPerRun must be ${expectedMaxTurns}`);
    }
    if (!Number.isInteger(got.maxTurnsPerRun) || got.maxTurnsPerRun < 1 || got.maxTurnsPerRun > 40) {
      errors.push(`anthropic-first ${slug}: maxTurnsPerRun must be integer between 1 and 40`);
    }
    const expectedConfigProfile = expectedAnthropicConfigProfile(slug);
    if (got.claudeConfigProfile !== expectedConfigProfile) {
      errors.push(
        `anthropic-first ${slug}: claudeConfigProfile must be ${expectedConfigProfile}`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    expectedSwitchable,
  };
}

function isSecretVersionSelector(value) {
  return value === "latest" || (Number.isInteger(value) && value > 0);
}

/**
 * Strict local parse of a Paperclip secret_ref object.
 * Fail-closed on malformed shapes; never accepts or preserves plaintext values.
 * When allowRedactedSecretRefs is true (offline detect/preview only), the literal
 * SECRET_REDACTION_MARKER is accepted as secretId so redacted snapshots still deep-equal.
 * Mutating paths must leave the flag false and fail closed on the marker.
 */
function parseSecretRefBinding(record, label, { allowRedactedSecretRefs = false } = {}) {
  const unknown = Object.keys(record).filter((key) => !SECRET_REF_ALLOWED_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new Error(`malformed secret_ref at ${label}: unexpected fields ${unknown.join(", ")}`);
  }
  const secretIdOk = typeof record.secretId === "string"
    && (
      UUID_RE.test(record.secretId)
      || (allowRedactedSecretRefs === true && record.secretId === SECRET_REDACTION_MARKER)
    );
  if (!secretIdOk) {
    throw new Error(
      allowRedactedSecretRefs
        ? `malformed secret_ref at ${label}: secretId must be a uuid or ${SECRET_REDACTION_MARKER}`
        : `malformed secret_ref at ${label}: secretId must be a uuid`,
    );
  }
  const out = {
    type: "secret_ref",
    secretId: record.secretId,
  };
  if (record.version !== undefined) {
    if (!isSecretVersionSelector(record.version)) {
      throw new Error(`malformed secret_ref at ${label}: version must be "latest" or a positive integer`);
    }
    out.version = record.version;
  }
  if (record.projectionClass !== undefined) {
    if (!SECRET_PROJECTION_CLASSES.includes(record.projectionClass)) {
      throw new Error(
        `malformed secret_ref at ${label}: projectionClass must be one of ${SECRET_PROJECTION_CLASSES.join(", ")}`,
      );
    }
    out.projectionClass = record.projectionClass;
  }
  if (record.projectionAllowlistKey !== undefined) {
    if (record.projectionAllowlistKey !== null) {
      if (
        typeof record.projectionAllowlistKey !== "string"
        || record.projectionAllowlistKey.trim() === ""
        || record.projectionAllowlistKey.trim().length > 160
      ) {
        throw new Error(
          `malformed secret_ref at ${label}: projectionAllowlistKey must be null or a non-empty string (<=160)`,
        );
      }
      out.projectionAllowlistKey = record.projectionAllowlistKey.trim();
    } else {
      out.projectionAllowlistKey = null;
    }
  }
  return out;
}

/**
 * Strict local parse of a Paperclip user_secret_ref object.
 * Fail-closed on malformed shapes; never accepts plaintext values.
 */
function parseUserSecretRefBinding(record, label) {
  const unknown = Object.keys(record).filter((key) => !USER_SECRET_REF_ALLOWED_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new Error(`malformed user_secret_ref at ${label}: unexpected fields ${unknown.join(", ")}`);
  }
  if (typeof record.key !== "string" || !USER_SECRET_KEY_RE.test(record.key)) {
    throw new Error(
      `malformed user_secret_ref at ${label}: key must match /^[a-zA-Z0-9_.-]{1,120}$/`,
    );
  }
  const out = {
    type: "user_secret_ref",
    key: record.key,
  };
  if (record.version !== undefined) {
    if (!isSecretVersionSelector(record.version)) {
      throw new Error(
        `malformed user_secret_ref at ${label}: version must be "latest" or a positive integer`,
      );
    }
    out.version = record.version;
  }
  if (record.required !== undefined) {
    if (typeof record.required !== "boolean") {
      throw new Error(`malformed user_secret_ref at ${label}: required must be a boolean`);
    }
    out.required = record.required;
  }
  if (record.allowMissingOverride !== undefined) {
    if (typeof record.allowMissingOverride !== "boolean") {
      throw new Error(
        `malformed user_secret_ref at ${label}: allowMissingOverride must be a boolean`,
      );
    }
    out.allowMissingOverride = record.allowMissingOverride;
  }
  return out;
}

/**
 * Returns a preserved secret/user_secret ref, null when the value is not a ref
 * candidate (plain/unknown — caller drops), or throws on malformed ref shapes.
 */
function tryPreserveSecretBinding(value, label, { allowRedactedSecretRefs = false } = {}) {
  const record = asRecord(value);
  if (!record || typeof record.type !== "string") return null;
  if (record.type === "secret_ref") {
    return parseSecretRefBinding(record, label, { allowRedactedSecretRefs });
  }
  if (record.type === "user_secret_ref") return parseUserSecretRefBinding(record, label);
  return null;
}

function preserveEnvSecretRefBindings(
  liveEnv,
  labelPrefix = "adapterConfig.env",
  { allowRedactedSecretRefs = false } = {},
) {
  const live = asRecord(liveEnv);
  if (!live) return {};
  const out = {};
  for (const [key, value] of Object.entries(live)) {
    const preserved = tryPreserveSecretBinding(value, `${labelPrefix}.${key}`, {
      allowRedactedSecretRefs,
    });
    if (preserved) out[key] = preserved;
  }
  return out;
}

function preserveManagedAdapterConfigFields(
  liveAdapterConfig,
  { allowRedactedSecretRefs = false } = {},
) {
  const out = {};
  const live = asRecord(liveAdapterConfig) ?? {};
  for (const key of PRESERVED_ADAPTER_CONFIG_KEYS) {
    if (live[key] !== undefined) out[key] = cloneJson(live[key]);
  }
  for (const [key, value] of Object.entries(live)) {
    if (PRESERVED_ADAPTER_CONFIG_KEYS.includes(key)) continue;
    if (key === "env") continue;
    const preserved = tryPreserveSecretBinding(value, `adapterConfig.${key}`, {
      allowRedactedSecretRefs,
    });
    if (preserved) out[key] = preserved;
  }
  return out;
}

function withJarvisInstructionsPath({
  profileName,
  slug,
  preserved,
}) {
  if (slug !== JARVIS_SLUG) return preserved;
  const rootPath = typeof preserved.instructionsRootPath === "string"
    ? preserved.instructionsRootPath.trim()
    : "";
  if (!isNonEmptyAbsolutePath(rootPath)) {
    throw new Error(
      `profile ${profileName} requires ${JARVIS_SLUG} adapterConfig.instructionsRootPath as a non-empty absolute path`,
    );
  }
  const entryFile = profileName === "openai-first"
    ? JARVIS_CODEX_AGENTS_FILE
    : JARVIS_ANTHROPIC_AGENTS_FILE;
  return {
    ...preserved,
    instructionsEntryFile: entryFile,
    instructionsFilePath: path.join(rootPath, entryFile),
  };
}

function buildTargetAdapterConfig(
  profileName,
  profileEntry,
  liveAgent,
  {
    runtimeEnv = process.env,
    runtimeCapabilitiesBySlug = null,
    allowRedactedSecretRefs = false,
  } = {},
) {
  const liveAdapterConfig = asRecord(liveAgent.adapterConfig) ?? {};
  const preserved = withJarvisInstructionsPath({
    profileName,
    slug: profileEntry.slug,
    preserved: preserveManagedAdapterConfigFields(liveAdapterConfig, {
      allowRedactedSecretRefs,
    }),
  });
  const preservedEnv = preserveEnvSecretRefBindings(liveAdapterConfig.env, "adapterConfig.env", {
    allowRedactedSecretRefs,
  });
  let adapterConfig;
  if (profileName === "openai-first") {
    adapterConfig = {
      ...preserved,
      engine: "cli",
      model: profileEntry.model,
      modelReasoningEffort: profileEntry.modelReasoningEffort,
      fastMode: false,
      search: false,
      dangerouslyBypassApprovalsAndSandbox: false,
      filesystemScope: "workspace",
      filesystemWorkspaceAccess: profileEntry.filesystemWorkspaceAccess,
      networkScope: "allowlist",
      networkAllowlist: [...OPENAI_SAFE_ALLOWLIST],
      extraArgs: [...SAFE_CODEX_EXTRA_ARGS],
      timeoutSec: PATCH_TIMEOUT_SEC,
      outputInactivityTimeoutMs: PATCH_INACTIVITY_TIMEOUT_MS,
      graceSec: PATCH_GRACE_SEC,
    };
    if (Object.keys(preservedEnv).length > 0) {
      adapterConfig.env = preservedEnv;
    }
  } else {
    const configEnvName = profileEntry.claudeConfigProfile === "boss"
      ? ANTHROPIC_BOSS_CONFIG_ENV
      : ANTHROPIC_WORKER_CONFIG_ENV;
    const configDir = runtimeEnv?.[configEnvName];
    adapterConfig = {
      ...preserved,
      engine: "cli",
      model: profileEntry.model,
      maxTurnsPerRun: profileEntry.maxTurnsPerRun,
      dangerouslySkipPermissions: true,
      filesystemScope: "workspace",
      networkScope: "allowlist",
      networkAllowlist: [...ANTHROPIC_SAFE_ALLOWLIST],
      timeoutSec: PATCH_TIMEOUT_SEC,
      graceSec: PATCH_GRACE_SEC,
      chrome: false,
      env: {
        ...preservedEnv,
        // Always rebuild from trusted runtimeEnv; wins over any live CLAUDE_CONFIG_DIR ref/plain.
        CLAUDE_CONFIG_DIR: {
          type: "plain",
          value: configDir,
        },
      },
    };
  }
  const capabilities = runtimeCapabilitiesBySlug?.get?.(profileEntry.slug) ?? null;
  return applyRuntimeCapabilitiesToAdapterConfig(adapterConfig, capabilities);
}

function buildTargetRuntimeConfig(liveAgent, profileEntry) {
  const base = asRecord(liveAgent.runtimeConfig) ?? {};
  return {
    ...cloneJson(base),
    heartbeat: {
      enabled: false,
      wakeOnDemand: true,
      maxConcurrentRuns: 1,
      maxDailyRuns: profileEntry.maxDailyRuns,
    },
  };
}

function normalizeLiveAgentState(liveAgent) {
  return {
    status: liveAgent.status ?? null,
    adapterType: liveAgent.adapterType ?? null,
    adapterConfig: asRecord(liveAgent.adapterConfig) ?? {},
    runtimeConfig: asRecord(liveAgent.runtimeConfig) ?? {},
    desiredSkills: Array.isArray(liveAgent.desiredSkills) ? [...liveAgent.desiredSkills] : [],
  };
}

function normalizeExpectedState(
  profileName,
  profileEntry,
  liveAgent,
  {
    runtimeEnv = process.env,
    runtimeCapabilitiesBySlug = null,
    allowRedactedSecretRefs = false,
  } = {},
) {
  return {
    status: "paused",
    adapterType: profileEntry.adapterType,
    adapterConfig: buildTargetAdapterConfig(profileName, profileEntry, liveAgent, {
      runtimeEnv,
      runtimeCapabilitiesBySlug,
      allowRedactedSecretRefs,
    }),
    runtimeConfig: buildTargetRuntimeConfig(liveAgent, profileEntry),
  };
}

function getLiveAgentBySlug(liveSnapshot) {
  return new Map((liveSnapshot.agents ?? []).map((agent) => [agent.slug, agent]));
}

function extractProfileBySlug(profilesDoc, profileName) {
  return new Map(
    (profilesDoc.profiles?.[profileName]?.agents ?? []).map((entry) => [entry.slug, entry]),
  );
}

function matchesFullSafeProfileState({
  profileName,
  profileEntry,
  liveAgent,
  runtimeCapabilitiesBySlug = null,
  allowRedactedSecretRefs = false,
}) {
  try {
    const runtimeEnv = {};
    if (profileName === "anthropic-first") {
      const configEnvName = profileEntry.claudeConfigProfile === "boss"
        ? ANTHROPIC_BOSS_CONFIG_ENV
        : ANTHROPIC_WORKER_CONFIG_ENV;
      const configBinding = liveAgent?.adapterConfig?.env?.CLAUDE_CONFIG_DIR;
      if (
        configBinding?.type !== "plain"
        || !isNonEmptyAbsolutePath(configBinding?.value)
      ) {
        return false;
      }
      runtimeEnv[configEnvName] = configBinding.value;
    }
    const currentState = normalizeLiveAgentState(liveAgent);
    const expectedState = normalizeExpectedState(
      profileName,
      profileEntry,
      liveAgent,
      { runtimeEnv, runtimeCapabilitiesBySlug, allowRedactedSecretRefs },
    );
    return currentState.status === expectedState.status
      && currentState.adapterType === expectedState.adapterType
      && deepEqual(currentState.adapterConfig, expectedState.adapterConfig)
      && deepEqual(currentState.runtimeConfig, expectedState.runtimeConfig);
  } catch {
    return false;
  }
}

export function detectProviderProfileState({
  profilesDoc,
  liveSnapshot,
  runtimeCapabilitiesBySlug = null,
  desiredDir = DESIRED_DIR,
  allowRedactedSecretRefs = false,
}) {
  let capabilitiesBySlug = runtimeCapabilitiesBySlug;
  if (capabilitiesBySlug == null) {
    const loaded = loadValidatedRuntimeCapabilities(desiredDir);
    if (!loaded.ok) {
      return {
        ok: false,
        profileName: null,
        switchableSlugs: Array.isArray(profilesDoc?.switchableAgents)
          ? [...new Set(profilesDoc.switchableAgents.map((slug) => String(slug)))].sort()
          : [],
        matchedProfileBySlug: {},
        issues: loaded.errors.map((detail) => ({
          code: "runtime-capabilities-invalid",
          detail,
        })),
      };
    }
    capabilitiesBySlug = loaded.bySlug;
  }
  const switchableSlugs = Array.isArray(profilesDoc?.switchableAgents)
    ? [...new Set(profilesDoc.switchableAgents.map((slug) => String(slug)))].sort()
    : [];
  const declaredProfileNames = Object.keys(profilesDoc?.profiles ?? {}).sort();
  const profileByName = new Map(
    declaredProfileNames.map((profileName) => [profileName, extractProfileBySlug(profilesDoc, profileName)]),
  );
  const liveBySlug = getLiveAgentBySlug(liveSnapshot ?? {});
  const issues = [];
  const matchedProfileBySlug = {};

  for (const slug of switchableSlugs) {
    const live = liveBySlug.get(slug);
    if (!live) {
      issues.push({ code: "missing", slug, detail: `missing live switchable agent ${slug}` });
      continue;
    }
    const matchedProfiles = [];
    for (const profileName of declaredProfileNames) {
      const entry = profileByName.get(profileName)?.get(slug);
      if (!entry) continue;
      if (matchesFullSafeProfileState({
        profileName,
        profileEntry: entry,
        liveAgent: live,
        runtimeCapabilitiesBySlug: capabilitiesBySlug,
        allowRedactedSecretRefs,
      })) {
        matchedProfiles.push(profileName);
      }
    }
    if (matchedProfiles.length === 0) {
      issues.push({
        code: "unknown",
        slug,
        detail: `${slug} does not match the full safe configuration of any declared profile`,
      });
      continue;
    }
    if (matchedProfiles.length > 1) {
      issues.push({
        code: "unknown",
        slug,
        detail: `${slug} matches multiple profiles: ${matchedProfiles.join(", ")}`,
        matchedProfiles,
      });
      continue;
    }
    matchedProfileBySlug[slug] = matchedProfiles[0];
  }

  const matchedProfiles = Object.values(matchedProfileBySlug);
  const uniqueProfiles = [...new Set(matchedProfiles)].sort();
  if (issues.length === 0 && uniqueProfiles.length === 1) {
    return {
      ok: true,
      profileName: uniqueProfiles[0],
      switchableSlugs,
      matchedProfileBySlug,
      issues: [],
    };
  }
  if (issues.length === 0 && uniqueProfiles.length > 1) {
    const slugsByProfile = Object.fromEntries(
      uniqueProfiles.map((profileName) => [
        profileName,
        Object.entries(matchedProfileBySlug)
          .filter(([, value]) => value === profileName)
          .map(([slug]) => slug)
          .sort(),
      ]),
    );
    issues.push({
      code: "mixed",
      detail: `switchable agents map to multiple profiles: ${uniqueProfiles.join(", ")}`,
      profiles: uniqueProfiles,
      slugsByProfile,
    });
  }
  return {
    ok: false,
    profileName: null,
    switchableSlugs,
    matchedProfileBySlug,
    issues,
  };
}

function isMissingAnthropicConfigDir(runtimeEnv, envName) {
  const rawValue = runtimeEnv?.[envName];
  if (!isNonEmptyAbsolutePath(rawValue)) {
    return `${envName} must be a non-empty absolute path`;
  }
  const fullPath = String(rawValue).trim();
  if (!existsSync(fullPath)) {
    return `${envName} points to a path that does not exist`;
  }
  try {
    if (!statSync(fullPath).isDirectory()) {
      return `${envName} must point to a directory`;
    }
  } catch {
    return `${envName} points to a path that cannot be inspected`;
  }
  return null;
}

export function planProviderProfileSwitch({
  desiredDir,
  liveSnapshot,
  profileName,
  runtimeEnv = process.env,
  allowRedactedSecretRefs = false,
}) {
  const desired = loadDesired(desiredDir);
  const profilesDoc = readProfilesFile(desiredDir);
  const schemaValidation = validateProviderProfilesDocument({ desired, profilesDoc, desiredDir });
  if (!schemaValidation.ok) {
    return {
      ok: false,
      error: "profiles schema validation failed",
      issues: schemaValidation.errors,
      blockers: schemaValidation.errors,
      planned: [],
      profileName,
    };
  }
  const knownSlugs = [
    ...(desired.agents?.agents ?? []).map((agent) => agent.slug),
    "summarizer",
    "reflection-coach",
  ];
  const runtimeCapabilities = loadValidatedRuntimeCapabilities(desiredDir, { knownSlugs });
  if (!runtimeCapabilities.ok) {
    return {
      ok: false,
      error: "runtime capabilities validation failed",
      issues: runtimeCapabilities.errors,
      blockers: runtimeCapabilities.errors,
      planned: [],
      profileName,
    };
  }
  const runtimeCapabilitiesBySlug = runtimeCapabilities.bySlug;
  if (!REQUIRED_PROFILES.includes(profileName)) {
    return {
      ok: false,
      error: `unsupported profile ${profileName}`,
      issues: [`Supported profiles: ${REQUIRED_PROFILES.join(", ")}`],
      blockers: [`Supported profiles: ${REQUIRED_PROFILES.join(", ")}`],
      planned: [],
      profileName,
    };
  }

  const switchableSlugs = schemaValidation.expectedSwitchable;
  const profileBySlug = extractProfileBySlug(profilesDoc, profileName);
  const liveBySlug = getLiveAgentBySlug(liveSnapshot);
  const planned = [];
  const blockers = [];
  const allAffected = [];
  if (profileName === "anthropic-first") {
    const workerConfigDirError = isMissingAnthropicConfigDir(runtimeEnv, ANTHROPIC_WORKER_CONFIG_ENV);
    if (workerConfigDirError) {
      blockers.push(`anthropic-first requires ${workerConfigDirError}`);
    }
    const bossConfigDirError = isMissingAnthropicConfigDir(runtimeEnv, ANTHROPIC_BOSS_CONFIG_ENV);
    if (bossConfigDirError) {
      blockers.push(`anthropic-first requires ${bossConfigDirError}`);
    }
  }
  for (const slug of switchableSlugs) {
    const live = liveBySlug.get(slug);
    if (!live) {
      blockers.push(`missing live agent ${slug}`);
      continue;
    }
    let skipDueToBlocker = false;
    if (slug === JARVIS_SLUG) {
      const rootPath = live?.adapterConfig?.instructionsRootPath;
      if (!isNonEmptyAbsolutePath(rootPath)) {
        blockers.push(
          `${JARVIS_SLUG} requires adapterConfig.instructionsRootPath as a non-empty absolute path`,
        );
        skipDueToBlocker = true;
      }
    }
    if (skipDueToBlocker) continue;
    const profileEntry = profileBySlug.get(slug);
    if (!profileEntry) {
      blockers.push(`missing profile mapping for ${slug}`);
      continue;
    }
    const currentState = normalizeLiveAgentState(live);
    let expectedState;
    try {
      expectedState = normalizeExpectedState(profileName, profileEntry, live, {
        runtimeEnv,
        runtimeCapabilitiesBySlug,
        allowRedactedSecretRefs,
      });
    } catch (err) {
      blockers.push(`${slug}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const changed =
      currentState.status !== expectedState.status
      || currentState.adapterType !== expectedState.adapterType
      || !deepEqual(currentState.adapterConfig, expectedState.adapterConfig)
      || !deepEqual(currentState.runtimeConfig, expectedState.runtimeConfig);
    const item = {
      slug,
      agentId: live.id,
      status: live.status ?? null,
      from: currentState,
      to: expectedState,
      requiresPatch: changed,
      patch: {
        status: "paused",
        adapterType: expectedState.adapterType,
        adapterConfig: expectedState.adapterConfig,
        runtimeConfig: expectedState.runtimeConfig,
        replaceAdapterConfig: true,
      },
    };
    allAffected.push(item);
    if (changed) planned.push(item);
  }

  const unpaused = allAffected.filter((item) => item.status !== "paused").map((item) => item.slug);
  if (unpaused.length > 0) {
    blockers.push(`affected agents must be paused: ${unpaused.join(", ")}`);
  }

  return {
    ok: blockers.length === 0,
    profileName,
    allAffected,
    planned,
    blockers,
    schemaValidation,
  };
}

function finishReport(report) {
  report.finishedAt = new Date().toISOString();
  report.ok = report.failed.length === 0;
  report.summary = {
    planned: report.planned.length,
    completed: report.completed.length,
    failed: report.failed.length,
    rolledBack: report.rolledBack.length,
    writesSucceeded: report.writesSucceeded,
  };
  return redactSecrets(report);
}

async function verifyPatchedAgent(client, expectedStep) {
  const res = await client.get(`/api/agents/${expectedStep.agentId}`);
  if (!res.ok) return { ok: false, error: `verify GET failed HTTP ${res.status}` };
  const live = res.data ?? {};
  if (live.status !== expectedStep.to.status) {
    return { ok: false, error: `${expectedStep.slug}: status verify mismatch` };
  }
  if (live.adapterType !== expectedStep.to.adapterType) {
    return { ok: false, error: `${expectedStep.slug}: adapterType verify mismatch` };
  }
  const liveAdapterConfig = asRecord(live.adapterConfig) ?? {};
  if (!deepEqual(liveAdapterConfig, expectedStep.to.adapterConfig)) {
    return { ok: false, error: `${expectedStep.slug}: adapterConfig verify mismatch` };
  }
  const liveRuntime = asRecord(live.runtimeConfig) ?? {};
  if (!deepEqual(liveRuntime, expectedStep.to.runtimeConfig)) {
    return { ok: false, error: `${expectedStep.slug}: runtimeConfig verify mismatch` };
  }
  // GET /api/agents/:id does not include desiredSkills; assignment lives on /skills.
  const skillsRes = await client.get(`/api/agents/${expectedStep.agentId}/skills`);
  if (!skillsRes.ok) {
    return {
      ok: false,
      error: `${expectedStep.slug}: desiredSkills verify GET failed HTTP ${skillsRes.status}`,
    };
  }
  if (!Array.isArray(skillsRes.data?.desiredSkills)) {
    return {
      ok: false,
      error: `${expectedStep.slug}: desiredSkills missing from skills verify GET`,
    };
  }
  if (!deepEqual(skillsRes.data.desiredSkills, expectedStep.from.desiredSkills)) {
    return { ok: false, error: `${expectedStep.slug}: desiredSkills drift during profile patch` };
  }
  return { ok: true };
}

async function verifyRestoredAgent(client, step) {
  const res = await client.get(`/api/agents/${step.agentId}`);
  if (!res.ok) return { ok: false, error: `restore verify GET failed HTTP ${res.status}` };
  const live = res.data ?? {};
  if (live.status !== "paused") {
    return { ok: false, error: `${step.slug}: restore status mismatch` };
  }
  if (live.adapterType !== step.from.adapterType) {
    return { ok: false, error: `${step.slug}: restore adapterType mismatch` };
  }
  const liveAdapterConfig = asRecord(live.adapterConfig) ?? {};
  if (!deepEqual(liveAdapterConfig, step.from.adapterConfig)) {
    return { ok: false, error: `${step.slug}: restore adapterConfig mismatch` };
  }
  const liveRuntime = asRecord(live.runtimeConfig) ?? {};
  if (!deepEqual(liveRuntime, step.from.runtimeConfig)) {
    return { ok: false, error: `${step.slug}: restore runtimeConfig mismatch` };
  }
  return { ok: true };
}

async function fetchLiveRuns(client, companyId) {
  const res = await client.get(`/api/companies/${companyId}/live-runs?limit=1&minCount=0`);
  if (!res.ok) {
    return { ok: false, error: `live-runs check failed HTTP ${res.status}`, runs: [] };
  }
  const runs = Array.isArray(res.data) ? res.data : [];
  return { ok: true, runs };
}

async function getInstructionsBundleFile(client, agentId, fileName) {
  const route = `/api/agents/${agentId}/instructions-bundle/file?path=${encodeURIComponent(fileName)}`;
  const res = await client.get(route);
  if (!res.ok && res.status === 404) return { ok: true, missing: true, content: null };
  if (!res.ok) return { ok: false, error: `bundle GET failed HTTP ${res.status}` };
  return { ok: true, missing: false, content: String(res.data?.content ?? "") };
}

async function putInstructionsBundleFile(client, agentId, fileName, content) {
  const route = `/api/agents/${agentId}/instructions-bundle/file?path=${encodeURIComponent(fileName)}`;
  const res = await client.put(route, { path: fileName, content });
  if (!res.ok) return { ok: false, writeAttempted: true, error: `bundle PUT failed HTTP ${res.status}` };
  return { ok: true, writeAttempted: true };
}

async function captureJarvisInstructionsBackup(client, jarvisStep) {
  // Prefer compact entry; fall back to legacy full harness for first migration.
  const candidates = [JARVIS_CODEX_AGENTS_FILE, JARVIS_CODEX_FULL_AGENTS_FILE];
  let lastError = null;
  for (const fileName of candidates) {
    const current = await getInstructionsBundleFile(
      client,
      jarvisStep.agentId,
      fileName,
    );
    if (!current.ok) {
      lastError = current;
      continue;
    }
    if (current.missing) continue;
    return {
      ok: true,
      agentId: jarvisStep.agentId,
      path: fileName,
      content: current.content,
      sha256: sha256(current.content),
    };
  }
  if (lastError && !lastError.ok) return lastError;
  return {
    ok: false,
    error: "cannot switch safely: previous Jarvis instruction content is missing",
  };
}

async function restoreJarvisInstructionsBackup(client, backup) {
  const expectedHash = sha256(backup.content);
  if (expectedHash !== backup.sha256) {
    return { ok: false, error: "Jarvis instruction backup hash mismatch" };
  }
  const put = await putInstructionsBundleFile(
    client,
    backup.agentId,
    backup.path,
    backup.content,
  );
  if (!put.ok) return put;
  const verify = await getInstructionsBundleFile(client, backup.agentId, backup.path);
  if (!verify.ok) return { ...verify, writeAttempted: true };
  if (
    verify.missing
    || sha256(verify.content) !== backup.sha256
    || verify.content !== backup.content
  ) {
    return {
      ok: false,
      writeAttempted: true,
      error: `Jarvis instruction restore verify mismatch expected=${backup.sha256.slice(0, 12)} got=${hashPrefix(
        verify.content ?? "",
      )}`,
    };
  }
  return {
    ok: true,
    writeAttempted: true,
    hashPrefix: backup.sha256.slice(0, 12),
  };
}

async function ensureJarvisCodexBundle({
  client,
  jarvisStep,
  artifactContent,
}) {
  const current = await getInstructionsBundleFile(client, jarvisStep.agentId, JARVIS_CODEX_AGENTS_FILE);
  if (!current.ok) return current;
  if (!current.missing && current.content === artifactContent) {
    return {
      ok: true,
      action: "none",
      status: "already-exact",
      hashPrefix: hashPrefix(artifactContent),
      changed: false,
      writeAttempted: false,
    };
  }
  const put = await putInstructionsBundleFile(
    client,
    jarvisStep.agentId,
    JARVIS_CODEX_AGENTS_FILE,
    artifactContent,
  );
  if (!put.ok) return put;
  const verify = await getInstructionsBundleFile(client, jarvisStep.agentId, JARVIS_CODEX_AGENTS_FILE);
  if (!verify.ok) return { ...verify, writeAttempted: true };
  if (verify.missing || verify.content !== artifactContent) {
    return {
      ok: false,
      writeAttempted: true,
      error: `bundle verify mismatch expected=${hashPrefix(artifactContent)} got=${hashPrefix(
        verify.content ?? "",
      )}`,
    };
  }
  return {
    ok: true,
    action: "put",
    status: current.missing ? "uploaded" : "updated",
    hashPrefix: hashPrefix(artifactContent),
    changed: true,
    writeAttempted: true,
  };
}

async function rollbackStep({ client, step, report }) {
  if (step.instructionsBackup) {
    const instructionsRestore = await restoreJarvisInstructionsBackup(
      client,
      step.instructionsBackup,
    );
    if (instructionsRestore.writeAttempted) report.writesSucceeded += 1;
    if (!instructionsRestore.ok) throw new Error(instructionsRestore.error);
  }
  const restoreBody = {
    status: "paused",
    adapterType: step.from.adapterType,
    adapterConfig: step.from.adapterConfig,
    runtimeConfig: step.from.runtimeConfig,
    replaceAdapterConfig: true,
  };
  const restoreRes = await client.patch(`/api/agents/${step.agentId}`, restoreBody);
  if (!restoreRes.ok) {
    throw new Error(`${step.slug}: rollback PATCH failed HTTP ${restoreRes.status}`);
  }
  report.writesSucceeded += 1;
  const verified = await verifyRestoredAgent(client, step);
  if (!verified.ok) throw new Error(verified.error);
  report.rolledBack.push({ slug: step.slug, agentId: step.agentId, result: "rolled-back" });
}

function writeSwitchBackupFile({ backupPath, payload }) {
  if (!backupPath) throw new Error("--state-backup-file is required");
  if (existsSync(backupPath)) {
    throw new Error(`refusing to overwrite existing state backup file: ${backupPath}`);
  }
  const backupDir = path.dirname(backupPath);
  mkdirSync(backupDir, { recursive: true });
  const tempPath = path.join(
    backupDir,
    `.${path.basename(backupPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  const content = `${JSON.stringify(payload, null, 2)}\n`;
  let tempFd;
  try {
    tempFd = openSync(tempPath, "wx", 0o600);
    writeSync(tempFd, content, undefined, "utf8");
    fsyncSync(tempFd);
    closeSync(tempFd);
    tempFd = undefined;
    if (existsSync(backupPath)) {
      throw new Error(`refusing to overwrite existing state backup file: ${backupPath}`);
    }
    renameSync(tempPath, backupPath);
    chmodSync(backupPath, 0o600);
  } catch (err) {
    if (tempFd !== undefined) {
      try {
        closeSync(tempFd);
      } catch {
        // no-op cleanup
      }
    }
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // no-op cleanup
    }
    throw err;
  }
}

function isEmptyAgentInstructions(value) {
  return value == null || typeof value !== "string" || value.trim().length === 0;
}

function agentBuiltInKey(agent) {
  return agent?.metadata?.paperclipBuiltInAgent?.key ?? null;
}

/**
 * When profile-switch apply used --allow-empty-instruction-repair for live
 * capture, tolerate empty AGENTS.md only for non-switchable portable agents
 * whose canonical package AGENTS.md is non-empty (deferred fleet apply repair).
 * Never repairs or writes instructions here. Switchable/affected empties and
 * missing package seeds fail closed before any mutation.
 *
 * Fail-closed against the live snapshot: every agent with null/empty/whitespace
 * instructions must have a non-empty slug that appears exactly in
 * completeness.emptyInstructionRepairSlugs. Structured repair slugs that do not
 * correspond to an actually empty portable agent are rejected before writes.
 */
export function assertProfileSwitchEmptyInstructionRepairScope({
  liveSnapshot,
  switchableSlugs,
  packageDir = PACKAGE_DIR,
}) {
  const repairSlugs = Array.isArray(liveSnapshot?.completeness?.emptyInstructionRepairSlugs)
    ? [...new Set(liveSnapshot.completeness.emptyInstructionRepairSlugs.map(String))].sort()
    : [];
  const repairSlugSet = new Set(repairSlugs);
  const switchable = new Set((switchableSlugs ?? []).map(String));
  const pkg = loadPackage(packageDir);
  const errors = [];

  const agents = Array.isArray(liveSnapshot?.agents) ? liveSnapshot.agents : [];
  const actualEmptyBySlug = new Map();

  for (const agent of agents) {
    if (!isEmptyAgentInstructions(agent?.instructions)) continue;

    const rawSlug = typeof agent?.slug === "string" ? agent.slug.trim() : "";
    if (rawSlug === "") {
      const label = agent?.name ?? agent?.id ?? "<unknown>";
      errors.push(
        `empty AGENTS.md on agent ${label} requires a non-empty slug to match `
          + `completeness.emptyInstructionRepairSlugs before profile-switch writes`,
      );
      continue;
    }

    if (actualEmptyBySlug.has(rawSlug)) {
      errors.push(`empty AGENTS.md: duplicate live agent slug ${rawSlug}`);
      continue;
    }
    actualEmptyBySlug.set(rawSlug, agent);

    if (!repairSlugSet.has(rawSlug)) {
      errors.push(
        `empty AGENTS.md on live agent ${rawSlug} is missing from `
          + `completeness.emptyInstructionRepairSlugs (refuse mismatched repair scope)`,
      );
    }
  }

  const actualEmptySlugs = [...actualEmptyBySlug.keys()].sort();
  if (repairSlugs.length === 0 && actualEmptySlugs.length === 0) {
    return { ok: errors.length === 0, errors, repairSlugs };
  }

  for (const slug of repairSlugs) {
    const agent = actualEmptyBySlug.get(slug);
    if (!agent) {
      errors.push(
        `completeness.emptyInstructionRepairSlugs lists ${slug} but live snapshot has no `
          + `agent with null/empty/whitespace instructions under that slug`,
      );
      continue;
    }
    if (agentBuiltInKey(agent)) {
      errors.push(
        `empty AGENTS.md on built-in agent ${slug} is not tolerated by profile-switch`,
      );
      continue;
    }
    if (switchable.has(slug)) {
      errors.push(
        `empty AGENTS.md on switchable/affected agent ${slug} is not tolerated by profile-switch `
          + `(use fleet apply empty-bundle repair only for non-switchable portables after profile normalization)`,
      );
      continue;
    }
    const packageInstructions = pkg.agentBySlug?.[slug]?.instructions ?? null;
    if (typeof packageInstructions !== "string" || packageInstructions.trim().length === 0) {
      errors.push(
        `empty AGENTS.md on non-switchable portable ${slug} requires non-empty canonical package `
          + `AGENTS.md so fleet apply can repair afterward`,
      );
    }
  }

  return { ok: errors.length === 0, errors, repairSlugs };
}

function buildStateBackupPayload({
  companyId,
  profileName,
  allAffected,
  snapshotCapturedAt,
  jarvisInstructions = null,
}) {
  const payload = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    kind: "jarvis-provider-profile-backup",
    companyId,
    profileName,
    capturedAt: new Date().toISOString(),
    snapshotCapturedAt: snapshotCapturedAt ?? null,
    agents: allAffected.map((step) => ({
      agentId: step.agentId,
      slug: step.slug,
      state: {
        status: step.from.status,
        adapterType: step.from.adapterType,
        adapterConfig: cloneJson(step.from.adapterConfig),
        runtimeConfig: cloneJson(step.from.runtimeConfig),
      },
    })),
  };
  if (jarvisInstructions) {
    payload.jarvisInstructions = {
      agentId: jarvisInstructions.agentId,
      path: jarvisInstructions.path,
      content: jarvisInstructions.content,
      sha256: jarvisInstructions.sha256,
    };
  }
  return payload;
}

function validateRollbackBackupPayload(payload, liveSnapshot, { expectedCompanyId, expectedSlugs }) {
  const errors = [];
  if (payload?.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    errors.push(`backup schemaVersion must equal ${BACKUP_SCHEMA_VERSION}`);
  }
  if (payload?.kind !== "jarvis-provider-profile-backup") {
    errors.push("backup kind mismatch");
  }
  if (payload?.companyId !== expectedCompanyId) {
    errors.push(`backup companyId must equal requested company ${expectedCompanyId}`);
  }
  if (!Array.isArray(payload?.agents) || payload.agents.length === 0) {
    errors.push("backup agents must be a non-empty array");
  }
  const expectedSet = new Set(expectedSlugs);
  if ((payload?.agents?.length ?? 0) !== expectedSlugs.length) {
    errors.push(`backup must contain exactly ${expectedSlugs.length} agents`);
  }
  const liveById = new Map((liveSnapshot.agents ?? []).map((agent) => [agent.id, agent]));
  const seenBySlug = new Set();
  for (const row of payload.agents ?? []) {
    if (seenBySlug.has(row.slug)) errors.push(`backup duplicate slug ${row.slug}`);
    seenBySlug.add(row.slug);
    if (!expectedSet.has(row.slug)) errors.push(`backup unexpected slug ${row.slug}`);
    const live = liveById.get(row.agentId);
    if (!live) errors.push(`backup agentId not present live: ${row.agentId}`);
    if (live && live.slug !== row.slug) {
      errors.push(`backup slug mismatch for agentId ${row.agentId}: expected ${live.slug}, got ${row.slug}`);
    }
    if (!row.state || typeof row.state !== "object") {
      errors.push(`backup state missing for ${row.slug}`);
      continue;
    }
    if (typeof row.state.adapterType !== "string" || !row.state.adapterType) {
      errors.push(`backup adapterType missing for ${row.slug}`);
    }
    if (asRecord(row.state.adapterConfig) == null) {
      errors.push(`backup adapterConfig must be object for ${row.slug}`);
    }
    if (asRecord(row.state.runtimeConfig) == null) {
      errors.push(`backup runtimeConfig must be object for ${row.slug}`);
    }
  }
  for (const slug of expectedSlugs) {
    if (!seenBySlug.has(slug)) errors.push(`backup missing slug ${slug}`);
  }
  if (payload?.profileName === "openai-first") {
    const jarvisInstructions = asRecord(payload?.jarvisInstructions);
    const jarvisRow = (payload?.agents ?? []).find((row) => row?.slug === JARVIS_SLUG);
    if (!jarvisInstructions) {
      errors.push("backup Jarvis instructions missing");
    } else {
      if (jarvisInstructions.agentId !== jarvisRow?.agentId) {
        errors.push("backup Jarvis instructions agentId mismatch");
      }
      if (
        jarvisInstructions.path !== JARVIS_CODEX_AGENTS_FILE
        && jarvisInstructions.path !== JARVIS_CODEX_FULL_AGENTS_FILE
      ) {
        errors.push(
          `backup Jarvis instructions path mismatch (expected ${JARVIS_CODEX_AGENTS_FILE} or legacy ${JARVIS_CODEX_FULL_AGENTS_FILE})`,
        );
      }
      if (typeof jarvisInstructions.content !== "string") {
        errors.push("backup Jarvis instruction content must be a string");
      } else if (
        typeof jarvisInstructions.sha256 !== "string"
        || sha256(jarvisInstructions.content) !== jarvisInstructions.sha256
      ) {
        errors.push("backup Jarvis instruction hash mismatch");
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

export async function previewProviderProfileSwitch({
  desiredDir,
  liveSnapshot,
  profileName,
  runtimeEnv = process.env,
}) {
  // Offline preview only: allow redacted secretId markers so standard snapshots
  // deep-compare cleanly. Never used for apply/PATCH construction.
  const plan = planProviderProfileSwitch({
    desiredDir,
    liveSnapshot,
    profileName,
    runtimeEnv,
    allowRedactedSecretRefs: true,
  });
  const planErrors = plan.blockers ?? plan.issues ?? [plan.error ?? "unknown planning error"];
  return redactSecrets({
    mode: "preview",
    profileName,
    ok: plan.ok,
    failed: plan.ok ? [] : [{ step: "plan", error: planErrors.join("; ") }],
    planned: plan.planned.map((item) => ({
      slug: item.slug,
      agentId: item.agentId,
      from: {
        status: item.from.status,
        adapterType: item.from.adapterType,
        model: item.from.adapterConfig?.model ?? null,
      },
      to: {
        status: item.to.status,
        adapterType: item.to.adapterType,
        model: item.to.adapterConfig?.model ?? null,
      },
    })),
    summary: {
      affected: plan.allAffected?.length ?? 0,
      planned: plan.planned?.length ?? 0,
      writes: 0,
    },
  });
}

export async function applyProviderProfileSwitch({
  desiredDir,
  packageDir = PACKAGE_DIR,
  companyId,
  profileName,
  confirmProfile,
  backupGate = {},
  stateBackupFile = null,
  api = null,
  liveSnapshot = null,
  snapshotFn = snapshotFleet,
  runtimeEnv = process.env,
  allowEmptyInstructionsRepair = false,
}) {
  const report = {
    mode: "apply",
    profileName,
    startedAt: new Date().toISOString(),
    planned: [],
    completed: [],
    failed: [],
    rolledBack: [],
    writesSucceeded: 0,
    stateBackupFile,
  };

  if (confirmProfile !== profileName) {
    report.failed.push({
      step: "confirm-profile",
      error: `confirmation mismatch: pass --confirm-profile ${profileName}`,
    });
    return finishReport(report);
  }

  const gate = assertBackupGate(backupGate);
  if (!gate.ok) {
    report.failed.push({ step: "backup-gate", error: gate.detail });
    return finishReport(report);
  }

  if (!companyId) {
    report.failed.push({ step: "company-id", error: "--company-id is required for apply" });
    return finishReport(report);
  }

  const client = api
    ?? createApiClient({
      baseUrl: process.env.PAPERCLIP_API_URL,
      apiKey: process.env.PAPERCLIP_API_KEY,
      dryRun: false,
    });

  const fresh = liveSnapshot ?? await snapshotFn({
    companyId,
    internalCapture: true,
    allowEmptyInstructionsRepair: Boolean(allowEmptyInstructionsRepair),
  });
  if (allowEmptyInstructionsRepair) {
    let profilesDoc;
    try {
      profilesDoc = readProfilesFile(desiredDir);
    } catch (err) {
      report.failed.push({
        step: "empty-instruction-repair-scope",
        error: err instanceof Error ? err.message : String(err),
      });
      return finishReport(report);
    }
    const switchableSlugs = Array.isArray(profilesDoc?.switchableAgents)
      ? [...new Set(profilesDoc.switchableAgents.map((slug) => String(slug)))].sort()
      : [];
    const scope = assertProfileSwitchEmptyInstructionRepairScope({
      liveSnapshot: fresh,
      switchableSlugs,
      packageDir,
    });
    if (!scope.ok) {
      report.failed.push({
        step: "empty-instruction-repair-scope",
        error: scope.errors.join("; "),
      });
      return finishReport(report);
    }
  }
  const liveRuns = await fetchLiveRuns(client, companyId);
  if (!liveRuns.ok) {
    report.failed.push({ step: "live-runs", error: liveRuns.error });
    return finishReport(report);
  }
  if (liveRuns.runs.length > 0) {
    report.failed.push({
      step: "live-runs",
      error: `expected zero active runs, found ${liveRuns.runs.length}`,
    });
    return finishReport(report);
  }

  const plan = planProviderProfileSwitch({
    desiredDir,
    liveSnapshot: fresh,
    profileName,
    runtimeEnv,
    // Mutating path: refuse redacted secretId markers; require real UUIDs from internalCapture.
  });
  if (!plan.ok) {
    const planErrors = plan.blockers ?? plan.issues ?? [plan.error ?? "unknown planning error"];
    report.failed.push({ step: "plan", error: planErrors.join("; ") });
    return finishReport(report);
  }
  report.planned = plan.planned.map((item) => ({
    slug: item.slug,
    agentId: item.agentId,
    from: { adapterType: item.from.adapterType, model: item.from.adapterConfig?.model ?? null },
    to: { adapterType: item.to.adapterType, model: item.to.adapterConfig?.model ?? null },
  }));
  let openAiArtifact = null;
  let jarvisStep = null;
  let jarvisInstructionsBackup = null;
  if (profileName === "openai-first") {
    try {
      openAiArtifact = buildOpenAiJarvisArtifact({ desiredDir, runtimeEnv });
    } catch (err) {
      report.failed.push({
        step: "openai-instructions-freshness",
        error: err instanceof Error ? err.message : String(err),
      });
      return finishReport(report);
    }
    jarvisStep = plan.allAffected.find((step) => step.slug === JARVIS_SLUG);
    if (!jarvisStep) {
      report.failed.push({
        step: "jarvis-instructions-backup",
        error: "missing jarvis from profile switch plan",
      });
      return finishReport(report);
    }
    jarvisInstructionsBackup = await captureJarvisInstructionsBackup(client, jarvisStep);
    if (!jarvisInstructionsBackup.ok) {
      report.failed.push({
        step: "jarvis-instructions-backup",
        slug: jarvisStep.slug,
        agentId: jarvisStep.agentId,
        error: jarvisInstructionsBackup.error,
      });
      return finishReport(report);
    }
    jarvisStep.instructionsBackup = jarvisInstructionsBackup;
  }
  if (plan.planned.length === 0 && profileName !== "openai-first") {
    return finishReport(report);
  }

  const backupPayload = buildStateBackupPayload({
    companyId,
    profileName,
    allAffected: plan.allAffected,
    snapshotCapturedAt: fresh.capturedAt ?? null,
    jarvisInstructions: jarvisInstructionsBackup,
  });
  try {
    writeSwitchBackupFile({ backupPath: stateBackupFile, payload: backupPayload });
  } catch (err) {
    report.failed.push({
      step: "state-backup-write",
      error: err instanceof Error ? err.message : String(err),
    });
    return finishReport(report);
  }

  const rollbackOrder = [];
  const rollbackBySlug = new Map();
  const pushRollback = (step) => {
    if (!step || rollbackBySlug.has(step.slug)) return;
    rollbackBySlug.set(step.slug, step);
    rollbackOrder.push(step.slug);
  };

  if (profileName === "openai-first") {
    const sync = await ensureJarvisCodexBundle({
      client,
      jarvisStep,
      artifactContent: openAiArtifact.content,
    });
    if (!sync.ok) {
      if (sync.writeAttempted) {
        report.writesSucceeded += 1;
        pushRollback(jarvisStep);
      }
      report.failed.push({
        step: "jarvis-codex-upload",
        slug: jarvisStep.slug,
        agentId: jarvisStep.agentId,
        error: sync.error,
      });
    } else {
      if (sync.changed) {
        report.writesSucceeded += 1;
        pushRollback(jarvisStep);
      }
      report.completed.push({
        step: "jarvis-codex-upload",
        slug: jarvisStep.slug,
        agentId: jarvisStep.agentId,
        action: sync.action,
        status: sync.status,
        hashPrefix: sync.hashPrefix,
        sourceHashPrefix: openAiArtifact.sourceSha256.slice(0, 12),
      });
    }
    if (report.failed.length > 0) {
      for (const slug of [...rollbackOrder].reverse()) {
        const step = rollbackBySlug.get(slug);
        try {
          await rollbackStep({ client, step, report });
        } catch (err) {
          report.failed.push({
            step: "auto-rollback",
            slug: step.slug,
            agentId: step.agentId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return finishReport(report);
    }
  }

  const changedSteps = [];
  for (const step of plan.planned) {
    try {
      const res = await client.patch(`/api/agents/${step.agentId}`, step.patch);
      if (!res.ok) throw new Error(`${step.slug}: PATCH failed HTTP ${res.status}`);
      report.writesSucceeded += 1;
      changedSteps.push(step);
      pushRollback(step);
      const verified = await verifyPatchedAgent(client, step);
      if (!verified.ok) throw new Error(verified.error);
      report.completed.push({
        slug: step.slug,
        agentId: step.agentId,
        result: "applied",
      });
    } catch (err) {
      report.failed.push({
        step: "patch",
        slug: step.slug,
        agentId: step.agentId,
        error: err instanceof Error ? err.message : String(err),
      });
      break;
    }
  }

  if (report.failed.length > 0 && rollbackOrder.length > 0) {
    for (const slug of [...rollbackOrder].reverse()) {
      const step = rollbackBySlug.get(slug);
      try {
        await rollbackStep({ client, step, report });
      } catch (err) {
        report.failed.push({
          step: "auto-rollback",
          slug: step.slug,
          agentId: step.agentId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return finishReport(report);
}

export async function rollbackProviderProfileSwitch({
  companyId,
  backupFile,
  backupGate = {},
  api = null,
  liveSnapshot = null,
  snapshotFn = snapshotFleet,
}) {
  const report = {
    mode: "rollback",
    startedAt: new Date().toISOString(),
    completed: [],
    planned: [],
    failed: [],
    rolledBack: [],
    writesSucceeded: 0,
  };

  if (!companyId) {
    report.failed.push({ step: "company-id", error: "--company-id is required for rollback" });
    return finishReport(report);
  }
  if (!backupFile || !existsSync(backupFile)) {
    report.failed.push({ step: "backup-file", error: "existing --rollback-file is required" });
    return finishReport(report);
  }
  const gate = assertBackupGate(backupGate);
  if (!gate.ok) {
    report.failed.push({ step: "backup-gate", error: gate.detail });
    return finishReport(report);
  }

  const payload = JSON.parse(readFileSync(backupFile, "utf8"));
  const client = api
    ?? createApiClient({
      baseUrl: process.env.PAPERCLIP_API_URL,
      apiKey: process.env.PAPERCLIP_API_KEY,
      dryRun: false,
    });
  const fresh = liveSnapshot ?? await snapshotFn({ companyId, internalCapture: true });
  const backupValidation = validateRollbackBackupPayload(payload, fresh, {
    expectedCompanyId: companyId,
    expectedSlugs: EXPECTED_SWITCHABLE_SLUGS,
  });
  if (!backupValidation.ok) {
    report.failed.push({ step: "backup-validate", error: backupValidation.errors.join("; ") });
    return finishReport(report);
  }
  const liveRuns = await fetchLiveRuns(client, companyId);
  if (!liveRuns.ok) {
    report.failed.push({ step: "live-runs", error: liveRuns.error });
    return finishReport(report);
  }
  if (liveRuns.runs.length > 0) {
    report.failed.push({
      step: "live-runs",
      error: `expected zero active runs, found ${liveRuns.runs.length}`,
    });
    return finishReport(report);
  }

  report.planned = payload.agents.map((row) => ({
    slug: row.slug,
    agentId: row.agentId,
    adapterType: row.state.adapterType,
    model: row.state.adapterConfig?.model ?? null,
  }));

  for (const row of payload.agents) {
    const body = {
      status: "paused",
      adapterType: row.state.adapterType,
      adapterConfig: row.state.adapterConfig,
      runtimeConfig: row.state.runtimeConfig,
      replaceAdapterConfig: true,
    };
    try {
      let instructionsHashPrefix = null;
      if (row.slug === JARVIS_SLUG && payload.profileName === "openai-first") {
        const instructionsRestore = await restoreJarvisInstructionsBackup(
          client,
          payload.jarvisInstructions,
        );
        if (instructionsRestore.writeAttempted) report.writesSucceeded += 1;
        if (!instructionsRestore.ok) throw new Error(instructionsRestore.error);
        instructionsHashPrefix = instructionsRestore.hashPrefix;
      }
      const res = await client.patch(`/api/agents/${row.agentId}`, body);
      if (!res.ok) throw new Error(`${row.slug}: rollback PATCH failed HTTP ${res.status}`);
      report.writesSucceeded += 1;
      const verify = await client.get(`/api/agents/${row.agentId}`);
      if (!verify.ok) throw new Error(`${row.slug}: rollback verify GET failed HTTP ${verify.status}`);
      const live = verify.data ?? {};
      if (live.status !== "paused") throw new Error(`${row.slug}: rollback status mismatch`);
      if (live.adapterType !== row.state.adapterType) {
        throw new Error(`${row.slug}: rollback adapterType mismatch`);
      }
      if (!deepEqual(asRecord(live.adapterConfig) ?? {}, row.state.adapterConfig)) {
        throw new Error(`${row.slug}: rollback adapterConfig mismatch`);
      }
      if (!deepEqual(asRecord(live.runtimeConfig) ?? {}, row.state.runtimeConfig)) {
        throw new Error(`${row.slug}: rollback runtimeConfig mismatch`);
      }
      report.completed.push({
        slug: row.slug,
        agentId: row.agentId,
        result: "restored-paused",
        ...(instructionsHashPrefix ? { instructionsHashPrefix } : {}),
      });
      report.rolledBack.push({ slug: row.slug, agentId: row.agentId });
    } catch (err) {
      report.failed.push({
        step: "rollback",
        slug: row.slug,
        agentId: row.agentId,
        error: err instanceof Error ? err.message : String(err),
      });
      break;
    }
  }

  return finishReport(report);
}
