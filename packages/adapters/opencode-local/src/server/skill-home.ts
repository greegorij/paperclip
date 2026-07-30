import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

type OpenCodeSkillHomeResolution = {
  homeDir: string;
  skillsHome: string;
  source: "configured_env" | "paperclip_managed";
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveConfiguredEnvHome(config: Record<string, unknown>): string | null {
  const env =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  const configuredHome = asString(env.HOME);
  return configuredHome ? path.resolve(configuredHome) : null;
}

function stableAgentHomeSegment(agentId: string): string {
  const normalizedId = agentId.trim() || "unknown-agent";
  const slug =
    normalizedId
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "agent";
  const digest = createHash("sha256").update(normalizedId).digest("hex").slice(0, 16);
  return `${slug}-${digest}`;
}

function resolveManagedHomeDir(agentId: string): string {
  return path.join(
    os.homedir(),
    ".paperclip",
    "opencode",
    "agents",
    stableAgentHomeSegment(agentId),
  );
}

export function resolveOpenCodeSkillHome(
  config: Record<string, unknown>,
  agentId: string,
): OpenCodeSkillHomeResolution {
  const configuredHome = resolveConfiguredEnvHome(config);
  const homeDir = configuredHome ?? resolveManagedHomeDir(agentId);
  return {
    homeDir,
    skillsHome: path.join(homeDir, ".claude", "skills"),
    source: configuredHome ? "configured_env" : "paperclip_managed",
  };
}
