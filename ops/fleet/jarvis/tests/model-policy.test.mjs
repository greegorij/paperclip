import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateModelPolicy } from "../lib/model-policy.mjs";

const EXPECTED_SLUGS = Object.freeze(["analyst", "in-ynier-wdro-e"]);

const SHADOW_EXPECTED_SLUGS = Object.freeze([
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
  "mi-sie-kodu-codex",
  "mi-sie-kodu-cursor",
  "mi-sie-kodu-glm",
  "mi-sie-recenzji-glm",
  "mi-sie-vault",
  "mi-sie-web",
  "modelarz-procesow",
  "obserwator-upstream",
  "recenzent",
  "reflection-coach",
  "senior-programista",
  "specjalista-deck-w",
  "specjalista-komunikacji-klienckiej",
  "specjalista-ofert",
  "summarizer",
  "szef-komercyjny",
  "zwiadowca-kodu",
  "zwiadowca-vaultu",
]);

const SHADOW_POLICY_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../desired/model-policy.shadow.v1.json",
);

function baseProviders() {
  return {
    openai: {
      adapterType: "codex_local",
      allowedDataClasses: ["public", "internal", "confidential", "sanitized"],
      availability: "candidate",
    },
    deepseek: {
      adapterType: "http",
      allowedDataClasses: ["sanitized"],
      availability: "candidate",
    },
  };
}

function subscriptionPricing(overrides = {}) {
  return {
    mode: "subscription",
    quotaSource: "example-chatgpt-plus-quota",
    verifiedOn: "2026-07-01",
    ...overrides,
  };
}

function apiPricing(overrides = {}) {
  return {
    mode: "api",
    currency: "USD",
    // Explicit example numbers for fixtures — not live market prices.
    inputPerMillionTokens: 0.14,
    outputPerMillionTokens: 0.28,
    verifiedOn: "2026-07-01",
    ...overrides,
  };
}

function baseCatalog() {
  return {
    "gpt-safe": {
      provider: "openai",
      adapterType: "codex_local",
      allowedDataClasses: ["public", "internal", "confidential", "sanitized"],
      availability: "candidate",
      billing: "subscription",
      pricing: subscriptionPricing(),
    },
    "gpt-5.6-luna": {
      provider: "openai",
      adapterType: "codex_local",
      allowedDataClasses: ["public", "internal", "confidential", "sanitized"],
      availability: "candidate",
      billing: "subscription",
      pricing: subscriptionPricing(),
    },
    "gpt-fallback": {
      provider: "openai",
      adapterType: "codex_local",
      allowedDataClasses: ["public", "internal", "confidential", "sanitized"],
      availability: "candidate",
      billing: "subscription",
      pricing: subscriptionPricing(),
    },
    "deepseek-chat": {
      provider: "deepseek",
      adapterType: "http",
      allowedDataClasses: ["sanitized"],
      availability: "candidate",
      billing: "api",
      pricing: apiPricing(),
    },
  };
}

function baseRole(overrides = {}) {
  return {
    primary: {
      model: "gpt-safe",
      workspaceAccess: "ro",
    },
    fallback: [{ model: "gpt-fallback" }],
    effort: "medium",
    dataClass: "internal",
    hardGates: ["shadow-read-only", "no-live-apply", "no-secret-export"],
    escalation: {
      max: 1,
      when: ["high-stakes", "tool-failure"],
      target: "stronger-model",
    },
    validator: "mechanical",
    limits: {
      maxAttempts: 2,
      maxEscalations: 1,
      maxDailyRuns: 3,
      maxTokensPerRun: 1000,
      maxRunSeconds: 60,
      maxDailyTokens: 5000,
    },
    ...overrides,
  };
}

function deployEngineerRole(overrides = {}) {
  return baseRole({
    validator: "independent-review",
    primary: {
      model: "gpt-safe",
      workspaceAccess: "rw",
    },
    ...overrides,
  });
}

function minimalPolicy(overrides = {}) {
  return {
    schemaVersion: 1,
    policyId: "jarvis-shadow-model-policy",
    version: "2026-07-31.1",
    mode: "shadow",
    providers: baseProviders(),
    modelCatalog: baseCatalog(),
    roles: {
      analyst: baseRole(),
      "in-ynier-wdro-e": deployEngineerRole(),
    },
    ...overrides,
  };
}

test("validateModelPolicy accepts a minimal valid policy for two expected slugs", () => {
  const result = validateModelPolicy({
    policy: minimalPolicy(),
    expectedSlugs: EXPECTED_SLUGS,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("validateModelPolicy rejects missing role coverage", () => {
  const policy = minimalPolicy({
    roles: {
      analyst: baseRole(),
    },
  });
  const result = validateModelPolicy({
    policy,
    expectedSlugs: EXPECTED_SLUGS,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("missing slug in-ynier-wdro-e")));
});

test("validateModelPolicy rejects dataClass not allowed by the model", () => {
  const policy = minimalPolicy({
    roles: {
      analyst: baseRole({
        primary: { model: "deepseek-chat", workspaceAccess: "ro" },
        fallback: [],
        dataClass: "confidential",
        limits: {
          maxAttempts: 2,
          maxEscalations: 1,
          maxDailyRuns: 3,
          maxTokensPerRun: 1000,
          maxRunSeconds: 60,
          maxDailyTokens: 5000,
          maxCostPerRun: 1,
        },
      }),
      "in-ynier-wdro-e": deployEngineerRole(),
    },
  });
  const result = validateModelPolicy({
    policy,
    expectedSlugs: EXPECTED_SLUGS,
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((error) =>
      error.includes("does not allow dataClass confidential")
      || error.includes("require dataClass sanitized")),
  );
});

test("validateModelPolicy rejects Luna primary with rw for in-ynier-wdro-e", () => {
  const policy = minimalPolicy({
    roles: {
      analyst: baseRole(),
      "in-ynier-wdro-e": deployEngineerRole({
        primary: {
          model: "gpt-5.6-luna",
          workspaceAccess: "rw",
        },
      }),
    },
  });
  const result = validateModelPolicy({
    policy,
    expectedSlugs: EXPECTED_SLUGS,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("luna") && error.includes("rw")));
});

test("validateModelPolicy rejects identical fallback model", () => {
  const policy = minimalPolicy({
    roles: {
      analyst: baseRole({
        primary: { model: "gpt-safe", workspaceAccess: "ro" },
        fallback: [{ model: "gpt-safe" }],
      }),
      "in-ynier-wdro-e": deployEngineerRole(),
    },
  });
  const result = validateModelPolicy({
    policy,
    expectedSlugs: EXPECTED_SLUGS,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("fallback model must differ from primary")));
});

test("validateModelPolicy rejects a zero limit", () => {
  const policy = minimalPolicy({
    roles: {
      analyst: baseRole({
        limits: {
          maxAttempts: 0,
          maxEscalations: 1,
          maxDailyRuns: 3,
          maxTokensPerRun: 1000,
          maxRunSeconds: 60,
          maxDailyTokens: 5000,
        },
      }),
      "in-ynier-wdro-e": deployEngineerRole(),
    },
  });
  const result = validateModelPolicy({
    policy,
    expectedSlugs: EXPECTED_SLUGS,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("limits.maxAttempts")));
});

test("validateModelPolicy rejects missing cross-provider fallback when available", () => {
  const catalog = {
    ...baseCatalog(),
    "claude-safe": {
      provider: "anthropic",
      adapterType: "claude_local",
      allowedDataClasses: ["public", "internal", "confidential", "sanitized"],
      availability: "candidate",
      billing: "subscription",
      pricing: subscriptionPricing(),
    },
  };
  const policy = minimalPolicy({
    providers: {
      ...baseProviders(),
      anthropic: {
        adapterType: "claude_local",
        allowedDataClasses: ["public", "internal", "confidential", "sanitized"],
        availability: "candidate",
      },
    },
    modelCatalog: catalog,
    roles: {
      analyst: baseRole({
        fallback: [{ model: "gpt-fallback" }],
      }),
      "in-ynier-wdro-e": deployEngineerRole({
        primary: { model: "gpt-safe", workspaceAccess: "rw" },
        fallback: [{ model: "gpt-fallback" }],
      }),
    },
  });
  const result = validateModelPolicy({
    policy,
    expectedSlugs: EXPECTED_SLUGS,
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((error) =>
      error.includes("fallback must include at least one model from a different provider")),
  );
});

test("validateModelPolicy rejects empty fallback when cross-provider model exists", () => {
  const catalog = {
    ...baseCatalog(),
    "claude-safe": {
      provider: "anthropic",
      adapterType: "claude_local",
      allowedDataClasses: ["public", "internal", "confidential", "sanitized"],
      availability: "candidate",
      billing: "subscription",
      pricing: subscriptionPricing(),
    },
  };
  const policy = minimalPolicy({
    providers: {
      ...baseProviders(),
      anthropic: {
        adapterType: "claude_local",
        allowedDataClasses: ["public", "internal", "confidential", "sanitized"],
        availability: "candidate",
      },
    },
    modelCatalog: catalog,
    roles: {
      analyst: baseRole({
        fallback: [],
      }),
      "in-ynier-wdro-e": deployEngineerRole({
        primary: { model: "gpt-safe", workspaceAccess: "rw" },
      }),
    },
  });
  const result = validateModelPolicy({
    policy,
    expectedSlugs: EXPECTED_SLUGS,
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((error) => error.includes("fallback must contain at least 1 entry")),
  );
});

test("validateModelPolicy rejects empty expectedSlugs", () => {
  const result = validateModelPolicy({
    policy: minimalPolicy({ roles: {} }),
    expectedSlugs: [],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("expectedSlugs")));
});

test("validateModelPolicy rejects unknown provider in modelCatalog", () => {
  const catalog = baseCatalog();
  catalog["gpt-safe"] = {
    ...catalog["gpt-safe"],
    provider: "unknown-provider",
  };
  const result = validateModelPolicy({
    policy: minimalPolicy({ modelCatalog: catalog }),
    expectedSlugs: EXPECTED_SLUGS,
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((error) =>
      error.includes("unknown-provider") && error.includes("providers")),
  );
});

test("validateModelPolicy rejects modelCatalog entry without pricing", () => {
  const catalog = baseCatalog();
  const { pricing: _removed, ...withoutPricing } = catalog["gpt-safe"];
  catalog["gpt-safe"] = withoutPricing;
  const result = validateModelPolicy({
    policy: minimalPolicy({ modelCatalog: catalog }),
    expectedSlugs: EXPECTED_SLUGS,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("pricing is required")));
});

test("validateModelPolicy rejects incomplete API pricing", () => {
  const catalog = baseCatalog();
  catalog["deepseek-chat"] = {
    ...catalog["deepseek-chat"],
    pricing: {
      mode: "api",
      currency: "USD",
      verifiedOn: "2026-07-01",
    },
  };
  const result = validateModelPolicy({
    policy: minimalPolicy({ modelCatalog: catalog }),
    expectedSlugs: EXPECTED_SLUGS,
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((error) => error.includes("pricing.inputPerMillionTokens")),
  );
  assert.ok(
    result.errors.some((error) => error.includes("pricing.outputPerMillionTokens")),
  );
});

test("validateModelPolicy rejects missing policyId", () => {
  const policy = minimalPolicy();
  delete policy.policyId;
  const result = validateModelPolicy({
    policy,
    expectedSlugs: EXPECTED_SLUGS,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("policyId")));
});

test("validateModelPolicy rejects unknown hardGate", () => {
  const policy = minimalPolicy({
    roles: {
      analyst: baseRole({
        hardGates: ["shadow-read-only", "unknown-gate"],
      }),
      "in-ynier-wdro-e": deployEngineerRole(),
    },
  });
  const result = validateModelPolicy({
    policy,
    expectedSlugs: EXPECTED_SLUGS,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("unknown hardGate")));
});

test("validateModelPolicy rejects sanitized-input-only without dataClass sanitized", () => {
  const policy = minimalPolicy({
    roles: {
      analyst: baseRole({
        hardGates: [
          "shadow-read-only",
          "no-live-apply",
          "no-secret-export",
          "sanitized-input-only",
        ],
        dataClass: "internal",
      }),
      "in-ynier-wdro-e": deployEngineerRole(),
    },
  });
  const result = validateModelPolicy({
    policy,
    expectedSlugs: EXPECTED_SLUGS,
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((error) =>
      error.includes("sanitized-input-only") && error.includes("dataClass sanitized")),
  );
});

test("validateModelPolicy rejects high-responsibility role without independent-review", () => {
  const policy = minimalPolicy({
    roles: {
      analyst: baseRole(),
      "in-ynier-wdro-e": deployEngineerRole({
        validator: "mechanical",
      }),
    },
  });
  const result = validateModelPolicy({
    policy,
    expectedSlugs: EXPECTED_SLUGS,
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((error) =>
      error.includes("in-ynier-wdro-e")
      && error.includes("independent-review")),
  );
});

test("shadow model policy file validates for all 29 expected roles", () => {
  assert.equal(SHADOW_EXPECTED_SLUGS.length, 29);
  const policy = JSON.parse(readFileSync(SHADOW_POLICY_PATH, "utf8"));
  assert.equal(Object.keys(policy.roles).length, 29);
  const result = validateModelPolicy({
    policy,
    expectedSlugs: SHADOW_EXPECTED_SLUGS,
  });
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.deepEqual(result.errors, []);
});
