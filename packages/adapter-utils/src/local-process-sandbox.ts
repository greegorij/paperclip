import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export type LocalProcessSandboxAccess = "ro" | "rw";
export type LocalProcessNetworkScope = "deny" | "allowlist";

export interface LocalProcessSandboxPath {
  path: string;
  access: LocalProcessSandboxAccess;
}

export interface LocalProcessSandboxPathAlias {
  path: string;
  target: string;
}

export interface LocalProcessSandboxOptions {
  workspaceDir: string;
  filesystemScope?: "workspace" | null;
  filesystemWorkspaceAccess?: LocalProcessSandboxAccess | null;
  managedPaths?: LocalProcessSandboxPath[];
  extraPaths?: LocalProcessSandboxPath[];
  pathAliases?: LocalProcessSandboxPathAlias[];
  outboundRestorePaths?: string[];
  homeDir?: string | null;
  networkScope?: LocalProcessNetworkScope | null;
  networkAllowlist?: string[];
  networkTrustedUrls?: string[];
  command?: string;
}

export interface LocalProcessSandboxSpawnTarget {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  cleanup?: () => Promise<void>;
}

interface NetworkAllowlistRule {
  hostname: string;
  port: string | null;
}

interface NetworkAllowlistProxy {
  close: () => Promise<void>;
}

export type { NetworkAllowlistProxy };

const SYSTEM_READ_PATHS = [
  "/usr",
  "/etc/ca-certificates",
  "/etc/ssl",
  "/etc/resolv.conf",
  "/etc/hosts",
  "/etc/nsswitch.conf",
  "/etc/passwd",
  "/etc/group",
  "/etc/localtime",
  "/etc/timezone",
  "/etc/gitconfig",
] as const;

const TOP_LEVEL_SYSTEM_PATH_FALLBACKS = [
  ["/bin", "usr/bin"],
  ["/sbin", "usr/sbin"],
  ["/lib", "usr/lib"],
  ["/lib64", "usr/lib64"],
] as const;

const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"] as const;
const SANDBOX_PROXY_PORT = 31_337;
const UNIX_SOCKET_PATH_MAX_BYTES = 107;
const NETWORK_PROXY_TEMP_PREFIX = "paperclip-network-sandbox-";

function normalizeAbsolutePath(candidate: string, label: string): string {
  const trimmed = candidate.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) {
    throw new Error(`${label} must be an absolute path.`);
  }
  return path.resolve(trimmed);
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.lstat(candidate).then(() => true).catch(() => false);
}

function parentDirectories(candidate: string): string[] {
  const directories: string[] = [];
  let current = path.dirname(candidate);
  while (current !== path.dirname(current)) {
    directories.push(current);
    current = path.dirname(current);
  }
  return directories.reverse();
}

function addParentDirectories(args: string[], created: Set<string>, candidate: string): void {
  for (const directory of parentDirectories(candidate)) {
    if (created.has(directory)) continue;
    args.push("--dir", directory);
    created.add(directory);
  }
}

async function nearestPackageRoot(candidate: string): Promise<string> {
  // Cap the upward walk at the user home directory. Without this ceiling, a
  // package.json in $HOME (or any ancestor below /) becomes the "package root"
  // and the whole home tree is mounted into the sandbox.
  const fallback = path.dirname(candidate);
  const ceiling = path.resolve(os.homedir());
  let current = path.dirname(candidate);
  while (current !== path.dirname(current)) {
    if (path.resolve(current) === ceiling) return fallback;
    if (await pathExists(path.join(current, "package.json"))) return current;
    current = path.dirname(current);
  }
  return fallback;
}

const EXECUTABLE_SYMLINK_MAX_STEPS = 40;

export interface ExecutableSandboxPlan {
  mounts: string[];
  symlinks: Array<{ linkPath: string; target: string }>;
}

/**
 * First symlink along `candidate` (including intermediate directory links).
 * Uses lexical prefixes only — never realpath — so near-root directory
 * symlinks remain visible to the walk.
 */
async function firstSymlinkInPath(candidate: string): Promise<string | null> {
  const absolute = path.resolve(candidate);
  if (absolute === path.parse(absolute).root) return null;
  const parts = absolute.split(path.sep);
  let prefix = "";
  for (let index = 1; index < parts.length; index += 1) {
    prefix += `${path.sep}${parts[index]}`;
    try {
      const stat = await fs.lstat(prefix);
      if (stat.isSymbolicLink()) return prefix;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Build sandbox mounts and in-sandbox symlink recreations for an executable.
 *
 * Mounts only the command directory and the package root of the fully resolved
 * path. Symlink chain hops (literal readlink targets, including relative ones)
 * are returned for recreation via `addSymlink` — parent stop directories are
 * not mounted.
 *
 * Never throws: on read errors, cycles, or step limits, returns what was
 * collected so far.
 */
export async function executableSandboxPlan(command: string): Promise<ExecutableSandboxPlan> {
  const mounts = new Set<string>();
  const symlinks: Array<{ linkPath: string; target: string }> = [];
  const visited = new Set<string>();

  mounts.add(path.dirname(command));

  // Resolve lexically only (no realpath) so directory symlinks stay visible.
  let current = path.resolve(command);
  for (let step = 0; step < EXECUTABLE_SYMLINK_MAX_STEPS; step += 1) {
    let linkPath: string | null;
    try {
      linkPath = await firstSymlinkInPath(current);
    } catch {
      break;
    }
    if (!linkPath || visited.has(linkPath)) break;
    visited.add(linkPath);

    let target: string;
    try {
      target = await fs.readlink(linkPath);
    } catch {
      break;
    }
    // Keep the target exactly as readlink returned it (relative targets stay relative).
    symlinks.push({ linkPath, target });

    const resolvedTarget = path.isAbsolute(target)
      ? target
      : path.resolve(path.dirname(linkPath), target);
    const suffix = current.length > linkPath.length ? current.slice(linkPath.length) : "";
    current = path.normalize(`${resolvedTarget}${suffix}`);
  }

  try {
    const realCommand = await fs.realpath(command).catch(() => command);
    mounts.add(await nearestPackageRoot(realCommand));
  } catch {
    // Keep mounts collected so far.
  }

  return { mounts: Array.from(mounts), symlinks };
}

async function applyExecutableSandboxPlan(
  command: string,
  mount: (source: string, access: LocalProcessSandboxAccess) => Promise<void>,
  addSymlink: (linkPath: string, target: string) => void,
): Promise<void> {
  const plan = await executableSandboxPlan(command);
  // Mounts first, then symlinks. Bubblewrap applies args in order: announcing a
  // --symlink and later --dir/--bind through it fails with "No such file or
  // directory". Mounts that already materialize a path as a directory (or cover
  // an ancestor) make recreating that hop unnecessary — and harmful.
  for (const mountPath of plan.mounts) await mount(mountPath, "ro");
  for (const entry of plan.symlinks) addSymlink(entry.linkPath, entry.target);
}

function parseNetworkAllowlistEntry(entry: string, index: number): NetworkAllowlistRule {
  const trimmed = entry.trim();
  if (!trimmed) throw new Error(`networkAllowlist[${index}] must not be empty.`);
  let hostname: string;
  let port: string | null;
  try {
    const parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new Error("path");
    }
    hostname = parsed.hostname.toLowerCase();
    port = parsed.port || null;
  } catch {
    throw new Error(`networkAllowlist[${index}] must be a hostname, hostname:port, or origin URL.`);
  }
  if (!hostname || hostname === "*" || hostname.startsWith("*.")) {
    throw new Error(`networkAllowlist[${index}] must use an exact hostname; wildcards are not supported.`);
  }
  return { hostname, port };
}

export function parseLocalProcessNetworkAllowlist(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    if (typeof entry !== "string") throw new Error(`networkAllowlist[${index}] must be a string.`);
    const rule = parseNetworkAllowlistEntry(entry, index);
    return rule.port ? `${rule.hostname}:${rule.port}` : rule.hostname;
  });
}

export function parseLocalProcessNetworkScope(value: unknown): LocalProcessNetworkScope | null {
  if (value == null || value === "") return null;
  if (value === "deny" || value === "allowlist") return value;
  throw new Error('networkScope must be "deny" or "allowlist".');
}

export function parseLocalProcessFilesystemScope(value: unknown): "workspace" | null {
  if (value == null || value === "") return null;
  if (value === "workspace") return value;
  throw new Error('filesystemScope must be "workspace".');
}

export function parseLocalProcessFilesystemWorkspaceAccess(value: unknown): LocalProcessSandboxAccess {
  if (value == null || value === "") return "rw";
  if (value === "ro" || value === "rw") return value;
  throw new Error('filesystemWorkspaceAccess must be "ro" or "rw".');
}

function isNetworkTargetAllowed(hostname: string, port: string, rules: NetworkAllowlistRule[]): boolean {
  const normalizedHostname = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return rules.some((rule) => rule.hostname === normalizedHostname && (rule.port === null || rule.port === port));
}

function assertUnixSocketPathLength(socketPath: string): void {
  const pathBytes = Buffer.byteLength(socketPath);
  if (pathBytes > UNIX_SOCKET_PATH_MAX_BYTES) {
    throw new Error(
      `Paperclip sandbox proxy socket path is ${pathBytes} bytes, exceeding the Linux limit of ${UNIX_SOCKET_PATH_MAX_BYTES}: ${socketPath}`,
    );
  }
}

async function createNetworkProxyTempDir(): Promise<string> {
  const candidates = Array.from(new Set(["/tmp", os.tmpdir()]));
  let lastError: unknown;
  for (const baseDir of candidates) {
    try {
      const tempDir = await fs.mkdtemp(path.join(baseDir, NETWORK_PROXY_TEMP_PREFIX));
      try {
        assertUnixSocketPathLength(path.join(tempDir, "proxy.sock"));
        return tempDir;
      } catch (error) {
        await fs.rm(tempDir, { recursive: true, force: true });
        lastError = error;
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error("Unable to create a Linux-safe Paperclip sandbox proxy socket directory.", { cause: lastError });
}

function parseTrustedNetworkUrl(value: string): NetworkAllowlistRule | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return {
      hostname: parsed.hostname.toLowerCase(),
      port: parsed.port || (parsed.protocol === "https:" ? "443" : "80"),
    };
  } catch {
    return null;
  }
}

function writeProxyError(response: http.ServerResponse, status: number, code: string, message: string): void {
  const body = `${JSON.stringify({ error: { code, message } })}\n`;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  }).end(body);
}

/**
 * Symmetric teardown for a bidirectional socket pair (CONNECT). Error or close
 * on either side destroys both peers so EPIPE never becomes an uncaught
 * process-level Socket error. Do not use for HTTP request/response hops —
 * IncomingMessage `close` is part of a successful lifecycle.
 */
function bindProxyPairTeardown(
  left: { destroy: (error?: Error) => void; on: (event: string, listener: (...args: unknown[]) => void) => void },
  right: { destroy: (error?: Error) => void; on: (event: string, listener: (...args: unknown[]) => void) => void },
): void {
  let closed = false;
  const closePair = () => {
    if (closed) return;
    closed = true;
    left.destroy();
    right.destroy();
  };
  left.on("error", closePair);
  right.on("error", closePair);
  left.on("close", closePair);
  right.on("close", closePair);
}

/**
 * Abort/error-scoped lifecycle for an HTTP reverse-proxy hop.
 * Normal request completion must finish the upstream request and allow the
 * full upstream response; only abort, error, or premature downstream close
 * tears down peers. Error listeners on both pipe sides swallow EPIPE.
 */
function bindHttpProxyLifecycle(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  upstream: http.ClientRequest,
): { bindUpstreamResponse: (upstreamResponse: http.IncomingMessage) => void } {
  let upstreamResponse: http.IncomingMessage | undefined;

  const destroyUpstreamSide = () => {
    if (!upstream.destroyed) upstream.destroy();
    if (upstreamResponse && !upstreamResponse.destroyed) upstreamResponse.destroy();
  };

  const onClientAbortOrError = () => {
    destroyUpstreamSide();
  };

  request.on("aborted", onClientAbortOrError);
  request.on("error", onClientAbortOrError);
  request.on("close", () => {
    // Premature destroy / disconnect before the full request body arrived.
    if (!request.complete) destroyUpstreamSide();
  });

  response.on("error", onClientAbortOrError);
  response.on("close", () => {
    // Client disconnected before the proxied response finished writing.
    if (!response.writableEnded) destroyUpstreamSide();
  });

  upstream.on("error", () => {
    if (response.writableEnded || response.destroyed) return;
    if (!response.headersSent) {
      writeProxyError(
        response,
        502,
        "upstream_error",
        "Upstream request failed through the Paperclip sandbox proxy.",
      );
    } else {
      response.destroy();
    }
  });

  return {
    bindUpstreamResponse: (incoming) => {
      upstreamResponse = incoming;
      incoming.on("error", () => {
        if (!response.writableEnded && !response.destroyed) response.destroy();
      });
    },
  };
}

function connectProxyError(code: string, message: string): string {
  const body = `${JSON.stringify({ error: { code, message } })}\n`;
  return [
    "HTTP/1.1 403 Forbidden",
    "Connection: close",
    "Content-Type: application/json; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "",
    body,
  ].join("\r\n");
}

/** Exported for regression tests of proxy pipe teardown (EPIPE / client disconnect). */
export async function startNetworkAllowlistProxy(
  allowlist: string[],
  trustedUrls: string[],
  socketPath: string,
): Promise<NetworkAllowlistProxy> {
  assertUnixSocketPathLength(socketPath);
  const rules = [
    ...allowlist.map(parseNetworkAllowlistEntry),
    ...trustedUrls.map(parseTrustedNetworkUrl).filter((rule): rule is NetworkAllowlistRule => rule !== null),
  ];
  if (rules.length === 0) {
    throw new Error(
      'networkScope="allowlist" requires at least one valid networkAllowlist hostname or HTTP(S) networkTrustedUrl.',
    );
  }
  const server = http.createServer((request, response) => {
    let target: URL;
    try {
      target = new URL(request.url ?? "");
    } catch {
      writeProxyError(response, 400, "invalid_request_url", "Paperclip sandbox proxy requires an absolute request URL.");
      return;
    }
    const port = target.port || (target.protocol === "https:" ? "443" : "80");
    if (target.protocol !== "http:") {
      writeProxyError(response, 400, "https_requires_connect", "HTTPS targets must use CONNECT through the Paperclip sandbox proxy.");
      return;
    }
    if (!isNetworkTargetAllowed(target.hostname, port, rules)) {
      writeProxyError(response, 403, "network_target_denied", "Network target denied by Paperclip sandbox policy.");
      return;
    }
    const upstream = http.request(target, {
      method: request.method,
      headers: { ...request.headers, host: target.host },
    });
    const lifecycle = bindHttpProxyLifecycle(request, response, upstream);
    upstream.on("response", (upstreamResponse) => {
      lifecycle.bindUpstreamResponse(upstreamResponse);
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    request.pipe(upstream);
  });
  server.on("connect", (request, clientSocket, head) => {
    const separator = request.url?.lastIndexOf(":") ?? -1;
    const hostname = separator > 0 ? request.url!.slice(0, separator).replace(/^\[|\]$/g, "") : "";
    const port = separator > 0 ? request.url!.slice(separator + 1) : "443";
    if (!hostname || !/^\d+$/.test(port) || !isNetworkTargetAllowed(hostname, port, rules)) {
      clientSocket.end(connectProxyError(
        "network_target_denied",
        "Network target denied by Paperclip sandbox policy.",
      ));
      return;
    }
    const upstream = net.connect(Number(port), hostname, () => {
      try {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      } catch {
        clientSocket.destroy();
        upstream.destroy();
      }
    });
    // Register before connect completes so a cancelled client cannot EPIPE the
    // "200 Connection Established" write into an uncaught Socket error.
    bindProxyPairTeardown(clientSocket, upstream);
  });
  const sockets = new Set<net.Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function createNetworkProxyBridge(): Promise<string> {
  const source = `
const net = require("node:net");
const { spawn } = require("node:child_process");
const socketPath = process.argv[2];
const executable = process.argv[3];
const args = process.argv.slice(4);
const server = net.createServer((client) => {
  const upstream = net.connect(socketPath);
  client.pipe(upstream);
  upstream.pipe(client);
  const close = () => { client.destroy(); upstream.destroy(); };
  client.on("error", close);
  upstream.on("error", close);
});
server.listen(${SANDBOX_PROXY_PORT}, "127.0.0.1", () => {
  const child = spawn(executable, args, { stdio: "inherit", env: process.env });
  const forward = (signal) => { if (!child.killed) child.kill(signal); };
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGINT", () => forward("SIGINT"));
  child.on("exit", (code, signal) => server.close(() => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code == null ? 1 : code);
  }));
});
`;
  return source.trimStart();
}

export async function buildLocalProcessSandboxSpawnTarget(input: {
  executable: string;
  args: string[];
  cwd: string;
  options: LocalProcessSandboxOptions;
}): Promise<LocalProcessSandboxSpawnTarget> {
  if (process.platform !== "linux") {
    throw new Error("Local process filesystem and network scopes are currently supported only on Linux.");
  }
  const filesystemScope = input.options.filesystemScope ?? null;
  const filesystemWorkspaceAccessRaw = input.options.filesystemWorkspaceAccess ?? "rw";
  if (filesystemWorkspaceAccessRaw !== "ro" && filesystemWorkspaceAccessRaw !== "rw") {
    throw new Error('filesystemWorkspaceAccess must be "ro" or "rw".');
  }
  const filesystemWorkspaceAccess: LocalProcessSandboxAccess = filesystemWorkspaceAccessRaw;
  const networkScope = input.options.networkScope ?? null;
  if (!filesystemScope && !networkScope) throw new Error("Local process sandbox requires a filesystem or network scope.");

  const workspaceDir = normalizeAbsolutePath(input.options.workspaceDir, "Sandbox workspaceDir");
  const cwd = normalizeAbsolutePath(input.cwd, "Sandbox cwd");
  if (filesystemScope === "workspace") {
    const relativeCwd = path.relative(workspaceDir, cwd);
    if (relativeCwd.startsWith("..") || path.isAbsolute(relativeCwd)) {
      throw new Error(`Sandbox cwd "${cwd}" must be inside workspaceDir "${workspaceDir}".`);
    }
    const outboundRestorePaths = (input.options.outboundRestorePaths ?? []).map((candidate, index) =>
      normalizeAbsolutePath(candidate, `Sandbox outboundRestorePaths[${index}]`));
    for (const [index, extraPath] of (input.options.extraPaths ?? []).entries()) {
      if (extraPath.access !== "rw") continue;
      const normalizedExtraPath = normalizeAbsolutePath(extraPath.path, `Sandbox extraPaths[${index}].path`);
      const relativeToWorkspace = path.relative(workspaceDir, normalizedExtraPath);
      const synchronized = !relativeToWorkspace.startsWith("..") && !path.isAbsolute(relativeToWorkspace);
      if (filesystemWorkspaceAccess === "ro" && synchronized) {
        throw new Error(
          `Writable sandbox path "${normalizedExtraPath}" is inside read-only workspace "${workspaceDir}".`,
        );
      }
      const restored = outboundRestorePaths.some((restorePath) => {
        const relative = path.relative(restorePath, normalizedExtraPath);
        return !relative.startsWith("..") && !path.isAbsolute(relative);
      });
      if (!synchronized && !restored) {
        throw new Error(
          `Writable sandbox path "${normalizedExtraPath}" is outside synchronized workspace "${workspaceDir}" and has no outbound restore mapping.`,
        );
      }
    }
  }

  const bwrapCommand = input.options.command?.trim() || "bwrap";
  const args = ["--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts"];
  const env: Record<string, string | undefined> = {};
  let cleanup: (() => Promise<void>) | undefined;
  let executable = input.executable;
  let executableArgs = input.args;

  if (filesystemScope === "workspace") {
    args.push("--tmpfs", "/", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
    const created = new Set<string>(["/", "/proc", "/dev", "/tmp"]);
    const represented = new Set<string>(["/", "/proc", "/dev", "/tmp"]);
    const mounted = new Set<string>();
    const hasMountedAncestor = (candidate: string): boolean => {
      let current = path.dirname(candidate);
      while (current !== path.dirname(current)) {
        if (mounted.has(current)) return true;
        current = path.dirname(current);
      }
      return false;
    };
    const addSymlink = (linkPath: string, target: string) => {
      const normalized = normalizeAbsolutePath(linkPath, "Sandbox path");
      // Skip when the path is already a sandbox directory/mount/symlink, or when
      // a mounted ancestor already covers it (prefix check — exact match is not
      // enough). Recreating a hop that mounts already turned into a directory
      // breaks bubblewrap startup; recreating inside a foreign bind only works
      // while the literal target happens to match the host.
      if (represented.has(normalized) || created.has(normalized) || hasMountedAncestor(normalized)) {
        return;
      }
      addParentDirectories(args, created, normalized);
      args.push("--symlink", target, normalized);
      represented.add(normalized);
      created.add(normalized);
    };
    const mount = async (source: string, access: LocalProcessSandboxAccess) => {
      const normalized = normalizeAbsolutePath(source, "Sandbox path");
      if (mounted.has(normalized) || represented.has(normalized) || !(await pathExists(normalized))) return;
      addParentDirectories(args, created, normalized);
      args.push(access === "rw" ? "--bind" : "--ro-bind", normalized, normalized);
      mounted.add(normalized);
      represented.add(normalized);
      created.add(normalized);
    };
    for (const [systemPath, fallbackTarget] of TOP_LEVEL_SYSTEM_PATH_FALLBACKS) {
      const normalized = normalizeAbsolutePath(systemPath, "Sandbox path");
      let stat: Awaited<ReturnType<typeof fs.lstat>> | null = null;
      try {
        stat = await fs.lstat(normalized);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (stat?.isSymbolicLink()) {
        const target = (await fs.readlink(normalized)).trim() || fallbackTarget;
        addSymlink(normalized, target);
        continue;
      }
      if (stat) {
        await mount(normalized, "ro");
        continue;
      }
      addSymlink(normalized, fallbackTarget);
    }
    for (const systemPath of SYSTEM_READ_PATHS) await mount(systemPath, "ro");
    await applyExecutableSandboxPlan(input.executable, mount, addSymlink);
    if (networkScope === "allowlist") {
      await applyExecutableSandboxPlan(process.execPath, mount, addSymlink);
    }
    for (const managedPath of input.options.managedPaths ?? []) await mount(managedPath.path, managedPath.access);
    for (const extraPath of input.options.extraPaths ?? []) await mount(extraPath.path, extraPath.access);
    await mount(workspaceDir, filesystemWorkspaceAccess);
    for (const [index, alias] of (input.options.pathAliases ?? []).entries()) {
      const aliasPath = normalizeAbsolutePath(alias.path, `Sandbox pathAliases[${index}].path`);
      const aliasTarget = normalizeAbsolutePath(alias.target, `Sandbox pathAliases[${index}].target`);
      const relativeTarget = path.relative(workspaceDir, aliasTarget);
      if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
        throw new Error(
          `Sandbox path alias "${aliasPath}" must target the synchronized workspace "${workspaceDir}".`,
        );
      }
      if (!(await pathExists(aliasTarget))) {
        throw new Error(`Sandbox path alias target "${aliasTarget}" does not exist.`);
      }
      addParentDirectories(args, created, aliasPath);
      args.push(filesystemWorkspaceAccess === "ro" ? "--ro-bind" : "--bind", aliasTarget, aliasPath);
      created.add(aliasPath);
    }

    if (networkScope === "allowlist") {
      const tempDir = await createNetworkProxyTempDir();
      const socketPath = path.join(tempDir, "proxy.sock");
      const bridgePath = path.join(tempDir, "bridge.cjs");
      await fs.writeFile(bridgePath, await createNetworkProxyBridge(), { mode: 0o500 });
      const proxy = await startNetworkAllowlistProxy(
        input.options.networkAllowlist ?? [],
        input.options.networkTrustedUrls ?? [],
        socketPath,
      ).catch(async (error) => {
        await fs.rm(tempDir, { recursive: true, force: true });
        throw error;
      });
      await mount(tempDir, "rw");
      executable = process.execPath;
      executableArgs = [bridgePath, socketPath, input.executable, ...input.args];
      cleanup = async () => {
        await proxy.close();
        await fs.rm(tempDir, { recursive: true, force: true });
      };
    }
  } else {
    args.push("--bind", "/", "/");
    if (networkScope === "allowlist") {
      const tempDir = await createNetworkProxyTempDir();
      const socketPath = path.join(tempDir, "proxy.sock");
      const bridgePath = path.join(tempDir, "bridge.cjs");
      await fs.writeFile(bridgePath, await createNetworkProxyBridge(), { mode: 0o500 });
      const proxy = await startNetworkAllowlistProxy(
        input.options.networkAllowlist ?? [],
        input.options.networkTrustedUrls ?? [],
        socketPath,
      ).catch(async (error) => {
        await fs.rm(tempDir, { recursive: true, force: true });
        throw error;
      });
      executable = process.execPath;
      executableArgs = [bridgePath, socketPath, input.executable, ...input.args];
      cleanup = async () => {
        await proxy.close();
        await fs.rm(tempDir, { recursive: true, force: true });
      };
    }
  }

  if (networkScope) {
    args.push("--unshare-net");
    for (const key of PROXY_ENV_KEYS) env[key] = undefined;
    env.NO_PROXY = "";
    env.no_proxy = "";
  }
  if (networkScope === "allowlist") {
    const proxyUrl = `http://127.0.0.1:${SANDBOX_PROXY_PORT}`;
    env.NODE_USE_ENV_PROXY = "1";
    env.HTTP_PROXY = proxyUrl;
    env.HTTPS_PROXY = proxyUrl;
    env.http_proxy = proxyUrl;
    env.https_proxy = proxyUrl;
  }

  args.push("--chdir", cwd, "--", executable, ...executableArgs);
  return { command: bwrapCommand, args, cwd: "/", env, cleanup };
}

export function parseLocalProcessSandboxExtraPaths(value: unknown): LocalProcessSandboxPath[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    if (typeof entry === "string") {
      return { path: normalizeAbsolutePath(entry, `filesystemExtraPaths[${index}]`), access: "ro" };
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`filesystemExtraPaths[${index}] must be an absolute path or { path, access } object.`);
    }
    const raw = entry as Record<string, unknown>;
    const access = raw.access === "rw" ? "rw" : raw.access === "ro" || raw.access == null ? "ro" : null;
    if (!access || typeof raw.path !== "string") {
      throw new Error(`filesystemExtraPaths[${index}] must use access "ro" or "rw" and an absolute path.`);
    }
    return { path: normalizeAbsolutePath(raw.path, `filesystemExtraPaths[${index}].path`), access };
  });
}
