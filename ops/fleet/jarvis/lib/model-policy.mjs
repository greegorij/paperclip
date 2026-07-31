const ALLOWED_DATA_CLASSES = Object.freeze([
  "public",
  "internal",
  "confidential",
  "sanitized",
]);
const ALLOWED_EFFORTS = Object.freeze(["low", "medium", "high"]);
const ALLOWED_BILLINGS = Object.freeze(["api", "subscription"]);
const ALLOWED_HARD_GATES = Object.freeze([
  "shadow-read-only",
  "no-live-apply",
  "no-secret-export",
  "approval-required",
  "no-profile-change-in-run",
  "sanitized-input-only",
]);
const ALLOWED_VALIDATORS = Object.freeze(["mechanical", "independent-review"]);
const ALLOWED_ESCALATION_WHEN = Object.freeze([
  "contradictory-sources",
  "high-stakes",
  "tool-failure",
  "write-operation",
  "long-context",
  "human-correction",
]);
const ALLOWED_ESCALATION_TARGETS = Object.freeze([
  "stronger-model",
  "independent-review",
  "human",
]);
const POSITIVE_LIMIT_KEYS = Object.freeze([
  "maxAttempts",
  "maxEscalations",
  "maxDailyRuns",
  "maxTokensPerRun",
  "maxRunSeconds",
  "maxDailyTokens",
]);
const RESTRICTED_PROVIDER_MARKERS = Object.freeze(["glm", "deepseek", "minimax"]);
const DEPLOY_ENGINEER_SLUG = "in-ynier-wdro-e";
const HIGH_RESPONSIBILITY_SLUGS = Object.freeze([
  "jarvis",
  "szef-komercyjny",
  "in-ynier-wdro-e",
  "konfigurator-systemu",
  "mi-sie-kodu-codex",
  "mi-sie-kodu-cursor",
  "senior-programista",
  "specjalista-deck-w",
  "specjalista-komunikacji-klienckiej",
  "specjalista-ofert",
]);
const POLICY_VERSION_RE = /^(\d{4}-\d{2}-\d{2})\.([1-9]\d*)$/;

function asRecord(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}

function isPositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isIsoDateString(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
  );
}

function isPolicyVersion(value) {
  if (typeof value !== "string") return false;
  const match = POLICY_VERSION_RE.exec(value);
  if (!match) return false;
  return isIsoDateString(match[1]);
}

function validateModelPricing({ modelId, entry, errors }) {
  const label = `modelCatalog.${modelId}`;
  const pricing = asRecord(entry.pricing);
  if (!pricing) {
    errors.push(`${label}: pricing is required`);
    return;
  }

  if (!isIsoDateString(pricing.verifiedOn)) {
    errors.push(`${label}: pricing.verifiedOn must be YYYY-MM-DD`);
  }

  if (entry.billing === "subscription") {
    if (pricing.mode !== "subscription") {
      errors.push(`${label}: pricing.mode must equal "subscription"`);
    }
    if (!isNonEmptyString(pricing.quotaSource)) {
      errors.push(`${label}: pricing.quotaSource is required`);
    }
    return;
  }

  if (entry.billing === "api") {
    if (pricing.mode !== "api") {
      errors.push(`${label}: pricing.mode must equal "api"`);
    }
    if (pricing.currency !== "USD") {
      errors.push(`${label}: pricing.currency must equal "USD"`);
    }
    if (!isPositiveNumber(pricing.inputPerMillionTokens)) {
      errors.push(`${label}: pricing.inputPerMillionTokens must be a positive number`);
    }
    if (!isPositiveNumber(pricing.outputPerMillionTokens)) {
      errors.push(`${label}: pricing.outputPerMillionTokens must be a positive number`);
    }
  }
}

function isRestrictedModel({ modelId, provider }) {
  const haystack = `${String(provider ?? "")} ${String(modelId ?? "")}`.toLowerCase();
  return RESTRICTED_PROVIDER_MARKERS.some((marker) => haystack.includes(marker));
}

function modelAllowsDataClass(modelEntry, dataClass) {
  return Array.isArray(modelEntry?.allowedDataClasses)
    && modelEntry.allowedDataClasses.includes(dataClass);
}

function validateExpectedSlugs(expectedSlugs, errors) {
  if (!Array.isArray(expectedSlugs) || expectedSlugs.length === 0) {
    errors.push("expectedSlugs must be a non-empty array of unique non-empty strings");
    return [];
  }
  const seen = new Set();
  for (const slug of expectedSlugs) {
    if (!isNonEmptyString(slug) || seen.has(slug)) {
      errors.push("expectedSlugs must be a non-empty array of unique non-empty strings");
      return expectedSlugs.filter(isNonEmptyString).map(String);
    }
    seen.add(slug);
  }
  return expectedSlugs.map(String);
}

function validateModelRef({ label, ref, catalog, dataClass, errors }) {
  const record = asRecord(ref);
  if (!record) {
    errors.push(`${label}: must be an object`);
    return null;
  }
  if (!isNonEmptyString(record.model)) {
    errors.push(`${label}: model is required`);
    return null;
  }
  const modelId = record.model;
  const modelEntry = catalog[modelId];
  if (!modelEntry) {
    errors.push(`${label}: unknown model ${modelId}`);
    return null;
  }
  if (!modelAllowsDataClass(modelEntry, dataClass)) {
    errors.push(`${label}: model ${modelId} does not allow dataClass ${dataClass}`);
  }
  if (isRestrictedModel({ modelId, provider: modelEntry.provider }) && dataClass !== "sanitized") {
    errors.push(`${label}: GLM/DeepSeek/MiniMax models require dataClass sanitized`);
  }
  return { modelId, modelEntry, record };
}

function catalogHasCompatibleOtherProvider({ catalog, primaryModelId, primaryProvider, dataClass }) {
  for (const [modelId, rawEntry] of Object.entries(catalog)) {
    if (modelId === primaryModelId) continue;
    const entry = asRecord(rawEntry);
    if (!entry) continue;
    if (entry.provider === primaryProvider) continue;
    if (!modelAllowsDataClass(entry, dataClass)) continue;
    return true;
  }
  return false;
}

/**
 * Validate a shadow-mode model policy against an exact expected role slug set.
 * Returns { ok, errors } and never throws for invalid policy content.
 */
export function validateModelPolicy({ policy, expectedSlugs }) {
  const errors = [];
  const expected = validateExpectedSlugs(expectedSlugs, errors);
  const expectedSet = new Set(expected);

  const doc = asRecord(policy);
  if (!doc) {
    return { ok: false, errors: [...errors, "policy must be an object"] };
  }

  if (doc.schemaVersion !== 1) {
    errors.push("schemaVersion must equal 1");
  }
  if (!isNonEmptyString(doc.policyId)) {
    errors.push("policyId must be a non-empty string");
  }
  if (!isPolicyVersion(doc.version)) {
    errors.push("version must match YYYY-MM-DD.<positive-integer>");
  }
  if (doc.mode !== "shadow") {
    errors.push('mode must equal "shadow"');
  }

  const providers = asRecord(doc.providers);
  const providerKeys = providers ? Object.keys(providers) : [];
  if (!providers || providerKeys.length === 0) {
    errors.push("providers must be a non-empty object");
  } else {
    for (const [providerId, rawProvider] of Object.entries(providers)) {
      const provider = asRecord(rawProvider);
      if (!provider) {
        errors.push(`providers.${providerId}: must be an object`);
        continue;
      }
      if (!isNonEmptyString(provider.adapterType)) {
        errors.push(`providers.${providerId}: adapterType is required`);
      }
      if (!Array.isArray(provider.allowedDataClasses) || provider.allowedDataClasses.length === 0) {
        errors.push(`providers.${providerId}: allowedDataClasses must be a non-empty array`);
      } else {
        for (const dataClass of provider.allowedDataClasses) {
          if (!ALLOWED_DATA_CLASSES.includes(dataClass)) {
            errors.push(`providers.${providerId}: invalid dataClass ${dataClass}`);
          }
        }
      }
      if (provider.availability !== "candidate") {
        errors.push(`providers.${providerId}: availability must equal "candidate"`);
      }
    }
  }

  const catalog = asRecord(doc.modelCatalog);
  if (!catalog) {
    errors.push("modelCatalog must be an object");
  } else {
    for (const [modelId, rawEntry] of Object.entries(catalog)) {
      const entry = asRecord(rawEntry);
      if (!entry) {
        errors.push(`modelCatalog.${modelId}: must be an object`);
        continue;
      }
      if (!isNonEmptyString(entry.provider)) {
        errors.push(`modelCatalog.${modelId}: provider is required`);
      } else if (!providers || !Object.prototype.hasOwnProperty.call(providers, entry.provider)) {
        errors.push(
          `modelCatalog.${modelId}: provider ${entry.provider} must reference a key in providers`,
        );
      } else {
        const providerConfig = asRecord(providers[entry.provider]);
        if (providerConfig) {
          if (
            isNonEmptyString(entry.adapterType)
            && isNonEmptyString(providerConfig.adapterType)
            && entry.adapterType !== providerConfig.adapterType
          ) {
            errors.push(
              `modelCatalog.${modelId}: adapterType must match providers.${entry.provider}`,
            );
          }
          if (
            Array.isArray(entry.allowedDataClasses)
            && Array.isArray(providerConfig.allowedDataClasses)
          ) {
            for (const dataClass of entry.allowedDataClasses) {
              if (!providerConfig.allowedDataClasses.includes(dataClass)) {
                errors.push(
                  `modelCatalog.${modelId}: allowedDataClasses must be a subset of providers.${entry.provider}`,
                );
                break;
              }
            }
          }
        }
      }
      if (!isNonEmptyString(entry.adapterType)) {
        errors.push(`modelCatalog.${modelId}: adapterType is required`);
      }
      if (!ALLOWED_BILLINGS.includes(entry.billing)) {
        errors.push(`modelCatalog.${modelId}: billing must be "api" or "subscription"`);
      } else {
        validateModelPricing({ modelId, entry, errors });
      }
      if (!Array.isArray(entry.allowedDataClasses) || entry.allowedDataClasses.length === 0) {
        errors.push(`modelCatalog.${modelId}: allowedDataClasses must be a non-empty array`);
      } else {
        for (const dataClass of entry.allowedDataClasses) {
          if (!ALLOWED_DATA_CLASSES.includes(dataClass)) {
            errors.push(`modelCatalog.${modelId}: invalid dataClass ${dataClass}`);
          }
        }
        if (
          isRestrictedModel({ modelId, provider: entry.provider })
          && (
            entry.allowedDataClasses.length !== 1
            || entry.allowedDataClasses[0] !== "sanitized"
          )
        ) {
          errors.push(
            `modelCatalog.${modelId}: GLM/DeepSeek/MiniMax models may only allow sanitized`,
          );
        }
      }
      if (entry.availability !== "candidate") {
        errors.push(`modelCatalog.${modelId}: availability must equal "candidate"`);
      }
    }
  }

  const roles = asRecord(doc.roles);
  if (!roles) {
    errors.push("roles must be an object");
    return { ok: errors.length === 0, errors };
  }

  const roleSlugs = Object.keys(roles);
  const roleSet = new Set(roleSlugs);
  for (const slug of expected) {
    if (!roleSet.has(slug)) errors.push(`roles: missing slug ${slug}`);
  }
  for (const slug of roleSlugs) {
    if (!expectedSet.has(slug)) errors.push(`roles: unexpected slug ${slug}`);
  }

  const safeCatalog = catalog ?? {};

  for (const [slug, rawRole] of Object.entries(roles)) {
    const role = asRecord(rawRole);
    if (!role) {
      errors.push(`roles.${slug}: must be an object`);
      continue;
    }

    if (!ALLOWED_DATA_CLASSES.includes(role.dataClass)) {
      errors.push(`roles.${slug}: dataClass must be one of ${ALLOWED_DATA_CLASSES.join(", ")}`);
    }
    if (!ALLOWED_EFFORTS.includes(role.effort)) {
      errors.push(`roles.${slug}: effort must be one of ${ALLOWED_EFFORTS.join(", ")}`);
    }
    if (!Array.isArray(role.hardGates) || role.hardGates.length === 0) {
      errors.push(`roles.${slug}: hardGates must be a non-empty array`);
    } else {
      for (const gate of role.hardGates) {
        if (!ALLOWED_HARD_GATES.includes(gate)) {
          errors.push(`roles.${slug}: unknown hardGate ${gate}`);
        }
      }
      if (role.hardGates.includes("sanitized-input-only") && role.dataClass !== "sanitized") {
        errors.push(
          `roles.${slug}: hardGate sanitized-input-only requires dataClass sanitized`,
        );
      }
    }
    if (!ALLOWED_VALIDATORS.includes(role.validator)) {
      errors.push(
        `roles.${slug}: validator must be one of ${ALLOWED_VALIDATORS.join(", ")}`,
      );
    }
    if (
      HIGH_RESPONSIBILITY_SLUGS.includes(slug)
      && role.validator !== "independent-review"
    ) {
      errors.push(
        `roles.${slug}: high-responsibility role requires validator independent-review`,
      );
    }

    const escalation = asRecord(role.escalation);
    if (!escalation) {
      errors.push(`roles.${slug}: escalation must be an object`);
    } else {
      if (escalation.max !== 0 && escalation.max !== 1) {
        errors.push(`roles.${slug}: escalation.max must be 0 or 1`);
      }
      if (!Array.isArray(escalation.when) || escalation.when.length === 0) {
        errors.push(`roles.${slug}: escalation.when must be a non-empty array`);
      } else {
        for (const reason of escalation.when) {
          if (!ALLOWED_ESCALATION_WHEN.includes(reason)) {
            errors.push(`roles.${slug}: unknown escalation.when ${reason}`);
          }
        }
      }
      if (!ALLOWED_ESCALATION_TARGETS.includes(escalation.target)) {
        errors.push(
          `roles.${slug}: escalation.target must be one of ${ALLOWED_ESCALATION_TARGETS.join(", ")}`,
        );
      }
    }

    const limits = asRecord(role.limits);
    if (!limits) {
      errors.push(`roles.${slug}: limits must be an object`);
    } else {
      for (const key of POSITIVE_LIMIT_KEYS) {
        if (!isPositiveNumber(limits[key])) {
          errors.push(`roles.${slug}: limits.${key} must be a positive number`);
        }
      }
    }

    const primary = validateModelRef({
      label: `roles.${slug}.primary`,
      ref: role.primary,
      catalog: safeCatalog,
      dataClass: role.dataClass,
      errors,
    });

    if (primary && primary.modelEntry.billing === "api") {
      if (!limits || !isPositiveNumber(limits.maxCostPerRun)) {
        errors.push(`roles.${slug}: limits.maxCostPerRun must be a positive number when billing is api`);
      }
    }

    if (
      slug === DEPLOY_ENGINEER_SLUG
      && primary
      && String(primary.modelId).toLowerCase().includes("luna")
      && primary.record.workspaceAccess === "rw"
    ) {
      errors.push(
        `roles.${slug}: primary model containing luna cannot use workspaceAccess rw`,
      );
    }

    if (!Array.isArray(role.fallback)) {
      errors.push(`roles.${slug}: fallback must be an array`);
    } else if (role.fallback.length < 1) {
      errors.push(`roles.${slug}: fallback must contain at least 1 entry`);
    } else if (role.fallback.length > 2) {
      errors.push(`roles.${slug}: fallback may contain at most 2 entries`);
    } else {
      const fallbackRefs = [];
      for (let i = 0; i < role.fallback.length; i += 1) {
        const fallbackRef = validateModelRef({
          label: `roles.${slug}.fallback[${i}]`,
          ref: role.fallback[i],
          catalog: safeCatalog,
          dataClass: role.dataClass,
          errors,
        });
        if (primary && fallbackRef && fallbackRef.modelId === primary.modelId) {
          errors.push(`roles.${slug}: fallback model must differ from primary`);
        }
        if (fallbackRef) fallbackRefs.push(fallbackRef);
      }

      if (
        primary
        && catalogHasCompatibleOtherProvider({
          catalog: safeCatalog,
          primaryModelId: primary.modelId,
          primaryProvider: primary.modelEntry.provider,
          dataClass: role.dataClass,
        })
      ) {
        const hasCrossProviderFallback = fallbackRefs.some(
          (ref) => ref.modelEntry.provider !== primary.modelEntry.provider,
        );
        if (!hasCrossProviderFallback) {
          errors.push(
            `roles.${slug}: fallback must include at least one model from a different provider than primary`,
          );
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
