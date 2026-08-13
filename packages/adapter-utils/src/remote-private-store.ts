import path from "node:path";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Builds a fail-closed shell fragment for a private persistent adapter store.
 * Only descendants of `<remoteCwd>/.paperclip-runtime/<adapter>/session-stores`
 * are accepted. Every managed component is checked before creation and then
 * chmodded 0700. This bounds the remaining shell TOCTOU window to a root whose
 * write permissions Paperclip controls; eliminating it fully requires openat(2).
 */
export function buildRemotePrivateStoreProvision(input: {
  remoteCwd: string;
  adapterKey: string;
  storeDir: string;
}): string {
  if (
    !path.posix.isAbsolute(input.remoteCwd) ||
    input.remoteCwd.includes("\0") ||
    input.remoteCwd.split("/").includes("..")
  ) throw new Error("Remote private store requires an absolute cwd without traversal");
  const remoteCwd = path.posix.normalize(input.remoteCwd);
  if (remoteCwd === "/") throw new Error("Remote private store cannot use the filesystem root");
  const storeRoot = path.posix.join(remoteCwd, ".paperclip-runtime", input.adapterKey, "session-stores");
  const storeDir = path.posix.normalize(input.storeDir);
  const relative = path.posix.relative(storeRoot, storeDir);
  if (
    !path.posix.isAbsolute(remoteCwd) ||
    !/^[A-Za-z0-9_-]+$/.test(input.adapterKey) ||
    relative === "" ||
    relative === ".." ||
    relative.startsWith("../") ||
    path.posix.isAbsolute(relative)
  ) {
    throw new Error("Remote private store must be a descendant of its anchored session-store root");
  }
  const components = [
    path.posix.join(remoteCwd, ".paperclip-runtime"),
    path.posix.join(remoteCwd, ".paperclip-runtime", input.adapterKey),
    storeRoot,
  ];
  let current = storeRoot;
  for (const segment of relative.split("/")) {
    if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new Error("Remote private store has an unsafe path segment");
    current = path.posix.join(current, segment);
    components.push(current);
  }
  return components.map((component) =>
    `if [ -L ${shellQuote(component)} ] || { [ -e ${shellQuote(component)} ] && [ ! -d ${shellQuote(component)} ]; }; then ` +
      `echo ${shellQuote(`Refusing unsafe private store component: ${component}`)} >&2; exit 73; fi; ` +
      `mkdir ${shellQuote(component)} 2>/dev/null || [ -d ${shellQuote(component)} ]; ` +
      `chmod 700 ${shellQuote(component)}`,
  ).join(" && ");
}
