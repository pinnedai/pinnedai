# AGENT.md — pinnedai rules for AI coding agents

> This file is maintained by [pinnedai](https://pinnedai.dev). It tells
> AI agents (Claude Code, Cursor, Aider, etc.) when and how to use
> Pinned in this repo.
>
> Reference this file from your CLAUDE.md / .cursorrules / AGENTS.md:
>
>     See tests/pinned/AGENT.md for AI-agent rules.

## Rules for the AI agent working in this repo

### Before marking a task complete

1. Run the relevant test suite (`pnpm test`, `npm test`, etc.).
2. Run `npm run pinned:test` (or `npx pinnedai test` if no script
   exists).
3. If any test in `tests/pinned/*.test.ts` fails, **do not skip or
   delete it**. It fails because a PR description from the past
   claimed something that you've now regressed. Fix the regression,
   then re-run.

### When you add code that makes a verifiable claim

Examples of claims worth pinning:

- A new route requires authentication
- A new route is rate-limited
- A webhook handler is idempotent
- A CLI command outputs a specific string / exits 0 / creates a file
- A library function returns a specific value

If you add any of these to this repo:

1. Add a one-line claim to the PR description in the exact phrasing
   Pinned recognizes:

       - Auth required on /api/admin/export.
       - Rate-limits /api/users to 60 req/min.
       - Makes /webhooks/stripe idempotent on event_id.
       - `pinned doctor` outputs `All checks passed`.
       - `parseConfig()` in `src/config.ts` returns `{"version": 1}`.

2. Pinned's GitHub Action will pick it up automatically and generate a
   test file in `tests/pinned/`.

### When you encounter a failing pin test

The error message includes a paste-ready repair prompt. Use it
verbatim — do not invent a different fix. Pinned tells you exactly
what claim was broken, what was expected, what was actual, and where
to look.

If the claim is genuinely no longer applicable (e.g. endpoint
deprecated, intentional behavior change), run:

    npx pinnedai retire <claim-id> --reason="why this no longer applies"

Do not just delete the test file — that loses the audit trail.

### Never modify these

- `tests/pinned/*.test.ts` (generated test files — change only via
  `pinned generate` or `pinned retire`)
- `tests/pinned/PINS.md` (auto-rendered from `.registry.json`)
- `tests/pinned/.registry.json` (managed by pinnedai)

If you think one of these needs to change, run the pinnedai command,
don't hand-edit.

## Quick reference

| Command | What it does |
| --- | --- |
| `npx pinnedai check --description "..."` | Parse a PR description for claims |
| `npx pinnedai scan` | Scan the current diff for risk surfaces |
| `npx pinnedai baseline` | Find risky promises in the current repo |
| `npx pinnedai generate --pr-id pr-N --description "..."` | Write pin files |
| `npx pinnedai list` | Show all pinned claims |
| `npx pinnedai retire <id> --reason="..."` | Move a pin to retired |
| `npx pinnedai doctor` | Diagnose setup issues |
