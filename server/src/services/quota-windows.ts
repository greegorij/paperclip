import type { ProviderQuotaResult } from "@paperclipai/shared";
import { listServerAdapters } from "../adapters/registry.js";

const QUOTA_PROVIDER_TIMEOUT_MS = 20_000;

/**
 * Fail-open switch: when truthy (`1` / `true` / `yes` / `on`), {@link fetchAllQuotaWindows}
 * skips every adapter quota probe and returns an empty list.
 *
 * Callers that derive provider availability from this (heartbeat gates, costs UI)
 * treat missing telemetry as `unknown`, never `blocked`. Production leaves this unset
 * so probes still run. Server Vitest harness sets it to avoid spawning real CLI probes.
 */
export const PAPERCLIP_DISABLE_EXTERNAL_QUOTA_PROBES = "PAPERCLIP_DISABLE_EXTERNAL_QUOTA_PROBES";

function isTruthyEnvFlag(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function areExternalQuotaProbesDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyEnvFlag(env[PAPERCLIP_DISABLE_EXTERNAL_QUOTA_PROBES]);
}

export function providerSlugForAdapterType(type: string): string {
  switch (type) {
    case "claude_local":
    case "claude_remote":
      return "anthropic";
    case "codex_local":
    case "codex_remote":
      return "openai";
    default:
      return type;
  }
}

/**
 * Asks each registered adapter for its provider quota windows and aggregates the results.
 * Adapters that don't implement getQuotaWindows() are silently skipped.
 * Individual adapter failures are caught and returned as error results rather than
 * letting one provider's outage block the entire response.
 *
 * When {@link PAPERCLIP_DISABLE_EXTERNAL_QUOTA_PROBES} is set, returns `[]` immediately
 * (fail-open: no probes, no fabricated blocked state).
 */
export async function fetchAllQuotaWindows(): Promise<ProviderQuotaResult[]> {
  if (areExternalQuotaProbesDisabled()) {
    return [];
  }

  const adapters = listServerAdapters().filter((a) => a.getQuotaWindows != null);

  const settled = await Promise.allSettled(
    adapters.map((adapter) => withQuotaTimeout(adapter.type, adapter.getQuotaWindows!())),
  );

  return settled.map((result, i) => {
    if (result.status === "fulfilled") return result.value;
    const adapterType = adapters[i]!.type;
    return {
      provider: providerSlugForAdapterType(adapterType),
      ok: false,
      error: String(result.reason),
      windows: [],
    };
  });
}

async function withQuotaTimeout(
  adapterType: string,
  task: Promise<ProviderQuotaResult>,
): Promise<ProviderQuotaResult> {
  let timeoutId: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      task,
      new Promise<ProviderQuotaResult>((resolve) => {
        timeoutId = setTimeout(() => {
          resolve({
            provider: providerSlugForAdapterType(adapterType),
            ok: false,
            error: `quota polling timed out after ${Math.round(QUOTA_PROVIDER_TIMEOUT_MS / 1000)}s`,
            windows: [],
          });
        }, QUOTA_PROVIDER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
