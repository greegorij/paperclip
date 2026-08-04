# Watchdog recovery after a resolved execution block

## Problem

A task watchdog is a generated child task. If its own run is stopped while its
agent is temporarily unavailable (for example because a budget hard-stop has
paused that agent), it can remain `blocked` after the pause has been removed.
The watched parent is then held by a watchdog that has no unresolved issue
blocker and no active run.

## Intended behaviour

The scheduler may return a generated watchdog from this specific stale state to
`todo` only when all of the following are true:

1. it is a task-watchdog issue;
2. it has no unresolved explicit issue blockers or active execution path;
3. its assigned watchdog agent is currently invokable; and
4. the watched subtree still has the same stopped fingerprint.

The normal scheduler then creates one idempotent wake. It must not reopen
ordinary user tasks, watchdogs with a real blocker, or terminal/review states.
If the next watchdog run fails, existing bounded recovery policy remains in
charge; this change must not create retry loops.

## Verification

- focused service tests for the eligible and ineligible states;
- existing task-watchdog scheduler tests;
- typecheck and diff hygiene.
