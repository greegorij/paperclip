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
- Agent status is mutated only when `manageStatus: true` (Codex → paused). Apply never mass-resumes agents.
- Do not treat `GET /agents/:id/skills` `entries.length ≈ 39` as assignment.
- Snapshot/validate are **fail-closed**: hard invariant **29 = 27 portable + exactly 2 built-in keys** (`summarizer`, `reflection-coach`); `completeness` object required with `complete: true` and counters matching agent/skill arrays; empty AGENTS.md rejected; missing `skillLibrary` aborts. Built-ins are derived from `metadata.paperclipBuiltInAgent.key` (the `/built-in-agents` endpoint may 404 when disabled and must not wipe data).
- **Diff/verify compare full `skillKeys` vs live `desiredSkills` for all 27 portable agents** (not a four-role override subset). Built-in model/skills drift is included in verify — not ignored.
- Apply runs full structural validate + skill-key preflight **before** the first mutation; fail-fast after the first write/verify error. `partial=true` if any write succeeded, including write-ok/verify-fail when `completed` is still empty.
- Every successful write is followed by a confirming GET (model, AGENTS.md content/hash, desired skill keys, routine id+title+triggerId+value). Dry-run skips write-verify GETs.

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

Routine IDs and schedule trigger IDs are already filled in `desired/routines.json` from the live audit. Apply refuses if live id/title/triggerId do not all match — **no name-only fallback**.

## APIs used

| Change | API |
|--------|-----|
| Model | `PATCH /api/agents/:id` with `{ adapterConfig: { model }, replaceAdapterConfig: false }` only |
| Portable instructions | `PUT /api/agents/:id/instructions-bundle/file` → GET verify exact content |
| Desired skills | `POST /api/agents/:id/skills/sync` with full library keys only → GET verify |
| Pause Codex | `POST /api/agents/:id/pause` (only `manageStatus:true`) → GET status |
| Routine status | `PATCH /api/routines/:id` → GET `/routines/:id` |
| Schedule trigger | `PATCH /api/routine-triggers/:id` → GET `/routines/:id` |
| Summarizer stock claim fix | `GET` then `PUT` then `GET` `/api/agents/:id/instructions-bundle/file` |

Partial failure: report lists **completed** / **failed** / **skipped** and `writesSucceeded`. Exit `3` = partial success (fail-fast; no further mutations). A PUT that passes but fails GET verify still sets `partial=true`.

## Summarizer (built-in)

Stock template (`server/src/built-ins/agents/summarizer/AGENTS.md`) now states primary model `claude-haiku-4-5` (not a default `cheap` profile lane). Live has `experimental.enableBuiltInAgents=false`, so built-in **reset returns 404**. Snapshot still keeps Summarizer model + instructions from the regular agent list metadata. Apply patches via GET → exact-old fragment → PUT → GET verify: post-write content must equal `plan.next` (or matching SHA-256). `already-patched` requires the exact target section with no cheap-lane claim; partial/corrupted Model wording is refused.

## Skill runtime policy

| Adapter | Desired count | Active state |
|---------|---------------|--------------|
| `claude_local` / `codex_local` | 1–10 | `configured` |
| `cursor` / `opencode_local` | 1–5 | `installed` |

## Routines — observability note

After a routine is paused and its schedule trigger disabled, the live API may still return a stale `nextRunAt`. **Executive truth** for fleet-config is `status` + `trigger.enabled` (matched with id + title + triggerId). Validators deliberately do **not** require `nextRunAt === null`.

## Tests

```sh
node --test ops/fleet/jarvis/tests/fleet-config.test.mjs
# optional (may SKIP without embedded Postgres):
./node_modules/.bin/vitest run server/src/__tests__/built-in-agents.test.ts -t 'Summarizer|summarizer'
```

## Rollback

Restore the verified DB backup taken before apply (orchestrator). Agent config revisions may cover scoped PATCHes. Re-run `verify`.

## Limitations

- JSON under `desired/` is the only SSOT — no YAML mirrors.
- Skill content is not in-repo; missing library keys or short-name inputs fail before the first mutation.
- Codex remains paused; no bubblewrap pilot in this change.
- Stale `nextRunAt` on paused routines is an API observability limitation — validators do not assert `nextRunAt === null`.
