import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { DESIRED_DIR, PACKAGE_DIR } from "./paths.mjs";

export function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export function loadDesired(desiredDir = DESIRED_DIR) {
  return {
    fleet: readJson(path.join(desiredDir, "fleet.json")),
    models: readJson(path.join(desiredDir, "models.json")),
    profiles: existsSync(path.join(desiredDir, "profiles.json"))
      ? readJson(path.join(desiredDir, "profiles.json"))
      : null,
    skills: readJson(path.join(desiredDir, "skills.json")),
    routines: readJson(path.join(desiredDir, "routines.json")),
    builtIns: readJson(path.join(desiredDir, "built-ins.json")),
    contradictions: readJson(path.join(desiredDir, "contradictions.json")),
    agents: existsSync(path.join(desiredDir, "agents.json"))
      ? readJson(path.join(desiredDir, "agents.json"))
      : null,
  };
}

export function skillShortName(key) {
  const parts = String(key).split("/");
  return parts[parts.length - 1] || String(key);
}

export function listPackageAgents(packageDir = PACKAGE_DIR) {
  const agentsDir = path.join(packageDir, "agents");
  if (!existsSync(agentsDir)) return [];
  return readdirSync(agentsDir)
    .filter((name) => statSync(path.join(agentsDir, name)).isDirectory())
    .map((slug) => {
      const instructionPath = path.join(agentsDir, slug, "AGENTS.md");
      const instructions = existsSync(instructionPath)
        ? readFileSync(instructionPath, "utf8")
        : "";
      const skills = parseFrontmatterSkills(instructions);
      return { slug, instructionPath, instructions, skills };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

export function parseFrontmatterSkills(content) {
  const fm = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fm) return [];
  const skills = [];
  for (const line of fm[1].split("\n")) {
    const m = line.match(/^\s*-\s*"([^"]+)"\s*$/);
    if (m) skills.push(m[1]);
  }
  return skills;
}

export function loadPackage(packageDir = PACKAGE_DIR) {
  const agents = listPackageAgents(packageDir);
  return {
    packageDir,
    agents,
    agentBySlug: Object.fromEntries(agents.map((a) => [a.slug, a])),
  };
}

/** Redact secrets from objects before logging/reporting. */
export function redactSecrets(value, depth = 0) {
  if (depth > 12) return "[truncated]";
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/secret|token|password|api[_-]?key|authorization|bearer/i.test(k)) {
        out[k] = typeof v === "string" && v ? "[redacted]" : v;
      } else {
        out[k] = redactSecrets(v, depth + 1);
      }
    }
    return out;
  }
  if (typeof value === "string" && /^(sk-|pcp_|ghp_|xox)/.test(value)) {
    return "[redacted]";
  }
  return value;
}
