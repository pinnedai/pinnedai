# PinnedAI

> **Pinned creates a local AI-coder safety net on install, writes repo-specific lessons, and blocks AI from weakening protected guards.**
>
> *Free beta · Founder Pro waitlist open at [pinnedai.dev](https://pinnedai.dev).*

## The 5-step value loop

1. **`pinned init`** scans your repo and creates baseline guards on install (auth checks, lockfile integrity, secret prefixes, route registrations, webhook signatures, URL literals, exports, form error-handling, more).
2. **Guard Integrity blocks** any commit that tries to delete, skip, weaken, or `--no-verify`-bypass a guard.
3. **AI Lessons file** (`.pinned/ai-lessons.md`) captures repo-specific rules — read by Claude / Cursor / Devin / Copilot before they edit.
4. **`pinned audit --learned`** scans sibling code paths for the same mistake pattern.
5. **Future AI edits must pass every guard.** The output of every finding is an executable test, not a review comment.

**Proof it works**: see the [`/proof` page](https://pinnedai.dev/proof) for benchmark results, or jump to [Status](#status) below for the headline numbers.

---

## Quickstart

```bash
# See what Pinned does on a sample claim — no install, no signup
npx pinnedai

# Install in your repo (one command)
npx pinnedai init

# After init, on every commit Pinned blocks AI bypass attempts and
# auto-protects new admin/middleware/webhook/client-fetch code.
```

`pinned init` writes `.github/workflows/pinned.yml`, creates `tests/pinned/` with `PINS.md`, installs pre-commit + pre-push hooks, auto-generates baseline pins from your current code, and seeds AI-coder rules into `CLAUDE.md` + `.github/copilot-instructions.md` (and any other AI rule file already in the repo). Each step prompts before writing in interactive mode; pass `--auto` to accept all.

If your repo already has `.cursorrules`, `.clinerules`, `AGENTS.md`, or `.windsurfrules`, init writes to those too — same marker-bounded block, identical uninstall flow (`pinned uninstall-agent-rules`).

---

## Editor + AI-tool surfaces

Pinned ships across every major AI-coder surface:

| Surface | What you get | How to install |
|---|---|---|
| **VS Code / Cursor / Windsurf / Codium** | `◆ pinned · N guards · ✓` in the status bar, rich hover tooltip with recent guards + latest AI lesson, click → Quick Pick (action chooser) → command runs in a Pinned-managed terminal. Works in stock VS Code (Copilot users), Cursor, Windsurf, Codium. | Bundled `.vsix` auto-installs during `pinned init` (until we publish to the Marketplace + Open VSX in v0.1.1) |
| **Claude Code** | Statusline + UserPromptSubmit hook (`◆ pinned · LEARNED · 1 new AI mistake`, transient block-event messages). Optional `/pinned-status`, `/pinned-list`, `/pinned-review`, `/pinned-done` slash commands. | Statusline auto-wired by `init`; slash commands via `npx pinnedai install-claude` |
| **GitHub Copilot Chat (free + paid)** | Reads Pinned rules from `.github/copilot-instructions.md` before generating code | Auto-created during `init` |
| **MCP-aware tools (Claude Desktop, Cline, Continue)** | `pinned_before_code_change`, `pinned_before_done_check`, `pinned_scan_diff`, `pinned_list_guards`, `pinned_check_pr_description`, `pinned_suggest_init` as native tools with structured `human_summary` + must-report `agent_instruction` fields | Add `pinnedai-mcp` to the tool's MCP config — see [docs/integrations/](./docs/integrations/) |
| **GitHub Action (CI)** | `pinned check-guard-removal` + vitest on every PR — guard weakening attempts fail CI | Auto-wired via `.github/workflows/pinned.yml` from `init` |
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

## What Pinned protects

Pinned focuses on AI-prone failure modes:

- **Guard weakening** — `.skip()`, `.only()`, `xit()`, `.todo()`, `.skipIf(true)`, deleted tests, weakened assertions (`toBe(401)` → `toBeTruthy()`), `|| true`, `?? true`, `catch(() => true)`, `expect(true).toBe(true)` tautologies, commented-out `expect()`, `expect.assertions(0)`, early `return;` in test body.
- **Pinned-infrastructure tampering** — deletion of `tests/pinned/*`, `.github/workflows/pinned.yml`, `tests/pinned/.registry.json`, `.pinned/ai-lessons.md`, or sneaky rename-to-retired/ without the matching `.audit.json`.
- **Client / API mistakes** — missing `authHeaders()`, missing `credentials: "include"`, lost `if (!res.ok)` gates, removed 401/402/403 handling. Detected statically per file via path + pattern heuristics.
- **Auth / middleware regressions** — `requireAuth` / `requireAdmin` / middleware matcher coverage; the middleware-aware pin uses `middleware.ts`'s captured auth signature so removing the auth check fails the guard.
- **Route / export / reference integrity** — internal `<Link href="/foo">` / `navigate("/foo")` / `router.push("/foo")` that resolve today are pinned; if a future commit removes the target page file, the pin fails.
- **Webhook signature verification** — `stripe.webhooks.constructEvent`, `x-hub-signature-256`, `svix.verify`, `twilio.validateRequest`, generic `crypto.createHmac("sha256", ...)`. Pinned captures the verify call so removing it fails the guard.
- **Public exposure no-fixture checks** — `.env` committed without `.gitignore` coverage, `.map` files in `dist/`/`build/`, debug routes (`__debug`, `__test`, `debug.html`, `/admin/console`).

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
```

### Lifecycle

```bash
npx pinned retire <claim-id> --reason="..."   # legitimate retirement (writes audit entry)
```

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
