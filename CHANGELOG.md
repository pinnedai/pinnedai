# Changelog

All notable changes to pinnedai. Follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This file tracks the `pinnedai` npm package version; the Cloudflare Worker tracks its own version independently in `apps/edge/`.

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
