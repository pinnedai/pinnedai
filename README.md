# pinnedai

> **Permanent guardrails for AI-coded apps.**

> Pinned remembers the promises your app must keep — auth, billing, rate limits, webhooks, permissions, and critical flows — and blocks future AI edits from quietly breaking them.

The missing layer in the AI-coding stack:

1. Cursor / Claude Code writes the code
2. CodeRabbit / Copilot reviews it
3. **Pinned turns important promises into permanent guardrails** ← we live here
4. CI enforces them forever

Every promise your PR description makes — "auth required on /api/admin", "rate-limits /api/users to 60/min", "Stripe webhook idempotent by event_id" — becomes a permanent CI test in your repo. When a future AI change touches that protected behavior, CI fails with a back-reference to the original PR and a paste-ready repair prompt for Cursor or Claude Code.

---

## Get immediate value in 60 seconds (not after some future regression)

### 1. See the demo

```bash
npx pinnedai
```

Parses a sample PR description, generates a Vitest file, shows the regression simulator. No install, no signup, no config.

### 2. Install in your repo (one command)

```bash
npx pinnedai init
```

Writes `.github/workflows/pinned.yml`, creates `tests/pinned/` with an auto-maintained `PINS.md` registry.

### 3. Find unprotected promises **today** with `baseline`

```bash
npx pinnedai baseline
```

Walks your repo, applies the risk-surface detector, finds claims you should pin **right now** — typically 8-12 candidates on a typical Next.js / Hono / Express app.

**This is the immediate value.** Pinned isn't insurance against future regressions — it's protection for the promises your code is already making but isn't testing. Six months later, when AI tools refactor through that code, those pins are still there.

### 4. Open a PR. The Action does the rest.

Commit your code, open a PR with a claim in the description. The Action:
- Scans the diff for new risk surfaces
- Posts a PR comment with suggested pins for anything unprotected
- Auto-generates and commits tests for every claim in the description
- Replies `✓ Pinned` when the tests join your suite

---

## What you can claim (8 templates across 3 domains)

### Web app claims (3)

Generated tests hit `PREVIEW_URL` and assert HTTP-level behavior.

| Claim phrasing | Test that gets generated |
|---|---|
| `Rate-limits /api/users to 60 req/min.` | Bursts 61 parallel requests, asserts ≥1 returns 429 |
| `Auth required on /api/admin/export.` | Single GET without auth, asserts 401 or 403 |
| `Makes /webhooks/stripe idempotent on event_id.` | POSTs the same payload twice, asserts byte-identical response |

**Example**:

```bash
npx pinnedai check --description "Rate-limits /api/users to 60 req/min. Auth required on /api/admin/export."
# → Found 2 claim(s):
#   • rate-limit     /api/users  →  60/minute
#   • auth-required  /api/admin/export  →  401/403 without auth
```

### CLI tool claims (4)

Generated tests spawn the binary via `execFileSync` / `spawnSync` (no shell) and assert on stdout, exit code, file side-effects, or `--help` output.

| Claim phrasing | Test that gets generated |
|---|---|
| `` `pinned doctor` outputs `tests/pinned/ directory`. `` | Spawn, capture stdout, assert substring present |
| `` `pinned init` exits 0 on a healthy repo. `` | Spawn, assert exit code is 0 |
| `` `pinned init` creates `tests/pinned/.registry.json`. `` | Spawn in tempdir, assert file exists relative to cwd |
| `` `pinned check` supports `--json` flag. `` | Spawn `<cmd> --help`, assert flag appears in output |

**Example**:

```bash
npx pinnedai check --description "\`pinned doctor\` outputs \`All checks passed\`. \`pinned --version\` exits 0."
# → Found 2 claim(s):
#   • cli-output     `pinned doctor`  →  stdout contains "All checks passed"
#   • cli-exits      `pinned --version`  →  exits 0
```

### Library / SDK claims (1)

Generated tests import the named function from a repo-relative module and deep-equal the return.

| Claim phrasing | Test that gets generated |
|---|---|
| `` `parseConfig()` in `src/config.ts` returns `{"version": 1}`. `` | Import, call, assert JSON-deep-equal on return |

**Example**:

```bash
npx pinnedai check --description "\`add(2, 3)\` in \`src/math.ts\` returns \`5\`."
# → Found 1 claim(s):
#   • library        add(2, 3) in src/math.ts  →  returns 5
```

> **Need a template that isn't here?** Open an issue at [github.com/pinnedai/pinnedai/issues](https://github.com/pinnedai/pinnedai/issues) with the claim phrasing you'd like to support — each template is ~200 lines and we add them on customer demand.

---

## Sticky features

### `PINS.md` — the visible behavioral contract

Every `pinned generate` updates `tests/pinned/PINS.md`, a human-readable table of every pinned claim. Browse it on GitHub like a README; every dev on the team sees what contracts the repo holds itself to. The more pins, the more it compounds.

```bash
npx pinnedai list                # what's pinned (active)
npx pinnedai list --include-retired   # plus retired (audit trail)
```

### `pinned scan` — "no proof found" PR comments

The Action runs `scan` (alias: `scan-diff`) on every PR. It detects risk surfaces (new Next.js routes, webhook handlers, middleware changes, `.env` edits), cross-references the PR description + existing pins for coverage, and comments suggested pins for unprotected changes.

```bash
npx pinnedai scan --base origin/main --markdown
# Markdown for PR comments
```

### Safety Pass — deterministic AI-mistake scan

`pinned safety` runs a static scan for the kind of mistakes AI-generated code introduces. **Pure deterministic — zero LLM cost by default.** Checks:

- Env var used in code but missing from `.env.example`
- `NEXT_PUBLIC_*SECRET / TOKEN / KEY` (public-by-name + secret-by-shape = leak)
- Public CORS wildcard (`*` origin)
- Destructive SQL (`DROP TABLE`, `TRUNCATE`, `DELETE` without `WHERE`)
- Type / lint escape hatches (`@ts-ignore`, `eslint-disable`)

```bash
npx pinnedai safety
# Safety Pass: 2 warnings · 1 info
#   ⚠ Env var `STRIPE_SECRET_KEY` is used in code but not listed in .env.example.
#      src/billing.ts:14
#      → Add STRIPE_SECRET_KEY= to .env.example
```

Optional `--summarize` flag sends only the compact findings JSON (not the diff or source) to the hosted LLM for a 3-bullet markdown summary. Counts against monthly LLM quota.

### `pinned status` — the full picture

```bash
npx pinnedai status
```

Shows pins (active/passing/failing) + unpinned risks + Safety Pass findings + suggested next action. Reads from `.last-status.json` cache so it's fast.

### `pinned protect` — turn risks into pins (interactive)

After `pinned risks` (alias for `baseline`) surfaces unpinned routes/webhooks:

```bash
$ npx pinnedai protect

Pinned can protect 2 unpinned risks:

  [1] Risk-surface: route /api/admin/billing found in app/api/admin/billing/route.ts
      → Auth required on /api/admin/billing.

  [2] Risk-surface: webhook /webhooks/stripe found in app/api/webhooks/stripe/route.ts
      → Makes /webhooks/stripe idempotent on event_id.

Protect these risks?
  [Y] all (1-2)    [1,3,5] choose by index    [N] cancel
  >
```

For CI: `pinned protect --all` or `--dry-run`.

### `pinned fix-prompt` — repair prompt for Claude / Cursor

When a pin fails (or a risk / safety finding needs action), generate a paste-ready prompt for your AI editor:

```bash
npx pinnedai fix-prompt              # for failing pins
npx pinnedai fix-prompt --risk 1     # for the Nth unpinned risk
npx pinnedai fix-prompt --safety 2   # for the Nth Safety Pass finding
```

Your AI editor pays for the repair tokens — pinned just gives the prompt.

### Claude Code integration (statusline + failure hook)

Pinned can show up persistently in [Claude Code](https://claude.com/claude-code) without polluting your chat. Two surfaces:

**Statusline** (always-visible bottom bar):

```
◆ pinned · 8 pins · ✓                  (quiet when green)
◆ pinned · 8 pins · ✗ 1 failing        (when a pinned test fails)
◆ pinned · 8 pins · ⚠ 2 risks          (when there are unpinned risks)
```

**Chat injection ONLY when something is broken** — empty stdout when green so chat stays clean.

Add to your repo's `.claude/settings.json` (one-time, team-shared):

```json
{
  "statusLine": {
    "type": "command",
    "command": "npx pinnedai statusline"
  },
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "npx pinnedai hook-failure" }
        ]
      }
    ]
  }
}
```

`pinned init` will offer to set this up for you when it detects Claude Code is in use.

### `@pinned add:` — pin from a PR comment

Reviewer notices a claim missing? Comment on the PR:

```
@pinned add: Auth required on /api/admin/billing.
```

The Action parses the comment, generates the test, commits to the PR branch, replies with ✓. Gated to OWNER/MEMBER/COLLABORATOR so external contributors can't trigger commits on public repos.

### `pinned baseline` — first-day "wow"

Run once after `npx pinnedai init` on an existing repo. Walks the whole working tree, suggests pins from the routes/handlers/middleware that already exist — typically 10+ candidates for a typical Next.js / Hono / Express repo.

```bash
npx pinnedai baseline
# Found 12 candidate pin(s) in your repo. Add the suggested lines to your next PR description...
```

### Repair-prompt on failure

When a pin fails CI, the error message includes a **paste-ready prompt** for Cursor or Claude Code. Workflow:

1. Refactor breaks a pinned claim
2. CI fails with the original PR reference + repair prompt
3. Copy the prompt → paste into your AI editor
4. AI proposes a fix matching the original claim
5. Commit, CI passes

### `pinned retire` — graceful audit trail

When a contract genuinely no longer applies:

```bash
npx pinnedai retire <claim-id> --reason="endpoint deprecated 2026-Q2"
```

Moves the test to `tests/pinned/retired/` and writes a per-file `<id>.audit.json` with timestamp + author + reason. The retire move is preserved in git history — SOC 2 / ISO 27001 change-management evidence.

### `pinned doctor` — diagnose setup issues

```bash
npx pinnedai doctor
# Health check for pinnedai setup in this repo.
# ✓ tests/pinned/ directory                  present
# ✓ .github/workflows/pinned.yml             present
# ✓ Workflow OIDC permission                 id-token: write declared
# ✓ Workflow auto-commit permission          contents: write declared
# ✓ PINS.md registry                         8 active pin(s), 0 retired
```

---

## CLI reference

| Command | What it does |
|---|---|
| `npx pinnedai` | Default — runs the local demo. Zero config. |
| `pinned init` | Scaffold the GitHub Action workflow + `tests/pinned/` registry. Offers to wire `.claude/settings.json` for statusline/hook. |
| `pinned check --description "..."` | Parse a PR description for claims (regex + LLM in CI). `--json` for structured output. |
| `pinned generate --pr-id pr-N --description "..."` | Write test files to `tests/pinned/`. Auto-runs in the workflow. `--dry-run` to preview. |
| `pinned scan --base origin/main` | Find unpinned risk surfaces in the current diff. `--markdown` for PR-comment output. Alias: `scan-diff`. |
| `pinned baseline` (alias: `risks`) | Scan the whole repo, suggest pins from current state |
| `pinned protect [--all] [--dry-run]` | Interactive: turn detected risks into pins |
| `pinned safety [--summarize] [--json]` | Deterministic Safety Pass — env vars, secret-shape, CORS, SQL, lint escape hatches |
| `pinned status [--refresh]` | Full breakdown: pins + risks + safety + suggested next |
| `pinned fix-prompt [--risk N \| --safety N]` | Paste-ready repair prompt for Claude/Cursor |
| `pinned test` | Run pinned tests + update `.last-status.json` cache |
| `pinned list [--include-retired] [--verbose]` | Browse all pinned + retired claims in this repo |
| `pinned show <claim-id>` | Full detail for one pin: claim text, file, status, catch history |
| `pinned catches [--limit N]` | Lifetime history of regressions Pinned has caught |
| `pinned auto-protect [--base WORKING_TREE] [--mode safe\|ask\|off]` | Run the auto-protect classifier against the current diff. Auto-adds safe pins in `safe` mode |
| `pinned watch [--debounce 3000]` | Background fs watcher; runs auto-protect after the configured quiet window |
| `pinned retire <claim-id> --reason="..."` | Move a pin to `retired/` with an audit-log entry |
| `pinned doctor` | Health check — diagnose setup issues (missing perms, broken workflow, etc.) |
| `pinned ai-rules install [--yes]` | Opt-in: add the pinnedai block to CLAUDE.md / .cursorrules |
| `pinned statusline` | One-line indicator for Claude Code bottom bar (read from cache) |
| `pinned hook-failure` | Chat injection content — empty when green, warning when a pin is failing |
| `pinned pr-comment` | Short PR-comment markdown (quiet-success / claims-added / risky / broken) |

All commands work locally — they only call the hosted LLM when running inside GitHub Actions (keyless via OIDC, no API key required).

---

## Pricing

| Tier | Price | LLM calls/mo | Pins | Other |
|---|---|---|---|---|
| **Free** | $0 | **1,000** public · **100** private | **Unlimited** | All 8 templates · auto-commit · no API key |
| **Pro** | $19/mo | 5,000 (fair use) | Unlimited | Optional BYOK (Anthropic/OpenAI) · custom templates · `@pinned fix` |
| **Team** | $199/mo | 50,000 | Unlimited | Org policies · audit log · Slack alerts · CODEOWNERS routing |
| **Enterprise** | $20K+/yr | 1,000,000 | Unlimited | Self-hosted Worker · SSO · SOC 2 CC8.1 evidence export |

Pin count is **unlimited at every tier** — the value compounds with every PR, and capping pins would cap the moat. Tiers differentiate on LLM-call volume (cost-bounded by what we pay OpenAI on your behalf) and features.

Free tier needs only `npx pinnedai init`. Public-repo LLM caps match CodeRabbit's launch generosity for OSS. Private-repo caps match the Greptile/Qodo/Snyk zone but with no per-PR restrictions. Pro/Team/Enterprise: customer pays via Stripe with their GitHub org name; the next PR auto-detects the subscription via OIDC. No license key, no API key wiring, no config.

---

## BYOK (Pro+, optional)

If compliance requires that PR descriptions never transit our infrastructure, opt in with:

```yaml
# .github/workflows/pinned.yml
- uses: pinnedai/pinnedai-action@v1
  with:
    byok: anthropic   # or "openai"
  env:
    PINNEDAI_ANTHROPIC_KEY: ${{ secrets.PINNEDAI_ANTHROPIC_KEY }}
```

The CLI calls Anthropic/OpenAI directly with your key. Our Worker only sees the OIDC plan-check, never the PR body. Naked `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` env vars are intentionally NOT auto-discovered — the prefixed env var name is a deliberate opt-in.

---

## Comparison

| | CodeRabbit / Greptile / Qodo | Pinned |
|---|---|---|
| Reviews PRs | ✅ | — |
| Leaves comments | ✅ | — |
| Finds possible bugs | ✅ | — |
| **Converts claims into tests** | ❌ | ✅ |
| **Leaves repo artifacts** | ❌ | ✅ |
| **Prevents repeated broken promises** | ❌ | ✅ |
| **Pins live forever in your codebase** | ❌ | ✅ |
| **Works on web + CLI + library code** | ❌ (web) | ✅ |

Pinned isn't a code-review bot. It's a *test artifact registry* that turns PR claims into permanent regression tests. Use it alongside CodeRabbit, Cursor, or Claude Code — they review, Pinned protects.

---

## Show your pin count in your README (free virality)

Once you've pinned a few claims, embed the pinnedai badge in your README so visitors see the contract count:

```markdown
[![pinned by pinnedai](https://api.pinnedai.dev/badge/your-org/your-repo)](https://pinnedai.dev)
```

The SVG reads `tests/pinned/PINS.md` from your repo on-demand and renders the active pin count. Free for any public repo — no auth, no signup.

---

## Dogfood

pinnedai pins claims about itself in `tests/pinned/`. The CI workflow at `.github/workflows/ci.yml` runs them on every push. See those test files for living examples of every template.

---

## License: Apache 2.0

The CLI is fully open source — auditable for any security team. The hosted LLM extraction service is a separate, closed-source Worker; substitute your own endpoint via `PINNEDAI_ENDPOINT` if you want to self-host.

---

## Links

- **Live demo**: [pinnedai.dev](https://pinnedai.dev)
- **npm**: [pinnedai](https://www.npmjs.com/package/pinnedai)
- **Issues**: [github.com/pinnedai/pinnedai/issues](https://github.com/pinnedai/pinnedai/issues)
