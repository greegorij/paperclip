import * as fs from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupPaperclipClaudeMcpRun,
  buildRemoteClaudeConfigMaterializationCommand,
  createDisposableClaudeConfigDir,
  prepareClaudeConfigSeed,
  sweepAbandonedPaperclipClaudeMcpRuns,
  writePaperclipClaudeMcpConfig,
} from "./claude-config.js";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("writePaperclipClaudeMcpConfig", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function makeStateDir(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-mcp-config-"));
    cleanupDirs.push(root);
    return root;
  }

  it("keeps remote project transcripts visible across two private config roots", async () => {
    const root = await makeStateDir();
    const seed = path.join(root, "seed");
    const persistentProjects = path.join(root, ".paperclip-runtime", "claude", "session-stores", "agent", "projects");
    const firstConfig = path.join(root, "runs", "run-one", "config");
    const secondConfig = path.join(root, "runs", "run-two", "config");
    await fs.mkdir(seed, { recursive: true });

    for (const privateConfig of [firstConfig, secondConfig]) {
      await execFileAsync("sh", ["-c", buildRemoteClaudeConfigMaterializationCommand({
        remoteClaudeConfigDir: privateConfig,
        remoteClaudeConfigSeedDir: seed,
        persistentProjectsDir: persistentProjects,
        persistentProjectsRemoteCwd: root,
      })]);
      expect((await fs.lstat(path.join(privateConfig, "projects"))).isSymbolicLink()).toBe(true);
      if (privateConfig === firstConfig) {
        const transcript = path.join(privateConfig, "projects", "workspace", "session.jsonl");
        await fs.mkdir(path.dirname(transcript), { recursive: true });
        await fs.writeFile(transcript, '{"type":"assistant"}\n');
        await fs.rm(firstConfig, { recursive: true, force: true });
      }
    }

    await expect(fs.readFile(
      path.join(secondConfig, "projects", "workspace", "session.jsonl"),
      "utf8",
    )).resolves.toBe('{"type":"assistant"}\n');
    expect((await fs.stat(persistentProjects)).mode & 0o777).toBe(0o700);
  });

  it("refuses an intermediate symlink in the persistent remote projects store", async () => {
    const root = await makeStateDir();
    const outside = path.join(root, "outside");
    const persistentProjects = path.join(root, ".paperclip-runtime", "claude", "session-stores", "agent", "projects");
    await fs.mkdir(path.join(root, ".paperclip-runtime"), { recursive: true });
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(root, ".paperclip-runtime", "claude"), "dir");

    await expect(execFileAsync("sh", ["-c", buildRemoteClaudeConfigMaterializationCommand({
      remoteClaudeConfigDir: path.join(root, "private-config"),
      remoteClaudeConfigSeedDir: path.join(root, "seed"),
      persistentProjectsDir: persistentProjects,
      persistentProjectsRemoteCwd: root,
    })])).rejects.toBeDefined();
  });

  /** Default Claude Code layout: profile is sibling of CLAUDE_CONFIG_DIR. */
  async function makeClaudeHomeWithProfile(mcpServers: Record<string, unknown>): Promise<string> {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-home-"));
    cleanupDirs.push(home);
    const claudeConfigDir = path.join(home, ".claude");
    await fs.mkdir(claudeConfigDir, { recursive: true });
    await fs.writeFile(
      path.join(home, ".claude.json"),
      JSON.stringify({ mcpServers }),
      "utf8",
    );
    return claudeConfigDir;
  }

  /** Explicit CLAUDE_CONFIG_DIR layout: profile lives inside the config directory. */
  async function makeClaudeConfigDirWithInsideProfile(
    mcpServers: Record<string, unknown>,
  ): Promise<string> {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-dir-"));
    cleanupDirs.push(home);
    const claudeConfigDir = path.join(home, ".claude-jarvis");
    await fs.mkdir(claudeConfigDir, { recursive: true });
    await fs.writeFile(
      path.join(claudeConfigDir, ".claude.json"),
      JSON.stringify({ mcpServers }),
      "utf8",
    );
    return claudeConfigDir;
  }

  const gatewayServer = {
    name: "gateway-tools",
    url: "https://gateway.example/mcp",
    token: "gateway-token",
    connectionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  };

  it("merges a profile stdio server (paperclip) alongside gateway servers", async () => {
    const stateDir = await makeStateDir();
    const claudeConfigDir = await makeClaudeHomeWithProfile({
      paperclip: {
        command: "npx",
        args: ["-y", "paperclipai"],
      },
    });

    const configPath = await writePaperclipClaudeMcpConfig({
      stateDir,
      runId: "run-stdio",
      servers: [gatewayServer],
      claudeConfigDir,
    });
    const written = JSON.parse(await fs.readFile(configPath, "utf8"));

    expect(written.mcpServers["gateway-tools"]).toEqual({
      type: "http",
      url: gatewayServer.url,
      headers: { Authorization: `Bearer ${gatewayServer.token}` },
    });
    expect(written.mcpServers.paperclip).toEqual({
      command: "npx",
      args: ["-y", "paperclipai"],
    });
  });

  it("does not copy a profile network (http) server into the generated config", async () => {
    const stateDir = await makeStateDir();
    const claudeConfigDir = await makeClaudeHomeWithProfile({
      remote_vendor: {
        type: "http",
        url: "https://vendor.example/mcp",
      },
      also_url_only: {
        url: "https://other.example/mcp",
      },
    });

    const configPath = await writePaperclipClaudeMcpConfig({
      stateDir,
      runId: "run-no-http",
      servers: [gatewayServer],
      claudeConfigDir,
    });
    const written = JSON.parse(await fs.readFile(configPath, "utf8"));

    expect(Object.keys(written.mcpServers)).toEqual(["gateway-tools"]);
    expect(written.mcpServers.remote_vendor).toBeUndefined();
    expect(written.mcpServers.also_url_only).toBeUndefined();
  });

  it("keeps the gateway entry when a profile allowlisted server shares the same name", async () => {
    const stateDir = await makeStateDir();
    const claudeConfigDir = await makeClaudeHomeWithProfile({
      paperclip: {
        command: "local-paperclip",
        args: ["--stdio"],
      },
    });

    const configPath = await writePaperclipClaudeMcpConfig({
      stateDir,
      runId: "run-collision",
      servers: [{
        name: "paperclip",
        url: "https://gateway.example/paperclip",
        token: "gateway-paperclip-token",
        connectionId: "11111111-2222-3333-4444-555555555555",
      }],
      claudeConfigDir,
    });
    const written = JSON.parse(await fs.readFile(configPath, "utf8"));

    expect(Object.keys(written.mcpServers)).toEqual(["paperclip"]);
    expect(written.mcpServers.paperclip).toEqual({
      type: "http",
      url: "https://gateway.example/paperclip",
      headers: { Authorization: "Bearer gateway-paperclip-token" },
    });
  });

  it("returns gateway-only config when the profile file is missing", async () => {
    const stateDir = await makeStateDir();
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-home-missing-"));
    cleanupDirs.push(home);
    const claudeConfigDir = path.join(home, ".claude");
    await fs.mkdir(claudeConfigDir, { recursive: true });

    const configPath = await writePaperclipClaudeMcpConfig({
      stateDir,
      runId: "run-missing-profile",
      servers: [gatewayServer],
      claudeConfigDir,
    });
    const written = JSON.parse(await fs.readFile(configPath, "utf8"));

    expect(written.mcpServers).toEqual({
      "gateway-tools": {
        type: "http",
        url: gatewayServer.url,
        headers: { Authorization: `Bearer ${gatewayServer.token}` },
      },
    });
  });

  it("returns gateway-only config when the profile JSON is invalid", async () => {
    const stateDir = await makeStateDir();
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-home-badjson-"));
    cleanupDirs.push(home);
    const claudeConfigDir = path.join(home, ".claude");
    await fs.mkdir(claudeConfigDir, { recursive: true });
    await fs.writeFile(path.join(home, ".claude.json"), "{ not-json", "utf8");

    const configPath = await writePaperclipClaudeMcpConfig({
      stateDir,
      runId: "run-bad-json",
      servers: [gatewayServer],
      claudeConfigDir,
    });
    const written = JSON.parse(await fs.readFile(configPath, "utf8"));

    expect(written.mcpServers).toEqual({
      "gateway-tools": {
        type: "http",
        url: gatewayServer.url,
        headers: { Authorization: `Bearer ${gatewayServer.token}` },
      },
    });
  });

  it("behaves like today when claudeConfigDir is omitted", async () => {
    const stateDir = await makeStateDir();

    const configPath = await writePaperclipClaudeMcpConfig({
      stateDir,
      runId: "run-no-dir",
      servers: [gatewayServer],
    });
    const written = JSON.parse(await fs.readFile(configPath, "utf8"));

    expect(written.mcpServers).toEqual({
      "gateway-tools": {
        type: "http",
        url: gatewayServer.url,
        headers: { Authorization: `Bearer ${gatewayServer.token}` },
      },
    });
  });

  it("finds a stdio server from .claude.json inside the config directory", async () => {
    const stateDir = await makeStateDir();
    const claudeConfigDir = await makeClaudeConfigDirWithInsideProfile({
      paperclip: {
        command: "npx",
        args: ["-y", "paperclipai"],
      },
    });

    const configPath = await writePaperclipClaudeMcpConfig({
      stateDir,
      runId: "run-inside-profile",
      servers: [gatewayServer],
      claudeConfigDir,
    });
    const written = JSON.parse(await fs.readFile(configPath, "utf8"));

    expect(written.mcpServers.paperclip).toEqual({
      command: "npx",
      args: ["-y", "paperclipai"],
    });
  });

  it("falls back to sibling .claude.json when the inside profile is missing", async () => {
    const stateDir = await makeStateDir();
    const claudeConfigDir = await makeClaudeHomeWithProfile({
      paperclip: {
        command: "npx",
        args: ["-y", "paperclipai"],
      },
    });

    const configPath = await writePaperclipClaudeMcpConfig({
      stateDir,
      runId: "run-sibling-fallback",
      servers: [gatewayServer],
      claudeConfigDir,
    });
    const written = JSON.parse(await fs.readFile(configPath, "utf8"));

    expect(written.mcpServers.paperclip).toEqual({
      command: "npx",
      args: ["-y", "paperclipai"],
    });
  });

  it("falls back to sibling when the inside profile has empty mcpServers", async () => {
    const stateDir = await makeStateDir();
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-empty-inside-"));
    cleanupDirs.push(home);
    const claudeConfigDir = path.join(home, ".claude-jarvis");
    await fs.mkdir(claudeConfigDir, { recursive: true });
    await fs.writeFile(
      path.join(claudeConfigDir, ".claude.json"),
      JSON.stringify({ mcpServers: {} }),
      "utf8",
    );
    await fs.writeFile(
      path.join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          paperclip: { command: "npx", args: ["-y", "paperclipai"] },
        },
      }),
      "utf8",
    );

    const configPath = await writePaperclipClaudeMcpConfig({
      stateDir,
      runId: "run-empty-inside-fallback",
      servers: [gatewayServer],
      claudeConfigDir,
    });
    const written = JSON.parse(await fs.readFile(configPath, "utf8"));

    expect(written.mcpServers.paperclip).toEqual({
      command: "npx",
      args: ["-y", "paperclipai"],
    });
  });

  it("prefers the inside profile when both profiles have non-empty mcpServers", async () => {
    const stateDir = await makeStateDir();
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-both-profiles-"));
    cleanupDirs.push(home);
    const claudeConfigDir = path.join(home, ".claude-jarvis");
    await fs.mkdir(claudeConfigDir, { recursive: true });
    await fs.writeFile(
      path.join(claudeConfigDir, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          paperclip: { command: "inside-cmd", args: ["--inside"] },
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          paperclip: { command: "sibling-cmd", args: ["--sibling"] },
        },
      }),
      "utf8",
    );

    const configPath = await writePaperclipClaudeMcpConfig({
      stateDir,
      runId: "run-inside-wins",
      servers: [gatewayServer],
      claudeConfigDir,
    });
    const written = JSON.parse(await fs.readFile(configPath, "utf8"));

    expect(written.mcpServers.paperclip).toEqual({
      command: "inside-cmd",
      args: ["--inside"],
    });
  });

  it("does not copy mcp-remote under a non-allowlisted name", async () => {
    const stateDir = await makeStateDir();
    const claudeConfigDir = await makeClaudeHomeWithProfile({
      vendor_proxy: {
        command: "npx",
        args: ["-y", "mcp-remote", "https://x/mcp"],
      },
    });

    const configPath = await writePaperclipClaudeMcpConfig({
      stateDir,
      runId: "run-mcp-remote-denied",
      servers: [gatewayServer],
      claudeConfigDir,
    });
    const written = JSON.parse(await fs.readFile(configPath, "utf8"));

    expect(Object.keys(written.mcpServers)).toEqual(["gateway-tools"]);
    expect(written.mcpServers.vendor_proxy).toBeUndefined();
  });

  it("copies mcp-remote when the entry is named paperclip (allowlist decides)", async () => {
    const stateDir = await makeStateDir();
    const claudeConfigDir = await makeClaudeHomeWithProfile({
      paperclip: {
        command: "npx",
        args: ["-y", "mcp-remote", "https://x/mcp"],
      },
    });

    const configPath = await writePaperclipClaudeMcpConfig({
      stateDir,
      runId: "run-mcp-remote-allowlisted",
      servers: [gatewayServer],
      claudeConfigDir,
    });
    const written = JSON.parse(await fs.readFile(configPath, "utf8"));

    expect(written.mcpServers.paperclip).toEqual({
      command: "npx",
      args: ["-y", "mcp-remote", "https://x/mcp"],
    });
  });

  it("falls back to sibling when the inside profile has only network entries", async () => {
    const stateDir = await makeStateDir();
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-network-inside-"));
    cleanupDirs.push(home);
    const claudeConfigDir = path.join(home, ".claude-jarvis");
    await fs.mkdir(claudeConfigDir, { recursive: true });
    await fs.writeFile(
      path.join(claudeConfigDir, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          remote_vendor: {
            type: "http",
            url: "https://vendor.example/mcp",
          },
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          paperclip: { command: "npx", args: ["-y", "paperclipai"] },
        },
      }),
      "utf8",
    );

    const configPath = await writePaperclipClaudeMcpConfig({
      stateDir,
      runId: "run-network-inside-sibling-kokpit",
      servers: [gatewayServer],
      claudeConfigDir,
    });
    const written = JSON.parse(await fs.readFile(configPath, "utf8"));

    expect(written.mcpServers.remote_vendor).toBeUndefined();
    expect(written.mcpServers.paperclip).toEqual({
      command: "npx",
      args: ["-y", "paperclipai"],
    });
  });

  it("skips a malformed allowlisted entry and leaves gateway servers intact", async () => {
    const stateDir = await makeStateDir();
    const claudeConfigDir = await makeClaudeHomeWithProfile({
      paperclip: {
        command: "npx",
        args: 42,
      },
    });

    const configPath = await writePaperclipClaudeMcpConfig({
      stateDir,
      runId: "run-malformed-args",
      servers: [gatewayServer],
      claudeConfigDir,
    });
    const written = JSON.parse(await fs.readFile(configPath, "utf8"));

    expect(written.mcpServers).toEqual({
      "gateway-tools": {
        type: "http",
        url: gatewayServer.url,
        headers: { Authorization: `Bearer ${gatewayServer.token}` },
      },
    });
    expect(written.mcpServers.paperclip).toBeUndefined();
  });

  it("does not read the profile when servers is empty", async () => {
    const stateDir = await makeStateDir();
    const readProfileFile = vi.fn(async () => {
      throw new Error("profile read should be skipped when servers is empty");
    });

    const configPath = await writePaperclipClaudeMcpConfig({
      stateDir,
      runId: "run-skip-empty-servers",
      servers: [],
      claudeConfigDir: "/should/not/be/read",
      _readProfileFile: readProfileFile,
    });

    expect(readProfileFile).not.toHaveBeenCalled();
    const written = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(written.mcpServers).toEqual({});
  });

  it("writes the mcp config file with mode 0o600", async () => {
    const stateDir = await makeStateDir();
    const configPath = await writePaperclipClaudeMcpConfig({
      stateDir,
      runId: "run-mode-600",
      servers: [gatewayServer],
    });
    const stat = await fs.stat(configPath);
    expect(stat.mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(path.dirname(configPath)))).mode & 0o777).toBe(0o700);
  });

  it("removes only a run carrying its exact Paperclip owner marker", async () => {
    const stateDir = await makeStateDir();
    const ownedConfig = await writePaperclipClaudeMcpConfig({
      stateDir,
      runId: "owned-run",
      servers: [gatewayServer],
    });
    const foreignRun = path.join(stateDir, "runs", "foreign-run");
    await fs.mkdir(foreignRun, { recursive: true });
    await fs.writeFile(path.join(foreignRun, ".paperclip-mcp-run"), "different-run\n");

    await cleanupPaperclipClaudeMcpRun(stateDir, "owned-run");
    await cleanupPaperclipClaudeMcpRun(stateDir, "foreign-run");

    await expect(fs.stat(ownedConfig)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(foreignRun)).resolves.toBeDefined();
    await expect(cleanupPaperclipClaudeMcpRun(stateDir, "../broad")).rejects.toThrow(/safe path segment/);
  });

  it("sweeps only abandoned owned runs and preserves live, foreign, and symlink entries", async () => {
    const stateDir = await makeStateDir();
    const abandonedPath = await writePaperclipClaudeMcpConfig({
      stateDir, runId: "abandoned-run", servers: [gatewayServer],
    });
    await fs.writeFile(path.join(stateDir, "runs", "abandoned-run", ".paperclip-mcp-run"), JSON.stringify({
      owner: "paperclip-claude-mcp", runId: "abandoned-run", pid: 999_999, createdAt: new Date().toISOString(),
    }));
    const livePath = await writePaperclipClaudeMcpConfig({
      stateDir, runId: "live-run", servers: [gatewayServer],
    });
    const foreignRun = path.join(stateDir, "runs", "foreign-run");
    await fs.mkdir(foreignRun, { recursive: true });
    await fs.writeFile(path.join(foreignRun, ".paperclip-mcp-run"), JSON.stringify({
      owner: "someone-else", runId: "foreign-run", pid: 77, createdAt: new Date().toISOString(),
    }));
    const outside = path.join(stateDir, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "sentinel"), "keep");
    await fs.symlink(outside, path.join(stateDir, "runs", "symlink-run"), "dir");

    await sweepAbandonedPaperclipClaudeMcpRuns(stateDir, {
      isProcessAlive: (pid) => pid === process.pid,
    });

    await expect(fs.access(abandonedPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(livePath)).resolves.toBeUndefined();
    await expect(fs.access(foreignRun)).resolves.toBeUndefined();
    await expect(fs.readFile(path.join(outside, "sentinel"), "utf8")).resolves.toBe("keep");
  });

  it("reports a residue removal failure without blocking the next run", async () => {
    const stateDir = await makeStateDir();
    const configPath = await writePaperclipClaudeMcpConfig({
      stateDir, runId: "undeletable-run", servers: [gatewayServer],
    });
    await fs.writeFile(path.join(stateDir, "runs", "undeletable-run", ".paperclip-mcp-run"), JSON.stringify({
      owner: "paperclip-claude-mcp", runId: "undeletable-run", pid: 999_998, createdAt: new Date().toISOString(),
    }));
    const warnings: string[] = [];

    await expect(sweepAbandonedPaperclipClaudeMcpRuns(stateDir, {
      isProcessAlive: () => false,
      removeRun: async () => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); },
      onWarning: (message) => warnings.push(message),
    })).resolves.toBeUndefined();

    expect(warnings).toEqual([expect.stringContaining("permission denied")]);
    await expect(fs.access(configPath)).resolves.toBeUndefined();
    await expect(writePaperclipClaudeMcpConfig({
      stateDir, runId: "next-run", servers: [gatewayServer],
    })).resolves.toContain(path.join("next-run", "mcp", "mcp-config.json"));
  });

  it("advances the bounded residue cursor so entries beyond one batch are not starved", async () => {
    const stateDir = await makeStateDir();
    const runsDir = path.join(stateDir, "runs");
    await fs.mkdir(runsDir, { recursive: true });
    await Promise.all(Array.from({ length: 128 }, async (_, index) => {
      const name = `foreign-${String(index).padStart(3, "0")}`;
      const dir = path.join(runsDir, name);
      await fs.mkdir(dir);
      await fs.writeFile(path.join(dir, ".paperclip-mcp-run"), "foreign\n");
    }));
    const stalePath = await writePaperclipClaudeMcpConfig({
      stateDir, runId: "zzz-stale", servers: [gatewayServer],
    });
    await fs.writeFile(path.join(runsDir, "zzz-stale", ".paperclip-mcp-run"), JSON.stringify({
      owner: "paperclip-claude-mcp", runId: "zzz-stale", pid: 999_997, createdAt: new Date().toISOString(),
    }));

    await sweepAbandonedPaperclipClaudeMcpRuns(stateDir, { isProcessAlive: () => false });
    await expect(fs.access(stalePath)).resolves.toBeUndefined();
    await sweepAbandonedPaperclipClaudeMcpRuns(stateDir, { isProcessAlive: () => false });
    await expect(fs.access(stalePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("wires MCP profile merge in execute.ts to effectiveEnv, not process.env", async () => {
    const source = await fs.readFile(path.join(__dirname, "execute.ts"), "utf8");
    expect(source).toMatch(
      /const sharedClaudeConfigDir = resolveSharedClaudeConfigDir\(effectiveEnv\);/,
    );
    expect(source).not.toMatch(
      /const sharedClaudeConfigDir = resolveSharedClaudeConfigDir\(process\.env\);/,
    );
    expect(source).toContain("cleanupPaperclipClaudeMcpRun(claudeRuntimeStateDir, runId)");
  });
});

describe("prepareClaudeConfigSeed", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  function createEnv(root: string, sourceDir: string): NodeJS.ProcessEnv {
    return {
      HOME: root,
      PAPERCLIP_HOME: path.join(root, "paperclip-home"),
      PAPERCLIP_INSTANCE_ID: "test-instance",
      CLAUDE_CONFIG_DIR: sourceDir,
    };
  }

  it("reuses the same snapshot path when the seeded files are unchanged", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-seed-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({
      theme: "light",
      permissions: { defaultMode: "bypassPermissions" },
    }), "utf8");
    await fs.writeFile(path.join(sourceDir, ".credentials.json"), JSON.stringify({ token: "local" }), "utf8");

    const onLog = vi.fn(async () => {});
    const env = createEnv(root, sourceDir);

    const first = await prepareClaudeConfigSeed(env, onLog, "company-1");
    const second = await prepareClaudeConfigSeed(env, onLog, "company-1");

    expect(first).toBe(second);
    await expect(fs.readFile(path.join(first, "settings.json"), "utf8"))
      .resolves.toBe(JSON.stringify({ theme: "light", permissions: { defaultMode: "default" } }));
    await expect(fs.access(path.join(first, ".credentials.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps an existing snapshot intact when the seeded files change", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-race-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({ theme: "light" }), "utf8");

    const onLog = vi.fn(async () => {});
    const env = createEnv(root, sourceDir);
    const first = await prepareClaudeConfigSeed(env, onLog, "company-1");

    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({ theme: "dark" }), "utf8");
    const second = await prepareClaudeConfigSeed(env, onLog, "company-1");

    expect(second).not.toBe(first);
    await expect(fs.readFile(path.join(first, "settings.json"), "utf8"))
      .resolves.toBe(JSON.stringify({ theme: "light", permissions: { defaultMode: "default" } }));
    await expect(fs.readFile(path.join(second, "settings.json"), "utf8"))
      .resolves.toBe(JSON.stringify({ theme: "dark", permissions: { defaultMode: "default" } }));
  });

  it("strips local-only settings from remote Claude config seeds", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-boundary-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({
      permissions: {
        defaultMode: "dontAsk",
        allow: ["Bash(op item *)"],
      },
      hooks: { PreToolUse: [{ matcher: "*" }] },
      mcpServers: { local: { command: "secret-local-server" } },
      permissionMode: "dontAsk",
      skipDangerousModePermissionPrompt: true,
    }), "utf8");
    await fs.writeFile(path.join(sourceDir, "settings.local.json"), JSON.stringify({
      permissions: { defaultMode: "bypassPermissions" },
    }), "utf8");
    await fs.writeFile(path.join(sourceDir, "credentials.json"), JSON.stringify({ token: "local" }), "utf8");
    await fs.writeFile(path.join(sourceDir, "CLAUDE.md"), "local instructions", "utf8");

    const onLog = vi.fn(async () => {});
    const env = createEnv(root, sourceDir);
    const seedDir = await prepareClaudeConfigSeed(env, onLog, "company-1");
    const remoteSettings = JSON.parse(await fs.readFile(path.join(seedDir, "settings.json"), "utf8"));

    expect(remoteSettings.permissions).toEqual({ defaultMode: "default" });
    expect(remoteSettings.hooks).toBeUndefined();
    expect(remoteSettings.mcpServers).toBeUndefined();
    expect(remoteSettings.permissionMode).toBeUndefined();
    expect(remoteSettings.skipDangerousModePermissionPrompt).toBeUndefined();
    await expect(fs.access(path.join(seedDir, "settings.local.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(seedDir, "credentials.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(seedDir, "CLAUDE.md"), "utf8"))
      .resolves.toBe("local instructions");
  });
});

describe("createDisposableClaudeConfigDir", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function makeSourceDir(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-disposable-src-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, ".claude");
    await fs.mkdir(sourceDir, { recursive: true });
    return sourceDir;
  }

  it("copies credentials and CLAUDE.md into a unique disposable directory", async () => {
    const sourceDir = await makeSourceDir();
    await fs.writeFile(path.join(sourceDir, ".credentials.json"), JSON.stringify({ token: "dot" }), "utf8");
    await fs.writeFile(path.join(sourceDir, "credentials.json"), JSON.stringify({ token: "plain" }), "utf8");
    await fs.writeFile(path.join(sourceDir, "CLAUDE.md"), "shadow instructions", "utf8");

    const disposableDir = await createDisposableClaudeConfigDir(sourceDir);
    cleanupDirs.push(disposableDir);

    expect(disposableDir).not.toBe(sourceDir);
    await expect(fs.readFile(path.join(disposableDir, ".credentials.json"), "utf8"))
      .resolves.toBe(JSON.stringify({ token: "dot" }));
    await expect(fs.readFile(path.join(disposableDir, "credentials.json"), "utf8"))
      .resolves.toBe(JSON.stringify({ token: "plain" }));
    await expect(fs.readFile(path.join(disposableDir, "CLAUDE.md"), "utf8"))
      .resolves.toBe("shadow instructions");

    const dirStat = await fs.stat(disposableDir);
    expect(dirStat.mode & 0o777).toBe(0o700);
    const fileStat = await fs.stat(path.join(disposableDir, ".credentials.json"));
    expect(fileStat.mode & 0o777).toBe(0o600);
  });

  it("sanitizes unsafe settings.json while leaving the source unchanged", async () => {
    const sourceDir = await makeSourceDir();
    const unsafeSettings = {
      theme: "dark",
      permissions: {
        defaultMode: "dontAsk",
        allow: ["Bash(op item *)"],
      },
      hooks: { PreToolUse: [{ matcher: "*" }] },
      mcpServers: { local: { command: "secret-local-server" } },
      permissionMode: "dontAsk",
      skipDangerousModePermissionPrompt: true,
    };
    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify(unsafeSettings), "utf8");
    await fs.writeFile(path.join(sourceDir, "CLAUDE.md"), "keep me", "utf8");

    const disposableDir = await createDisposableClaudeConfigDir(sourceDir);
    cleanupDirs.push(disposableDir);

    const stagedSettings = JSON.parse(await fs.readFile(path.join(disposableDir, "settings.json"), "utf8"));
    expect(stagedSettings).toEqual({
      theme: "dark",
      permissions: { defaultMode: "default" },
    });
    expect(stagedSettings.hooks).toBeUndefined();
    expect(stagedSettings.mcpServers).toBeUndefined();
    expect(stagedSettings.permissionMode).toBeUndefined();
    expect(stagedSettings.skipDangerousModePermissionPrompt).toBeUndefined();

    await expect(fs.readFile(path.join(sourceDir, "settings.json"), "utf8"))
      .resolves.toBe(JSON.stringify(unsafeSettings));
    await expect(fs.readFile(path.join(sourceDir, "CLAUDE.md"), "utf8"))
      .resolves.toBe("keep me");
  });

  it("does not copy non-whitelisted files, sessions, projects, or .claude.json", async () => {
    const sourceDir = await makeSourceDir();
    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({ theme: "light" }), "utf8");
    await fs.writeFile(path.join(sourceDir, "CLAUDE.md"), "ok", "utf8");
    await fs.writeFile(path.join(sourceDir, ".credentials.json"), JSON.stringify({ token: "x" }), "utf8");
    await fs.writeFile(path.join(sourceDir, "settings.local.json"), JSON.stringify({ secret: true }), "utf8");
    await fs.writeFile(path.join(sourceDir, ".claude.json"), JSON.stringify({ mcpServers: {} }), "utf8");
    await fs.mkdir(path.join(sourceDir, "sessions"), { recursive: true });
    await fs.writeFile(path.join(sourceDir, "sessions", "session.json"), "{}", "utf8");
    await fs.mkdir(path.join(sourceDir, "projects"), { recursive: true });
    await fs.writeFile(path.join(sourceDir, "projects", "proj.json"), "{}", "utf8");
    await fs.writeFile(
      path.join(path.dirname(sourceDir), ".claude.json"),
      JSON.stringify({ sibling: true }),
      "utf8",
    );

    const disposableDir = await createDisposableClaudeConfigDir(sourceDir);
    cleanupDirs.push(disposableDir);

    const stagedNames = (await fs.readdir(disposableDir)).sort();
    expect(stagedNames).toEqual([".credentials.json", "CLAUDE.md", "settings.json"]);
    await expect(fs.access(path.join(disposableDir, "settings.local.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(disposableDir, ".claude.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(disposableDir, "sessions")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(disposableDir, "projects")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes the partial temp directory when an unexpected copy error occurs", async () => {
    const sourceDir = await makeSourceDir();
    await fs.writeFile(path.join(sourceDir, ".credentials.json"), JSON.stringify({ token: "partial" }), "utf8");
    // Directory where a file is expected → readFile throws EISDIR after credentials are staged.
    await fs.mkdir(path.join(sourceDir, "settings.json"));

    const before = new Set(await fs.readdir(os.tmpdir()));
    await expect(createDisposableClaudeConfigDir(sourceDir)).rejects.toMatchObject({ code: "EISDIR" });
    const after = await fs.readdir(os.tmpdir());
    const leaked = after.filter(
      (name) => name.startsWith("paperclip-claude-disposable-") && !before.has(name),
    );
    expect(leaked).toEqual([]);
  });
});
