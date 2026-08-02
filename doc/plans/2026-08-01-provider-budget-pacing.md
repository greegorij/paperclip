# Provider budget pacing (2026-08-01)

## Problem

Quota windows already surface Anthropic/OpenAI subscription usage, but company/agent budget hard-stops still default to `billed_cents`. On subscription plans marginal billed cents are often `0`, so the money brake never fires while the subscription window can still be exhausted. Operators need a reversible first cut that:

1. understands token burn without counting cache reads as subscription spend, and
2. turns live provider windows into a pacing recommendation (`accelerate` / `normal` / `throttle` / `stop` / `unknown`) with a **narrow** automatic stop only when the provider window is clearly exhausted.

This branch already records cost events for failed/cancelled heartbeats; that accounting must stay intact.

## Scope of this iteration

- Add budget metric `total_tokens` = `input_tokens + output_tokens` (exclude `cached_input_tokens`).
- Pure pacing module over quota windows + recent burn.
- Deterministic `admissionRate` in `[0, 1]` from percentage burn versus a 95% safe target; raw token burn remains telemetry only.
- Read-only company endpoint `GET /api/companies/:companyId/costs/budget-pacing` (same authz as quota-windows).
- Short in-process cache (~30s) so heartbeats/UI do not hammer provider quota APIs.
- Provider-wide queued-run admission cap: sum of agent hard concurrency limits, scaled by `admissionRate`, with a company/provider start lock.
- `getInvocationBlock` blocks **only** when pacing mode is `stop`, the agent adapter maps to that provider, and `resetAt` is in the future.
- Small Costs UI card for pacing visibility.
- Docs + targeted tests. No new daemon/process.

## Safety constraints

- No automatic stop from missing/unknown/error quota data.
- Do not invent `resetAt`; keep `null` when the provider did not report it.
- `throttle` / `stop` do not pause agents; queued work waits for a later fresh snapshot/reset. Local budget policies remain independent.
- Persisted queued work is reconsidered by the existing scheduler about every 30 seconds, so a fresh post-reset snapshot reopens admission without mass-resuming agents.
- Cache payloads must not include credentials or secret material.
- Prefer no DB migration; `budget_policies.metric` is free text.

## Tests

- Pure pacing modes + no-data → `unknown`.
- Admission rate: early/normal, smooth throttle, stop, missing reset fail-open, and raw-token independence.
- Provider cap: hard ceiling, provider isolation, two-agent start race, and throttle/stop resume behavior.
- Endpoint/cache behavior (read-only, TTL reuse).
- `getInvocationBlock`: stop blocks matching provider; `unknown` / `throttle` do not.
- `total_tokens` observed amount ignores cached input and enforces hard-stop.

## Explicitly out of scope

- Full model router / provider failover.
- New migrations or schema redesign.
- Replacing money budgets; `billed_cents` remains first-class.
