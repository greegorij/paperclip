---
title: Codex
summary: OpenAI Codex local adapter setup and configuration
---

The `codex_local` adapter runs OpenAI's Codex CLI locally. It supports session persistence via `previous_response_id` chaining and skills injection through the global Codex skills directory.

## Prerequisites

- Codex CLI installed (`codex` command available)
- Either a host Codex login with `~/.codex/auth.json`, or a per-agent
  `OPENAI_API_KEY` configured in adapter env (Paperclip materializes this into
  `$CODEX_HOME/auth.json` for managed homes; Codex CLI reads credentials from
  `auth.json`, not directly from the process environment — for a self-managed
  external `CODEX_HOME`, write `auth.json` there directly instead)

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | Yes | Working directory for the agent process (absolute path; created automatically if missing when permissions allow) |
| `model` | string | No | Model to use |
| `promptTemplate` | string | No | Prompt used for all runs |
| `env` | object | No | Environment variables (supports secret refs) |
| `timeoutSec` | number | No | Process timeout (0 = no timeout) |
| `graceSec` | number | No | Grace period before force-kill |
| `filesystemScope` | string | No | Set to `workspace` to run Codex inside Bubblewrap filesystem confinement |
| `filesystemWorkspaceAccess` | string | No | Workspace mount mode for `filesystemScope=workspace`: `rw` (default) or `ro` |
| `networkScope` | string | No | Local Bubblewrap network policy (`deny` or `allowlist`) |
| `networkAllowlist` | string[] | No | Exact hostnames/origins allowed when `networkScope=allowlist` |
| `shadowReadOnly` | boolean | No | Runs a local, disposable read-only evaluation lane; rejects ACP, remote targets, empty allowlists, and extra filesystem paths |
| `fastMode` | boolean | No | Enables Codex Fast mode. Currently supported on `gpt-5.4` only and burns credits faster |
| `dangerouslyBypassApprovalsAndSandbox` | boolean | No | Skip safety checks (dev only) |

## Paperclip control plane and process environment

Normal CLI and ACP runs receive one adapter-neutral, run-scoped `runtimeMcp`
set. Its first entry is the mandatory Paperclip control plane at `/api/mcp`,
created for every authenticated run independently of gateway tables. Optional
managed gateways and installed tool connections are appended as authenticated HTTP MCP
endpoints. The Codex renderer writes only that set into the managed `CODEX_HOME`;
there is no separate heartbeat-context channel, so switching between Claude and
Codex preserves the same tool identity.

The child process inherits only allowlisted operating-system identity/runtime
values from the Paperclip server. Provider credentials are not inherited;
authentication must come from the adapter's explicit `env` or its CLI-owned
credential files. Database,
migration, encryption, signing, backup, mail and infrastructure settings are
server-only. Values declared explicitly in adapter `env` still pass through.
`managedMcpOnly=false` disables only additional named managed gateways. It can
never disable the mandatory Paperclip control plane; independently permitted
optional connections remain available.

## Session Persistence

Codex uses `previous_response_id` for session continuity. The adapter serializes and restores this across heartbeats, allowing the agent to maintain conversation context.

## Skills Injection

The adapter symlinks Paperclip skills into the global Codex skills directory (`~/.codex/skills`). Existing user skills are not overwritten.

## Bubblewrap + Codex sandbox layering

When `filesystemScope`/`networkScope` are enabled, Bubblewrap is the hard execution boundary. In this setup you can keep `dangerouslyBypassApprovalsAndSandbox=false` while still passing Codex CLI `--sandbox danger-full-access` through `extraArgs`, so Codex does not add a second inner sandbox on top of Bubblewrap.

What the Bubblewrap workspace sandbox actually brings in from the host:

- **Mounted read-only (system):** `/usr` and related cert/userdb/timezone/gitconfig paths, plus top-level `/bin`, `/sbin`, `/lib`, `/lib64` when they are real directories (merged-/usr hosts recreate those as symlinks to `usr/...` instead of mounting them).
- **Mounted (workspace):** the configured workspace directory (`rw` by default, or `ro` when `filesystemWorkspaceAccess=ro`), plus any explicit managed/extra paths.
- **Mounted read-only (engine):** the command directory (`dirname` of the Codex executable path) and the real package root of the fully resolved binary — not parent stop directories along a symlink install layout.
- **Recreated inside the sandbox:** symlink hops on the executable path (for example `~/.local/bin/codex` and a `standalone/current → releases/<version>` style directory link) are replayed with their literal `readlink` targets, including relative ones. Intermediate directories such as `standalone/` or `standalone/releases/` are not mounted.

Parent directories of those reconstructed links are created empty in the sandbox so relative targets in the chain can resolve. Package-root discovery walks upward from the resolved binary without a home ceiling, so a host home path may still appear among mounts when that is the nearest package boundary found.

## Read-only shadow evaluation

Set `shadowReadOnly=true` only for offline evaluation or shadow comparisons, not for normal agent work. The adapter fails closed unless it can use the local Codex CLI, mount the workspace read-only, and apply a non-empty network allowlist. ACP, remote execution, and additional filesystem paths are rejected.

Each shadow run uses a disposable `CODEX_HOME`. It keeps only the provider credential/configuration needed by Codex, removes Paperclip-managed MCP configuration, and is deleted when the run ends—even after a spawn failure. The child process receives no `PAPERCLIP_*` environment variables, Paperclip API token, runtime MCP, bridge, workspace restore path, or auth copy-back path. This makes the lane suitable for measurement, not for operating the Paperclip control plane.

Shadow runs also always start a fresh Codex session: a saved response or session identifier is neither passed to the CLI nor recovered from the disposable home.

## Fast Mode

When `fastMode` is enabled, Paperclip adds Codex config overrides equivalent to:

```sh
-c 'service_tier="fast"' -c 'features.fast_mode=true'
```

Paperclip currently applies that only when the selected model is `gpt-5.4`. On other models, the toggle is preserved in config but ignored at execution time to avoid unsupported runs.

## Managed `CODEX_HOME`

When Paperclip is running inside a managed worktree instance (`PAPERCLIP_IN_WORKTREE=true`), the adapter instead uses a worktree-isolated `CODEX_HOME` under the Paperclip instance so Codex skills, sessions, logs, and other runtime state do not leak across checkouts. It seeds that isolated home from the user's main Codex home for shared auth/config continuity.

### Per-agent isolation and auth seeding

For `codex_local` agents the server isolation guard pins each agent to a per-agent home (`<instance>/companies/<companyId>/agents/<agentId>/codex-home`) and sets `OPENAI_API_KEY=""` so an agent can never spend against the host API key or share another agent's Codex state.

A managed home is created empty, so the adapter must provision auth into it before launching Codex — otherwise the agent runs with zero credentials and the provider returns `401 Missing bearer`. The seeding contract:

- **Managed homes** (the default home and any configured `CODEX_HOME` under the company tree) are always seeded: the ChatGPT-subscription `auth.json` is symlinked from the host Codex home, or, when a per-agent `OPENAI_API_KEY` is configured, an API-key `auth.json` is written instead.
- **Genuine external overrides** (a `CODEX_HOME` outside the Paperclip-managed company tree) are treated as self-managed and are never seeded or overwritten.
- **Fail-fast guard:** if a managed home ends up with no usable `auth.json` and no configured API key, the run fails with an explicit `adapter_failed` ("no Codex credentials provisioned for managed home …") rather than emitting an unauthenticated request.

### Auth ownership and precedence

`codex_local` is host-owns-auth when Paperclip owns the effective
`CODEX_HOME`. The winning credential file is:

1. **Per-agent API key:** when adapter env contains a non-empty
   `OPENAI_API_KEY`, Paperclip writes `$CODEX_HOME/auth.json` with only
   `{ "OPENAI_API_KEY": "..." }`. This overwrites any existing file or symlink
   at that path. Codex CLI versions that Paperclip supports read the key from
   `auth.json`, not directly from the process environment.
2. **Host ChatGPT-subscription login:** when no per-agent key is configured,
   Paperclip symlinks `auth.json` from the shared host Codex home into the
   managed home. The symlink keeps rotating/single-use refresh tokens live
   instead of copying a stale token into the managed home.
3. **External `CODEX_HOME`:** if adapter env points `CODEX_HOME` outside the
   Paperclip-managed company tree, that home is self-managed. Paperclip does
   not seed or overwrite it, so its own `auth.json` wins.

For sandbox or SSH execution, Paperclip uploads the effective managed
`CODEX_HOME` and launches Codex with `CODEX_HOME` pointing at that uploaded
directory. Any `auth.json` already baked into the sandbox image is shadowed in
managed-home mode. If the host has no usable `auth.json` and no per-agent
`OPENAI_API_KEY`, the managed run fails fast instead of falling back to an
in-sandbox login.

Worked example: a worker runs in a sandbox image that already has
`$HOME/.codex/auth.json`, and the Paperclip host is logged in with a ChatGPT
subscription. For a managed `codex_local` agent, Paperclip symlinks the host
`auth.json` into the agent's managed home, uploads that home to the sandbox,
and sets `CODEX_HOME` to the uploaded path. Codex reads the host-owned
uploaded file, so the sandbox image login does not win.

For high-concurrency sandbox fleets, prefer a per-agent `OPENAI_API_KEY` over a
shared ChatGPT-subscription login. API-key mode produces a standalone
`auth.json` for each managed home and avoids many concurrent sandboxes sharing
one rotating subscription credential. The tradeoff is billing: API-key mode is
metered per token through the OpenAI API, while ChatGPT-subscription auth uses
the subscription's flat-plan economics and quota behavior. Pick the mode
deliberately for the fleet's cost and concurrency profile.

### Deferred config-validation warning spec

This section specifies a warning that is not implemented yet. The warning should
help operators notice the host-owns-auth topology before they run a sandbox
fleet with ChatGPT-subscription credentials.

- **Source fields:** resolved Codex auth mode (`api` vs `subscription`) and
  execution target kind (`local`, `remote:ssh`, or `remote:sandbox`). Infer the
  auth mode from the final managed `$CODEX_HOME/auth.json` shape after seeding:
  `{ "OPENAI_API_KEY": ... }` means API-key mode; subscription-token-shaped
  host auth, including the symlinked host file, means ChatGPT-subscription
  mode. Use top-level shape only; do not read credential values into the
  warning. The target kind comes from `AdapterExecutionTarget`.
- **Transformations:** during config preparation or home seeding for a run,
  classify `(subscription auth mode AND remote/sandbox execution target)` as a
  warning condition. This is classification only. Do not read credential values
  into the warning.
- **Sink fields:** emit a warning log line through `onLog("stderr", ...)` and,
  when the config-validation surface supports it, a surfaced validation warning.
  The sink may include only the auth-mode label and target type.
- **Retention:** warning text may appear in ephemeral run logs or validation
  results. Do not persist auth material.
- **Attacker-observable IDs:** none new. The warning must not print token
  values, email addresses, or `auth.json` contents.
- **Hook point:** wire the check at the `codex_local` execute/config-prep path
  around managed-home seeding: `execute.ts` already has `executionTarget` /
  target transport in scope, calls `seedManagedCodexHome`, and calls
  `evaluateCodexCredentialReadiness` before uploading `CODEX_HOME`. If the
  warning is factored into `codex-home.ts`, pass the resolved target
  classification in rather than making `codex-home.ts` inspect execution
  targets on its own.

Because the warning touches authentication behavior, implementation must go
through the security-review gate. Treat this docs section as the follow-up
implementation spec, not as authorization to add the warning in a docs-only
change.

## Manual Local CLI

For manual local CLI usage outside heartbeat runs (for example running as `codexcoder` directly), use:

```sh
pnpm paperclipai agent local-cli codexcoder --company-id <company-id>
```

This installs any missing skills, creates an agent API key, and prints shell exports to run as that agent.

## Instructions Resolution

If `instructionsFilePath` is configured, Paperclip reads that file and prepends it to the stdin prompt sent to `codex exec` on every run.

This is separate from any workspace-level instruction discovery that Codex itself performs in the run `cwd`. Paperclip does not disable Codex-native repo instruction files, so a repo-local `AGENTS.md` may still be loaded by Codex in addition to the Paperclip-managed agent instructions.

## Environment Test

The environment test checks:

- Codex CLI is installed and accessible
- Working directory is absolute and available (auto-created if missing and permitted)
- Authentication signal (`OPENAI_API_KEY` presence)
- A live hello probe (`codex exec --json -` with prompt `Respond with hello.`) to verify the CLI can actually run
