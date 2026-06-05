# PinnedAI

> **One command finds every high-stakes write surface in your AI-built app — Server Actions, paid-API calls, Supabase Edge Functions, cron handlers, Stripe webhooks, multi-step journeys, host-conditional families — and pins them as permanent regression tests. Plus first-time bug catching: enum drift, missing env declarations, undeclared Supabase columns, webhook header typos, unguarded `.find()` results, response-shape mismatches — all caught at the moment they're written, before any baseline exists. They run on every commit and every agent edit.**
>
> *Free beta · Founder Pro waitlist open at [pinnedai.dev](https://pinnedai.dev).*

## The value loop

1. **`npx pinnedai audit`** — read-only inventory of your write surfaces. Zero install footprint. Tells you what Pinned would protect before you commit to anything.
2. **`pinned sweep`** — one command auto-detects every high-stakes surface across your tree (not just the current diff): Server Actions, paid-API calls, Edge Functions, cron schedules, Stripe webhook event dispatch, multi-step journeys, host-conditional families. Each becomes a `tests/pinned/*.test.ts` file.
3. **`pinned init`** — wires hooks: pre-commit + pre-push Guard Integrity blocks AI-weakening attempts (`.skip()` / weakened assertions / deleted tests / `--no-verify` bypass). Claude Code PostToolUse hook auto-verifies pins against your running dev server after every agent edit — *while the agent is still in the loop, not after the PR*. AI-coder rules seeded into `CLAUDE.md` / `.cursorrules` / `AGENTS.md` so Cursor / Claude / Copilot read them before editing.
4. **Every commit + every agent edit** runs the pin suite. Bug fixes captured as `pinned record-server-action` / `record-interaction` fixtures land in your repo permanently.
5. **AI Lessons** (`.pinned/ai-lessons.md`) capture repo-specific rules from real blocked events. `pinned audit --learned` finds sibling code paths with the same mistake pattern.

The output of every finding is an **executable test**, not a review comment. Cancel Pinned tomorrow and the pins stay.

**Proof it works**: see the [`/proof` page](https://pinnedai.dev/proof) for benchmark results, or [Status](#status) below for headline numbers. Real dyad-app dogfood: 63 detections across 10 repos, 0 spurious; 42 unprotected Edge Function writes surfaced on a single repo.

---

## Quickstart

```bash
# 0. See what Pinned would protect — read-only, no install footprint
npx pinnedai audit

# 1. Auto-detect every high-stakes write surface and pin it
npx pinnedai sweep

# 2. Wire continuous verification (hooks + AI-coder rules + CI workflow)
npx pinnedai init
```

`pinned sweep` finds (precision-bound, no false positives in 10-repo dogfood):
- **Server Action mutations** (`"use server"` functions with DB writes / file uploads / paid-API calls — auth gate + input schema captured)
- **Paid-API calls** (Anthropic / OpenAI / Gemini / Stripe — model literal + max_tokens preserved)
- **Supabase Edge Functions** (Deno runtime — HTTP-route detection misses these)
- **Cron handlers** (Vercel `vercel.json:crons[]` + GitHub Actions `on.schedule`)
- **Stripe webhook event dispatch** (case-literal preservation — catches one-letter typos)
- **Multi-step journeys** (POST→GET redirects, signup→thanks flows with shared session)
- **Host-conditional families** (one root file → multiple consumer routes)

`pinned init` writes `.github/workflows/pinned.yml`, creates `tests/pinned/` with `PINS.md`, installs pre-commit + pre-push hooks, seeds AI-coder rules into `CLAUDE.md` + `.github/copilot-instructions.md`, and (for Claude Code users) wires the PostToolUse hook so Pinned auto-verifies pins against your running dev server after every agent edit. Each step prompts before writing in interactive mode; pass `--auto` to accept all.

If your repo already has `.cursorrules`, `.clinerules`, `AGENTS.md`, or `.windsurfrules`, init writes to those too — same marker-bounded block, identical uninstall flow (`pinned uninstall-agent-rules`).

---

## Editor + AI-tool surfaces

Pinned ships across every major AI-coder surface:

| Surface | What you get | How to install |
|---|---|---|
| **VS Code / Cursor / Windsurf / Codium** | `◆ pinned · N guards · ✓` in the status bar, rich hover tooltip with recent guards + latest AI lesson, click → Quick Pick (action chooser) → command runs in a Pinned-managed terminal. Works in stock VS Code (Copilot users), Cursor, Windsurf, Codium. | Bundled `.vsix` auto-installs during `pinned init` (until we publish to the Marketplace + Open VSX in v0.1.1) |
| **Claude Code** | **PostToolUse hook** — after every Claude edit, Pinned auto-verifies the affected pins against your running dev server and injects the result into Claude's next turn (catches regressions *while the agent is still in the loop*). Plus statusline (`◆ pinned · LEARNED · 1 new AI mistake`), UserPromptSubmit hook (transient block-event messages), `/pinned-status`, `/pinned-list`, `/pinned-review`, `/pinned-done` slash commands. | PostToolUse hook auto-wired by `init`; slash commands via `npx pinnedai install-claude` |
| **GitHub Copilot Chat (free + paid)** | Reads Pinned rules from `.github/copilot-instructions.md` before generating code | Auto-created during `init` |
| **MCP-aware tools (Claude Desktop, Cline, Continue)** | `pinned_before_code_change`, `pinned_before_done_check`, `pinned_scan_diff`, `pinned_list_guards`, `pinned_check_pr_description`, `pinned_suggest_init` as native tools with structured `human_summary` + must-report `agent_instruction` fields | Add `pinnedai-mcp` to the tool's MCP config — see [docs/integrations/](./docs/integrations/) |
| **GitHub Action (CI)** | Runs `pinned test` (all sweep-emitted pins) + `pinned check-guard-removal` on every PR. Guard weakening attempts AND functional regressions fail CI. | Auto-wired via `.github/workflows/pinned.yml` from `init`, or use the [Marketplace action](https://github.com/marketplace/actions/pinnedai) directly |
| **Pre-commit + pre-push hooks** | Block bypass attempts locally before they reach CI | Auto-wired by `init` |

Per-tool integration docs:

- [docs/integrations/cursor-rules.md](./docs/integrations/cursor-rules.md)
- [docs/integrations/windsurf-rules.md](./docs/integrations/windsurf-rules.md)
- [docs/integrations/claude-code.md](./docs/integrations/claude-code.md)

## README badge

```markdown
[![Pinned protected](https://pinnedai.dev/badge.svg)](https://pinnedai.dev)
```

---

## Pin templates

Each template is a deterministic verifier — the LLM never writes test logic, it only fills slots. Templates auto-fire from `pinned sweep` based on what the detectors find in your tree. The full inventory:

### 🆕 First-time bug catching (0.2.22+)

Every other Pinned template catches **regressions** — bugs that appear when previously-good code breaks. This category catches bugs **at the moment they're written**, before any baseline exists. All static (no creds, no runtime probes).

- **`enum-drift`** — consumer reads `x === "done"` but in-repo producer only emits `"completed"/"failed"/"processing"`. The socialideagen-dogfood-shape bug. Two confidence tiers: confirmed (≥1 vocabulary overlap, auto-pin) and review (zero overlap, soft signal — cross-table column collisions or cross-repo external producers).
- **`env-required`** — code reads `process.env.X_API_KEY` but `.env.example` / `vercel.json` env / `next.config.js` env block / `wrangler.toml [vars]` doesn't declare it. Cloned-repo first-runs and deploys silently get `undefined`.
- **`supabase-column`** — `.from("X").select("col_a, col_b")` against a Supabase table where one of the columns isn't in `supabase/migrations/*.sql` or `database.types.ts`. Runtime error on first query.
- **`expected-header`** — webhook handler reads `x-stripe-signature` (wrong) when the Stripe SDK signs with canonical `stripe-signature`. Signature verification silently fails on every request. Provider catalog: Stripe / GitHub / Svix / Twilio / Shopify.
- **`nullable-result`** — `arr.find(...)` / `.match()` / `.exec()` result used without null guard in **server-side route handlers** (`route.ts` / `*.actions.ts` / `supabase/functions/`). First edge-case input crashes the route with a 500.
- **`response-shape`** — consumer reads `body.referralCode` from a `fetch("/api/X")` response, but the producer's `NextResponse.json({...})` never emits that key. Generalizes the enum-drift bug class to JSON-key mismatches in same-repo HTTP routes.

### HTTP / API surface
- **`page-renders`** — *"GET /path renders without crashing."* Catches React/Next/Vite render errors + 500 pages + broken SSR.
- **`validation-rejects-bad`** — *"POST /api/X with bad input returns 400."* One pin, N sub-tests (malformed-JSON + per-field missing).
- **`happy-path-with-side-effect`** — *"POST /api/X creates a users record."* Catches stub endpoints returning 200 without doing the work (misleading-green) via the `X-Pinned-Side-Effect` response header convention.
- **`auth-required`** / **`permission-required`** / **`tier-cap`** — auth gates + role checks + per-tier caps survive.
- **`rate-limit`** / **`idempotent`** — rate limiters + webhook dedup keys preserved.
- **`returns-status`** — `<method> <route> returns <status> on <condition>` — auto-generated from added validation schemas in diffs.

### App-Router + modern mutation surfaces (0.2.18+)
- **`server-action-write`** — `"use server"` mutations with DB write / file upload / paid-API call. Direct-invoke pin with `vi.mock()` for the auth helper — runs the success path AND the reject path so AI silently *removing* the auth gate is caught (not just bypassing it).
- **`paid-api-call`** — Anthropic / OpenAI / Gemini / Stripe calls anywhere in the codebase (not just inside Server Actions). Captures the call expression + **model literal** (catches `claude-opus` → `claude-haiku` silent swaps) + **max_tokens cap** (catches unbounded-spend regressions).
- **`edge-function-write`** — Supabase Edge Functions at `supabase/functions/<name>/index.ts` (Deno runtime — HTTP-route detection misses these). Three-tier auth posture: confirmed (recognized helper) / ambiguous (auth-shaped signals but unrecognized — soft warn) / none (truly bare endpoint — loud alarm).
- **`cron-handler`** — Vercel `vercel.json:crons[]` entries + GitHub Actions `on.schedule[].cron`. Catches silent schedule drift (`0 4 * * *` → `0 4 * * 0`, runs once a week instead of daily) + handler renames.
- **`stripe-event-handled`** — Stripe webhook `switch (event.type) { case "X": ... }` dispatch. Catches AI silently typoing `"checkout.session.complete"` (one-letter rename), merging fallthrough arms dropping one, or wholesale deleting a case. Signature still verifies — paying customers never get provisioned.

### Multi-step + family-shaped
- **`journey`** — multi-step flows (signup→thanks, login→dashboard) with shared session. Catches "step 1 succeeds but step 2 silently regresses" — single-route pins structurally miss these.
- Family detection (host-conditional) — one root file → multiple consumer routes. A change to the root pins all consumers as a group.

### Browser interactions (🛟 BETA — opt-in)
- **`interaction-baseline`** — Playwright records the observable effect of an interaction (carousel arrow click → scroll position, submit button → URL change). Catches `onClick` handler regressions that go undetected because the page still renders.
- **`page-accessibility`** — axe-core via Playwright. Catches WCAG-AA contrast failures + invisible text — the *"page renders but is unreadable"* class that page-renders pins go GREEN on. WARN-only on violations; `confidence: "review"` so catches don't inflate the GA metric.

### Repo integrity
- **`lockfile-integrity`** / **`config-invariant`** / **`package-exports-exist`** / **`module-export-stable`** / **`import-path-resolves`** / **`tsc-clean`** — lockfile sha + critical config keys + module exports + import resolution + TS build all stay intact.
- **`url-literal-preserved`** / **`changed-literal-preserved`** — URLs in code + bug-fix literals don't regress.
- **`webhook-handler-exists`** — webhook handler signatures preserved.
- **`react-route-registered`** — internal `<Link href="/foo">` / `navigate("/foo")` resolve to a real page file.
- **`secret-not-public`** — no `NEXT_PUBLIC_*SECRET*` leaks, no `.env` commits, no debug routes exposed.
- **`form-submit-error-handling`** — async error-handling on form submits stays wrapped.

### CLI / library tooling
- **`cli-output-contains`** / **`cli-exits-zero`** / **`cli-creates-file`** / **`cli-json-shape`** / **`cli-flag-supported`** — for CLI tools and binaries.
- **`library-returns`** — a library function still returns the expected shape.

The detectors are precision-bound: every pin emit has a specific signal, never a generic shape match. The 10-repo dyad dogfood produced **0 false positives** across 63 detections.

### Recognized write libraries

`happy-path-with-side-effect` + `server-action-write` + `edge-function-write` auto-fire on these write shapes (both in new diffs AND retroactively via `pinned sweep`):

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
| supabase-storage / aws-s3 / cloudflare-r2 / vercel-blob | `storage.from(BUCKET).upload`, `PutObjectCommand`, `env.BUCKET.put`, `@vercel/blob put` |
| Anthropic / OpenAI / Gemini / Stripe (paid API) | `messages.create/parse/stream`, `chat.completions.create`, `responses.create`, `images.generate`, `embeddings.create`, `generateContent`, `checkout.sessions.create`, `billingPortal.sessions.create`, `paymentIntents.create`, `charges.create` |

The widened Supabase client-identifier vocabulary recognizes `admin.from(...)`, `db.from(...)`, `userClient.from(...)`, `serviceClient.from(...)`, etc. — not just the literal `supabase` identifier. Confirmed across 42 Edge Functions on the MediniDyad dogfood repo.

If your repo uses a write library not yet recognized, the pin won't auto-fire — open an issue with the import pattern. Adding a row is two regex lines.

## What Pinned protects

Pinned focuses on AI-prone failure modes. Categories grow with each release:

### 🆕 First-time bugs (no regression baseline needed — 0.2.22+)

The bug class where consumer + producer never agreed, OR the configuration was wrong from line 1. Other detectors miss these because there's nothing to regress from.

- **Enum-value drift** — client reads `status === "done"` but producer emits `"completed"` (the socialideagen dogfood bug).
- **Undeclared env vars** — code reads `process.env.X` but `.env.example` / `vercel.json` env / `next.config.js` env / `wrangler.toml` doesn't list it. Cloned-repo first-runs and deploys silently get undefined.
- **Undeclared DB columns** — code queries `.from("X").select("col_a, col_b")` against a Supabase table where the column doesn't exist in migrations or `database.types.ts`.
- **Webhook header typos** — handler reads `x-stripe-signature` (wrong) when Stripe SDK signs with `stripe-signature` (canonical). Silent verification failure on every request.
- **Unguarded `.find()` / `.match()` results in route handlers** — first edge-case input crashes the route with a 500.
- **Response-shape mismatches** — consumer reads a JSON key the producer never emits.

### App-Router + modern mutation surfaces
- **Next.js Server Actions** — `"use server"` functions that perform writes (DB / file upload / paid API) with auth gate + zod input schema captured. Direct-invoke verifier with `vi.mock()` for the auth helper runs success path AND reject path → catches silent gate removal too.
- **Paid-API calls (anywhere)** — model string preserved (no silent `claude-opus` → `claude-haiku` swaps), `max_tokens` cap preserved (no unbounded-spend regressions), call expression preserved (no silent removal). Fires on plain backend services, library helpers, anywhere — not just Server Actions.
- **Supabase Edge Functions** — Deno-runtime functions invisible to HTTP-route detection. File-existence + write expression + auth-gate idiom all preserved. Three-tier auth posture so soft-warns don't bury truly bare endpoints.
- **Cron handlers** — Vercel `vercel.json:crons[]` + GitHub Actions `on.schedule`. Schedule drift (`0 4 * * *` → `0 4 * * 0`, daily vs weekly — same shape, very different behavior) + handler renames caught.
- **Stripe webhook event-type dispatch** — every `case "<event-name>":` arm preserved. One-letter typo / merged fallthrough / deleted case fails the pin even though the signature still verifies.

### Auth / access
- **Auth gates** — `requireAuth` / `requireAdmin` / middleware matcher coverage; the middleware-aware pin uses `middleware.ts`'s captured auth signature so removing the check fails the guard.
- **Permission roles** — per-role + per-tier caps preserved.
- **Client / API mistakes** — missing `authHeaders()`, missing `credentials: "include"`, lost `if (!res.ok)` gates, removed 401/402/403 handling.
- **Webhook signature verification** — `stripe.webhooks.constructEvent`, `x-hub-signature-256`, `svix.verify`, `twilio.validateRequest`, generic `crypto.createHmac("sha256", ...)`. Removing the verify call fails the pin.

### Visual / usability (🛟 BETA — opt-in)
- **WCAG-AA contrast / invisible text** — axe-core via Playwright. Catches the "page renders but is unreadable" class (white-on-white text shipped 3 times in real dyad-app dogfood) that plain page-renders pins go GREEN on.
- **Interaction baselines** — Playwright records the observable effect of a click / scroll / type. Catches `onClick` handler regressions.

### Repo integrity
- **Guard weakening** — `.skip()`, `.only()`, `xit()`, `.todo()`, `.skipIf(true)`, deleted tests, weakened assertions (`toBe(401)` → `toBeTruthy()`), `|| true`, `?? true`, `catch(() => true)`, `expect(true).toBe(true)` tautologies, commented-out `expect()`, `expect.assertions(0)`, early `return;` in test body.
- **Pinned-infrastructure tampering** — deletion of `tests/pinned/*`, `.github/workflows/pinned.yml`, `tests/pinned/.registry.json`, `.pinned/ai-lessons.md`, or sneaky rename-to-retired/ without the matching `.audit.json`.
- **Route / export / reference integrity** — internal `<Link href="/foo">` / `navigate("/foo")` / `router.push("/foo")` that resolve today are pinned; future removal of the target page file fails the pin.
- **Module exports** — package.json `exports`, named exports from libraries, import-path resolution.
- **Lockfile + config invariants** — pnpm-lock.yaml sha + critical config keys preserved.

### Public exposure
- **Secrets in client bundle** — `NEXT_PUBLIC_*SECRET*` / `NEXT_PUBLIC_*KEY*` leaks.
- **No-fixture checks** — `.env` committed without `.gitignore` coverage, `.map` files in `dist/`/`build/`, debug routes (`__debug`, `__test`, `debug.html`, `/admin/console`).

---

## AI lessons

Pinned writes repo-specific lessons to `.pinned/ai-lessons.md` (markdown for humans) and `.pinned/lessons.json` (structured for tools).

Each lesson is generated from a real event — a blocked bypass attempt, a replay-verified bug-fix guard, or a confirmed sibling audit. Dedupe is per `guardId`: repeat attempts append evidence to the existing entry, not duplicate sections.

Example:

```md
## Don't weaken client-getReport-authHeaders

<!-- pinned:guard=client-getReport-authHeaders kind=guard-block -->

**Past mistake:**
weakened: src/api/getReport.ts — `headers: await authHeaders()` removed in PR #88

**Rule:**
Do not remove `authHeaders()` from `src/api/getReport.ts`. Fix the application code instead.

**Guard:** `client-getReport-authHeaders`

**Plain English:** don't drop authHeaders() from API calls
```

Point your AI coder at this file with `pinned install-agent-rules` so Claude/Cursor reads the rules before editing.

---

## Commands

### Setup

```bash
npx pinnedai init                    # one-time per repo
npx pinnedai install-agent-rules     # opt-in: wire CLAUDE.md/.cursorrules/etc. to read .pinned/ai-lessons.md
npx pinnedai uninstall-agent-rules   # undo the above
npx pinnedai agent-rules             # show which agent files are wired
```

### Daily workflow

```bash
npx pinned test                      # run the pin suite
npx pinned status                    # see active pins + recent events
npx pinned context                   # print the AI-coder context (rules + lessons) for inline prompting
```

### Discovery

```bash
npx pinned scan-diff                 # show what Pinned would auto-protect in the current diff
npx pinned audit --learned           # scan sibling code paths for risks matching learned patterns
npx pinned probe-admin               # enumerate admin/internal routes + their protection state
npx pinned list                      # list all active + retired pins
npx pinned show <pin-id>             # what a pin asserts + what would make it fail (alias: `describe`)
npx pinned regenerate --all          # re-emit all pin .test.ts files using the current templates — run this after upgrading pinnedai to apply any template-bug fixes to existing pins (alias: `regen`)
```

### Lifecycle

```bash
npx pinned retire <claim-id> --reason="..."   # legitimate retirement (writes audit entry)
```

### Reporting + analytics (local-first)

```bash
npx pinned report                              # per-detector dashboard, severity-sorted + 7-day trend + per-AI-model breakdown
npx pinned report --json                       # full schema for piping into your own tooling
npx pinned analytics status                    # show whether hosted analytics is opt-in
npx pinned analytics enable                    # opt-in to cross-repo + per-model dashboards at app.pinnedai.dev (Pro+)
npx pinned analytics disable                   # flip off; local stats keep working
npx pinned analytics upload                    # manual one-shot upload (or auto-fires on every `pinned sweep` when enabled)
```

Local data lives in `.pinned/repo-stats.json` (per-detector hit counts, severity ranking, per-AI-model rollup, bounded samples, 7-day snapshots). Free tier gets the full local dashboard. Hosted analytics is opt-in only — never auto-uploads. Uploaded data is structured to exclude source code, file contents, and secrets; only counts + sample file-paths + line-numbers + plain-English summaries get sent. See [tier-model-final-2026-05-23](#) for the free/paid split.

### Paid-API call pins (silent model swap / token-cap defense)

Pin every paid API call in your backend — not just the ones in Next.js Server Actions. Captures the call expression + model literal + `max_tokens` cap so AI silently swapping `claude-opus` → `claude-haiku` (quality regression) or removing the token cap (unbounded spend) is caught immediately.

```bash
npx pinned sweep          # auto-detects paid-API calls (Anthropic / OpenAI / Gemini / Stripe)
```

Coverage: Anthropic (`messages.create` / `parse` / `stream`), OpenAI (`chat.completions.create`, `responses.create`, `images.generate`, `embeddings.create`), Google Gemini (`generateContent`), Stripe (`paymentIntents.create`, `charges.create`, `subscriptions.create`, `customers.create`, `checkout.sessions.create`, `billingPortal.sessions.create`). Entry-point-agnostic — fires anywhere, plain backend service or Server Action.

### Supabase Edge Function pins (Deno runtime)

HTTP-route detection structurally misses Supabase Edge Functions (they run in Deno, not Node). Pin asserts the function file exists, the write expression survives, and the auth gate is preserved.

```bash
npx pinned sweep          # detects supabase/functions/<name>/index.ts
```

Catches: AI deletes the function ("dead code cleanup"), removes the write call, weakens the auth gate.

### Cron handler pins (Vercel + GitHub Actions)

Cron fires WITHOUT a user in the loop — schedule drift (`0 4 * * *` → `0 4 * * 0` runs once a week instead of daily) or handler rename = silent SLA break. Pin captures Vercel `vercel.json:crons[]` entries and GH Actions `on.schedule[].cron` schedules.

```bash
npx pinned sweep          # detects vercel.json + .github/workflows/*.yml
```

### Stripe webhook event-type dispatch pins

The layer above signature-verify. Catches AI silently typoing `case "checkout.session.complete":` (one-letter rename), merging fallthrough arms dropping one, or wholesale deleting a case. The signature still verifies — Stripe still returns 200 — paying customers never get provisioned.

### Server-Action pins (Next.js App-Router mutations)

Pin the App-Router mutation pattern that `/api/*` HTTP-route detectors can't see — auth-gated `"use server"` functions that perform DB writes, file uploads, or paid-API calls. Closes the highest-impact coverage gap reported via real-world dogfood.

```bash
npx pinned sweep                                                     # auto-detects Server Action writes
npx pinned record-server-action <claim-id> --fixture <payload.json>  # capture valid payload + regenerate test
```

Detection covers: supabase / prisma / drizzle / kysely / mongoose / raw SQL DB writes; supabase-storage / S3 / R2 / Vercel Blob file uploads; outbound paid-API calls (Anthropic / OpenAI / Gemini / Stripe). Auth-gate function name (`isAdminAuthed`, `requireAuth`, etc.) and zod input-schema name are captured automatically. Until you record a fixture, the pin self-skips with a clear message.

### Page accessibility pins (🛟 BETA — opt-in)

Catches the *"page renders but is unreadable"* class — white-on-white text, WCAG-AA contrast failures, invisible labels. Plain page-renders pins stay GREEN on these because the page does render; this is the only template that catches it.

```bash
npx pinned add-browser                  # one-time: install Playwright (~300 MB)
npx pinned sweep --include-beta         # auto-detects pages + emits axe-core pins
```

Loads each page via Playwright + injects axe-core (pinned version, CDN-loaded) + runs the `color-contrast` rule. WARN-only on violations (frontend a11y doesn't fail CI) + `confidence: "review"` so catches don't inflate the GA metric.

### Browser interaction pins (🛟 BETA — opt-in)

Cover frontend interaction regressions (the carousel "arrows do nothing" class) by wrapping Playwright. Beta posture: WARN-only on drift, attach-only to a running dev server, catches quarantined as `confidence:"review"` so they don't inflate the GA metric.

```bash
npx pinned add-browser                                # one-time: install Playwright + Chromium (~300 MB)
npx pinned sweep --include-beta                       # auto-detect interaction candidates + pin them
npx pinned record-interaction <claim-id>              # capture the baseline observation once
npx pinned record-interaction <claim-id> --dry-run    # observe without persisting (calibration)
```

Auto-detection finds buttons with stable selectors (`data-testid` preferred over `aria-label`) AND an `onClick` handler. Until you run `record-interaction`, the pin emits a single warn-only message; only after recording does drift get reported.

### Internal (called by hooks)

```bash
npx pinned check-guard-removal       # pre-commit hook entry; blocks AI bypass attempts
npx pinned statusline                # statusline rendering for Claude Code
npx pinned backtest --mode=bug-fix   # replay a repo's git history (calibration tool)
```

### Optional AI-assisted analysis (BYOK)

```bash
PINNEDAI_BYOK=openai PINNEDAI_OPENAI_KEY=sk-... npx pinned check
```

LLM-as-proposer fires on each commit's diff to suggest additional guards the deterministic detectors might miss. Customer pays their LLM vendor directly; Pinned doesn't proxy.

---

## Statusline

Pinned surfaces protection events without becoming a noisy reviewer. Events decay back to a calm baseline:

```
◆ pinned · 34 pins · 7 lessons · ✓ 12 verified                  # baseline
◆ pinned · 34 pins · ⚠ 2 protected files in this commit          # editing guarded files
◆ pinned · 34 pins · ⛔ blocked: AI weakened pin sample.test.ts   # Guard Integrity refused
◆ pinned · 34 pins · +1 new guard                                # SAVED
◆ pinned · 34 pins · scanned 3 similar files                     # AUDIT
◆ pinned · 34 pins · 4 guards passed                             # COVERED
◆ pinned · 34 pins · learned: don't drop authHeaders() from API calls  # LEARNED
◆ pinned · 34 pins · ✗ 1 broken                                  # failing pin
```

The `BLOCK / LEARNED / SAVED / AUDIT / COVERED` transients fall back to baseline after 1-2 minutes. Persistent value = guard count + lesson count.

---

## What Pinned is NOT

Pinned is **not** a generic code reviewer, SAST scanner, or AI bug-fixer.

CodeRabbit reviews PRs. Snyk / Semgrep scan for broad security issues. They run once and leave comments.

Pinned protects the repo-specific promises your AI coder must not forget: the bug fixes, guards, tests, and lessons that should survive future AI edits. **The output of every finding is an executable guard, not a comment.**

---

## AI and privacy

Pinned works **without an LLM**. The core engine is deterministic: guards either pass, fail, or were weakened.

Optional AI-assisted mode (BYOK) can propose additional guards, sibling audits, and lessons from diff context. AI output never enforces anything by itself — deterministic guards + CI do the enforcement.

Principle:

```
LLM proposes. Guards prove. CI enforces.
```

**Local-first.** Free beta runs entirely on your machine + your CI. Pinned doesn't see your code unless you set BYOK env vars (in which case the calls go directly to your LLM vendor, not through Pinned infrastructure).

---

## Free vs Founder Pro

| | Free Beta | Founder Pro (waitlist) |
|---|---|---|
| All deterministic detectors | ✅ Unlimited | ✅ |
| Guard Integrity blocks | ✅ | ✅ |
| AI Lessons file + agent config wiring | ✅ | ✅ |
| Replay-verified bug-fix guards | ✅ | ✅ |
| Local audit / probe / context | ✅ | ✅ |
| Pre-commit / pre-push hooks | ✅ | ✅ |
| Statusline integration | ✅ | ✅ |
| Report-only CI (you wire `pinned guard` yourself) | ✅ | ✅ |
| Optional BYOK AI proposer (your own key) | ✅ | ✅ |
| **PR comments with repair prompts** | — | Coming |
| **Cross-repo AI lessons** | — | Coming |
| **Hosted AI analysis (no API key)** | — | Coming |
| **Cloud proof / history dashboard** | — | Coming |
| **AI / provider mistake analytics** | — | Coming |
| **Managed CI enforcement policies** | — | Coming |
| **Custom guard templates** | — | Coming |
| **Team policies + audit log** | — | Coming |

Founder Pro is a **waitlist** today — no payment, no card. We collect interest to gauge demand for the paid features above. When paid opens, founder pricing locks for everyone on the list.

[Join the waitlist →](https://pinnedai.dev#waitlist)

---

## Status

v0.1 (free beta) ships with:

- 8 Guard Integrity detectors (23 / 23 known AI bypass tactics blocked in our mutation-test suite)
- AI Lessons file + opt-in agent-config wiring (CLAUDE.md, .cursorrules, .github/copilot-instructions.md, etc.)
- 6 P0 detector categories generating pins at init: Guard Integrity, client fetch / auth-headers / error-handling, auth/middleware, route/export/reference integrity, public exposure, webhook signature
- `pinned audit --learned` for sibling discovery
- `pinned probe-admin` for admin-route enumeration
- `pinned context` for runtime AI-coder briefing
- Statusline events for BLOCK / SAVED / AUDIT / COVERED / LEARNED / VERIFIED + baseline `N pins · M lessons`

Open beta. Bug reports + feature requests welcome at [github.com/pinnedai/pinnedai/issues](https://github.com/pinnedai/pinnedai/issues).

---

## License

Apache 2.0. CLI source is public; the Cloudflare Worker that backs the (coming) hosted AI / cross-repo lessons / dashboard features stays private.
