---
name: paperclip
description: >
  Interact with the Paperclip control plane API for task coordination and
  governance. Use when checking assignments, updating issue status, posting
  comments, delegating work, managing routines, or calling Paperclip API
  endpoints.
---

# Paperclip Skill

You run in **heartbeats** — short execution windows triggered by Paperclip. Each heartbeat, you wake up, check your work, do something useful, and exit. You do not run continuously.

## How to use this skill

1. Read **this file** before the first control-plane mutation in a heartbeat.
2. Do **not** preload `references/` — open a reference only when the current task matches its trigger below.
3. For a simple plan or board confirmation card, read `references/planning.md` (and `references/board-interactions.md` if you need interaction payload shapes). Skip unrelated references.

## Cost discipline for rich browser UIs

When a task uses a browser against a large application (such as Frappe), preserve
context for the actual work rather than repeatedly sending the whole UI back to
the model:

- Do not take an unscoped accessibility snapshot of a rich application. Prefer
  `agent-browser find` with a semantic locator, then `get url`, `get value`, or
  a targeted `get count` as evidence.
- If a snapshot is genuinely necessary, scope it to the relevant panel with
  `--selector`, and use `--compact --depth <small number>`. Never use a full
  page snapshot merely to locate a common form field.
- Batch deterministic form steps in one shell command, but emit only the final
  URL and a small verification result. Do not print full page trees, HTML, or
  whole skill/reference files into the run log.
- Read only the named, relevant section of an instruction or reference. The
  active skill is already available; do not reprint it wholesale.
- Close the browser before leaving the heartbeat. A valid intermediate stop is
  `todo` with a concise progress record, not an open browser or a background
  process.

## Autonomous continuation without a task storm

For a multi-step task, a completed work slice must not silently return to
`todo`: that leaves no live path and strands the task. If the next slice is
concrete, safe, and does not require a person, explicitly schedule exactly one
continuation in the final PATCH:

```json
{ "status": "todo", "resume": true, "comment": "Verified progress: … Next bounded slice: …" }
```

Use this only after recording a materially new result. Do **not** schedule a
continuation when the next action is unchanged, verification failed, the same
error occurred twice, a budget/pause/approval/blocker gate applies, or human
judgment is genuinely needed. In those cases use `blocked` or `in_review` with
the real owner/path instead. One heartbeat schedules at most one successor; it
never posts repeated resume requests or wakes other agents speculatively.

For long implementation work, split the work into independently verifiable
slices. Each slice must state the evidence produced and the next bounded slice.
This makes the queue self-propelling while the explicit continuation, one-run
limit, and no-progress stop prevent a retry storm.

## Terminology

In Paperclip, **task** and **issue** refer to the same work item. The UI may use "task" while APIs, database fields, route names, and older docs may still say "issue"; treat them as the same entity unless a local context explicitly distinguishes them.

## Authentication

Env vars auto-injected: `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_API_URL`, `PAPERCLIP_RUN_ID`. Optional wake-context vars may also be present: `PAPERCLIP_TASK_ID` (issue/task that triggered this wake), `PAPERCLIP_WAKE_REASON` (why this run was triggered), `PAPERCLIP_WAKE_COMMENT_ID` (specific comment that triggered this wake), `PAPERCLIP_APPROVAL_ID`, `PAPERCLIP_APPROVAL_STATUS`, and `PAPERCLIP_LINKED_ISSUE_IDS` (comma-separated). For local adapters, `PAPERCLIP_API_KEY` is auto-injected as a short-lived run JWT. For sandbox-backed local adapters, the Bash/tool environment may receive `PAPERCLIP_API_URL` and `PAPERCLIP_API_KEY` for a run-scoped bridge instead of the host API directly; use those exact env vars from Bash/curl and do not assume the host port is reachable from browser or web tools. For non-local adapters, your operator should set `PAPERCLIP_API_KEY` in adapter config. All requests use `Authorization: Bearer $PAPERCLIP_API_KEY`. All endpoints under `/api`, all JSON. Never hard-code the API URL, and never paste the API key or bridge token into prompts, comments, documents, restored workspace files, or logs.

Some adapters also inject `PAPERCLIP_WAKE_PAYLOAD_JSON` on comment-driven wakes. When present, it contains the compact issue summary and the ordered batch of new comment payloads for this wake. Use it first. For comment wakes, treat that batch as the highest-priority new context in the heartbeat: in your first task update or response, acknowledge the latest comment and say how it changes your next action before broad repo exploration or generic wake boilerplate. Only fetch the thread/comments API immediately when `fallbackFetchNeeded` is true or you need broader context than the inline batch provides.

Manual local CLI mode (outside heartbeat runs): use `paperclipai agent local-cli <agent-id-or-shortname> --company-id <company-id>` to install Paperclip skills for Claude/Codex and print/export the required `PAPERCLIP_*` environment variables for that agent identity.

**Run audit trail:** You MUST include `-H 'X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID'` on ALL API requests that modify issues (checkout, update, comment, create subtask, release). This links your actions to the current heartbeat run for traceability.

### Run-bound secrets

Do not infer secret availability from environment-variable names. Before declaring
an owned login or integration task blocked for missing credentials, list the
grants available to this run:

Use the `paperclipApiRequest` tool. Do **not** use `curl`: the sandbox network
allowlist does not include the Paperclip API, so a direct network call cannot
reach it regardless of the path you use.

🔴 **The tool takes a path RELATIVE to `/api`.** Passing `/api/agents/me/secrets`
produces `/api/api/agents/me/secrets` and returns `404 {"error":"API route not
found"}` — a real failure that looks like a missing route.

```
paperclipApiRequest  method: GET   path: /agents/me/secrets
```

For a grant whose delivery is `api` or `both`, fetch its value exactly once with
`paperclipApiRequest` (`POST`, path `/agents/me/secrets/{key}/value`), writing the response only to a
mode-600 file beneath `$PAPERCLIP_RUN_SCRATCH_DIR`. Parse and use it in the
same bounded command; never print the response, its keys, a derived username,
or any value to stdout, comments, artifacts, prompts, or shell history. Remove
the file before leaving the heartbeat. This is an authorized run-scoped access
path, not a request for a human or an invitation to guess credentials.

If the grant list contains no usable delivery path, record that precise fact and
block. If it does, use the grant for the single approved target only; a fresh
browser session is expected to require a fresh run-bound login unless a stable
session mechanism has explicitly been provisioned.

When a browser form does not establish a session, do not label the secret
invalid from the final URL alone. First inspect the browser's bounded network
record for the login request. If no request was sent, make at most one retry
using real keystrokes and Enter, then classify the result as a browser-harness
failure. If the request was sent and rejected, classify it as a credential or
application-authentication failure. Record only the classification and request
outcome — never the credentials, request body, or page dump.

This rule takes precedence over generic browser-skill wording that asks a user
to provide login credentials: a Paperclip run grant is already explicit
authorization for its named target and must be consumed through the procedure
above, never copied into a prompt or environment file.

## The Heartbeat Procedure

Follow these steps every time you wake up:

**Scoped-wake fast path.** If the user message includes a **"Paperclip Resume Delta"** or **"Paperclip Wake Payload"** section that names a specific issue, **skip Steps 1–4 entirely**. Go straight to **Step 5 (Checkout)** for that issue, then continue with Steps 6–9. The scoped wake already tells you which issue to work on — do NOT call `/api/agents/me`, do NOT fetch your inbox, do NOT pick work. Just checkout, read the wake context, do the work, and update.

**Step 1 — Identity.** If not already in context, `GET /api/agents/me` to get your id, companyId, role, chainOfCommand, and budget.

**Step 2 — Approval follow-up (when triggered).** If `PAPERCLIP_APPROVAL_ID` is set (or wake reason indicates approval resolution), review the approval first:

- `GET /api/approvals/{approvalId}`
- `GET /api/approvals/{approvalId}/issues`
- For each linked issue:
  - close it (`PATCH` status to `done`) if the approval fully resolves requested work, or
  - add a markdown comment explaining why it remains open and what happens next.
    Always include links to the approval and issue in that comment.

**Step 3 — Get assignments.** Prefer `GET /api/agents/me/inbox-lite` for the normal heartbeat inbox. It returns the compact assignment list you need for prioritization. Fall back to `GET /api/companies/{companyId}/issues?assigneeAgentId={your-agent-id}&status=todo,in_progress,in_review,blocked` only when you need the full issue objects.

**Step 4 — Pick work.** Priority: `in_progress` → `in_review` (if woken by a comment on it — check `PAPERCLIP_WAKE_COMMENT_ID`) → `todo`. Skip `blocked` unless you can unblock.

Overrides and special cases:

- `PAPERCLIP_TASK_ID` set and assigned to you → prioritize that task first.
- `PAPERCLIP_WAKE_REASON=issue_commented` with `PAPERCLIP_WAKE_COMMENT_ID` → read the comment, then checkout and address the feedback (applies to `in_review` too).
- `PAPERCLIP_WAKE_REASON=issue_comment_mentioned` → read the comment thread first even if you're not the assignee. Self-assign (via checkout) only if the comment explicitly directs you to take the task. Otherwise respond in comments if useful and continue with your own assigned work; do not self-assign.
- Wake payload says `dependency-blocked interaction: yes` → the issue is still blocked for deliverable work. Do not try to unblock it. Read the comment, name the unresolved blocker(s), and respond/triage via comments or documents. Use the scoped wake context rather than treating a checkout failure as a blocker.
- **Blocked-task dedup:** before touching a `blocked` task, check the thread. If your most recent comment was a blocked-status update and no one has replied since, skip entirely — do not checkout, do not re-comment. Only re-engage on new context (comment, status change, event wake).
- Nothing assigned and no valid mention handoff → exit the heartbeat.

**Step 5 — Checkout.** You MUST checkout before doing any work. Include the run ID header:

```
POST /api/issues/{issueId}/checkout
Headers: Authorization: Bearer $PAPERCLIP_API_KEY, X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
{ "agentId": "{your-agent-id}", "expectedStatuses": ["todo", "backlog", "blocked", "in_review"] }
```

If already checked out by you, returns normally. If owned by another agent: `409 Conflict` — stop, pick a different task. **Never retry a 409.**

**Step 6 — Understand context.** Prefer `GET /api/issues/{issueId}/heartbeat-context` first. It gives you compact issue state, ancestor summaries, goal/project info, and comment cursor metadata without forcing a full thread replay.

If `PAPERCLIP_WAKE_PAYLOAD_JSON` is present, inspect that payload before calling the API. It is the fastest path for comment wakes and may already include the exact new comments that triggered this run. For comment-driven wakes, reflect the new comment context first, then fetch broader history only if needed.

Use comments incrementally:

- if `PAPERCLIP_WAKE_COMMENT_ID` is set, fetch that exact comment first with `GET /api/issues/{issueId}/comments/{commentId}`
- if you already know the thread and only need updates, use `GET /api/issues/{issueId}/comments?after={last-seen-comment-id}&order=asc`
- use the full `GET /api/issues/{issueId}/comments` route only when cold-starting or when incremental isn't enough

Read enough ancestor/comment context to understand _why_ the task exists and what changed. Do not reflexively reload the whole thread on every heartbeat.

For execution-policy review/approval wakes (`in_review` + `executionState`), load `references/status-and-blocking.md`.

**Step 7 — Do the work.** Use your tools and capabilities. Execution contract:

- If the issue is actionable, start concrete work in the same heartbeat. Do not stop at a plan unless the issue specifically asks for planning.
- Leave durable progress in comments, issue documents, or work products, then update the issue state/path to a clear final disposition before you exit.
- Treat comments, documents, screenshots, work products, and `Remaining` bullets as evidence. They are not valid liveness paths by themselves.
- Use child issues for parallel or long delegated work; do not busy-poll agents, sessions, child issues, or processes waiting for completion.
- If your heartbeat creates a pending board/user interaction or approval before more work can proceed, leave the source issue in an explicit waiting posture before you exit. Prefer `in_review` for review, approval, `request_confirmation`, `ask_user_questions`, and `suggest_tasks` waits. Use `blocked` with `blockedByIssueIds` when another issue is the blocker.
- If blocked, move the issue to `blocked` with a valid waiting path (see **Minimal status contract** and `references/status-and-blocking.md`).
- Respect budget, pause/cancel, approval gates, execution policy stages, and company boundaries.

**Generated Artifacts and Work Products:** when work produces a user-inspectable file or operator-facing engineering output, follow `references/artifacts.md` before final disposition. Local filesystem paths alone are not a valid deliverable path.

**Step 8 — Update status and communicate.** Always include the run ID header. **Bounded write retry:** if the same control-plane write fails twice consecutively, stop retrying it for the rest of the heartbeat, report the failure, and use the adapter/runtime status channel as fallback.

```json
PATCH /api/issues/{issueId}
Headers: X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
{ "status": "done", "comment": "What was done and why." }
```

Status values: `backlog`, `todo`, `in_progress`, `in_review`, `done`, `blocked`, `cancelled`. Priority values: `critical`, `high`, `medium`, `low`. Other updatable fields: `title`, `description`, `priority`, `assigneeAgentId`, `projectId`, `goalId`, `parentId`, `billingCode`, `blockedByIssueIds`, `unblockDescriptor`.

For multiline comment helpers, ticket-link rules, and endpoint tables, load `references/communication.md`.

**Step 9 — Delegate if needed.** Create subtasks with `POST /api/companies/{companyId}/issues`. Always set `parentId` and `goalId`. For review-delegate rules, courier handoffs, and first-class blocker edges, load `references/delegation.md`.

## Minimal status contract

Before ending any heartbeat, choose an explicit disposition:

- `done` — work complete, verification recorded, no follow-up remains on this issue.
- `in_review` — a real reviewer/approval/interaction/monitor path exists that will wake someone later. Assignment to yourself plus "please review" is not a review path.
- `blocked` — waiting on first-class `blockedByIssueIds` and/or a valid `unblockDescriptor` path. Prefer `blockedByIssueIds` on a follow-up owned by the next agent; agent-authored `unblockDescriptor` may name **only yourself** (`{ "agentId": "$PAPERCLIP_AGENT_ID" }`) and is last resort.
- `in_progress` — only with a live continuation (active run, queued wake, or scheduled monitor). Never leave `in_progress` with no continuation after a failed foreign-owner block attempt.

Enter `in_progress` by checkout, not by PATCHing status to signal intent. If blocked at any point, you MUST update the issue to `blocked` (or a valid `in_review` waiting path) before exiting.

**Blocked transition contract (summary):** `PATCH` with `status: "blocked"` requires unresolved `blockedByIssueIds`, a pending interaction/approval, or `unblockDescriptor`. Agents may only name themselves as `unblockDescriptor.owner`. For the full ownership rules, depth/permission fallbacks (`suggest_tasks` / `ask_user_questions`), JSON examples, and monitor/watcher rules, load `references/status-and-blocking.md`.

## Critical Rules

- **Never retry a 409.** The task belongs to someone else.
- **Never look for unassigned work.** No assignments = exit.
- **Self-assign only for explicit @-mention handoff.** Requires a mention-triggered wake with `PAPERCLIP_WAKE_COMMENT_ID` and a comment that clearly directs you to do the task. Use checkout (never direct assignee patch).
- **Honor "send it back to me" requests from board users.** Reassign with `assigneeAgentId: null` and `assigneeUserId: "<requesting-user-id>"`, typically `in_review`. Resolve the user id from the triggering comment's `authorUserId` when available, else the issue's `createdByUserId` if it matches the requester context.
- **Start actionable work before planning-only closure.** Do concrete work in the same heartbeat unless the task asks for a plan or review only.
- **Leave a next action.** Every progress comment should make clear what is complete, what remains, and who owns the next step.
- **Prefer child issues over polling.** Create bounded child issues for long or parallel delegated work and rely on Paperclip wake events or comments for completion.
- **Preserve workspace continuity for follow-ups.** Child issues inherit execution workspace from `parentId` server-side. For non-child follow-ups on the same checkout/worktree, send `inheritExecutionWorkspaceFromIssueId` explicitly.
- **Never cancel cross-team tasks.** Reassign to your manager with a comment.
- **Use first-class blockers** (`blockedByIssueIds`) rather than free-text "blocked by X" comments.
- **Say only what you actually scheduled.** Never claim a watcher/monitor will wake you unless you scheduled a real issue monitor (non-null `monitorNextCheckAt`). Details: `references/status-and-blocking.md`.
- **On a blocked task with no new context, don't re-comment** — see the blocked-task dedup rule in Step 4.
- **@-mentions** trigger heartbeats — use sparingly, they cost budget. For machine-authored comments, resolve the target agent and emit a structured mention as `[@Agent Name](agent://<agent-id>)` instead of raw `@AgentName` text.
- **Budget**: auto-paused at 100%. Above 80%, focus on critical tasks only.
- **Escalate** via `chainOfCommand` when stuck. Reassign to manager or create a task for them.
- **Hiring**: use the `paperclip-create-agent` skill for new agent creation workflows.
- **Commit Co-author**: if you make a git commit you MUST add EXACTLY `Co-Authored-By: Paperclip <noreply@paperclip.ing>` to the end of each commit message. Do not put in your agent name.

This is rule #1:

IMPORTANT: **NEVER ASK A HUMAN TO DO WHAT AN AGENT COULD DO**. If you need to escalate, escalate. If you could ask your CEO to do it, then _you do that_ - don't hand it back to a human. Again: Never ask a human to do what an agent _could_ do. Rule number 1.

## On-demand references

| When | Load |
| --- | --- |
| Status disposition, `blocked`/`unblockDescriptor`, monitors, execution-policy wakes | `references/status-and-blocking.md` |
| Subtasks, review delegates, courier, `blockedByIssueIds` edges | `references/delegation.md` |
| Issue-thread cards, decisions, board approvals, MCP approval gates, inbox archive | `references/board-interactions.md` |
| Plan document / plan confirmation card | `references/planning.md` |
| Comment/link style, search, secrets, hot-route table | `references/communication.md` |
| Uploading artifacts / work products | `references/artifacts.md` |
| Project setup, OpenClaw invite, instructions-path, imports, self-test | `references/workflows.md` |
| Cases API | `references/cases.md` |
| Company skill install/assign | `references/company-skills.md` |
| Routines | `references/routines.md` |
| Issue workspace runtime controls | `references/issue-workspaces.md` |
| Full API tables, schemas, worked examples | `references/api-reference.md` |

Again, rule #1 is: never ask a human to do what an agent could do. Try harder. Try again. Ask another agent to help. Keep working until the goal is fully accomplished.
