# Contributing to pinnedai

Thanks for considering a contribution. pinnedai is built solo with AI tooling, so the bar for changes is:

1. **Read [CLAUDE.md](./CLAUDE.md)** — it has the architectural pillars, locked decisions, and what's explicitly out of scope.
2. **Match the existing style**: terse comments, descriptive identifiers, no over-abstraction. We prefer "three similar lines" over a premature helper.
3. **Tests are required** for new templates, parser changes, and CLI commands. Aim for one POSITIVE CONTROL test per behavior (an input known to produce a specific signal) plus edge cases.

## Local dev

```bash
pnpm install
pnpm --filter pinnedai build
pnpm --filter pinnedai test
pnpm dogfood:pins   # runs pinnedai's own pins
```

The workspace has three apps:

- **`apps/cli/`** — the `pinnedai` npm package (binary: `pinned`). Apache 2.0, public.
- **`apps/edge/`** — the Cloudflare Worker (hosted LLM extraction). Closed source.
- **`apps/landing/`** — the [pinnedai.dev](https://pinnedai.dev) marketing site. Vite + React.

The CLI and landing are mirrored to a public repo via `scripts/sync-public.sh`. The Worker is intentionally not mirrored.

## Adding a new template

Each template is ~5 files:

1. **Claim type** in `apps/cli/src/claimParser.ts` (e.g. `MyTemplateClaim`)
2. **Regex** in the same file, with a unique key in `claimKey()` and slug logic in `claimSlug()`
3. **Generator** at `apps/cli/src/templates/myTemplate.ts` — emits a Vitest file string
4. **Dispatcher entry** in `apps/cli/src/index.ts` — add to the `generateTest()` switch
5. **Tests** in `claimParser.test.ts` + `templates.test.ts` — at least one POSITIVE CONTROL + edge cases (escape safety, malformed input rejection)

Then update:
- `apps/cli/src/registry.ts` → `claimLabel()` for PINS.md rendering
- `apps/cli/src/cli.ts` → `describeClaim()` for `pinned check` output
- `examples/<template>/pr-description.md` + `generated.test.ts` + `why.md`
- The README's templates table
- The landing-page demo's `ClaimChip` if you want the chip styling

See `apps/cli/src/templates/cliOutputContains.ts` for a fully-worked example.

## Pull request workflow

1. Open a PR with a description that itself contains pinnable claims. The Action will generate test files for them. Yes, we dogfood.
2. CI must pass: typecheck + tests + dogfood pins.
3. Reviewer responds with `✓` or specific feedback. Be patient — solo founder.

If the change touches the Worker (`apps/edge/`), the public mirror will not include it. The Worker stays closed-source; we still review your PR but the patch lands in the private monorepo.

## What we won't accept

- Features outside the [CLAUDE.md "What we are NOT" list](./CLAUDE.md)
- LLM-writes-test logic (constrained templates only — see Architecture Pillar 1)
- New API endpoints on the Worker without a corresponding cost model
- Pricing-table changes without a strategic conversation

## License

By contributing, you agree that your contributions to `apps/cli/` and `apps/landing/` are licensed under Apache 2.0. The closed-source Worker is not accepting external contributions yet.
