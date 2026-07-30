import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "@paperclipai/adapter-opencode-local/server";

type CapturePayload = {
  home: string;
  skillsDir: string;
  visibleSkills: string[];
};

async function writeFakeOpenCodeCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("models")) {
  process.stdout.write("opencode/gpt-5-nano\\n");
  process.exit(0);
}
const home = process.env.HOME || "";
const skillsDir = path.join(home, ".claude", "skills");
const visibleSkills = fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir).sort() : [];
if (process.env.PAPERCLIP_TEST_CAPTURE_PATH) {
  fs.writeFileSync(
    process.env.PAPERCLIP_TEST_CAPTURE_PATH,
    JSON.stringify({ home, skillsDir, visibleSkills }),
    "utf8",
  );
}
console.log(JSON.stringify({ type: "step_start", sessionID: "session-opencode-1" }));
console.log(JSON.stringify({ type: "text", sessionID: "session-opencode-1", part: { text: "ok" } }));
console.log(JSON.stringify({
  type: "step_finish",
  sessionID: "session-opencode-1",
  part: { cost: 0.001, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
}));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function createSkillDir(root: string, name: string): Promise<string> {
  const skillDir = path.join(root, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf8");
  return skillDir;
}

describe("opencode local execute", () => {
  it("uses a stable per-agent HOME and exposes only the agent's requested skills", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-execute-"));
    const workspace = path.join(root, "workspace");
    const runtimeSkillsRoot = path.join(root, "runtime-skills");
    const commandPath = path.join(root, "fake-opencode.js");
    const captureAPath = path.join(root, "capture-a.json");
    const captureBPath = path.join(root, "capture-b.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeOpenCodeCommand(commandPath);

    const alphaDir = await createSkillDir(runtimeSkillsRoot, "alpha");
    const betaDir = await createSkillDir(runtimeSkillsRoot, "beta");
    const runtimeSkills = [
      { name: "alpha", source: alphaDir },
      { name: "beta", source: betaDir },
    ];

    const previousHome = process.env.HOME;
    process.env.HOME = path.join(root, "paperclip-host-home");

    try {
      const resultA = await execute({
        runId: "run-opencode-a",
        agent: {
          id: "agent-a",
          companyId: "company-1",
          name: "OpenCode A",
          adapterType: "opencode_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "opencode/gpt-5-nano",
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: captureAPath,
          },
          paperclipRuntimeSkills: runtimeSkills,
          paperclipSkillSync: {
            desiredSkills: ["alpha"],
          },
        },
        context: {},
        onLog: async () => {},
      });

      const resultB = await execute({
        runId: "run-opencode-b",
        agent: {
          id: "agent-b",
          companyId: "company-1",
          name: "OpenCode B",
          adapterType: "opencode_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "opencode/gpt-5-nano",
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: captureBPath,
          },
          paperclipRuntimeSkills: runtimeSkills,
          paperclipSkillSync: {
            desiredSkills: ["beta"],
          },
        },
        context: {},
        onLog: async () => {},
      });

      expect(resultA.exitCode).toBe(0);
      expect(resultB.exitCode).toBe(0);

      const captureA = JSON.parse(await fs.readFile(captureAPath, "utf8")) as CapturePayload;
      const captureB = JSON.parse(await fs.readFile(captureBPath, "utf8")) as CapturePayload;

      expect(captureA.home).toContain(`${path.sep}.paperclip${path.sep}opencode${path.sep}agents${path.sep}`);
      expect(captureB.home).toContain(`${path.sep}.paperclip${path.sep}opencode${path.sep}agents${path.sep}`);
      expect(captureA.home).not.toBe(captureB.home);
      expect(captureA.visibleSkills).toEqual(["alpha"]);
      expect(captureB.visibleSkills).toEqual(["beta"]);

      expect(await fs.realpath(path.join(captureA.skillsDir, "alpha"))).toBe(await fs.realpath(alphaDir));
      expect(await fs.realpath(path.join(captureB.skillsDir, "beta"))).toBe(await fs.realpath(betaDir));
      await expect(fs.lstat(path.join(captureA.skillsDir, "beta"))).rejects.toThrow();
      await expect(fs.lstat(path.join(captureB.skillsDir, "alpha"))).rejects.toThrow();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
