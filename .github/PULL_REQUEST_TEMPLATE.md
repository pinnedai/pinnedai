<!--
This template doubles as a Pinned-format prompt. Claims in the
"Claims" section get auto-pinned by the `pinned` workflow once this
PR opens. See https://pinnedai.dev for the supported claim shapes.
-->

## Summary

<!-- 1-2 sentences. What changes, why? -->

## Claims

<!--
List behavioral promises this PR makes. Each line below will be pinned
as a permanent CI test if it matches one of the 8 supported templates.

Examples (delete the ones that don't apply, add your own):

- Rate-limits /api/users to 60 req/min.
- Auth required on /api/admin/export.
- Makes /webhooks/stripe idempotent on event_id.
- `pinned doctor` outputs `tests/pinned/ directory`.
- `pinned init` exits 0.
- `pinned init` creates `tests/pinned/.registry.json`.
- `pinned check` supports `--json` flag.
- `parseConfig()` in `src/config.ts` returns `{"version": 1}`.
-->

## Test plan

<!-- How you verified this works. -->

- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm dogfood:pins` (if CLI or template behavior changed)

## Risk

<!-- Anything reviewers should look at carefully. -->
