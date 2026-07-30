import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listOpenCodeSkills,
  syncOpenCodeSkills,
} from "@paperclipai/adapter-opencode-local/server";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createSkillDir(root: string, name: string): Promise<string> {
  const skillDir = path.join(root, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf8");
  return skillDir;
}

describe("opencode local skill sync", () => {
  const paperclipKey = "paperclipai/paperclip/paperclip";
  const cleanupDirs = new Set<string>();
  const originalHome = process.env.HOME;

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("respects explicit env.HOME and installs skills into that OpenCode home", async () => {
    const home = await makeTempDir("paperclip-opencode-skill-sync-");
    cleanupDirs.add(home);

    const ctx = {
      agentId: "agent-1",
      companyId: "company-1",
      adapterType: "opencode_local",
      config: {
        env: {
          HOME: home,
        },
        paperclipSkillSync: {
          desiredSkills: [paperclipKey],
        },
      },
    } as const;

    const before = await listOpenCodeSkills(ctx);
    expect(before.mode).toBe("persistent");
    expect(before.desiredSkills).toContain(paperclipKey);
    expect(before.entries.find((entry) => entry.key === paperclipKey)?.state).toBe("missing");

    const after = await syncOpenCodeSkills(ctx, [paperclipKey]);
    expect(after.entries.find((entry) => entry.key === paperclipKey)?.state).toBe("installed");
    expect((await fs.lstat(path.join(home, ".claude", "skills", "paperclip"))).isSymbolicLink()).toBe(true);
  });

  it("keeps per-agent managed homes isolated across sequential syncs", async () => {
    const root = await makeTempDir("paperclip-opencode-skill-isolation-");
    const skillsRoot = path.join(root, "runtime-skills");
    cleanupDirs.add(root);
    process.env.HOME = path.join(root, "host-home");

    const alphaDir = await createSkillDir(skillsRoot, "alpha");
    const betaDir = await createSkillDir(skillsRoot, "beta");
    const runtimeSkills = [
      { name: "alpha", source: alphaDir },
      { name: "beta", source: betaDir },
    ];

    const ctxA = {
      agentId: "agent-a",
      companyId: "company-1",
      adapterType: "opencode_local",
      config: {
        paperclipRuntimeSkills: runtimeSkills,
        paperclipSkillSync: {
          desiredSkills: ["alpha"],
        },
      },
    } as const;
    const ctxB = {
      agentId: "agent-b",
      companyId: "company-1",
      adapterType: "opencode_local",
      config: {
        paperclipRuntimeSkills: runtimeSkills,
        paperclipSkillSync: {
          desiredSkills: ["beta"],
        },
      },
    } as const;

    const afterA = await syncOpenCodeSkills(ctxA, ["alpha"]);
    const alphaEntryA = afterA.entries.find((entry) => entry.key === "alpha");
    expect(alphaEntryA?.state).toBe("installed");
    const alphaPathA = alphaEntryA?.targetPath ?? "";
    expect(alphaPathA).toContain(`${path.sep}.paperclip${path.sep}opencode${path.sep}agents${path.sep}`);

    const afterB = await syncOpenCodeSkills(ctxB, ["beta"]);
    const betaEntryB = afterB.entries.find((entry) => entry.key === "beta");
    expect(betaEntryB?.state).toBe("installed");
    const betaPathB = betaEntryB?.targetPath ?? "";
    expect(betaPathB).toContain(`${path.sep}.paperclip${path.sep}opencode${path.sep}agents${path.sep}`);

    expect(path.dirname(alphaPathA)).not.toBe(path.dirname(betaPathB));
    expect((await fs.lstat(alphaPathA)).isSymbolicLink()).toBe(true);
    expect(await fs.realpath(alphaPathA)).toBe(await fs.realpath(alphaDir));
    expect(await fs.realpath(betaPathB)).toBe(await fs.realpath(betaDir));

    await expect(fs.lstat(path.join(path.dirname(alphaPathA), "beta"))).rejects.toThrow();
    await expect(fs.lstat(path.join(path.dirname(betaPathB), "alpha"))).rejects.toThrow();

    const afterASecondSync = await syncOpenCodeSkills(ctxA, ["alpha"]);
    const alphaSecondPath = afterASecondSync.entries.find((entry) => entry.key === "alpha")?.targetPath;
    expect(alphaSecondPath).toBe(alphaPathA);
  });
});
