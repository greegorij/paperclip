import type { CompanyBudgetPacingSnapshot, ProviderBudgetPacing } from "@paperclipai/shared";
import { Gauge } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatTokens, providerDisplayName } from "@/lib/utils";

function modeLabel(mode: ProviderBudgetPacing["mode"]): string {
  switch (mode) {
    case "accelerate":
      return "Accelerate";
    case "normal":
      return "Normal";
    case "throttle":
      return "Throttle";
    case "stop":
      return "Stop";
    case "unknown":
      return "Unknown";
  }
}

function modeToneClass(mode: ProviderBudgetPacing["mode"]): string {
  switch (mode) {
    case "stop":
      return "text-(--status-task-blocked)";
    case "throttle":
      return "text-(--status-task-todo)";
    case "accelerate":
      return "text-(--status-task-done)";
    case "unknown":
      return "text-muted-foreground";
    default:
      return "text-foreground";
  }
}

function formatReset(resetAt: string | null): string {
  if (!resetAt) return "reset unknown";
  const ms = Date.parse(resetAt);
  if (!Number.isFinite(ms)) return "reset unknown";
  return `resets ${new Date(ms).toLocaleString()}`;
}

function ProviderRow({ row }: { row: ProviderBudgetPacing }) {
  return (
    <div className="rounded-md border border-border px-3 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="font-medium">{providerDisplayName(row.provider)}</div>
        <div className={`text-sm font-semibold tabular-nums ${modeToneClass(row.mode)}`}>
          {modeLabel(row.mode)}
          {row.usedPercent != null ? ` · ${row.usedPercent}%` : ""}
        </div>
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        {formatReset(row.resetAt)}
        {" · "}
        {formatTokens(Math.round(row.burnRatePerHour))}/h
        {" · "}
        {formatTokens(row.recentTokens)} last 24h
      </div>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">{row.reason}</p>
      {row.mode === "unknown" || row.warning ? (
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          {row.warning ?? "Incomplete quota data — no automatic stop."}
        </p>
      ) : null}
      {row.mode === "throttle" || row.mode === "accelerate" ? (
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          Recommendation only — concurrency is not auto-changed in this release.
        </p>
      ) : null}
    </div>
  );
}

export function ProviderBudgetPacingCard({
  snapshot,
  isLoading,
  error,
}: {
  snapshot?: CompanyBudgetPacingSnapshot | null;
  isLoading?: boolean;
  error?: string | null;
}) {
  return (
    <Card>
      <CardHeader className="gap-2">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Tempo względem limitów dostawców</CardTitle>
            <CardDescription className="mt-1">
              Read-only pacing from subscription quota windows and recent token burn. Unknown/error never auto-stops
              agents.
            </CardDescription>
          </div>
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border">
            <Gauge className="h-4 w-4 text-muted-foreground" />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading provider pacing…</p>
        ) : error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : !snapshot || snapshot.providers.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No provider pacing data yet. Quota adapters and recent cost events will populate this card.
          </p>
        ) : (
          <>
            <div className="space-y-2">
              {snapshot.providers.map((row) => (
                <ProviderRow key={row.provider} row={row} />
              ))}
            </div>
            <p className="text-(length:--text-micro) text-muted-foreground">
              Fetched {new Date(snapshot.fetchedAt).toLocaleString()} · source {snapshot.source}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
