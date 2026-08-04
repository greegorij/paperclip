import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  existsSync,
  cpSync,
} from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";

import { PACKAGE_DIR, DESIRED_DIR, FIXTURES_DIR, FLEET_ROOT } from "../lib/paths.mjs";
import { loadDesired, loadPackage, redactSecrets, SECRET_REDACTION_MARKER } from "../lib/load.mjs";
import { validateFleet } from "../lib/validate.mjs";
import { validateSkillRuntime } from "../lib/skill-state.mjs";
import { checkAllContradictions } from "../lib/contradictions.mjs";
import { diffFleet, matchRoutineStrict } from "../lib/diff.mjs";
import { applyFleet, validateApplyChanges } from "../lib/apply.mjs";
import { assertBackupGate } from "../lib/backup-gate.mjs";
import { verifyFleet } from "../lib/verify.mjs";
import { verifyAgentSkills } from "../lib/write-verify.mjs";
import { resolveFullSkillKeys, resolveBootstrapSkillKey } from "../lib/skill-keys.mjs";
import { snapshotFleet } from "../lib/snapshot.mjs";
import {
  planSummarizerInstructionPatch,
  applySummarizerInstructionPatch,
  SUMMARIZER_CHEAP_CLAIM_RE,
} from "../lib/summarizer-patch.mjs";
import { summarizeExportWarnings } from "../lib/sanitize.mjs";
import { planProviderProfileSwitch } from "../lib/profile-switch.mjs";

const broken = JSON.parse(
  readFileSync(path.join(FIXTURES_DIR, "broken-instructions.json"), "utf8"),
);
const REQUIRED_POLICY_EXTRA_ARGS = ["--sandbox", "danger-full-access", "--skip-git-repo-check"];
const OPENAI_SAFE_ALLOWLIST = ["chatgpt.com", "api.openai.com", "auth.openai.com"];
const OPENAI_SAFE_ALLOWLIST_WITH_GITHUB = [
  ...OPENAI_SAFE_ALLOWLIST,
  "github.com",
  "api.github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
];
const SWITCHABLE_PROFILE_SLUGS = new Set(
  (loadDesired(DESIRED_DIR).profiles?.switchableAgents ?? []).map(String),
);
const ANTHROPIC_RUNTIME_ENV = {
  ...process.env,
  ...(() => {
    const rootDir = mkdtempSync(path.join(os.tmpdir(), "jarvis-claude-config-"));
    const workerDir = path.join(rootDir, "worker");
    const bossDir = path.join(rootDir, "boss");
    mkdirSync(workerDir);
    mkdirSync(bossDir);
    return {
      JARVIS_CLAUDE_WORKER_CONFIG_DIR: workerDir,
      JARVIS_CLAUDE_BOSS_CONFIG_DIR: bossDir,
    };
  })(),
};

function canonicalModel(agent) {
  return agent?.adapterConfig?.model ?? agent?.model ?? null;
}

function ensureJarvisManagedInstructions(snapshot) {
  const jarvis = snapshot.agents?.find((agent) => agent.slug === "jarvis");
  if (!jarvis) return snapshot;
  const instructionsRootPath = path.join(os.tmpdir(), "jarvis-managed-instructions");
  jarvis.adapterConfig = {
    ...(jarvis.adapterConfig ?? {}),
    instructionsBundleMode: "managed",
    instructionsRootPath,
    instructionsEntryFile: "AGENTS.md",
    instructionsFilePath: path.join(instructionsRootPath, "AGENTS.md"),
  };
  return snapshot;
}

function applyManagedOpenAiRoleFit(snapshot) {
  ensureJarvisManagedInstructions(snapshot);
  const bySlug = new Map((snapshot.agents ?? []).map((agent) => [agent.slug, agent]));
  const specs = {
    "zwiadowca-kodu": {
      model: "gpt-5.6-terra",
      effort: "medium",
      workspaceAccess: "ro",
      networkAllowlist: OPENAI_SAFE_ALLOWLIST,
      maxDailyRuns: 3,
      maxConcurrentRuns: 1,
    },
    "mi-sie-kodu-codex": {
      model: "gpt-5.6-sol",
      effort: "high",
      workspaceAccess: "rw",
      networkAllowlist: OPENAI_SAFE_ALLOWLIST_WITH_GITHUB,
      maxDailyRuns: 1,
      maxConcurrentRuns: 1,
    },
    "mi-sie-kodu-codex-szybki": {
      model: "codex-mini-latest",
      effort: "low",
      workspaceAccess: "rw",
      networkAllowlist: OPENAI_SAFE_ALLOWLIST_WITH_GITHUB,
      maxDailyRuns: 8,
      maxConcurrentRuns: 2,
      fastMode: true,
      timeoutSec: 900,
      outputInactivityTimeoutMs: 360000,
    },
  };
  for (const [slug, spec] of Object.entries(specs)) {
    const agent = bySlug.get(slug);
    assert.ok(agent, `fixture must include ${slug}`);
    agent.status = "paused";
    agent.maxConcurrentRuns = spec.maxConcurrentRuns ?? 1;
    agent.adapterType = "codex_local";
    agent.model = spec.model;
    agent.heartbeat = {
      enabled: false,
      wakeOnDemand: true,
      maxDailyRuns: spec.maxDailyRuns,
    };
    agent.adapterConfig = {
      ...(agent.adapterConfig ?? {}),
      engine: "cli",
      model: spec.model,
      modelReasoningEffort: spec.effort,
      fastMode: spec.fastMode ?? false,
      search: false,
      dangerouslyBypassApprovalsAndSandbox: false,
      filesystemScope: "workspace",
      filesystemWorkspaceAccess: spec.workspaceAccess,
      networkScope: "allowlist",
      networkAllowlist: [...spec.networkAllowlist],
      extraArgs: [...REQUIRED_POLICY_EXTRA_ARGS],
      ...(spec.timeoutSec != null ? { timeoutSec: spec.timeoutSec } : {}),
      ...(spec.outputInactivityTimeoutMs != null
        ? { outputInactivityTimeoutMs: spec.outputInactivityTimeoutMs }
        : {}),
    };
  }
  return snapshot;
}

function buildLiveSnapshotForProfile(profileName, runtimeEnv, sourceSnapshot = liveAligned) {
  const snapshot = structuredClone(sourceSnapshot);
  ensureJarvisManagedInstructions(snapshot);
  for (const agent of snapshot.agents ?? []) {
    if (SWITCHABLE_PROFILE_SLUGS.has(agent.slug)) {
      agent.status = "paused";
    }
  }
  const plan = planProviderProfileSwitch({
    desiredDir: DESIRED_DIR,
    liveSnapshot: snapshot,
    profileName,
    runtimeEnv,
  });
  assert.equal(plan.ok, true, JSON.stringify(plan.blockers ?? plan.issues ?? [], null, 2));
  for (const step of plan.allAffected ?? []) {
    const live = snapshot.agents.find((agent) => agent.id === step.agentId);
    assert.ok(live, `missing live agent for ${step.slug}`);
    live.status = step.to.status;
    live.adapterType = step.to.adapterType;
    live.adapterConfig = structuredClone(step.to.adapterConfig);
    live.runtimeConfig = structuredClone(step.to.runtimeConfig);
    live.model = canonicalModel(live);
  }
  for (const builtIn of snapshot.builtIns ?? []) {
    const live = snapshot.agents.find((agent) => agent.id === builtIn.agentId);
    if (!live) continue;
    builtIn.model = canonicalModel(live);
  }
  return snapshot;
}

function isProfileOwnedModelChange(change) {
  if (change.kind !== "agent-model" && change.kind !== "builtin-model") return false;
  return SWITCHABLE_PROFILE_SLUGS.has(String(change.target));
}

const liveAligned = buildLiveSnapshotForProfile(
  "anthropic-first",
  ANTHROPIC_RUNTIME_ENV,
  applyManagedOpenAiRoleFit(
    JSON.parse(readFileSync(path.join(FIXTURES_DIR, "live-aligned.json"), "utf8")),
  ),
);
const liveDrift = buildLiveSnapshotForProfile(
  "anthropic-first",
  ANTHROPIC_RUNTIME_ENV,
  applyManagedOpenAiRoleFit(
    JSON.parse(readFileSync(path.join(FIXTURES_DIR, "live-drift.json"), "utf8")),
  ),
);
function buildApplySnapshotWithNonProfileModelDrift({
  includeSecondModelDrift = false,
} = {}) {
  const snap = buildLiveSnapshotForProfile("anthropic-first", ANTHROPIC_RUNTIME_ENV);
  const driftBySlug = new Map(snap.agents.map((agent) => [agent.slug, agent]));
  const web = driftBySlug.get("mi-sie-web");
  assert.ok(web, "drift fixture missing mi-sie-web");
  assert.equal(SWITCHABLE_PROFILE_SLUGS.has("mi-sie-web"), false);
  web.adapterConfig = {
    ...(web.adapterConfig ?? {}),
    model: "openrouter/openai/gpt-4o-mini",
  };
  web.model = "openrouter/openai/gpt-4o-mini";

  if (includeSecondModelDrift) {
    const reviewGlm = driftBySlug.get("mi-sie-recenzji-glm");
    assert.ok(reviewGlm, "drift fixture missing mi-sie-recenzji-glm");
    assert.equal(SWITCHABLE_PROFILE_SLUGS.has("mi-sie-recenzji-glm"), false);
    reviewGlm.adapterConfig = {
      ...(reviewGlm.adapterConfig ?? {}),
      model: "openrouter/openai/gpt-4o-mini",
    };
    reviewGlm.model = "openrouter/openai/gpt-4o-mini";
  }

  return snap;
}
const liveTitleMismatch = applyManagedOpenAiRoleFit(
  JSON.parse(readFileSync(path.join(FIXTURES_DIR, "live-routine-title-mismatch.json"), "utf8")),
);
const liveTriggerMismatch = applyManagedOpenAiRoleFit(
  JSON.parse(readFileSync(path.join(FIXTURES_DIR, "live-routine-trigger-mismatch.json"), "utf8")),
);
const skillOk = JSON.parse(
  readFileSync(path.join(FIXTURES_DIR, "skill-snapshots-ok.json"), "utf8"),
);
const skillBad = JSON.parse(
  readFileSync(path.join(FIXTURES_DIR, "skill-snapshots-bad.json"), "utf8"),
);
const summarizerOld = readFileSync(
  path.join(FIXTURES_DIR, "summarizer-old-agents.md"),
  "utf8",
);
const summarizerNew = readFileSync(
  path.join(FIXTURES_DIR, "summarizer-new-agents.md"),
  "utf8",
);

function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createLiveSnapshotFetchMock({
  companyId = "company-jarvis",
  detailFailureById = new Map(),
  instructionsFailureById = new Map(),
} = {}) {
  const desiredSkillStateForAdapter = (adapterType) => {
    if (adapterType === "opencode_local" || adapterType === "cursor") return "installed";
    if (adapterType === "claude_local" || adapterType === "codex_local") return "configured";
    return "configured";
  };

  const source = structuredClone(liveAligned);
  const secondSelectedAgentSlug = "jarvis";
  const list = source.agents.map((agent) => {
    const row = structuredClone(agent);
    delete row.runtimeConfig;
    delete row.heartbeat;
    if (row.slug === "recenzent" || row.slug === secondSelectedAgentSlug) row.maxConcurrentRuns = null;
    return row;
  });
  const detailsById = new Map(
    source.agents.map((agent) => {
      const detail = structuredClone(agent);
      delete detail.heartbeat;
      return [agent.id, detail];
    }),
  );
  const skillSnapshotsByAgentId = new Map(
    (source.skillSnapshots ?? []).map((snapshot) => [snapshot.agentId, structuredClone(snapshot)]),
  );
  const recenzent = source.agents.find((agent) => agent.slug === "recenzent");
  assert.ok(recenzent, "fixture must include recenzent");
  const recenzentDetail = detailsById.get(recenzent.id);
  recenzentDetail.maxConcurrentRuns = null;
  recenzentDetail.runtimeConfig = { heartbeat: { maxConcurrentRuns: 1 } };
  const secondSelectedAgent = source.agents.find((agent) => agent.slug === secondSelectedAgentSlug);
  assert.ok(secondSelectedAgent, `fixture must include ${secondSelectedAgentSlug}`);
  const secondSelectedAgentDetail = detailsById.get(secondSelectedAgent.id);
  secondSelectedAgentDetail.maxConcurrentRuns = null;
  secondSelectedAgentDetail.runtimeConfig = {
    ...(secondSelectedAgentDetail.runtimeConfig ?? {}),
    heartbeat: {
      ...(secondSelectedAgentDetail.runtimeConfig?.heartbeat ?? {}),
      maxConcurrentRuns: 1,
    },
  };
  const heartbeatRoleSlugs = ["zwiadowca-kodu", "mi-sie-kodu-codex", "mi-sie-kodu-codex-szybki"];
  for (const slug of heartbeatRoleSlugs) {
    const sourceAgent = source.agents.find((agent) => agent.slug === slug);
    assert.ok(sourceAgent, `fixture must include ${slug}`);
    const detail = detailsById.get(sourceAgent.id);
    detail.runtimeConfig = {
      heartbeat: {
        enabled: sourceAgent.heartbeat?.enabled ?? null,
        wakeOnDemand: sourceAgent.heartbeat?.wakeOnDemand ?? null,
        maxDailyRuns: sourceAgent.heartbeat?.maxDailyRuns ?? null,
        maxConcurrentRuns: sourceAgent.maxConcurrentRuns ?? null,
      },
    };
  }

  return async function fetchMock(url) {
    const parsed = new URL(url);
    const { pathname, searchParams } = parsed;

    if (pathname === `/api/companies/${companyId}/agents`) return jsonResponse(200, list);
    if (pathname === `/api/companies/${companyId}/routines`) return jsonResponse(200, source.routines);
    if (pathname === `/api/companies/${companyId}/skills`) {
      return jsonResponse(200, { skills: source.skillLibrary });
    }
    if (pathname === `/api/companies/${companyId}/built-in-agents`) return jsonResponse(404, { error: "off" });

    const detailMatch = pathname.match(/^\/api\/agents\/([^/]+)$/);
    if (detailMatch) {
      const agentId = detailMatch[1];
      const failedStatus = detailFailureById.get(agentId);
      if (failedStatus) return jsonResponse(failedStatus, { error: "detail failed" });
      return jsonResponse(200, detailsById.get(agentId));
    }

    const instructionsMatch = pathname.match(/^\/api\/agents\/([^/]+)\/instructions-bundle\/file$/);
    if (instructionsMatch) {
      if (searchParams.get("path") !== "AGENTS.md") return jsonResponse(404, { error: "path not found" });
      const agentId = instructionsMatch[1];
      const failedStatus = instructionsFailureById.get(agentId);
      if (failedStatus) return jsonResponse(failedStatus, { error: "instructions failed" });
      const agent = detailsById.get(agentId);
      return jsonResponse(200, { content: agent.instructions });
    }

    const skillsMatch = pathname.match(/^\/api\/agents\/([^/]+)\/skills$/);
    if (skillsMatch) {
      const agentId = skillsMatch[1];
      const agent = detailsById.get(agentId);
      if (!agent) {
        throw new Error(`mock route /api/agents/:id/skills missing agent for agentId=${agentId}`);
      }
      const skillSnapshot = skillSnapshotsByAgentId.get(agentId);
      if (!skillSnapshot) {
        throw new Error(`mock route /api/agents/:id/skills missing skillSnapshot for agentId=${agentId}`);
      }
      const desiredSkills = agent.desiredSkills ?? [];
      const desiredSet = new Set(desiredSkills);
      const desiredState = desiredSkillStateForAdapter(agent.adapterType);
      const entries = (skillSnapshot.entries ?? []).map((entry) => {
        const desired = desiredSet.has(entry.key);
        return {
          ...entry,
          desired,
          state: desired ? desiredState : "available",
        };
      });
      return jsonResponse(200, {
        desiredSkills,
        entries,
      });
    }

    return jsonResponse(404, { error: "unhandled mock route" });
  };
}

test("package contains 28 portable agents and excludes built-ins", () => {
  const pkg = loadPackage(PACKAGE_DIR);
  assert.equal(pkg.agents.length, 28);
  assert.equal(pkg.agentBySlug.summarizer, undefined);
  assert.equal(pkg.agentBySlug["reflection-coach"], undefined);
  assert.ok(pkg.agentBySlug["mi-sie-kodu-codex-szybki"]?.instructions?.trim().length > 0);
});

test("package does not vendor skills/local or skills/company", () => {
  assert.equal(existsSync(path.join(PACKAGE_DIR, "skills")), false);
});

test("desired uses JSON SSOT only — no YAML mirrors", () => {
  const files = readdirSync(DESIRED_DIR);
  assert.ok(files.every((f) => !f.endsWith(".yaml") && !f.endsWith(".yml")), files.join(","));
  assert.ok(files.includes("routines.json"));
});

test("versioned fleet tree has no /home/, /Users/, ~/, or token-like values", () => {
  const roots = [DESIRED_DIR, PACKAGE_DIR, path.join(FLEET_ROOT, "lib"), path.join(FLEET_ROOT, "bin")];
  // Explicit operator-host grants for Konfigurator browser capability (sandbox RO mounts + protocol).
  const hostPathAllowlist = new Set([
    path.join(DESIRED_DIR, "runtime-capabilities.json"),
    path.join(PACKAGE_DIR, "agents", "konfigurator-systemu", "AGENTS.md"),
  ]);
  const offenders = [];
  function walk(dir) {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, name.name);
      if (name.isDirectory()) walk(p);
      else if (/\.(json|md|ya?ml|mjs|txt)$/.test(name.name)) {
        const text = readFileSync(p, "utf8");
        if (/\/home\/|\/Users\/|~\//.test(text) && !hostPathAllowlist.has(p)) {
          offenders.push(`${p}: host path`);
        }
        if (/sk-[A-Za-z0-9]{10,}|pcp_[A-Za-z0-9]+|ghp_[A-Za-z0-9]+/.test(text)) {
          offenders.push(`${p}: token-like`);
        }
      }
    }
  }
  for (const r of roots) walk(r);
  assert.deepEqual(offenders, []);
});

test("export warnings are anonymized categories without host paths", () => {
  const desired = loadDesired(DESIRED_DIR);
  assert.ok(desired.agents.meta.exportWarnings);
  assert.equal(desired.agents.meta.warnings, undefined);
  const summarized = summarizeExportWarnings([
    "Skipped 2 built-in managed agents from export.",
    "Agent x env CLAUDE_CONFIG_DIR default was exported as system-dependent.",
    "Agent y command /home/ccuser/bin/foo was omitted from export because it is system-dependent.",
  ]);
  assert.equal(summarized.categories.skippedBuiltIns, 1);
  assert.equal(summarized.categories.systemDependentEnv, 1);
  assert.equal(summarized.categories.omittedSystemDependentCommands, 1);
  assert.ok(!JSON.stringify(desired.agents.meta.exportWarnings).includes("/home/"));
});

test("validate package+desired passes without live snapshot", () => {
  const result = validateFleet({ packageDir: PACKAGE_DIR, desiredDir: DESIRED_DIR });
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
  assert.equal(result.portableAgentCount, 28);
});

test("validate live fixture covers 30 agents", () => {
  const result = validateFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: liveAligned,
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
  assert.ok(result.okItems.some((i) => i.code === "live-agent-count"));
  assert.ok(result.okItems.some((i) => i.code === "skill-library-complete"));
  assert.ok(result.okItems.filter((i) => i.code === "routine-id-title-trigger").length === 5);
});

test("39 catalog entries with 1-10 configured/installed pass", () => {
  const desired = loadDesired(DESIRED_DIR);
  for (const snap of skillOk) {
    const findings = validateSkillRuntime(snap, desired.skills.skillRuntimePolicy);
    assert.ok(findings.some((f) => f.code === "skill-catalog-ok"), JSON.stringify(findings));
    assert.ok(!findings.some((f) => f.severity === "error"), JSON.stringify(findings));
  }
});

test("39 catalog entries all configured/installed fail", () => {
  const desired = loadDesired(DESIRED_DIR);
  for (const snap of skillBad) {
    const findings = validateSkillRuntime(snap, desired.skills.skillRuntimePolicy);
    assert.ok(
      findings.some((f) => f.code === "skill-catalog-treated-as-assignment"),
      JSON.stringify(findings),
    );
  }
});

test("detects seven named contradictions on broken instructions", () => {
  const desired = loadDesired(DESIRED_DIR);
  const results = checkAllContradictions(desired.contradictions.contradictions, {
    recenzent: { instructions: broken.recenzent },
    "zwiadowca-kodu": { instructions: broken["zwiadowca-kodu"] },
    "in-ynier-wdro-e": { instructions: broken["in-ynier-wdro-e"] },
    "senior-programista": { instructions: broken["senior-programista"] },
    "mi-sie-web": { instructions: broken["mi-sie-web"] },
    "mi-sie-recenzji-glm": { instructions: broken["mi-sie-recenzji-glm"] },
    summarizer: { instructions: broken.summarizer, model: "claude-haiku-4-5" },
  });
  assert.equal(results.length, 7);
  assert.ok(results.every((r) => r.ok === false), JSON.stringify(results, null, 2));
});

test("fixed package clears six portable contradictions", () => {
  const desired = loadDesired(DESIRED_DIR);
  const pkg = loadPackage(PACKAGE_DIR);
  const ctx = Object.fromEntries(
    pkg.agents.map((a) => [a.slug, { instructions: a.instructions }]),
  );
  const portableRules = desired.contradictions.contradictions.filter((r) => !r.builtIn);
  const results = checkAllContradictions(portableRules, ctx);
  assert.equal(results.length, 6);
  assert.ok(results.every((r) => r.ok), JSON.stringify(results, null, 2));
});

test("stock Summarizer template has Haiku and no cheap claim", () => {
  assert.ok(summarizerNew.includes("claude-haiku-4-5"));
  assert.ok(!SUMMARIZER_CHEAP_CLAIM_RE.test(summarizerNew));
  const result = validateFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    includeBuiltInInstructions: { summarizer: summarizerNew },
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
});

test("four skill-set overrides match package frontmatter", () => {
  const result = validateFleet({ packageDir: PACKAGE_DIR, desiredDir: DESIRED_DIR });
  assert.equal(result.okItems.filter((i) => i.code === "skill-override").length, 4);
});

test("target models and Codex manageStatus paused are encoded", () => {
  const desired = loadDesired(DESIRED_DIR);
  const bySlug = Object.fromEntries(desired.agents.agents.map((a) => [a.slug, a]));
  assert.equal(bySlug.jarvis.model, "claude-opus-5");
  assert.equal(bySlug["szef-komercyjny"].model, "claude-opus-5");
  assert.equal(bySlug.kronikarz.model, "claude-haiku-4-5");
  assert.equal(bySlug["mi-sie-vault"].model, "claude-haiku-4-5");
  assert.equal(bySlug["mi-sie-kodu-cursor"].model, "auto");
  assert.equal(bySlug["mi-sie-kodu-glm"].model, "openrouter/z-ai/glm-5.2");
  assert.equal(bySlug["mi-sie-web"].model, "openrouter/google/gemini-2.5-flash");
  assert.equal(bySlug["zwiadowca-kodu"].model, "gpt-5.6-terra");
  assert.equal(bySlug["zwiadowca-kodu"].adapterType, "codex_local");
  assert.equal(bySlug["zwiadowca-kodu"].status, "paused");
  assert.equal(bySlug["zwiadowca-kodu"].manageStatus, true);
  assert.equal(bySlug["zwiadowca-kodu"].expectedRuntimePolicy.status, "paused");
  assert.equal(bySlug["zwiadowca-kodu"].expectedRuntimePolicy.maxConcurrentRuns, 1);
  assert.equal(bySlug["zwiadowca-kodu"].expectedRuntimePolicy.adapterType, "codex_local");
  assert.equal(bySlug["zwiadowca-kodu"].expectedRuntimePolicy.model, "gpt-5.6-terra");
  assert.equal(
    bySlug["zwiadowca-kodu"].expectedRuntimePolicy.adapterConfig.modelReasoningEffort,
    "medium",
  );
  assert.equal(
    bySlug["zwiadowca-kodu"].expectedRuntimePolicy.adapterConfig.filesystemWorkspaceAccess,
    "ro",
  );
  assert.deepEqual(bySlug["zwiadowca-kodu"].expectedRuntimePolicy.adapterConfig.networkAllowlist, OPENAI_SAFE_ALLOWLIST);
  assert.deepEqual(
    bySlug["zwiadowca-kodu"].expectedRuntimePolicy.adapterConfig.extraArgs,
    REQUIRED_POLICY_EXTRA_ARGS,
  );
  assert.equal(bySlug["zwiadowca-kodu"].expectedRuntimePolicy.heartbeat.enabled, false);
  assert.equal(bySlug["zwiadowca-kodu"].expectedRuntimePolicy.heartbeat.wakeOnDemand, true);
  assert.equal(bySlug["zwiadowca-kodu"].expectedRuntimePolicy.heartbeat.maxDailyRuns, 3);

  assert.equal(bySlug.recenzent.model, "gpt-5.6-sol");
  assert.equal(bySlug.recenzent.adapterType, "codex_local");
  assert.equal(bySlug.recenzent.status, "paused");
  assert.equal(bySlug.recenzent.manageStatus, true);
  assert.equal(bySlug.recenzent.expectedRuntimePolicy.maxConcurrentRuns, 1);
  assert.equal(bySlug.recenzent.expectedRuntimePolicy.adapterConfig.filesystemScope, "workspace");
  assert.equal(bySlug.recenzent.expectedRuntimePolicy.adapterConfig.filesystemWorkspaceAccess, "ro");
  assert.equal(bySlug.recenzent.expectedRuntimePolicy.adapterConfig.networkScope, "allowlist");
  assert.equal(bySlug.recenzent.expectedRuntimePolicy.adapterConfig.dangerouslyBypassApprovalsAndSandbox, false);
  assert.deepEqual(bySlug.recenzent.expectedRuntimePolicy.adapterConfig.extraArgs, [
    "--sandbox",
    "danger-full-access",
    "--skip-git-repo-check",
  ]);
  assert.equal(bySlug["mi-sie-kodu-codex"].model, "gpt-5.6-sol");
  assert.equal(bySlug["mi-sie-kodu-codex"].adapterType, "codex_local");
  assert.equal(bySlug["mi-sie-kodu-codex"].status, "paused");
  assert.equal(bySlug["mi-sie-kodu-codex"].manageStatus, true);
  assert.equal(bySlug["mi-sie-kodu-codex"].expectedRuntimePolicy.status, "paused");
  assert.equal(bySlug["mi-sie-kodu-codex"].expectedRuntimePolicy.maxConcurrentRuns, 1);
  assert.equal(bySlug["mi-sie-kodu-codex"].expectedRuntimePolicy.adapterType, "codex_local");
  assert.equal(bySlug["mi-sie-kodu-codex"].expectedRuntimePolicy.model, "gpt-5.6-sol");
  assert.equal(
    bySlug["mi-sie-kodu-codex"].expectedRuntimePolicy.adapterConfig.modelReasoningEffort,
    "high",
  );
  assert.equal(
    bySlug["mi-sie-kodu-codex"].expectedRuntimePolicy.adapterConfig.filesystemWorkspaceAccess,
    "rw",
  );
  assert.deepEqual(
    bySlug["mi-sie-kodu-codex"].expectedRuntimePolicy.adapterConfig.networkAllowlist,
    OPENAI_SAFE_ALLOWLIST_WITH_GITHUB,
  );
  assert.deepEqual(
    bySlug["mi-sie-kodu-codex"].expectedRuntimePolicy.adapterConfig.extraArgs,
    REQUIRED_POLICY_EXTRA_ARGS,
  );
  assert.equal(bySlug["mi-sie-kodu-codex"].expectedRuntimePolicy.heartbeat.enabled, false);
  assert.equal(bySlug["mi-sie-kodu-codex"].expectedRuntimePolicy.heartbeat.wakeOnDemand, true);
  assert.equal(bySlug["mi-sie-kodu-codex"].expectedRuntimePolicy.heartbeat.maxDailyRuns, 1);

  assert.equal(bySlug["mi-sie-kodu-codex-szybki"].model, "codex-mini-latest");
  assert.equal(bySlug["mi-sie-kodu-codex-szybki"].adapterType, "codex_local");
  assert.equal(bySlug["mi-sie-kodu-codex-szybki"].status, "paused");
  assert.equal(bySlug["mi-sie-kodu-codex-szybki"].manageStatus, true);
  assert.equal(bySlug["mi-sie-kodu-codex-szybki"].expectedRuntimePolicy.status, "paused");
  assert.equal(bySlug["mi-sie-kodu-codex-szybki"].expectedRuntimePolicy.maxConcurrentRuns, 2);
  assert.equal(bySlug["mi-sie-kodu-codex-szybki"].expectedRuntimePolicy.adapterType, "codex_local");
  assert.equal(bySlug["mi-sie-kodu-codex-szybki"].expectedRuntimePolicy.model, "codex-mini-latest");
  assert.equal(
    bySlug["mi-sie-kodu-codex-szybki"].expectedRuntimePolicy.adapterConfig.modelReasoningEffort,
    "low",
  );
  assert.equal(bySlug["mi-sie-kodu-codex-szybki"].expectedRuntimePolicy.adapterConfig.fastMode, true);
  assert.equal(
    bySlug["mi-sie-kodu-codex-szybki"].expectedRuntimePolicy.adapterConfig.filesystemWorkspaceAccess,
    "rw",
  );
  assert.equal(
    bySlug["mi-sie-kodu-codex-szybki"].expectedRuntimePolicy.adapterConfig.timeoutSec,
    900,
  );
  assert.equal(
    bySlug["mi-sie-kodu-codex-szybki"].expectedRuntimePolicy.adapterConfig.outputInactivityTimeoutMs,
    360000,
  );
  assert.deepEqual(
    bySlug["mi-sie-kodu-codex-szybki"].expectedRuntimePolicy.adapterConfig.networkAllowlist,
    OPENAI_SAFE_ALLOWLIST_WITH_GITHUB,
  );
  assert.equal(bySlug["mi-sie-kodu-codex-szybki"].expectedRuntimePolicy.heartbeat.maxDailyRuns, 8);
  assert.ok(
    desired.agents.agents.filter(
      (a) =>
        ![
          "mi-sie-kodu-codex",
          "mi-sie-kodu-codex-szybki",
          "recenzent",
          "zwiadowca-kodu",
        ].includes(a.slug) && a.manageStatus,
    ).length === 0,
  );
});

function withMutatedDesiredAgents(mutateAgentsDoc, run) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "jarvis-desired-policy-"));
  cpSync(DESIRED_DIR, tmp, { recursive: true });
  const agentsPath = path.join(tmp, "agents.json");
  const doc = JSON.parse(readFileSync(agentsPath, "utf8"));
  mutateAgentsDoc(doc);
  writeFileSync(agentsPath, `${JSON.stringify(doc, null, 2)}\n`);
  return run(tmp);
}

function findDesiredAgent(doc, slug) {
  const agent = doc.agents.find((row) => row.slug === slug);
  assert.ok(agent, `desired agents.json must include ${slug}`);
  return agent;
}

test("validate rejects pre-existing managed role with maxConcurrentRuns 2", () => {
  withMutatedDesiredAgents((doc) => {
    findDesiredAgent(doc, "mi-sie-kodu-codex").expectedRuntimePolicy.maxConcurrentRuns = 2;
  }, (desiredDir) => {
    const result = validateFleet({ packageDir: PACKAGE_DIR, desiredDir });
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some(
        (error) =>
          error.code === "runtime-policy-max-concurrent"
          && error.message.includes("mi-sie-kodu-codex")
          && error.message.includes("must equal 1"),
      ),
      JSON.stringify(result.errors, null, 2),
    );
  });
});

test("validate rejects pre-existing managed role with timeout adapter keys", () => {
  withMutatedDesiredAgents((doc) => {
    const policy = findDesiredAgent(doc, "zwiadowca-kodu").expectedRuntimePolicy;
    policy.adapterConfig.timeoutSec = 900;
    policy.adapterConfig.outputInactivityTimeoutMs = 360000;
  }, (desiredDir) => {
    const result = validateFleet({ packageDir: PACKAGE_DIR, desiredDir });
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some(
        (error) =>
          error.code === "runtime-policy-adapter-config-structure"
          && error.message.includes("zwiadowca-kodu"),
      ),
      JSON.stringify(result.errors, null, 2),
    );
  });
});

test("validate rejects fast Codex role with maxConcurrentRuns 1", () => {
  withMutatedDesiredAgents((doc) => {
    findDesiredAgent(doc, "mi-sie-kodu-codex-szybki").expectedRuntimePolicy.maxConcurrentRuns = 1;
  }, (desiredDir) => {
    const result = validateFleet({ packageDir: PACKAGE_DIR, desiredDir });
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some(
        (error) =>
          error.code === "runtime-policy-max-concurrent"
          && error.message.includes("mi-sie-kodu-codex-szybki")
          && error.message.includes("must equal 2"),
      ),
      JSON.stringify(result.errors, null, 2),
    );
  });
});

test("validate rejects fast Codex role missing timeout adapter keys", () => {
  withMutatedDesiredAgents((doc) => {
    const adapterConfig = findDesiredAgent(doc, "mi-sie-kodu-codex-szybki").expectedRuntimePolicy
      .adapterConfig;
    delete adapterConfig.timeoutSec;
    delete adapterConfig.outputInactivityTimeoutMs;
  }, (desiredDir) => {
    const result = validateFleet({ packageDir: PACKAGE_DIR, desiredDir });
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some(
        (error) =>
          error.code === "runtime-policy-adapter-config-structure"
          && error.message.includes("mi-sie-kodu-codex-szybki"),
      ),
      JSON.stringify(result.errors, null, 2),
    );
  });
});

async function assertValidateAndApplyRejectsPolicyDrift({ slug, mutate, errorCode }) {
  const snap = structuredClone(liveAligned);
  const agent = snap.agents.find((a) => a.slug === slug);
  assert.ok(agent, `fixture must include ${slug}`);
  mutate(agent);

  const validation = validateFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: snap,
    forApply: true,
  });
  assert.equal(validation.ok, false);
  assert.ok(
    validation.errors.some((e) => e.code === errorCode),
    JSON.stringify(validation.errors, null, 2),
  );

  let calls = 0;
  const api = {
    dryRun: false,
    async get() {
      calls += 1;
      throw new Error("must not call get");
    },
    async patch() {
      calls += 1;
      throw new Error("must not call patch");
    },
    async post() {
      calls += 1;
      throw new Error("must not call post");
    },
    async put() {
      calls += 1;
      throw new Error("must not call put");
    },
  };

  const report = await applyFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: snap,
    apply: true,
    backupGate: makeBackupGate(),
    api,
  });
  assert.equal(report.ok, false);
  assert.equal(report.writesSucceeded, 0);
  assert.equal(report.completed.length, 0);
  assert.equal(calls, 0);
  assert.ok(report.failed.some((f) => f.step === "validate"));
}

const policyDriftCases = [
  {
    name: "zwiadowca adapterType drift",
    slug: "zwiadowca-kodu",
    mutate: (agent) => {
      agent.adapterType = "claude_local";
    },
    errorCode: "live-adapter-type-mismatch",
  },
  {
    name: "zwiadowca model drift",
    slug: "zwiadowca-kodu",
    mutate: (agent) => {
      agent.adapterConfig.model = "gpt-5.6-sol";
      agent.model = "gpt-5.6-sol";
    },
    errorCode: "runtime-policy-model-mismatch",
  },
  {
    name: "zwiadowca effort drift",
    slug: "zwiadowca-kodu",
    mutate: (agent) => {
      agent.adapterConfig.modelReasoningEffort = "high";
    },
    errorCode: "runtime-policy-adapter-config-mismatch",
  },
  {
    name: "zwiadowca workspace access drift",
    slug: "zwiadowca-kodu",
    mutate: (agent) => {
      agent.adapterConfig.filesystemWorkspaceAccess = "rw";
    },
    errorCode: "runtime-policy-adapter-config-mismatch",
  },
  {
    name: "zwiadowca extra args drift",
    slug: "zwiadowca-kodu",
    mutate: (agent) => {
      agent.adapterConfig.extraArgs = ["--sandbox", "workspace-write", "--skip-git-repo-check"];
    },
    errorCode: "runtime-policy-extra-args-mismatch",
  },
  {
    name: "zwiadowca bypass drift",
    slug: "zwiadowca-kodu",
    mutate: (agent) => {
      agent.adapterConfig.dangerouslyBypassApprovalsAndSandbox = true;
    },
    errorCode: "runtime-policy-adapter-config-mismatch",
  },
  {
    name: "zwiadowca maxConcurrentRuns drift",
    slug: "zwiadowca-kodu",
    mutate: (agent) => {
      agent.maxConcurrentRuns = 2;
    },
    errorCode: "runtime-policy-max-concurrent-mismatch",
  },
  {
    name: "zwiadowca maxDailyRuns drift",
    slug: "zwiadowca-kodu",
    mutate: (agent) => {
      agent.heartbeat.maxDailyRuns = 1;
    },
    errorCode: "runtime-policy-heartbeat-max-daily-runs-mismatch",
  },
  {
    name: "zwiadowca status drift",
    slug: "zwiadowca-kodu",
    mutate: (agent) => {
      agent.status = "idle";
    },
    errorCode: "runtime-policy-status-mismatch",
  },
  {
    name: "zwiadowca network allowlist drift",
    slug: "zwiadowca-kodu",
    mutate: (agent) => {
      agent.adapterConfig.networkAllowlist = [];
    },
    errorCode: "runtime-policy-network-allowlist-mismatch",
  },
  {
    name: "zwiadowca heartbeat enabled drift",
    slug: "zwiadowca-kodu",
    mutate: (agent) => {
      agent.heartbeat.enabled = true;
    },
    errorCode: "runtime-policy-heartbeat-enabled-mismatch",
  },
  {
    name: "zwiadowca heartbeat wakeOnDemand drift",
    slug: "zwiadowca-kodu",
    mutate: (agent) => {
      agent.heartbeat.wakeOnDemand = false;
    },
    errorCode: "runtime-policy-heartbeat-wake-mismatch",
  },
  {
    name: "mi-sie-kodu-codex adapterType drift",
    slug: "mi-sie-kodu-codex",
    mutate: (agent) => {
      agent.adapterType = "claude_local";
    },
    errorCode: "live-adapter-type-mismatch",
  },
  {
    name: "mi-sie-kodu-codex model drift",
    slug: "mi-sie-kodu-codex",
    mutate: (agent) => {
      agent.adapterConfig.model = "gpt-5.6-terra";
      agent.model = "gpt-5.6-terra";
    },
    errorCode: "runtime-policy-model-mismatch",
  },
  {
    name: "mi-sie-kodu-codex effort drift",
    slug: "mi-sie-kodu-codex",
    mutate: (agent) => {
      agent.adapterConfig.modelReasoningEffort = "medium";
    },
    errorCode: "runtime-policy-adapter-config-mismatch",
  },
  {
    name: "mi-sie-kodu-codex workspace access drift",
    slug: "mi-sie-kodu-codex",
    mutate: (agent) => {
      agent.adapterConfig.filesystemWorkspaceAccess = "ro";
    },
    errorCode: "runtime-policy-adapter-config-mismatch",
  },
  {
    name: "mi-sie-kodu-codex extra args drift",
    slug: "mi-sie-kodu-codex",
    mutate: (agent) => {
      agent.adapterConfig.extraArgs = ["--sandbox", "workspace-write", "--skip-git-repo-check"];
    },
    errorCode: "runtime-policy-extra-args-mismatch",
  },
  {
    name: "mi-sie-kodu-codex bypass drift",
    slug: "mi-sie-kodu-codex",
    mutate: (agent) => {
      agent.adapterConfig.dangerouslyBypassApprovalsAndSandbox = true;
    },
    errorCode: "runtime-policy-adapter-config-mismatch",
  },
  {
    name: "mi-sie-kodu-codex maxConcurrentRuns drift",
    slug: "mi-sie-kodu-codex",
    mutate: (agent) => {
      agent.maxConcurrentRuns = 2;
    },
    errorCode: "runtime-policy-max-concurrent-mismatch",
  },
  {
    name: "mi-sie-kodu-codex maxDailyRuns drift",
    slug: "mi-sie-kodu-codex",
    mutate: (agent) => {
      agent.heartbeat.maxDailyRuns = 2;
    },
    errorCode: "runtime-policy-heartbeat-max-daily-runs-mismatch",
  },
  {
    name: "mi-sie-kodu-codex status drift",
    slug: "mi-sie-kodu-codex",
    mutate: (agent) => {
      agent.status = "idle";
    },
    errorCode: "runtime-policy-status-mismatch",
  },
  {
    name: "mi-sie-kodu-codex network allowlist drift",
    slug: "mi-sie-kodu-codex",
    mutate: (agent) => {
      agent.adapterConfig.networkAllowlist = [];
    },
    errorCode: "runtime-policy-network-allowlist-mismatch",
  },
  {
    name: "mi-sie-kodu-codex heartbeat enabled drift",
    slug: "mi-sie-kodu-codex",
    mutate: (agent) => {
      agent.heartbeat.enabled = true;
    },
    errorCode: "runtime-policy-heartbeat-enabled-mismatch",
  },
  {
    name: "mi-sie-kodu-codex heartbeat wakeOnDemand drift",
    slug: "mi-sie-kodu-codex",
    mutate: (agent) => {
      agent.heartbeat.wakeOnDemand = false;
    },
    errorCode: "runtime-policy-heartbeat-wake-mismatch",
  },
  {
    name: "recenzent adapterType drift",
    slug: "recenzent",
    mutate: (agent) => {
      agent.adapterType = "claude_local";
    },
    errorCode: "live-adapter-type-mismatch",
  },
  {
    name: "recenzent extra args drift",
    slug: "recenzent",
    mutate: (agent) => {
      agent.adapterConfig.extraArgs = ["--sandbox", "workspace-write", "--skip-git-repo-check"];
    },
    errorCode: "runtime-policy-extra-args-mismatch",
  },
  {
    name: "recenzent cwd drift",
    slug: "recenzent",
    mutate: (agent) => {
      agent.adapterConfig.cwd = "/srv/paperclip/production/recenzent-mirror";
    },
    errorCode: "runtime-policy-cwd-mismatch",
  },
  {
    name: "recenzent bypass drift",
    slug: "recenzent",
    mutate: (agent) => {
      agent.adapterConfig.dangerouslyBypassApprovalsAndSandbox = true;
    },
    errorCode: "runtime-policy-adapter-config-mismatch",
  },
  {
    name: "recenzent network allowlist drift",
    slug: "recenzent",
    mutate: (agent) => {
      agent.adapterConfig.networkAllowlist = agent.adapterConfig.networkAllowlist.filter(
        (host) => host !== "auth.openai.com",
      );
    },
    errorCode: "runtime-policy-network-allowlist-mismatch",
  },
  {
    name: "recenzent workspace access drift",
    slug: "recenzent",
    mutate: (agent) => {
      agent.adapterConfig.filesystemWorkspaceAccess = "rw";
    },
    errorCode: "runtime-policy-adapter-config-mismatch",
  },
  {
    name: "recenzent maxConcurrentRuns drift",
    slug: "recenzent",
    mutate: (agent) => {
      agent.maxConcurrentRuns = 2;
    },
    errorCode: "runtime-policy-max-concurrent-mismatch",
  },
];

for (const driftCase of policyDriftCases) {
  test(`live ${driftCase.name} fails validate/apply before API call`, async () => {
    await assertValidateAndApplyRejectsPolicyDrift(driftCase);
  });
}

test("five routines have exact live ids and trigger ids", () => {
  const desired = loadDesired(DESIRED_DIR);
  assert.equal(desired.routines.routines.length, 5);
  const expected = {
    "Przegląd nowych PR-ów upstream": [
      "23311405-afb9-46b3-a4cd-981b42439771",
      "b9d081f3-30c2-4eb3-9b0c-dec3121021d8",
    ],
    "Review recent agent trajectories for coaching proposals": [
      "dc5d4ccd-f965-4bcf-a33c-fcd0b3abfd93",
      "a2267c9f-f114-4c08-a952-c4efbca7ec77",
    ],
    "Refresh stale summary slots": [
      "8b9b861f-f6df-4e48-96ad-4ba25ee812a0",
      "2c3c61be-71a2-475e-bd79-c655bc55cb91",
    ],
    "Cotygodniowy przeglad trajektorii agentow (refleksja)": [
      "917e06bd-97e7-4e2f-84cc-b6dbb14ccd9f",
      "ab78f03a-fb5d-4a3e-b590-652d2f836eb2",
    ],
    "Nasłuch skrzynki Company OS (agent KO)": [
      "f539d2b7-22f7-4e21-983c-15ba9ba1e92a",
      "c4284183-44c9-4452-a000-b4abc0c3dc51",
    ],
  };
  for (const r of desired.routines.routines) {
    assert.deepEqual([r.id, r.triggerId], expected[r.title]);
  }
});

test("matchRoutineStrict refuses title mismatch and trigger mismatch", () => {
  const desired = loadDesired(DESIRED_DIR);
  const first = desired.routines.routines[0];
  const badTitle = matchRoutineStrict(first, liveTitleMismatch.routines);
  assert.equal(badTitle.ok, false);
  assert.equal(badTitle.code, "routine-title-mismatch");
  const badTrig = matchRoutineStrict(first, liveTriggerMismatch.routines);
  assert.equal(badTrig.ok, false);
  assert.equal(badTrig.code, "routine-trigger-id-missing");
  const okMatch = matchRoutineStrict(first, liveAligned.routines);
  assert.equal(okMatch.ok, true);
  assert.equal(okMatch.trigger.id, first.triggerId);
});

test("diff blocks on routine id/title/trigger mismatches — no name-only apply path", () => {
  const titleDiff = diffFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: liveTitleMismatch,
  });
  assert.ok(titleDiff.blocking > 0);
  assert.ok(titleDiff.changes.some((c) => c.kind === "routine-title-mismatch"));

  const trigDiff = diffFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: liveTriggerMismatch,
  });
  assert.ok(trigDiff.changes.some((c) => c.kind === "routine-trigger-id-missing"));
});

test("backup gate requires existing file + sha — soft confirm removed", () => {
  assert.equal(assertBackupGate({}).ok, false);
  assert.equal(assertBackupGate({ confirmFlag: "I_HAVE_VERIFIED_DB_BACKUP" }).ok, false);
  const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-bak-"));
  const file = path.join(dir, "db.bak");
  writeFileSync(file, "backup-bytes");
  const sha = createHash("sha256").update("backup-bytes").digest("hex");
  assert.equal(assertBackupGate({ backupFile: file, backupSha256: sha }).ok, true);
  assert.equal(assertBackupGate({ backupFile: file, backupSha256: "deadbeef" }).ok, false);
});

function makeBackupGate() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-bak-"));
  const file = path.join(dir, "db.bak");
  writeFileSync(file, "backup-bytes");
  const sha = createHash("sha256").update("backup-bytes").digest("hex");
  return { backupFile: file, backupSha256: sha };
}

test("apply dry-run is offline — no API client / env required", async () => {
  const liveApplyDrift = buildApplySnapshotWithNonProfileModelDrift();
  const prevUrl = process.env.PAPERCLIP_API_URL;
  const prevKey = process.env.PAPERCLIP_API_KEY;
  delete process.env.PAPERCLIP_API_URL;
  delete process.env.PAPERCLIP_API_KEY;
  try {
    const report = await applyFleet({
      packageDir: PACKAGE_DIR,
      desiredDir: DESIRED_DIR,
      liveSnapshot: liveApplyDrift,
      apply: false,
    });
    assert.equal(report.mode, "dry-run");
    assert.ok(report.planned.length > 0);
    assert.ok(report.ok);
    assert.equal(report.completed.length, 0);
    assert.ok(
      !report.planned.some(
        (c) =>
          c.kind === "agent-pause" &&
          ["recenzent", "zwiadowca-kodu", "mi-sie-kodu-codex", "mi-sie-kodu-codex-szybki"].includes(
            c.target,
          ),
      ),
    );
  } finally {
    if (prevUrl !== undefined) process.env.PAPERCLIP_API_URL = prevUrl;
    else delete process.env.PAPERCLIP_API_URL;
    if (prevKey !== undefined) process.env.PAPERCLIP_API_KEY = prevKey;
    else delete process.env.PAPERCLIP_API_KEY;
  }
});

test("apply does not change status of unmanaged agents even if paused in fixture", async () => {
  const managedPaused = new Set([
    "mi-sie-kodu-codex",
    "mi-sie-kodu-codex-szybki",
    "recenzent",
    "zwiadowca-kodu",
  ]);
  const pausedOthers = liveAligned.agents.filter(
    (a) =>
      a.status === "paused"
      && !managedPaused.has(a.slug)
      && !a.slug?.includes("summarizer"),
  );
  assert.ok(pausedOthers.length > 0, "fixture should include paused unmanaged agents");
  const diff = diffFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: liveAligned,
  });
  assert.ok(!diff.changes.some((c) => c.kind === "agent-pause" && !managedPaused.has(c.target)));
  assert.ok(!diff.changes.some((c) => c.kind === "agent-resume"));
});

test("apply --apply refuses without backup gate", async () => {
  const report = await applyFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: liveDrift,
    apply: true,
    backupGate: {},
  });
  assert.equal(report.ok, false);
  assert.ok(report.failed.some((f) => f.step === "backup-gate"));
});

test("preflight rejects crafted instruction change kinds", () => {
  const crafted = [
    { kind: "agent-model", target: "mi-sie-web" },
    { kind: "agent-instructions", target: "mi-sie-web", detail: "crafted" },
    { kind: "summarizer-instructions-patch", target: "summarizer", detail: "crafted" },
  ];
  const result = validateApplyChanges(crafted);
  assert.equal(result.ok, false);
  assert.match(result.error, /instruction changes are forbidden/);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].target, "mi-sie-web");
  assert.equal(result.items[1].target, "summarizer");
});

test("preflight allows empty-bundle instruction repair kind", () => {
  const result = validateApplyChanges([
    {
      kind: "agent-instructions-empty-repair",
      target: "mi-sie-kodu-codex-szybki",
      detail: "empty live",
    },
  ]);
  assert.equal(result.ok, true);
});

test("diff plans empty-bundle repair and never overwrites non-empty live instructions", () => {
  const emptySnap = structuredClone(liveAligned);
  const szybki = emptySnap.agents.find((a) => a.slug === "mi-sie-kodu-codex-szybki");
  assert.ok(szybki);
  szybki.instructions = "   ";
  const emptyDiff = diffFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: emptySnap,
  });
  const repair = emptyDiff.changes.find(
    (c) => c.kind === "agent-instructions-empty-repair" && c.target === "mi-sie-kodu-codex-szybki",
  );
  assert.ok(repair, JSON.stringify(emptyDiff.changes, null, 2));
  assert.equal(repair.api?.method, "PUT");
  assert.match(repair.api?.path ?? "", /instructions-bundle\/file$/);

  const nonEmptyDiff = diffFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: liveAligned,
  });
  assert.ok(
    !nonEmptyDiff.changes.some((c) => c.kind === "agent-instructions-empty-repair"),
    JSON.stringify(nonEmptyDiff.changes, null, 2),
  );
});

test("apply seeds empty managed bundle from package and refuses overwrite of non-empty", async () => {
  const pkg = loadPackage(PACKAGE_DIR);
  const packageText = pkg.agentBySlug["mi-sie-kodu-codex-szybki"].instructions;
  assert.ok(packageText.trim().length > 0);

  const emptySnap = structuredClone(liveAligned);
  const szybki = emptySnap.agents.find((a) => a.slug === "mi-sie-kodu-codex-szybki");
  szybki.instructions = "";
  const detailsById = new Map(emptySnap.agents.map((a) => [a.id, structuredClone(a)]));
  let putCount = 0;
  const api = {
    dryRun: false,
    async get(pathname) {
      const match = pathname.match(/^\/api\/agents\/([^/]+)\/instructions-bundle\/file/);
      if (match) {
        const agent = detailsById.get(match[1]);
        return { ok: true, status: 200, data: { content: agent?.instructions ?? "" } };
      }
      const agentMatch = pathname.match(/^\/api\/agents\/([^/]+)$/);
      if (agentMatch) {
        return { ok: true, status: 200, data: detailsById.get(agentMatch[1]) };
      }
      return { ok: false, status: 404, data: null };
    },
    async put(pathname, body) {
      putCount += 1;
      const match = pathname.match(/^\/api\/agents\/([^/]+)\/instructions-bundle\/file$/);
      assert.ok(match);
      const agent = detailsById.get(match[1]);
      assert.equal(body.path, "AGENTS.md");
      assert.equal(body.content, packageText);
      agent.instructions = body.content;
      return { ok: true, status: 200, data: { path: body.path, size: body.content.length } };
    },
    async patch() {
      return { ok: false, status: 500, data: null };
    },
    async post() {
      return { ok: false, status: 500, data: null };
    },
  };

  const gate = (() => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-bak-"));
    const file = path.join(dir, "db.bak");
    writeFileSync(file, "backup-bytes");
    const sha = createHash("sha256").update("backup-bytes").digest("hex");
    return { backupFile: file, backupSha256: sha };
  })();

  const report = await applyFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: emptySnap,
    apply: true,
    backupGate: gate,
    api,
  });
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
  assert.equal(putCount, 1);
  const completed = report.completed.find(
    (c) => c.kind === "agent-instructions-empty-repair" && c.target === "mi-sie-kodu-codex-szybki",
  );
  assert.ok(completed);
  const expectedSha = createHash("sha256").update(packageText, "utf8").digest("hex");
  assert.equal(completed.verified?.contentSha256, expectedSha);
  assert.equal(completed.verified?.contentLength, packageText.length);
  assert.equal(completed.requestBody?.contentSha256, expectedSha);
  assert.equal(detailsById.get(szybki.id).instructions, packageText);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(packageText), false, "apply report must not include instruction body");
  assert.equal(
    Object.prototype.hasOwnProperty.call(completed.verified ?? {}, "content"),
    false,
  );

  // Non-empty live must not be overwritten even if a repair change is forced somehow.
  const nonEmptySnap = structuredClone(liveAligned);
  const liveText = nonEmptySnap.agents.find((a) => a.slug === "mi-sie-kodu-codex-szybki").instructions;
  assert.ok(liveText.trim().length > 0);
  const dry = await applyFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: nonEmptySnap,
    apply: false,
  });
  assert.ok(!dry.planned.some((c) => c.kind === "agent-instructions-empty-repair"));
});

test("apply fails closed when empty-bundle verify returns wrong-but-nonempty content", async () => {
  const pkg = loadPackage(PACKAGE_DIR);
  const packageText = pkg.agentBySlug["mi-sie-kodu-codex-szybki"].instructions;
  assert.ok(packageText.trim().length > 0);
  const wrongNonEmpty = "unrelated-nonempty-agents-md-body-not-from-package";
  assert.notEqual(wrongNonEmpty, packageText);

  const emptySnap = structuredClone(liveAligned);
  const szybki = emptySnap.agents.find((a) => a.slug === "mi-sie-kodu-codex-szybki");
  szybki.instructions = "";
  const detailsById = new Map(emptySnap.agents.map((a) => [a.id, structuredClone(a)]));
  let putCount = 0;
  let poisonVerify = false;
  const api = {
    dryRun: false,
    async get(pathname) {
      const match = pathname.match(/^\/api\/agents\/([^/]+)\/instructions-bundle\/file/);
      if (match) {
        if (poisonVerify) {
          return { ok: true, status: 200, data: { content: wrongNonEmpty } };
        }
        const agent = detailsById.get(match[1]);
        return { ok: true, status: 200, data: { content: agent?.instructions ?? "" } };
      }
      const agentMatch = pathname.match(/^\/api\/agents\/([^/]+)$/);
      if (agentMatch) {
        return { ok: true, status: 200, data: detailsById.get(agentMatch[1]) };
      }
      return { ok: false, status: 404, data: null };
    },
    async put(pathname, body) {
      putCount += 1;
      const match = pathname.match(/^\/api\/agents\/([^/]+)\/instructions-bundle\/file$/);
      assert.ok(match);
      assert.equal(body.path, "AGENTS.md");
      assert.equal(body.content, packageText);
      detailsById.get(match[1]).instructions = body.content;
      poisonVerify = true;
      return { ok: true, status: 200, data: { path: body.path, size: body.content.length } };
    },
    async patch() {
      return { ok: false, status: 500, data: null };
    },
    async post() {
      return { ok: false, status: 500, data: null };
    },
  };

  const gate = (() => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-bak-"));
    const file = path.join(dir, "db.bak");
    writeFileSync(file, "backup-bytes");
    const sha = createHash("sha256").update("backup-bytes").digest("hex");
    return { backupFile: file, backupSha256: sha };
  })();

  const report = await applyFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: emptySnap,
    apply: true,
    backupGate: gate,
    api,
  });
  assert.equal(report.ok, false, JSON.stringify(report, null, 2));
  assert.equal(putCount, 1);
  assert.equal(report.writesSucceeded, 1);
  assert.equal(report.partial, true);
  assert.equal(report.completed.length, 0);
  const failed = report.failed.find(
    (f) => f.kind === "agent-instructions-empty-repair" && f.target === "mi-sie-kodu-codex-szybki",
  );
  assert.ok(failed, JSON.stringify(report.failed, null, 2));
  assert.match(failed.error, /instructions verify content mismatch/);
  assert.match(failed.error, /expected=[0-9a-f]{12}/);
  assert.match(failed.error, /got=[0-9a-f]{12}/);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(packageText), false, "failed report must not include package instruction body");
  assert.equal(serialized.includes(wrongNonEmpty), false, "failed report must not include wrong live instruction body");
});

test("missing skillLibrary is a validate error", () => {
  const snap = structuredClone(liveAligned);
  delete snap.skillLibrary;
  const result = validateFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: snap,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === "skill-library-absent"));
});

test("agent-missing is blocking and apply refuses", async () => {
  const snap = structuredClone(liveAligned);
  snap.agents = snap.agents.filter((a) => a.slug !== "jarvis");
  snap.completeness.agentCount = snap.agents.length;
  const diff = diffFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: snap,
  });
  assert.ok(diff.changes.some((c) => c.kind === "agent-missing" && c.blocking));
  const report = await applyFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: snap,
    apply: true,
    backupGate: makeBackupGate(),
  });
  assert.equal(report.ok, false);
  assert.ok(
    report.failed.some((f) => f.step === "validate" || f.step === "preflight"),
    JSON.stringify(report.failed),
  );
});

test("skill key preflight refuses short names and missing library keys", () => {
  const missing = resolveFullSkillKeys(
    ["paperclipai/paperclip/paperclip", "local/does-not-exist/commit"],
    liveAligned.skillLibrary,
  );
  assert.equal(missing.ok, false);
  assert.match(missing.error, /missing/);

  const short = resolveFullSkillKeys(["paperclip"], liveAligned.skillLibrary);
  assert.equal(short.ok, false);
  assert.match(short.error, /short/i);
});

test("resolveFullSkillKeys accepts unique full key even when short suffix is shared", () => {
  const library = [
    { key: "paperclipai/paperclip/paperclip" },
    { key: "other/org/paperclip" },
    { key: "paperclipai/bundled/paperclip-operations/summarize-status" },
  ];
  const ok = resolveFullSkillKeys(["paperclipai/paperclip/paperclip"], library);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.keys, ["paperclipai/paperclip/paperclip"]);
});

test("resolveBootstrapSkillKey exact full key wins; 0 or >1 short matches fail closed", () => {
  const catalog = new Set([
    "paperclipai/paperclip/paperclip",
    "other/org/paperclip",
    "local/abc/research",
  ]);
  assert.equal(resolveBootstrapSkillKey("paperclipai/paperclip/paperclip", catalog).ok, true);
  assert.equal(resolveBootstrapSkillKey("missing-skill", catalog).ok, false);
  assert.equal(resolveBootstrapSkillKey("paperclip", catalog).ok, false); // ambiguous short
  assert.equal(resolveBootstrapSkillKey("research", catalog).ok, true); // unique short
});

test("apply refuses skill sync when override keys are not uniquely in library", async () => {
  const snap = structuredClone(liveDrift);
  // Force an agent-skills change whose skillKeys are absent from library
  const web = snap.agents.find((a) => a.slug === "mi-sie-web");
  web.desiredSkills = ["paperclipai/paperclip/paperclip", "local/59da7d4268/research", "extra"];
  snap.skillLibrary = snap.skillLibrary.filter((s) => s.key !== "local/59da7d4268/research");
  const report = await applyFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: snap,
    apply: true,
    backupGate: makeBackupGate(),
  });
  assert.equal(report.ok, false);
  assert.ok(report.failed.some((f) => f.step === "skill-keys" || f.step === "validate"));
  assert.equal(report.completed.length, 0);
});

function createStatefulApplyMock({
  failOnPatchCall = null,
  verifyFailKind = null,
  liveSnapshot = liveDrift,
} = {}) {
  const activeStateForAdapter = (adapterType) => {
    if (adapterType === "opencode_local" || adapterType === "cursor") return "installed";
    if (adapterType === "claude_local" || adapterType === "codex_local") return "configured";
    return "configured";
  };

  const agents = new Map(liveSnapshot.agents.map((a) => [a.id, structuredClone(a)]));
  const routines = new Map(liveSnapshot.routines.map((r) => [r.id, structuredClone(r)]));
  let summarizerContent =
    liveSnapshot.builtIns?.find((b) => b.key === "summarizer")?.instructions ?? summarizerOld;
  let patchCalls = 0;
  let postCalls = 0;
  let putCalls = 0;
  let stopped = false;
  // After a successful model PATCH, poison only the next agent GET (post-write verify).
  let poisonNextModelVerify = false;

  return {
    dryRun: false,
    async get(url) {
      if (stopped) throw new Error("get after fail-fast stop");
      if (url.includes("/instructions-bundle/file")) {
        const id = url.split("/api/agents/")[1].split("/")[0];
        if (id === "agent-summarizer") {
          return { ok: true, status: 200, data: { content: summarizerContent } };
        }
        const agent = agents.get(id);
        return {
          ok: true,
          status: 200,
          data: { content: agent?.instructions ?? "" },
        };
      }
      if (url.match(/\/api\/agents\/[^/]+\/skills$/)) {
        const id = url.split("/api/agents/")[1].split("/")[0];
        const agent = agents.get(id);
        const desiredSkills = agent?.desiredSkills ?? [];
        const activeState = activeStateForAdapter(agent?.adapterType);
        const desiredSet = new Set(desiredSkills);
        const entries = desiredSkills.map((key) => ({
          key,
          state: activeState,
          desired: true,
        }));
        if (verifyFailKind === "skills") {
          if (entries.length > 1) {
            entries[entries.length - 1].state = "missing";
          } else if (entries.length === 1) {
            entries.length = 0;
          }
        }
        return {
          ok: true,
          status: 200,
          data: {
            adapterType: agent?.adapterType ?? null,
            desiredSkills,
            entries,
            desiredCount: desiredSet.size,
          },
        };
      }
      if (url.match(/\/api\/agents\/[^/]+$/)) {
        const id = url.split("/api/agents/")[1];
        const agent = agents.get(id);
        if (verifyFailKind === "model" && poisonNextModelVerify && agent) {
          poisonNextModelVerify = false;
          return {
            ok: true,
            status: 200,
            data: {
              ...agent,
              adapterConfig: { ...(agent.adapterConfig ?? {}), model: "WRONG_MODEL" },
              model: "WRONG_MODEL",
            },
          };
        }
        return { ok: true, status: 200, data: agent };
      }
      if (url.startsWith("/api/routines/")) {
        const id = url.slice("/api/routines/".length);
        return { ok: true, status: 200, data: routines.get(id) };
      }
      return { ok: false, status: 404, data: null };
    },
    async patch(url, body) {
      patchCalls += 1;
      if (failOnPatchCall != null && patchCalls === failOnPatchCall) {
        stopped = true;
        return { ok: false, status: 500, data: null };
      }
      if (url.startsWith("/api/agents/")) {
        const id = url.slice("/api/agents/".length);
        const agent = agents.get(id);
        assert.deepEqual(body, {
          adapterConfig: { model: body.adapterConfig.model },
          replaceAdapterConfig: false,
        });
        agent.adapterConfig = { ...(agent.adapterConfig ?? {}), model: body.adapterConfig.model };
        agent.model = body.adapterConfig.model;
        if (verifyFailKind === "model") poisonNextModelVerify = true;
        return { ok: true, status: 200, data: agent, requestBody: body };
      }
      if (url.startsWith("/api/routines/")) {
        const id = url.slice("/api/routines/".length);
        const routine = routines.get(id);
        routine.status = body.status ?? routine.status;
        return { ok: true, status: 200, data: routine };
      }
      if (url.startsWith("/api/routine-triggers/")) {
        const triggerId = url.slice("/api/routine-triggers/".length);
        for (const routine of routines.values()) {
          const t = (routine.triggers ?? []).find((x) => x.id === triggerId);
          if (t) t.enabled = body.enabled;
        }
        return { ok: true, status: 200, data: { id: triggerId, enabled: body.enabled } };
      }
      return { ok: false, status: 404, data: null };
    },
    async post(url, body) {
      postCalls += 1;
      if (url.endsWith("/pause")) {
        const id = url.split("/api/agents/")[1].split("/")[0];
        const agent = agents.get(id);
        agent.status = "paused";
        return { ok: true, status: 200, data: agent };
      }
      if (url.endsWith("/skills/sync")) {
        const id = url.split("/api/agents/")[1].split("/")[0];
        const agent = agents.get(id);
        agent.desiredSkills = body.desiredSkills;
        return { ok: true, status: 200, data: { desiredSkills: body.desiredSkills } };
      }
      return { ok: false, status: 404, data: null };
    },
    async put(url, body) {
      putCalls += 1;
      const id = url.split("/api/agents/")[1].split("/")[0];
      if (id === "agent-summarizer") {
        summarizerContent = body.content;
        return { ok: true, status: 200, data: { content: body.content } };
      }
      const agent = agents.get(id);
      agent.instructions = body.content;
      if (verifyFailKind === "instructions") {
        // Pretend write succeeded but leave different content for GET verify
        agent.instructions = "TAMPERED";
      }
      return { ok: true, status: 200, data: { content: body.content } };
    },
    get patchCalls() {
      return patchCalls;
    },
    get postCalls() {
      return postCalls;
    },
    get putCalls() {
      return putCalls;
    },
  };
}

test("apply writes minimal model patch body and verifies", async () => {
  const liveApplyDrift = buildApplySnapshotWithNonProfileModelDrift();
  const api = createStatefulApplyMock({ liveSnapshot: liveApplyDrift });
  const report = await applyFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: liveApplyDrift,
    apply: true,
    backupGate: makeBackupGate(),
    api,
  });
  assert.equal(report.ok, true, JSON.stringify(report.failed, null, 2));
  const plannedModelStep = report.planned.find((c) => c.kind === "agent-model");
  assert.ok(plannedModelStep);
  assert.equal(plannedModelStep.target, "mi-sie-web");
  assert.equal(plannedModelStep.from, "openrouter/openai/gpt-4o-mini");
  assert.equal(plannedModelStep.to, "openrouter/google/gemini-2.5-flash");
  const modelStep = report.completed.find((c) => c.kind === "agent-model");
  assert.ok(modelStep);
  assert.equal(modelStep.target, "mi-sie-web");
  assert.deepEqual(modelStep.requestBody, {
    adapterConfig: { model: "openrouter/google/gemini-2.5-flash" },
    replaceAdapterConfig: false,
  });
  assert.deepEqual(modelStep.verified, {
    ok: true,
    got: "openrouter/google/gemini-2.5-flash",
  });
  assert.equal(report.writesSucceeded, 1);
  assert.ok(report.completed.every((c) => c.verified?.ok === true));
});

test("apply fail-fast stops after first mutation error with partial=true", async () => {
  const liveApplyDrift = buildApplySnapshotWithNonProfileModelDrift({
    includeSecondModelDrift: true,
  });
  const planned = diffFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: liveApplyDrift,
  });
  assert.ok(
    planned.changes.filter((change) => change.kind === "agent-model").length >= 2,
    JSON.stringify(planned.changes, null, 2),
  );
  const api = createStatefulApplyMock({ failOnPatchCall: 2, liveSnapshot: liveApplyDrift });
  const report = await applyFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: liveApplyDrift,
    apply: true,
    backupGate: makeBackupGate(),
    api,
  });
  assert.equal(report.partial, true);
  assert.ok(report.completed.length >= 1);
  assert.equal(report.failed.length, 1);
  // No further patches after failure
  assert.equal(api.patchCalls, 2);
});

test("apply fails closed when post-write verify mismatches", async () => {
  // Isolated from liveDrift: only planned mutation is mi-sie-web model wrong -> desired.
  const snap = structuredClone(liveAligned);
  assert.equal(SWITCHABLE_PROFILE_SLUGS.has("mi-sie-web"), false);
  const web = snap.agents.find((a) => a.slug === "mi-sie-web");
  assert.ok(web, "fixture must include mi-sie-web");
  web.adapterConfig = { ...(web.adapterConfig ?? {}), model: "openrouter/openai/gpt-4o-mini" };
  web.model = "openrouter/openai/gpt-4o-mini";

  const planned = diffFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: snap,
  });
  assert.equal(planned.changeCount, 1, JSON.stringify(planned.changes, null, 2));
  assert.equal(planned.changes[0].kind, "agent-model");
  assert.equal(planned.changes[0].target, "mi-sie-web");
  assert.equal(planned.changes[0].from, "openrouter/openai/gpt-4o-mini");
  assert.equal(planned.changes[0].to, "openrouter/google/gemini-2.5-flash");

  const api = createStatefulApplyMock({ liveSnapshot: snap, verifyFailKind: "model" });
  const report = await applyFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: snap,
    apply: true,
    backupGate: makeBackupGate(),
    api,
  });
  assert.equal(report.ok, false);
  assert.equal(report.completed.length, 0);
  assert.ok(report.writesSucceeded >= 1);
  assert.equal(report.partial, true);
  assert.equal(report.failed.length, 1);
  assert.ok(/verify/i.test(report.failed[0].error), report.failed[0].error);
  // Fail-fast: successful PATCH then verify mismatch — no further mutations.
  assert.equal(api.patchCalls, 1);
  assert.equal(api.postCalls, 0);
  assert.equal(api.putCalls, 0);
});

test("verifyAgentSkills fails when desired keys match but active states are incomplete", async () => {
  const result = await verifyAgentSkills(
    {
      get: async () => ({
        ok: true,
        status: 200,
        data: {
          adapterType: "cursor",
          desiredSkills: ["skill/a", "skill/b"],
          entries: [
            { key: "skill/a", desired: true, state: "installed" },
            { key: "skill/b", desired: true, state: "missing" },
          ],
        },
      }),
    },
    {
      agentId: "agent-cursor",
      expectedKeys: ["skill/a", "skill/b"],
      expectedAdapterType: "cursor",
    },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /invalid state/i);
});

test("verifyAgentSkills fails when expected key has desired=false", async () => {
  const result = await verifyAgentSkills(
    {
      get: async () => ({
        ok: true,
        status: 200,
        data: {
          adapterType: "cursor",
          desiredSkills: ["skill/a"],
          entries: [
            { key: "skill/a", desired: false, state: "installed" },
          ],
        },
      }),
    },
    {
      agentId: "agent-cursor",
      expectedKeys: ["skill/a"],
      expectedAdapterType: "cursor",
    },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /desired:true key set mismatch/i);
});

test("verifyAgentSkills fails when entries contain extra desired:true key", async () => {
  const result = await verifyAgentSkills(
    {
      get: async () => ({
        ok: true,
        status: 200,
        data: {
          adapterType: "cursor",
          desiredSkills: ["skill/a"],
          entries: [
            { key: "skill/a", desired: true, state: "installed" },
            { key: "skill/extra", desired: true, state: "installed" },
          ],
        },
      }),
    },
    {
      agentId: "agent-cursor",
      expectedKeys: ["skill/a"],
      expectedAdapterType: "cursor",
    },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /desired:true key set mismatch/i);
});

test("verifyAgentSkills fails closed on adapterType mismatch", async () => {
  const result = await verifyAgentSkills(
    {
      get: async () => ({
        ok: true,
        status: 200,
        data: {
          adapterType: "claude_local",
          desiredSkills: ["skill/a"],
          entries: [
            { key: "skill/a", desired: true, state: "configured" },
          ],
        },
      }),
    },
    {
      agentId: "agent-cursor",
      expectedKeys: ["skill/a"],
      expectedAdapterType: "cursor",
    },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /adapterType mismatch/i);
});

test("summarizer patch plans exact replace and refuses unexpected drift", () => {
  const okPlan = planSummarizerInstructionPatch(summarizerOld);
  assert.equal(okPlan.ok, true);
  assert.ok(okPlan.next.includes("claude-haiku-4-5"));
  assert.ok(!SUMMARIZER_CHEAP_CLAIM_RE.test(okPlan.next));

  const already = planSummarizerInstructionPatch(summarizerNew);
  assert.equal(already.ok, false);
  assert.equal(already.code, "already-patched");

  const drift = planSummarizerInstructionPatch("# Custom Summarizer\n\nNo model lane here.\n");
  assert.equal(drift.ok, false);
  assert.equal(drift.code, "unexpected-drift");
});

test("summarizer apply patches via GET/PUT/verify and fails closed on drift", async () => {
  let stored = summarizerOld;
  const client = {
    dryRun: false,
    get: async () => ({ ok: true, dryRun: false, status: 200, data: { content: stored } }),
    put: async (_path, body) => {
      stored = body.content;
      return { ok: true, dryRun: false, status: 200 };
    },
  };
  const applied = await applySummarizerInstructionPatch({
    agentId: "agent-summarizer",
    client,
    dryRun: false,
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.result, "applied");
  assert.ok(stored.includes("claude-haiku-4-5"));
  assert.ok(!SUMMARIZER_CHEAP_CLAIM_RE.test(stored));

  const refused = await applySummarizerInstructionPatch({
    agentId: "agent-summarizer",
    client: {
      dryRun: false,
      get: async () => ({
        ok: true,
        dryRun: false,
        status: 200,
        data: {
          content:
            "# unexpected\ncheap claim without exact block but run on the low-cost model profile lane (`cheap`) by default\n",
        },
      }),
      put: async () => {
        throw new Error("must not write");
      },
    },
    dryRun: false,
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.result, "refused");
});

test("summarizer PUT success + verify fail sets partial=true", async () => {
  let stored = summarizerOld;
  let putDone = false;
  const client = {
    dryRun: false,
    get: async () => {
      if (!putDone) return { ok: true, dryRun: false, status: 200, data: { content: stored } };
      // verify returns corrupted/partial content (not exact plan.next)
      return {
        ok: true,
        dryRun: false,
        status: 200,
        data: { content: "# Model\n\nclaude-haiku-4-5 without exact section\n" },
      };
    },
    put: async (_p, body) => {
      putDone = true;
      stored = body.content;
      return { ok: true, dryRun: false, status: 200 };
    },
  };
  const result = await applySummarizerInstructionPatch({
    agentId: "agent-summarizer",
    client,
    dryRun: false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.result, "verify-failed");
  assert.equal(result.partial, true);
});

test("summarizer partial/corrupted Haiku wording is unexpected-drift not already-patched", () => {
  const partial = `# Summarizer\n\n## Model\n\nYour model is claude-haiku-4-5 somehow but not the exact section.\n`;
  const plan = planSummarizerInstructionPatch(partial);
  assert.equal(plan.ok, false);
  assert.equal(plan.code, "unexpected-drift");
});

test("missing completeness object is a validate error", () => {
  const snap = structuredClone(liveAligned);
  delete snap.completeness;
  const result = validateFleet({ packageDir: PACKAGE_DIR, desiredDir: DESIRED_DIR, liveSnapshot: snap });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === "completeness-missing"));
});

test("snapshotFleet live path maps runtimeConfig heartbeat fields", async () => {
  const companyId = "company-jarvis";
  const snap = await snapshotFleet({
    companyId,
    apiUrl: "http://mock.paperclip.local",
    apiKey: "token",
    fetchImpl: createLiveSnapshotFetchMock({ companyId }),
  });
  const recenzent = snap.agents.find((agent) => agent.slug === "recenzent");
  assert.ok(recenzent, "snapshot should include recenzent");
  assert.equal(recenzent.maxConcurrentRuns, 1);
  const jarvis = snap.agents.find((agent) => agent.slug === "jarvis");
  assert.ok(jarvis, "snapshot should include jarvis");
  assert.equal(jarvis.maxConcurrentRuns, 1);
  const zwiadowca = snap.agents.find((agent) => agent.slug === "zwiadowca-kodu");
  assert.ok(zwiadowca, "snapshot should include zwiadowca-kodu");
  assert.deepEqual(zwiadowca.heartbeat, {
    enabled: false,
    wakeOnDemand: true,
    maxDailyRuns: 3,
  });
  const codex = snap.agents.find((agent) => agent.slug === "mi-sie-kodu-codex");
  assert.ok(codex, "snapshot should include mi-sie-kodu-codex");
  assert.deepEqual(codex.heartbeat, {
    enabled: false,
    wakeOnDemand: true,
    maxDailyRuns: 1,
  });

  const validation = validateFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: snap,
  });
  assert.equal(validation.ok, true, JSON.stringify(validation.errors, null, 2));
  assert.ok(
    !validation.errors.some((error) => error.code === "runtime-policy-max-concurrent-mismatch"),
    JSON.stringify(validation.errors, null, 2),
  );
});

test("snapshotFleet live path fails closed on agent detail GET error", async () => {
  const companyId = "company-jarvis";
  const recenzent = liveAligned.agents.find((agent) => agent.slug === "recenzent");
  assert.ok(recenzent, "fixture should include recenzent");

  await assert.rejects(
    () =>
      snapshotFleet({
        companyId,
        apiUrl: "http://mock.paperclip.local",
        apiKey: "token",
        fetchImpl: createLiveSnapshotFetchMock({
          companyId,
          detailFailureById: new Map([[recenzent.id, 503]]),
        }),
      }),
    /agent detail GET failed for recenzent .*HTTP 503/i,
  );
});

test("snapshotFleet AGENTS.md 404 with repair flag yields empty-bundle repair plan only", async () => {
  const companyId = "company-jarvis";
  const szybki = liveAligned.agents.find((agent) => agent.slug === "mi-sie-kodu-codex-szybki");
  assert.ok(szybki, "fixture should include mi-sie-kodu-codex-szybki");

  const snap = await snapshotFleet({
    companyId,
    apiUrl: "http://mock.paperclip.local",
    apiKey: "token",
    allowEmptyInstructionsRepair: true,
    fetchImpl: createLiveSnapshotFetchMock({
      companyId,
      instructionsFailureById: new Map([[szybki.id, 404]]),
    }),
  });

  const live = snap.agents.find((agent) => agent.slug === "mi-sie-kodu-codex-szybki");
  assert.ok(live);
  assert.equal(live.instructions, "");
  assert.ok(
    Array.isArray(snap.completeness?.emptyInstructionRepairsNeeded)
      && snap.completeness.emptyInstructionRepairsNeeded.some((msg) =>
        String(msg).includes("mi-sie-kodu-codex-szybki"),
      ),
    JSON.stringify(snap.completeness, null, 2),
  );
  assert.deepEqual(
    snap.completeness.emptyInstructionRepairSlugs,
    ["mi-sie-kodu-codex-szybki"],
    JSON.stringify(snap.completeness, null, 2),
  );

  const diff = diffFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: snap,
  });
  assert.deepEqual(
    diff.changes.map((c) => c.kind),
    ["agent-instructions-empty-repair"],
    JSON.stringify(diff.changes, null, 2),
  );
  assert.equal(diff.changes[0].target, "mi-sie-kodu-codex-szybki");
});

test("snapshotFleet AGENTS.md 404 without repair flag fails closed", async () => {
  const companyId = "company-jarvis";
  const szybki = liveAligned.agents.find((agent) => agent.slug === "mi-sie-kodu-codex-szybki");
  assert.ok(szybki, "fixture should include mi-sie-kodu-codex-szybki");

  await assert.rejects(
    () =>
      snapshotFleet({
        companyId,
        apiUrl: "http://mock.paperclip.local",
        apiKey: "token",
        allowEmptyInstructionsRepair: false,
        fetchImpl: createLiveSnapshotFetchMock({
          companyId,
          instructionsFailureById: new Map([[szybki.id, 404]]),
        }),
      }),
    /instructions GET failed for mi-sie-kodu-codex-szybki .*HTTP 404/i,
  );
});

test("snapshotFleet AGENTS.md HTTP 500 always fails even with repair flag", async () => {
  const companyId = "company-jarvis";
  const szybki = liveAligned.agents.find((agent) => agent.slug === "mi-sie-kodu-codex-szybki");
  assert.ok(szybki, "fixture should include mi-sie-kodu-codex-szybki");

  await assert.rejects(
    () =>
      snapshotFleet({
        companyId,
        apiUrl: "http://mock.paperclip.local",
        apiKey: "token",
        allowEmptyInstructionsRepair: true,
        fetchImpl: createLiveSnapshotFetchMock({
          companyId,
          instructionsFailureById: new Map([[szybki.id, 500]]),
        }),
      }),
    /instructions GET failed for mi-sie-kodu-codex-szybki .*HTTP 500/i,
  );
});

test("snapshotFleet built-in AGENTS.md 404 is not repairable", async () => {
  const companyId = "company-jarvis";
  const summarizer = liveAligned.agents.find((agent) => agent.id === "agent-summarizer");
  assert.ok(summarizer, "fixture should include summarizer");
  assert.ok(
    summarizer.metadata?.paperclipBuiltInAgent?.key === "summarizer",
    "summarizer must be a built-in",
  );

  await assert.rejects(
    () =>
      snapshotFleet({
        companyId,
        apiUrl: "http://mock.paperclip.local",
        apiKey: "token",
        allowEmptyInstructionsRepair: true,
        fetchImpl: createLiveSnapshotFetchMock({
          companyId,
          instructionsFailureById: new Map([[summarizer.id, 404]]),
        }),
      }),
    /instructions GET failed for .*HTTP 404/i,
  );
});

test("snapshotFleet fixture path enforces completeness", async () => {
  const bad = structuredClone(liveAligned);
  delete bad.completeness;
  await assert.rejects(() => snapshotFleet({ fixture: bad }), /completeness/);
  const ok = await snapshotFleet({ fixture: liveAligned });
  assert.equal(ok.completeness.complete, true);
});

test("snapshotFleet internal capture forbids raw outPath writes", async () => {
  const outPath = path.join(
    mkdtempSync(path.join(os.tmpdir(), "jarvis-snapshot-internal-")),
    "live.json",
  );
  await assert.rejects(
    () =>
      snapshotFleet({
        fixture: liveAligned,
        internalCapture: true,
        outPath,
      }),
    /internalCapture forbids writing unredacted snapshot to outPath/,
  );
});

test("diff blocks provider profile inconsistency and avoids builtin-model repair for profile-owned built-in", () => {
  const snap = structuredClone(liveAligned);
  const bi = snap.builtIns.find((b) => b.key === "summarizer");
  bi.model = null;
  const agent = snap.agents.find((a) => a.id === "agent-summarizer");
  agent.model = null;
  agent.adapterConfig = { ...(agent.adapterConfig ?? {}), model: null };
  const diff = diffFleet({ packageDir: PACKAGE_DIR, desiredDir: DESIRED_DIR, liveSnapshot: snap });
  assert.ok(
    diff.changes.some((c) => c.kind === "provider-profile-inconsistent" && c.blocking),
    JSON.stringify(diff.changes, null, 2),
  );
  assert.ok(
    !diff.changes.some((c) => c.kind === "builtin-model" && c.target === "summarizer"),
    JSON.stringify(diff.changes, null, 2),
  );
});

test("verifyFleet fails when summarizer model drifts", () => {
  const snap = structuredClone(liveAligned);
  snap.builtIns.find((b) => b.key === "summarizer").model = "wrong-model";
  snap.agents.find((a) => a.id === "agent-summarizer").adapterConfig.model = "wrong-model";
  snap.agents.find((a) => a.id === "agent-summarizer").model = "wrong-model";
  const result = verifyFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: snap,
    includeBuiltInInstructions: { summarizer: summarizerNew },
  });
  assert.equal(result.ok, false);
  assert.ok(result.remainingBlocking.some((c) => c.kind === "provider-profile-inconsistent"));
});

test("diff compares full skillKeys for all portable agents not only overrides", () => {
  const snap = structuredClone(liveAligned);
  const agent = snap.agents.find((a) => a.slug === "badacz");
  agent.desiredSkills = agent.desiredSkills.slice(0, 1); // truncate
  const diff = diffFleet({ packageDir: PACKAGE_DIR, desiredDir: DESIRED_DIR, liveSnapshot: snap });
  assert.ok(diff.changes.some((c) => c.kind === "agent-skills" && c.target === "badacz"));
  assert.ok(Array.isArray(diff.changes.find((c) => c.target === "badacz").skillKeys));
  assert.ok(diff.changes.find((c) => c.target === "badacz").skillKeys[0].includes("/"));
});

test("diff ignores portable package AGENTS.md drift including frontmatter and host-path placeholders", () => {
  const snap = structuredClone(liveAligned);
  const agent = snap.agents.find((a) => a.slug === "badacz");
  assert.ok(agent, "fixture must include badacz");
  agent.instructions =
    "---\nname: \"Badacz\"\nskills:\n  - \"paperclipai/paperclip/paperclip\"\n---\n\nKod jest w `<host-path-redacted>`.\n";
  agent.instructionsHash = "not-the-package-hash";
  const diff = diffFleet({ packageDir: PACKAGE_DIR, desiredDir: DESIRED_DIR, liveSnapshot: snap });
  assert.ok(
    !diff.changes.some((c) => c.kind === "agent-instructions"),
    JSON.stringify(diff.changes, null, 2),
  );
  assert.equal(diff.changeCount, 0, JSON.stringify(diff.changes, null, 2));
});

test("diff on liveDrift does not plan any instruction mutation kinds", () => {
  const diff = diffFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: liveDrift,
  });
  assert.ok(
    !diff.changes.some(
      (c) => c.kind === "agent-instructions" || c.kind === "summarizer-instructions-patch",
    ),
    JSON.stringify(diff.changes, null, 2),
  );
});

test("diff plans builtin-skills sync when built-in desiredSkills empty", () => {
  const snap = structuredClone(liveAligned);
  const sum = snap.agents.find((a) => a.id === "agent-summarizer");
  sum.desiredSkills = [];
  const ss = snap.skillSnapshots.find((s) => s.agentId === "agent-summarizer");
  if (ss) ss.desiredSkills = [];
  const diff = diffFleet({ packageDir: PACKAGE_DIR, desiredDir: DESIRED_DIR, liveSnapshot: snap });
  assert.ok(diff.changes.some((c) => c.kind === "builtin-skills" && c.target === "summarizer" && c.agentId === "agent-summarizer"));
});

test("live contradiction fails validate/apply before any API call", async () => {
  const snap = structuredClone(liveAligned);
  const summarizer = snap.agents.find((a) => a.id === "agent-summarizer");
  assert.ok(summarizer, "fixture must include summarizer built-in agent");
  summarizer.instructions =
    "This agent will run on the low-cost model profile lane (`cheap`) by default.";
  // Keep duplicated builtIns fields aligned so this test isolates contradiction logic.
  const builtInSummarizer = snap.builtIns.find((b) => b.key === "summarizer");
  assert.ok(builtInSummarizer, "fixture must include summarizer built-in row");
  builtInSummarizer.instructions = summarizer.instructions;

  const validation = validateFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: snap,
    forApply: true,
  });
  assert.equal(validation.ok, false);
  assert.ok(
    validation.errors.some((e) => e.code === "live-contradiction:summarizer-cheap-claim"),
    JSON.stringify(validation.errors, null, 2),
  );

  let calls = 0;
  const api = {
    dryRun: false,
    async get() {
      calls += 1;
      throw new Error("must not call get");
    },
    async patch() {
      calls += 1;
      throw new Error("must not call patch");
    },
    async post() {
      calls += 1;
      throw new Error("must not call post");
    },
    async put() {
      calls += 1;
      throw new Error("must not call put");
    },
  };
  const report = await applyFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: snap,
    apply: true,
    backupGate: makeBackupGate(),
    api,
  });
  assert.equal(report.ok, false);
  assert.equal(report.writesSucceeded, 0);
  assert.equal(report.completed.length, 0);
  assert.equal(calls, 0);
  assert.ok(report.failed.some((f) => f.step === "validate"));
});

test("diff is idempotent against aligned live snapshot", () => {
  const result = diffFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: liveAligned,
  });
  assert.equal(result.changeCount, 0, JSON.stringify(result.changes, null, 2));
});

test("openai profile live snapshot validates and never plans profile-owned model patches", () => {
  const snapshot = buildLiveSnapshotForProfile("openai-first");
  const diff = diffFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: snapshot,
  });
  assert.equal(
    diff.changes.filter((change) => isProfileOwnedModelChange(change)).length,
    0,
    JSON.stringify(diff.changes, null, 2),
  );
  const validation = validateFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: snapshot,
  });
  assert.equal(validation.ok, true, JSON.stringify(validation.errors, null, 2));
});

test("switchable profile model corruption blocks profile consistency and avoids destructive model patches", () => {
  const snapshot = buildLiveSnapshotForProfile("openai-first");
  const jarvis = snapshot.agents.find((agent) => agent.slug === "jarvis");
  assert.ok(jarvis, "fixture must include jarvis");
  jarvis.adapterConfig = { ...(jarvis.adapterConfig ?? {}), model: "claude-opus-5" };
  jarvis.model = "claude-opus-5";
  const diff = diffFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: snapshot,
  });
  assert.ok(
    diff.changes.some((change) => change.kind === "provider-profile-inconsistent" && change.blocking),
    JSON.stringify(diff.changes, null, 2),
  );
  assert.equal(
    diff.changes.filter((change) => isProfileOwnedModelChange(change)).length,
    0,
    JSON.stringify(diff.changes, null, 2),
  );
  const validation = validateFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: snapshot,
  });
  assert.ok(
    validation.errors.some((error) => error.code === "provider-profile-inconsistent"),
    JSON.stringify(validation.errors, null, 2),
  );
});

test("switchable safe-config drift blocks profile consistency even when adapter and model match", () => {
  const snapshot = buildLiveSnapshotForProfile("openai-first");
  const badacz = snapshot.agents.find((agent) => agent.slug === "badacz");
  assert.ok(badacz, "fixture must include badacz");
  badacz.adapterConfig.networkAllowlist = [];
  const diff = diffFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: snapshot,
  });
  assert.ok(
    diff.changes.some((change) => change.kind === "provider-profile-inconsistent" && change.blocking),
    JSON.stringify(diff.changes, null, 2),
  );
  assert.equal(
    diff.changes.filter((change) => isProfileOwnedModelChange(change)).length,
    0,
    JSON.stringify(diff.changes, null, 2),
  );
  const validation = validateFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: snapshot,
  });
  assert.ok(
    validation.errors.some((error) => error.code === "provider-profile-inconsistent"),
    JSON.stringify(validation.errors, null, 2),
  );
});

test("non-profile model drift still emits agent-model while profile is consistent", () => {
  const snapshot = buildLiveSnapshotForProfile("openai-first");
  const recenzent = snapshot.agents.find((agent) => agent.slug === "recenzent");
  assert.ok(recenzent, "fixture must include recenzent");
  recenzent.adapterConfig = { ...(recenzent.adapterConfig ?? {}), model: "gpt-5.6-luna" };
  recenzent.model = "gpt-5.6-luna";
  const diff = diffFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: snapshot,
  });
  assert.ok(
    diff.changes.some((change) => change.kind === "agent-model" && change.target === "recenzent"),
    JSON.stringify(diff.changes, null, 2),
  );
});

test("verify passes on aligned fixture", () => {
  const result = verifyFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: liveAligned,
    includeBuiltInInstructions: { summarizer: summarizerNew },
  });
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
});

test("diff/verify stay profile-consistent on redacted secret_ref snapshots", () => {
  const SAMPLE_SECRET_ID = "11111111-1111-4111-8111-111111111111";
  const snapshot = structuredClone(liveAligned);
  const target = snapshot.agents.find((agent) => agent.slug === "badacz");
  assert.ok(target, "fixture must include badacz");
  target.adapterConfig = {
    ...(target.adapterConfig ?? {}),
    "access.STRIPE": {
      type: "secret_ref",
      secretId: SAMPLE_SECRET_ID,
      version: "latest",
    },
    env: {
      ...(target.adapterConfig?.env ?? {}),
      PROVIDER_TOKEN: {
        type: "secret_ref",
        secretId: SAMPLE_SECRET_ID,
        version: 1,
      },
    },
  };
  const redacted = redactSecrets(snapshot);
  assert.equal(
    redacted.agents.find((agent) => agent.slug === "badacz").adapterConfig["access.STRIPE"].secretId,
    SECRET_REDACTION_MARKER,
  );
  assert.equal(JSON.stringify(redacted).includes(SAMPLE_SECRET_ID), false);

  const diff = diffFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: redacted,
  });
  assert.equal(
    diff.changes.some((change) => change.kind === "provider-profile-inconsistent"),
    false,
    JSON.stringify(diff.changes, null, 2),
  );
  assert.equal(diff.changeCount, 0, JSON.stringify(diff.changes, null, 2));

  const validation = validateFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: redacted,
    includeBuiltInInstructions: { summarizer: summarizerNew },
  });
  assert.equal(validation.ok, true, JSON.stringify(validation.errors, null, 2));
  assert.equal(
    validation.errors.some((error) => error.code === "provider-profile-inconsistent"),
    false,
    JSON.stringify(validation.errors, null, 2),
  );
  assert.ok(
    validation.okItems.some((item) => item.code === "provider-profile-consistent"),
    JSON.stringify(validation.okItems, null, 2),
  );

  const verified = verifyFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: redacted,
    includeBuiltInInstructions: { summarizer: summarizerNew },
  });
  assert.equal(verified.ok, true, JSON.stringify(verified, null, 2));
});

test("summarizer cheap claim is detected via built-in overlay of old text", () => {
  const result = validateFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    includeBuiltInInstructions: { summarizer: summarizerOld },
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => String(e.code).includes("summarizer-cheap-claim")));
});

test("stale nextRunAt on paused routine is not a validate error", () => {
  const snap = structuredClone(liveAligned);
  const routine = snap.routines.find((r) => r.status === "paused");
  routine.nextRunAt = "2099-01-01T00:00:00.000Z";
  const result = validateFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: snap,
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
});

test("stock Summarizer template file remains the Haiku primary-model wording", () => {
  const stock = readFileSync(
    path.join(
      FLEET_ROOT,
      "../../../server/src/built-ins/agents/summarizer/AGENTS.md",
    ),
    "utf8",
  );
  assert.ok(stock.includes("claude-haiku-4-5"));
  assert.ok(!SUMMARIZER_CHEAP_CLAIM_RE.test(stock));
});

test("swapped built-in agentIds fail validate and apply before mutation", async () => {
  const snap = structuredClone(liveAligned);
  const sum = snap.builtIns.find((b) => b.key === "summarizer");
  const ref = snap.builtIns.find((b) => b.key === "reflection-coach");
  const sumId = sum.agentId;
  const refId = ref.agentId;
  sum.agentId = refId;
  ref.agentId = sumId;
  // Keep duplicated fields consistent with the (wrong) agentId targets so only
  // the id↔metadata-key binding fails — not an incidental field divergence.
  const sumAgent = snap.agents.find((a) => a.id === sumId);
  const refAgent = snap.agents.find((a) => a.id === refId);
  sum.model = refAgent.model;
  sum.instructions = refAgent.instructions;
  sum.desiredSkills = [...refAgent.desiredSkills];
  ref.model = sumAgent.model;
  ref.instructions = sumAgent.instructions;
  ref.desiredSkills = [...sumAgent.desiredSkills];

  const result = validateFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: snap,
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.code === "builtin-agent-id-mismatch"),
    JSON.stringify(result.errors, null, 2),
  );

  const report = await applyFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: snap,
    apply: true,
    backupGate: makeBackupGate(),
  });
  assert.equal(report.ok, false);
  assert.equal(report.writesSucceeded, 0);
  assert.ok(report.failed.some((f) => f.step === "validate"));
  assert.equal(report.completed.length, 0);
});

test("built-in duplicated model/instructions/desiredSkills divergence is refuse", () => {
  const snap = structuredClone(liveAligned);
  const bi = snap.builtIns.find((b) => b.key === "summarizer");
  bi.model = "totally-wrong-model";
  const modelResult = validateFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: snap,
  });
  assert.equal(modelResult.ok, false);
  assert.ok(modelResult.errors.some((e) => e.code === "builtin-model-divergence"));

  const snap2 = structuredClone(liveAligned);
  snap2.builtIns.find((b) => b.key === "summarizer").instructions = "# wrong\n";
  const instrResult = validateFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: snap2,
  });
  assert.equal(instrResult.ok, false);
  assert.ok(instrResult.errors.some((e) => e.code === "builtin-instructions-divergence"));

  const snap3 = structuredClone(liveAligned);
  snap3.builtIns.find((b) => b.key === "summarizer").desiredSkills = ["only/one"];
  const skillsResult = validateFleet({
    packageDir: PACKAGE_DIR,
    desiredDir: DESIRED_DIR,
    liveSnapshot: snap3,
  });
  assert.equal(skillsResult.ok, false);
  assert.ok(skillsResult.errors.some((e) => e.code === "builtin-desired-skills-divergence"));
});
