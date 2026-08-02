---
title: Costs
summary: Cost events, summaries, and budget management
---

Track token usage and spending across agents, projects, and the company.

## Report Cost Event

```
POST /api/companies/{companyId}/cost-events
{
  "agentId": "{agentId}",
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "inputTokens": 15000,
  "outputTokens": 3000,
  "costCents": 12
}
```

Typically reported automatically by adapters after each heartbeat.

## Company Cost Summary

```
GET /api/companies/{companyId}/costs/summary
```

Returns total spend, budget, and utilization for the current month.

## Costs by Agent

```
GET /api/companies/{companyId}/costs/by-agent
```

Returns per-agent cost breakdown for the current month.

## Costs by Project

```
GET /api/companies/{companyId}/costs/by-project
```

Returns per-project cost breakdown for the current month.

## Budget Management

### Set Company Budget

```
PATCH /api/companies/{companyId}
{ "budgetMonthlyCents": 100000 }
```

### Set Agent Budget

```
PATCH /api/agents/{agentId}
{ "budgetMonthlyCents": 5000 }
```

## Provider Budget Pacing

```
GET /api/companies/{companyId}/costs/budget-pacing
```

Board/company read (same authz as `quota-windows`). Read-only.

Returns a snapshot with `fetchedAt`, non-secret `source`, and per-provider pacing:

| Field | Meaning |
|-------|---------|
| `mode` | `accelerate` \| `normal` \| `throttle` \| `stop` \| `unknown` |
| `usedPercent` | Most constraining quota window usage, or null |
| `resetAt` | Provider-reported reset time, or null (never invented) |
| `recentTokens` | `input_tokens + output_tokens` over the last 24h (excludes cached input) |
| `burnRatePerHour` | `recentTokens / 24` |
| `projectedExhaustionAt` | Optional projection from window progress |
| `reason` / `confidence` / `warning` | Human-readable decision context |

Modes:

- **stop** — window is exhausted and `resetAt` is in the future. Invocation is blocked only for agents whose adapter maps to that provider.
- **throttle** / **accelerate** — recommendations only in this release (no auto concurrency changes, no fleet wake/pause).
- **unknown** — missing/error quota data. Work continues; UI shows that there is no automatic stop.

Responses are cached briefly (~30s) so UI/heartbeats do not re-poll provider quota APIs on every request. That short cache also deduplicates concurrent requests for one company into a single in-flight provider quota probe; a force refresh bypasses a settled cache entry but still joins an already-running probe. Failed probes are not cached. Missing or error telemetry remains `unknown` (fail-open — work continues).

## Budget Enforcement

| Threshold | Effect |
|-----------|--------|
| 80% | Soft alert — agent should focus on critical tasks |
| 100% | Hard stop — agent is auto-paused |

Budget policies may use metric `billed_cents` (money) or `total_tokens` (input + output; cached input excluded). Money budget windows reset on the first of each month (UTC).
