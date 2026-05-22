# GPT prompt — battle-test the Pinned system for bugs

> Copy-paste this entire file into a fresh GPT-5 / Claude Opus conversation. Best results when the model can also read the relevant source files (paste them in as attachments / share the public repo URL). The goal is **finding bugs we missed**, not validating decisions we've already made.

---

## Background — what Pinned is

Pinned (`pinnedai` on npm) is a developer tool that converts PR description claims into permanent Vitest tests. The pitch: "Permanent guardrails for AI-coded apps." When AI agents (Claude Code, Cursor, Copilot) ship a PR with claims like *"auth required on /api/admin/export"* or *"rate-limits /api/users to 60 req/min"*, Pinned generates a real test file in `tests/pinned/` that verifies the claim and joins the test suite forever. Future commits that break the claim fail CI with a paste-ready repair prompt.

**Architecture summary:**

- **CLI** (`apps/cli/`): npm package `pinnedai`, binary `pinned`. ~225KB Node 20 CJS bundle. Handles `init / generate / test / check / scan / scan-pr / baseline / protect / safety / status / show / catches / retire / doctor / fix-prompt / statusline / hook-failure / auto-protect`.
- **Templates** (`apps/cli/src/templates/`): 11 deterministic test generators (auth-required, permission-required, tier-cap, rate-limit, idempotent, returns-status, 4× CLI templates, library-returns). Each takes a parsed Claim, emits a self-contained Vitest test file.
- **Parser** (`apps/cli/src/claimParser.ts`): regex-first claim extraction with LLM fallback (LLM via hosted Worker). 60+ regex patterns across 11 templates, ReDoS-bounded.
- **Registry** (`tests/pinned/.registry.json`): on-disk source of truth for the customer's pins. Atomic writes via temp-file + rename. Includes `covers / badCase / bugFixOrigin` metadata.
- **Worker** (`apps/edge/`): Cloudflare Worker that validates GitHub OIDC JWTs, meters monthly LLM-call quota in D1, proxies OpenAI calls. Aggregate cost cap (`FREE_BUDGET_TOTAL_PER_MONTH`).
- **GitHub Action** (`action/action.yml`): composite action that runs `pinned check + scan + generate` on every PR.
- **Statusline + chat-hook** (`apps/cli/src/statusline.ts`): Claude Code statusline (bottom bar) + UserPromptSubmit chat-injection on broken pins.
- **VS Code extension** (`apps/vscode-extension/`): same statusline UX for Cursor / VS Code users.
- **Day-zero verification** (`apps/cli/src/dayZeroVerify.ts`): after `pinned generate`, runs the new pin against current code via vitest. Double-confirm (re-run failures with 500ms gap) to mitigate flakes.
- **Audit suite** (`audit/`): 372 audits covering features, templates, fixtures, e2e dogfood. Every template has POSITIVE + NEGATIVE + NO-CHANGE controls.

**Locked invariants (do not propose changes to these):**

1. The LLM never writes test logic — only fills slots in deterministic templates.
2. Tests live in the customer's repo, not on our cloud.
3. Keyless onboarding: customer's GitHub repo IS the identity via OIDC.
4. False positives are catastrophic — every assertion in every direction is opt-in via env-var-gated `it.skipIf`.
5. CLI public (Apache 2.0), Worker private. Auto-commit + custom templates + Bug Scout live in the private Worker.

---

## What's already covered (no need to re-test these)

We have these internal proofs already running on every CI:

| Coverage | Count |
|---|---|
| Per-template positive control (healthy fixture server → test passes) | 11 of 11 templates |
| Per-template negative control (broken fixture → test fails with PINNED FAILURE header) | 11 of 11 templates |
| Per-direction tests for multi-direction templates (auth-required, permission-required, tier-cap) — POS / NEG / NO-CHANGE-skip for each direction | 3 templates × 3 directions each = 9 explicit tests |
| ReDoS regex audits (200KB filler inputs proven not to backtrack catastrophically) | All 60+ regexes in the parser |
| `pinned init --auto` idempotent re-run, multi-tool rule install, --from-agent audit trail | 4 audits |
| Statusline state precedence + minimal-mode + verifiedStreak counter | 12 audits |
| CATCHES.md ledger render + chat-hook celebration (catch message includes bad_case + lifetime count) | 11 audits |
| Day-zero verify FP-prevention contracts (no PREVIEW_URL → silent skip, --no-verify bypasses, default DOES verify) | 4 audits |
| FP-mitigation infrastructure (X-Pinned-Test header on every fetch, retry-with-backoff on 5xx, loud skip reporting) | 7 audits |
| Bug-fix vocab detection (POS + FALSIFIABILITY for "fixture"/"prefix" not falsely tagging) | 11 audits |
| Coverage mapping (covers field intersection with diff, REVIEW · N touched statusline state) | 8 audits |
| End-to-end dogfood script (15 phases: scaffold → auto-protect → sabotage-and-recover → catch fires) | All 15 pass |

**Don't propose duplicating these.** Propose tests we haven't thought of.

---

## What we want from you

Find **specific bug-finding scenarios** that could break Pinned in ways we haven't audited for. Output a numbered list. For each scenario:

1. **The exact attack/edge case** in plain English (1-2 sentences)
2. **Why it could break Pinned specifically** (point at the layer: parser, template, registry, Worker, Action, etc.)
3. **A reproducible test scenario** — concrete enough that we can write the audit in ~30 minutes
4. **Severity** — CRITICAL (silent FP / silent miss / data corruption) / HIGH (loud failure but unrecoverable) / MEDIUM (recoverable with manual intervention) / LOW (cosmetic / nice-to-have)

We particularly want bugs in these areas — feel free to invent more:

### Parser robustness

- **Adversarial PR descriptions**: a malicious AI agent (or just a confused one) crafts a PR description that abuses the regex patterns. Examples: nested backticks, unicode lookalikes for route slashes, very long phrasing that triggers a different pattern than intended, RTL-override characters.
- **Mixed-template phrases**: "Auth required on /api/x, rate-limited to 60/min" — does the parser extract both claims cleanly? What if they overlap (`auth-required on /api/x is rate-limited to 60/min`)?
- **i18n / non-ASCII**: a PR description in Japanese / Cyrillic / Arabic-script identifiers. Does the parser silently drop these or crash?
- **Conflicting claims in same PR**: `Auth required on /api/x. Auth removed from /api/x.` — does Pinned create conflicting pins?
- **Regex ReDoS we haven't caught**: I'm particularly worried about regexes with nested `*` / `+` quantifiers on overlapping character classes. We've audited 200KB filler, but specific adversarial inputs might still backtrack.

### Template / test-runtime bugs

- **Generated test escapes**: a claim's `route` or `text` contains backticks, newlines, template literal interpolations, or shell metacharacters. Does the generated test source still compile? Does it execute the right HTTP request?
- **Preview-URL trust boundaries**: `PREVIEW_URL=http://localhost:3000` vs `PREVIEW_URL=http://attacker.com:3000` — Pinned tests blindly trust whatever URL the env var holds. Is there an attack vector via a malicious `PREVIEW_URL` (e.g., SSRF if the test runs inside a privileged CI runner)?
- **Generated test stability under vitest version drift**: tests use `it.skipIf` which is vitest 0.34+. What happens on vitest 1.x vs 2.x vs 3.x? Are there silent behavior changes we'd miss?
- **Race conditions in `pinned test --background`**: post-commit hook fires `pinned test` in background. What if 5 commits land in quick succession? Do we get 5 concurrent test runs writing to `.last-status.json`?

### Registry / on-disk state

- **Concurrent writes from multiple PRs**: two GitHub Actions running in parallel both try to add a pin to the same registry. Atomic-write via temp-file + rename: is the rename atomic across the file system Cloudflare/GitHub actions use? Could one PR's pin be lost?
- **Corrupted `.registry.json`**: a customer hand-edits the file and introduces invalid JSON. `pinned status` / `pinned generate` — how do they degrade? Could a corrupted registry cause a SILENT miss (e.g., dropping pins) rather than a loud failure?
- **`covers` field drift**: a pin's `covers.routes` says `/api/admin/export`, but the customer renames that route to `/api/admin/data-export`. The pin still runs against the old (now 404) endpoint. Does Pinned detect / surface this drift?
- **Retired pins resurfacing**: customer retires pin X with a reason. Six months later, an AI agent regenerates a similar claim. Does the new pin somehow inherit the retired pin's claimId? Does it overwrite the retired audit trail?

### Worker / OIDC

- **Stolen OIDC token replay**: GitHub OIDC tokens have a 5-minute TTL. What if an attacker captures one and replays it from a different IP within that window? The Worker validates JWKS but not source IP. Is that the right trade-off?
- **JWKS cache poisoning**: the Worker fetches GitHub's JWKS to validate signatures. If GitHub rotates keys and the Worker's cache is stale, valid tokens get rejected. What's the cache TTL? How does it recover?
- **Worker quota math drift**: D1 counters increment on every LLM call. What happens at midnight UTC on the 1st of the month? Does the rollover have a race window where calls aren't counted (free quota leak) or are double-counted (false 429s)?
- **Worker's `FREE_BUDGET_TOTAL_PER_MONTH` aggregate cap**: meant as a cost ceiling. If it fires, every org gets a 429 simultaneously — even paid Pro orgs. Is that the right behavior? Should Pro be carved out?

### GitHub Action

- **`fetch-depth: 0` not set in customer's workflow**: `pinned scan --base origin/main` needs full history. Some customers will set `fetch-depth: 1` or omit. What does Pinned do? Silently emit nothing? Loud failure?
- **`auto-commit` permission missing**: the workflow needs `contents: write`. If the customer disables that, what happens? Silent skip? Error?
- **Composite-action timeout**: the action makes Worker calls. If the Worker is slow/down, the PR check hangs for 6+ minutes (the default GitHub timeout). Should Pinned have its own per-call timeout?

### Day-zero verify

- **Vitest installed but broken**: vitest's `node_modules/.bin/vitest` exists but `--reporter=verbose` errors out (vitest config issue, plugin mismatch, etc.). Does day-zero verify silently flag every pin as failing? It shouldn't.
- **Pin generation under partial git state**: customer runs `pinned generate` mid-rebase or with uncommitted merge conflicts. Does the day-zero verify run against the broken state and incorrectly flag pins as failing?

### Security / privacy

- **`X-Pinned-Test: 1` header forge**: an attacker sends production traffic with this header to bypass the customer's rate limit / billing counter / audit log. Should the header value require a customer-specific secret to be considered valid?
- **PR body contains secrets**: the customer's PR description accidentally includes an API key. Pinned's parser extracts and stores the raw text in `.registry.json` and PINS.md (public on GitHub). Should we redact / strip secrets at parse time?
- **`--from-agent` log injection**: the `--from-agent="<consent>"` flag writes the consent string to `~/.config/pinnedai/install-prefs.json` without escaping. An attacker's AI agent could write payloads. Is the file format trustable?

### Edge cases in catch detection

- **Test flakes vs real catches**: a pin's `it()` body throws an unrelated error (e.g., DNS failure to PREVIEW_URL). Pinned sees test failure and increments `breaksCaught`. The customer thinks Pinned caught a real bug. How do we distinguish?
- **Pin retired during catch**: a pin was failing in CI. The customer retires it WHILE CI is still running. Does the catch get recorded? Does PINS.md / CATCHES.md show conflicting info?
- **Multiple catches in one test run**: 5 pins fail simultaneously in one CI run. Statusline shows `🛟 caught 1 break` (the count from `recentlyAddedCount` not aggregated). Should it say "caught 5 breaks"? Is the chat-hook injecting one or five copies of the celebration?

### Bonus area — UX

- **Pinned grows unboundedly**: customer has 500 pins after 2 years. `PINS.md` is 50KB of table rows on GitHub. Does GitHub render it? Does `pinned list` paginate? Does the statusline still update fast (< 50ms)?
- **Pin file naming collisions**: two PRs generate `pr-X-auth-required-/api-admin-..-abc123.test.ts` with the same hash suffix. Race condition or guaranteed?

---

## Output format

Number each finding 1-N. Bias toward CRITICAL / HIGH findings. Skip cosmetic stuff. Include a brief "why we should care" line for each.

**Bonus**: at the end, list 3-5 attack surfaces we DIDN'T mention in this prompt that you think we should be auditing. Be specific.
