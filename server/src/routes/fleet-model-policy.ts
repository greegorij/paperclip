import { Router } from "express";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "@paperclipai/db";
import { HttpError } from "../errors.js";
import { companyService } from "../services/index.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(MODULE_DIR, "../../..");
const MODEL_POLICY_PATH = path.join(
  REPO_ROOT,
  "ops/fleet/jarvis/desired/model-policy.shadow.v1.json",
);
const PROFILES_PATH = path.join(
  REPO_ROOT,
  "ops/fleet/jarvis/desired/profiles.json",
);

const UNAVAILABLE_MESSAGE = "Fleet model policy unavailable";

export type FleetModelPolicyRoleProjection = {
  primary: { model: string; workspaceAccess?: string };
  fallback: Array<{ model: string }>;
  effort?: string;
  dataClass?: string;
  hardGates?: string[];
  escalation?: {
    max?: number;
    when?: string[];
    target?: string;
  };
  validator?: string;
  limits?: {
    maxAttempts?: number;
    maxEscalations?: number;
    maxDailyRuns?: number;
    maxTokensPerRun?: number;
    maxRunSeconds?: number;
    maxDailyTokens?: number;
  };
};

export type FleetModelPolicyProfileAgentProjection = {
  slug: string;
  model: string;
  modelReasoningEffort?: string;
};

export type FleetModelPolicyProfileProjection = {
  version: string;
  agents: FleetModelPolicyProfileAgentProjection[];
};

export type FleetModelPolicyProjection = {
  policyId: string;
  version: string;
  mode: string;
  roles: Record<string, FleetModelPolicyRoleProjection>;
  profiles: Record<string, FleetModelPolicyProfileProjection>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function projectStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string");
  return items.length === value.length ? items : undefined;
}

function projectPrimary(value: unknown): FleetModelPolicyRoleProjection["primary"] | null {
  const record = asRecord(value);
  if (!record) return null;
  const model = requireNonEmptyString(record.model);
  if (!model) return null;
  const workspaceAccess = requireNonEmptyString(record.workspaceAccess) ?? undefined;
  return workspaceAccess ? { model, workspaceAccess } : { model };
}

function projectFallback(value: unknown): Array<{ model: string }> | null {
  if (!Array.isArray(value)) return null;
  const fallback: Array<{ model: string }> = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const model = record ? requireNonEmptyString(record.model) : null;
    if (!model) return null;
    fallback.push({ model });
  }
  return fallback;
}

function projectEscalation(value: unknown): FleetModelPolicyRoleProjection["escalation"] | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const escalation: NonNullable<FleetModelPolicyRoleProjection["escalation"]> = {};
  if (typeof record.max === "number" && Number.isFinite(record.max)) {
    escalation.max = record.max;
  }
  const when = projectStringArray(record.when);
  if (when) escalation.when = when;
  const target = requireNonEmptyString(record.target);
  if (target) escalation.target = target;
  return Object.keys(escalation).length > 0 ? escalation : undefined;
}

function projectLimits(value: unknown): FleetModelPolicyRoleProjection["limits"] | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const limits: NonNullable<FleetModelPolicyRoleProjection["limits"]> = {};
  for (const key of [
    "maxAttempts",
    "maxEscalations",
    "maxDailyRuns",
    "maxTokensPerRun",
    "maxRunSeconds",
    "maxDailyTokens",
  ] as const) {
    const raw = record[key];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      limits[key] = raw;
    }
  }
  return Object.keys(limits).length > 0 ? limits : undefined;
}

function projectRole(value: unknown): FleetModelPolicyRoleProjection | null {
  const record = asRecord(value);
  if (!record) return null;
  const primary = projectPrimary(record.primary);
  const fallback = projectFallback(record.fallback);
  if (!primary || !fallback) return null;

  const role: FleetModelPolicyRoleProjection = { primary, fallback };
  const effort = requireNonEmptyString(record.effort);
  if (effort) role.effort = effort;
  const dataClass = requireNonEmptyString(record.dataClass);
  if (dataClass) role.dataClass = dataClass;
  const hardGates = projectStringArray(record.hardGates);
  if (hardGates) role.hardGates = hardGates;
  const escalation = projectEscalation(record.escalation);
  if (escalation) role.escalation = escalation;
  const validator = requireNonEmptyString(record.validator);
  if (validator) role.validator = validator;
  const limits = projectLimits(record.limits);
  if (limits) role.limits = limits;
  return role;
}

function projectRoles(value: unknown): Record<string, FleetModelPolicyRoleProjection> | null {
  const record = asRecord(value);
  if (!record) return null;
  const roles: Record<string, FleetModelPolicyRoleProjection> = {};
  for (const [slug, roleValue] of Object.entries(record)) {
    const role = projectRole(roleValue);
    if (!role) return null;
    roles[slug] = role;
  }
  return roles;
}

function projectProfileAgent(value: unknown): FleetModelPolicyProfileAgentProjection | null {
  const record = asRecord(value);
  if (!record) return null;
  const slug = requireNonEmptyString(record.slug);
  const model = requireNonEmptyString(record.model);
  if (!slug || !model) return null;
  const agent: FleetModelPolicyProfileAgentProjection = { slug, model };
  const modelReasoningEffort = requireNonEmptyString(record.modelReasoningEffort);
  if (modelReasoningEffort) agent.modelReasoningEffort = modelReasoningEffort;
  return agent;
}

function projectProfiles(value: unknown): Record<string, FleetModelPolicyProfileProjection> | null {
  const record = asRecord(value);
  if (!record) return null;
  const profiles: Record<string, FleetModelPolicyProfileProjection> = {};
  for (const [profileId, profileValue] of Object.entries(record)) {
    const profile = asRecord(profileValue);
    if (!profile) return null;
    const version = requireNonEmptyString(profile.version);
    if (!version || !Array.isArray(profile.agents)) return null;
    const agents: FleetModelPolicyProfileAgentProjection[] = [];
    for (const agentValue of profile.agents) {
      const agent = projectProfileAgent(agentValue);
      if (!agent) return null;
      agents.push(agent);
    }
    profiles[profileId] = { version, agents };
  }
  return profiles;
}

function parseJsonObject(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("invalid");
  }
  const record = asRecord(parsed);
  if (!record) throw new Error("invalid");
  return record;
}

export async function loadFleetModelPolicyProjection(
  readText: (filePath: string) => Promise<string> = (filePath) => readFile(filePath, "utf8"),
): Promise<FleetModelPolicyProjection> {
  const [policyRaw, profilesRaw] = await Promise.all([
    readText(MODEL_POLICY_PATH),
    readText(PROFILES_PATH),
  ]);
  const policyDoc = parseJsonObject(policyRaw);
  const profilesDoc = parseJsonObject(profilesRaw);

  const policyId = requireNonEmptyString(policyDoc.policyId);
  const version = requireNonEmptyString(policyDoc.version);
  const mode = requireNonEmptyString(policyDoc.mode);
  const roles = projectRoles(policyDoc.roles);
  const profiles = projectProfiles(profilesDoc.profiles);

  if (!policyId || !version || !mode || !roles || !profiles) {
    throw new Error("invalid");
  }

  return { policyId, version, mode, roles, profiles };
}

export function fleetModelPolicyRoutes(
  db: Db,
  options: {
    loadProjection?: () => Promise<FleetModelPolicyProjection>;
  } = {},
) {
  const router = Router();
  const companies = companyService(db);
  const loadProjection = options.loadProjection ?? loadFleetModelPolicyProjection;

  router.get("/companies/:companyId/fleet-model-policy", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);

    const company = await companies.getById(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    try {
      const projection = await loadProjection();
      res.json(projection);
    } catch {
      throw new HttpError(503, UNAVAILABLE_MESSAGE);
    }
  });

  return router;
}
