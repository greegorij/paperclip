#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import {
  generateCodexJarvisInstructions,
} from "../lib/codex-jarvis-instructions.mjs";
import { resolveFleetPath } from "../lib/paths.mjs";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = value;
      i += 1;
    }
  }
  return args;
}

function writeFileAtomically(targetPath, content) {
  const dir = path.dirname(targetPath);
  const tempPath = path.join(
    dir,
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  let fd;
  try {
    fd = openSync(tempPath, "wx", 0o600);
    writeSync(fd, content, undefined, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, targetPath);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // cleanup best effort
      }
    }
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // cleanup best effort
    }
    throw error;
  }
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const headlessFile = path.resolve(
    String(args["headless-file"] ?? "/tmp/jarvis-paperclip-boss-CLAUDE.md"),
  );
  const cockpitFile = path.resolve(
    String(args["cockpit-file"] ?? resolveFleetPath("package", "agents", "jarvis", "AGENTS.md")),
  );
  const outFile = path.resolve(
    String(args.out ?? resolveFleetPath("package", "agents", "jarvis", "AGENTS-CODEX.md")),
  );

  const source = readFileSync(headlessFile, "utf8");
  const cockpit = readFileSync(cockpitFile, "utf8");
  const generated = generateCodexJarvisInstructions({
    headlessBossClaude: source,
    cockpitAgentsMd: cockpit,
  });
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileAtomically(outFile, generated.content);

  process.stdout.write(
    `${JSON.stringify(
      {
        out: path.basename(outFile),
        sourceSha256: generated.sourceSha256,
        cockpitSha256: generated.cockpitSha256,
      },
      null,
      2,
    )}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}