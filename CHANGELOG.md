# Changelog

All notable changes to pinnedai. Follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This file tracks the `pinnedai` npm package version; the Cloudflare Worker tracks its own version independently in `apps/edge/`.

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
