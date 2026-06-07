# Changelog

All notable changes to pinnedai. Follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This file tracks the `pinnedai` npm package version; the Cloudflare Worker tracks its own version independently in `apps/edge/`.

## [0.4.2] — 2026-06-07

The 0.4.1 PostToolUse auto-install shipped wiring tests ("settings.json has the entry") instead of behavior tests ("hook actually fires on an edit"). Cipherwake caught it in the field: the hook was installed correctly but produced NOTHING on every edit because blast-radius didn't connect literal routes / template routes to their dynamic page files. Three P0 fixes.

### Fixed (P0) — `blast-radius` didn't resolve dynamic routes to page files

Repro on real Next.js App Router app:
```
$ pinned blast-radius "app/preview/[slug]/page.tsx"           → No smoke pins affected
$ pinned blast-radius components/IdeaLanding.tsx Hero.tsx     → No smoke pins affected
$ pinned blast-radius lib/ideas.ts                            → No smoke pins affected
```

Cause: smoke pin entrypoints are literal routes (`/preview/benchmob`); render-collection / visibility-invariant are templates (`/preview/[slug]`); but the source file is the dynamic `app/preview/[slug]/page.tsx`. `filesForSmokeClaim` had a comment that literally said *"http-route: no file (the route is a runtime address, not a static file we can name from the claim alone)"* — and that's the bug. I wrote it off as out of scope.

Fix: new `deriveLikelyPageFilesForRoute(route, repoRoot)` walks route segments and at each level accepts an exact-name directory OR a dynamic `[param]` / `[...slug]` / `[[...slug]]` directory OR a transparent `(group)` route group. Supports:
- Next.js App Router (`app/...` and `src/app/...`)
- Next.js Pages Router (`pages/preview/[slug].tsx` filename style AND directory style)
- SvelteKit (`src/routes/.../+page.svelte`)
- Astro (`src/pages/.../index.astro`)
- API routes (`app/.../route.ts`)

Then the transitive importer walk (already in blast-radius) covers components + data modules.

### Fixed (P0) — `hook-postedit` silent no-op was indistinguishable from success

When blast-radius returned empty, hook-postedit silently exited → no output → Claude couldn't tell "verified, all good" from "did nothing." Multiple silent-exit paths (`if (editedFiles.size === 0) return;`, `if (!existsSync(pinnedDir)) return;`, etc.) all return-with-nothing.

Fix: every silent-exit now emits a distinguishable single-line message. The "0 pins covered" case now reads `pinned: 0 pins cover the edited file(s): <files>. (Use \`pinned blast-radius <file>\` to debug coverage)` so the user can act on it.

Also: the hook now uses `buildSmokePinIndex` + `affectedSmokePins` (the same pipeline `pinned blast-radius` uses) instead of its own ad-hoc route-equality matching that had the same dynamic-route gap. One source of truth for "edit → affected pins."

### Added (P0) — behavior test, not wiring test

The 0.4.1 acceptance was "settings.json gets the PostToolUse entry." That's WIRING. The required acceptance per the field report: spin up a fresh repo, install the pin, programmatically edit a file, fire `hook-postedit`, assert the hook emits a NON-EMPTY result.

Two new vitest matrices:
- `blastRadius.dynamic-route.test.ts` — 15 tests against Next App Router / Pages Router / SvelteKit / Astro routing conventions + the full Cipherwake repro (page / component / data-module / unrelated-file all flag the right pins).
- `hookPostedit.e2e.test.ts` — 5 tests that programmatically edit a file, pipe a real PostToolUse payload to `node dist/cli.js hook-postedit`, and assert the output is non-empty and names the affected pin(s). Negative case: unrelated edit emits the "0 pins covered" diagnostic, not silent.

These match the field report's exact acceptance: "ASSERT the hook emits a NON-EMPTY result naming the pin and its pass/fail outcome."

### Tested

- 437/437 vitest (was 417; +20 new across dynamic-route + hook E2E)
- Cipherwake's exact command `blast-radius app/preview/[slug]/page.tsx` now lists both pins
- 42/42 dyad sweep across 6 repos × 7 new-command invocations — no regressions

---

## [0.4.1] — 2026-06-07

Bug-pack release. Two P0 fixes that made 0.4.0's `render-collection` pin unusable on Next.js App Router, plus closing the "automatic verification on opt-in" gap Cipherwake flagged in the field.

### Fixed (P0) — `render-collection` false-positives `notFound()` on EVERY healthy 200 page

Cipherwake dogfood on a Next.js 15 App Router repo: 9 routes all returned real HTTP 200 with full content, but the pin reported 9/9 failed with `notFound() shape detected (prerendered but resolver 404s)`.

Cause: the `__pinnedHasNotFoundShape` heuristic used body-substring markers (`"This page could not be found"`, `"Page Not Found"`, `"404 -"`). Next.js App Router embeds the not-found boundary as part of every page's streamed RSC payload — so a healthy 200 page also contains those substrings (from the not-found component that exists in the tree but isn't shown).

Fix: trust the actual HTTP status. `notFound()` returns 404 in both routers. The body markers are removed entirely. Matches what `visibility-invariant` already does (it checks real HTTP status, never trusts body content). As shipped in 0.4.0, this pin red-flagged a perfectly healthy multi-tenant app on every route — a 100% false-positive that would block CI.

### Fixed (P0) — `--from=generate-static-params` threw "React is not defined" on JSX pages

`pinned render add --from generate-static-params --module app/preview/[slug]/page.tsx` generated a pin whose runtime tried to dynamic-import the page module to call `generateStaticParams()`. App Router pages transitively import JSX/React components, and in the vitest enumeration context React isn't in scope → `route enumeration failed: React is not defined`. Any page that imports components broke this source — essentially all App Router pages.

Fix: detect JSX / `from "react"` / relative component imports at `pinned render add` time and fail fast with the exact alternative command. Until AST-based extraction lands, the supported path is `--from=collection-getter` against a plain-TS module exporting the slug source. The error message includes the exact substitute command, copy-paste ready.

### Added — `pinned init --auto` now installs the Claude PostToolUse auto-verify hook by default

Per Cipherwake's field observation: opting into Pinned should mean opting into AUTOMATIC verification, not just passive rules. Before: `install-claude-hook` was a separate opt-in command that `pinned init` never ran, so vibe-coders got zero automatic verification. After: auto mode bundles it; manual mode asks with one consent line.

When the hook fires after an edit and no dev server is detected, it emits one loud line (already shipped) — never silent. Run `pinned dev` in another terminal to give it a server to verify against.

### Tested

- 417/417 vitest
- Bug 2 acceptance test: stub returns 200 + embedded not-found markers → pin now PASSES (was 100% FP)
- Bug 1 acceptance test: JSX page → fails fast with the exact alternative command; non-JSX module → generates the pin normally (negative case preserved)
- `pinned init --auto` E2E: PostToolUse hook installed in `.claude/settings.json` alongside the existing statusline + UserPromptSubmit failure-hook
- 42/42 dyad sweep across 6 repos × 7 new-command invocations — no regressions

### Known follow-ups

- AST extraction of just `generateStaticParams` from a JSX module — replaces the manual `--from=collection-getter` workaround.
- Non-Claude fallback for the auto-verify hook (Cursor / Copilot / Windsurf). Today, `git pre-push` + `pinned watch` exist but don't run vitest. Tracked as part of the Gap 6 work.
- Self-check after `install-claude-hook` — run one affected pin and confirm it EXECUTED (not skipped) before declaring install complete.

---

## [0.4.0] — 2026-06-06

The Cipherwake-dogfood release. Five gaps caught during a real socialideagen session where Pinned ran zero tests locally AND in CI, and the one real regression (stub-404 / prerender divergence) was caught by manual review, not a pin. Each gap below is closed with the exact acceptance test from the field report.

### Gap 3b — Zero-config base URL resolution

`apps/cli/src/baseUrl.ts` + inlined into every smoke / render-collection / visibility-invariant template. Resolution chain:

1. Explicit overrides: `PINNED_SMOKE_BASE_URL` / `PINNED_BASE_URL` / `PREVIEW_URL` / `PINNED_CI_BASE_URL`
2. CI auto-detect (zero config): Vercel (`VERCEL_BRANCH_URL` > `VERCEL_URL` > `VERCEL_PROJECT_PRODUCTION_URL`), Netlify (`DEPLOY_PRIME_URL` > `URL` when `NETLIFY=true`), Cloudflare Pages (`CF_PAGES_URL`), Render (`RENDER_EXTERNAL_URL`)
3. Last-known-good cache `.pinned/base-url.json` (written by `pinned dev`)
4. Author-declared `defaultBaseUrl`

When nothing resolves: ONE loud single-line message (`pinned: no base URL (not on a known CI provider, no local server). Run \`pinned dev\` or set PINNED_BASE_URL.`). Never silent `20 skipped` — that's the actual trap. 18 new tests.

### Gap 1 — `render-collection` pin (the highest-value asked-for feature)

Pin shape that enumerates routes at run time and renders each. Single-slug pins gave ~zero coverage on multi-tenant / template-per-row apps; this pin's coverage scales with the collection automatically.

Three enumeration sources:
- `generate-static-params` — dynamic import + call `generateStaticParams()`. This alone catches the prerender/resolver divergence (prerendered set vs resolvable set must match).
- `collection-getter` — dynamic import a module + named export returning `[{ slug, ... }]`.
- `sitemap` — GET `/sitemap.xml`, extract `<loc>`s under a path prefix.

Per-slug failure reporting (names which specific slug failed, not "preview broke"). Deterministic hash-sort + cap at N (default 20) with a "covered N/M, sampled" line — no silent truncation.

CLI: `pinned render add --path '/preview/[slug]' --from collection-getter --module lib/ideas.ts --export getAllIdeas`. Adding a new item to the collection covers it automatically — no pin edit. That's the whole point.

Acceptance test passes: bug-shape (generateStaticParams returns drafts) fails naming the draft slugs; fixed-shape (filters drafts) passes.

### Gap 3 — `pinned dev` (the local-loop closer)

Three-part fix to the real problem: pins skip because cadence=on-demand needs `SMOKE_RUN=1`, AND the generated workflow doesn't set it.

(A) **Generated `pinned.yml` now sets `SMOKE_RUN=1`, `PINNED_SMOKE=1`, `PINNED_ALLOW_PRODUCTION_URL=1`, and `PINNED_SMOKE_BASE_URL` from `${{ env.VERCEL_BRANCH_URL || env.VERCEL_URL || env.DEPLOY_PRIME_URL || '' }}`.** Plus verifies execution after vitest exits: if 0 pins executed despite the env being set, the workflow step FAILS with a loud GitHub Actions error annotation. Auto-opt-in that silently still skips is the same trap as not opting in.

(B) **New `pinned dev` command.** Detects framework (Next/Vite/Astro/SvelteKit/Remix/Nuxt), reads `package.json#scripts.dev`, picks an unused port (prefers framework default), spawns the dev server, polls until ready (60s default), writes the URL to `.pinned/base-url.json`, runs vitest with `SMOKE_RUN=1` + `PINNED_SMOKE_BASE_URL=http://localhost:PORT`, tears down (SIGTERM→SIGKILL). After vitest exits, parses output and exits non-zero if 0 pins executed. Zero env vars needed by the user.

(C) Loud-skip messaging already shipped in Gap 3b.

### Gap 2 — Authed cookie support on smoke pins

Optional `auth: { cookie, valueFromEnv }` on `http-route` smoke entrypoints. The cookie VALUE comes from an env var at run time, never stored in the pin file. CLI: `pinned smoke add ... --auth-cookie admin --auth-env PINNED_ADMIN_COOKIE`.

Three runtime cases verified:
- Env var unset → SKIP-with-WARN (never RED, doesn't break unauthed CI)
- Right cookie → actually renders the authed page + asserts content
- Wrong cookie → FAIL (caught the bad auth)

### Gap 4 — `visibility-invariant` pin (the negative assertion render pins cannot provide)

The dual of Gap 1. Render pins prove "items that should work, work." They cannot prove "items that should be hidden, are hidden." The real shipped leak that motivated this: 9 draft idea slugs stayed publicly resolvable (200 + valid HTML) because `getAllIdeas()` filtered DB rows but not seed merge.

Pin reads the UNFILTERED collection (admin getter), splits items by a discriminant field, asserts:
- items where `field ∈ publicValues` → must render with one of `publicStatusAllowed` (default `[200]`)
- items NOT matching → must return one of `privateStatusAllowed` (default `[404, 307, 308]`)

CLI: `pinned visibility add --public-route '/preview/[slug]' --module lib/ideas.ts --export getAllIdeasAdmin --field status --public-values live`.

Acceptance: bug stub (serves all slugs at 200) FAILS naming each leaked draft. Fixed stub (drafts → 404) PASSES.

### Gap 5 — `pinned sync-rules` (inline lessons, never redirect)

The existing agent-rules block points at `tests/pinned/AGENT.md` and `.pinned/ai-lessons.md` — but a pointer is one hop, and one hop is what got skipped during the field session. Per Gap 5: "three lines of plainEnglish in the always-loaded file beats a pointer to a 50-line file."

`pinned sync-rules` reads `.pinned/lessons.json`, ranks by severity + past-mistakes count, and inlines the top-N (default 5) into a marker-bounded sub-block (`<!-- pinnedai:lessons:start -->`) within every agent-rules file that already has the pinnedai marker block. Files without it are listed (`run \`pinned ai-rules install\` first`) — never auto-created.

Idempotent: re-running replaces just the lessons sub-block, never duplicates. Line-budget capped at 25 (default) so the block stays cheap to ingest on every agent edit.

### Tested

- 417/417 vitest (was 392; +25 new tests across baseUrl, render-collection, visibility-invariant)
- Gap 1 acceptance test passes: render-collection on socialideagen-shape draft-404 repro fails on bug shape, passes on fix
- Gap 4 acceptance test passes: visibility-invariant fails naming each leaked slug on the leak stub, passes on the fix
- Gap 2 acceptance: 3/3 (no-env skips, right cookie passes + asserts content, wrong cookie fails)
- Gap 3 acceptance: `pinned dev` on a synthetic Next-shape repo: boots server, runs pin, verifies 1/1 executed, exits 0. All-skip case exits 1 with loud message.
- Gap 5 acceptance: lessons inlined into CLAUDE.md, AGENTS.md skipped (no marker), re-run is idempotent (no duplication)
- Prior matrices: 16/16 (0.3.1 bug-pack) + 14/14 (0.3.2 A+B+D) + 54/54 (dyad sweep) all intact

### Honest framing (preserved from the field report)

In the original socialideagen session that motivated this release, Pinned ran zero tests locally AND in CI, and the one real regression was caught by manual code review, not a pin. The render-collection pin (Gap 1) is the single change that turns that miss into a catch. As of 0.4.0, the auto-opt-in in `pinned init --auto` AND the generated workflow set `SMOKE_RUN=1` + a base URL by default AND verify execution — so the silent-skip trap is closed at every layer.

---

## [0.3.3] — 2026-06-05

Closes the schema-detector gap Cipherwake flagged in 0.3.2 — the static-analysis blind spot that let "POST → 500 on missing relation" bugs slip past the detector.

### Fixed — `detectSupabaseColumnExists` now catches missing tables, not just missing columns

The 0.3.2 detector checked that every column referenced via `.from("X").select / .eq / .update / .insert` existed in the declared schema — but if the TABLE itself wasn't declared, the detector silently skipped (`if (!declared) continue;`). Code that did `.from("feedback").insert({...})` with no `CREATE TABLE feedback` in any migration produced zero hits, so the runtime 500 on first POST went uncaught.

Now: when code performs a WRITE against an undeclared table (insert / update / upsert / delete), the detector emits a hit with `declaredColumns: []` and a clear "Runtime 500 — the relation does not exist" message.

### Precision gates (high-confidence only)

- **Writes only.** SELECT against an undeclared table is too ambiguous — could be a Postgres view, an RPC call, an `auth.*` / `storage.*` schema alias, or a foreign schema. INSERT / UPDATE / UPSERT / DELETE on an undeclared table is "definitely intended to hit this table" → fires.
- **Skip Supabase built-ins.** `auth.users`, `storage.objects`, `realtime.messages`, etc. — when code does `.from("users").update(...)` and `public.users` isn't declared, that's usually `auth.users`, not a missing table. Skipped via a known-builtin list.
- **Requires at least one schema source.** A repo with NO `supabase/migrations/*.sql` AND NO `database.types.ts` provides no ground truth — the detector returns empty. No schema = no signal.

### Closes the wedge thesis

Per the build plan's positioning, the static-detector layer catches "definitely-broken code at the moment it's written" without execution. The smoke-pin layer (0.3.0) catches "feature can't actually work" bugs by executing the endpoint. The table-missing case sits in between — static detection IS sufficient (we have ground truth from migrations) but was structurally skipped. This release closes that gap, leaving smoke pins to handle the genuinely-needs-execution cases.

### Tested

- 399/399 vitest (was 392; +7 new schema-gap tests)
- 7/7 schema-gap matrix: positive INSERT, positive DELETE, plus 4 negative cases (declared table, SELECT-only, Supabase built-in, no schema sources), plus multi-write aggregation
- 16/16 prior 0.3.1 bug-pack matrix still passes
- 14/14 prior 0.3.2 A+B+D matrix still passes
- 54/54 dyad-apps FP sweep clean

---

## [0.3.2] — 2026-06-05

Four more Cipherwake-dogfood findings. Three sharpenings + one architectural decouple.

### Fixed — Supabase ANON keys + publishable keys quiet; NEXT_PUBLIC_*SERVICE_ROLE = CRITICAL (inverted)

The "NEXT_PUBLIC_* with KEY-shaped name" heuristic FP-flagged `NEXT_PUBLIC_SUPABASE_ANON_KEY` (designed to be public — the literal token ANON in the name says "not secret"). Rather than just silence it, we **inverted** the check: explicit publishable signals (`*ANON*`, `*PUBLISHABLE*`, `*SITE_KEY*`, `*CLIENT_KEY*`, `*APP_ID*`, `*PUBLIC_KEY*`) now quiet correctly, AND a new `next-public-secret-exposed` rule fires at **block severity** when a NEXT_PUBLIC_* env explicitly signals a secret (`*SERVICE_ROLE*`, `*SECRET*`, `*PRIVATE*`, `*ROOT_KEY*`, `*MASTER_KEY*`, `*ADMIN_KEY*`, Stripe sk_test_/sk_live_).

`NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY` is the load-bearing case — it hands the whole DB (RLS-bypassing) to every visitor, a catastrophic + frequent AI mistake. Catching it at block severity flips an FP into a high-value detector.

Regex fix on the way: `\bANON\b` doesn't form a boundary between `_` chars in JS regex (`NEXT_PUBLIC_*_ANON_KEY` wouldn't match), so we use explicit `(?:^|_)TOKEN(?:_|$)` anchors throughout.

### Fixed — Lint-suppression noise (tiered DANGEROUS vs commonly-legit)

`pinned safety` was flagging every `eslint-disable-next-line` at the same severity, burying the dangerous ones. Now tiered:

- **DANGEROUS (warn):** `@ts-ignore`, `@ts-nocheck`, file-scoped `/* eslint-disable */`, `no-explicit-any`, `no-eval`, `no-unsafe-*`, `security/*`, `no-restricted-imports`.
- **Quiet (no finding):** `@next/next/no-img-element` (data-URI / dynamic `<img>` is routinely legit), `react-hooks/exhaustive-deps`, `jsx-a11y/*`, `react/display-name`.

Surface signal preserved on the catches that matter; noise on routinely-legitimate suppressions removed.

### Fixed — Enum-drift contracts collided across unrelated `status` columns

A `job-status` contract with `column: "status"` matched EVERY `.status === "..."` in the repo (idea status, comment status, anything). Added `appliesTo: string[]` to the contract schema — contracts only fire on files matching one of the declared globs (`lib/jobs/**`, exact paths, prefix patterns). Absence = repo-wide (back-compat with 0.3.0/0.3.1 contracts).

### Changed — `pinned sweep` decoupled stats from pin-writing (recording happens always)

The 0.3.1 sweep early-returned on `--dry-run` BEFORE writing `.pinned/repo-stats.json`, so dry-run never populated the tracker. Worse: a piped `n` decline (`printf 'n' | pinned sweep`) was consumed by the prompt but pinned everything anyway because the empty-EOF answer fell through to "yes". Both fixed:

- **Stats are now recorded ALWAYS** — before the dry-run gate, before the batch-confirm prompt. `--dry-run` populates the tracker; declined batch-confirm populates the tracker. Pin-file writing only happens when the user explicitly accepts.
- **Piped non-interactive stdin defaults to decline** — unless an explicit `y`/`yes` is read. Stats still get written; no surprise mass-pinning.

### Tested

- 392/392 vitest (no regression on the 0.3.1 suite)
- 14/14 A+B+D acceptance matrix (4 publishable-secret cases, 4 lint-tier cases, 6 sweep behavior cases)
- 16/16 prior 0.3.1 bug-pack acceptance matrix still passes
- 54/54 dyad-apps FP sweep clean across 9 CLI commands × 6 repos

### Doc / behavior notes (not bugs, surfaced from dogfood C)

`pinned report` model attribution is `unspecified-model` on manual `pinned sweep` because a manual sweep has no AI-agent signal. The per-model analytics ("Sonnet produced X bugs") only populates from in-agent-loop detections (PostToolUse with a known model). This is documented in the report output now so users don't expect model breakdowns from manual sweeps.

### Known follow-up — schema-detector gap

Cipherwake reported a "feature can't actually work" bug where code writes to a table that has no migration. Static detectors saw the write surface but not the missing table — the type of bug only a smoke pin executing against prod would catch (POST → 500 on missing relation). Tracked as the **schema-detector gap**: extending `detectSupabaseColumnExists` (which currently checks columns within declared tables) to ALSO check table existence is a 0.3.3 candidate.

---

## [0.3.1] — 2026-06-05

Bug-pack release. Six Cipherwake-dogfood-reported issues that compounded into "FP auth pin you can't silence" — the exact adoption-killer the wedge release shouldn't have shipped with.

### Fixed — Retired pins kept executing (the adoption-killer)

`pinned retire` moved the test to `tests/pinned/retired/<id>.test.ts` but the default vitest glob (`tests/pinned/**/*.test.ts`) still picked it up. So a retired pin failed the suite forever. Now: the moved file content is rewritten to a self-skipping stub at retire time — file still exists for the audit trail, glob still matches, but the test is a harmless `it.skip()` with the retire reason. `pinned heal-retired` rewrites existing 0.3.0-retired pins to the same stub form.

### Fixed — Retire dead-end when test file was already deleted

`pinned retire <id>` previously required the test file to exist on disk. If a user manually deleted the file (the natural throwaway flow) then ran retire, it errored with `✗ No pinned claim found at ...` — leaving a dangling registry entry that couldn't be retired (file gone), couldn't be removed (no command), and couldn't be hand-fixed (guard blocks registry edits). The only escape was `PINNEDAI_ALLOW_PIN_EDIT=1`. Now: retire reconciles by claim-id; if the file is missing but the registry has the claim, it still updates the registry + writes the audit JSON.

### Added — `pinned rm <id>` (clean experimental-pin removal)

Drops the test file + registry entry + PINS.md row in one sanctioned step, with `--force` confirmation. For pins you want to UN-CREATE (not retire — no audit trail needed). Stamps the CLI-edit marker so the pre-commit guard recognizes it as sanctioned.

### Fixed — False-positive auth pin on pass-through routing skip-lists

The auth-check detector matched `pathname.startsWith("/admin")` as a gate even when the line was in a routing skip-list (`if (pathname.startsWith("/admin")) return NextResponse.next();`) — i.e. the OPPOSITE of an auth check. The detector now looks at the surrounding block: if the WEAK match is followed by `return next()` / `return NextResponse.next()` BEFORE any confirmer-shaped expression, treat it as not-a-gate. The bug Cipherwake reported on socialideagen `middleware.ts`.

### Fixed — Enum-drift contract column-name collision

A `job-status` contract with `column: "status"` previously matched EVERY `status` column across the repo — including unrelated `status` fields (idea draft/live, comment status, etc.) — flagging legitimate values as drift. Added `appliesTo: string[]` to the contract schema: contracts only fire on files matching the declared globs (`lib/jobs/**`, exact paths, prefix patterns). Absence = repo-wide (back-compat with 0.3.0).

### Added — CLI-edit marker (sanctions CLI-driven registry changes)

`pinned smoke add` / `pinned rm` / `pinned retire` now stamp `.pinned/.last-cli-edit` with the sha256 of the registry after writing. The pre-commit guard reads it: if the marker hash matches the current registry's hash, the change was CLI-driven and the "registry modified directly" warning is suppressed. Hand-edits still fire the warning (hash mismatch).

### Added — `pinned verify` (server-side enforcement layer)

The CI check that turns the bypassable local guard into real enforcement. Local pre-commit guard = DX layer (defeatable via `--no-verify`, `PINNEDAI_ALLOW_PIN_EDIT=1`, or `pinned uninstall`); `pinned verify` runs server-side in the GitHub Action and CANNOT be `--no-verify`'d.

Diffs HEAD against `--base` and FAILS on: deleted pin files without matching `retired/<id>.test.ts` + audit JSON, deleted registry entries without audit, weakened pins, retires without a valid audit entry, and registry/file drift. Exit 0 = clean, exit 1 = blocking violation.

Acceptance test (passes): `rm tests/pinned/<id>.test.ts && git commit --no-verify && pinned verify` exits 1 with the removed claim-id; `pinned retire <id> --reason="..."` (sanctioned retire) → `pinned verify` exits 0.

### Verified end-to-end

- 392/392 vitest (was 389; +3 new tests for contract `appliesTo`)
- 16/16 acceptance matrix: dead-end fix, `pinned rm`, retire-stub, CLI-edit marker, verify-catches-silent-removal, verify-passes-proper-retire, bug 2 regression
- 54/54 dyad-apps FP sweep across 6 repos × 9 new commands
- `pinned verify` runs clean against real dyad repos

### Positioning fix

Stopped calling pins "permanent / unbreakable contracts" in docs — a sharp user disproves it with one `--no-verify`. Reframed as: "weakening a pin is loud, deliberate, and auditable locally; with `pinned verify` as a required CI check, a silent pin removal can't be merged." Local hook = DX layer; `pinned verify` = enforcement layer.

---

## [0.3.0] — 2026-06-05

**The wedge feature.** Tier 1 functional smoke pins — Pinned actually executes your feature once at pin-eval and asserts a real outcome. Catches the dominant AI failure mode: "the agent confidently ships a feature that LOOKS done but never actually works" (silent empty return, hung worker, status-string mismatch). Combined with task #146 (Tier 0 agent prompt) shipping the same release, this is the capability that turns Pinned from "protects what works" into "tells you whether it works at all."

### Added — Smoke pin (Tier 1 functional, `smoke-functional` template)

Author declares an entrypoint + assertions; Pinned generates a vitest file that runs the endpoint and asserts the outcome.

**Entrypoint (v0.3.0):** HTTP route. `{ kind: "http-route", method, body?, headers?, defaultBaseUrl? }`. Exported-function + CLI entrypoints land in 0.3.0.x. UI/button (Tier 2 via Playwright) lands in 0.3.1.

**Assertion vocabulary** — derived from the real image-gen bug case study (client polls `status === "done"` while worker writes `"completed"` — the dominant async-feature bug shape):

- `status-ok` — HTTP 2xx
- `returns-nonempty` — body is not `""` or `"null"`
- `returns-shape` — body contains a declared substring (`{ mustContain: "<svg" }`)
- `responds-within` — generous latency ceiling (orphan detection, NOT tight SLA)
- `reaches-terminal-state` — for async/job-backed features: poll until the response body hits one of the caller's declared terminal states, RED if not terminal within the bound. **This is the assertion that catches the image-gen bug.**

**Opt-in gates** (per `[[anything-annoying-must-be-opt-in]]`):

- `safeToExecute: false` by default. Generated test is SKIPPED with WARN until author flips it. Protects against accidental side-effect execution.
- `cadence: "on-demand"` by default. Requires `SMOKE_RUN=1` or `PINNED_SMOKE=1` env var to fire under normal `vitest run`. `pre-commit` and `ci-only` cadences also available.
- Base URL resolution waterfall: `PINNED_SMOKE_BASE_URL` → `PREVIEW_URL` → `PINNED_CI_BASE_URL` → `defaultBaseUrl`. Skipped with WARN if none resolves (no false RED on missing-env).

**Flakiness handling:** Double-confirm — if first run fails, wait 500ms and retry once. If retry passes, smoke is GREEN. If both fail, RED with expected-vs-actual diagnostic message.

**Hard 4-minute test timeout** so a hung remote endpoint doesn't hang vitest forever.

### Verified end-to-end

Real runtime matrix against a stub server:
- Pin #1 (positive): GREEN — stub returns `status: completed` + `<svg/>`, all 4 assertions pass.
- Pin #2 (negative, image-gen bug case): RED with exact-expected message `"expected terminal state in [completed, failed] within 3000ms via status; last observed: 'done'"`. **The wedge feature works.**
- Pin #3 (gated, `safeToExecute: false`): SKIPPED with reason. Opt-in gate honored.

Dyad-apps regression sweep (6 repos): all clean, exit=0, no novel FP errors.

### Stripped — 0.2.26 auto-upload-on-sweep

Auto-upload-on-sweep was prototyped in 0.2.26 but had reliability issues during the matrix and was stripped before ship to avoid polluting the diagnostic trail. Manual upload via `pinned analytics upload` remains the supported path. Auto-upload will land in a follow-up patch once tested against the matrix in [[positive-and-negative-tests-required]].

### Tracked next

- Task #145 — 0.3.1 Tier 2 UI/button smoke pins (Playwright, BETA install gate)
- Task #146 — Tier 0 agent prompt snippet (ships in 0.3.0 follow-up)
- Task #147 — PreToolUse Bash hook for checklist gating on commit/publish/push
- Task #123 — Wire all 7 first-time-bug detectors into PostToolUse + pre-commit hooks (still pending)

---

## [0.2.26] — 2026-06-04

`pinned analytics` CLI command + hosted analytics upload path (opt-in only). Backend Worker endpoint shipped to `apps/edge/` for the 0.3.0 paid-tier dashboard at `app.pinnedai.dev/dashboard`. The opt-in model holds: free tier still gets the full `.pinned/repo-stats.json` + `pinned report` locally; uploads only fire when the customer has explicitly run `pinned analytics enable`.

### Added — `pinned analytics <enable|disable|status|upload>`

- `enable` — writes `.pinned/analytics-config.json` with the endpoint URL + opt-in timestamp. Prints exactly what gets uploaded (per-detector counts, per-model rollup, bounded samples) and what does NOT (source code, file contents, secrets).
- `disable` — flips the config off. Local stats + `pinned report` keep working unchanged.
- `status` — shows current opt-in state + endpoint + last upload result.
- `upload` — manual upload. Requires either a GitHub Actions OIDC token (auto-discovered via `ACTIONS_ID_TOKEN_REQUEST_URL` + `ACTIONS_ID_TOKEN_REQUEST_TOKEN`) or `PINNED_ANALYTICS_TOKEN` env var. Surfaces clear errors when no token is available.

Auto-upload-on-sweep was prototyped but deferred — the integration with the sweep code path had reliability issues during the matrix and shipping it broken would have polluted the diagnostic trail. For 0.2.26, customers manually upload via `pinned analytics upload` (or wire it into CI as a separate step). Auto-upload will land in a follow-up patch once tested end-to-end against the matrix in [[positive-and-negative-tests-required]].

### Added — Cloudflare Worker `POST /v1/repo-stats` (`apps/edge/`)

- OIDC JWT validation against GitHub's JWKS (same model as `/v1/extract`).
- 256 KB body cap.
- Subscription gate (Pro+ only — free tier stays local).
- Pro-tier per-repo monthly upload cap (100 uploads/repo/mo, fair-use).
- Two-table storage: append-only `repo_stats_uploads` event log + denormalized `detector_model_rollup` for cheap cross-repo dashboard queries.
- Returns `dashboardUrl` for the customer's org view.

### Privacy posture (load-bearing)

- Opt-in only — never auto-uploads without `pinned analytics enable`.
- No source code, no file contents, no secrets uploaded. Just the structured `.pinned/repo-stats.json` shape: per-detector counts + per-model rollup + sample file paths + line numbers + plain-English summaries (already bounded to 10 samples per detector on the CLI side).
- OIDC = repo identity. No API keys, no client-side license keys.

### Tested

- 327/327 vitest pass.
- `apps/cli` typecheck clean.
- `apps/edge` typecheck clean.
- End-to-end smoke: `pinned analytics enable` → `disable` → `status` → `upload` (verified the no-stats and no-token error paths).

---

## [0.2.25] — 2026-06-05

Per-repo bug-class tracking foundation + AI-model tagging + `pinned report` dashboard + auto-lesson-enrichment. Sets up the provider-mistake analytics that's the durable paid-tier moat per [[strategic-moat-independent-guardrail]] — neither Anthropic nor Cursor can credibly ship "your Claude bugs vs your GPT bugs" analytics for themselves (irreducible conflict of interest).

### Added — `.pinned/repo-stats.json` (local-first)

Every `pinned sweep` now updates a structured stats file: per-detector hit counts, severity ranking (critical / high / medium / low — `mass-mutation` is critical, money/data-integrity detectors are high, functional regressions are medium, surface checks are low), per-model breakdown, sample hits (bounded to last 10 per detector), 7-day rolling snapshots for trend deltas, repo identity for future cross-repo aggregation.

Atomic write pattern (same as `.last-status.json`). Schema versioned (`version: 1`) so future paid-tier upload doesn't need migration. Free tier: full local data, all detectors, all model tags. Paid tier (coming): cross-repo aggregation + org-wide provider analytics.

### Added — AI-model tagging (`src/aiModel.ts`)

Detection priority:
1. **Explicit override**: `PINNED_AI_MODEL` env var (and optional `PINNED_AI_TOOL`)
2. **Hook context**: `PINNED_HOOK_AI_MODEL` set by Claude Code's PostToolUse hook (0.2.25+ hook update wires this)
3. **BYOK**: `PINNEDAI_BYOK=anthropic|openai|claude-code|github-models` → mapped to a sensible default model label
4. **Heuristic**: presence of agent-rule-file (`CLAUDE.md` / `.cursorrules` / `.github/copilot-instructions.md` / `AGENTS.md` / `.windsurfrules` / `.clinerules` / etc) → tool tagged, model "unknown"
5. **Fallback**: `unspecified-model`

The "tool" dimension (which CLI/IDE) is tracked separately from "model" (which LLM). A user can run Claude Code (tool) routing through Anthropic Sonnet 4 (model); both dimensions are captured independently when known.

### Added — `pinned report` command

Local dashboard. Reads `.pinned/repo-stats.json`. Per-detector table sorted by severity then hit count + 7-day trend delta + per-model breakdown + recent samples (newest 3 per detector). Current AI context shown with detection signal for audit trail. `--json` exposes the full schema for the hosted upload path.

### Added — Auto-lesson-enrichment from first-time-bug catches

When `pinned sweep` finds a first-time-bug catch (enum-drift / env-required / supabase-column / expected-header / nullable-result / response-shape / mass-mutation), it auto-appends a model-tagged lesson to `.pinned/ai-lessons.md` + `.pinned/lessons.json`. The lesson surfaces in every agent's rule-context (Claude / Cursor / Copilot) so future edits learn from the catch.

Each lesson carries the AI-model tag. `lessons.json` now includes a `byModel` field per lesson: `{ provider:model:version → { hits, firstSeen, lastSeen, tool } }`. This is the structure the hosted paid-tier dashboard will consume. **Lessons surface to ALL models** — the tag is for analytics + filtering, never for gating which AI sees the rule.

Limited to first-time-bug detectors so the lessons file doesn't flood with noise from happy-path / journey / host-conditional catches (those already create executable pins that ARE the lesson).

### Tier-design notes (free vs paid)

Per [[strategic-moat-independent-guardrail]] + the locked [[free-tier-definition]]:
- **Free (everything local)**: full `.pinned/repo-stats.json` + model tagging + `pinned report` + auto-lessons. Never gets capped. Local never gets uploaded without explicit opt-in.
- **Paid (hosted, coming in 0.3.0)**: cross-repo aggregation, org-wide provider-mistake dashboards, anonymized team trends, Slack spike notifications, shared org-wide rule bank. The local schema already structures for this; no migration needed when backend ships.

### Honest scope

0.3.0 hosted analytics endpoint + dashboard UI is **not in this release** — that's backend infrastructure (Cloudflare Worker + paid dashboard at `app.pinnedai.dev`) that needs separate ship. This release is the foundation: local-first data + the upload-ready schema.

### Tested

- All 327/327 vitest tests pass
- End-to-end manual test: synthetic repo with mass-mutation + enum-drift fixtures → `pinned sweep` writes correctly-tagged stats + lessons → `pinned report` renders dashboard with `anthropic:claude:sonnet-4-6 via claude-code` model attribution when `PINNED_AI_MODEL` is set
- Stats schema serializes to JSON cleanly via `--json` for paid-tier upload path

## [0.2.24] — 2026-06-05

### Added — `mass-mutation` detector (the "AI dropped the `.eq()` filter" defense)

Catches `.from("X").update({...})` / `.from("X").delete()` calls that no longer have a filter clause (`.eq` / `.match` / `.in` / `.neq` / `.gt` / `.gte` / `.lt` / `.lte` / `.like` / `.ilike` / `.is` / `.contains` / `.containedBy` / `.range*` / `.overlaps` / `.textSearch` / `.filter` / `.or` / `.not` / `.maybeSingle` / `.single` / `.limit` / `.range`).

The bug class: AI drops the `.eq("id", userId)` filter during refactor, leaving `.from("users").update({banned: true})` — which mutates **every row in the table** on first execution. Catastrophic data loss / unwanted state change. First-time bug class, pure static, tight signal, zero FPs across 10 dyad-app sweep.

Pin asserts the captured call site STILL has a filter at test time OR the call is removed entirely (clean refactor). Fails when AI keeps the update/delete but drops every filter clause.

Tests:
- Detector matrix: 4/4 (positive update-no-filter / positive delete-no-filter / negative update-with-eq-filter / negative delete-with-in-filter)
- Template matrix via real vitest: 3/3 (filter-present green / filter-removed red / call-removed-entirely green)
- Dyad FP sweep: 0 hits across 10 repos — every existing update/delete in those repos has at least one filter
- Regression: 327/327 vitest

## [0.2.23] — 2026-06-05

Five new **first-time-bug** detectors per the audit agent's top-5 list. Every other Pinned detector assumes a green baseline to regress from — these five catch bugs at the *moment they're written*, before any baseline exists. All static (no creds, no runtime probes), all precision-gated (10-repo FP sweep), all wire into the existing real-time catching paths (PostToolUse hook + pre-commit + sweep + CI).

### Added — `env-required` (the audit agent's #1)

Walks the repo for `process.env.X` / `Deno.env.get("X")` / `getEnv("X")` reads. Cross-references against declaration sources: `.env.example`, `.env.local.example`, `.env.template`, `.env.sample`, `.env.dist`, `next.config.{js,mjs,ts}` env block, `vercel.json` env, `wrangler.toml [vars]`. Flags every key read in code but missing from every declaration source. The "cloned repo first-runs silently break with undefined env" bug class.

**FP gates**: 60+ Node/Next/Vercel/GitHub-Actions/Cloudflare/Pinned-self built-ins allowlisted. Dynamic reads (`process.env[var]`) skipped. `process.env.X || "default"` and `?? "default"` fallback patterns skipped (handled-missing case). Test/script/migration files skipped. Only fires when ≥1 declaration source exists (no signal → no FP).

**Dyad-app dogfood**: socialideagen flagged 3 missing keys (`ANTHROPIC_API_KEY`, `NEXT_PUBLIC_CLAUDE_DROPLET_SUPABASE_URL`, `NEXT_PUBLIC_CLAUDE_DROPLET_SUPABASE_ANON_KEY`) — exact set the audit predicted. quantasyte 23 missing, quantapact 25 missing, researchAi 4 missing.

### Added — `supabase-column-exists` (the audit agent's #3)

Walks code for `.from("X").select("col1,col2")` / `.eq("col3", ...)` / `.update({col4: ...})` / `.insert({col5: ...})` / `.upsert({col6: ...})`. Cross-references against schema sources: `supabase/migrations/*.sql` (CREATE TABLE + ALTER TABLE ADD COLUMN parser), `database.types.ts` / `db.types.ts` / `types/database.ts` / `types/supabase.ts` (generated types parser). Flags columns code references that the schema doesn't declare. The "runtime error on first query" bug class.

**FP gates**: returns no hits when neither migration nor types source exists (no signal → no FP). Dynamic table/column names (`from(tableVar)`) skipped. Foreign-key relation joins (`users(name)`) handled correctly. PRIMARY/FOREIGN/UNIQUE/CHECK/CONSTRAINT SQL keywords skipped from column extraction. Star-select (`select("*")`) skipped.

**Dyad-app dogfood**: 20 hits across 3 repos with schemas (quantapact 10, MediniDyad 9, researchAi 1). 5 repos without schemas correctly returned no signal.

### Added — `expected-header-present` (the audit agent's #4)

Catches webhook header-name typos. Provider canonical headers: Stripe `stripe-signature`, GitHub `x-hub-signature-256`, Svix `svix-signature`, Twilio `x-twilio-signature`, Shopify `x-shopify-hmac-sha256`. Detects typo variants (e.g. `x-stripe-signature` when canonical is `stripe-signature`, `x-hub-signature` without `-256`) in `headers.get()` / `req.headers["..."]` / `headers.X` reads.

**FP gates**: only fires when file imports the matching SDK (`new Stripe(`, `from "@octokit/`, etc). Skipped when file ALSO contains the canonical header (dual-pattern fallback assumed correct). One hit per file max — the bug is "this handler reads the wrong header," not "many sites read the wrong header."

**Dyad-app dogfood**: 0 hits — all existing webhook handlers use canonical headers. Synthetic positive case verified: handler reading `x-stripe-signature` with Stripe SDK import → flagged. Handler reading canonical `stripe-signature` → no flag.

### Added — `nullable-result-used` (the audit agent's #5)

Catches `arr.find(...)` / `.match()` / `Map.get()` / `regex.exec()` results used without null guard in **server-side request handlers** (`app/**/route.ts`, `*.actions.ts`, `supabase/functions/*/index.ts`, top-level `api/*.ts`). First edge-case input crashes the route with a 500.

**Tight scope (FP gate)**: only fires in server-side handler contexts where a crash = user-visible 500. Library code / utility code / tests skipped. Guards detected: `if (!name)`, `if (name)`, `name?.`, `name ?? `, `name === null`, `name !== undefined`.

**Dyad-app dogfood**: 14 hits across 2 repos (MediniDyad Edge Functions 13, quantapact 1). Each is a real unguarded `.find()`/`.match()` site in a request handler where bad input would 500.

### Added — `response-shape` (the audit agent's #2 — generalizes the socialideagen bug)

Cross-file: finds `fetch("/api/X")` consumers + their key reads, finds the matching `app/api/X/route.ts` producer + its `NextResponse.json({...})` keys, flags when consumer reads a key the producer never emits on 2xx. Generalizes the user's socialideagen `status === "done"` bug to all consumer/producer JSON-key mismatches in same-repo HTTP routes.

**FP gates**: literal-route only (dynamic-path-template variants skipped — too FP-prone for v1). Both destructured (`const { a, b } = await res.json()`) and bound-name (`const data = await res.json(); data.x; data.y`) consumer patterns handled. Skipped when 100% missing AND producer set is tiny (likely error-response shape, not happy-path).

### Tested

- **5 detector positive/negative matrices** via synthetic + real vitest invocation
- **env-required template matrix**: 3/3 via real vitest (all-declared green / key-removed red on specific key / sources-removed red on source-check)
- **Combined dyad sweep across 10 repos**: env=53 across 4 repos (correct distribution), supacol=20 across 3 repos with schemas (5 with no schema correctly no-signal), nullable=14 across 2 repos, headers=0 (no typos in corpus — synthetic positive confirms detector works), resp-shape=0 (no key-mismatch in corpus — synthetic positive confirms)
- **Regression**: 327/327 vitest, typecheck clean
- **Architecture**: all 5 detectors wire into the existing real-time paths — PostToolUse hook (Claude Code), pre-commit hook (Husky), `pinned sweep` (manual/CI), GitHub Action workflow (PR-time)

### Real-time catching

Same continuous-verification flow as every other Pinned pin:
- `pinned sweep` ad hoc — surfaces drift on demand
- pre-commit + pre-push hooks — run `pinned test` before code leaves your machine
- CI workflow — runs on every PR
- Claude Code PostToolUse hook — auto-verifies affected pins after every agent edit

## [0.2.22] — 2026-06-05

First **first-time-bug** detector. Pinned's other detectors assume a green baseline to regress from — this one catches bugs where consumer + producer never agreed in the first place. Closes the socialideagen-dogfood gap (client polled `status === "done"` but the producer never emits that value).

### Added — `enum-drift` detector + pin template

`detectEnumDrift` performs a cross-file static scan: collects every producer-side write to a string-typed object-literal field (`update({ col: "X" })`, `insert({ col: "X" })`, `return { col: "X" }`, etc.), collects every consumer-side string comparison (`x.col === "Y"`, `x.col !== "Y"`, `switch (x.col) { case "Y": }`, `.includes("Y")`, destructured `const { col } = x; ...col === "Y"`). For each (consumer file, column), flags values the consumer reads that the in-repo producer never emits.

**Two confidence tiers** (precision-gated):
- **confirmed**: ≥1 expected value overlaps with the producer set (shared vocabulary, real drift on a specific value). Auto-pinned by `pinned sweep`.
- **review**: zero overlap — usually a cross-table column-name collision, occasionally the user's cross-repo external-producer shape. Surfaced in sweep output but NOT auto-pinned. Opt in via `--include-beta` to pin them too.

**FP gates** (load-bearing — keep tight per dyad-app FP sweep):
- Producer column set size capped at 12 (filters out id-like columns that slipped past the generic-name filter)
- 100% missing + tiny producer set (<3 values) → drop (signal too weak)
- Generic field names skipped (id / name / type / value / etc.)
- Generic value tokens skipped (true / false / null / get / post / etc.)
- Test files / scripts / migrations skipped from both sides
- Only flag columns where the producer also writes (no external-producer false positives — if there's no in-repo producer for the column, no signal)

**Pin template**: emits a vitest file that re-scans the codebase at test time, asserts each `observedValue` (the producer-side emit set at pin-creation) still appears as a producer write somewhere. When AI silently removes a producer write for a value the consumer reads, the pin fails specifically on that value.

### Dyad-app dogfood results

10-repo sweep produced **38 confirmed + 6 review** hits. Confirmed catches include real drift patterns:
- back-in-play: `confidence === "Medium"` reads but only `"High"` produced; `modelType === "injury"` / `"team"` reads but only `"player"` produced
- researchAi: `study_type === "meta_analysis"` / `"scoping_review"` reads but only `"systematic_review"` produced
- MediniDyad: `visit_mode === "virtual"` reads but only `"in_person"` produced
- quantapact: `direction === "better"` reads but only `"worse"` produced

socialideagen's cross-table column collision (`status` shared between `ideas` and `jobs` tables, different value sets) correctly demoted to review tier.

### How it catches bugs in real time

Same continuous-verification path as every other Pinned pin:
1. **`pinned sweep`** — surfaces drift on demand. Confirmed-tier hits auto-pin.
2. **Pre-commit + pre-push hooks** — run `pinned test` (which includes the new enum-drift pins) before code leaves your machine.
3. **CI workflow** — runs on every PR.
4. **Claude Code PostToolUse hook** — verifies affected pins after every agent edit. Dedicated "scan just-edited file for new drift" mode shipping in 0.2.23.

### Honest scope

`enum-drift` catches the **in-repo** variant of the user-reported bug class. The specific socialideagen bug (producer is a daemon in a separate repo) lands in the review tier OR isn't caught at all (when the in-repo producer never writes to that column). The cross-repo variant needs a declared contract artifact both sides reference — deferred to a follow-on release.

### Tested

- **Detector matrix**: positive (socialideagen-shape bug caught) + negative (matching consumer/producer green) + negative (external producer skipped — no in-repo writes, no signal) + negative (generic field names like `name` skipped). 4/4 ✓
- **Template matrix via real vitest**: positive (all producer values intact → 3 sub-tests pass) + negative (AI removes producer write for `completed` → red specifically on that value) + edge case (constant-folded producer values caught as drift, known limitation). 3/3 ✓
- **Dyad FP sweep**: 10 repos, 38 confirmed + 6 review. socialideagen cross-table case correctly demoted to review. No high-volume FP repos.
- **Regression**: 327/327 vitest, typecheck clean.

## [0.2.21] — 2026-06-04

Both gaps from the socialideagen admin-build dogfood closed. Moves page-renders from *"didn't crash"* → *"works + is usable,"* and Server Action pins from *"detected"* → *"verified."* Every contrast bug and every admin write went unguarded in that build; this release pins both classes.

### Added — Server Action pins go GREEN (test-session injection)

The 0.2.18 detector caught `saveIdea` / `uploadMockup` / `aiFillIdea` but couldn't verify them — they're `isAdminAuthed()`-gated, so direct invocation always returned `{ok: false, error: "Not authorized."}`. 0.2.19's precondition-WARN downgraded that from cry-wolf-red to skip-with-warning (good), but the pin was still inert — no actual verification, just "we know we can't verify."

0.2.21 closes the loop. When the detector captures the auth helper's import location (via `extractAuthHelperImport`), the generated test emits `vi.mock(specifier, () => ({ authHelper: () => __authState.allow }))` using vi.hoisted() for a flippable mock reference. Two test cases land:

1. **"returns success shape for valid payload (session mocked)"** — `__authState.allow = true`, action runs through to its happy path, success-shape asserted field-by-field.
2. **"rejects when unauthenticated"** — `__authState.allow = false`, expects `{ok: false}` OR thrown rejection. This second case is what catches AI silently REMOVING the auth gate entirely (with only the allow-mock, gate removal would still pass).

Falls back to single-test mode when no auth helper detected (or non-standard import shape) — preserves prior behavior for ungated actions.

Acceptance on socialideagen `lib/ideaActions.ts:saveIdea`:
- `authHelperImport: { specifier: "./adminAuth", named: "isAdminAuthed" }` captured at detection
- Generated test mocks `../../lib/adminAuth` via `vi.mock` — resolves to the same absolute path as the action's `./adminAuth` import
- With session mock + valid fixture: GREEN on `{ok: true, slug: ...}`
- Removed write / removed validation / removed auth gate: each fails specifically

Matrix: 7/7 (positive gated action / auth-gate removal red / write removal red / throw-on-unauthed accepted / env-missing precondition warn / no-fixture skip / no-auth-helper fallback).

### Added — Page accessibility (axe-core contrast) — BETA

Closes the white-on-white-shipped-three-times class. page-renders pins go GREEN on these pages (the page DID render, body has content), so this is the only template that catches the *"looks broken but doesn't crash"* class.

`detectRetroactivePages` walks the tree for `app/**/page.tsx` + `pages/**/index.tsx` files, emits a `page-accessibility` proposal for each. Generated test:
- Launches Playwright (same opt-in beta as interaction-baseline)
- Navigates to the page via `PREVIEW_URL`
- Injects axe-core via CDN script tag (`https://cdn.jsdelivr.net/npm/axe-core@4.10.0/axe.min.js`) — pinned version so future axe updates can't silently shift the pin's verdict
- Runs `axe.run` with `runOnly: { type: "rule", values: ["color-contrast"] }` — filters out the noisy region/landmark findings that aren't actionable from a Pinned pin
- WARN-only on violations — beta posture (frontend a11y doesn't fail CI). Catches tagged `confidence:"review"` so they don't inflate the GA metric

Acceptance on socialideagen: 12 page-accessibility candidates surfaced — including the exact admin pages where white-on-white text shipped (`/admin/ideas/new`, `/admin/ideas/[slug]/edit`, `/admin/ideas/[slug]/ads`, `/admin/ideas/[slug]/customize`).

### Tested

- **Server Action GREEN matrix**: 7/7 end-to-end via real vitest (proper-gating both tests pass / auth-gate removal red / write removal red / throw-on-unauthed accepted / env-missing precondition still WARNs / no-fixture skip / no-auth-helper fallback)
- **Real-world wiring**: socialideagen `saveIdea` now captures `authHelperImport: { specifier: "./adminAuth", named: "isAdminAuthed" }` at detection
- **Detector matrix**: `detectRetroactivePages` on socialideagen returns 12 page candidates, all real admin pages
- **Template emit**: generated a11y test file parses clean (TypeScript module-resolution + axe-core CDN + 30s test timeout + confidence:review env set)
- **Regression suite**: 327/327 vitest, typecheck clean
- **Dyad sweep**: no new spurious hits (page-accessibility candidates only emit for files matching the page-route conventions)

## [0.2.20] — 2026-06-04

Quality fix on top of 0.2.19 — the new auth-posture detector was reviewed by an external audit agent and three concrete tightenings applied. The audit's concern: the "ambiguous → verify" tier was too loose, would engulf real bare-endpoint warnings under soft yellow alarms, and developers would learn to ignore everything. Three tightenings landed:

1. **`verify`/`validate`/`check` calls now require an auth-noun suffix** (Webhook/Signature/Token/Hmac/Auth/Session/Sig/Jwt/Bearer/Oidc/Pkce/Password/Secret). Kills FPs on `checkPastTime`, `validateEnv`, `checkAndIncrement`, `validateSubscription` — none of which are auth, all of which previously flipped functions to "ambiguous".
2. **`Authorization`-header signal now requires an INBOUND read**, not literal word presence. Without this, every backend file with `headers: { Authorization: \`Bearer ${OPENAI_API_KEY}\` }` (outbound proxy) was getting "ambiguous" — exactly the case where a real bare webhook receiver could merge into the soft warnings.
3. **Bare env-secret references dropped from ambiguous signals.** Nearly universal in backend code; on its own says nothing about caller auth.

Plus two `extractAuthGate` improvements:
4. **Widened `require*` vocab** to include Scope / ApiKey / Key / Token / Permission / Access. Caught `requireRetellAgentScope`, `requireRetellApiKey`, `requireRetellToolScope` (real auth helpers from MediniDyad). Anchored on camelCase boundary so `requireNonEmptyString` (a string validator) does NOT match.
5. **Dropped service-role-key branch** — `if (!SUPABASE_SERVICE_ROLE_KEY) throw` is a config assertion, not a caller-auth boundary. Was incorrectly labeling bare endpoints as "gated."

### Result on MediniDyad's 42 Edge Functions

| Tier | Original (0.2.19) | After audit + fix |
|---|---|---|
| Confirmed auth | 19 | **25** (caught 6 Retell scope/key helpers + the `medini-cancel-appointment` retell-scope check) |
| Ambiguous (soft warn) | 0 (originally all alarm-or-clear) | **5** (genuinely-might-be-auth idioms — OAuth callbacks, prod-admin with password compare) |
| NO_AUTH (loud alarm) | 27 (mostly wrong) | **12** — the actually-bare functions worth investigating |

Same posture model also applied to Server Actions for consistency.

### Tested

- 9 unit cases for the widened `require*` regex: 9/9 correct (real auth helpers detected, validator/data-access FPs rejected)
- Full vitest suite: 327/327 ✓
- 5-template matrix re-run: 21/21 ✓ (all FP/positive checks still pass)
- Dyad FP sweep: 0 new spurious hits introduced by the tightenings

## [0.2.19] — 2026-06-04

Five new coverage gaps closed in a single release, plus a precondition-WARN fix on Server Actions and a long-overdue npm-README sync. The new gaps span the highest-stakes surfaces dyad-app dogfood and a follow-up deep-audit agent both flagged: paid-API calls in plain backend services (the "AI silently swapped my model" defense), Supabase Edge Functions (Deno runtime — HTTP-route detection structurally misses them), Vercel/GH-Actions cron handlers (no user-in-loop, silent SLA-break class), Stripe webhook event-type dispatch (one-letter typo + signature still verifies = paying customers never get provisioned), and Stripe checkout/billingPortal session creation. FP sweep across 10 dyad-apps: 0 spurious hits, every detection confirmed real-world.

### Fixed — Server Action template no longer cry-wolf-reds on precondition failures

When a Server Action returns a recognizable "can't run here" shape — `{ ok: false, error: "Not authorized." }` (no admin session in test env), `{ ok: false, error: "Backend not configured." }` (missing service-role key), `{ status: 503 }` — the test now WARNS and skips instead of failing red. The Pinned thesis on cry-wolf reds: a guard that hard-fails when it simply couldn't run trains people to ignore reds. Precondition failure is NOT a regression.

Recognized signals: unauthorized / sign-in / forbidden vocabulary in `error`; backend-not-configured / service-unavailable / missing-env vocabulary; 503 in `status` or `statusCode`. Genuine returns ("Database write failed: connection refused", thrown errors, success-shape mismatches) still fail red — verified via the matrix: 4 positive WARN cases + 3 negative real-failure cases, all behave correctly.

### Added — Paid-API call detector (the HEADLINE)

`detectPaidApiCalls()` is entry-point-agnostic: it fires on ANY .ts/.js file (skipping tests + scripts + node_modules + dist) that calls a paid SDK endpoint. The 0.2.18 Server Action detector caught these inside `"use server"` modules; this catches them everywhere. Marketing line: *"Pinned guards every paid API call in your backend — not just the ones in Next.js Server Actions."*

The bug classes it stops:
1. **AI silently swaps the model** — `claude-opus` → `claude-haiku`, `gpt-4o` → `gpt-4o-mini`. Quality regression nobody notices until users complain. Pin captures the model literal + asserts it survives.
2. **AI removes `max_tokens` / `max_completion_tokens`** — unbounded spend regression. Single runaway payload = $50-200 in API costs. Pin captures the cap's presence (not the value) so adding a Pinned guard to existing code doesn't suddenly flag it as missing a cap.
3. **AI silently removes the call entirely** — caught by the call-expression assertion.

Coverage: Anthropic (`messages.create/parse/stream`), OpenAI (`chat.completions.create`, `responses.create`, `images.generate`, `embeddings.create`), Google Gemini (`generateContent`), Stripe (`paymentIntents.create`, `charges.create`, `subscriptions.create`, `customers.create`, `checkout.sessions.create`, `billingPortal.sessions.create`). Each gated by an SDK-import requirement so `client.X` calls on supabase/redis/other clients don't false-positive.

Real-world evidence: sAles repI's `server/src/services/extraction.ts:64` calls `anthropic.messages.create` with `claude-sonnet-4-5-20250929` + `max_tokens` — exactly the surface the Server Action detector structurally misses (plain Express service, not a Server Action).

### Added — Supabase Edge Function detector

`detectEdgeFunctionWrites()` finds files matching `supabase/functions/<name>/index.ts` that contain either `Deno.serve(...)` OR `import { serve } from "https://deno.land/std/..." + serve(...)` AND a recognized write shape. Static source-scan pin — Edge Functions run in Deno, not Node, so direct invoke from vitest isn't feasible. The pin asserts: (a) file exists, (b) write expression survives, (c) auth-gate function call survives.

Same WRITE_SHAPE_PATTERNS as Server Action detection, with **widened Supabase client-identifier vocabulary** — production code uses `admin.from(...).insert(...)` / `db.from(...).update(...)` / `userClient.from(...).upsert(...)` not just the literal `supabase.X` identifier. Confirmed: MediniDyad 42 Edge Function writes detected (up from 1 in the initial implementation pass), plus 2 each in Ai-Book + researchAi.

### Added — Cron handler detector (Vercel + GitHub Actions)

`detectCronHandlers()` parses `vercel.json:crons[]` for path + schedule pairs, and `.github/workflows/*.yml:on.schedule[].cron` for workflow schedules. Both surfaces share the same risk: cron fires WITHOUT a user in the loop, so schedule drift (`0 4 * * *` → `0 4 * * 0` runs once a week instead of daily, same shape) or handler rename = silent SLA break.

Vercel pin: file exists + schedule preserved + path still declared + handler file (resolved via path → `api/<path>.ts` or `app/<path>/route.ts`) exists. GH Actions pin: workflow file exists + schedule string preserved. Real-world: quantapact 11 Vercel crons (rollup-scan-events, alert-deliver, scan-peers, etc.), 1 GH Actions schedule on pulse.yml; quantasyte synthetic-monitor.yml; pinnedai itself pulse.yml.

### Added — Stripe webhook event-type dispatch detector

`detectStripeEventDispatches()` finds the dispatch layer above signature-verify: `switch (event.type) { case "checkout.session.completed": ... }`. The bug it stops: AI silently typos a case literal (`"checkout.session.complete"` vs `"checkout.session.completed"`), merges fallthrough arms dropping one, or wholesale deletes a case. Signature still verifies — Stripe still 200s — paying customers never get provisioned.

Precision-gated:
- File must use the Stripe SDK (direct `stripe.webhooks.constructEvent` call, OR `Stripe.Event` type reference, OR `from "stripe"` import paired with a wrapper-named verify call)
- File must contain `switch (event.type)` OR `switch (<discriminant>)` where the discriminant was destructured/assigned from `event.type`
- At least one case arm must match Stripe's `<resource>.<action>` event-name shape (`STRIPE_EVENT_NAME_RE`)

Confirmed across 3 dyad-apps: quantapact `tier-webhook.ts` + `badge-webhook.ts` (each with 4 events), quantasyte `apps/api/src/controllers/billing.ts` (4 events). Quantasyte uses a wrapper-call pattern (`constructWebhookEvent` from a local stripeService); the SDK-detection gate accepts that via the `Stripe.Event` type signal.

### Added — Stripe checkout/billingPortal session patterns

Two missing entries added to `WRITE_SHAPE_PATTERNS`: `stripe.checkout.sessions.create` (the SaaS hosted-checkout endpoint that 80% of SaaS apps use) and `stripe.billingPortal.sessions.create` (the subscription-management surface). The existing Stripe coverage was paymentIntents / charges / subscriptions / customers — common, but not the surface real SaaS apps actually use. Zero-FP shape: confirmed on quantasyte stripeService.ts (lines 77 + 110) and quantapact badge-portal.ts (line 109).

### Added — Vercel pages-style `api/X.ts` route derivation

`deriveRouteFromPath()` now handles top-level `api/X.ts` files (Vercel pages-style serverless functions) and `apps/<workspace>/api/X.ts` (monorepo workspace roots). Previously returned `null` for both — silently skipping write-endpoint detection on production code. Confirmed: quantapact's `api/badge-portal.ts` + 11 `api/cron/*.ts` files now route-derivable. Tightly constrained (regex anchored to repo-root / workspace-root) so `lib/api/X.ts` does NOT match.

### Fixed — npm-published README was stale

`apps/cli/README.md` (what npm publishes when `pnpm pack` runs in that workspace) was frozen circa "9 templates across 3 domains" — missing every feature since 0.2.0. Synced to root README content. Added a `prepublishOnly` script (`cp ../../README.md ./README.md`) so future releases keep the two in lockstep.

### Updated — landing site

`apps/landing` quick-start step 2 now shows `pinned sweep` instead of `pinned guard` (the canonical first-run command). New protection card added: *App-Router mutations — Next.js Server Actions, DB writes, file uploads, paid-API calls; auth gate + input schema captured per action.*

### Tested

Three-test matrix + dyad FP sweep per [[fp-check-everything-with-real-tests]], all run end-to-end through real vitest (no synthetic substitutes):
- **Server Action precondition WARN**: 4 positive WARN cases (ok:true / Not authorized / Backend not configured / 503) + 3 negative real-failure cases (DB write fail / thrown / wrong-shape). 7/7 ✓
- **Stripe event-type dispatch**: positive (all events handled → green) + negative (one-letter typo / commented case → red). 3/3 ✓
- **Paid-API call**: positive (correct model + max_tokens → green) + 3 negatives (model swap / max_tokens removed / call deleted → red). 4/4 ✓
- **Edge Function write**: positive (auth + write present → green) + 2 negatives (write removed / auth removed → red). 3/3 ✓
- **Cron handler**: positive (intact → green) + 2 negatives (schedule drift / handler renamed → red). 3/3 ✓
- **Stripe checkout/portal patterns**: 3/3 ✓ (checkout detected + portal detected + retrieve skipped)
- **Full vitest suite**: 327/327 ✓; typecheck clean.
- **FP sweep across 10 dyad-apps**: stripeEvent=2, paidApi=2, edgeFn=46, cron=13. All 63 hits manually verified real (every Vercel cron + every GH Actions schedule + every Stripe webhook + every Edge Function write + sAles-repI + socialideagen aiFill + quantapact badge-portal). **0 spurious hits.**

## [0.2.18] — 2026-06-03

Two trust-critical fixes shipped together: (1) the retired-pin catch trust bug — phantom catches from retired pins were permanently inflating the "regressions caught" metric with no clean way to remove them. (2) The App-Router mutation blind spot — Server Actions (the modern Next.js mutation pattern) were entirely invisible to `pinned sweep` because write detection only covered HTTP `/api/*` route handlers. Both are P0 per [[strategic-moat-independent-guardrail]] (the trust metric must be trustworthy; the independent guardrail must actually see the high-stakes write surfaces).

### Fixed — retired-pin catches no longer inflate the trust metric

`pinned catches` headline + the UserPromptSubmit hook output + the statusline "★ N catches today" rollup now ignore catches whose `claimId` is no longer an active pin. The records persist in `.last-status.json` as audit-trail (so an unwise retire can still be investigated), but they don't show up in any user-facing metric until the user explicitly purges them with `--reset-phantoms`.

The bug: `retire` correctly cleaned catchHistory + `caughtClaimIds` + `breaksCaught` as of 0.2.12, but (a) pre-0.2.12 retires left orphans that never got cleaned, and (b) `--reset-phantoms` only dropped catches whose claimId was in `failingClaimIds` — retiring a pin REMOVES it from `failingClaimIds`, so its lingering catches became forever-phantoms with the failing-set early-exit returning "Nothing to reset." 8 phantom catches on pinnedai itself (every catch ever recorded was from a now-retired baseline pin); 1 reported by user on socialideagen.

The fix: three layers.
1. **Read-side filter** (no migration needed): `pinned catches` listing, `pinned hook-failure` output, statusline catch counters all filter `catchHistory` against `getActiveClaimIds()`. Orphan catches surface as a one-line `ⓘ N orphan events` info so the user knows phantoms exist.
2. **Extended `--reset-phantoms`**: now drops catches in `failingClaimIds` UNION orphan claimIds (catches whose pin is no longer active in the registry). Removed the "Nothing to reset — no claims are marked as currently failing" early-exit that was suppressing the orphan path.
3. **failureMessage active-set filter**: a retired pin still listed in `failingClaimIds` no longer fires the chat-hook regression warning — defense-in-depth against the cache-vs-registry skew that triggered the user's report.

Three-test matrix:
- Positive 4/4: orphan filtered from listing + headline drops to honest count + `--reset-phantoms` purges orphan catches + writes drop to disk + hook-failure suppresses retired-pin warnings.
- Negative 3/3: active-pin catches survive `--reset-phantoms` untouched + legitimately failing active pin still fires the hook regression warning + empty-state (`0 failing, 0 orphan`) exits cleanly with `Nothing to reset`.
- Self-applied on pinnedai: 8 phantom catches identified + cleared (all 8 corresponded to retired baseline pins from earlier dogfood iterations).

### Added — Next.js Server Action write detection (the App-Router mutation blind spot)

`detectServerActionWrites()` walks the tree for files containing a module-level `"use server"` directive (or inline directive at function-body top), finds exported async functions / arrow exports, runs `detectWriteShape()` against each body, and surfaces:
- write target (table / bucket / API)
- library (supabase-js / supabase-storage / aws-s3 / cloudflare-r2 / vercel-blob / anthropic / openai / google-gemini / stripe / …)
- auth gate function name (`isAdminAuthed`, `requireAuth`, `getServerSession`, etc.)
- input schema variable (`IdeaInput`, `*Schema`, `*Body`, `*Payload`)

Acceptance on socialideagen (the report fixture): `pinned sweep` now flags all three of the admin panel's Server Actions — `saveIdea` (DB upsert → `ideas` via supabase-js), `uploadMockup` (file upload → `mockups` bucket via supabase-storage), `aiFillIdea` (paid Anthropic call → `client.messages.parse`). All three were previously invisible. All three carry the `isAdminAuthed()` gate, captured + surfaced in the sweep output.

**Extended `WriteShape` coverage:**
- `file-upload` kind, libraries: supabase-storage (`storage.from(BUCKET).upload`), aws-s3 (`PutObjectCommand` / `putObject`), cloudflare-r2 / Workers KV (`env.BUCKET.put`), vercel-blob (`@vercel/blob` import + `put()` call)
- `http-post` kind, libraries: anthropic (`messages.create` / `messages.parse` / `messages.stream`), openai (`chat.completions.create` / `responses.create` / `images.generate` / `embeddings.create`), google-gemini (`generateContent`), stripe (`paymentIntents.create` / `charges.create` / `subscriptions.create` / `customers.create`)

### Added — `server-action-write` template + `pinned record-server-action`

The verifier loop. The detector emits a `server-action-write` claim into `pinned sweep`'s batch confirm; on Y the pin file is written. Until a fixture is recorded the test self-skips with a clear `run pinned record-server-action` message. Same posture as `interaction-baseline`'s "no baseline recorded yet" mode.

**Template (`templates/serverActionWrite.ts`):** imports the action by relative path (derived from `actionModule`, extension stripped for ESM resolution), calls it with the recorded fixture, asserts the return matches `successShape` (default `{ ok: true }`) field-by-field. Specific error messages for the two failure modes that matter most: action no longer exported / action no longer returns the success shape. No PREVIEW_URL needed — runs against the customer's compiled code in-process.

**Command (`pinned record-server-action <claim-id> --fixture <path>`):** reads a JSON file containing a valid payload, validates it parses as an object (not array / not primitive), persists it onto the claim's `fixturePayload` field, regenerates the pin file via the standard `generateTest()` dispatcher so the inline `FIXTURE` constant matches. Writes a `.pinnedai/regenerate-allow.json` marker (`source: "record-server-action"`) so the pre-commit guard recognizes the regeneration as sanctioned.

**Auth-gated actions** (all three socialideagen examples — `isAdminAuthed`): the recorder prints a warning explaining that the direct-invoke test will hit the not-authorized branch unless the user adds a `PINNED_TEST_BYPASS_AUTH` short-circuit to their auth helper OR sets up a fixture session in vitest setup. Documented limitation for 0.2.18; full auth-fixture machinery lands in 0.2.19.

### Tested

Three-test matrix + dyad sweep per [[fp-check-everything-with-real-tests]]:
- **Positive (detector)**: socialideagen 3/3 actions detected with correct categorization, library, target, and auth gate. WriteShape patterns 5/5 (supabase-storage, aws-s3, vercel-blob, anthropic `.parse`, openai chat.completions). 8/8 ✓
- **Negative (detector)**: read-only Server Action skipped, no-directive skipped, no-export skipped, commented-out directive skipped, .css skipped, test file skipped. 6/6 ✓
- **Positive (template)**: skip-without-fixture emits `FIXTURE = null` + `it.skipIf(noFixture)` + `../../lib/...` import path. With-fixture emits inline payload. 4/4 ✓
- **Positive (record-server-action)**: writes fixture to registry + regenerates pin file with inline payload + `.pinnedai/regenerate-allow.json` marker tagged `source: "record-server-action"`. 4/4 ✓
- **Negative (record-server-action)**: rejects wrong-template claim, rejects missing `--fixture`. 2/2 ✓
- **Full suite**: 327/327 vitest tests pass; typecheck clean.
- **FP sweep**: 10 dyad repos, 683 files, 3 candidates, 0 spurious (all 3 real socialideagen actions).

### Added — README "Browser interaction pins" section + new "Server-Action pins" section

Per [[readme-updates-with-every-release]].

## [0.2.17] — 2026-06-03

Closes the BETA Playwright adapter loop: auto-detection of interaction pins from source + `pinned record-interaction` to capture the baseline. With this release, the carousel "arrows do nothing" regression class is end-to-end covered — discover → pin → record → catch — without the user authoring a single test by hand.

### Added — auto-detect interaction pins (`pinned sweep --include-beta`)

`detectInteractionCandidates()` walks the customer's `app/` / `pages/` / `src/` / `components/` trees for JSX buttons that satisfy ALL of:
1. Have a stable selector (`data-testid="…"` preferred over `aria-label="…"`).
2. Have an `onClick` handler (visual-only buttons are skipped).
3. Live in a real component file (API routes filtered out).
4. Aren't inside a `// …` or `/* … */` comment (commented-out JSX skipped).

Handles ternary aria-labels (`aria-label={dir < 0 ? "Previous" : "Next"}` emits TWO candidates) — the exact shape that ships in `socialideagen/components/Carousel.tsx`. Suggested observation is inferred from the aria-label semantics: `"Next"` / `"Previous"` / `"Scroll"` → `scroll-position`; `"Open"` / `"Toggle"` / `"Show"` → `element-count`; `"Submit"` / `"Sign in"` / `"Continue"` → `url`; default → `dom-text`.

Surfaced in `pinned sweep` output under "🛟 BETA — Interaction-baseline candidates" (visible by default, NOT pinned). Pinning requires both `--include-beta` AND a prior `pinned add-browser` to keep the consent ladder explicit. FP sweep across 10 dyad repos / 445 component files: 3 candidates, all real (2 socialideagen carousel arrows + 1 Ai-Book intro-video modal), 0 spurious hits.

### Added — `pinned record-interaction <claim-id>`

The final piece of the interaction-baseline workflow. Runs the action once via Playwright against `$PREVIEW_URL` (or `--url=<url>`, defaulting to `http://localhost:3000`), captures the observable value (scroll position / DOM text / URL / element count), writes it back onto the claim's `baseline` field in `.registry.json`, regenerates the `.test.ts` so the embedded `BASELINE` constant matches.

Sanctioned via the same `.pinnedai/regenerate-allow.json` marker as `pinned regenerate` (source: `"record-interaction"`, 5-min TTL, sha256-bound to the regenerated file), so the pre-commit guard-removal hook recognizes the change as legitimate. Until a baseline is recorded, the auto-pinned test emits a single warn-only message ("no baseline yet — run pinned record-interaction") and returns green; the only way to ship a beta interaction pin to CI is the explicit record step.

Resolves Playwright from the customer's `cwd/node_modules`, NOT the CLI's install dir — Playwright is the customer's optional devDep, not Pinned's runtime dep. Hard-fails with a pointer to `pinned add-browser` when missing. Refuses non-`http(s)` URLs, refuses claim-ids that aren't interaction-baseline pins, accepts only existing active pins (retired pins or unknown ids exit non-zero with a clear message).

### Tested

Three-test matrix + dyad sweep recorded in commit message per [[fp-check-everything-with-real-tests]]:
- **Positive (detector)**: ternary aria-label carousel → emits both Previous + Next (2 hits). data-testid → preferred over aria-label. "Sign in" aria-label → url observation. 3/3 ✓
- **Negative (detector)**: button without selector → skipped. Button without onClick → skipped. Commented JSX → skipped. API route → skipped. 4/4 ✓
- **FP sweep (detector)**: 10 dyad repos, 445 component files, 3 candidates total — all real, 0 spurious.
- **Positive (record-interaction)**: real Playwright run against a local HTML server clicked an `[aria-label=ScrollDown]` button → observed `top=500,left=0`, persisted to registry, rewrote pin file, wrote regenerate-allow marker. 4/4 ✓
- **Negative (record-interaction)**: missing claim-id, unknown id, wrong template, no Playwright installed, invalid URL — all fail with specific actionable error. 5/5 ✓

## [0.2.16] — 2026-06-03

Backend GA proof packaging + identity-aware quarantine trigger + journey empty-state extraction + Playwright interaction adapter beta. Closes 4 of the items from the locked [[full-stack-roadmap-2026-06-03]] in a single batch.

### Added — `pinned sweep` command (red→green proof packaging)

Per locked [[pattern-driven-family-sweep]]: `pinned audit` is L0 (read-only); `pinned sweep` is L1 (read + pin). Walks the tree, runs precision-bound detectors (host-conditional + family, retroactive write-endpoints, retroactive journeys), groups multi-consumer findings into families with shared roots, prints a summary, and batch-confirms before writing pin files. Uses the existing `generateTest()` dispatcher so every shipped template improvement (schema-derived bodies, tier-1/2/3 safety net, etc) applies automatically.

Acceptance on socialideagen: sweep surfaces the host-conditional family (`lib/host.ts:resolveIdeaFromRequest` → 2 consumer routes), 3 journeys (admin-logout, confirm→thanks with `setsCookie: "SIGNUP_COOKIE"`, signup→thanks). User confirms once with `Y` and pin files land. At 6bf2c28 those pins go RED against a preview; at HEAD they go GREEN. Detection alone was not the demo — sweep IS the demo.

### Added — project-identity probe with auto `confidence:"review"` trigger

Completes the second half of the phantom-catch fix per the locked roadmap. `probeRunningDevServer` now does identity verification when the user adds an `http.identity_marker` to `.pinnedai/config.json` + an `http.identity_path` (defaults to `/__pinned/identity`). Probe hits the path; if the response carries `X-Pinned-Project: <marker>` header OR the body contains the marker, identity is `"verified"` and catches default to `confidence:"confirmed"`. If marker missing, mismatched, or 404, identity is `"config-only"` and the test runner is invoked with `PINNED_CATCH_CONFIDENCE=review` so any catches get auto-quarantined.

Opt-in by design — most users don't need it. Add when port collisions are likely (multi-project dev), or when running Pinned in CI against a self-hosted preview where identity matters. Full pattern documented in `docs/test-fixtures.md` with header + body response examples.

### Added — journey detector extracts empty-state UI markers → `bodyForbids`

Closes socialideagen bug #3 ("/thanks shows 'No signup found' when cookie isn't set") with structural detection. `extractEmptyStateMarkers()` scans page sources for empty-state UI text inside conditional branches: `<h1>No X found</h1>`, `<NoSignup />` / `<NotFound />` component-shape patterns (with internal heading extraction), `<h1>X not found</h1>` / `<h1>Sign in</h1>` / `<h1>expired session</h1>`. Precision-gated — text must appear inside an `if (!X) return` / ternary / `&&` conditional, not in marketing copy.

`detectRetroactiveJourneys` threads the extracted markers as `bodyForbids` on the page step. When auto-pinned via `pinned sweep`, the journey claim's page step asserts the markers don't appear in the rendered response. socialideagen example: signup→/thanks journey now auto-includes `bodyForbids: ["No signup found"]`. Three-test matrix (5/5 green) + FP sweep on 330 dyad pages: 1 true-positive marker extracted ("Sign in" from Ai-Book's Login.tsx), 0 false-positives.

### Added — Playwright interaction adapter (BETA, opt-in)

Per locked roadmap. Full-stack coverage extends to frontend interaction regressions (the carousel "arrows do nothing" class) by WRAPPING Playwright — never building a browser engine.

**New:** `pinned add-browser` opt-in installer with disclosure of install size (~300 MB) + consent prompt. Detects existing install; idempotent. Detects user's package manager (pnpm/yarn/npm). Installs `@playwright/test` as devDep then runs `npx playwright install chromium`.

**New:** `interaction-baseline` template. New `InteractionBaselineClaim` type wired through every exhaustive switch (claim union, dispatcher, claimRoute, claimKey, classifyPinStrength, describeClaimForUser, badCaseForClaim, summarizeClaimForBanner, describeClaim, preflight, coverageFromClaim, claimLabel, backtest path-relevance). The emitted test:
- **Dynamic-imports** `@playwright/test` so the file PARSES even without Playwright installed — the test just skips with a clear "run `pinned add-browser`" message.
- **Sets `PINNED_CATCH_CONFIDENCE = "review"`** at module load. Beta catches auto-quarantine via 0.2.15 metric machinery so they don't inflate the GA "regressions caught" headline.
- **WARNS instead of throwing** on baseline drift. Frontend flake is real; beta does NOT gate merges. The emitted drift path uses `console.warn` + `return`, never `throw`.
- **Attaches to the dev server** (never auto-boots, reuses scoped probe from 0.2.14).
- **Labels everything 🛟 BETA** in output, including a clear `pinned record-interaction` re-record command in the drift warning.

Observation kinds supported: `scroll-position`, `dom-text`, `url`, `element-count`. Actions: `click`, `scroll`, `type`, `press-key`.

Three-test matrix (4/4 green):
- Positive: emitted test carries all expected markers (BETA label, confidence:"review", playwright import, drift detection, scroll-position observation, baseline literal)
- Negative 1: no-baseline path emits a warn-only branch with re-record hint
- Negative 2: drift path uses `console.warn` + `return`, NOT `throw`
- CLI: `pinned add-browser --help` exposes the command with the right opt-in wording

**Roadmap status:** 4 of 5 items from the locked roadmap shipped in 0.2.16. Remaining: auto-detection of interaction pins (find onClick handlers on buttons + propose pins via sweep) — Phase 2.

### Internal

- New `extractEmptyStateMarkers(content)` exported from scanDiff.ts
- `FileAnalysis.emptyStateMarkers` added; threaded into `RetroactiveJourneyHit.steps[].bodyForbids`
- `probeRunningDevServer` return type adds `identity: "verified" | "config-only"`
- `InteractionBaselineClaim` added to claim union + wired through 13 exhaustive switches
- New template `apps/cli/src/templates/interactionBaseline.ts` with safe-by-default emission

## [0.2.15] — 2026-06-03

P0 follow-on to 0.2.14: the second half of the phantom-catch trust fix per the locked [[full-stack-roadmap-2026-06-03]]. 0.2.14 stopped phantoms at the SOURCE (probe only attaches to config.http.url). 0.2.15 adds a SAFETY NET so even if a future probe path or misconfigured PREVIEW_URL produces a catch against an unverified host, the resulting record doesn't inflate the GA "regressions caught" headline.

### Added — catch-confidence field + metric quarantine

New optional `confidence: "confirmed" | "review"` field on `CatchRecord`:

- **`undefined`** — legacy records (pre-0.2.15). Treated as confirmed for backward compat.
- **`"confirmed"`** — host was identity-verified for this project. Counts toward `breaksCaught` + the UserPromptSubmit hook's headline alarm.
- **`"review"`** — host attached but identity couldn't be confirmed. **PRESERVED in `catchHistory` for audit BUT EXCLUDED from `breaksCaught`** + the hook's headline. Surfaces in `pinned catches` with a 🔍 prefix and a `(review — not counted in lifetime catches)` suffix so the user knows to audit.

### Wiring

- `pinned test` now reads `PINNED_CATCH_CONFIDENCE` env var when recording a green→red transition. Defaults to `"confirmed"` (preserves current 0.2.14 behavior). Future versions will auto-set `"review"` when probe attaches without an identity-verification step.
- `caughtClaimIds` set (which derives `breaksCaught`) now only adds claim IDs when the catch is `confirmed`. Review-confidence records stay in `catchHistory` but don't bump the metric.
- A claim that gets a `review` catch first and a `confirmed` catch later DOES promote into `breaksCaught` (the audit history is monotonic).
- `pinned catches` listing renders `🔍 review` instead of `🛟` so the user can spot quarantined entries.

### Three-test matrix (4/4 green)

- **Positive** — 2 confirmed catches → `breaksCaught` 1 → 3 ✓
- **Negative** — 2 review catches → `breaksCaught` stays at 1 (quarantined) ✓
- **Mixed** — same claim review then later confirmed → now counts ✓
- **Dedup** — already-caught + new confirmed → still 1 (Set dedupe holds) ✓

### Roadmap status

Both halves of the P0 phantom-catch fix from [[full-stack-roadmap-2026-06-03]] are now shipped (0.2.14 = probe scope; 0.2.15 = metric quarantine). Next: identity probe that triggers `review` automatically when an attach can't be verified.

## [0.2.14] — 2026-06-03

P0 hotfix for a trust-damaging bug shipped in 0.2.12.

### Fixed — `probeRunningDevServer` no longer attaches to unrelated localhost servers

The target-resolution waterfall introduced in 0.2.12 (#79) probed ports 3000 / 5173 / 4321 / 8080 / 8000 indiscriminately and attached to whatever localhost server it found first. When a developer had ANY unrelated server up on those ports (another dyad project's Vite dev server, a Docker dashboard, a sleeping Next.js app), Pinned would attach to it, run the project's pin tests against the wrong app, and report bogus "🛟 Pinned caught a regression — N protected behaviors are failing" alerts via the UserPromptSubmit hook.

Confirmed in the wild on `pinnedai`'s own repo immediately after the 0.2.13 publish: 5 pins flagged as "failing" because an unrelated dev server on port 3000 returned 2xx for `/api/admin` instead of 401/403. The pins weren't broken; they were running against the wrong host.

**0.2.14 tightens probe scope:**

- Only attaches when `.pinnedai/config.json` has `http.mode: "local"` AND `http.url` set (the URL the user explicitly configured at `pinned init` time).
- If `http.mode` is `"off"` or `"preview"`, returns null even if a server is up at common ports.
- If `http.url` is unreachable, returns null cleanly (no fallback to other ports).

Trade-off: this removes the "fortuitously catches when they happen to have their dev server up" magic. Per [[retro-audit-zero-work-zero-anger]]'s L2 consent rung, attach only when configured, never via opportunistic port scan. Better to skip verification than verify against the wrong server and lie to the user.

### Added — `pinned catches --review <claim-id>` and `pinned catches --reset-phantoms`

For users who got phantom catches from 0.2.12 / 0.2.13:

- **`pinned catches --review <claim-id>`** — drop a single bogus catch from `catchHistory` + `caughtClaimIds` + `failingClaimIds`. Re-renders `CATCHES.md`. Pin file preserved.
- **`pinned catches --reset-phantoms`** — bulk cleanup. Drops every catch whose claimId is currently in `failingClaimIds`. Resets `status` to "green" and decrements `breaksCaught` accordingly. Run AFTER upgrading to 0.2.14 + verifying the failures aren't real by running pins against the actual configured `PREVIEW_URL`.

### Three-test matrix (this release)

Per the locked rule:

- **Positive**: `http.mode: local` + `http.url: http://localhost:7771` + server up at 7771 → attaches ✓
- **Negative 1**: no `.pinnedai/config.json` + stranger on port 3000 → returns null ✓ (was the bug)
- **Negative 2**: `http.mode: off` + stranger on port 3000 → returns null ✓
- **Negative 3**: `http.url` configured but unreachable → returns null cleanly ✓
- **CLI flags exposed**: `pinned catches --review` and `--reset-phantoms` both registered ✓

5/5 green. Live cleanup verified on `pinnedai` itself: 13 lifetime catches (5 phantoms) → 8 (real prior catches preserved).

## [0.2.13] — 2026-06-03

One addition on top of 0.2.12: the agent PostToolUse hook — THE activation wedge per [[agent-loop-activation-wedge]]. Plus the FP-check-everything memory rule upgrade to require positive + negative + dyad-sweep matrix for every feature ship going forward.

### Added — Agent PostToolUse hook (THE activation wedge)

Two new commands wire the agent-loop verification path:

- **`pinned install-claude-hook`** — registers Pinned as a PostToolUse hook in Claude Code's `settings.json` (project-local by default; `--global` writes to `~/.claude/settings.json` with its own confirmation per the consent ladder). Shows the exact `before`/`after` JSON diff + explains what the hook does + the safety contract BEFORE asking for `[y/N]`. Backs up the previous settings to `settings.json.pinned-backup`. Marker-bounded so `pinned uninstall` removes exactly Pinned's entry without touching any other PostToolUse hooks the user has configured (Cipherwake, custom tools, etc.).

- **`pinned hook-postedit`** — the runtime handler the hook calls. Reads Claude's tool-input JSON from stdin, identifies the file path(s) edited (Edit / Write / MultiEdit), maps them to routes via `deriveRouteFromPath`, looks up active pins covering those routes, probes for a running dev server, runs the affected pins via `vitest`, and writes a structured `🛟 pinned: …` line to stdout that Claude reads + surfaces in its next turn. Three observable outcomes:
  - **No pin covers the edited route** → soft suggestion: `"consider \`pinned check\` to add one"`.
  - **Pin exists, no dev server up** → soft note: `"start your dev server so Pinned can verify the next edit"`.
  - **Pin exists, dev server up, vitest run** → either `"✓ N guard(s) still pass"` (green) OR `"🛟 N guard(s) FAILED — your change broke a protected contract"` (red, with the failing pin names + repair-prompt pointer).

Safety contract (verified by smoke test):
- The hook NEVER crashes the agent — empty stdin, malformed payloads, missing pins, missing dev server all exit silently with code 0.
- The hook NEVER auto-starts the app — only attaches to an already-running localhost dev server (per [[retro-audit-zero-work-zero-anger]]'s L2 rung).
- The hook NEVER edits source files — read-only verification.
- 1-second stdin failsafe + configurable 15s vitest timeout prevent the hook from ever hanging the agent.

`pinned uninstall` now also removes the PostToolUse hook entry (marker-bounded via the `pinned hook-postedit` command string), leaving any other PostToolUse hooks in place.

### MCP 0.1.4

Dep refresh — `pinnedai-mcp` now bundles `pinnedai ^0.2.13` so MCPB / Smithery users get the full 0.2.12 + 0.2.13 batch (retro audit, family sweep, agent PostToolUse hook, dev-server attach, init-runs-once, watch verifies, retire cache cleanup, four-template static-verify softening, auth FP fix, schema-derived body across zod/yup/joi/valibot, journey capture step, fixture-token docs, host-conditional actionable suggestions, clean uninstall).

### Memory rule upgrade — three-test matrix required per feature

`fp-check-everything-with-real-tests.md` extended with operational rule that EVERY feature ship now requires:
1. Positive case (feature fires when it should)
2. Negative case (feature doesn't fire when it shouldn't)
3. FP sweep against the 10 dyad-apps repos (0 false positives or documented limitations)

Commit message must include the matrix results. Pure UX wiring (banner copy, prompt text) exempt; behavioral changes always require the matrix.

## [0.2.12] — 2026-06-03

Largest release this iteration — closes the M1/M2/M3/P2 roadmap blocks + the headline activation wedge + a pattern-driven family sweep.

### Added — `pinned audit` (the L0 activation, read-only retro scan)

THE first-touch experience per [[retro-audit-zero-work-zero-anger]]. `npx pinnedai audit` runs against any repo and surfaces:

- **Regressions ALREADY shipped** in recent git history that Pinned would have caught (host-conditional added, auth check removed, validation removed — all from existing precision-bound detectors)
- **Unprotected critical flows** (write endpoints, host-conditional handlers) with no Pinned coverage
- **Risk families** — single root cause spanning N route consumers, surfaced from one signal

Safety contract (verified): NO install, NO app execution, NO config writes, NO network egress beyond `git log` / `git show`. The lowest-friction, lowest-risk activation surface — Snyk/Sonar-style first touch. Replaces "install + manufacture a regression + watch it catch" with "point at my repo, see what already broke." Old `pinned audit --learned` is now `pinned audit-learned` (same flags, same behavior).

### Added — pattern-driven family sweep

Per [[pattern-driven-family-sweep]]: move protection from catch/diff-driven to PATTERN-driven. `pinned audit` now builds an import/usage graph + resolves multi-consumer risk families. When `host-conditional` fires on `lib/host.ts:resolveIdeaFromRequest`, the audit lists every route handler that imports that specific function — those routes share the divergence risk through the single root. Acceptance on socialideagen: detects host-conditional family + 3 route consumers at `6bf2c28`. New scanDiff exports: `buildImportGraph`, `findFamilyMembers`, `findAllImportersOfFile`, `extractExportedNames`. Host-conditional detector now also returns `affectedExport` (the exported function name containing the host-read) for precise family scoping.

### Added — auto-detect PREVIEW_URL via Vercel API + loud "0 verifying" banner

M1 from the locked agent-loop / never-silent roadmap. `pinned init` now: (1) reads `.vercel/project.json` + uses `VERCEL_TOKEN` to query Vercel's REST API for the latest preview deployment, (2) suggests it as the PREVIEW_URL the user should set, (3) prints a LOUD warning banner when no verification target is available so the user can never walk away thinking pins are running when they're skipping. Statusline upgrade: when ALL pins skip, surfaces `⚠ N pins · 0 verifying (no PREVIEW_URL)` in yellow; partial skip stays cyan.

### Added — `pinned init` runs pins once at the end (first value before they leave)

After init completes, automatically runs pin tests against an available target (PREVIEW_URL or a detected running localhost dev server) and shows the result inline — green or a real catch — in under 60 seconds. Never auto-boots the app (per [[retro-audit-zero-work-zero-anger]]'s consent ladder); only attaches to a server the user already has running.

### Added — attach to running dev server (never auto-boot)

L2 of the consent ladder. `pinned test` now probes localhost (via `.pinnedai/config.json` http.url, framework-default port, or common ports 3000/5173/4321/8080/8000) for an already-running dev server. If found, attaches and uses it as the PREVIEW_URL automatically. If not found, fails gracefully back to the existing "0 verifying" banner. Never spawns `npm run dev` unless the user explicitly opted into `http.mode: local` at init time.

### Added — `X-Pinned-Test: 1` side-effect-skip docs

Extended `docs/test-fixtures.md` with the `X-Pinned-Test` header pattern. Handler can detect the header and no-op real side effects (emails, queue messages, billing events, analytics writes) while still verifying the meaningful behavior. The header is public/no-secret; it controls suppression only, never authorization. Pairs with the existing `X-Pinned-Secret` pattern for privileged-data access.

### Added — journey capture step + interpolation

Per M2. New optional `capture: { name, from }` field on `JourneyStep` extracts a value from the step's response into a journey-local map. Later steps reference captured values via `${name}` interpolation in any string field (route, body, headers, expect assertions). `from` supports `body-json` (dot-path), `header`, `cookie`, and `redirect-location`. Catches confirmation-token-from-DB flows when paired with the fixture-token pattern.

### Improved — backend-not-configured → warn instead of fail (#84)

Happy-path's tier-2 body-marker check now relaxes to WARN when (a) the probe target is `localhost*` AND (b) the response is 503 OR contains a "backend not configured" / "env not configured" / "missing env" marker. The user is in dev mode, not a production-misconfigured mode — pointing them at `.env.local` is the right next step, not failing the pin. Real misleading-green (production target with `{skipped:true}`) still hard-fails.

### Fixed — auth-required false-positive on routing middleware

`detectAuthChecksInDiff` previously emitted an `auth-required` pin for any file containing `pathname.startsWith("/admin")` — including socialideagen's middleware.ts, which uses that check to ALLOW-LIST admin paths through (`return NextResponse.next()`), not GATE them. The path-startsWith patterns are now tagged WEAK; the detector requires a co-occurring CONFIRMER signal (401/403 status return, redirect to /login, session/cookie/token read, throw of an Unauthorized error) before treating the weak match as an auth signal. FP-checked: 0 hits on socialideagen's routing middleware (previously fired), still fires correctly on quantasyte (8 real admin checks) and quantapact (1 real `request.headers.get("authorization")`). 9 real hits across 1163 files, 0 false positives.

### Fixed — static-verify hard-fail on legitimate refactor (4 templates)

The four static-verify-bearing templates (`auth-required`, `idempotent`, `permission-required`, `returns-status`) all hard-failed when the captured source signature couldn't be found in the file — even if the behavior was preserved by a refactor. Trust-damaging on every legit lint/format/restructure commit. 0.2.12 softens: when `PREVIEW_URL` is set (live HTTP check is the real verification), signature-missing now WARNS via `console.warn` and the test passes. Hard-fail still applies when PREVIEW_URL is unset.

### Fixed — host-conditional warnings are now actionable

P2. When `pinned auto-protect` flags a host-conditional handler AND active pins exist for the same route, the warning now names the specific pin file(s) that will likely false-fail AND prints the exact `PREVIEW_URL=… npx vitest run …` command to verify. Closes the loop from "warning detected" → "concrete next step."

### Fixed — `pinned retire` now refreshes status cache + cleans catch history

M3. Pre-0.2.12, the retired pin's `catchHistory` entries + `caughtClaimIds` set + `failingClaimIds` all stayed in the cache after retire — so the UserPromptSubmit hook kept reporting the retired pin as a live catch ("this would have shipped..."), inflating `breaksCaught` with false-positive ghosts. 0.2.12: retire now (a) removes the claimId from `failingClaimIds`, (b) strips records from `catchHistory`, (c) removes from `caughtClaimIds` so `breaksCaught` (derived from set size) decrements, (d) re-renders `CATCHES.md` from the cleaned history. Headline metric stays honest.

### Added — `pinned watch` also verifies on file-quiet (#82)

The background watcher previously only ran `auto-protect` after file-quiet. 0.2.12 also probes for a running localhost dev server after each auto-protect cycle and, if one is up, runs `vitest run tests/pinned/` against it with a 30s cap. Surfaces RED catches in the watch output as they happen (`🔴 N pin(s) FAILED — Pinned caught a regression on watch verify`). Never spawns a server — only attaches to ones the user has running. Silent when no server is up (the watch's auto-pin role is unaffected).

### Added — `pinned uninstall` (clean complete removal, trust pass)

Per [[retro-audit-zero-work-zero-anger]]: *"people trust tools they know they can fully remove."* New command removes EVERY trace of Pinned from the project: hook blocks (pre-commit, pre-push, post-commit — marker-bounded removal preserves the user's own hook content), AI-coder rules blocks in CLAUDE.md / .cursorrules / .clinerules / AGENTS.md / .windsurfrules, Claude statusline entry (with compose-wrapper awareness — restores the third-party command if Pinned was composed alongside another tool), `.github/workflows/pinned.yml`, the `.pinnedai/` and `.pinned/` directories. Pin tests in `tests/pinned/` are PRESERVED by default; pass `--tests` to also remove them. Global writes (`~/.claude/settings.json` statusline, `~/.config/pinnedai/` prefs) require `--global`. Always shows what will be removed BEFORE deleting; asks for confirm (`--yes` skips for scripts). `--dry-run` previews without modifying anything. New `uninstallClaudeStatusline()` helper in claudeSettings.ts mirrors the install logic.

### Renamed — `pinned audit --learned` → `pinned audit-learned`

To free `pinned audit` for the headline retro-scan command (above). Same flags, same behavior — `--learned` is now a no-op on the new command (preserved for backwards compat). Existing scripts referencing `pinned audit --learned` should switch to `pinned audit-learned`.

### Internal

- New scanDiff exports: `buildImportGraph`, `findFamilyMembers`, `findAllImportersOfFile`, `extractExportedNames`, `deriveRouteFromPath`, plus `WEAK_AUTH_PATTERNS` + `AUTH_CONFIRMER_PATTERNS` for the auth tightening.
- `probeRunningDevServer(cwd)` private helper in cli.ts — probes localhost for a running dev server (read-only, never spawns).
- `detectVercelPreviewUrl(cwd)` private helper in cli.ts — reads `.vercel/project.json` + queries Vercel API with VERCEL_TOKEN.
- `uninstallClaudeStatusline(repoRoot)` in claudeSettings.ts — compose-wrapper-aware removal of Pinned's statusline entry.
- Memory updates (4 new entries): `tier-model-refinements-2026-06-02`, `agent-loop-activation-wedge`, `retro-audit-zero-work-zero-anger`, `pattern-driven-family-sweep`.

## [0.2.11] — 2026-06-02

Two trust-damaging false-positives fixed after a third dogfood pass on socialideagen.

### Fixed — auth-required false-positive on routing middleware

`detectAuthChecksInDiff` previously emitted an `auth-required` pin for any file containing `pathname.startsWith("/admin")` — including socialideagen's middleware.ts, which uses that check to ALLOW-LIST admin paths through (`return NextResponse.next()`), not to GATE them. The path-startsWith patterns are now tagged WEAK; the detector requires a co-occurring CONFIRMER signal in the same file (401/403 status return, redirect to /login, throw of an Unauthorized/Forbidden error, session/cookie/token read) before treating the weak match as an auth signal. FP-checked: 0 hits on socialideagen's routing middleware (previously fired), still fires correctly on quantasyte (8 real admin route checks) and quantapact (1 real `request.headers.get("authorization")` gate). Total: 9 real hits across 1163 files in 10 dyad-apps repos, 0 false positives.

### Fixed — static-verify hard-fail on legitimate refactor

The four static-verify-bearing templates (auth-required, idempotent, permission-required, returns-status) all hard-failed when the captured source signature couldn't be found in the file — even if the behavior was preserved by a refactor. Trust-damaging on every legit lint/format/restructure commit. 0.2.11 softens: when `PREVIEW_URL` is set (live HTTP check is configured), signature-missing now WARNS via `console.warn` and the test passes. The live check (unauth → 401/403, two POSTs → byte-identical, three-direction role check, status code match) is the authoritative verification of behavior; the static signature is a fallback for repos without live verification. When PREVIEW_URL is unset, hard-fail still applies — the signature is then the only verification available.

The repair-prompt message in the hard-fail case now tells the user: "set PREVIEW_URL so the live HTTP check becomes the verification; the static check will then warn-only."

### MCP 0.1.3

Dep refresh — `pinnedai-mcp` now bundles `pinnedai ^0.2.11` instead of `^0.1.0`. MCPB users (Smithery / Claude Desktop) get the full set of detectors / templates / fixes from the last 11 releases.

## [0.2.10] — 2026-06-02

Two fixes from the live walk-forward verification on socialideagen (which produced 7 real catches at the buggy commit 6bf2c28 vs the fixed HEAD).

### Added — yup / joi / valibot bodyShape extraction

`detectNewValidationSchemasInDiff` now extracts `bodyShape` (the per-field type + format + min hints) from yup, joi, and valibot schemas, not just zod. The complementary happy-path-with-side-effect pin can now ship a schema-satisfying body for routes guarded by any of the four major validation libraries. Library-specific method mappings:

- **yup**: `.email() .url() .uuid() .datetime() .date() .min(N) .integer() .positive() .oneOf([...])`. Requires `.required()` on the field entry (yup's default is optional).
- **joi**: `.email() .uri() .guid()/.uuid() .isoDate() .min(N) .integer() .positive() .valid(...)`. Same `.required()` requirement.
- **valibot**: `v.string([v.email(), v.minLength(N)])` style — sniffs the inner validator array for format + min. Skips fields wrapped in `v.optional(...) / v.nullable(...) / v.nullish(...)`.

Tested on all three libraries; the captured shape correctly drives the happy-path test's `buildValidBody()` so first runs satisfy the schema instead of 4xx-ing on missing fields.

### Fixed — `pinned init` crashed in git worktrees (ENOTDIR on `.git/hooks`)

Surfaced during the socialideagen walk-forward verification. In a git worktree, `.git/` is a FILE containing `gitdir: <main repo>/.git/worktrees/<name>`, not a directory. The hooks installer did `mkdirSync(path.join(repoRoot, ".git", "hooks"), { recursive: true })`, which threw ENOTDIR before any hook was written. 0.2.10 adds `resolveHooksDir(repoRoot)` which: (1) statSyncs `.git` to detect the worktree case, (2) prefers `git rev-parse --git-path hooks` for the canonical answer, (3) falls back to parsing the `.git` file's `gitdir:` line directly when git isn't on PATH. Hooks now install at the worktree's own hooks directory, hookPath + uninstallHook use the resolved path, behavior unchanged for regular repos.

## [0.2.9] — 2026-06-02

One addition on top of 0.2.8 — closes the socialideagen cold-walk-forward to 4/4 by adding a retroactive journey detector.

### Added — retroactive journey detector (closes walk-forward to 4/4)

The 0.2.8 journey parser + diff-pair detector both rely on EITHER a PR description OR a fresh diff to fire. Customers installing Pinned cold on an existing repo had neither — the multi-step contracts that single-step pins structurally miss (signup→thanks, confirm→thanks) stayed unpinned. `detectRetroactiveJourneys` walks the full repo during `pinned init`'s baseline pass and pairs existing route handlers with existing pages via two precision-bound signals:

1. **shared-session-module** — POST handler imports `writeXId` / `setXSession` / `setXCookie` from a module AND a page imports the matching `readXId` / `getXSession` / `getXUser` from the SAME module. Catches the contract "signup writes a session, /thanks page reads it back."

2. **redirect-target** — route handler emits a redirect to a page that exists, AND optionally captures `setsCookie` from `res.cookies.set(NAME, ...)` calls in the same handler. Catches "confirm redirects to /thanks?confirm=ok with a session cookie set."

Emitted via the config-invariant emission path (bypasses parseClaims) so rich pairing info (setsCookie, redirectIncludes captured from source) survives into the generated test. FP-checked: socialideagen produces 3 hits (signup→thanks, confirm→thanks, admin-logout→admin — all real journey contracts); 6 other dyad-apps repos produce 0 hits. **Walk-forward against socialideagen's known 4-bug commit (6bf2c28): retroactive happy-path catches #1 + #2 (signup/invite 400s on preview), retroactive journeys catch #3 + #4 (thanks "No signup found"; confirm cookie missing). 4/4 cold-walk-forward.**

## [0.2.8] — 2026-06-02

Five fixes from a second dogfood pass on socialideagen — the four production bugs the other Claude found ({POST /api/signup→400 on preview, POST /api/track/invite→400, GET /thanks "No signup found", GET /api/confirm cookie missing}) confirmed three structural gaps the 0.2.7 batch hadn't closed.

### Fixed — `breaksCaught` + `pinned catches` double-count

Cache transitioning green → failing → green (e.g. an all-skipped test run flipping status to "green") re-counted every currently-failing pin as a fresh catch. socialideagen run showed `breaksCaught: 6` for 3 unique pins (login/logout/middleware × 2 records). 0.2.8 derives `breaksCaught` from a dedupe-safe `caughtClaimIds` set (preserved in the cache) instead of incrementing on each transition. `pinned catches` listing + `CATCHES.md` render also dedupe by claimId with a "N issues · M events" footer when the record count exceeds unique count. Migration: caches without the new field re-seed from the existing `catchHistory`'s claim IDs — no count loss.

### Added — retroactive happy-path emission for existing DB-writing POST handlers

The 0.2.6 diff-detector only fired on routes ADDED in the current diff. Customers installing Pinned on an existing repo (the realistic adoption path) had all their real write endpoints already present — the detector silently skipped every one of them. socialideagen's signup / track/invite / track/view routes existed pre-Pinned, never got happy-path pins → 0/4 production-bug catches.

0.2.8 adds `detectRetroactiveWriteEndpoints` — a strict scanner (requires a recognized write shape, not just a method handler) that walks the full repo during `pinned init`'s baseline pass. Recognized write libraries:

| Library | Pattern detected |
|---|---|
| supabase-js | `supabase.from("X").insert/update/upsert/delete` |
| prisma | `prisma.X.create/update/upsert/delete` (incl. `createMany` / `updateMany`) |
| drizzle-orm | `db.insert/update/delete(X)` (also `tx.insert(...)` inside transactions) |
| kysely | `db.insertInto("X")` / `db.updateTable("X")` / `db.deleteFrom("X")` |
| mongoose | `Model.create(...)`, `new Model(...).save()`, `Model.updateOne(...)` |
| raw SQL | `INSERT INTO X`, `UPDATE X SET`, `DELETE FROM X` inside `db.execute()` / `sql\`...\`` |
| resend / sendgrid / nodemailer / aws-ses / postmark | their send / sendMail / sendEmail methods |
| bullmq / inngest / generic queue | `queue.add()`, `inngest.send()`, `jobs.enqueue()` |

FP-checked: 3 hits on socialideagen, all real (signup/track-invite/track-view); 0 hits on 6 other dyad repos that lack handler-level writes. README documents the full pattern table so customers know when happy-path will vs won't auto-emit. Diff path also uses the captured write target — `supabase.from("user_profiles").insert(` gives `targetGuess: "user_profiles"`, not the route-segment pluralization guess.

### Improved — louder PREVIEW_URL prompt in `pinned init`

Per dogfood debrief: "Nothing verifies without PREVIEW_URL — prompt hard for it at init; catch rate is 0 without it." Init's HTTP-mode prompt now (a) opens with a ⚠ banner explaining that every HTTP-shaped pin will skip without an HTTP target, (b) cites the 0/4 dogfood evidence directly, and (c) re-prompts when the user picks "skip" — single y/Enter confirms, anything else loops back to mode selection. The off-mode explainLine is also louder: "⚠ HTTP testing: OFF — every HTTP pin will SKIP."

### Added — multi-step journey auto-detection (parser + diff pair)

Two new paths for journey claims, both bypassing the v0.3 deferral:

**(a) Natural-language parser** — two regex patterns:
- `X then Y` / `X → Y` / `X -> Y` / `X followed by Y` (post-second-step prose extracts `bodyIncludes` / `bodyForbids`)
- `After X, Y` / `Once X, Y` (leading-clause form)

Both extract:
- Step 1 method+route
- Step 2 method (defaults to GET) + route
- bodyIncludes from `shows "X"` / `displays "X"` / `returns "X"` / `renders "X"` / `includes "X"`
- bodyForbids from `without "X"` / `no longer shows "X"` / `does not show "X"` / `missing "X"` + bare `without X` for short noun phrases

FP-tested: 4 positive cases pass, 2 negative cases (rate-limit / validation descriptions) correctly produce zero journey claims.

**(b) Diff-side pair detector** — `detectJourneyPairsInDiff` — when a new POST endpoint (with recognized writeShape) AND a new page are added in the same diff AND share at least one of {write target name appears in page route, write target name appears in page handler, write route segment appears in page route}, emit a journey candidate pairing the two. Catches the bug class socialideagen #3 lived in: "signup wrote a row, but /thanks page didn't read the new row back."

Wired into `auto-protect` as an `ask` candidate (heuristic body assertions want a review before they're auto-pinned).

### Wired

- `caughtClaimIds: string[]` added to `LastStatus` type
- `WriteShape` type + `detectWriteShape()` + `detectRetroactiveWriteEndpoints()` in scanDiff.ts
- `DiffNewPostEndpointHit.writeShape?` field
- `DiffJourneyHit` + `detectJourneyPairsInDiff()` in scanDiff.ts
- Journey parser appended to `parseClaims()` end (post-existing-templates, dedupe via `journey:<label>:<steps>` key)
- AutoProtect imports + journey-pair emission path
- README documents the recognized write-shape table

## [0.2.7] — 2026-06-02

Six closure fixes from a single dogfood debrief — the "0/4 catches on existing repo" finding on socialideagen pointed at structural gaps the prior 0.2.x releases didn't close. All fixes ship in one batch per the [[dont-defer-buildable-fixes]] rule.

### Added — sanctioned-write marker for auto-protect (closes self-fighting hook)

`pinned auto-protect` (when invoked from the pre-commit hook) now writes a `.pinnedai/regenerate-allow.json` marker recording the sha256 of each file it just modified (`.registry.json`, `PINS.md`, and any newly-authored `*.test.ts`). The subsequent `check-guard-removal` step honors the marker and skips violations on files matching the recorded sha. Before 0.2.7, the hook called its own writes "AI tampering" — `git commit` was blocked any time auto-protect added a pin, with the documented bypass (PINNEDAI_ALLOW_PIN_EDIT=1) as the only escape hatch.

### Added — `--auto-stage` flag replaces blanket `git add`

The pre-commit / pre-push hooks previously ran `git add tests/pinned/ 2>/dev/null || true`, silently bundling ANY change in `tests/pinned/` into the user's commit (including unrelated pin edits in flight). 0.2.7 replaces it with `pinned auto-protect --auto-stage`, which stages ONLY the specific files Pinned just authored this run AND prints a one-line notice listing them. Unrelated tests/pinned/ changes stay where the user left them.

### Improved — tier-1/2/3 assertion pattern applied to all live-HTTP templates

The happy-path-with-side-effect refactor (tier-1 mandatory status + tier-2 body marker + tier-3 SOFT header) is now applied to every other live-HTTP template that had the same wrong-direction or wrong-dimension foot-gun:

- **idempotent** — added body-marker check on the first call. Two byte-identical `200 { error: "..." }` responses no longer falsely satisfy the equality assertion.
- **page-renders** — added a SOFT_404_MARKERS list (Next.js default 404 body, `<title>404</title>`, "Page Not Found", etc.). A deleted route returning 200 with a not-found page no longer passes.
- **validation-rejects-bad** — added 404/405/501 disambiguation so deleting a route doesn't silently satisfy "endpoint rejects bad input" (404 is technically in the 4xx range but the route is GONE, not validating).
- **permission-required direction-3** (right-role → 2xx) — added body-marker check. Same close as happy-path tier-2.
- **auth-required direction-2** (authed → 2xx) — same body-marker check. A handler that accepts the token but returns `{ error: "..." }` no longer passes the over-tightening direction.
- **returns-status** — both fixes: 404/405/501 disambiguation when expected is 4xx (clearer failure message when the route is gone), AND body-marker check when expected is 2xx.

Six templates, identical structural risk to the one happy-path round caught. After this batch, the entire live-HTTP template family carries the same safety net.

### Added — schema-derived `bodyShape` for happy-path-with-side-effect

`detectNewValidationSchemasInDiff` now also extracts per-field type/format from the route's zod schema (string vs number vs email vs url vs uuid vs cuid vs date vs datetime, plus min length / int / enum / literal / array). When auto-protect emits the complementary `happy-path-with-side-effect` candidate, the extracted shape rides along on the claim. The generated test's `buildValidBody()` then ships a body that **satisfies** the schema (`pinned-test@example.com` for `z.string().email()`, padded string for `.min(N)`, first enum value for `z.enum([...])`, etc.) instead of a placeholder that 4xx's on first run. Closes the "happy-path pin fails immediately because the customer's schema needs real fields" foot-gun. zod only in 0.2.7; yup/joi follow the same shape, planned for v0.3.

### Added — multi-step `journey` template

New template covering bug classes single-route pins structurally miss: signup-then-`/me`-returns-new-email, login-then-`/dashboard`-renders-without-warnings, checkout-then-order-detail-page-shows-items. Walks N HTTP steps with a shared cookie jar so session-bearing journeys carry state between steps. Per-step assertions: `status` (exact or range), `bodyIncludes`, `bodyForbids`, `setsCookie`, `redirectIncludes`. Tier-2 misleading-green markers (`{ error }`, `{ skipped: true }`, `{ degraded: true }`) checked per-step automatically. Wired into all the exhaustive switches (claim type, dispatcher, claimSlug, claimRoute, claimKey, classifyPinStrength, describeClaimForUser, badCaseForClaim, summarizeClaimForBanner, describeClaim, preflight, coverageFromClaim, claimLabel, backtest path-relevance) AND added to the LLM SYSTEM_PROMPT (entry #8) so cloud-LLM / BYOK customers extract journey claims from natural-language PR descriptions. Auto-detection from diff is deferred to v0.3.

### Added — host-conditional detector

New diff detector flags route handlers that read `req.headers.get("host")` / `req.hostname` / `c.req.header("host")` / `headers().get("x-forwarded-host")` AND gate behavior on the captured value. This is the "works in prod, broken in preview" failure pattern — Pinned probes against PREVIEW_URL, the handler takes its non-prod branch, the happy-path pin false-fails. v0.2.7 surfaces as a WARNING in `pinned auto-protect`'s output (not an auto-pin — the customer's right response varies). FP-checked against 1208 files across 10 dyad-apps repos: initial version had 5/10 false positives (URL parsing, client-side env, SSRF allowlist code); tightened version has **0 false positives, 1 true positive** (socialideagen's `resolveIdeaFromRequest` — exactly the divergence pattern).

### Added — retroactive auto-detect coverage (the #1 buyer blocker)

`pinned init`'s baseline pass now runs the three v0.2.5/v0.2.6 diff-aware detectors (`detectNewPostEndpointsInDiff`, `detectNewPagesInDiff`, `detectNewValidationSchemasInDiff`) against the **current state of every file in the repo**, not just diff-added lines. The killer-demo path *"install on my existing repo → it pins my real endpoints"* now works. Before 0.2.7, an existing-codebase adopter got only `scanDiffFull`'s suggestions (auth surfaces, lockfile, etc.) — business-critical happy-path / validation / page contracts stayed unpinned. Confirmed cost: 0/4 production bugs caught on a real repo today.

### Added — three new templates wired into the LLM proposer (`SYSTEM_PROMPT`)

`page-renders`, `validation-rejects-bad`, `happy-path-with-side-effect` now appear in `apps/cli/src/llmDirect.ts`'s `SYSTEM_PROMPT` as numbered claim shapes 5/6/7. Before 0.2.7, customers using `PINNEDAI_BYOK=anthropic` (or any other BYOK provider) couldn't extract the new templates from natural-language PR descriptions — silent coverage gap. Now they can. Locked in [[new-templates-need-both-deterministic-and-llm]] memory rule: every future template MUST be wired into BOTH paths in the same release.

### Added — `/api/confirm`-style routes added to `isLikelyPublicEndpoint`

Token-bearing public routes (`/api/confirm`, `/api/verify`, `/api/unsubscribe`, `/api/magic-link`, `/api/reset-password`, `/api/forgot-password`, `/api/invite-accept`, `/api/opt-in`, `/api/opt-out`) no longer false-fire as `auth-required` candidates. The URL token IS the auth — these routes correctly accept anonymous requests with a signed token in path/body. Caught on socialideagen 2026-06-02 as a false-positive auto-pin.

### Improved — loud messaging when most/all pins skipped

`pinned guard` previously said *"⊘ Some pins SKIPPED"* in a tone that read as "almost-PASS." It isn't — pins that skip silently provide zero protection. Now:

- **`fullyInactive`** (all pins skipped, none passed) — banner reads: *"⚠ NOT VERIFYING — all N pin(s) skipped this run. Pinned is providing ZERO protection right now. REVIEW is NOT 'almost-PASS'."* Plus the PREVIEW_URL fix line.
- **`mostlyInactive`** (≥50% skipped) — *"⚠ MOSTLY NOT VERIFYING — N of M pin(s) skipped (X%)."*
- **Some skipped** (< 50%) — same as before but cleaner counter.

### Improved — Next.js 405 skip message calls out the Allow-header quirk

The auth-required template's 405-no-Allow-header skip path now explicitly notes that Next.js's default 405 response omits the Allow header (not a Pinned bug, framework behavior). Agents/devs reading the warning understand this is the COMMON case on Next.js POST-only routes, not an edge case.

### Added — 3 new acceptance fixtures

`audit/positive-controls/` now has three additional bug→fix fixtures from GPT's list:

- `03-url-literal-typo/nextjs-api-base/` — staging URL accidentally shipped to prod → fix locks the prod URL. `url-literal-preserved` should fire.
- `04-missing-export/auth-index/` — barrel re-export of `signIn` was forgotten → consumers got runtime undefined → fix adds the re-export. `module-export-stable` / `package-exports-exist` should fire.
- `05-tsc-clean/strict-implicit-any/` — implicit-any parameter in strict-mode `tsconfig.json` → fix adds the type annotation. `tsc-clean` should fire.

### Locked memory rules from today's session

- `dont-defer-buildable-fixes` — never defer a 1-2 day fix; reserve deferral for >1-week infra blockers
- `new-templates-need-both-deterministic-and-llm` — every template ships in BOTH paths in the same release (with full checklist)

## [0.2.6] — 2026-06-02

Closes the remaining v0.2.0 auto-detector gap — `page-renders` and `validation-rejects-bad` now also auto-fire on the diff that introduces them, matching what 0.2.5 did for `happy-path-with-side-effect`. All three workhorse templates from Claude session feedback (named in 0.2.0) now reach customers via auto-protect, not just explicit claims.

### Added

- **`detectNewPagesInDiff()`** in `scanDiff.ts` — scans the diff for new Next.js app-router page files (`app/<path>/page.tsx`) + pages-router files (`pages/<path>.tsx`, `pages/<path>/index.tsx`). Excludes `_app.tsx`, `_document.tsx`, `404.tsx`, `500.tsx`, `pages/api/*` (not user-facing pages). Requires a top-level export to fire. Emits a `page-renders` candidate with `decision: "safe"` (no customer setup needed; the test just GETs the path).
- **`detectNewValidationSchemasInDiff()`** in `scanDiff.ts` — scans the diff for new `z.object({ ... })`, `yup.object({ ... .required() })`, `Joi.object({ ... .required() })` schemas on POST/PUT/PATCH/DELETE handlers. Extracts the list of required field names (correctly excludes `.optional()` / `.nullable()` / `.nullish()`). Emits a `validation-rejects-bad` candidate with `decision: "safe"` and the extracted field list — each becomes a missing-field sub-test in the emitted pin.
- **Shared `splitTopLevelCommas()` helper** for the schema body parser — handles nested parens correctly so `z.string().min(3)` doesn't false-split.
- **13 unit tests** in `diffDetectors.test.ts` covering: Next.js app router pages, pages-router files, nested routes, root page, exclusions (`_app`, `_document`, `pages/api/*`, test files), zod with optional fields, yup with `.required()`, GET-only route rejection.

### Why ship all three auto-detectors together (instead of "deferring" 2 of 3)

Per the [[dont-defer-buildable-fixes]] memory rule locked earlier this session. Original 0.2.0 ship was the wrong call — should have included all three auto-detectors as one batch. This release closes that gap so we don't accumulate more day-one incidents like 0.2.0's POST /api/signup 400 → "deferred to 0.2.1" → prod regression cycle.

### Impact

A new Next.js app with a typical structure (a few pages + API routes + zod schemas) now gets pinned automatically on first `git commit` after `pinned init` — no manual claims, no manual schema annotations, no AGENT SETUP REQUIRED prompts (except where the X-Pinned-Side-Effect header is needed for happy-path verification).

## [0.2.5] — 2026-06-02

Auto-detect new POST/PUT/PATCH/DELETE endpoints and auto-pin them with happy-path-with-side-effect. Closes the gap that let a 400 regression ship on `/api/signup` in socialideagen yesterday: the v0.2.0 happy-path template existed but only fired on explicit claims, never on auto-protect. Now any new mutating endpoint gets a pin candidate automatically.

### Added

- **`detectNewPostEndpointsInDiff()`** in `scanDiff.ts` — scans the staged diff for new `export async function POST/PUT/PATCH/DELETE` declarations in route-handler files (Next.js app router primary, pages router + Express/Fastify-style `.post()` calls also recognized). Returns one hit per new endpoint with:
  - `route` — derived from the file path (`app/api/signup/route.ts` → `/api/signup`)
  - `method` — POST/PUT/PATCH/DELETE
  - `targetGuess` — pluralized last segment (`signup` → `signups`, `box` → `boxes`, `category` → `categories`)
  - `suggestedPin` — human-readable claim text for PINS.md
- **Wired into `autoProtect.ts`** — each new endpoint becomes a `happy-path-with-side-effect` pin candidate with `decision: "ask"` (customer needs to add the `X-Pinned-Side-Effect` wrapper before the pin can verify side-effects; the pin's repairPrompt includes the wrapper code).
- **8 unit tests** in `diffDetectors.test.ts` covering: Next.js app router POST/PATCH/DELETE, Express-style `router.post`, pluralization rules, FP rejection of utility files / test files / GET-only routes, dedup across single diff.

### Impact

Two real prod incidents in one day on socialideagen would have been auto-caught:
- 400 regression on `POST /api/signup` → pin asserts `2xx + X-Pinned-Side-Effect: db-write target=signups`
- Idea-resolver bug on `POST /api/track/invite` → pin asserts `2xx + X-Pinned-Side-Effect: db-write target=invites`

Both endpoints would have been auto-pinned at commit time (with the AGENT SETUP REQUIRED prompt for the wrapper). Customer's AI fills in the wrapper, pins fire, regressions get blocked at CI before they ship.

### Notes

- After upgrading to 0.2.5, run `pinned regenerate --all` to re-emit existing pins. New auto-pins land on the next `pinned init` or `git commit` that touches a route file.
- Target-guess pluralization is best-effort; customer can override during AGENT SETUP REQUIRED.
- `decision: "ask"` (not "safe") because the wrapper setup is a non-trivial code change. Customer confirms before pin lands.

## [0.2.4] — 2026-06-02

Claude Code statusLine compose-instead-of-clobber. Claude Code only supports ONE `statusLine.command`. When two tools both install statusLine setups, whichever runs LAST wins — the other gets silently shadowed. A customer running both Pinned and any other Claude statusLine-using tool (Cipherwake, custom shell, etc.) used to see only one badge, not both.

### Added

`pinned init` now detects an existing third-party `statusLine.command` in `.claude/settings.json` and writes a small POSIX `sh` wrapper at `.pinnedai/statusline-combined.sh` that runs **both** commands and joins their outputs with `" · "`. Claude's settings get pointed at the wrapper. The wrapper:

- Runs each producer in a subshell with stderr discarded → silent tools don't break the chain
- Joins outputs only when both are non-empty → no dangling separators
- Self-marks with `# pinnedai:statusline-compose` so future re-runs detect their own wrapper and don't double-wrap
- Re-runs of `pinned init` rewrite the wrapper if Pinned's bin path changed but leave the "other" command alone (idempotent)
- Falls back gracefully — if either tool emits nothing, the other still renders

Net effect: install Pinned, then install Cipherwake (or any other statusLine-using tool), re-run `pinned init` → you see **both** badges in your Claude statusline (`◆ pinned · N guards · ✓ · 🛟 cipherwake · pass`). No manual wrapper script needed.

`isClaudeStatuslineInstalled()` updated to recognize both the direct command AND the compose-wrapper path as "Pinned installed."

## [0.2.3] — 2026-06-02

`.pinnedai/` auto-gitignored. `.pinnedai/` holds transient state (the regenerate-allow marker from 0.2.2, BYOK creds in `byok.json`, the cache directory, `.last-auto-test`, `.last-status.json`) — none of it should be committed; some of it would be a security or correctness bug if it were (committed BYOK creds → leaked API keys; committed regenerate marker → CI could bypass the guard hook for any matching file).

- **`pinned init` adds `.pinnedai/` to `.gitignore`** for fresh installs.
- **`pinned regenerate` also auto-adds it** on every run. Existing installs (from before 0.2.3) get the fix the first time they upgrade and regenerate — no manual action.
- **Shared `ensureGitignored(pattern)` helper** — idempotent, exact-line match (won't false-positive on `.pinnedai.bak/`).

### Added

- **`pinned init` adds `.pinnedai/` to `.gitignore`** for fresh installs. `.pinnedai/` holds transient state (the regenerate-allow marker, BYOK creds in `byok.json`, the cache directory, `.last-auto-test`, `.last-status.json`) — none of it should be committed; some of it would be a security or correctness bug if it were.
- **`pinned regenerate` also auto-adds `.pinnedai/`** to `.gitignore` on every run if missing. Existing installs (from before 0.2.3) get the fix the first time they upgrade and regenerate — no manual action required.
- **Shared `ensureGitignored(pattern)` helper** — idempotent, safe-append, no-ops if the pattern is already covered. Used by init + regenerate. Easy to extend to other transient state in future releases.

### Notes

- The gitignore append uses an exact-line regex (with optional leading `/`), so `.pinnedai/` matches both `.pinnedai/` and `/.pinnedai/` but doesn't match unrelated rules like `.pinnedai.bak/`.
- No change to existing `.gitignore` content if `.pinnedai/` is already there — safe to re-run.

## [0.2.2] — 2026-06-02

Fixes the foot-gun introduced in 0.2.1: `pinned regenerate --all` succeeded then told the user to run `git add tests/pinned/ && git commit`, but the pre-commit hook (correctly, by design) refused that commit because the pin files were modified. The hook couldn't tell *"modified by `pinned regenerate` (sanctioned)"* from *"modified by AI weakening (forbidden)"*. The only workaround was `PINNEDAI_ALLOW_PIN_EDIT=1 git commit ...` — a documented bypass that turns off ALL guard-removal protection, not just the regenerate-related changes.

### Added

- **`pinned regenerate` writes a short-lived `.pinnedai/regenerate-allow.json` marker** containing each regenerated filename + its sha256 + a 5-minute TTL + a unique runId. The pre-commit hook (`pinned check-guard-removal`) reads the marker and lets through modifications whose CURRENT on-disk sha256 matches the recorded one. AI tampering on top of a sanctioned regenerate (sha256 won't match) still gets blocked. Expired markers fall through to normal protection. No env-var bypass needed.
- **Updated `pinned regenerate` success message** to reflect the new flow: *"Now commit — the pre-commit hook will recognize these as sanctioned changes (via .pinnedai/regenerate-allow.json; auto-expires in 5 min)."* Removes the misleading instruction.

### Why marker over env-var or auto-commit

- **Env-var bypass** (`PINNEDAI_ALLOW_PIN_EDIT=1`) turns off ALL protection — too broad. AI tampering done in the same commit as a legitimate regenerate would slip through.
- **Auto-commit** (`pinned regenerate --commit`) skips the user's review step. Some pin changes need human eyes (e.g. a template that wraps a route name into the test code might pick up a typo).
- **Marker file** is sha256-bound to exactly the bytes regenerate wrote — so it can ONLY authorize those specific changes, can't be exploited as a general bypass, auto-expires in 5 min so it doesn't leak.

### Why .pinnedai/ for the marker

`.pinnedai/` is already in `.gitignore` from `pinned init` (alongside `byok.json`, `cache/`). The marker file is transient local state — must NOT be committed, otherwise a CI run with an old marker file could bypass the hook.

## [0.2.1] — 2026-06-02

Structural fix for the *"library upgrades don't reach existing pin files"* problem. Pin .test.ts files are self-contained artifacts in the customer's repo (the moat is permanence) — they're frozen at the version they were generated under. Before 0.2.1, a template-bug fix in a newer pinnedai release **did not apply to existing pins**. Customers post-upgrade saw the same false-catches as before. This release fixes that.

### Added

- **`pinned regenerate <claim-id>` and `pinned regenerate --all`** (alias: `pinned regen`). Reads each pin's claim from `.registry.json` and re-emits the `.test.ts` file using the CURRENT template generator. `--dry-run` shows what would change. After upgrading pinnedai, **run `pinned regenerate --all`** to apply any template-bug fixes that landed in the new version to your existing pins. If you don't, the old pins keep running the old (buggy) emitted code.
- **`// generated-by: pinnedai@<version>` stamp** in every newly-emitted pin file. Injected by the dispatcher in `apps/cli/src/index.ts:generateTest()`, so all 25 templates get it without per-file edits.
- **Stale-pin warning in `pinned guard`.** When the guard runs against a `tests/pinned/` directory containing pins generated by an older pinnedai (or pins without a `generated-by` stamp), it warns: *"N pin(s) generated by older pinnedai (current: X.Y.Z). Run `pinned regenerate --all` to apply current templates."* Non-blocking; just informational so users discover the fix path.

### Fixed

- **`pinned check` dropped-claim tip** now shows concrete example phrasings (rate-limit / auth-required / page-renders / validation / happy-path) instead of telling users to "run `pinned check` with no args for examples" — that referenced an older behavior. Surfaced by the Claude dogfood session.

### Notes for upgrading from 0.1.x / 0.2.0

The two false-positive bugs flagged on 0.1.1 (auth-required GET-vs-POST + wildcard middleware URL concat) were fixed in template code in 0.1.2 and 0.2.0 respectively — but those fixes only affected NEWLY-generated pins. If you have auto-protect pins from before 0.2.1, **run `pinned regenerate --all`** now to apply the fixes to them. Otherwise the same false-catches keep firing.

## [0.2.0] — 2026-06-02

Three workhorse templates from Claude session feedback — the contracts a real app actually wants pinned. FP-checked on 10 dyad-apps repos (0 false positives) and TP-checked against Claude's verbatim phrasings (3/3 match) plus 9 natural variants (8/9 match — the 1 miss is "creates a new entry" which has no extractable target name).

### Added

- **`page-renders` template** — *"GET /path renders without crashing."* GETs the route with `Accept: text/html`, asserts 200/304 + non-trivial HTML body + no React/Next/Vite render-error markers (`Application error: a client-side exception`, `__NEXT_ERROR_CODE`, `Cannot read prop`, `[vite] Internal server error`, `[Vue warn]`, etc.). Default min body 500 bytes (configurable per pin). Auth-gated pages re-use `authResponseIsValid` so login-redirect / login-form / 401/403 don't false-fail. Parser matches: `GET /path renders`, `GET /path renders without crashing`, `Page /path renders`, `/path should render`, `GET /path should load`, `/path returns a working page`. Includes the root path `/`.

- **`validation-rejects-bad` template** — *"POST /api/X with bad input returns 400."* One pin, N sub-tests: malformed-JSON + one per required field (missing). Each sub-test asserts the endpoint returns 4xx. Parser matches: `POST /api/X requires fields A, B, C`, `POST /api/X needs fields A, B`, `POST /api/X validates body`, `POST /api/X must reject invalid email`, `POST /api/X with bad input returns 400`, `POST /api/X with invalid email returns 400`. Fallback to malformed-JSON-only when no required fields are extracted.

- **`happy-path-with-side-effect` template (Option C — `X-Pinned-Side-Effect` header)** — *"POST /api/X creates a users record."* Asserts the endpoint returns 2xx AND emits `X-Pinned-Side-Effect`, `X-Pinned-Side-Effect-Target`, `X-Pinned-Side-Effect-Id` response headers when `X-Pinned-Test: 1` is set on the request. The endpoint emits these only on test-marked requests (zero prod impact) via a ~5-10 LOC wrapper the customer's AI agent adds. Failure prompt includes the framework-specific wrapper code so Claude can self-install it. Catches the misleading-green case where a refactor stubs out the side-effect and keeps returning 200. Parser matches: `creates a users record`, `writes to users`, `inserts into users`, `with valid body returns 200 + writes a row to users`. Target-word filter ("a", "an", "the", "new", "row", "record", "entry") prevents false targets from filler words.

### Notes

- **Auto-protect-on-commit detectors for these three templates are deferred to v0.2.1.** Today's release adds parser support + template generators — they fire when explicit claims are written (Claude session writing structured claim text, or PR descriptions using the new phrasings). Diff-based auto-detection (new `app/page.tsx` → page-renders pin, new zod schema → validation pin, new POST endpoint with DB call → happy-path pin) is a separate piece of work coming next.

- The `X-Pinned-Side-Effect` wrapper is a new convention. Docs page at https://pinnedai.dev/docs/x-pinned-side-effect (to be added). The wrapper is ~5-10 LOC and framework-agnostic — Next.js / Express / Fastify / Hono all use the same shape.

## [0.1.2] — 2026-06-02

Hotfix release for two day-one trust-burning bugs surfaced by real dogfooding on a fresh Next.js project (socialideagen). FP-checked against quantasyte before publish per the new "no detector / template change ships without a real-codebase FP-check" rule.

### Fixed

- **auth-required pin no longer false-catches POST-only routes.** Generated tests previously sent a GET to whatever route was captured. Routes that correctly accept only POST/PUT/DELETE (login, logout, signup, etc.) returned 405 Method Not Allowed, which the validator interpreted as "not 401/403 = regression catch." Now: when the live test gets 405, it reads the `Allow` response header, retries with the first non-GET/HEAD/OPTIONS method (with `content-type: application/json` + `{}` body), and uses the retry response for the auth verdict. If no Allow header is present, logs a warning and skips the assertion instead of false-failing — *missed catches are recoverable; false catches erode trust*.
- **auth-required pin no longer attempts to fetch wildcard routes.** Auto-protect captures middleware-wide auth as `route = "* (middleware)"`. The previous live-direction code built `PREVIEW_URL + "* (middleware)"`, which `fetch()` rejected as a malformed URL, surfacing as a noisy `PINNED_INFRA_FAILURE`. Now: a new `routeIsFetchable()` guard skips the live HTTP direction when the route is wildcard / non-`/`-prefixed / contains whitespace. The static-mode check (which verifies the auth signature is still present in the middleware source) still runs — that's the real catch path for wildcard pins anyway.

### Why this matters

The Claude session that flagged these wrote: *"on a properly-built Next.js app, 0 of 3 auto-pins verified on the live deploy."* That's the day-one experience for a modal new user. Both fixes are unambiguous code bugs, not design calls. FP-tested by generating real pins via `pinned generate` and grepping the emitted test code for the new guards.

### Tier-model / pricing — unchanged

Local-first + Free remains. No quota changes. v0.2 hosted-AI work continues per the tier-model-final memory.

## [0.1.1] — 2026-06-01

Friction fixes from real Claude-Code dogfooding on a fresh project.

### Fixed

- **Silent parser failure on unrecognized claims.** When `pinned check --description "claim A. claim B. claim C."` only matched 1 of 3, the output said `Found 1 claim(s)` — read as 1/1, not 1/3. Now: `Recognized 1 of 3 claim(s). 2 dropped — no template matched their phrasing:` followed by each dropped line verbatim. `--json` payload includes a `dropped` array so the GitHub Action / PR-comment workflow / agent flows surface them too. The `pinned generate` command surfaces them too. New `parseClaimsWithDiagnostics()` export; `parseClaims()` unchanged for backwards compat.

### Changed

- **`auth-required` template now accepts three response shapes** instead of demanding bare 401/403. Modern apps that redirect-to-login (3xx with `Location` matching `/login|signin|auth/`) or render a login form inline (200 with `<input type=password>` + sign-in copy) are now valid — pins no longer false-fail because the app prioritized UX. Existing 401/403 still works. Embedded `authResponseIsValid()` validator in every generated `auth-required` pin. Failure prompt explains which shape was missing.
- **`pinned show` (alias `pinned describe`) now prints "This pin FAILS if: ..."** — a plain-English failure scenario per template, so developers don't have to read the generated test file to understand what the pin actually asserts. 23 templates each get a tailored one-liner ("`/api/admin` starts serving protected content without auth", "`pnpm-lock.yaml` content drifts", "`apps/api/oauth.ts` reverts to the old URL value", etc.).
- **`pinned init` post-success output now leads with auto-protect**, not manual `pinned check` claim writing. The old "Try it: pinned check --description ..." framing misled users into thinking they had to handcraft claim text. New text opens with: *"✓ Auto-protection is wired — just commit normally. Pinned does the work."* Manual claim flow demoted to "If you want to pin a behavior from a PR description manually:" further down. Documents the Claude Code statusline launch-dir caveat.

### Deferred to 0.2

- **No-op / graceful-skip detection** for misleading-green pins (when an endpoint returns `200 {ok:true,skipped:true}` because env was unset and the pin asserts only the status). Needs design — wrong implementation makes pins flaky.

## [Unreleased]

### Roadmap notes (not yet built)

- **v0.2 — OSS LLM as free-tier backup (self-hosted on founder's GPU)**: instead of hard 429 when aggregate budget hits cap, route overflow to a Llama 3.1 / Qwen 2.5 model running on a dedicated GPU desktop via Ollama + Cloudflare Tunnel. Per-call cost: effectively $0 (electricity only). Trades premium gpt-4o-mini quality + latency for the guarantee that the free tier never truly cuts off. Pro tier stays on OpenAI premium. Work involved: eval suite to validate structured-extraction quality matches gpt-4o-mini, Worker fallback logic, Tunnel setup.
- **v0.2 — Bug Scout**: flag claims about *missing* protections (e.g., "this endpoint takes user input but no input-validation pin exists"). Active prompt to add pins, not passive detection.
- **v0.2 — Async / DB / perf templates**: extend the library family with async-function-returns, db-schema-invariant, perf-budget templates.
- **v0.2 — Both-direction tightening on existing templates**: add at-cap (rate) + below-cap (1 req → 2xx) assertions to rate-limit, with-auth positive case to auth-required, with-good-input positive case to returns-status. Each one needs FP calibration from real-world preview-deploy data before it's safe to ship by default.
- **v0.2 — tier-cap + uniqueness templates**: needs DB fixture conventions and bulletproof state cleanup.
- **v0.3 — Mutation testing for pin quality**: grade each generated pin by running it against deliberately-mutated source code (Stryker-style). Proves the pin would actually catch what it claims to guard.
- **v0.3 — Stripe webhook integration**: replace the manual `POST /admin/subscription` provisioning with automated subscription lifecycle.

### Added (v0.1 catch-rate + Guardrail positioning round)

- **Day-zero pin verification at `pinned generate`** — every newly-written pin runs against the customer's current code immediately. Double-confirmed (re-run failing files after 500ms gap) so flakes don't fire false catches. Per-template preflight skips silently when PREVIEW_URL is unreachable / module file missing / vitest not installed.
- **`permission-required` template** — role-based access control with three independently skipIf-gated directions: no-auth → 401/403, wrong-role token → 403, right-role token → 2xx. Parser recognizes 5 phrasings ("X requires admin role", "X is admin-only", "Only admin can access X", "admin-only on X", "Restricts X to admin"). Closes the #2 AI regression class after plain auth.
- **Pin coverage mapping** — every pin's `.registry.json` entry now carries `covers: { routes?, files? }` derived at generation time from the claim shape. New `findTouchedPins()` intersects the current git diff with existing pin coverage. New statusline state: `◆ pinned · N pins · REVIEW · 1 touched` (amber) fires when the working tree edits a guarded route or file.
- **`X-Pinned-Test: 1` header convention** — every Pinned-generated HTTP request sets it. Documented in AGENT.md so customers' rate-limit / billing-tier / analytics code can exclude Pinned traffic. Single biggest false-positive mitigation lever.
- **Retry-with-backoff in web templates** — `pinnedFetch` helper embedded in every generated web test retries transient 502/503/504 + network errors up to 2× with 500ms × attempt backoff. Eats cold-start preview false-positives.
- **`bugFixOrigin` claim tagging** — parser detects bug-fix vocabulary ("fix", "regression", "no longer", "bypass", "race condition", "edge case", "prevent", "should not", "must not") in the PR body and stamps every extracted pin. Bug-fix-origin pins surface first in PINS.md with 🔁 tag — they encode specific failure modes the original PR documented, so they're disproportionately likely to catch future regressions.
- **`bad_case` field on every pin** — plain-English description of the specific scenario the pin guards against. Embedded in generated test failure messages, surfaced in CATCHES.md ledger entries, threaded into the chat-hook celebration. Replaces test-name jargon with human-impact framing ("an unauthenticated request to /api/admin/export returned 2xx instead of 401/403").
- **`tests/pinned/CATCHES.md` ledger** — written on every confirmed catch. Carries the bad_case, original PR provenance, bug-fix-origin 🔁 tag, lifetime catch count. The customer-visible "Pinned has saved me N times" evidence ledger that compounds over time.
- **Multi-tool AI rule install** — `pinned init --auto` now writes the Pinned rule block to **all detected AI rule files simultaneously** (CLAUDE.md + .cursorrules + .clinerules + AGENTS.md + .github/copilot-instructions.md). Devs using Claude Code + Cursor + Copilot get coverage in every AI's context in one command.
- **`--from-agent="<consent>"` flag on `pinned init`** — audit-trail capture for AI agents running install on a user's behalf. Writes structured entry to `~/.config/pinnedai/install-prefs.json` with consent text, agent fingerprint (Claude Code / Cursor / Copilot / CI), timestamp. Compliance paper trail.
- **VS Code extension (`apps/vscode-extension/`)** — status bar item + command palette integration for Cursor / VS Code / VSCodium users. Shells out to `pinned statusline` CLI. Built to publish to both OpenVSX (Cursor) and VS Code Marketplace. Full publish checklist in `apps/vscode-extension/PUBLISHING.md`.
- **`⊘ N skipped (no preview)` statusline state** — surfaces when the last `pinned test` run had pins that couldn't actually verify (no PREVIEW_URL / preview down / missing module). Replaces silent ✓-when-skipped which was misleading about protection status.
- **`✓ N verified` alive counter** — calm-green state now shows the auto-incrementing `verifiedStreak` (consecutive successful test runs). Climbs naturally on every commit, resets only on a real catch. Solves the "✓ looks dead" UX without nag noise.
- **Landing "Bugs Pinned catches" section** — 6 concrete bug scenarios (security / money / access / data / abuse / breakage) with the "what ships without Pinned" cost line and the "how Pinned catches it" mechanism. Social-proof framing.

### Changed (v0.1 catch-rate + Guardrail positioning round)

- **Positioning shift to "Guardrail" framing** across landing page, CLI README, root README, and CLAUDE.md. Hero: "Permanent guardrails for AI-coded apps." Subhead: "Pinned remembers the promises your app must keep — auth, billing, rate limits, webhooks, permissions, and critical flows — and blocks future AI edits from quietly breaking them." Locked vocabulary: "pin" stays as the verb / file noun in all product surfaces; "promises" and "guardrails" appear only in marketing prose.
- **Catch chat-hook reframed** from `⚠ Pinned: N failing` (warning) to `🛟 Pinned caught a regression` (save framing). Includes bad_case for each currently-failing pin so the AI agent communicates concrete impact ("Without Pinned, this would have shipped: <bad_case>") instead of a test-name list. Tells the AI to double-confirm before changing code — protects against flake-triggered "fixes."
- **Statusline trim** — removed `N to review` (passive backlog nag) and `active editing` (git already tells you that). Kept `REVIEW · N touched` (diff-aware, actionable: your AI just edited a guarded file) and added `✓ N verified` calm-green counter.
- **PINS.md ordering** — bug-fix-origin pins surface first, tagged with 🔁 + a legend explaining why.
- **All web templates use `pinnedFetch` instead of raw `fetch`** — auth-required, rate-limit, idempotent, returns-status, permission-required all route through the shared helper for header + retry behavior.
- **`unionClaims` + `claimKey` extended** for `permission-required` (route + role identity).
- **Role-required PR phrasings now generate `permission-required` pins** instead of plain `auth-required` (previously the role was captured but discarded). Customers without role-fixture env vars get equivalent direction-1 (no-auth → 401) behavior via skipIf; adding fixtures over time expands catch coverage without retiring pins.

### Audits (v0.1 catch-rate round)

- New audit files: J (dir containment), K (vscode-extension build), L (coverage mapping), M (day-zero verify FP contract), N (FP-mitigation infra), O (bug-fix detection + bad_case), P (permission-required), Q (statusline trim), R (CATCHES.md + chat-hook).
- Expanded `audit/e2e/fake-project-dogfood.sh` with 5 new scripted phases (11-15) exercising day-zero verify skip behavior, bug-fix tagging, permission-required generation, X-Pinned-Test header presence, and CATCHES.md persistence.
- Test surface: **357 feature audits passing** (up from 295 at start of this round; +62 new tests across 9 new audit files), **184 CLI unit + integration tests passing**, **4 Worker tests passing**, **15-phase fake-project E2E green**.

### Added (earlier in the [Unreleased] window)
- `cli-output-contains` template — pin claims like `` `pinned doctor` outputs `tests/pinned/ directory` ``
- `cli-exits-zero` template — pin claims like `` `pinned init` exits 0 ``
- `cli-creates-file` template — pin claims like `` `pinned init` creates `tests/pinned/.registry.json` ``
- `cli-flag-supported` template — pin claims like `` `pinned check` supports `--json` flag ``
- `library-returns` template — pin claims like `` `parseConfig()` in `src/config.ts` returns `{"version": 1}` ``
- `examples/` directory with PR descriptions + generated tests for all 8 templates
- BYOK opt-in via `byok: anthropic|openai` action input + `PINNEDAI_ANTHROPIC_KEY` / `PINNEDAI_OPENAI_KEY` secrets
- `/v1/plan` Worker endpoint — verifies subscription plan via OIDC without burning LLM quota
- `pnpm dogfood:pins` — runs pinnedai's own pins via root vitest config
- Worker aggregate budget cap (`FREE_BUDGET_TOTAL_PER_MONTH`) — hard cost ceiling regardless of growth

### Changed (earlier in the [Unreleased] window)
- **Pin counts are now unlimited at every tier** (was 25/repo on Free in v0.0.x drafts). Free differentiates on monthly LLM-call volume, not pin count.
- Free-tier monthly LLM-call caps: 500/mo public repos, 100/mo private repos (was 100/mo all repos)
- License-key authentication removed entirely. Identity is the OIDC `repository_owner` claim. Customers pay via Stripe + provide GitHub org name on checkout.
- `PINNEDAI_LICENSE_KEY` env var is now inert and will be removed in v0.2

### Removed
- Local license-key validation (`isFreeTier()`, `hasValidLicenseFormat()`, `LICENSE_KEY_RE`)
- `/admin/license` Worker endpoint (replaced by `/admin/subscription`)
- Auto-discovery of `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` env vars (now requires `PINNEDAI_`-prefixed names for explicit opt-in)
- Statusline `N to review` + `active editing` states (passive nag without actionable signal; replaced by diff-aware `REVIEW · N touched`).

## [0.0.1] - 2026-04-30

### Added
- Initial scaffold — placeholder package on npm to reserve the name. No published functionality.
