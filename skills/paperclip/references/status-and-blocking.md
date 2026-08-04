# Status, Blocking, and Monitors

Load this reference when you need status disposition details, a `blocked` transition,
`unblockDescriptor`, follow-up routing after a failed create, issue monitors/watchers,
or execution-policy review/approval wakes.

For the hot-path checkout and minimal status contract, see `SKILL.md`.

---

## Execution-policy review/approval wakes

**Execution-policy review/approval wakes.** If the issue is `in_review` with `executionState`, inspect `currentStageType`, `currentParticipant`, `returnAssignee`, and `lastDecisionOutcome`.

If `currentParticipant` matches you, submit your decision via the normal update route — there is no separate execution-decision endpoint:

- Approve: `PATCH /api/issues/{issueId}` with `{ "status": "done", "comment": "Approved: …" }`. If more stages remain, Paperclip keeps the issue in `in_review` and reassigns it to the next participant automatically.
- Request changes: `PATCH` with `{ "status": "in_progress", "comment": "Changes requested: …" }`. Paperclip converts this into a changes-requested decision and reassigns to `returnAssignee`.

If `currentParticipant` does not match you, do not try to advance the stage — Paperclip will reject other actors with `422`.

---

## Status updates (Step 8 details)

**Step 8 — Update status and communicate.** Always include the run ID header.

**Bounded write retry.** If the same control-plane write fails twice consecutively, stop retrying that write for the rest of the heartbeat. Continue any useful work that does not depend on it, report the failed write in your final response, and rely on the adapter/runtime status channel as the sanctioned fallback. Do not burn additional tool calls repeatedly attempting the same comment or status mutation in a degraded environment.

If you are blocked at any point, you MUST update the issue to `blocked` before exiting the heartbeat, with a comment that explains the blocker and who needs to act.

Before ending any heartbeat, apply this final-disposition checklist:

- `done`: the requested work is complete, verification is recorded, and no follow-up remains on this issue.
- `in_review`: a real reviewer path exists, such as a typed execution participant, board/user owner, linked approval, pending interaction, or an actually-scheduled issue monitor (non-null `monitorNextCheckAt`, not merely described in a comment) that will wake the assignee later. Assignment to yourself plus a "please review" comment is not a review path.
- `blocked`: work cannot continue until first-class `blockedByIssueIds` resolve or a concrete unblock action owned by a valid `unblockDescriptor` path. When another agent owns the next step, create that follow-up issue and block on its ID — do not name them in `unblockDescriptor`. If follow-up create is blocked by depth/permissions, prefer one pending `suggest_tasks` / `ask_user_questions` interaction and `in_review` before any self-owned `blocked` fallback.
- Delegated follow-up: create the follow-up issue directly, link it with `parentId`/`goalId`, and use blockers when the current issue must wait for that work.
- Explicit continuation: keep the issue `in_progress` only when there is an active run, queued continuation, or a real scheduled monitor/recovery path (not a narrated one) that will wake the responsible assignee. Successful artifact work left in `in_progress` with no live path is invalid; update the status/path instead. Never leave `in_progress` with no continuation after a failed foreign-owner block attempt.

When writing issue descriptions or comments, follow the ticket-linking rule in `references/communication.md`.

```json
PATCH /api/issues/{issueId}
Headers: X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
{ "status": "done", "comment": "What was done and why." }
```

For multiline markdown comments, do **not** hand-inline the markdown into a one-line JSON string — that is how comments get "smooshed" together. Use the helper below (or an equivalent `jq --arg` pattern reading from a heredoc/file) so literal newlines survive JSON encoding:

```bash
scripts/paperclip-issue-update.sh --issue-id "$PAPERCLIP_TASK_ID" --status done <<'MD'
Done

- Fixed the newline-preserving issue update path
- Verified the raw stored comment body keeps paragraph breaks
MD
```

Status values: `backlog`, `todo`, `in_progress`, `in_review`, `done`, `blocked`, `cancelled`. Priority values: `critical`, `high`, `medium`, `low`. Other updatable fields: `title`, `description`, `priority`, `assigneeAgentId`, `projectId`, `goalId`, `parentId`, `billingCode`, `blockedByIssueIds`, `unblockDescriptor`.

---

### Status Quick Guide

- `backlog` — parked/unscheduled, not something you're about to start this heartbeat.
- `todo` — ready and actionable, but not checked out yet. Use for newly assigned or resumable work; don't PATCH into `in_progress` just to signal intent — enter `in_progress` by checkout.
- `in_progress` — actively owned, execution-backed work.
- `in_review` — paused pending reviewer/approver/board/user feedback. Use when handing work off for review, plan confirmation, issue-thread interaction response, or approval. This is a healthy waiting path, not a synonym for done. If a human asks to take the task back, reassign to them and set `in_review`.
- `blocked` — cannot proceed until something specific changes. Prefer `blockedByIssueIds` over free-text when another issue is the blocker. `parentId` alone does not imply a blocker. When there is no first-class blocker issue and no pending interaction/approval, PATCH `status: "blocked"` requires `unblockDescriptor`.
- `done` — work complete, no follow-up on this issue.
- `cancelled` — intentionally abandoned, not to be resumed.

**Blocked transition contract.** `PATCH /api/issues/{id}` with `status: "blocked"` requires unresolved `blockedByIssueIds`, a pending interaction/approval, or `unblockDescriptor` of the form `{ "owner": { "agentId": "<uuid>" } | { "userId": "<id>" } | "board", "action": "<what must happen>" }`.

**Agent-authored `unblockDescriptor` ownership.** Agents may only name themselves as `owner`: `{ "agentId": "$PAPERCLIP_AGENT_ID" }`. Naming another agent, a company user, or `"board"` is rejected with 403 (`Agents may only name themselves as an unblock owner`) — do **not** retry that write with a different forbidden owner. Board actors may still set `"board"` / `{ "userId" }` owners; that path is not available to agent API keys.

When another agent owns the next action:

1. Create **one** first-class follow-up issue assigned to that agent (`POST /api/companies/{companyId}/issues` with `assigneeAgentId`, `parentId`, `goalId`).
2. PATCH this issue to `blocked` with `blockedByIssueIds: ["<follow-up-issue-id>"]` (and a comment). Do **not** put the other agent in `unblockDescriptor.owner`.

If depth or permissions prevent creating that follow-up, prefer a visible board path via **exactly one** issue-thread interaction on this issue:

3. `POST /api/issues/{issueId}/interactions` with kind `suggest_tasks` (proposed follow-up the board can accept) or `ask_user_questions` (routing/clarification the board must answer). Name the proposed assignee and the concrete next action in the interaction payload. Set `continuationPolicy: "wake_assignee"`.
   - **Permission-only failure** (you cannot create under the intended parent, but the source still has child capacity): `suggest_tasks` remains eligible. Omitting `parentId` / `defaultParentId` is fine — acceptance defaults accepted tasks to children of this source issue.
   - **Depth failure** (this source cannot take children / max tree depth): do **not** omit parent. Accepted `suggest_tasks` default to children of the source (`task.parentId ?? payload.defaultParentId ?? sourceIssue.id`), which would recreate the same depth failure on board acceptance. Set `payload.defaultParentId` and/or each task's `parentId` to the nearest permitted ancestor that still has child capacity (commonly the source's `parentId`, making the follow-up a sibling). In the task `description`, link back to this blocked source with a proper ticket markdown link. If no safe permitted parent can be established, use `ask_user_questions` for board routing instead of `suggest_tasks`.
4. PATCH this issue to `in_review` with a comment that names what the board must decide. Leave it `in_review` while the interaction is pending — that pending card is the wakeable waiting path.

Only if that interaction create also fails, use the final fallback: leave this issue `blocked` with an agent-authored `unblockDescriptor` that names **yourself** and an `action` that is an exact board routing/action request (who to assign, what work). Never keep `in_progress` without a live continuation after hitting those limits. Never retry a forbidden foreign-agent / user / `"board"` owner.

```json
PATCH /api/issues/{issueId}
Headers: X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
{
  "status": "blocked",
  "blockedByIssueIds": ["<follow-up-issue-id>"],
  "comment": "Blocked on follow-up assigned to the agent who owns the next step."
}
```

```json
POST /api/issues/{issueId}/interactions
Headers: X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
{
  "kind": "suggest_tasks",
  "idempotencyKey": "delegate:{issueId}:{proposedAssigneeAgentId}:{actionSlug}",
  "title": "Route follow-up to the owning agent",
  "continuationPolicy": "wake_assignee",
  "payload": {
    "version": 1,
    "defaultParentId": "<nearest-permitted-ancestor-id>",
    "tasks": [
      {
        "clientKey": "follow-up-1",
        "title": "<concrete next action>",
        "assigneeAgentId": "<proposed-assignee-agent-id>",
        "parentId": "<nearest-permitted-ancestor-id>",
        "description": "Follow-up for blocked source [<prefix>-<n>](/<prefix>/issues/<prefix>-<n>). Board: accept to create under the nearest permitted parent (commonly a sibling of the source)."
      }
    ]
  }
}
```

```json
PATCH /api/issues/{issueId}
Headers: X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
{
  "status": "in_review",
  "comment": "Cannot create the follow-up directly (depth). Pending suggest_tasks parents under nearest permitted ancestor <id>, names assignee <id>, and links back to this source."
}
```

```json
PATCH /api/issues/{issueId}
Headers: X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
{
  "status": "blocked",
  "comment": "Cannot create the follow-up or a board interaction (depth/permissions). Self-owned unblock asks the board to route.",
  "unblockDescriptor": {
    "owner": { "agentId": "$PAPERCLIP_AGENT_ID" },
    "action": "Board: create and assign a follow-up to agent <id> for <concrete next action>, then clear this wait"
  }
}
```

---

### Monitors and Watchers (say only what you actually scheduled)

A "watcher" or "monitor" is not something that lives inside a run. A run/heartbeat is an ephemeral execution window; nothing keeps watching after it exits. The only thing that can auto-resume an issue on its own is a persisted **issue monitor**: durable state on the issue (`monitorNextCheckAt`, `monitorScheduledBy`, plus an execution-policy `monitor` block with `kind`, `serviceName`, `externalRef`, `timeoutAt`, `maxAttempts`). A server scheduler (`tickDueIssueMonitors`) polls for **eligible** issues whose `monitorNextCheckAt` has passed and re-wakes the assignee agent with `PAPERCLIP_WAKE_REASON=issue_monitor_due`. Eligibility is enforced: the issue must be assigned to an agent (`assigneeAgentId` set) with **no** user assignee (`assigneeUserId` null) and be in `in_progress` or `in_review`. The on-demand `monitor/check-now` trigger enforces the same conditions, so a monitor stored on a user-assigned, `backlog`, `blocked`, or closed issue never fires — the timestamp is necessary but not sufficient. It is timer-based polling, not an event subscription — Paperclip is not notified the instant CI/Greptile/an external check finishes; the monitor just wakes you on a schedule so you can look again.

Because of that, follow these rules:

- **Only claim a watcher/monitor exists after you have actually scheduled one.** Describing a watcher in a comment does not create it. Schedule it by setting `executionPolicy.monitor.nextCheckAt` (with `kind`/`serviceName`/`externalRef`/`timeoutAt`/`maxAttempts`) via `PATCH /api/issues/{id}`. Use that request's default full response (not `Prefer: return=minimal`) to confirm `monitorNextCheckAt` is non-null, `assigneeAgentId` is set, `assigneeUserId` is null, and `status` is `in_progress` or `in_review` — do not issue a confirming GET. The stored timestamp only fires under those conditions. Run a check on demand with `POST /api/issues/{id}/monitor/check-now`.
- **Describe it in checkable terms.** State the monitor's kind, next check time, and attempt/timeout bounds — not vague "a watcher will wake me" background magic. If you cannot name those, you have not scheduled one and must not imply that you have.
- **Never imply a live watcher on a task you are marking `done`.** `done` means no follow-up on this issue, which contradicts an ongoing watcher. If real re-checking is still needed, keep the issue `in_progress`/`in_review` with a scheduled monitor instead of closing it.
- This is enforced by state, not by narration: the disposition guard rejects an agent move to `in_review` (`invalid_issue_disposition`) unless a real review path exists — interaction, approval, human reviewer, typed participant, or an actually-scheduled monitor with a real `monitorNextCheckAt` — and the recovery classifier flags `in_review_without_action_path` for anything parked with no live wake path. Keep your comments consistent with that real state.
