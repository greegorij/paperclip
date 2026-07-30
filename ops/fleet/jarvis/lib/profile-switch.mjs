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
import { generateCodexJarvisInstructions } from "./codex-jarvis-instructions.mjs";
import { loadDesired, redactSecrets } from "./load.mjs";
import { snapshotFleet } from "./snapshot.mjs";

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
const REQUIRED_PROFILES = Object.freeze(["openai-first", "anthropic-first"]);
const PATCH_TIMEOUT_SEC = 1200;
const PATCH_INACTIVITY_TIMEOUT_MS = 600000;
const PATCH_GRACE_SEC = 15;
const BACKUP_SCHEMA_VERSION = 1;
const EXPECTED_SWITCHABLE_COUNT = 22;
const ANTHROPIC_WORKER_CONFIG_ENV = "JARVIS_CLAUDE_WORKER_CONFIG_DIR";
const ANTHROPIC_BOSS_CONFIG_ENV = "JARVIS_CLAUDE_BOSS_CONFIG_DIR";
const BOSS_INSTRUCTIONS_SOURCE_ENV = "JARVIS_CLAUDE_BOSS_INSTRUCTIONS_FILE";
const JARVIS_SLUG = "jarvis";
const JARVIS_CODEX_AGENTS_FILE = "AGENTS-CODEX.md";
const JARVIS_ANTHROPIC_AGENTS_FILE = "AGENTS.md";
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

const OPENAI_EXPECTED = Object.freeze({
  jarvis: { model: "gpt-5.6-sol", modelReasoningEffort: "high" },
  "szef-komercyjny": { model: "gpt-5.6-sol", modelReasoningEffort: "high" },
  "senior-programista": { model: "gpt-5.6-sol", modelReasoningEffort: "high" },
  krytyk: { model: "gpt-5.6-sol", modelReasoningEffort: "high" },
  "analityk-biznesowy": { model: "gpt-5.6-sol", modelReasoningEffort: "medium" },
  badacz: { model: "gpt-5.6-sol", modelReasoningEffort: "medium" },
  "designer-ui": { model: "gpt-5.6-sol", modelReasoningEffort: "medium" },
  "konfigurator-systemu": { model: "gpt-5.6-sol", modelReasoningEffort: "medium" },
  "modelarz-procesow": { model: "gpt-5.6-sol", modelReasoningEffort: "medium" },
  "specjalista-deck-w": { model: "gpt-5.6-sol", modelReasoningEffort: "medium" },
  "specjalista-komunikacji-klienckiej": { model: "gpt-5.6-sol", modelReasoningEffort: "medium" },
  "specjalista-ofert": { model: "gpt-5.6-sol", modelReasoningEffort: "medium" },
  "czytacz-transkryptow": { model: "gpt-5.6-luna", modelReasoningEffort: "medium" },
  "in-ynier-wdro-e": { model: "gpt-5.6-luna", modelReasoningEffort: "medium" },
  "kurator-crm": { model: "gpt-5.6-luna", modelReasoningEffort: "medium" },
  "kurator-vaultu": { model: "gpt-5.6-luna", modelReasoningEffort: "medium" },
  "obserwator-upstream": { model: "gpt-5.6-luna", modelReasoningEffort: "medium" },
  "reflection-coach": { model: "gpt-5.6-luna", modelReasoningEffort: "medium" },
  "zwiadowca-vaultu": { model: "gpt-5.6-luna", modelReasoningEffort: "medium" },
  kronikarz: { model: "gpt-5.6-luna", modelReasoningEffort: "low" },
  "mi-sie-vault": { model: "gpt-5.6-luna", modelReasoningEffort: "low" },
  summarizer: { model: "gpt-5.6-luna", modelReasoningEffort: "low" },
});

const ANTHROPIC_EXPECTED_MODELS = Object.freeze({
  jarvis: "claude-opus-5",
  "szef-komercyjny": "claude-opus-5",
  kronikarz: "claude-haiku-4-5",
  "mi-sie-vault": "claude-haiku-4-5",
  summarizer: "claude-haiku-4-5",
  "analityk-biznesowy": "claude-sonnet-5",
  badacz: "claude-sonnet-5",
  "czytacz-transkryptow": "claude-sonnet-5",
  "designer-ui": "claude-sonnet-5",
  "in-ynier-wdro-e": "claude-sonnet-5",
  "konfigurator-systemu": "claude-sonnet-5",
  krytyk: "claude-sonnet-5",
  "kurator-crm": "claude-sonnet-5",
  "kurator-vaultu": "claude-sonnet-5",
  "modelarz-procesow": "claude-sonnet-5",
  "obserwator-upstream": "claude-sonnet-5",
  "senior-programista": "claude-sonnet-5",
  "specjalista-deck-w": "claude-sonnet-5",
  "specjalista-komunikacji-klienckiej": "claude-sonnet-5",
  "specjalista-ofert": "claude-sonnet-5",
  "zwiadowca-vaultu": "claude-sonnet-5",
  "reflection-coach": "claude-sonnet-5",
});
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
const EXPECTED_SWITCHABLE_SLUGS = Object.freeze(Object.keys(OPENAI_EXPECTED).sort());

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
  const codexPath = resolveJarvisPath(desiredDir, JARVIS_CODEX_ARTIFACT_RELATIVE);
  if (!existsSync(cockpitPath)) {
    throw new Error(`cockpit AGENTS.md not found: ${cockpitPath}`);
  }
  if (!existsSync(codexPath)) {
    throw new Error(`committed AGENTS-CODEX.md not found: ${codexPath}`);
  }
  const source = readFileSync(sourcePath, "utf8");
  const cockpit = readFileSync(cockpitPath, "utf8");
  const committed = readFileSync(codexPath, "utf8");
  const generated = generateCodexJarvisInstructions({
    headlessBossClaude: source,
    cockpitAgentsMd: cockpit,
  });
  if (generated.content !== committed) {
    throw new Error(
      `AGENTS-CODEX.md mismatch (generated=${hashPrefix(generated.content)} committed=${hashPrefix(committed)})`,
    );
  }
  return {
    sourcePath,
    sourceSha256: generated.sourceSha256,
    cockpitSha256: generated.cockpitSha256,
    content: committed,
    contentHashPrefix: hashPrefix(committed),
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

export function validateProviderProfilesDocument({ desired, profilesDoc }) {
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

  for (const profileName of REQUIRED_PROFILES) {
    if (!profilesDoc?.profiles?.[profileName]) {
      errors.push(`profiles.json: missing profile ${profileName}`);
      continue;
    }
    const profile = profilesDoc.profiles[profileName];
    if (typeof profile.version !== "string" || profile.version.trim() === "") {
      errors.push(`profiles.json ${profileName}: version is required`);
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

  const openAiBySlug = new Map(
    (profilesDoc?.profiles?.["openai-first"]?.agents ?? []).map((item) => [item.slug, item]),
  );
  for (const [slug, expected] of Object.entries(OPENAI_EXPECTED)) {
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
    if (got.model !== expected.model) {
      errors.push(`openai-first ${slug}: model must be ${expected.model}`);
    }
    if (got.modelReasoningEffort !== expected.modelReasoningEffort) {
      errors.push(
        `openai-first ${slug}: modelReasoningEffort must be ${expected.modelReasoningEffort}`,
      );
    }
    if (!["ro", "rw"].includes(got.filesystemWorkspaceAccess)) {
      errors.push(`openai-first ${slug}: filesystemWorkspaceAccess must be ro or rw`);
    }
    if (!Number.isInteger(got.maxDailyRuns) || got.maxDailyRuns < 1) {
      errors.push(`openai-first ${slug}: maxDailyRuns must be integer >= 1`);
    }
  }

  const anthropicBySlug = new Map(
    (profilesDoc?.profiles?.["anthropic-first"]?.agents ?? []).map((item) => [item.slug, item]),
  );
  for (const [slug, expectedModel] of Object.entries(ANTHROPIC_EXPECTED_MODELS)) {
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
    if (got.model !== expectedModel) {
      errors.push(`anthropic-first ${slug}: model must be ${expectedModel}`);
    }
    if (!Number.isInteger(got.maxDailyRuns) || got.maxDailyRuns < 1) {
      errors.push(`anthropic-first ${slug}: maxDailyRuns must be integer >= 1`);
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

function preserveManagedAdapterConfigFields(liveAdapterConfig) {
  const out = {};
  const live = asRecord(liveAdapterConfig) ?? {};
  for (const key of PRESERVED_ADAPTER_CONFIG_KEYS) {
    if (live[key] !== undefined) out[key] = cloneJson(live[key]);
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

function buildTargetAdapterConfig(profileName, profileEntry, liveAgent, { runtimeEnv = process.env } = {}) {
  const preserved = withJarvisInstructionsPath({
    profileName,
    slug: profileEntry.slug,
    preserved: preserveManagedAdapterConfigFields(liveAgent.adapterConfig),
  });
  if (profileName === "openai-first") {
    return {
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
  }
  const configEnvName = profileEntry.claudeConfigProfile === "boss"
    ? ANTHROPIC_BOSS_CONFIG_ENV
    : ANTHROPIC_WORKER_CONFIG_ENV;
  const configDir = runtimeEnv?.[configEnvName];
  return {
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
      CLAUDE_CONFIG_DIR: {
        type: "plain",
        value: configDir,
      },
    },
  };
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

function normalizeExpectedState(profileName, profileEntry, liveAgent, { runtimeEnv = process.env } = {}) {
  return {
    status: "paused",
    adapterType: profileEntry.adapterType,
    adapterConfig: buildTargetAdapterConfig(profileName, profileEntry, liveAgent, { runtimeEnv }),
    runtimeConfig: buildTargetRuntimeConfig(liveAgent, profileEntry),
  };
}

function getLiveAgentBySlug(liveSnapshot) {
  return new Map((liveSnapshot.agents ?? []).map((agent) => [agent.slug, agent]));
}

function canonicalLiveModel(agent) {
  return agent?.adapterConfig?.model ?? agent?.model ?? null;
}

function extractProfileBySlug(profilesDoc, profileName) {
  return new Map(
    (profilesDoc.profiles?.[profileName]?.agents ?? []).map((entry) => [entry.slug, entry]),
  );
}

export function detectProviderProfileState({ profilesDoc, liveSnapshot }) {
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
    const liveAdapterType = live.adapterType ?? null;
    const liveModel = canonicalLiveModel(live);
    const matchedProfiles = [];
    for (const profileName of declaredProfileNames) {
      const entry = profileByName.get(profileName)?.get(slug);
      if (!entry) continue;
      if ((entry.adapterType ?? null) === liveAdapterType && (entry.model ?? null) === liveModel) {
        matchedProfiles.push(profileName);
      }
    }
    if (matchedProfiles.length === 0) {
      issues.push({
        code: "unknown",
        slug,
        detail: `${slug} state adapterType=${liveAdapterType} model=${liveModel} does not match any declared profile`,
        live: { adapterType: liveAdapterType, model: liveModel },
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
}) {
  const desired = loadDesired(desiredDir);
  const profilesDoc = readProfilesFile(desiredDir);
  const schemaValidation = validateProviderProfilesDocument({ desired, profilesDoc });
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
    const expectedState = normalizeExpectedState(profileName, profileEntry, live, { runtimeEnv });
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
  const liveSkills = Array.isArray(live.desiredSkills) ? live.desiredSkills : [];
  if (!deepEqual(liveSkills, expectedStep.from.desiredSkills)) {
    return { ok: false, error: `${expectedStep.slug}: desiredSkills drift during profile patch` };
  }
  return { ok: true };
}

async function verifyRestoredAgent(client, step) {
  const res = await client.get(`/api/agents/${step.agentId}`);
  if (!res.ok) return { ok: false, error: `restore verify GET failed HTTP ${res.status}` };
  const live = res.data ?? {};
  if (live.status !== step.from.status) {
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
  const restoreBody = {
    status: step.from.status,
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

function buildStateBackupPayload({ companyId, profileName, allAffected, snapshotCapturedAt }) {
  return {
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
  return { ok: errors.length === 0, errors };
}

export async function previewProviderProfileSwitch({
  desiredDir,
  liveSnapshot,
  profileName,
  runtimeEnv = process.env,
}) {
  const plan = planProviderProfileSwitch({ desiredDir, liveSnapshot, profileName, runtimeEnv });
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
  companyId,
  profileName,
  confirmProfile,
  backupGate = {},
  stateBackupFile = null,
  api = null,
  liveSnapshot = null,
  snapshotFn = snapshotFleet,
  runtimeEnv = process.env,
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

  const fresh = liveSnapshot ?? await snapshotFn({ companyId, internalCapture: true });
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
  }
  if (plan.planned.length === 0 && profileName !== "openai-first") {
    return finishReport(report);
  }

  const backupPayload = buildStateBackupPayload({
    companyId,
    profileName,
    allAffected: plan.allAffected,
    snapshotCapturedAt: fresh.capturedAt ?? null,
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
    const jarvisStep = plan.allAffected.find((step) => step.slug === JARVIS_SLUG);
    if (!jarvisStep) {
      report.failed.push({
        step: "jarvis-codex-upload",
        error: "missing jarvis from profile switch plan",
      });
      return finishReport(report);
    }
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
      status: row.state.status,
      adapterType: row.state.adapterType,
      adapterConfig: row.state.adapterConfig,
      runtimeConfig: row.state.runtimeConfig,
      replaceAdapterConfig: true,
    };
    try {
      const res = await client.patch(`/api/agents/${row.agentId}`, body);
      if (!res.ok) throw new Error(`${row.slug}: rollback PATCH failed HTTP ${res.status}`);
      report.writesSucceeded += 1;
      const verify = await client.get(`/api/agents/${row.agentId}`);
      if (!verify.ok) throw new Error(`${row.slug}: rollback verify GET failed HTTP ${verify.status}`);
      const live = verify.data ?? {};
      if (live.status !== row.state.status) throw new Error(`${row.slug}: rollback status mismatch`);
      if (live.adapterType !== row.state.adapterType) {
        throw new Error(`${row.slug}: rollback adapterType mismatch`);
      }
      if (!deepEqual(asRecord(live.adapterConfig) ?? {}, row.state.adapterConfig)) {
        throw new Error(`${row.slug}: rollback adapterConfig mismatch`);
      }
      if (!deepEqual(asRecord(live.runtimeConfig) ?? {}, row.state.runtimeConfig)) {
        throw new Error(`${row.slug}: rollback runtimeConfig mismatch`);
      }
      report.completed.push({ slug: row.slug, agentId: row.agentId, result: "restored" });
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
