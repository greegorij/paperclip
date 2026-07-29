#!/usr/bin/env node
/**
 * Jarvis fleet configuration tool.
 *
 * Commands: snapshot | validate | diff | apply | verify
 * Default apply mode is dry-run (offline). Mutations require --apply + backup file+sha.
 *
 * Never prints API keys / tokens. Does not create or restore databases.
 */
import { pathToFileURL } from "node:url";
import path from "node:path";
import { PACKAGE_DIR, DESIRED_DIR } from "../lib/paths.mjs";
import { validateFleet } from "../lib/validate.mjs";
import { diffFleet, loadSnapshotFile } from "../lib/diff.mjs";
import { applyFleet } from "../lib/apply.mjs";
import { verifyFleet } from "../lib/verify.mjs";
import { snapshotFleet } from "../lib/snapshot.mjs";
import { readFileSync } from "node:fs";

function usage() {
  return `Usage: fleet-config <command> [options]

Commands:
  snapshot   Capture live (or fixture) state to JSON
  validate   Validate package + desired overlays (+ optional snapshot)
  diff       Show planned changes vs snapshot (always non-mutating)
  apply      Dry-run by default (offline); --apply performs API mutations after backup gate
  verify     Validate + require empty mutable diff against snapshot

Common options:
  --package <dir>     Portable package root (default: ops/fleet/jarvis/package)
  --desired <dir>     Desired overlays (default: ops/fleet/jarvis/desired)
  --snapshot <file>   Live snapshot JSON
  --fixture <file>    Fixture JSON (snapshot command / tests)
  --company-id <id>   Company id for live snapshot
  --api-url <url>     Override PAPERCLIP_API_URL
  --out <file>        Snapshot output path

Apply options:
  --apply                          Actually mutate (default: dry-run)
  --backup-file <path>             Existing local DB backup file (required with --apply)
  --backup-sha256 <hex>            SHA-256 of backup file (required with --apply)

Safety:
  - No secrets logged
  - No DB create/restore
  - Dry-run never contacts the API
  - Built-in Summarizer/Reflection Coach files are never imported from package
`;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) args[key] = true;
      else {
        args[key] = next;
        i++;
      }
    } else args._.push(a);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command || args.help || args.h) {
    console.log(usage());
    process.exit(command ? 0 : 1);
  }

  if (args["i-confirm-db-backup"] != null) {
    console.error(
      "Rejected: --i-confirm-db-backup is no longer accepted. Use --backup-file and --backup-sha256.",
    );
    process.exit(1);
  }

  const packageDir = args.package ? path.resolve(args.package) : PACKAGE_DIR;
  const desiredDir = args.desired ? path.resolve(args.desired) : DESIRED_DIR;

  if (args["api-url"]) process.env.PAPERCLIP_API_URL = args["api-url"];

  if (command === "snapshot") {
    let fixture = null;
    if (args.fixture) fixture = JSON.parse(readFileSync(args.fixture, "utf8"));
    const snap = await snapshotFleet({
      companyId: args["company-id"],
      outPath: args.out ? path.resolve(args.out) : null,
      fixture,
    });
    console.log(
      JSON.stringify(
        {
          agents: snap.agents.length,
          routines: snap.routines.length,
          builtIns: snap.builtIns.length,
          skillLibrary: snap.skillLibrary?.length ?? null,
          completeness: snap.completeness ?? null,
          warnings: snap.warnings ?? [],
          out: args.out ?? null,
        },
        null,
        2,
      ),
    );
    return;
  }

  const snapshotPath = args.snapshot ? path.resolve(args.snapshot) : null;
  const liveSnapshot = snapshotPath ? loadSnapshotFile(snapshotPath) : null;

  if (command === "validate") {
    let includeBuiltInInstructions = null;
    if (args["built-in-instructions"]) {
      includeBuiltInInstructions = JSON.parse(
        readFileSync(args["built-in-instructions"], "utf8"),
      );
    }
    const result = validateFleet({
      packageDir,
      desiredDir,
      liveSnapshot,
      includeBuiltInInstructions,
    });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 2);
  }

  if (command === "diff") {
    if (!liveSnapshot) {
      console.error("--snapshot required for diff");
      process.exit(1);
    }
    const result = diffFleet({ packageDir, desiredDir, liveSnapshot });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.blocking > 0 ? 2 : 0);
  }

  if (command === "apply") {
    if (!liveSnapshot) {
      console.error("--snapshot required for apply");
      process.exit(1);
    }
    const doApply = args.apply === true;
    const report = await applyFleet({
      packageDir,
      desiredDir,
      liveSnapshot,
      apply: doApply,
      backupGate: {
        backupFile: args["backup-file"] ?? null,
        backupSha256: args["backup-sha256"] ?? null,
      },
    });
    console.log(JSON.stringify(report, null, 2));
    if (report.partial) process.exit(3);
    process.exit(report.ok ? 0 : 2);
  }

  if (command === "verify") {
    if (!liveSnapshot) {
      console.error("--snapshot required for verify");
      process.exit(1);
    }
    let includeBuiltInInstructions = null;
    if (args["built-in-instructions"]) {
      includeBuiltInInstructions = JSON.parse(
        readFileSync(args["built-in-instructions"], "utf8"),
      );
    }
    const result = verifyFleet({
      packageDir,
      desiredDir,
      liveSnapshot,
      includeBuiltInInstructions,
    });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 2);
  }

  console.error(`Unknown command: ${command}\n`);
  console.log(usage());
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

export { main };
