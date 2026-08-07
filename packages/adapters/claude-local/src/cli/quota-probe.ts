#!/usr/bin/env node

import {
  fetchClaudeQuota,
  getQuotaWindows,
  readClaudeAuthStatus,
  readClaudeToken,
} from "../server/quota.js";

interface ProbeArgs {
  json: boolean;
  oauthOnly: boolean;
}

function parseArgs(argv: string[]): ProbeArgs {
  if (argv.includes("--raw-cli") || argv.includes("--cli-only")) {
    throw new Error(
      "Claude CLI usage probe was removed: `claude usage` is not a real subcommand and billed interactive sessions on every call. Use OAuth usage polling only.",
    );
  }
  return {
    json: argv.includes("--json"),
    oauthOnly: argv.includes("--oauth-only"),
  };
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const authStatus = await readClaudeAuthStatus();
  const token = await readClaudeToken();

  const result: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    authStatus,
    tokenAvailable: token != null,
  };

  if (!token) {
    result.oauth = {
      ok: false,
      error: "No Claude OAuth access token found in local credentials files.",
      windows: [],
    };
  } else {
    try {
      result.oauth = {
        ok: true,
        windows: await fetchClaudeQuota(token),
      };
    } catch (error) {
      result.oauth = {
        ok: false,
        error: stringifyError(error),
        windows: [],
      };
    }
  }

  if (!args.oauthOnly) {
    try {
      result.aggregated = await getQuotaWindows();
    } catch (error) {
      result.aggregated = {
        ok: false,
        error: stringifyError(error),
      };
    }
  }

  const oauthOk = (result.oauth as { ok?: boolean } | undefined)?.ok === true;
  const aggregatedOk = (result.aggregated as { ok?: boolean } | undefined)?.ok === true;
  const ok = oauthOk || aggregatedOk;

  if (args.json || process.stdout.isTTY === false) {
    console.log(JSON.stringify({ ok, ...result }, null, 2));
  } else {
    console.log(`timestamp: ${result.timestamp}`);
    console.log(`auth: ${JSON.stringify(authStatus)}`);
    console.log(`tokenAvailable: ${token != null}`);
    if (result.oauth) console.log(`oauth: ${JSON.stringify(result.oauth, null, 2)}`);
    if (result.aggregated) console.log(`aggregated: ${JSON.stringify(result.aggregated, null, 2)}`);
  }

  if (!ok) process.exitCode = 1;
}

await main();
