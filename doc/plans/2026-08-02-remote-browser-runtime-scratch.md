# Remote browser runtime scratch

## Problem

The heartbeat runner creates `XDG_RUNTIME_DIR` on the Paperclip host only. A
remote sandbox receives that host path as an environment variable, but not the
directory itself. Browser-capability checks therefore stop before useful work.

## Scope

### Slice 1 — correct remote execution

Create the browser runtime directory in the execution target that consumes it,
or omit the host-only runtime variable when that target cannot materialize it.
The adapter must never receive an `XDG_RUNTIME_DIR` that is unavailable in its
own filesystem.

Add a regression test using the same remote execution seam as the sandbox
adapter. It must prove the target process can stat the directory and that two
commands in one heartbeat keep the same browser session.

### Slice 2 — safe operator visibility

When runtime materialization cannot be proven, fail before dispatch with a
plain, actionable environment error. The failure must produce a visible
recovery path rather than leaving the source issue silently blocked.

## Risks and rollback

Remote environment implementations differ: SSH and confined sandboxes must not
receive host paths. The change stays behind existing execution-target types and
is verified first against the sandbox transport. Rollback is a normal revert of
this branch; no database migration or fleet configuration is included.

## Verification

1. Focused unit tests for run scratch creation and environment projection.
2. Focused remote/sandbox execution test that checks directory existence in the
   target process.
3. Typecheck for the touched packages.
4. A single controlled Frappe retry only after the code is reviewed and
   published through the normal release path.

## Local implementation status

The target-local runtime directory, its `0700` permission, and the fail-closed
path were implemented and verified with focused adapter, scratch, and
environment tests. This remains a local candidate until review, normal
publication, and one controlled Frappe retry confirm the real sandbox path.
