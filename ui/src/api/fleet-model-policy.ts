import { api } from "./client";

export type FleetModelPolicyRole = {
  primary: {
    model: string;
    workspaceAccess?: string;
  };
  fallback: Array<{
    model: string;
  }>;
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

export type FleetModelPolicyProfile = {
  version: string;
  agents: Array<{
    slug: string;
    model: string;
    modelReasoningEffort?: string;
  }>;
};

export type FleetModelPolicy = {
  policyId: string;
  version: string;
  mode: string;
  roles: Record<string, FleetModelPolicyRole>;
  profiles: Record<string, FleetModelPolicyProfile>;
};

export const fleetModelPolicyApi = {
  get: (companyId: string) =>
    api.get<FleetModelPolicy>(`/companies/${companyId}/fleet-model-policy`),
};
