import fs from "node:fs/promises";
import type { Stats } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildLocalProcessSandboxSpawnTarget,
  executableSandboxPlan,
  parseLocalProcessFilesystemScope,
  parseLocalProcessFilesystemWorkspaceAccess,
  parseLocalProcessNetworkAllowlist,
  parseLocalProcessNetworkScope,
  parseLocalProcessSandboxExtraPaths,
  startNetworkAllowlistProxy,
} from "./local-process-sandbox.js";
import { runChildProcess } from "./server-utils.js";

const cleanup: string[] = [];

function mountTriplets(args: string[], flag: "--bind" | "--ro-bind"): Array<[string, string]> {
  const mounts: Array<[string, string]> = [];
  for (let index = 0; index < args.length - 2; index += 1) {
    if (args[index] === flag) mounts.push([args[index + 1], args[index + 2]]);
  }
  return mounts;
}

function isDirectChildOfRoot(candidate: string): boolean {
  const normalized = path.resolve(candidate);
  return path.dirname(normalized) === path.parse(normalized).root;
}

/** Negative mount assertions required for every symlink-chain case. */
function expectNarrowExecutableMounts(mounts: string[], homeDir: string): void {
  expect(mounts).not.toContain("/");
  expect(mounts).not.toContain(homeDir);
  expect(mounts.some(isDirectChildOfRoot)).toBe(false);
}

function isStrictPathDescendant(ancestor: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(ancestor), path.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Path is reachable in the sandbox only when the argv list actually creates or
 * mounts it, and that happens before any later `--dir` / `--bind` / `--ro-bind`
 * that passes through it. Ancestor-of-a-mount is not enough — inspect args.
 */
function isSandboxReachable(candidate: string, args: string[]): boolean {
  const normalized = path.resolve(candidate);
  let availableAt = -1;

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--") break;
    if (args[index] === "--dir" && index + 1 < args.length) {
      if (path.resolve(args[index + 1]) === normalized) {
        availableAt = index;
        break;
      }
      index += 1;
      continue;
    }
    if ((args[index] === "--bind" || args[index] === "--ro-bind") && index + 2 < args.length) {
      const dest = path.resolve(args[index + 2]);
      if (dest === normalized || isStrictPathDescendant(dest, normalized)) {
        availableAt = index;
        break;
      }
      index += 2;
      continue;
    }
  }

  if (availableAt < 0) return false;

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--") break;
    if (args[index] === "--dir" && index + 1 < args.length) {
      const dirPath = path.resolve(args[index + 1]);
      if (isStrictPathDescendant(normalized, dirPath) && index < availableAt) return false;
      index += 1;
      continue;
    }
    if ((args[index] === "--bind" || args[index] === "--ro-bind") && index + 2 < args.length) {
      const dest = path.resolve(args[index + 2]);
      if (isStrictPathDescendant(normalized, dest) && index < availableAt) return false;
      index += 2;
      continue;
    }
  }

  return true;
}

/**
 * Invariant: no `--dir` / `--bind` / `--ro-bind` may target a path whose any
 * ancestor was earlier announced as `--symlink` in the same argv list.
 * Bubblewrap applies args in order; mkdir through a prior symlink kills startup.
 */
function expectNoPathCreationThroughPriorSymlink(args: string[]): void {
  const announcedSymlinks = new Set<string>();
  const violations: string[] = [];

  const hasSymlinkAncestor = (candidate: string): boolean => {
    let current = path.dirname(path.resolve(candidate));
    while (current !== path.dirname(current)) {
      if (announcedSymlinks.has(current)) return true;
      current = path.dirname(current);
    }
    return false;
  };

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--") break;
    if (args[index] === "--symlink" && index + 2 < args.length) {
      announcedSymlinks.add(path.resolve(args[index + 2]));
      index += 2;
      continue;
    }
    if (args[index] === "--dir" && index + 1 < args.length) {
      const dirPath = path.resolve(args[index + 1]);
      if (hasSymlinkAncestor(dirPath)) {
        violations.push(`--dir ${dirPath} passes through a prior --symlink`);
      }
      index += 1;
      continue;
    }
    if ((args[index] === "--bind" || args[index] === "--ro-bind") && index + 2 < args.length) {
      const dest = path.resolve(args[index + 2]);
      if (hasSymlinkAncestor(dest)) {
        violations.push(`${args[index]} ${dest} passes through a prior --symlink`);
      }
      index += 2;
      continue;
    }
  }

  expect(violations, violations.join("\n") || "expected no symlink-order violations").toEqual([]);
}

/** buildLocalProcessSandboxSpawnTarget refuses non-Linux hosts; tests need argv. */
async function withLinuxPlatform<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.platform;
  Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, "platform", { configurable: true, value: previous });
  }
}

async function withTmpDir<T>(tmpDir: string, run: () => Promise<T>): Promise<T> {
  const previousTmpDir = process.env.TMPDIR;
  process.env.TMPDIR = tmpDir;
  try {
    return await run();
  } finally {
    if (previousTmpDir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpDir;
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanup.splice(0).map((candidate) => fs.rm(candidate, { recursive: true, force: true })));
});

describe("local process sandbox", () => {
  it("parses read-only and writable extra paths", () => {
    expect(parseLocalProcessSandboxExtraPaths(["/opt/cache", { path: "/var/lib/tool", access: "rw" }])).toEqual([
      { path: "/opt/cache", access: "ro" },
      { path: "/var/lib/tool", access: "rw" },
    ]);
    expect(() => parseLocalProcessSandboxExtraPaths(["relative"])).toThrow("must be an absolute path");
  });

  it("parses network scopes and exact-host allowlists", () => {
    expect(parseLocalProcessFilesystemScope("workspace")).toBe("workspace");
    expect(parseLocalProcessFilesystemScope(undefined)).toBeNull();
    expect(() => parseLocalProcessFilesystemScope("workpace")).toThrow('filesystemScope must be "workspace"');
    expect(parseLocalProcessFilesystemWorkspaceAccess(undefined)).toBe("rw");
    expect(parseLocalProcessFilesystemWorkspaceAccess("ro")).toBe("ro");
    expect(parseLocalProcessFilesystemWorkspaceAccess("rw")).toBe("rw");
    expect(() => parseLocalProcessFilesystemWorkspaceAccess("read-only")).toThrow(
      'filesystemWorkspaceAccess must be "ro" or "rw"',
    );
    expect(parseLocalProcessNetworkScope("deny")).toBe("deny");
    expect(parseLocalProcessNetworkScope("allowlist")).toBe("allowlist");
    expect(parseLocalProcessNetworkScope(undefined)).toBeNull();
    expect(parseLocalProcessNetworkAllowlist(["api.openai.com", "https://api.anthropic.com", "gateway.test:8443"]))
      .toEqual(["api.openai.com", "api.anthropic.com", "gateway.test:8443"]);
    expect(() => parseLocalProcessNetworkAllowlist(["*.example.com"])).toThrow("exact hostname");
    expect(() => parseLocalProcessNetworkScope("public")).toThrow('"deny" or "allowlist"');
  });

  it("describes every valid allowlist input when no proxy rules remain", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-network-rules-"));
    cleanup.push(workspace);

    await expect(buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: workspace,
      options: {
        workspaceDir: workspace,
        networkScope: "allowlist",
        networkAllowlist: [],
        networkTrustedUrls: ["file:///not-a-network-target"],
      },
    })).rejects.toThrow("valid networkAllowlist hostname or HTTP(S) networkTrustedUrl");
  });

  it("builds a fresh-root bubblewrap command with workspace access", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fs-sandbox-"));
    cleanup.push(root);
    const workspace = path.join(root, "workspace");
    const managedHome = path.join(root, "managed-home");
    await fs.mkdir(workspace);
    await fs.mkdir(managedHome);

    const target = await buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", "console.log('ok')"],
      cwd: workspace,
      options: {
        workspaceDir: workspace,
        filesystemScope: "workspace",
        managedPaths: [{ path: managedHome, access: "rw" }],
        homeDir: managedHome,
      },
    });

    expect(target.command).toBe("bwrap");
    expect(target.args).toContain("--tmpfs");
    expect(target.args).toContain(workspace);
    expect(target.args).toContain(managedHome);
    expect(target.args.slice(-3)).toEqual([process.execPath, "-e", "console.log('ok')"]);
  });

  it("supports read-only workspace mount while keeping managed paths writable", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fs-sandbox-workspace-ro-"));
    cleanup.push(root);
    const workspace = path.join(root, "workspace");
    const managedHome = path.join(root, "managed-home");
    await fs.mkdir(workspace);
    await fs.mkdir(managedHome);

    const target = await buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: workspace,
      options: {
        workspaceDir: workspace,
        filesystemScope: "workspace",
        filesystemWorkspaceAccess: "ro",
        managedPaths: [{ path: managedHome, access: "rw" }],
      },
    });

    const roBinds = mountTriplets(target.args, "--ro-bind");
    const binds = mountTriplets(target.args, "--bind");
    expect(roBinds).toContainEqual([workspace, workspace]);
    expect(binds).not.toContainEqual([workspace, workspace]);
    expect(binds).toContainEqual([managedHome, managedHome]);
  });

  it("preserves merged-/usr symlink layout for top-level system paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fs-merged-usr-"));
    cleanup.push(root);
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace);

    const symlinkTargets = new Map<string, string>([
      ["/bin", "usr/bin"],
      ["/sbin", "usr/sbin"],
      ["/lib", "usr/lib"],
      ["/lib64", "usr/lib64"],
    ]);
    const originalLstat = fs.lstat.bind(fs);
    const originalReadlink = fs.readlink.bind(fs);
    vi.spyOn(fs, "lstat").mockImplementation(async (candidate) => {
      const normalized = typeof candidate === "string" ? path.resolve(candidate) : String(candidate);
      if (symlinkTargets.has(normalized)) {
        return { isSymbolicLink: () => true } as Stats;
      }
      return originalLstat(candidate);
    });
    vi.spyOn(fs, "readlink").mockImplementation(async (candidate) => {
      const normalized = typeof candidate === "string" ? path.resolve(candidate) : String(candidate);
      const target = symlinkTargets.get(normalized);
      if (target) return target;
      return originalReadlink(candidate);
    });

    const target = await buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: workspace,
      options: {
        workspaceDir: workspace,
        filesystemScope: "workspace",
      },
    });

    const toPairs = (args: string[], flag: "--ro-bind" | "--symlink"): Array<[string, string]> => {
      const pairs: Array<[string, string]> = [];
      for (let index = 0; index < args.length - 2; index += 1) {
        if (args[index] === flag) pairs.push([args[index + 1], args[index + 2]]);
      }
      return pairs;
    };

    const roBinds = toPairs(target.args, "--ro-bind");
    const symlinks = toPairs(target.args, "--symlink");
    expect(roBinds).toContainEqual(["/usr", "/usr"]);
    expect(roBinds).not.toContainEqual(["/bin", "/bin"]);
    expect(roBinds).not.toContainEqual(["/sbin", "/sbin"]);
    expect(roBinds).not.toContainEqual(["/lib", "/lib"]);
    expect(roBinds).not.toContainEqual(["/lib64", "/lib64"]);
    expect(symlinks).toEqual(expect.arrayContaining([
      ["usr/bin", "/bin"],
      ["usr/sbin", "/sbin"],
      ["usr/lib", "/lib"],
      ["usr/lib64", "/lib64"],
    ]));
  });

  it("uses ro-bind for non-merged paths and /usr fallback for missing top-level paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fs-non-merged-usr-"));
    cleanup.push(root);
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace);

    const existingTopLevel = new Set<string>(["/bin", "/sbin", "/lib"]);
    const originalLstat = fs.lstat.bind(fs);
    vi.spyOn(fs, "lstat").mockImplementation(async (candidate) => {
      const normalized = typeof candidate === "string" ? path.resolve(candidate) : String(candidate);
      if (existingTopLevel.has(normalized)) {
        return { isSymbolicLink: () => false } as Stats;
      }
      if (normalized === "/lib64") {
        const error = new Error("Mocked missing /lib64") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return originalLstat(candidate);
    });

    const target = await buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: workspace,
      options: {
        workspaceDir: workspace,
        filesystemScope: "workspace",
      },
    });

    const toPairs = (args: string[], flag: "--ro-bind" | "--symlink"): Array<[string, string]> => {
      const pairs: Array<[string, string]> = [];
      for (let index = 0; index < args.length - 2; index += 1) {
        if (args[index] === flag) pairs.push([args[index + 1], args[index + 2]]);
      }
      return pairs;
    };

    const roBinds = toPairs(target.args, "--ro-bind");
    const symlinks = toPairs(target.args, "--symlink");
    expect(roBinds).toEqual(expect.arrayContaining([
      ["/bin", "/bin"],
      ["/sbin", "/sbin"],
      ["/lib", "/lib"],
    ]));
    expect(roBinds).not.toContainEqual(["/lib64", "/lib64"]);
    expect(symlinks).toContainEqual(["usr/lib64", "/lib64"]);
  });

  it("binds a confined absolute alias to the synchronized workspace", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fs-alias-"));
    cleanup.push(root);
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace);

    const target = await buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: workspace,
      options: {
        workspaceDir: workspace,
        filesystemScope: "workspace",
        pathAliases: [{ path: "/app", target: workspace }],
      },
    });

    expect(mountTriplets(target.args, "--bind")).toContainEqual([workspace, "/app"]);
  });

  it("uses read-only mount for workspace aliases when workspace access is read-only", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fs-alias-ro-"));
    cleanup.push(root);
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace);

    const target = await buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: workspace,
      options: {
        workspaceDir: workspace,
        filesystemScope: "workspace",
        filesystemWorkspaceAccess: "ro",
        pathAliases: [{ path: "/app", target: workspace }],
      },
    });

    expect(mountTriplets(target.args, "--ro-bind")).toContainEqual([workspace, "/app"]);
    expect(mountTriplets(target.args, "--bind")).not.toContainEqual([workspace, "/app"]);
  });

  it("rejects writable out-of-tree paths without an outbound restore mapping", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fs-outbound-"));
    cleanup.push(root);
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    await fs.mkdir(workspace);
    await fs.mkdir(outside);

    await expect(buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: workspace,
      options: {
        workspaceDir: workspace,
        filesystemScope: "workspace",
        extraPaths: [{ path: outside, access: "rw" }],
      },
    })).rejects.toThrow("has no outbound restore mapping");
  });

  it("rejects writable workspace extra paths when workspace access is read-only", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fs-workspace-ro-extra-path-"));
    cleanup.push(root);
    const workspace = path.join(root, "workspace");
    const workspaceCache = path.join(workspace, ".cache");
    await fs.mkdir(workspace);
    await fs.mkdir(workspaceCache);

    await expect(buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: workspace,
      options: {
        workspaceDir: workspace,
        filesystemScope: "workspace",
        filesystemWorkspaceAccess: "ro",
        extraPaths: [{ path: workspaceCache, access: "rw" }],
      },
    })).rejects.toThrow("is inside read-only workspace");
  });

  it("builds a network-only namespace without changing filesystem visibility", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-network-sandbox-"));
    cleanup.push(workspace);
    const target = await buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", "console.log('ok')"],
      cwd: workspace,
      options: { workspaceDir: workspace, networkScope: "deny" },
    });

    expect(target.args).toContain("--unshare-net");
    expect(target.args).toContain("--bind");
    expect(target.args).not.toContain("--tmpfs");
    expect(target.env?.HTTP_PROXY).toBeUndefined();
  });

  it("forwards allowed proxy targets with a deep TMPDIR and rejects other hosts", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-network-proxy-"));
    cleanup.push(workspace);
    const deepTmpDir = path.join(workspace, ...Array.from({ length: 6 }, () => "deep-temporary-directory-segment"));
    await fs.mkdir(deepTmpDir, { recursive: true });
    const server = http.createServer((_request, response) => response.end("allowed-response"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP test server address.");
    const target = await withTmpDir(deepTmpDir, () =>
      buildLocalProcessSandboxSpawnTarget({
        executable: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: workspace,
        options: {
          workspaceDir: workspace,
          filesystemScope: "workspace",
          networkScope: "allowlist",
          networkAllowlist: [`127.0.0.1:${address.port}`],
        },
      }),
    );
    const delimiterIndex = target.args.indexOf("--");
    const socketPath = target.args[delimiterIndex + 3];
    expect(Buffer.byteLength(path.join(deepTmpDir, "paperclip-network-sandbox-XXXXXX", "proxy.sock"))).toBeGreaterThan(107);
    expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(107);
    expect(socketPath).toMatch(/^\/tmp\/paperclip-network-sandbox-/);
    expect(target.args).toContain(path.dirname(socketPath));
    const request = (url: string) => new Promise<{ status: number; contentType: string | null; body: string }>((resolve, reject) => {
      const outgoing = http.request({ socketPath, path: url, headers: { host: new URL(url).host } }, (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => resolve({
          status: response.statusCode ?? 0,
          contentType: typeof response.headers["content-type"] === "string" ? response.headers["content-type"] : null,
          body,
        }));
      });
      outgoing.on("error", reject);
      outgoing.end();
    });

    try {
      await expect(request(`http://127.0.0.1:${address.port}/canary`)).resolves.toEqual({
        status: 200,
        contentType: null,
        body: "allowed-response",
      });
      await expect(request("http://example.com/")).resolves.toEqual({
        status: 403,
        contentType: "application/json; charset=utf-8",
        body: '{"error":{"code":"network_target_denied","message":"Network target denied by Paperclip sandbox policy."}}\n',
      });
      const connectResponse = await new Promise<string>((resolve, reject) => {
        const socket = net.createConnection(socketPath, () => {
          socket.end("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
        });
        let response = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => { response += chunk; });
        socket.on("end", () => resolve(response));
        socket.on("error", reject);
      });
      expect(connectResponse).toContain("HTTP/1.1 403 Forbidden\r\n");
      expect(connectResponse).toContain("Content-Type: application/json; charset=utf-8\r\n");
      expect(connectResponse).toContain(
        '{"error":{"code":"network_target_denied","message":"Network target denied by Paperclip sandbox policy."}}\n',
      );
    } finally {
      await target.cleanup?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("tears down proxy pipes on client disconnect without uncaught EPIPE", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-network-epipe-"));
    cleanup.push(workspace);
    const socketPath = path.join(workspace, "proxy.sock");

    let streamInterval: ReturnType<typeof setInterval> | null = null;
    const upstreamServer = http.createServer((request, response) => {
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      streamInterval = setInterval(() => {
        response.write(Buffer.alloc(64 * 1024, 0x61));
      }, 5);
      const stop = () => {
        if (streamInterval) {
          clearInterval(streamInterval);
          streamInterval = null;
        }
      };
      response.on("close", stop);
      request.on("close", stop);
    });
    await new Promise<void>((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));
    const address = upstreamServer.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP test server address.");

    const proxy = await startNetworkAllowlistProxy(
      [`127.0.0.1:${address.port}`],
      [],
      socketPath,
    );

    const uncaught: Error[] = [];
    const onUncaught = (error: Error) => {
      uncaught.push(error);
    };
    process.on("uncaughtException", onUncaught);

    try {
      await new Promise<void>((resolve) => {
        const outgoing = http.request({
          socketPath,
          path: `http://127.0.0.1:${address.port}/stream`,
          headers: { host: `127.0.0.1:${address.port}` },
        }, (incoming) => {
          incoming.once("data", () => {
            outgoing.destroy();
            incoming.destroy();
            setTimeout(resolve, 250);
          });
        });
        outgoing.on("error", () => {
          // Expected once the client tears down mid-stream.
        });
        outgoing.end();
      });

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
      if (streamInterval) clearInterval(streamInterval);
      await proxy.close();
      await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
    }
  });

  it("completes successful streaming HTTP proxy responses", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-network-stream-ok-"));
    cleanup.push(workspace);
    const socketPath = path.join(workspace, "proxy.sock");

    const chunks = ["alpha-", "bravo-", "charlie-", "delta"];
    const expectedBody = chunks.join("");
    const upstreamServer = http.createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      let index = 0;
      const writeNext = () => {
        if (index >= chunks.length) {
          response.end();
          return;
        }
        const ok = response.write(chunks[index]);
        index += 1;
        if (ok) setImmediate(writeNext);
        else response.once("drain", writeNext);
      };
      writeNext();
    });
    await new Promise<void>((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));
    const address = upstreamServer.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP test server address.");

    const proxy = await startNetworkAllowlistProxy(
      [`127.0.0.1:${address.port}`],
      [],
      socketPath,
    );

    try {
      const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const outgoing = http.request({
          socketPath,
          path: `http://127.0.0.1:${address.port}/stream-ok`,
          headers: { host: `127.0.0.1:${address.port}` },
        }, (incoming) => {
          let body = "";
          incoming.setEncoding("utf8");
          incoming.on("data", (chunk) => {
            body += chunk;
          });
          incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, body }));
          incoming.on("error", reject);
        });
        outgoing.on("error", reject);
        outgoing.end();
      });

      expect(result).toEqual({ status: 200, body: expectedBody });
    } finally {
      await proxy.close();
      await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
    }
  });

  it("always permits trusted Paperclip control-plane URLs", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-network-trusted-"));
    cleanup.push(workspace);
    const server = http.createServer((_request, response) => response.end("control-plane-response"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP test server address.");
    const target = await buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: workspace,
      options: {
        workspaceDir: workspace,
        networkScope: "allowlist",
        networkAllowlist: ["api.openai.com"],
        networkTrustedUrls: [`http://127.0.0.1:${address.port}/api/issues/issue-1`],
      },
    });
    const delimiterIndex = target.args.indexOf("--");
    const socketPath = target.args[delimiterIndex + 3];

    try {
      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const outgoing = http.request({
          socketPath,
          path: `http://127.0.0.1:${address.port}/api/issues/issue-1`,
          headers: { host: `127.0.0.1:${address.port}` },
        }, (incoming) => {
          let body = "";
          incoming.on("data", (chunk) => { body += chunk; });
          incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, body }));
        });
        outgoing.on("error", reject);
        outgoing.end();
      });
      expect(response).toEqual({ status: 200, body: "control-plane-response" });
    } finally {
      await target.cleanup?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("fails clearly when Bubblewrap is unavailable", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fs-sandbox-missing-"));
    cleanup.push(workspace);
    await expect(
      runChildProcess("filesystem-sandbox-missing", process.execPath, ["-e", "process.exit(0)"], {
        cwd: workspace,
        env: {},
        timeoutSec: 10,
        graceSec: 1,
        onLog: async () => {},
        localProcessSandbox: {
          workspaceDir: workspace,
          filesystemScope: "workspace",
          command: path.join(workspace, "missing-bwrap"),
        },
      }),
    ).rejects.toThrow("requires Bubblewrap");
  });

  it.runIf(Boolean(process.env.PAPERCLIP_TEST_BWRAP))(
    "prevents reads outside the workspace while allowing workspace writes",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fs-sandbox-integration-"));
      cleanup.push(root);
      const workspace = path.join(root, "workspace");
      const outside = path.join(root, "canary.txt");
      const allowed = path.join(root, "allowed.txt");
      await fs.mkdir(workspace);
      await fs.writeFile(outside, "host-secret", "utf8");
      await fs.writeFile(allowed, "allowed-value", "utf8");

      const script = [
        "const fs = require('node:fs');",
        `try { fs.readFileSync(${JSON.stringify(outside)}, 'utf8'); process.exit(9); } catch (error) {`,
        "  if (!['ENOENT', 'EACCES'].includes(error.code)) throw error;",
        "}",
        `if (fs.readFileSync(${JSON.stringify(allowed)}, 'utf8') !== 'allowed-value') process.exit(8);`,
        "fs.writeFileSync('workspace-ok.txt', 'ok');",
      ].join("\n");
      const result = await runChildProcess("filesystem-sandbox-test", process.execPath, ["-e", script], {
        cwd: workspace,
        env: {},
        timeoutSec: 10,
        graceSec: 1,
        onLog: async () => {},
        localProcessSandbox: {
          workspaceDir: workspace,
          filesystemScope: "workspace",
          extraPaths: [{ path: allowed, access: "ro" }],
          command: process.env.PAPERCLIP_TEST_BWRAP,
        },
      });

      expect(result.exitCode, result.stderr).toBe(0);
      await expect(fs.readFile(path.join(workspace, "workspace-ok.txt"), "utf8")).resolves.toBe("ok");
    },
  );

  it.runIf(Boolean(process.env.PAPERCLIP_TEST_BWRAP && process.env.PAPERCLIP_TEST_SANDBOX_BUILD))(
    "runs the adapter-utils TypeScript build inside the confined workspace",
    async () => {
      const workspace = process.cwd();
      const result = await runChildProcess(
        "filesystem-sandbox-build-test",
        path.join(workspace, "node_modules", ".bin", "tsc"),
        ["--noEmit", "-p", "packages/adapter-utils/tsconfig.json"],
        {
          cwd: workspace,
          env: {},
          timeoutSec: 60,
          graceSec: 2,
          onLog: async () => {},
          localProcessSandbox: {
            workspaceDir: workspace,
            filesystemScope: "workspace",
            command: process.env.PAPERCLIP_TEST_BWRAP,
          },
        },
      );

      expect(result.exitCode, result.stderr).toBe(0);
    },
  );

  it.runIf(Boolean(process.env.PAPERCLIP_TEST_BWRAP))(
    "denies direct network egress",
    async () => {
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-network-deny-"));
      cleanup.push(workspace);
      const server = http.createServer((_request, response) => response.end("host-network"));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP test server address.");
      const script = `require("node:http").get("http://127.0.0.1:${address.port}", () => process.exit(9)).on("error", () => process.exit(0));`;
      try {
        const result = await runChildProcess("network-sandbox-deny-test", process.execPath, ["-e", script], {
          cwd: workspace,
          env: {},
          timeoutSec: 10,
          graceSec: 1,
          onLog: async () => {},
          localProcessSandbox: {
            workspaceDir: workspace,
            networkScope: "deny",
            command: process.env.PAPERCLIP_TEST_BWRAP,
          },
        });
        expect(result.exitCode, result.stderr).toBe(0);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it.runIf(Boolean(process.env.PAPERCLIP_TEST_BWRAP))(
    "allows only configured network targets through the proxy bridge",
    async () => {
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-network-allowlist-"));
      cleanup.push(workspace);
      const server = http.createServer((_request, response) => response.end("allowed-response"));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP test server address.");
      const targetUrl = `http://127.0.0.1:${address.port}/canary`;
      const deniedUrl = "http://example.com/";
      const script = `
const http = require("node:http");
const proxy = new URL(process.env.HTTP_PROXY);
function request(url) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: proxy.hostname, port: proxy.port, path: url }, (response) => {
      let body = "";
      response.on("data", (chunk) => body += chunk);
      response.on("end", () => resolve({ status: response.statusCode, body }));
    }).on("error", reject);
  });
}
(async () => {
  const allowed = await request(${JSON.stringify(targetUrl)});
  const denied = await request(${JSON.stringify(deniedUrl)});
  if (allowed.status !== 200 || allowed.body !== "allowed-response" || denied.status !== 403) process.exit(8);
})().catch((error) => { console.error(error); process.exit(7); });
`;
      try {
        const deepTmpDir = path.join(workspace, ...Array.from({ length: 6 }, () => "deep-temporary-directory-segment"));
        await fs.mkdir(deepTmpDir, { recursive: true });
        const result = await withTmpDir(deepTmpDir, () =>
          runChildProcess(
            "network-sandbox-allowlist-test",
            process.execPath,
            ["-e", script],
            {
              cwd: workspace,
              env: {},
              timeoutSec: 10,
              graceSec: 1,
              onLog: async () => {},
              localProcessSandbox: {
                workspaceDir: workspace,
                filesystemScope: "workspace",
                networkScope: "allowlist",
                networkAllowlist: [`127.0.0.1:${address.port}`],
                command: process.env.PAPERCLIP_TEST_BWRAP,
              },
            },
          ),
        );
        expect(result.exitCode, result.stderr).toBe(0);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  describe("executableSandboxPlan symlink chain", () => {
    async function makeFixtureRoot(prefix: string): Promise<string> {
      // Realpath so macOS `/var → private/var` is not mistaken for an install hop.
      const raw = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
      cleanup.push(raw);
      return fs.realpath(raw);
    }

    it("recreates a two-level Codex-style chain with a relative directory hop", async () => {
      const root = await makeFixtureRoot("paperclip-exec-plan-codex-");
      const homeDir = path.join(root, "home");
      const localBin = path.join(homeDir, ".local", "bin");
      const version = "0.146.0-alpha.1";
      const standalone = path.join(root, "npm", "codex", "standalone");
      const releaseRoot = path.join(standalone, "releases", version);
      const realBin = path.join(releaseRoot, "bin", "codex");
      const currentLink = path.join(standalone, "current");
      const command = path.join(localBin, "codex");

      await fs.mkdir(localBin, { recursive: true });
      await fs.mkdir(path.join(releaseRoot, "bin"), { recursive: true });
      await fs.writeFile(path.join(releaseRoot, "package.json"), "{\"name\":\"codex\"}\n");
      await fs.writeFile(realBin, "#!/bin/sh\n");
      await fs.symlink(`releases/${version}`, currentLink);
      await fs.symlink(path.join(currentLink, "bin", "codex"), command);

      const plan = await executableSandboxPlan(command);

      expect(plan.mounts).toContain(releaseRoot);
      expect(plan.mounts).toContain(localBin);
      expect(plan.mounts).not.toContain(standalone);
      expect(plan.mounts).not.toContain(path.join(standalone, "releases"));
      expectNarrowExecutableMounts(plan.mounts, homeDir);

      expect(plan.symlinks).toEqual(expect.arrayContaining([
        { linkPath: command, target: path.join(currentLink, "bin", "codex") },
        { linkPath: currentLink, target: `releases/${version}` },
      ]));
      expect(plan.symlinks).toHaveLength(2);
      const currentEntry = plan.symlinks.find((entry) => entry.linkPath === currentLink);
      expect(currentEntry?.target).toBe(`releases/${version}`);
      expect(path.isAbsolute(currentEntry!.target)).toBe(false);
    });

    it("matches production Codex two-level chain without package.json (mounts bin, not release root)", async () => {
      // Production Codex installs under ~/.codex/packages/standalone have no
      // package.json in the release tree. Place a package.json ABOVE the
      // install (in the fixture home) so an uncapped nearestPackageRoot walk
      // would return home as a mount — the negative assertion can then fail.
      const root = await makeFixtureRoot("paperclip-exec-plan-codex-prod-");
      const homeDir = path.join(root, "home");
      const workspace = path.join(root, "workspace");
      const localBin = path.join(homeDir, ".local", "bin");
      const version = "0.146.0-x86_64-unknown-linux-musl";
      const standalone = path.join(homeDir, ".codex", "packages", "standalone");
      const releaseRoot = path.join(standalone, "releases", version);
      const releaseBin = path.join(releaseRoot, "bin");
      const realBin = path.join(releaseBin, "codex");
      const currentLink = path.join(standalone, "current");
      const command = path.join(localBin, "codex");

      await fs.mkdir(workspace, { recursive: true });
      await fs.mkdir(localBin, { recursive: true });
      await fs.mkdir(releaseBin, { recursive: true });
      // Ignition: package.json above the install tree, at the fixture home.
      await fs.writeFile(path.join(homeDir, "package.json"), "{\"name\":\"fixture-home\"}\n");
      await fs.writeFile(realBin, "#!/bin/sh\n");
      await fs.symlink(`releases/${version}`, currentLink);
      await fs.symlink(path.join(currentLink, "bin", "codex"), command);

      // Align os.homedir() with the fixture home so the package-root ceiling applies.
      const previousHome = process.env.HOME;
      process.env.HOME = homeDir;
      let plan: Awaited<ReturnType<typeof executableSandboxPlan>>;
      try {
        plan = await executableSandboxPlan(command);
      } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
      }

      // Ceiling must keep home out of mounts; fallback is dirname(realpath)=releaseBin.
      expectNarrowExecutableMounts(plan.mounts, homeDir);
      expect(plan.mounts).toContain(releaseBin);
      expect(plan.mounts).not.toContain(releaseRoot);
      expect(plan.mounts).toContain(localBin);
      expect(plan.mounts).not.toContain(standalone);
      expect(plan.mounts).not.toContain(path.join(standalone, "releases"));

      expect(plan.symlinks).toEqual(expect.arrayContaining([
        { linkPath: command, target: path.join(currentLink, "bin", "codex") },
        { linkPath: currentLink, target: `releases/${version}` },
      ]));
      expect(plan.symlinks).toHaveLength(2);
      const currentEntry = plan.symlinks.find((entry) => entry.linkPath === currentLink);
      expect(currentEntry?.target).toBe(`releases/${version}`);
      expect(path.isAbsolute(currentEntry!.target)).toBe(false);

      // Relative current → releases/<version> must resolve inside the sandbox:
      // releaseRoot must appear as --dir (or mount) in argv before anything under it.
      const currentTargetResolved = path.resolve(path.dirname(currentLink), currentEntry!.target);
      expect(currentTargetResolved).toBe(releaseRoot);
      const target = await withLinuxPlatform(() =>
        buildLocalProcessSandboxSpawnTarget({
          executable: command,
          args: ["--version"],
          cwd: workspace,
          options: {
            workspaceDir: workspace,
            filesystemScope: "workspace",
            homeDir,
          },
        }),
      );
      expect(isSandboxReachable(releaseRoot, target.args)).toBe(true);
    });

    it("walks three or more symlink hops without hard-coding depth two", async () => {
      const root = await makeFixtureRoot("paperclip-exec-plan-deep-");
      const homeDir = path.join(root, "home");
      const localBin = path.join(homeDir, ".local", "bin");
      const vendor = path.join(root, "vendor");
      const releaseRoot = path.join(vendor, "pkg");
      const realBin = path.join(releaseRoot, "bin", "tool");
      const hopA = path.join(vendor, "hop-a");
      const hopB = path.join(vendor, "hop-b");
      const command = path.join(localBin, "tool");

      await fs.mkdir(localBin, { recursive: true });
      await fs.mkdir(path.join(releaseRoot, "bin"), { recursive: true });
      await fs.writeFile(path.join(releaseRoot, "package.json"), "{\"name\":\"tool\"}\n");
      await fs.writeFile(realBin, "#!/bin/sh\n");
      await fs.symlink("pkg", hopB);
      await fs.symlink("hop-b", hopA);
      await fs.symlink(path.join(hopA, "bin", "tool"), command);

      const plan = await executableSandboxPlan(command);

      expect(plan.mounts).toContain(releaseRoot);
      expect(plan.mounts).toContain(localBin);
      expect(plan.symlinks).toHaveLength(3);
      expect(plan.symlinks).toEqual(expect.arrayContaining([
        { linkPath: command, target: path.join(hopA, "bin", "tool") },
        { linkPath: hopA, target: "hop-b" },
        { linkPath: hopB, target: "pkg" },
      ]));
      expect(plan.symlinks.every((entry) => entry.linkPath === command || !path.isAbsolute(entry.target))).toBe(true);
      expectNarrowExecutableMounts(plan.mounts, homeDir);
    });

    it("returns empty symlinks for a plain executable and keeps prior mounts", async () => {
      const root = await makeFixtureRoot("paperclip-exec-plan-plain-");
      const packageRoot = path.join(root, "pkg");
      const command = path.join(packageRoot, "bin", "tool");
      await fs.mkdir(path.dirname(command), { recursive: true });
      await fs.writeFile(path.join(packageRoot, "package.json"), "{\"name\":\"tool\"}\n");
      await fs.writeFile(command, "#!/bin/sh\n");

      const plan = await executableSandboxPlan(command);

      expect(plan.symlinks).toEqual([]);
      expect(plan.mounts).toEqual(expect.arrayContaining([path.dirname(command), packageRoot]));
      expect(plan.mounts).toHaveLength(2);
    });

    it("preserves Claude-style single-hop mounts and records one symlink", async () => {
      const root = await makeFixtureRoot("paperclip-exec-plan-claude-");
      const homeDir = path.join(root, "home");
      const localBin = path.join(homeDir, ".local", "bin");
      const packageRoot = path.join(root, "claude-pkg");
      const realBin = path.join(packageRoot, "bin", "claude");
      const command = path.join(localBin, "claude");

      await fs.mkdir(localBin, { recursive: true });
      await fs.mkdir(path.dirname(realBin), { recursive: true });
      await fs.writeFile(path.join(packageRoot, "package.json"), "{\"name\":\"claude\"}\n");
      await fs.writeFile(realBin, "#!/bin/sh\n");
      await fs.symlink(realBin, command);

      const plan = await executableSandboxPlan(command);

      expect(plan.mounts).toEqual(expect.arrayContaining([localBin, packageRoot]));
      expect(plan.mounts).toHaveLength(2);
      expect(plan.symlinks).toEqual([{ linkPath: command, target: realBin }]);
      expectNarrowExecutableMounts(plan.mounts, homeDir);
    });

    it("terminates self and mutual cycles without throwing", async () => {
      const root = await makeFixtureRoot("paperclip-exec-plan-cycle-");
      const homeDir = path.join(root, "home");
      const selfLink = path.join(root, "self");
      const a = path.join(root, "a");
      const b = path.join(root, "b");
      await fs.symlink(selfLink, selfLink);
      await fs.symlink(b, a);
      await fs.symlink(a, b);

      await expect(executableSandboxPlan(selfLink)).resolves.toMatchObject({
        mounts: expect.arrayContaining([path.dirname(selfLink)]),
      });
      const selfPlan = await executableSandboxPlan(selfLink);
      expect(selfPlan.symlinks.length).toBeGreaterThanOrEqual(1);
      expectNarrowExecutableMounts(selfPlan.mounts, homeDir);

      await expect(executableSandboxPlan(a)).resolves.toMatchObject({
        mounts: expect.arrayContaining([path.dirname(a)]),
      });
      const mutualPlan = await executableSandboxPlan(a);
      expect(mutualPlan.symlinks.length).toBeGreaterThanOrEqual(1);
      expectNarrowExecutableMounts(mutualPlan.mounts, homeDir);
    });

    it("sees a directory symlink near the root without canonicalizing the base", async () => {
      const root = await makeFixtureRoot("paperclip-exec-plan-near-root-");
      const homeDir = path.join(root, "home");
      // Keep the install under an un-realpath'd alias so the directory hop remains on the walk.
      const realTree = path.join(root, "real-tree");
      const aliasTree = path.join(root, "alias-tree");
      const packageRoot = path.join(realTree, "pkg");
      const realBin = path.join(packageRoot, "bin", "tool");
      const command = path.join(aliasTree, "pkg", "bin", "tool");

      await fs.mkdir(path.dirname(realBin), { recursive: true });
      await fs.writeFile(path.join(packageRoot, "package.json"), "{\"name\":\"tool\"}\n");
      await fs.writeFile(realBin, "#!/bin/sh\n");
      // Relative target — proves the walk does not absolutize directory-link targets.
      await fs.symlink("real-tree", aliasTree);

      const plan = await executableSandboxPlan(command);

      expect(plan.symlinks).toEqual([
        { linkPath: aliasTree, target: "real-tree" },
      ]);
      expect(plan.mounts).toContain(packageRoot);
      expect(plan.mounts).toContain(path.dirname(command));
      expect(plan.mounts).not.toContain(aliasTree);
      expectNarrowExecutableMounts(plan.mounts, homeDir);
    });
  });

  describe("sandbox argv does not create paths through prior symlinks", () => {
    async function makeFixtureRoot(prefix: string): Promise<string> {
      const raw = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
      cleanup.push(raw);
      return fs.realpath(raw);
    }

    it("does not --dir/--bind under a directory symlink hop on the command path", async () => {
      // First symlink on the command path is a directory component (alias-tree),
      // not a file at the leaf — the bug fires when mkdir walks through it.
      const root = await makeFixtureRoot("paperclip-sandbox-argv-alias-tree-");
      const workspace = path.join(root, "workspace");
      const realTree = path.join(root, "real-tree");
      const aliasTree = path.join(root, "alias-tree");
      const packageRoot = path.join(realTree, "pkg");
      const realBin = path.join(packageRoot, "bin", "tool");
      const command = path.join(aliasTree, "pkg", "bin", "tool");

      await fs.mkdir(workspace, { recursive: true });
      await fs.mkdir(path.dirname(realBin), { recursive: true });
      await fs.writeFile(path.join(packageRoot, "package.json"), "{\"name\":\"tool\"}\n");
      await fs.writeFile(realBin, "#!/bin/sh\n");
      await fs.symlink("real-tree", aliasTree);

      const target = await withLinuxPlatform(() =>
        buildLocalProcessSandboxSpawnTarget({
          executable: command,
          args: ["--version"],
          cwd: workspace,
          options: {
            workspaceDir: workspace,
            filesystemScope: "workspace",
          },
        }),
      );

      expectNoPathCreationThroughPriorSymlink(target.args);
    });

    it("does not --dir/--bind under a home directory that is itself a symlink", async () => {
      // Common production layout: $HOME is a symlink to another tree. The first
      // hop on the command path is then the home directory itself.
      const root = await makeFixtureRoot("paperclip-sandbox-argv-home-link-");
      const workspace = path.join(root, "workspace");
      const realHome = path.join(root, "real-home");
      const homeDir = path.join(root, "home");
      const localBin = path.join(homeDir, ".local", "bin");
      const packageRoot = path.join(homeDir, ".codex", "packages", "standalone", "pkg");
      const realBin = path.join(packageRoot, "bin", "tool");
      const command = path.join(localBin, "tool");

      await fs.mkdir(workspace, { recursive: true });
      await fs.mkdir(realHome, { recursive: true });
      await fs.symlink("real-home", homeDir);
      await fs.mkdir(path.dirname(realBin), { recursive: true });
      await fs.mkdir(localBin, { recursive: true });
      await fs.writeFile(path.join(packageRoot, "package.json"), "{\"name\":\"tool\"}\n");
      await fs.writeFile(realBin, "#!/bin/sh\n");
      await fs.symlink(realBin, command);

      const target = await withLinuxPlatform(() =>
        buildLocalProcessSandboxSpawnTarget({
          executable: command,
          args: ["--version"],
          cwd: workspace,
          options: {
            workspaceDir: workspace,
            filesystemScope: "workspace",
            homeDir,
          },
        }),
      );

      expectNoPathCreationThroughPriorSymlink(target.args);
    });
  });
});
