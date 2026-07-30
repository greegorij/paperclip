import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { DESIRED_DIR, FIXTURES_DIR, PACKAGE_DIR } from "../lib/paths.mjs";
import { loadDesired } from "../lib/load.mjs";
import { generateCodexJarvisInstructions } from "../lib/codex-jarvis-instructions.mjs";
import {
  validateProviderProfilesDocument,
  planProviderProfileSwitch,
  previewProviderProfileSwitch,
  applyProviderProfileSwitch,
  rollbackProviderProfileSwitch,
} from "../lib/profile-switch.mjs";

const liveAligned = JSON.parse(
  readFileSync(path.join(FIXTURES_DIR, "live-aligned.json"), "utf8"),
);

const SWITCHABLE = [
  "analityk-biznesowy",
  "badacz",
  "czytacz-transkryptow",
  "designer-ui",
  "in-ynier-wdro-e",
  "jarvis",
  "konfigurator-systemu",
  "kronikarz",
  "krytyk",
  "kurator-crm",
  "kurator-vaultu",
  "mi-sie-vault",
  "modelarz-procesow",
  "obserwator-upstream",
  "senior-programista",
  "specjalista-deck-w",
  "specjalista-komunikacji-klienckiej",
  "specjalista-ofert",
  "szef-komercyjny",
  "zwiadowca-vaultu",
  "summarizer",
  "reflection-coach",
];
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
const OPENAI_RUNTIME_ENV = {
  ...process.env,
  JARVIS_CLAUDE_BOSS_INSTRUCTIONS_FILE: path.join(
    FIXTURES_DIR,
    "jarvis-paperclip-boss-CLAUDE.md",
  ),
};
const JARVIS_CODEX_BUNDLE_PATH = "AGENTS-CODEX.md";
const JARVIS_ANTHROPIC_BUNDLE_PATH = "AGENTS.md";
const JARVIS_COCKPIT_FILE = path.join(PACKAGE_DIR, "agents", "jarvis", "AGENTS.md");
const COMMITTED_JARVIS_CODEX_BUNDLE_CONTENT = readFileSync(
  path.join(PACKAGE_DIR, "agents", "jarvis", JARVIS_CODEX_BUNDLE_PATH),
  "utf8",
);
const HEADLESS_BOSS_FIXTURE_CONTENT = readFileSync(
  path.join(FIXTURES_DIR, "jarvis-paperclip-boss-CLAUDE.md"),
  "utf8",
);
const JARVIS_COCKPIT_CONTENT = readFileSync(JARVIS_COCKPIT_FILE, "utf8");

function makeBackupGate() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jarvis-switch-bak-"));
  const file = path.join(dir, "db.bak");
  writeFileSync(file, "backup-bytes");
  const sha = createHash("sha256").update("backup-bytes").digest("hex");
  return { backupFile: file, backupSha256: sha };
}

function ensureJarvisManagedInstructions(snapshot) {
  const jarvis = snapshot.agents?.find((agent) => agent.slug === "jarvis");
  if (!jarvis) return;
  const instructionsRootPath = path.join(os.tmpdir(), "jarvis-managed-instructions");
  jarvis.adapterConfig = {
    ...(jarvis.adapterConfig ?? {}),
    instructionsBundleMode: "managed",
    instructionsRootPath,
    instructionsEntryFile: "AGENTS.md",
    instructionsFilePath: path.join(instructionsRootPath, "AGENTS.md"),
  };
}

function setSwitchablePaused(snapshot) {
  for (const agent of snapshot.agents ?? []) {
    if (SWITCHABLE.includes(agent.slug)) agent.status = "paused";
  }
  ensureJarvisManagedInstructions(snapshot);
}

function applyPlanToSnapshot(snapshot, plan) {
  for (const step of plan.allAffected ?? []) {
    const live = snapshot.agents.find((agent) => agent.id === step.agentId);
    if (!live) continue;
    live.status = step.to.status;
    live.adapterType = step.to.adapterType;
    live.adapterConfig = structuredClone(step.to.adapterConfig);
    live.runtimeConfig = structuredClone(step.to.runtimeConfig);
  }
}

function createApiMock(
  snapshot,
  {
    failVerifyForSlug = null,
    failRollbackForSlug = null,
    activeRuns = [],
    failBundlePut = null,
    instructionsBundleState = {},
    orderLog = null,
    omitDesiredSkillsOnAgentGet = false,
    skillsDesiredSkillsBySlug = null,
    omitDesiredSkillsArrayOnSkillsGetForSlug = null,
  } = {},
) {
  const byId = new Map((snapshot.agents ?? []).map((agent) => [agent.id, structuredClone(agent)]));
  const patchCalls = [];
  const putCalls = [];
  const getCalls = [];
  const logOrder = (entry) => {
    if (Array.isArray(orderLog)) orderLog.push(entry);
  };
  const instructionsBundleByAgentId = new Map();
  for (const [agentId] of byId.entries()) {
    const files = new Map([[JARVIS_CODEX_BUNDLE_PATH, COMMITTED_JARVIS_CODEX_BUNDLE_CONTENT]]);
    const globalOverrides = instructionsBundleState?.["*"];
    const agentOverrides = instructionsBundleState?.[agentId];
    for (const overrides of [globalOverrides, agentOverrides]) {
      if (!overrides || typeof overrides !== "object") continue;
      for (const [filePath, fileContent] of Object.entries(overrides)) {
        if (fileContent == null) {
          files.delete(filePath);
        } else {
          files.set(filePath, String(fileContent));
        }
      }
    }
    instructionsBundleByAgentId.set(agentId, files);
  }
  return {
    dryRun: false,
    patchCalls,
    putCalls,
    getCalls,
    peekBySlug(slug) {
      for (const agent of byId.values()) {
        if (agent.slug === slug) return structuredClone(agent);
      }
      return null;
    },
    async get(url) {
      logOrder({ type: "get", url });
      getCalls.push({ url });
      if (url.startsWith("/api/companies/") && url.includes("/live-runs")) {
        return { ok: true, status: 200, data: activeRuns };
      }
      const bundleMatch = url.match(/^\/api\/agents\/([^/]+)\/instructions-bundle\/file(?:\?(.*))?$/);
      if (bundleMatch) {
        const agentId = bundleMatch[1];
        const agent = byId.get(agentId);
        if (!agent) return { ok: false, status: 404, data: null };
        const query = new URLSearchParams(bundleMatch[2] ?? "");
        const requestedPath = query.get("path");
        if (requestedPath !== JARVIS_CODEX_BUNDLE_PATH) {
          return { ok: false, status: 404, data: null };
        }
        const content = instructionsBundleByAgentId.get(agentId)?.get(requestedPath);
        if (content == null) return { ok: false, status: 404, data: null };
        return {
          ok: true,
          status: 200,
          data: { path: requestedPath, content },
        };
      }
      const skillsMatch = url.match(/^\/api\/agents\/([^/]+)\/skills$/);
      if (skillsMatch) {
        const agent = byId.get(skillsMatch[1]);
        if (!agent) return { ok: false, status: 404, data: null };
        if (omitDesiredSkillsArrayOnSkillsGetForSlug === agent.slug) {
          return { ok: true, status: 200, data: { entries: [] } };
        }
        if (
          skillsDesiredSkillsBySlug
          && Object.prototype.hasOwnProperty.call(skillsDesiredSkillsBySlug, agent.slug)
        ) {
          return {
            ok: true,
            status: 200,
            data: { desiredSkills: structuredClone(skillsDesiredSkillsBySlug[agent.slug]) },
          };
        }
        return {
          ok: true,
          status: 200,
          data: {
            desiredSkills: Array.isArray(agent.desiredSkills) ? [...agent.desiredSkills] : [],
          },
        };
      }
      const match = url.match(/^\/api\/agents\/([^/]+)$/);
      if (match) {
        const agent = byId.get(match[1]);
        if (!agent) return { ok: false, status: 404, data: null };
        const payload = structuredClone(agent);
        if (omitDesiredSkillsOnAgentGet) {
          delete payload.desiredSkills;
        }
        if (failVerifyForSlug && agent.slug === failVerifyForSlug) {
          return {
            ok: true,
            status: 200,
            data: {
              ...payload,
              adapterConfig: {
                ...(payload.adapterConfig ?? {}),
                model: "wrong-model",
              },
            },
          };
        }
        return { ok: true, status: 200, data: payload };
      }
      return { ok: false, status: 404, data: null };
    },
    async patch(url, body) {
      const match = url.match(/^\/api\/agents\/([^/]+)$/);
      if (!match) return { ok: false, status: 404, data: null };
      const agent = byId.get(match[1]);
      if (!agent) return { ok: false, status: 404, data: null };
      logOrder({ type: "patch", url, slug: agent.slug });
      patchCalls.push({ url, body, slug: agent.slug });
      if (
        failRollbackForSlug
        && agent.slug === failRollbackForSlug
        && body.adapterType === "codex_local"
      ) {
        return { ok: false, status: 500, data: null };
      }
      agent.status = body.status;
      agent.adapterType = body.adapterType;
      agent.adapterConfig = structuredClone(body.adapterConfig);
      agent.runtimeConfig = structuredClone(body.runtimeConfig);
      return { ok: true, status: 200, data: structuredClone(agent) };
    },
    async put(url, body) {
      logOrder({ type: "put", url });
      const bundleMatch = url.match(/^\/api\/agents\/([^/]+)\/instructions-bundle\/file(?:\?(.*))?$/);
      if (!bundleMatch) return { ok: false, status: 404, data: null };
      const agentId = bundleMatch[1];
      const agent = byId.get(agentId);
      if (!agent) return { ok: false, status: 404, data: null };
      const query = new URLSearchParams(bundleMatch[2] ?? "");
      const pathFromQuery = query.get("path");
      const pathFromBody = typeof body?.path === "string" ? body.path : null;
      const targetPath = pathFromBody ?? pathFromQuery;
      if (targetPath !== JARVIS_CODEX_BUNDLE_PATH) {
        return { ok: false, status: 404, data: null };
      }
      if (typeof body?.content !== "string") {
        return { ok: false, status: 404, data: null };
      }
      const failCfg = failBundlePut && typeof failBundlePut === "object"
        ? failBundlePut
        : (failBundlePut ? { status: 500, afterWrite: true } : null);
      const failStatus = Number.isInteger(failCfg?.status) ? failCfg.status : 500;
      const failAfterWrite = failCfg?.afterWrite !== false;
      if (failCfg && !failAfterWrite) {
        putCalls.push({ url, body, slug: agent.slug, failed: true, afterWrite: false });
        return { ok: false, status: failStatus, data: null };
      }
      if (!instructionsBundleByAgentId.has(agentId)) {
        instructionsBundleByAgentId.set(agentId, new Map());
      }
      instructionsBundleByAgentId.get(agentId).set(targetPath, body.content);
      const rootPath = typeof agent.adapterConfig?.instructionsRootPath === "string"
        ? agent.adapterConfig.instructionsRootPath.trim()
        : "";
      const writtenPath = rootPath
        ? path.join(rootPath, targetPath)
        : targetPath;
      agent.adapterConfig = {
        ...(agent.adapterConfig ?? {}),
        instructionsEntryFile: targetPath,
        instructionsFilePath: writtenPath,
      };
      putCalls.push({ url, body, slug: agent.slug, failed: Boolean(failCfg), afterWrite: true });
      if (failCfg) {
        return { ok: false, status: failStatus, data: null };
      }
      return {
        ok: true,
        status: 200,
        data: {
          path: targetPath,
          sizeBytes: Buffer.byteLength(body.content, "utf8"),
          updatedAt: new Date().toISOString(),
        },
      };
    },
  };
}

function buildRollbackPayloadFromSnapshot(snapshot, { companyId, profileName }) {
  return {
    schemaVersion: 1,
    kind: "jarvis-provider-profile-backup",
    companyId,
    profileName,
    capturedAt: new Date().toISOString(),
    snapshotCapturedAt: new Date().toISOString(),
    agents: SWITCHABLE.map((slug) => {
      const live = snapshot.agents.find((agent) => agent.slug === slug);
      return {
        agentId: live.id,
        slug,
        state: {
          status: live.status,
          adapterType: live.adapterType,
          adapterConfig: structuredClone(live.adapterConfig ?? {}),
          runtimeConfig: structuredClone(live.runtimeConfig ?? {}),
        },
      };
    }),
  };
}

test("profiles schema validates exact 22 switchable slugs and required mappings", () => {
  const desired = loadDesired(DESIRED_DIR);
  const profilesDoc = desired.profiles;
  const result = validateProviderProfilesDocument({ desired, profilesDoc });
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
  assert.equal(result.expectedSwitchable.length, 22);
  assert.deepEqual(
    result.expectedSwitchable,
    [...SWITCHABLE].sort(),
  );
});

test("generator is deterministic and committed AGENTS-CODEX parity stays exact", () => {
  const first = generateCodexJarvisInstructions({
    headlessBossClaude: HEADLESS_BOSS_FIXTURE_CONTENT,
    cockpitAgentsMd: JARVIS_COCKPIT_CONTENT,
  });
  const second = generateCodexJarvisInstructions({
    headlessBossClaude: HEADLESS_BOSS_FIXTURE_CONTENT,
    cockpitAgentsMd: JARVIS_COCKPIT_CONTENT,
  });
  assert.equal(first.content, second.content);
  assert.equal(first.content, COMMITTED_JARVIS_CODEX_BUNDLE_CONTENT);
  assert.ok(first.content.includes("BOOT ORKIESTRATORA"));
  assert.ok(first.content.includes("TASK ROUTER"));
  assert.ok(first.content.includes("Hard Rules"));
  assert.ok(first.content.includes("Piony i ich kierownicy"));
  assert.equal(first.content.includes("CLAUDE.md"), false);
  assert.equal(first.content.includes("cheap model"), false);
  assert.equal(first.content.includes("Haiku"), false);
  assert.equal(first.content.includes("Sonnet"), false);
  assert.equal(first.content.includes("Opus"), false);
  assert.equal(first.content.includes("/home/"), false);
  assert.equal(first.content.includes("/Users/"), false);
  assert.ok(first.content.includes("vault_read"));
  assert.ok(first.content.includes("01 - Jarvis/Jarvis — Boot Manifest.md"));
  assert.equal(first.content.includes("${JARVIS_VAULT_ROOT}/"), false);
  assert.equal(first.content.includes("Zapis — ZAWSZE apply_patch"), false);
  assert.ok(
    first.content.includes("deleguj do wyznaczonego agenta vaultu") ||
      first.content.includes("Kurator Vaultu"),
  );
});

test("generator fails closed when legacy direct vault path or write claims remain", () => {
  assert.throws(
    () =>
      generateCodexJarvisInstructions({
        headlessBossClaude: HEADLESS_BOSS_FIXTURE_CONTENT.replace(
          "## 🔴 VAULT — JAK PISAĆ (KRYTYCZNE)",
          "## 🔴 VAULT — JAK ZAPISYWAĆ (KRYTYCZNE)",
        ),
        cockpitAgentsMd: JARVIS_COCKPIT_CONTENT,
      }),
    /direct vault writes|direct JARVIS_VAULT_ROOT filesystem paths|Boot Manifest/,
  );
});

test("preview is fully non-mutating and offline", async () => {
  const snapshot = structuredClone(liveAligned);
  setSwitchablePaused(snapshot);
  const report = await previewProviderProfileSwitch({
    desiredDir: DESIRED_DIR,
    liveSnapshot: snapshot,
    profileName: "openai-first",
    runtimeEnv: {},
  });
  assert.equal(report.mode, "preview");
  assert.equal(report.summary.writes, 0);
  assert.ok(report.summary.planned > 0);
});

test("anthropic planning fails closed when worker config env var is absent", () => {
  const snapshot = structuredClone(liveAligned);
  setSwitchablePaused(snapshot);
  const plan = planProviderProfileSwitch({
    desiredDir: DESIRED_DIR,
    liveSnapshot: snapshot,
    profileName: "anthropic-first",
    runtimeEnv: {},
  });
  assert.equal(plan.ok, false);
  assert.ok(
    (plan.blockers ?? []).some((item) => item.includes("JARVIS_CLAUDE_WORKER_CONFIG_DIR")),
  );

  const blankPlan = planProviderProfileSwitch({
    desiredDir: DESIRED_DIR,
    liveSnapshot: snapshot,
    profileName: "anthropic-first",
    runtimeEnv: {
      ...process.env,
      JARVIS_CLAUDE_WORKER_CONFIG_DIR: "   ",
    },
  });
  assert.equal(blankPlan.ok, false);
  assert.ok(
    (blankPlan.blockers ?? []).some((item) => item.includes("non-empty absolute path")),
  );
});

test("anthropic planning fails closed when worker config env var is relative", () => {
  const snapshot = structuredClone(liveAligned);
  setSwitchablePaused(snapshot);
  const plan = planProviderProfileSwitch({
    desiredDir: DESIRED_DIR,
    liveSnapshot: snapshot,
    profileName: "anthropic-first",
    runtimeEnv: {
      ...process.env,
      JARVIS_CLAUDE_WORKER_CONFIG_DIR: "jarvis-claude-worker-config",
    },
  });
  assert.equal(plan.ok, false);
  assert.ok(
    (plan.blockers ?? []).some((item) => item.includes("non-empty absolute path")),
  );
});

test("anthropic planning fails closed when boss config env var is absent", () => {
  const snapshot = structuredClone(liveAligned);
  setSwitchablePaused(snapshot);
  const plan = planProviderProfileSwitch({
    desiredDir: DESIRED_DIR,
    liveSnapshot: snapshot,
    profileName: "anthropic-first",
    runtimeEnv: {
      ...ANTHROPIC_RUNTIME_ENV,
      JARVIS_CLAUDE_BOSS_CONFIG_DIR: undefined,
    },
  });
  assert.equal(plan.ok, false);
  assert.ok(
    (plan.blockers ?? []).some((item) => item.includes("JARVIS_CLAUDE_BOSS_CONFIG_DIR")),
  );
});

test("anthropic planning fails closed when boss config env var is relative", () => {
  const snapshot = structuredClone(liveAligned);
  setSwitchablePaused(snapshot);
  const plan = planProviderProfileSwitch({
    desiredDir: DESIRED_DIR,
    liveSnapshot: snapshot,
    profileName: "anthropic-first",
    runtimeEnv: {
      ...process.env,
      JARVIS_CLAUDE_WORKER_CONFIG_DIR: ANTHROPIC_RUNTIME_ENV.JARVIS_CLAUDE_WORKER_CONFIG_DIR,
      JARVIS_CLAUDE_BOSS_CONFIG_DIR: "jarvis-claude-boss-config",
    },
  });
  assert.equal(plan.ok, false);
  assert.ok(
    (plan.blockers ?? []).some((item) => item.includes("non-empty absolute path")),
  );
});

test("anthropic planning fails closed when worker config dir path does not exist", () => {
  const snapshot = structuredClone(liveAligned);
  setSwitchablePaused(snapshot);
  const missingWorkerDir = path.join(
    mkdtempSync(path.join(os.tmpdir(), "jarvis-claude-missing-")),
    "worker-does-not-exist",
  );
  const plan = planProviderProfileSwitch({
    desiredDir: DESIRED_DIR,
    liveSnapshot: snapshot,
    profileName: "anthropic-first",
    runtimeEnv: {
      ...ANTHROPIC_RUNTIME_ENV,
      JARVIS_CLAUDE_WORKER_CONFIG_DIR: missingWorkerDir,
    },
  });
  assert.equal(plan.ok, false);
  assert.ok(
    (plan.blockers ?? []).some(
      (item) => item.includes("JARVIS_CLAUDE_WORKER_CONFIG_DIR")
        && item.includes("does not exist"),
    ),
  );
  assert.equal((plan.blockers ?? []).join(" ").includes(missingWorkerDir), false);
});

test("anthropic planning fails closed when boss config path is a file", () => {
  const snapshot = structuredClone(liveAligned);
  setSwitchablePaused(snapshot);
  const dir = mkdtempSync(path.join(os.tmpdir(), "jarvis-claude-file-"));
  const bossFilePath = path.join(dir, "boss-config.txt");
  writeFileSync(bossFilePath, "not-a-directory");
  const plan = planProviderProfileSwitch({
    desiredDir: DESIRED_DIR,
    liveSnapshot: snapshot,
    profileName: "anthropic-first",
    runtimeEnv: {
      ...ANTHROPIC_RUNTIME_ENV,
      JARVIS_CLAUDE_BOSS_CONFIG_DIR: bossFilePath,
    },
  });
  assert.equal(plan.ok, false);
  assert.ok(
    (plan.blockers ?? []).some(
      (item) => item.includes("JARVIS_CLAUDE_BOSS_CONFIG_DIR")
        && item.includes("must point to a directory"),
    ),
  );
  assert.equal((plan.blockers ?? []).join(" ").includes(bossFilePath), false);
});

test("anthropic planning passes when worker and boss config dirs exist", () => {
  const snapshot = structuredClone(liveAligned);
  setSwitchablePaused(snapshot);
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "jarvis-claude-existing-"));
  const workerDir = path.join(rootDir, "worker");
  const bossDir = path.join(rootDir, "boss");
  mkdirSync(workerDir);
  mkdirSync(bossDir);
  const plan = planProviderProfileSwitch({
    desiredDir: DESIRED_DIR,
    liveSnapshot: snapshot,
    profileName: "anthropic-first",
    runtimeEnv: {
      ...ANTHROPIC_RUNTIME_ENV,
      JARVIS_CLAUDE_WORKER_CONFIG_DIR: workerDir,
      JARVIS_CLAUDE_BOSS_CONFIG_DIR: bossDir,
    },
  });
  assert.equal(plan.ok, true, JSON.stringify(plan.blockers, null, 2));
});

test("openai planning fails closed when jarvis instructions root is missing", () => {
  const snapshot = structuredClone(liveAligned);
  setSwitchablePaused(snapshot);
  const jarvis = snapshot.agents.find((agent) => agent.slug === "jarvis");
  delete jarvis.adapterConfig.instructionsRootPath;
  let plan;
  assert.doesNotThrow(() => {
    plan = planProviderProfileSwitch({
      desiredDir: DESIRED_DIR,
      liveSnapshot: snapshot,
      profileName: "openai-first",
    });
  });
  assert.equal(plan.ok, false);
  assert.ok(
    (plan.blockers ?? []).some((item) => item.includes("jarvis requires adapterConfig.instructionsRootPath")),
  );
});

test("apply refuses unsafe state before any write: active runs or unpaused switchable", async () => {
  const snapshot = structuredClone(liveAligned);
  setSwitchablePaused(snapshot);
  snapshot.agents.find((agent) => agent.slug === "jarvis").status = "idle";
  const api = createApiMock(snapshot, { activeRuns: [{ id: "run-1", status: "running" }] });
  const backup = makeBackupGate();
  const stateBackupFile = path.join(mkdtempSync(path.join(os.tmpdir(), "jarvis-state-")), "pre.json");
  const report = await applyProviderProfileSwitch({
    desiredDir: DESIRED_DIR,
    companyId: "company-jarvis",
    profileName: "openai-first",
    confirmProfile: "openai-first",
    backupGate: backup,
    stateBackupFile,
    api,
    liveSnapshot: snapshot,
  });
  assert.equal(report.ok, false);
  assert.equal(api.patchCalls.length, 0);
  assert.ok(report.failed.some((item) => item.step === "live-runs"));
});

test("openai plan preserves only managed bundle + paperclipSkillSync fields", () => {
  const snapshot = structuredClone(liveAligned);
  setSwitchablePaused(snapshot);
  const target = snapshot.agents.find((agent) => agent.slug === "badacz");
  target.adapterConfig = {
    model: "claude-sonnet-5",
    instructionsFilePath: "/srv/managed/AGENTS.md",
    instructionsBundleMode: "managed",
    paperclipSkillSync: { desiredSkills: ["paperclipai/paperclip/paperclip"] },
    cwd: "/unsafe/path",
    env: { OPENAI_API_KEY: "sk-live-secret" },
  };
  const plan = planProviderProfileSwitch({
    desiredDir: DESIRED_DIR,
    liveSnapshot: snapshot,
    profileName: "openai-first",
  });
  assert.equal(plan.ok, true, JSON.stringify(plan.blockers, null, 2));
  const step = plan.planned.find((item) => item.slug === "badacz");
  assert.ok(step);
  assert.equal(step.patch.replaceAdapterConfig, true);
  assert.equal(step.patch.status, "paused");
  assert.ok(step.patch.adapterConfig.instructionsFilePath);
  assert.ok(step.patch.adapterConfig.paperclipSkillSync);
  assert.equal(step.patch.adapterConfig.cwd, undefined);
  assert.equal(step.patch.adapterConfig.env, undefined);
});

test("anthropic plan sets full safe adapter config and drops stale codex fields", () => {
  const snapshot = structuredClone(liveAligned);
  setSwitchablePaused(snapshot);
  const target = snapshot.agents.find((agent) => agent.slug === "badacz");
  target.adapterConfig = {
    model: "gpt-5.6-sol",
    modelReasoningEffort: "high",
    fastMode: true,
    search: true,
    dangerouslyBypassApprovalsAndSandbox: true,
    filesystemWorkspaceAccess: "rw",
    extraArgs: ["--bad-flag"],
    outputInactivityTimeoutMs: 111,
    instructionsFilePath: "/srv/managed/AGENTS.md",
    paperclipSkillSync: { desiredSkills: ["paperclipai/paperclip/paperclip"] },
  };
  const plan = planProviderProfileSwitch({
    desiredDir: DESIRED_DIR,
    liveSnapshot: snapshot,
    profileName: "anthropic-first",
    runtimeEnv: ANTHROPIC_RUNTIME_ENV,
  });
  assert.equal(plan.ok, true, JSON.stringify(plan.blockers, null, 2));
  const step = plan.planned.find((item) => item.slug === "badacz");
  assert.ok(step);
  assert.deepEqual(step.patch.adapterConfig, {
    instructionsFilePath: "/srv/managed/AGENTS.md",
    paperclipSkillSync: { desiredSkills: ["paperclipai/paperclip/paperclip"] },
    engine: "cli",
    model: "claude-sonnet-5",
    maxTurnsPerRun: 30,
    dangerouslySkipPermissions: true,
    filesystemScope: "workspace",
    networkScope: "allowlist",
    networkAllowlist: ["api.anthropic.com", "statsig.anthropic.com", "sentry.io"],
    timeoutSec: 1200,
    graceSec: 15,
    chrome: false,
    env: {
      CLAUDE_CONFIG_DIR: {
        type: "plain",
        value: ANTHROPIC_RUNTIME_ENV.JARVIS_CLAUDE_WORKER_CONFIG_DIR,
      },
    },
  });
  assert.equal(step.patch.adapterConfig.modelReasoningEffort, undefined);
  assert.equal(step.patch.adapterConfig.fastMode, undefined);
  assert.equal(step.patch.adapterConfig.filesystemWorkspaceAccess, undefined);
  assert.equal(step.patch.adapterConfig.extraArgs, undefined);
});

test("jarvis target instructions and config profile are provider-specific", () => {
  const snapshot = structuredClone(liveAligned);
  setSwitchablePaused(snapshot);
  const rootPath = path.join(os.tmpdir(), "jarvis-managed-instructions");
  const jarvis = snapshot.agents.find((agent) => agent.slug === "jarvis");
  jarvis.adapterConfig.instructionsRootPath = rootPath;

  const openAiPlan = planProviderProfileSwitch({
    desiredDir: DESIRED_DIR,
    liveSnapshot: snapshot,
    profileName: "openai-first",
  });
  assert.equal(openAiPlan.ok, true, JSON.stringify(openAiPlan.blockers, null, 2));
  const openAiJarvis = openAiPlan.allAffected.find((item) => item.slug === "jarvis");
  assert.equal(openAiJarvis.to.adapterConfig.instructionsEntryFile, JARVIS_CODEX_BUNDLE_PATH);
  assert.equal(
    openAiJarvis.to.adapterConfig.instructionsFilePath,
    path.join(rootPath, JARVIS_CODEX_BUNDLE_PATH),
  );

  const anthropicPlan = planProviderProfileSwitch({
    desiredDir: DESIRED_DIR,
    liveSnapshot: snapshot,
    profileName: "anthropic-first",
    runtimeEnv: ANTHROPIC_RUNTIME_ENV,
  });
  assert.equal(anthropicPlan.ok, true, JSON.stringify(anthropicPlan.blockers, null, 2));
  const anthropicJarvis = anthropicPlan.allAffected.find((item) => item.slug === "jarvis");
  assert.equal(anthropicJarvis.to.adapterConfig.instructionsEntryFile, JARVIS_ANTHROPIC_BUNDLE_PATH);
  assert.equal(
    anthropicJarvis.to.adapterConfig.instructionsFilePath,
    path.join(rootPath, JARVIS_ANTHROPIC_BUNDLE_PATH),
  );
  assert.equal(
    anthropicJarvis.to.adapterConfig.env.CLAUDE_CONFIG_DIR.value,
    ANTHROPIC_RUNTIME_ENV.JARVIS_CLAUDE_BOSS_CONFIG_DIR,
  );
});

test("profiles schema rejects anthropic maxTurnsPerRun boundary violations and unknown fields", () => {
  const desired = loadDesired(DESIRED_DIR);
  const baseline = structuredClone(desired.profiles);
  const badHigh = structuredClone(baseline);
  const badJarvis = badHigh.profiles["anthropic-first"].agents.find((item) => item.slug === "jarvis");
  badJarvis.maxTurnsPerRun = 41;
  let result = validateProviderProfilesDocument({ desired, profilesDoc: badHigh });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.includes("jarvis") && item.includes("between 1 and 40")));

  const badField = structuredClone(baseline);
  const badSummarizer = badField.profiles["anthropic-first"].agents.find(
    (item) => item.slug === "summarizer",
  );
  badSummarizer.unexpectedToggle = true;
  result = validateProviderProfilesDocument({ desired, profilesDoc: badField });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.includes("unexpected fields unexpectedToggle")));
});

test("profiles schema enforces claudeConfigProfile: jarvis=boss and every other agent=worker", () => {
  const desired = loadDesired(DESIRED_DIR);
  const baseline = structuredClone(desired.profiles);
  const baselineResult = validateProviderProfilesDocument({ desired, profilesDoc: baseline });
  assert.equal(baselineResult.ok, true, JSON.stringify(baselineResult.errors, null, 2));

  const missing = structuredClone(baseline);
  delete missing.profiles["anthropic-first"].agents.find((item) => item.slug === "jarvis").claudeConfigProfile;
  let result = validateProviderProfilesDocument({ desired, profilesDoc: missing });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.includes("jarvis") && item.includes("must be boss")));

  const unknown = structuredClone(baseline);
  unknown.profiles["anthropic-first"].agents.find((item) => item.slug === "badacz").claudeConfigProfile = "unknown";
  result = validateProviderProfilesDocument({ desired, profilesDoc: unknown });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.includes("badacz") && item.includes("must be worker")));

  const wrong = structuredClone(baseline);
  wrong.profiles["anthropic-first"].agents.find((item) => item.slug === "jarvis").claudeConfigProfile = "worker";
  result = validateProviderProfilesDocument({ desired, profilesDoc: wrong });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.includes("jarvis") && item.includes("must be boss")));
});

test("apply never resumes agents and idempotent reapply makes zero writes", async () => {
  const base = structuredClone(liveAligned);
  setSwitchablePaused(base);
  const firstPlan = planProviderProfileSwitch({
    desiredDir: DESIRED_DIR,
    liveSnapshot: base,
    profileName: "openai-first",
  });
  assert.equal(firstPlan.ok, true);
  applyPlanToSnapshot(base, firstPlan);
  const secondPlan = planProviderProfileSwitch({
    desiredDir: DESIRED_DIR,
    liveSnapshot: base,
    profileName: "openai-first",
  });
  assert.equal(secondPlan.ok, true);
  assert.equal(secondPlan.planned.length, 0);
  assert.ok(secondPlan.allAffected.every((item) => item.to.status === "paused"));
});

test("openai apply exact bundle makes zero PUT and zero agent PATCH on no-plan", async () => {
  const snapshot = structuredClone(liveAligned);
  setSwitchablePaused(snapshot);
  const openAiPlan = planProviderProfileSwitch({
    desiredDir: DESIRED_DIR,
    liveSnapshot: snapshot,
    profileName: "openai-first",
  });
  assert.equal(openAiPlan.ok, true, JSON.stringify(openAiPlan.blockers, null, 2));
  applyPlanToSnapshot(snapshot, openAiPlan);
  const noPlan = planProviderProfileSwitch({
    desiredDir: DESIRED_DIR,
    liveSnapshot: snapshot,
    profileName: "openai-first",
  });
  assert.equal(noPlan.ok, true);
  assert.equal(noPlan.planned.length, 0);

  const api = createApiMock(snapshot);
  const backup = makeBackupGate();
  const stateBackupFile = path.join(mkdtempSync(path.join(os.tmpdir(), "jarvis-state-")), "pre.json");
  const report = await applyProviderProfileSwitch({
    desiredDir: DESIRED_DIR,
    companyId: "company-jarvis",
    profileName: "openai-first",
    confirmProfile: "openai-first",
    backupGate: backup,
    stateBackupFile,
    api,
    liveSnapshot: snapshot,
    runtimeEnv: OPENAI_RUNTIME_ENV,
  });
  assert.equal(report.ok, true, JSON.stringify(report.failed, null, 2));
  assert.equal(api.putCalls.length, 0);
  assert.equal(api.patchCalls.length, 0);
});

test("openai apply uploads missing bundle before first agent patch and verifies GET", async () => {
  const snapshot = structuredClone(liveAligned);
  setSwitchablePaused(snapshot);
  const orderLog = [];
  const api = createApiMock(snapshot, {
    instructionsBundleState: { "*": { [JARVIS_CODEX_BUNDLE_PATH]: null } },
    orderLog,
  });
  const backup = makeBackupGate();
  const stateBackupFile = path.join(mkdtempSync(path.join(os.tmpdir(), "jarvis-state-")), "pre.json");
  const report = await applyProviderProfileSwitch({
    desiredDir: DESIRED_DIR,
    companyId: "company-jarvis",
    profileName: "openai-first",
    confirmProfile: "openai-first",
    backupGate: backup,
    stateBackupFile,
    api,
    liveSnapshot: snapshot,
    runtimeEnv: OPENAI_RUNTIME_ENV,
  });
  assert.equal(report.ok, true, JSON.stringify(report.failed, null, 2));
  assert.equal(api.putCalls.length, 1);
  assert.equal(api.putCalls[0].body.path, JARVIS_CODEX_BUNDLE_PATH);
  assert.equal(api.putCalls[0].body.content, COMMITTED_JARVIS_CODEX_BUNDLE_CONTENT);
  const putIndex = orderLog.findIndex((entry) => entry.type === "put");
  const firstPatchIndex = orderLog.findIndex((entry) => entry.type === "patch");
  assert.ok(putIndex >= 0);
  assert.ok(firstPatchIndex > putIndex);
  assert.ok(
    orderLog.some(
      (entry, idx) => entry.type === "get"
        && idx > putIndex
        && String(entry.url).includes("/instructions-bundle/file"),
    ),
  );
});

test("openai apply bundle PUT failure does not run profile PATCH and triggers rollback attempt", async () => {
  const snapshot = structuredClone(liveAligned);
  setSwitchablePaused(snapshot);
  const api = createApiMock(snapshot, {
    failBundlePut: { status: 500, afterWrite: true },
    instructionsBundleState: { "*": { [JARVIS_CODEX_BUNDLE_PATH]: null } },
  });
  const backup = makeBackupGate();
  const stateBackupFile = path.join(mkdtempSync(path.join(os.tmpdir(), "jarvis-state-")), "pre.json");
  const report = await applyProviderProfileSwitch({
    desiredDir: DESIRED_DIR,
    companyId: "company-jarvis",
    profileName: "openai-first",
    confirmProfile: "openai-first",
    backupGate: backup,
    stateBackupFile,
    api,
    liveSnapshot: snapshot,
    runtimeEnv: OPENAI_RUNTIME_ENV,
  });
  assert.equal(report.ok, false);
  assert.ok(report.failed.some((item) => item.step === "jarvis-codex-upload"));
  assert.equal(api.patchCalls.some((call) => call.body.adapterType === "codex_local"), false);
  assert.ok(api.patchCalls.some((call) => call.slug === "jarvis"));
});

test("openai apply later patch failure restores exact pre-upload jarvis config", async () => {
  const snapshot = structuredClone(liveAligned);
  setSwitchablePaused(snapshot);
  const baselineJarvis = structuredClone(snapshot.agents.find((agent) => agent.slug === "jarvis"));
  baselineJarvis.runtimeConfig = structuredClone(baselineJarvis.runtimeConfig ?? {});
  const api = createApiMock(snapshot, {
    failRollbackForSlug: "badacz",
    instructionsBundleState: { "*": { [JARVIS_CODEX_BUNDLE_PATH]: null } },
  });
  const backup = makeBackupGate();
  const stateBackupFile = path.join(mkdtempSync(path.join(os.tmpdir(), "jarvis-state-")), "pre.json");
  const report = await applyProviderProfileSwitch({
    desiredDir: DESIRED_DIR,
    companyId: "company-jarvis",
    profileName: "openai-first",
    confirmProfile: "openai-first",
    backupGate: backup,
    stateBackupFile,
    api,
    liveSnapshot: snapshot,
    runtimeEnv: OPENAI_RUNTIME_ENV,
  });
  assert.equal(report.ok, false);
  assert.equal(api.putCalls.length, 1);
  assert.ok(report.failed.some((item) => item.step === "patch" && item.slug === "badacz"));
  const restoredJarvis = api.peekBySlug("jarvis");
  assert.deepEqual(restoredJarvis, baselineJarvis);
});

test("openai no-plan still uploads and verifies missing bundle", async () => {
  const snapshot = structuredClone(liveAligned);
  setSwitchablePaused(snapshot);
  const openAiPlan = planProviderProfileSwitch({
    desiredDir: DESIRED_DIR,
    liveSnapshot: snapshot,
    profileName: "openai-first",
  });
  assert.equal(openAiPlan.ok, true, JSON.stringify(openAiPlan.blockers, null, 2));
  applyPlanToSnapshot(snapshot, openAiPlan);
  const api = createApiMock(snapshot, {
    instructionsBundleState: { "*": { [JARVIS_CODEX_BUNDLE_PATH]: null } },
  });
  const backup = makeBackupGate();
  const stateBackupFile = path.join(mkdtempSync(path.join(os.tmpdir(), "jarvis-state-")), "pre.json");
  const report = await applyProviderProfileSwitch({
    desiredDir: DESIRED_DIR,
    companyId: "company-jarvis",
    profileName: "openai-first",
    confirmProfile: "openai-first",
    backupGate: backup,
    stateBackupFile,
    api,
    liveSnapshot: snapshot,
    runtimeEnv: OPENAI_RUNTIME_ENV,
  });
  assert.equal(report.ok, true, JSON.stringify(report.failed, null, 2));
  assert.equal(api.putCalls.length, 1);
  assert.equal(api.patchCalls.length, 0);
  assert.ok(api.getCalls.some((call) => call.url.includes("/instructions-bundle/file")));
});

test("apply rolls back badacz after verify failure when only badacz is forced", async () => {
  const snapshot = structuredClone(liveAligned);
  setSwitchablePaused(snapshot);
  const badacz = snapshot.agents.find((agent) => agent.slug === "badacz");
  badacz.adapterType = "codex_local";
  badacz.adapterConfig = { model: "wrong-model" };
  badacz.runtimeConfig = {};

  const baselineBadacz = structuredClone(badacz);
  const api = createApiMock(snapshot, {
    failVerifyForSlug: "badacz",
  });
  const backup = makeBackupGate();
  const stateBackupFile = path.join(mkdtempSync(path.join(os.tmpdir(), "jarvis-state-")), "pre.json");
  const report = await applyProviderProfileSwitch({
    desiredDir: DESIRED_DIR,
    companyId: "company-jarvis",
    profileName: "anthropic-first",
    confirmProfile: "anthropic-first",
    backupGate: backup,
    stateBackupFile,
    api,
    liveSnapshot: snapshot,
    runtimeEnv: ANTHROPIC_RUNTIME_ENV,
  });
  assert.equal(report.ok, false);
  assert.ok(api.patchCalls.some((call) => call.slug === "badacz" && call.body.adapterType === "claude_local"));
  assert.ok(report.failed.some((item) => item.step === "patch" && item.slug === "badacz"));
  assert.ok(report.rolledBack.some((item) => item.slug === "badacz"));
  const restoredBadacz = api.peekBySlug("badacz");
  assert.deepEqual(restoredBadacz, baselineBadacz);
});

test("apply records czytacz rollback failure but still rolls back badacz", async () => {
  const snapshot = structuredClone(liveAligned);
  setSwitchablePaused(snapshot);
  const badacz = snapshot.agents.find((agent) => agent.slug === "badacz");
  const czytacz = snapshot.agents.find((agent) => agent.slug === "czytacz-transkryptow");
  badacz.adapterType = "codex_local";
  badacz.adapterConfig = { model: "gpt-5.6-sol" };
  badacz.runtimeConfig = {};
  czytacz.adapterType = "codex_local";
  czytacz.adapterConfig = { model: "gpt-5.6-sol" };
  czytacz.runtimeConfig = {};

  const baselineBadacz = structuredClone(badacz);
  const api = createApiMock(snapshot, {
    failVerifyForSlug: "czytacz-transkryptow",
    failRollbackForSlug: "czytacz-transkryptow",
  });
  const backup = makeBackupGate();
  const stateBackupFile = path.join(mkdtempSync(path.join(os.tmpdir(), "jarvis-state-")), "pre.json");
  const report = await applyProviderProfileSwitch({
    desiredDir: DESIRED_DIR,
    companyId: "company-jarvis",
    profileName: "anthropic-first",
    confirmProfile: "anthropic-first",
    backupGate: backup,
    stateBackupFile,
    api,
    liveSnapshot: snapshot,
    runtimeEnv: ANTHROPIC_RUNTIME_ENV,
  });
  assert.equal(report.ok, false);
  assert.ok(report.failed.some((item) => item.step === "patch" && item.slug === "czytacz-transkryptow"));
  assert.ok(report.failed.some((item) => item.step === "auto-rollback" && item.slug === "czytacz-transkryptow"));
  assert.ok(report.rolledBack.some((item) => item.slug === "badacz"));
  const restoredBadacz = api.peekBySlug("badacz");
  assert.deepEqual(restoredBadacz, baselineBadacz);
});

test("explicit rollback restores all backup agents and verifies each", async () => {
  const snapshot = structuredClone(liveAligned);
  setSwitchablePaused(snapshot);
  const backupPayload = buildRollbackPayloadFromSnapshot(snapshot, {
    companyId: "company-jarvis",
    profileName: "openai-first",
  });
  const dir = mkdtempSync(path.join(os.tmpdir(), "jarvis-rollback-"));
  const rollbackFile = path.join(dir, "rollback.json");
  writeFileSync(rollbackFile, JSON.stringify(backupPayload, null, 2));
  const rollbackGate = makeBackupGate();
  const api = createApiMock(snapshot);
  const report = await rollbackProviderProfileSwitch({
    companyId: "company-jarvis",
    backupFile: rollbackFile,
    backupGate: rollbackGate,
    api,
    liveSnapshot: snapshot,
  });
  assert.equal(report.ok, true, JSON.stringify(report.failed, null, 2));
  assert.equal(report.completed.length, 22);
});

test("rollback validates backup companyId against requested company", async () => {
  const snapshot = structuredClone(liveAligned);
  setSwitchablePaused(snapshot);
  const backupPayload = buildRollbackPayloadFromSnapshot(snapshot, {
    companyId: "wrong-company",
    profileName: "openai-first",
  });
  const dir = mkdtempSync(path.join(os.tmpdir(), "jarvis-rollback-"));
  const rollbackFile = path.join(dir, "rollback-company-mismatch.json");
  writeFileSync(rollbackFile, JSON.stringify(backupPayload, null, 2));
  const rollbackGate = makeBackupGate();
  const api = createApiMock(snapshot);
  const report = await rollbackProviderProfileSwitch({
    companyId: "company-jarvis",
    backupFile: rollbackFile,
    backupGate: rollbackGate,
    api,
    liveSnapshot: snapshot,
  });
  assert.equal(report.ok, false);
  assert.ok(report.failed.some((item) => item.step === "backup-validate"));
});

test("rollback validates expected slug set and live slug-to-agentId match", async () => {
  const snapshot = structuredClone(liveAligned);
  setSwitchablePaused(snapshot);
  const backupPayload = buildRollbackPayloadFromSnapshot(snapshot, {
    companyId: "company-jarvis",
    profileName: "openai-first",
  });
  backupPayload.agents[0].slug = "scout";
  const dir = mkdtempSync(path.join(os.tmpdir(), "jarvis-rollback-"));
  const rollbackFile = path.join(dir, "rollback-slug-mismatch.json");
  writeFileSync(rollbackFile, JSON.stringify(backupPayload, null, 2));
  const rollbackGate = makeBackupGate();
  const api = createApiMock(snapshot);
  const report = await rollbackProviderProfileSwitch({
    companyId: "company-jarvis",
    backupFile: rollbackFile,
    backupGate: rollbackGate,
    api,
    liveSnapshot: snapshot,
  });
  assert.equal(report.ok, false);
  assert.ok(report.failed.some((item) => item.step === "backup-validate"));
});

test("profile-switch output redacts secrets", async () => {
  const snapshot = structuredClone(liveAligned);
  setSwitchablePaused(snapshot);
  snapshot.agents.find((agent) => agent.slug === "jarvis").adapterConfig = {
    model: "claude-opus-5",
    apiKey: "sk-live-secret-value",
  };
  const report = await previewProviderProfileSwitch({
    desiredDir: DESIRED_DIR,
    liveSnapshot: snapshot,
    profileName: "openai-first",
  });
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("sk-live-secret-value"), false);
});

test("anthropic apply fails closed without worker config env before any writes", async () => {
  const snapshot = structuredClone(liveAligned);
  setSwitchablePaused(snapshot);
  const api = createApiMock(snapshot);
  const backup = makeBackupGate();
  const stateBackupFile = path.join(mkdtempSync(path.join(os.tmpdir(), "jarvis-state-")), "pre.json");
  const report = await applyProviderProfileSwitch({
    desiredDir: DESIRED_DIR,
    companyId: "company-jarvis",
    profileName: "anthropic-first",
    confirmProfile: "anthropic-first",
    backupGate: backup,
    stateBackupFile,
    api,
    liveSnapshot: snapshot,
    runtimeEnv: {},
  });
  assert.equal(report.ok, false);
  assert.equal(api.patchCalls.length, 0);
  assert.ok(report.failed.some((item) => item.step === "plan"));
  assert.ok(report.failed.some((item) => String(item.error).includes("JARVIS_CLAUDE_WORKER_CONFIG_DIR")));
});

test("state backup file is private (0600) during apply", async () => {
  const snapshot = structuredClone(liveAligned);
  setSwitchablePaused(snapshot);
  const jarvis = snapshot.agents.find((agent) => agent.slug === "jarvis");
  jarvis.adapterType = "claude_local";
  jarvis.adapterConfig = { model: "claude-opus-5" };
  jarvis.runtimeConfig = {};
  ensureJarvisManagedInstructions(snapshot);
  const backup = makeBackupGate();
  const stateBackupFile = path.join(
    mkdtempSync(path.join(os.tmpdir(), "jarvis-state-private-")),
    "state.json",
  );
  const api = createApiMock(snapshot);
  const report = await applyProviderProfileSwitch({
    desiredDir: DESIRED_DIR,
    companyId: "company-jarvis",
    profileName: "openai-first",
    confirmProfile: "openai-first",
    backupGate: backup,
    stateBackupFile,
    api,
    liveSnapshot: snapshot,
    runtimeEnv: OPENAI_RUNTIME_ENV,
  });
  assert.equal(report.ok, true, JSON.stringify(report.failed, null, 2));
  const mode = statSync(stateBackupFile).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("apply backup keeps exact secret_ref for rollback while report remains redacted", async () => {
  const snapshot = structuredClone(liveAligned);
  setSwitchablePaused(snapshot);
  const anthropicPlan = planProviderProfileSwitch({
    desiredDir: DESIRED_DIR,
    liveSnapshot: snapshot,
    profileName: "anthropic-first",
    runtimeEnv: ANTHROPIC_RUNTIME_ENV,
  });
  assert.equal(anthropicPlan.ok, true, JSON.stringify(anthropicPlan.blockers, null, 2));
  applyPlanToSnapshot(snapshot, anthropicPlan);
  const badacz = snapshot.agents.find((agent) => agent.slug === "badacz");
  const czytacz = snapshot.agents.find((agent) => agent.slug === "czytacz-transkryptow");
  const secretRefValue = "secret://companies/company-jarvis/openai-api-key";
  badacz.adapterType = "codex_local";
  badacz.adapterConfig = {
    model: "gpt-5.6-sol",
    env: {
      OPENAI_API_KEY: {
        type: "secret_ref",
        secretRef: secretRefValue,
      },
    },
  };
  badacz.runtimeConfig = { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } };
  czytacz.adapterType = "codex_local";
  czytacz.adapterConfig = { model: "gpt-5.6-sol" };
  czytacz.runtimeConfig = { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } };

  const api = createApiMock(snapshot, { failVerifyForSlug: "czytacz-transkryptow" });
  const backup = makeBackupGate();
  const stateBackupFile = path.join(
    mkdtempSync(path.join(os.tmpdir(), "jarvis-state-secret-ref-")),
    "state.json",
  );
  const report = await applyProviderProfileSwitch({
    desiredDir: DESIRED_DIR,
    companyId: "company-jarvis",
    profileName: "anthropic-first",
    confirmProfile: "anthropic-first",
    backupGate: backup,
    stateBackupFile,
    api,
    liveSnapshot: snapshot,
    runtimeEnv: ANTHROPIC_RUNTIME_ENV,
  });
  assert.equal(report.ok, false);
  assert.ok(report.rolledBack.some((item) => item.slug === "badacz"));
  const forwardPatchSlugs = api.patchCalls
    .filter((call) => call.body.adapterType === "claude_local")
    .map((call) => call.slug);
  assert.deepEqual(forwardPatchSlugs.slice(0, 2), ["badacz", "czytacz-transkryptow"]);

  const savedBackup = JSON.parse(readFileSync(stateBackupFile, "utf8"));
  const savedBadacz = savedBackup.agents.find((row) => row.slug === "badacz");
  assert.equal(
    savedBadacz.state.adapterConfig.env.OPENAI_API_KEY.secretRef,
    secretRefValue,
  );

  const rollbackCall = api.patchCalls.find(
    (call) => call.slug === "badacz" && call.body.adapterType === "codex_local",
  );
  assert.ok(rollbackCall);
  assert.deepEqual(rollbackCall.body.adapterConfig, savedBadacz.state.adapterConfig);

  const serializedReport = JSON.stringify(report);
  assert.equal(serializedReport.includes(secretRefValue), false);
});

test("apply verify uses skills GET when agent GET omits desiredSkills", async () => {
  const snapshot = structuredClone(liveAligned);
  setSwitchablePaused(snapshot);
  const badacz = snapshot.agents.find((agent) => agent.slug === "badacz");
  const preservedSkills = [
    "paperclipai/paperclip/paperclip",
    "paperclipai/paperclip/paperclip-converting-plans-to-tasks",
    "local/59da7d4268/research",
  ];
  badacz.desiredSkills = [...preservedSkills];
  badacz.adapterType = "codex_local";
  badacz.adapterConfig = { model: "wrong-model" };
  badacz.runtimeConfig = {};

  const api = createApiMock(snapshot, {
    omitDesiredSkillsOnAgentGet: true,
  });
  const backup = makeBackupGate();
  const stateBackupFile = path.join(mkdtempSync(path.join(os.tmpdir(), "jarvis-state-")), "pre.json");
  const report = await applyProviderProfileSwitch({
    desiredDir: DESIRED_DIR,
    companyId: "company-jarvis",
    profileName: "anthropic-first",
    confirmProfile: "anthropic-first",
    backupGate: backup,
    stateBackupFile,
    api,
    liveSnapshot: snapshot,
    runtimeEnv: ANTHROPIC_RUNTIME_ENV,
  });
  assert.equal(report.ok, true, JSON.stringify(report.failed, null, 2));
  assert.ok(api.patchCalls.some((call) => call.slug === "badacz" && call.body.adapterType === "claude_local"));
  assert.ok(
    api.getCalls.some((call) => String(call.url).match(/^\/api\/agents\/[^/]+\/skills$/)),
  );
  assert.ok(api.getCalls.some((call) => String(call.url).match(/^\/api\/agents\/[^/]+$/)));
  assert.deepEqual(api.peekBySlug("badacz").desiredSkills, preservedSkills);
});

test("apply fails closed when skills GET drifts from planned desiredSkills", async () => {
  const snapshot = structuredClone(liveAligned);
  setSwitchablePaused(snapshot);
  const badacz = snapshot.agents.find((agent) => agent.slug === "badacz");
  badacz.desiredSkills = [
    "paperclipai/paperclip/paperclip",
    "local/59da7d4268/research",
  ];
  badacz.adapterType = "codex_local";
  badacz.adapterConfig = { model: "wrong-model" };
  badacz.runtimeConfig = {};
  const baselineBadacz = structuredClone(badacz);

  const api = createApiMock(snapshot, {
    omitDesiredSkillsOnAgentGet: true,
    skillsDesiredSkillsBySlug: {
      badacz: ["paperclipai/paperclip/paperclip"],
    },
  });
  const backup = makeBackupGate();
  const stateBackupFile = path.join(mkdtempSync(path.join(os.tmpdir(), "jarvis-state-")), "pre.json");
  const report = await applyProviderProfileSwitch({
    desiredDir: DESIRED_DIR,
    companyId: "company-jarvis",
    profileName: "anthropic-first",
    confirmProfile: "anthropic-first",
    backupGate: backup,
    stateBackupFile,
    api,
    liveSnapshot: snapshot,
    runtimeEnv: ANTHROPIC_RUNTIME_ENV,
  });
  assert.equal(report.ok, false);
  assert.ok(
    report.failed.some(
      (item) => item.step === "patch"
        && item.slug === "badacz"
        && String(item.error).includes("desiredSkills drift"),
    ),
  );
  assert.ok(report.rolledBack.some((item) => item.slug === "badacz"));
  assert.deepEqual(api.peekBySlug("badacz"), baselineBadacz);
});

test("apply fails closed when skills GET is missing desiredSkills array", async () => {
  const snapshot = structuredClone(liveAligned);
  setSwitchablePaused(snapshot);
  const badacz = snapshot.agents.find((agent) => agent.slug === "badacz");
  badacz.desiredSkills = [
    "paperclipai/paperclip/paperclip",
    "local/59da7d4268/research",
  ];
  badacz.adapterType = "codex_local";
  badacz.adapterConfig = { model: "wrong-model" };
  badacz.runtimeConfig = {};
  const baselineBadacz = structuredClone(badacz);

  const api = createApiMock(snapshot, {
    omitDesiredSkillsOnAgentGet: true,
    omitDesiredSkillsArrayOnSkillsGetForSlug: "badacz",
  });
  const backup = makeBackupGate();
  const stateBackupFile = path.join(mkdtempSync(path.join(os.tmpdir(), "jarvis-state-")), "pre.json");
  const report = await applyProviderProfileSwitch({
    desiredDir: DESIRED_DIR,
    companyId: "company-jarvis",
    profileName: "anthropic-first",
    confirmProfile: "anthropic-first",
    backupGate: backup,
    stateBackupFile,
    api,
    liveSnapshot: snapshot,
    runtimeEnv: ANTHROPIC_RUNTIME_ENV,
  });
  assert.equal(report.ok, false);
  assert.ok(
    report.failed.some(
      (item) => item.step === "patch"
        && item.slug === "badacz"
        && String(item.error).includes("desiredSkills missing from skills verify GET"),
    ),
  );
  assert.ok(report.rolledBack.some((item) => item.slug === "badacz"));
  assert.deepEqual(api.peekBySlug("badacz"), baselineBadacz);
});
