import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterSkillContext,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  buildPersistentSkillSnapshot,
  ensurePaperclipSkillSymlink,
  readPaperclipRuntimeSkillEntries,
  readInstalledSkillTargets,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import { resolveOpenCodeSkillHome } from "./skill-home.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

async function buildOpenCodeSkillSnapshot(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(ctx.config, __moduleDir);
  const desiredSkills = resolvePaperclipDesiredSkillNames(ctx.config, availableEntries);
  const { skillsHome, source } = resolveOpenCodeSkillHome(ctx.config, ctx.agentId);
  const installed = await readInstalledSkillTargets(skillsHome);
  return buildPersistentSkillSnapshot({
    adapterType: "opencode_local",
    availableEntries,
    desiredSkills,
    installed,
    skillsHome,
    locationLabel: "~/.claude/skills",
    installedDetail:
      source === "configured_env"
        ? "Installed in the OpenCode skills home under the configured HOME."
        : "Installed in the Paperclip-managed OpenCode HOME for this agent.",
    missingDetail:
      source === "configured_env"
        ? "Configured but not currently linked into the OpenCode skills home under the configured HOME."
        : "Configured but not currently linked into this agent's Paperclip-managed OpenCode HOME.",
    externalConflictDetail:
      source === "configured_env"
        ? "Skill name is occupied by an external installation in the configured OpenCode skills home."
        : "Skill name is occupied by an external installation in this agent's Paperclip-managed OpenCode HOME.",
    externalDetail:
      source === "configured_env"
        ? "Installed outside Paperclip management in the configured OpenCode skills home."
        : "Installed outside Paperclip management in this agent's Paperclip-managed OpenCode HOME.",
  });
}

export async function listOpenCodeSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildOpenCodeSkillSnapshot(ctx);
}

export async function syncOpenCodeSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(ctx.config, __moduleDir);
  const desiredSet = new Set(desiredSkills);
  const { skillsHome } = resolveOpenCodeSkillHome(ctx.config, ctx.agentId);
  await fs.mkdir(skillsHome, { recursive: true });
  const installed = await readInstalledSkillTargets(skillsHome);
  const availableByRuntimeName = new Map(availableEntries.map((entry) => [entry.runtimeName, entry]));

  for (const available of availableEntries) {
    if (!desiredSet.has(available.key)) continue;
    const target = path.join(skillsHome, available.runtimeName);
    await ensurePaperclipSkillSymlink(available.source, target);
  }

  for (const [name, installedEntry] of installed.entries()) {
    const available = availableByRuntimeName.get(name);
    if (!available) continue;
    if (desiredSet.has(available.key)) continue;
    if (installedEntry.targetPath !== available.source) continue;
    await fs.unlink(path.join(skillsHome, name)).catch(() => {});
  }

  return buildOpenCodeSkillSnapshot(ctx);
}

export function resolveOpenCodeDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string }>,
) {
  return resolvePaperclipDesiredSkillNames(config, availableEntries);
}
