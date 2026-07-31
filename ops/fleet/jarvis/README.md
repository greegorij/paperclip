# Jarvis fleet configuration (`ops/fleet/jarvis`)

Versioned, secret-free management of the 29-agent Jarvis company on the private Paperclip fork.

| Layer | Count | Notes |
|-------|------:|-------|
| Portable package agents | 27 | Company package under `package/` (agents + sidecar only) |
| Managed built-ins | 2 | Summarizer, Reflection Coach — never imported into `package/` |
| Live total | 29 | `27 + 2` |
| Routines (status/trigger only) | 5 | Matched by **id + title + triggerId** before any mutation |

## Layout

```text
ops/fleet/jarvis/
├── README.md
├── VERSION
├── package/                  # portable agents + COMPANY.md + .paperclip.yaml
├── desired/                  # JSON-only SSOT (no YAML mirrors)
├── bin/fleet-config.mjs      # snapshot | validate | diff | apply | verify
├── bin/bootstrap-from-export.mjs
├── lib/
└── tests/
```

## Safety

- **Dry-run by default and fully offline.** `apply` without `--apply` never creates an API client and does not need `PAPERCLIP_API_URL` / `PAPERCLIP_API_KEY`.
- Mutations require `--apply` **and** a backup gate: existing `--backup-file PATH` **plus** matching `--backup-sha256 HEX` only. Soft confirm flags are **not** accepted.
- The tool **never** creates or restores a database.
- No API keys, tokens, env values, host paths (`~/`, `/home/`, `/Users/`), or DB dumps in this tree — use placeholders such as `<operator-skill-root>` and `<repo-clone-root>` in docs and package text.
- Export warnings are stored as **anonymized counts/categories** only.
- `package/skills/**` is **not** vendored — apply resolves full skill **keys** against the live `skillLibrary` only (short names refused; no live-desiredSkills fallback). A unique full library key is accepted even when another key shares the same short-name suffix. Full skill rollback is the DB backup, not this manifest.
- Summarizer / Reflection Coach files are **not** in the portable package; their `skillKeys` live in `desired/built-ins.json`.
- Agent status is mutated only when `manageStatus: true` (managed roles stay paused). Apply never mass-resumes agents.
- Do not treat `GET /agents/:id/skills` `entries.length ≈ 39` as assignment.
- Snapshot/validate are **fail-closed**: hard invariant **29 = 27 portable + exactly 2 built-in keys** (`summarizer`, `reflection-coach`); `completeness` object required with `complete: true` and counters matching agent/skill arrays; empty AGENTS.md rejected; missing `skillLibrary` aborts. Live snapshot first checks the 29-agent list, then fetches each full `GET /api/agents/:id` record (aborts on any detail HTTP failure) before reading instructions/skills. Built-ins are derived from `metadata.paperclipBuiltInAgent.key` (the `/built-in-agents` endpoint may 404 when disabled and must not wipe data).
- **Diff/verify compare full `skillKeys` vs live `desiredSkills` for all 27 portable agents** (not a four-role override subset). Built-in model/skills drift is included in verify — not ignored.
- Portable `package/agents/*/AGENTS.md` is export/import-only metadata. Diff/apply never reconcile full live instructions for existing portable agents.
- All live instruction mutations (portable and built-in, including Summarizer) are outside automated reconciliation.
- Apply runs full structural validate + skill-key preflight **before** the first mutation; fail-fast after the first write/verify error. `partial=true` if any write succeeded, including write-ok/verify-fail when `completed` is still empty.
- Three managed OpenAI runtime policies are fail-closed: `recenzent`, `zwiadowca-kodu`, `mi-sie-kodu-codex`. They stay `paused` by policy and require exact runtime shape in `expectedRuntimePolicy` (status/type/model, `maxConcurrentRuns`, effort, workspace RO/RW, bypass=false, exact `extraArgs`, allowlist domains, heartbeat/wake/maxDailyRuns). Outer Bubblewrap policy remains restrictive (`filesystemScope=workspace`, allowlist networking), while inner Codex still runs with `--sandbox danger-full-access` as required by Paperclip tooling.
- `Recenzent` and `zwiadowca-kodu` use the OpenAI safe allowlist (`chatgpt.com`, `api.openai.com`, `auth.openai.com`). `mi-sie-kodu-codex` extends it minimally for GitHub git-over-HTTPS operations (`github.com`, `api.github.com`, `objects.githubusercontent.com`, `raw.githubusercontent.com`).
- `mi-sie-kodu-cursor` remains the default code executor; Codex managed roles are paused fallback lanes, not the primary coding path.
- Snapshot normalization maps `runtimeConfig.heartbeat.maxConcurrentRuns` to top-level `maxConcurrentRuns` (fallback to existing top-level value for fixture compatibility; `0` stays `0`). Validate hard-fails on runtime-policy drift and apply stops before API traffic; diff/apply never auto-switch adapters and never auto-write managed runtime-policy fields.
- Validator raises contradiction errors for forbidden instruction-state drift, and apply is fail-closed on any instruction change kind before creating API traffic or mutating live state.
- Every successful write is followed by a confirming GET (model, desired skill keys, routine id+title+triggerId+value). Dry-run skips write-verify GETs.

## Why no `package/skills/`

Local/company playbooks already live under the operator skill roots (`<operator-skill-root>`, company library). Vendoring them here created a second source of truth. The portable package keeps skill **keys** in agent frontmatter and `desired/agents.json` (full keys for every portable agent); built-in keys are in `desired/built-ins.json`. Snapshot/validate require each desired key to exist in the live library.

## Export → package

```sh
node ops/fleet/jarvis/bin/bootstrap-from-export.mjs /path/to/export.json
```

Bootstrap sanitizes host defaults, skips all `skills/**`, anonymizes warnings, applies surgical instruction/skill/model fixes, and refreshes `desired/agents.json`.

## Dry-run / apply (orchestrator)

```sh
node ops/fleet/jarvis/bin/fleet-config.mjs snapshot --company-id "$COMPANY_ID" --out /tmp/jarvis-fleet-snapshot.json
node ops/fleet/jarvis/bin/fleet-config.mjs validate --snapshot /tmp/jarvis-fleet-snapshot.json
node ops/fleet/jarvis/bin/fleet-config.mjs diff --snapshot /tmp/jarvis-fleet-snapshot.json
# offline dry-run (no API env needed):
node ops/fleet/jarvis/bin/fleet-config.mjs apply --snapshot /tmp/jarvis-fleet-snapshot.json
# after review + verified local DB backup file:
node ops/fleet/jarvis/bin/fleet-config.mjs apply --apply --snapshot /tmp/jarvis-fleet-snapshot.json \
  --backup-file /path/to/verified-db-backup --backup-sha256 "<sha256>"
node ops/fleet/jarvis/bin/fleet-config.mjs verify --snapshot /tmp/jarvis-fleet-post.json
```

## Provider profile switch (safe preview/apply/rollback)

Switches only the 22 Anthropic-backed Jarvis roles (`20 portable claude_local + summarizer + reflection-coach`) between named profiles:

- `openai-first`
- `anthropic-first`

Profile-specific prerequisites:

- `anthropic-first` requires existing directories from `JARVIS_CLAUDE_WORKER_CONFIG_DIR` and `JARVIS_CLAUDE_BOSS_CONFIG_DIR` (absolute, non-empty, inspectable as directories).
- `openai-first` requires a current boss-instructions source file from `JARVIS_CLAUDE_BOSS_INSTRUCTIONS_FILE` and exact parity between committed `AGENTS-CODEX.md` and the generated artifact.

Safety gates for profile apply/rollback:

- explicit profile confirmation (`--confirm-profile`)
- verified DB backup gate (`--backup-file` + `--backup-sha256`)
- complete fresh live snapshot capture
- zero active runs (`/api/companies/:companyId/live-runs`)
- all affected agents already paused
- pre-change JSON backup of affected runtime state before first mutation (written atomically as a private `0600` rollback file)
- PATCH+GET verification per agent
- automatic reverse rollback on first failure

Rollback backup/report handling:

- rollback backup stores the exact private pre-change state needed for restore, including `secret_ref` fields inside adapter/runtime payloads.
- for `openai-first`, that backup also contains the exact previous private Jarvis instruction file plus its digest; automatic and explicit rollback restore and verify it before treating Jarvis as restored.
- rollback always leaves every affected agent paused, even when the saved pre-change status was different.
- older profile-backup files that do not contain the required Jarvis instruction copy are refused for an `openai-first` rollback; use the verified database backup for recovery instead.
- operator preview/apply reports and standard snapshots are secret-redacted; `secret_ref` values never appear there.

Profile switching uses `replaceAdapterConfig: true`, preserves only managed instruction-bundle fields and `paperclipSkillSync`, and never mutates instructions or skill assignments.

```sh
# Preview only (offline, non-mutating)
node ops/fleet/jarvis/bin/fleet-config.mjs profile-switch \
  --profile openai-first \
  --snapshot /tmp/jarvis-fleet-snapshot.json

# Apply with strict gates
node ops/fleet/jarvis/bin/fleet-config.mjs profile-switch \
  --apply \
  --profile openai-first \
  --confirm-profile openai-first \
  --company-id "$COMPANY_ID" \
  --backup-file /path/to/verified-db-backup \
  --backup-sha256 "<sha256>" \
  --state-backup-file /tmp/jarvis-profile-prechange.json

# Explicit rollback from profile backup file
node ops/fleet/jarvis/bin/fleet-config.mjs profile-switch \
  --rollback \
  --profile openai-first \
  --company-id "$COMPANY_ID" \
  --rollback-file /tmp/jarvis-profile-prechange.json \
  --backup-file /path/to/verified-db-backup \
  --backup-sha256 "<sha256>"
```

Profile switch **does not activate the fleet**: all affected agents remain `paused` and no resume calls are issued.

Routine IDs and schedule trigger IDs are already filled in `desired/routines.json` from the live audit. Apply refuses if live id/title/triggerId do not all match — **no name-only fallback**.

## APIs used

| Change | API |
|--------|-----|
| Model | `PATCH /api/agents/:id` with `{ adapterConfig: { model }, replaceAdapterConfig: false }` only |
| Desired skills | `POST /api/agents/:id/skills/sync` with full library keys only → GET verify |
| Pause Codex | `POST /api/agents/:id/pause` (only `manageStatus:true`) → GET status |
| Routine status | `PATCH /api/routines/:id` → GET `/routines/:id` |
| Schedule trigger | `PATCH /api/routine-triggers/:id` → GET `/routines/:id` |

Partial failure: report lists **completed** / **failed** / **skipped** and `writesSucceeded`. Exit `3` = partial success (fail-fast; no further mutations).

## Summarizer (built-in)

Stock template (`server/src/built-ins/agents/summarizer/AGENTS.md`) now states primary model `claude-haiku-4-5` (not a default `cheap` profile lane). Live has `experimental.enableBuiltInAgents=false`, so built-in **reset returns 404**. Snapshot still keeps Summarizer model + instructions from the regular agent list metadata. Any live Summarizer instruction drift is handled outside this automated reconciler: validator reports contradictions and apply refuses instruction-change kinds.

## Skill runtime policy

| Adapter | Desired count | Active state |
|---------|---------------|--------------|
| `claude_local` / `codex_local` | 1–10 | `configured` |
| `cursor` / `opencode_local` | 1–5 | `installed` |

## Model policy (shadow, with profile-consistency gate)

`desired/model-policy.shadow.v1.json` is the versioned, secret-free policy
candidate for all 29 roles. It records each role's primary model, fallback,
effort, data class, hard safety gates, escalation, independent review and
per-run limits. `lib/model-policy.mjs` validates the complete role set and
fails closed on contradictions such as a restricted-data provider without
sanitization or a high-responsibility role without independent review.

The policy remains a shadow specification: it cannot wake agents, change an
adapter, or bypass the existing backup and paused-agent gates. `profile-switch`
does consume it as a **read-only consistency gate** for the 22 switchable
roles: `openai-first` must equal each role's primary model, effort, workspace
access and daily limit; `anthropic-first` must equal its first Anthropic
fallback and daily limit. Both profile versions must equal the policy version.

This validation does not apply a policy and does not turn the policy into a
router. A live rollout still requires a separate dry-run runner with enforced
no-write execution and an explicit, reversible mapping from policy to live
agent configuration.

## Routines — observability note

After a routine is paused and its schedule trigger disabled, the live API may still return a stale `nextRunAt`. **Executive truth** for fleet-config is `status` + `trigger.enabled` (matched with id + title + triggerId). Validators deliberately do **not** require `nextRunAt === null`.

## Tests

```sh
node --test ops/fleet/jarvis/tests/fleet-config.test.mjs
node --test ops/fleet/jarvis/tests/profile-switch.test.mjs
# optional (may SKIP without embedded Postgres):
./node_modules/.bin/vitest run server/src/__tests__/built-in-agents.test.ts -t 'Summarizer|summarizer'
```

## Rollback

Restore the verified DB backup taken before apply (orchestrator). Agent config revisions may cover scoped PATCHes. Re-run `verify`.

## Limitations

- JSON under `desired/` is the only SSOT — no YAML mirrors.
- Skill content is not in-repo; missing library keys or short-name inputs fail before the first mutation.
- Codex/Recenzent remain paused by policy unless explicitly resumed in live operations.
- Stale `nextRunAt` on paused routines is an API observability limitation — validators do not assert `nextRunAt === null`.
