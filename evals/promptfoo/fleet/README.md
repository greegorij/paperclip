# Fleet Configuration Comparison — Isolated Eval Suite

This directory contains an isolated Promptfoo evaluation suite for comparing
Paperclip agent role/config behaviors across provider harnesses. It is separate
from the default heartbeat eval suite (`evals/promptfoo/promptfooconfig.yaml`)
so that routine `evals:smoke` runs do not incur the cost of the full provider matrix.

## Provider harnesses

| Label | Harness | Auth | Notes |
|-------|---------|------|-------|
| `fleet/claude-sonnet5-api-quality` | Anthropic direct API (`anthropic:messages:claude-sonnet-5`) | `ANTHROPIC_API_KEY` | Primary quality candidate; real Anthropic billing, not OpenRouter proxy |
| `fleet/claude-haiku45-api-cheap` | Anthropic direct API (`anthropic:messages:claude-haiku-4-5-20251001`) | `ANTHROPIC_API_KEY` | Cheap candidate; real Anthropic billing, not OpenRouter proxy |
| `fleet/claude-sonnet5-subscription-cli` | Node exec wrapper (`claude-exec.mjs`) | Claude Code subscription / keychain | Real `claude` CLI, `claude-sonnet-5`; **subscription cost, not API billing** |
| `fleet/codex-sdk-default` | `openai:codex-sdk` (no forced model) | ChatGPT login / `OPENAI_API_KEY` | Mirrors live adapter behavior where `--model` is omitted |
| `fleet/codex-gpt-5.6-sol` | `openai:codex-sdk` with `gpt-5.6-sol` | ChatGPT login may authenticate; `OPENAI_API_KEY` optional | Explicit Codex candidate — do not filter by `openai:gpt-5.6-sol`, that bypasses Codex SDK |
| `fleet/cursor-auto-exec` | Node exec wrapper (`cursor-exec.mjs`) | Cursor subscription | Real `cursor-agent` CLI; **subscription cost, not per-call API billing** |
| `fleet/openrouter-gemini-3.6-flash` | OpenRouter | `OPENROUTER_API_KEY` | OpenRouter routing only — not equivalent to local Cursor or Codex |
| `fleet/openrouter-gemini-3.5-flash-lite` | OpenRouter | `OPENROUTER_API_KEY` | Cheap OpenRouter candidate |

**Important distinctions:**

- **Anthropic direct API** bills to your Anthropic account at published API pricing.
- **Claude Code subscription CLI** runs the real `claude` CLI with `claude-sonnet-5`. Uses local subscription or keychain auth — no API key required. Network IS required for the model call. What IS guaranteed: no repo exposure, no tools, no persisted session, no settings/MCP inheritance. `--bare` is intentionally omitted so subscription/keychain auth remains possible. Do not compare subscription cost with API `cost_usd`.
- **Codex SDK / ChatGPT login** uses OpenAI's Codex harness; existing ChatGPT login may authenticate both the default and explicit gpt-5.6-sol candidates. Set `OPENAI_API_KEY` only for explicit API-key billing.
- **Cursor subscription harness** runs the real `cursor-agent` CLI. There is no per-call cost figure — usage is covered by your Cursor subscription. Do not compare subscription usage with API cost_usd figures.
- **OpenRouter** proxies requests through OpenRouter's routing layer. Model IDs are OpenRouter-specific.

All provider runs are **opt-in**. Use `--filter-providers` to select a single provider label
and avoid accidentally running the full paid matrix (see filtering examples below).

## Running evaluations

### Prerequisites

```bash
# Anthropic (direct API)
export ANTHROPIC_API_KEY=sk-ant-...

# Claude Code subscription CLI (optional override; default: claude on PATH)
# export CLAUDE_CODE_PATH=/path/to/claude

# Codex — optional; ChatGPT login may authenticate without a key
export OPENAI_API_KEY=sk-...

# OpenRouter candidates
export OPENROUTER_API_KEY=sk-or-...

# Cursor exec harness (optional override)
# export CURSOR_AGENT_PATH=/path/to/cursor-agent
```

### Validate config (no model calls)

```bash
pnpm evals:fleet:validate
# or directly:
cd evals/promptfoo/fleet
npx promptfoo@0.121.19 validate -c promptfooconfig.yaml
```

### Run all fleet providers (paid — explicit opt-in)

```bash
pnpm evals:fleet:run
# or directly:
cd evals/promptfoo/fleet
npx promptfoo@0.121.19 eval -c promptfooconfig.yaml
```

### Run fleet tests (no paid calls)

```bash
pnpm evals:fleet:test
```

### Filter by provider label (no config changes needed)

Use `--filter-providers` with a label regex. This is the correct way to select a single
provider without accidentally running the full matrix.

```bash
cd evals/promptfoo/fleet

# Anthropic quality candidate (Sonnet 5 direct API)
npx promptfoo@0.121.19 eval -c promptfooconfig.yaml \
  --filter-providers "fleet/claude-sonnet5-api-quality"

# Anthropic cheap candidate (Haiku 4.5 direct API)
npx promptfoo@0.121.19 eval -c promptfooconfig.yaml \
  --filter-providers "fleet/claude-haiku45-api-cheap"

# Codex default (no forced model)
npx promptfoo@0.121.19 eval -c promptfooconfig.yaml \
  --filter-providers "fleet/codex-sdk-default"

# Explicit gpt-5.6-sol via Codex SDK (select by label, NOT by openai:gpt-5.6-sol)
npx promptfoo@0.121.19 eval -c promptfooconfig.yaml \
  --filter-providers "fleet/codex-gpt-5.6-sol"

# Claude Code subscription CLI (requires claude in PATH or CLAUDE_CODE_PATH)
npx promptfoo@0.121.19 eval -c promptfooconfig.yaml \
  --filter-providers "fleet/claude-sonnet5-subscription-cli"

# Cursor exec harness (requires cursor-agent in PATH or CURSOR_AGENT_PATH)
npx promptfoo@0.121.19 eval -c promptfooconfig.yaml \
  --filter-providers "fleet/cursor-auto-exec"

# OpenRouter main candidate
npx promptfoo@0.121.19 eval -c promptfooconfig.yaml \
  --filter-providers "fleet/openrouter-gemini-3.6-flash"

# OpenRouter cheap candidate
npx promptfoo@0.121.19 eval -c promptfooconfig.yaml \
  --filter-providers "fleet/openrouter-gemini-3.5-flash-lite"
```

### View results

```bash
cd evals/promptfoo/fleet
npx promptfoo@0.121.19 view
```

## Claude Code subscription CLI exec wrapper

The Claude Code harness uses `scripts/claude-exec.mjs` — a portable Node ESM wrapper.

**How it works:**

1. Receives the rendered prompt as the first script argument. Promptfoo passes the prompt as the script first argument; in Node ESM `process.argv[2]` is that argument.
2. Resolves `claude` from `CLAUDE_CODE_PATH` env var or `claude` on `PATH`.
3. Creates a fresh `mkdtemp` working directory (used as `cwd` for `spawnSync`).
4. Invokes `claude -p --output-format text --model claude-sonnet-5 --no-session-persistence --permission-mode plan --tools "" --setting-sources "" --disable-slash-commands --no-chrome --strict-mcp-config --mcp-config '{"mcpServers":{}}' <prompt>`.
5. `--bare` is intentionally omitted so local subscription or keychain auth remains possible.
6. Enforces a configurable timeout (`CLAUDE_EVAL_TIMEOUT_MS`, default 120000 ms) via `spawnSync`.
7. Always deletes the temp directory on exit (success, error, or timeout).
8. Returns valid Promptfoo provider JSON `{ output, error }`.

**Safety claims:** no repo exposure, no tools, no persisted session, no settings/MCP inheritance.
**Not claimed:** network isolation (the model call requires network).

**Unit tests (no paid calls):**

```bash
node --test evals/promptfoo/fleet/scripts/claude-exec.test.js
```

Tests cover: `CLAUDE_CODE_PATH` resolution, exact argument passing (including `--tools ""`,
`--setting-sources ""`, `--mcp-config` JSON, absence of `--bare`), prompt via argv,
temp directory isolation, cleanup on success and timeout, missing executable,
nonzero exit, and no paid calls.

## Cursor exec wrapper

The Cursor harness uses `scripts/cursor-exec.mjs` — a portable Node ESM wrapper.

**How it works:**

1. Receives the rendered prompt as the first script argument. Promptfoo passes the prompt as the script first argument; in Node ESM `process.argv[2]` is that argument.
2. Resolves `cursor-agent` from `CURSOR_AGENT_PATH` env var or `cursor-agent` on `PATH`.
3. Creates a fresh `mkdtemp` working directory.
4. Invokes `cursor-agent -p --output-format text --mode ask --model auto --sandbox enabled --trust --workspace <tmpdir> <prompt>`.
5. Enforces a configurable timeout (`CURSOR_EVAL_TIMEOUT_MS`, default 120000 ms) via `spawnSync`.
6. Always deletes the temp directory on exit (success, error, or timeout).
7. Returns valid Promptfoo provider JSON `{ output, error }`.

**Unit tests (no paid calls):**

```bash
node --test evals/promptfoo/fleet/scripts/cursor-exec.test.js
```

Tests cover: `CURSOR_AGENT_PATH` resolution, exact argument passing, prompt via argv,
temp directory isolation, cleanup, nonzero exit, and timeout path.

## Metrics reported per case

| Metric | Source |
|--------|--------|
| `pass` / `fail` per assertion | Promptfoo |
| `latency_ms` | Promptfoo (automatic) |
| `tokens_in` / `tokens_out` | Provider (API only; not available for Cursor exec) |
| `cost_usd` | Provider (API pricing only) |

**Do not compare `cost_usd` from API providers with Cursor subscription usage.**
Report them in separate columns or runs.

## Test cases

| Case | What it checks |
|------|---------------|
| `fleet_config.done_vs_in_review_vs_blocked` | Correct status lifecycle |
| `fleet_config.readonly_role_compliance` | Read-only agent does not mutate beyond a comment |
| `fleet_config.delegation_not_self_edit` | Manager delegates via child issue, does not self-implement |
| `fleet_config.cheap_recovery_state_only` | Recovery heartbeat updates status/comment only |
| `fleet_config.role_contradiction_resistance` | Agent rejects instructions that violate its role |
| `fleet_config.concise_evidence_report` | Scout/reviewer output is structured with evidence, ≤280 words |

Assertions use compact JSON output requirements and parsed field checks for
determinism — not fragile phrase matching.

## Known limitations

- `claude` (Claude Code subscription CLI) network isolation is **not** claimed — the model
  call requires network. What IS claimed: no repo exposure, no tools, no persisted session,
  no settings/MCP inheritance.
- `cursor-agent` network isolation is **not** guaranteed by the CLI; the `--sandbox enabled`
  flag is the best available enforcement, but the harness cannot claim network isolation.
- Claude Code and Cursor subscription costs are not comparable to API `cost_usd` — report separately.
- These are prompt-level behavior assertions only. They do not replace server/API tests
  for status transitions or budget enforcement.
- `openai:codex-sdk` represents the Codex SDK harness, not the local Cursor environment.
- The Anthropic direct API providers (`fleet/claude-sonnet5-api-quality` and
  `fleet/claude-haiku45-api-cheap`) are kept separately labeled for pure model-price
  comparison; do not mix with subscription-harness cost figures.

## Safety

- No company, agent, or personal identifiers are embedded in test cases.
  `company-eval-01` and `agent-*-01` are eval-only synthetic identifiers.
- Results are local only (`promptfoo view`) unless you configure a remote store.
- Running this suite does not modify live fleet configuration.
