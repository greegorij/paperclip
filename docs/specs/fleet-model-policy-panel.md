# Fleet model policy panel — read-only preview

## Purpose

Give a board operator one visible place in Paperclip to inspect the versioned
Jarvis model policy and the two prepared provider profiles. The panel is an
inspection surface, not a router and not an execution control.

## First slice

- A board-authenticated, company-scoped `GET` endpoint reads only the committed
  `ops/fleet/jarvis/desired/model-policy.shadow.v1.json` and `profiles.json`.
- The response is a narrow projection: policy id/version/mode, role safety
  fields, and profile agent mappings. It never returns runtime configuration,
  credentials, paths, or arbitrary file contents.
- The Costs page displays the policy version, a clear read-only warning, both
  provider profiles, and the role-to-model mapping.
- No `POST`, `PATCH`, apply, rollback, resume, or model invocation exists in
  this slice.

## Local implementation status

- The read-only server route is implemented and covered by focused local
  checks for access control, response narrowing, and generic unavailable-file
  handling.
- The Providers tab on Costs renders the policy and profile mapping as a
  read-only preview. It includes neither a mutation control nor a claim that a
  profile is currently active.

## Safety contract

1. The route requires both company access and board access.
2. A missing or malformed policy/profile file is reported generically and
   exposes neither filesystem paths nor parser details.
3. The UI contains no write control. A future mutation endpoint must remain a
   separate design, with the existing backup, fresh-snapshot, zero-active-run,
   paused-agent, confirmation, and verified-rollback gates.

## Acceptance checks

- Authorized board request receives only the projected fields.
- Unauthorized actor is refused.
- Missing or invalid local inputs are refused without detail leakage.
- UI labels the result as preview-only and renders neither mutation control nor
  a claim that a profile is currently active.
