import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { DESIRED_DIR, FIXTURES_DIR, PACKAGE_DIR } from "../lib/paths.mjs";
import { loadDesired } from "../lib/load.mjs";
import {
  applyRuntimeCapabilitiesToAdapterConfig,
  loadValidatedRuntimeCapabilities,
  mergeNetworkAllowlist,
  validateRuntimeCapabilitiesDocument,
} from "../lib/runtime-capabilities.mjs";
import { planProviderProfileSwitch } from "../lib/profile-switch.mjs";

const liveAligned = JSON.parse(
  readFileSync(path.join(FIXTURES_DIR, "live-aligned.json"), "utf8"),
);

const ANTHROPIC_RUNTIME_ENV = {
  ...process.env,
  ...(() => {
    const rootDir = mkdtempSync(path.join(os.tmpdir(), "jarvis-rc-claude-"));
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

const KONFIGURATOR_PATHS = [
  "/home/ccuser/.local/agent-tools",
  "/home/ccuser/.agent-browser/browsers",
];
const KONFIGURATOR_HOSTS = ["workos.grzegorzgolas.com", "frappe.grzegorzgolas.com"];
const POLYGON_HOST = KONFIGURATOR_HOSTS[0];
const PACKAGE_AGENTS_MD = path.join(
  PACKAGE_DIR,
  "agents",
  "konfigurator-systemu",
  "AGENTS.md",
);

function writeCapabilities(dir, doc) {
  writeFileSync(path.join(dir, "runtime-capabilities.json"), `${JSON.stringify(doc, null, 2)}\n`);
}

function setPausedSwitchable(snapshot) {
  const switchable = new Set([
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
  ]);
  for (const agent of snapshot.agents ?? []) {
    if (switchable.has(agent.slug)) agent.status = "paused";
  }
  const jarvis = snapshot.agents?.find((agent) => agent.slug === "jarvis");
  if (jarvis) {
    const instructionsRootPath = path.join(os.tmpdir(), "jarvis-managed-instructions");
    jarvis.adapterConfig = {
      ...(jarvis.adapterConfig ?? {}),
      instructionsBundleMode: "managed",
      instructionsRootPath,
      instructionsEntryFile: "AGENTS.md",
      instructionsFilePath: path.join(instructionsRootPath, "AGENTS.md"),
    };
  }
}

test("committed runtime-capabilities.json validates and grants only konfigurator", () => {
  const loaded = loadValidatedRuntimeCapabilities(DESIRED_DIR, {
    knownSlugs: [
      ...(loadDesired(DESIRED_DIR).agents?.agents ?? []).map((a) => a.slug),
      "summarizer",
      "reflection-coach",
    ],
  });
  assert.equal(loaded.ok, true, JSON.stringify(loaded.errors, null, 2));
  assert.equal(loaded.bySlug.size, 1);
  const cap = loaded.bySlug.get("konfigurator-systemu");
  assert.ok(cap);
  assert.deepEqual(cap.filesystemExtraPaths, KONFIGURATOR_PATHS);
  assert.deepEqual(cap.networkAllowlistAdditions, KONFIGURATOR_HOSTS);
});

test("validation fails closed on forbidden model/adapter/base-allowlist fields", () => {
  const base = {
    schemaVersion: 1,
    agents: {
      "konfigurator-systemu": {
        filesystemExtraPaths: KONFIGURATOR_PATHS,
        networkAllowlistAdditions: KONFIGURATOR_HOSTS,
      },
    },
  };
  for (const field of ["model", "adapterType", "networkAllowlist", "adapter"]) {
    const doc = structuredClone(base);
    doc.agents["konfigurator-systemu"][field] = field === "networkAllowlist" ? ["evil.com"] : "x";
    const result = validateRuntimeCapabilitiesDocument(doc);
    assert.equal(result.ok, false, field);
    assert.ok(
      result.errors.some((item) => item.includes(`"${field}"`) && item.includes("forbidden")),
      JSON.stringify(result.errors),
    );
  }
});

test("validation rejects rw filesystem paths and non-hostname additions", () => {
  const rw = validateRuntimeCapabilitiesDocument({
    schemaVersion: 1,
    agents: {
      "konfigurator-systemu": {
        filesystemExtraPaths: [{ path: "/home/ccuser/.local/agent-tools", access: "rw" }],
      },
    },
  });
  assert.equal(rw.ok, false);
  assert.ok(rw.errors.some((item) => item.includes("read-only")));

  const badHost = validateRuntimeCapabilitiesDocument({
    schemaVersion: 1,
    agents: {
      "konfigurator-systemu": {
        networkAllowlistAdditions: ["https://workos.grzegorzgolas.com/path", "*.evil.com"],
      },
    },
  });
  assert.equal(badHost.ok, false);
  assert.ok(badHost.errors.some((item) => item.includes("hostnames")));
});

test("mergeNetworkAllowlist preserves provider base order and drops duplicates", () => {
  assert.deepEqual(
    mergeNetworkAllowlist(
      ["api.openai.com", "auth.openai.com"],
      ["workos.grzegorzgolas.com", "api.openai.com", "Workos.Grzegorzgolas.com"],
    ),
    ["api.openai.com", "auth.openai.com", "workos.grzegorzgolas.com"],
  );
});

test("applyRuntimeCapabilitiesToAdapterConfig is additive only", () => {
  const base = {
    model: "gpt-5.6-terra",
    networkAllowlist: ["api.openai.com"],
  };
  const out = applyRuntimeCapabilitiesToAdapterConfig(base, {
    filesystemExtraPaths: KONFIGURATOR_PATHS,
    networkAllowlistAdditions: KONFIGURATOR_HOSTS,
  });
  assert.equal(out.model, "gpt-5.6-terra");
  assert.deepEqual(out.filesystemExtraPaths, KONFIGURATOR_PATHS);
  assert.deepEqual(out.networkAllowlist, ["api.openai.com", ...KONFIGURATOR_HOSTS]);
  assert.deepEqual(base.networkAllowlist, ["api.openai.com"]);
});

test("profile-switch attaches capabilities to konfigurator in both profiles and not to peers", () => {
  const snapshot = structuredClone(liveAligned);
  setPausedSwitchable(snapshot);

  for (const profileName of ["openai-first", "anthropic-first"]) {
    const plan = planProviderProfileSwitch({
      desiredDir: DESIRED_DIR,
      liveSnapshot: snapshot,
      profileName,
      runtimeEnv: profileName === "anthropic-first" ? ANTHROPIC_RUNTIME_ENV : process.env,
    });
    assert.equal(plan.ok, true, JSON.stringify(plan.blockers, null, 2));
    const konfigurator = plan.allAffected.find((item) => item.slug === "konfigurator-systemu");
    const badacz = plan.allAffected.find((item) => item.slug === "badacz");
    assert.ok(konfigurator);
    assert.ok(badacz);
    assert.deepEqual(konfigurator.to.adapterConfig.filesystemExtraPaths, KONFIGURATOR_PATHS);
    for (const host of KONFIGURATOR_HOSTS) {
      assert.ok(
        konfigurator.to.adapterConfig.networkAllowlist.includes(host),
        `${profileName} missing ${host}`,
      );
    }
    if (profileName === "openai-first") {
      assert.deepEqual(konfigurator.to.adapterConfig.networkAllowlist, [
        "chatgpt.com",
        "api.openai.com",
        "auth.openai.com",
        ...KONFIGURATOR_HOSTS,
      ]);
    } else {
      assert.deepEqual(konfigurator.to.adapterConfig.networkAllowlist, [
        "api.anthropic.com",
        "statsig.anthropic.com",
        "sentry.io",
        ...KONFIGURATOR_HOSTS,
      ]);
    }
    assert.equal(badacz.to.adapterConfig.filesystemExtraPaths, undefined);
    for (const host of KONFIGURATOR_HOSTS) {
      assert.equal(
        badacz.to.adapterConfig.networkAllowlist.includes(host),
        false,
        `peer must not receive ${host}`,
      );
    }
  }
});

test("profile-switch fails closed when runtime-capabilities.json is invalid", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "jarvis-rc-bad-"));
  cpSync(DESIRED_DIR, tmp, { recursive: true });
  writeCapabilities(tmp, {
    schemaVersion: 1,
    agents: {
      "konfigurator-systemu": {
        model: "gpt-evil",
        networkAllowlistAdditions: KONFIGURATOR_HOSTS,
      },
    },
  });
  const snapshot = structuredClone(liveAligned);
  setPausedSwitchable(snapshot);
  const plan = planProviderProfileSwitch({
    desiredDir: tmp,
    liveSnapshot: snapshot,
    profileName: "openai-first",
  });
  assert.equal(plan.ok, false);
  assert.ok(
    (plan.blockers ?? []).some(
      (item) => item.includes("forbidden") || item.includes("runtime-capabilities"),
    ),
    JSON.stringify(plan.blockers, null, 2),
  );
});

test("konfigurator AGENTS.md browser protocol pins paths, noproxy, and evidence gate", () => {
  const text = readFileSync(PACKAGE_AGENTS_MD, "utf8");
  assert.match(text, /\/home\/ccuser\/\.local\/agent-tools\/bin/);
  assert.match(text, /\/home\/ccuser\/\.agent-browser\/browsers/);
  assert.match(
    text,
    /find \/home\/ccuser\/\.agent-browser\/browsers -type f -name chrome -perm -111 -print -quit/,
  );
  assert.doesNotMatch(text, /\|\s*head\b/);
  assert.match(
    text,
    /if \[ -z "\$CHROME" \] \|\| \[ ! -x "\$CHROME" \]; then echo "Chrome discovery failed:/,
  );
  assert.match(text, /export AGENT_BROWSER_EXECUTABLE_PATH="\$CHROME"/);
  assert.match(text, /XDG_RUNTIME_DIR/);
  assert.match(text, /AGENT_BROWSER_SESSION/);
  assert.match(text, /harnessowych/);
  assert.doesNotMatch(text, /mktemp\s+-d\s+\/tmp\/agent-browser-runtime/);
  assert.match(
    text,
    /if \[ -z "\$\{XDG_RUNTIME_DIR:-\}" \] \|\| \[ ! -d "\$XDG_RUNTIME_DIR" \] \|\| \[ -z "\$\{AGENT_BROWSER_SESSION:-\}" \]/,
  );
  assert.match(text, /--version/);
  assert.match(text, /--noproxy\s+127\.0\.0\.1,localhost/);
  assert.match(text, /brak przeglądarki/);
  assert.doesNotMatch(text, /chrome-linux|chrome-\d+|\/browsers\/\d+/);
});

test("konfigurator desired skillKeys include agent-browser catalog key only for that agent", () => {
  const desired = loadDesired(DESIRED_DIR);
  const key = "paperclipai/optional/browser/agent-browser";
  const konfigurator = desired.agents.agents.find((a) => a.slug === "konfigurator-systemu");
  assert.ok(konfigurator.skillKeys.includes(key));
  assert.ok(konfigurator.skills.includes("agent-browser"));
  for (const agent of desired.agents.agents) {
    if (agent.slug === "konfigurator-systemu") continue;
    assert.equal(
      agent.skillKeys.includes(key),
      false,
      `${agent.slug} must not receive agent-browser`,
    );
  }
});
