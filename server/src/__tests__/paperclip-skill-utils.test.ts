import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  listPaperclipSkillEntries,
  removeMaintainerOnlySkillSymlinks,
} from "@paperclipai/adapter-utils/server-utils";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Keep the mandatory hot-path skill short enough that agents can finish reading it before first work. */
const MAX_SKILL_MD_LINES = 220;
const MAX_SKILL_MD_BYTES = 18_000;

describe("paperclip skill utils", () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("lists bundled runtime skills from ./skills without pulling in .agents/skills", async () => {
    const root = await makeTempDir("paperclip-skill-roots-");
    cleanupDirs.add(root);

    const moduleDir = path.join(root, "a", "b", "c", "d", "e");
    await fs.mkdir(moduleDir, { recursive: true });
    await fs.mkdir(path.join(root, "skills", "paperclip"), { recursive: true });
    await fs.mkdir(path.join(root, "skills", "paperclip-create-agent"), { recursive: true });
    await fs.mkdir(path.join(root, ".agents", "skills", "diagnose-why-work-stopped"), { recursive: true });
    await fs.mkdir(path.join(root, ".agents", "skills", "paperclip-create-plugin"), { recursive: true });
    await fs.mkdir(path.join(root, ".agents", "skills", "release"), { recursive: true });
    await fs.mkdir(path.join(root, ".agents", "skills", "terminal-bench-loop"), { recursive: true });

    const entries = await listPaperclipSkillEntries(moduleDir);

    expect(entries.map((entry) => entry.key)).toEqual([
      "paperclipai/paperclip/paperclip",
      "paperclipai/paperclip/paperclip-create-agent",
    ]);
    expect(entries.map((entry) => entry.runtimeName)).toEqual([
      "paperclip",
      "paperclip-create-agent",
    ]);
    expect(entries[0]?.source).toBe(path.join(root, "skills", "paperclip"));
    expect(entries[1]?.source).toBe(path.join(root, "skills", "paperclip-create-agent"));
  });

  it("keeps the mandatory Paperclip skill short and points rare workflows at references", async () => {
    const skillBody = await fs.readFile(path.join(REPO_ROOT, "skills/paperclip/SKILL.md"), "utf8");
    const skillLines = skillBody.split(/\r?\n/).length;

    expect(skillLines).toBeLessThanOrEqual(MAX_SKILL_MD_LINES);
    expect(Buffer.byteLength(skillBody, "utf8")).toBeLessThanOrEqual(MAX_SKILL_MD_BYTES);
    expect(skillBody).toContain("How to use this skill");
    expect(skillBody).toContain("Do **not** preload `references/`");
    expect(skillBody).toContain("Never hard-code the API URL");
    expect(skillBody).toContain("never paste the API key");
    expect(skillBody).toContain("Scoped-wake fast path");
    expect(skillBody).toContain("skip Steps 1–4 entirely");
    expect(skillBody).toContain("X-Paperclip-Run-Id");
    expect(skillBody).toContain("Step 5 — Checkout");
    expect(skillBody).toContain("MUST checkout before doing any work");
    expect(skillBody).toContain("Never retry a 409");
    expect(skillBody).toContain("fails twice consecutively");
    expect(skillBody).toContain("Minimal status contract");
    expect(skillBody).toContain("`done` — work complete");
    expect(skillBody).toContain("`in_review` — a real reviewer/approval/interaction/monitor path exists");
    expect(skillBody).toContain("`blocked` — waiting on first-class `blockedByIssueIds`");
    expect(skillBody).toContain("`in_progress` — only with a live continuation");
    expect(skillBody).toContain("Critical Rules");
    expect(skillBody).toContain("references/planning.md");
    expect(skillBody).toContain("references/status-and-blocking.md");
    expect(skillBody).toContain("references/board-interactions.md");
    expect(skillBody).toContain("references/delegation.md");
    expect(skillBody).toContain("references/communication.md");
    expect(skillBody).not.toContain("## Issue-Thread Interactions");
    expect(skillBody).not.toContain("## Managing A User's Inbox");
    expect(skillBody).not.toContain("## MCP Tool Approval Gates");
    expect(skillBody).not.toContain("## Key Endpoints (Hot Routes)");
  });

  it("ships every on-demand reference named by the mandatory skill", async () => {
    const skillPath = path.resolve("skills/paperclip/SKILL.md");
    const skillBody = await fs.readFile(skillPath, "utf8");
    const referencePaths = Array.from(
      new Set(skillBody.match(/references\/[a-z0-9-]+\.md/g) ?? []),
    );

    expect(referencePaths).toEqual(expect.arrayContaining([
      "references/planning.md",
      "references/status-and-blocking.md",
      "references/board-interactions.md",
    ]));
    await Promise.all(
      referencePaths.map((referencePath) =>
        expect(fs.access(path.resolve(path.dirname(skillPath), referencePath))).resolves.toBeUndefined(),
      ),
    );
  });

  it("documents artifact uploads in the installed Paperclip skill", async () => {
    const skillBody = await fs.readFile(path.join(REPO_ROOT, "skills/paperclip/SKILL.md"), "utf8");
    const referenceBody = await fs.readFile(path.join(REPO_ROOT, "skills/paperclip/references/artifacts.md"), "utf8");

    expect(skillBody).toContain("Generated Artifacts and Work Products");
    expect(skillBody).toContain("references/artifacts.md");
    expect(skillBody).not.toContain("/api/companies/$PAPERCLIP_COMPANY_ID/issues/$PAPERCLIP_TASK_ID/attachments");
    expect(referenceBody).toContain("Generated Artifacts and Work Products");
    expect(referenceBody).toContain("scripts/paperclip-upload-artifact.sh");
    expect(referenceBody).toContain("POST");
    expect(referenceBody).toContain("/api/companies/$PAPERCLIP_COMPANY_ID/issues/$PAPERCLIP_TASK_ID/attachments");
    expect(referenceBody).toContain("/api/issues/$PAPERCLIP_TASK_ID/work-products");
    await expect(
      fs.access(path.join(REPO_ROOT, "skills/paperclip/scripts/paperclip-upload-artifact.sh")),
    ).resolves.toBeUndefined();
    await expect(fs.access(path.join(REPO_ROOT, "scripts/paperclip-upload-artifact.sh"))).rejects.toThrow();
  });

  it("uses the authoritative PATCH response to confirm monitor scheduling", async () => {
    const skillBody = await fs.readFile(path.join(REPO_ROOT, "skills/paperclip/SKILL.md"), "utf8");
    const statusBody = await fs.readFile(
      path.join(REPO_ROOT, "skills/paperclip/references/status-and-blocking.md"),
      "utf8",
    );

    expect(skillBody).toContain("references/status-and-blocking.md");
    expect(statusBody).toContain("Use that request's default full response");
    expect(statusBody).toContain("do not issue a confirming GET");
    expect(statusBody).toContain("`monitorNextCheckAt` is non-null");
    expect(statusBody).toContain("`assigneeAgentId` is set");
    expect(statusBody).toContain("`assigneeUserId` is null");
  });

  it("documents the blocked transition unblockDescriptor contract for agents", async () => {
    const skillBody = await fs.readFile(path.join(REPO_ROOT, "skills/paperclip/SKILL.md"), "utf8");
    const statusBody = await fs.readFile(
      path.join(REPO_ROOT, "skills/paperclip/references/status-and-blocking.md"),
      "utf8",
    );
    const apiReferenceBody = await fs.readFile(
      path.join(REPO_ROOT, "skills/paperclip/references/api-reference.md"),
      "utf8",
    );

    expect(skillBody).toContain("Blocked transition contract");
    expect(skillBody).toContain("references/status-and-blocking.md");
    expect(skillBody).toContain('{ "agentId": "$PAPERCLIP_AGENT_ID" }');
    expect(statusBody).toContain("Blocked transition contract");
    expect(statusBody).toContain("Agent-authored `unblockDescriptor` ownership");
    expect(statusBody).toContain("unblockDescriptor");
    expect(statusBody).toContain("Agents may only name themselves as `owner`");
    expect(statusBody).toContain('{ "agentId": "$PAPERCLIP_AGENT_ID" }');
    expect(statusBody).toContain("blockedByIssueIds");
    expect(statusBody).toContain("do **not** retry that write with a different forbidden owner");
    expect(statusBody).toContain('kind `suggest_tasks`');
    expect(statusBody).toContain("`ask_user_questions`");
    expect(statusBody).toContain('continuationPolicy: "wake_assignee"');
    expect(statusBody).toContain("Leave it `in_review` while the interaction is pending");
    expect(statusBody).toContain("Only if that interaction create also fails");
    expect(statusBody).toContain("exact board routing/action request");
    expect(statusBody).toContain("**Permission-only failure**");
    expect(statusBody).toContain("**Depth failure**");
    expect(statusBody).toContain('"defaultParentId": "<nearest-permitted-ancestor-id>"');
    expect(statusBody).toContain('"parentId": "<nearest-permitted-ancestor-id>"');
    expect(statusBody).toContain("recreate the same depth failure on board acceptance");
    expect(statusBody).toContain("use `ask_user_questions` for board routing instead of `suggest_tasks`");
    expect(statusBody).toContain("Follow-up for blocked source [<prefix>-<n>](/<prefix>/issues/<prefix>-<n>)");
    expect(statusBody).not.toContain('"owner": "board"');
    expect(apiReferenceBody).toContain("unblockDescriptor");
    expect(apiReferenceBody).toContain('{ "agentId": "<uuid>" } | { "userId": "<id>" } | "board"');
    expect(apiReferenceBody).toContain("Agent-authored `unblockDescriptor` may name only the current agent");
    expect(apiReferenceBody).toContain("do not retry with another forbidden owner");
    expect(apiReferenceBody).toContain('{ "agentId": "$PAPERCLIP_AGENT_ID" }');
    expect(apiReferenceBody).toContain("create exactly one `suggest_tasks` or `ask_user_questions` interaction");
    expect(apiReferenceBody).toContain('continuationPolicy: "wake_assignee"');
    expect(apiReferenceBody).toContain("leave the source `in_review` while the interaction is pending");
    expect(apiReferenceBody).toContain("Only if that interaction create also fails");
    expect(apiReferenceBody).toContain("Permission-only failures may use `suggest_tasks` without an explicit parent");
    expect(apiReferenceBody).toContain("nearest permitted ancestor with capacity");
    expect(apiReferenceBody).toContain('"defaultParentId": "<nearest-permitted-ancestor-id>"');
    expect(apiReferenceBody).toContain("use `ask_user_questions` instead of `suggest_tasks`");
  });

  it("keeps the create-issue-interaction-ui guide as a maintainer-only skill", async () => {
    const skillPath = path.join(REPO_ROOT, ".agents/skills/create-issue-interaction-ui/SKILL.md");
    const skillBody = await fs.readFile(skillPath, "utf8");
    const normalizedSkillBody = skillBody.replace(/\s+/g, " ");
    const normalizedLowerSkillBody = normalizedSkillBody.toLowerCase();

    expect(skillBody).toContain("name: create-issue-interaction-ui");
    expect(normalizedLowerSkillBody).toContain("developer/maintainer skill");
    expect(normalizedLowerSkillBody).toContain(
      "not the operational agents that run inside a deployed paperclip company",
    );
    expect(skillBody).toContain("packages/shared/src/constants.ts");
    expect(skillBody).toContain("server/src/services/issue-thread-interactions.ts");
    expect(skillBody).toContain("ui/src/components/IssueThreadInteractionCard.tsx");
    expect(skillBody).toContain("packages/plugins/sdk/src/testing.ts");
    await expect(fs.access(path.join(REPO_ROOT, "skills/create-issue-interaction-ui/SKILL.md"))).rejects.toThrow();
  });

  it("removes stale maintainer-only symlinks from a shared skills home", async () => {
    const root = await makeTempDir("paperclip-skill-cleanup-");
    cleanupDirs.add(root);

    const skillsHome = path.join(root, "skills-home");
    const runtimeSkill = path.join(root, "skills", "paperclip");
    const customSkill = path.join(root, "custom", "release-notes");
    const staleMaintainerSkill = path.join(root, ".agents", "skills", "release");

    await fs.mkdir(skillsHome, { recursive: true });
    await fs.mkdir(runtimeSkill, { recursive: true });
    await fs.mkdir(customSkill, { recursive: true });

    await fs.symlink(runtimeSkill, path.join(skillsHome, "paperclip"));
    await fs.symlink(customSkill, path.join(skillsHome, "release-notes"));
    await fs.symlink(staleMaintainerSkill, path.join(skillsHome, "release"));

    const removed = await removeMaintainerOnlySkillSymlinks(skillsHome, ["paperclip"]);

    expect(removed).toEqual(["release"]);
    await expect(fs.lstat(path.join(skillsHome, "release"))).rejects.toThrow();
    expect((await fs.lstat(path.join(skillsHome, "paperclip"))).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(path.join(skillsHome, "release-notes"))).isSymbolicLink()).toBe(true);
  });
});
