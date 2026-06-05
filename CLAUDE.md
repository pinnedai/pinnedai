# pinnedai — handoff for future Claude sessions

> **READ THIS FIRST** if you're a Claude session picking up this project for the first time. It contains the positioning, the scope rules, the file map, the next concrete tasks, and the rejected alternatives so you don't waste the user's time rehashing decisions.

---

## What this project is

**pinnedai** — permanent guardrails for AI-coded apps. Turns the promises in a PR description (auth, billing, rate limits, webhooks, permissions, critical flows) into permanent CI tests that block future AI edits from quietly breaking them.

**npm name**: `pinnedai` (binary: `pinned`)
**Website**: `pinnedai.dev` (not yet registered)
**GitHub**: `github.com/pinnedai/pinnedai` (not yet pushed)
**Project dir**: `/Users/michaelzon/dyad-apps/pinnedai/`

**Tagline**: *"Permanent guardrails for AI-coded apps."*
**Subhead**: *"Pinned remembers the promises your app must keep — and blocks future AI edits from quietly breaking them."*

**Brand-locked vocabulary** (do not re-debate per the locked-decisions section below):
- The product object is a **pin**. The verb is **pin**. Files: `tests/pinned/`, `PINS.md`, `.registry.json`. Do NOT rename pins → "promises" or "guardrails" at the API/file level. "Promise" appears only in marketing prose as the English description of what a pin protects ("the promises your app must keep"); "guardrail" appears only as the category descriptor.

### The product wedge

AI coding agents (Cursor, Claude Code, Devin, Copilot Workspace) ship PRs that *claim* to do things — "adds auth", "rate-limits this route", "makes webhook idempotent" — but reviewers don't have time to verify every claim against the actual diff. **Pinned generates a test file per claim and joins the user's test suite permanently.** Future commits that break the claim fail CI with a back-reference to the original PR.

### Demo flow (the thing that sells)

1. Dev opens PR with description: *"Rate-limits `/api/users` to 60 req/min."*
2. Pinned parses the claim → generates `tests/pinned/pr-1247-rate-limit.test.ts`
3. PR comment shows the generated test for review
4. Dev merges → test joins the suite **permanently**
5. Six months later, dev #4 refactors and accidentally breaks the rate limiter → **CI fails** with: *"This commit breaks claim made in PR #1247."*

### Why this beats CodeRabbit / Greptile / Copilot Workspace

| | Code-review bots | Pinned |
|---|---|---|
| Value moment | PR open, then gone | Every commit, forever |
| What carries forward when you cancel | Nothing | 1000s of tests in your codebase |
| Verification mechanism | LLM judgment | Constrained templates (deterministic) |
| Cost per PR at scale | LLM calls + compute | Runs in your existing test suite |

**The moat is persistence.** That's not a feature, it's the architectural choice. Generating *tests in the customer's codebase* is structurally different from posting review comments. CodeRabbit can't pivot to this without redesigning their product.

---

## Strategic moat — independent guardrail for autonomous agents (LOCKED 2026-06-03)

> Pinned and Cipherwake share the same existential risk and the same defense. Both products plant their flag here. Do not let scope drift away from this position.

**The existential risk (same for both products):** the labs and IDEs (Anthropic, OpenAI, Cursor, GitHub) are building verification + security natively into the coding agent. Standalone tools that bolt onto someone else's loop get commoditized as that loop absorbs them.

**The defense (same for both products):** independence + immutability + governance. The agent must not check or secure its own work. The verifier must be external, enforceable, and unable to be weakened by the agent it watches. That is the position neither the IDE nor the agent will ever credibly occupy — they have an irreducible conflict of interest, because their loop is what is being verified.

**Pinned's category claim:** *the independent, tamper-proof guardrail for autonomous agents.* Pin tests live in the customer's repo (not ours), are signed by Pinned (not the agent), and are wired so the agent that wrote the code cannot weaken/skip/delete its own guards without Pinned catching it on the next commit. That is Guard Integrity — already the headline per [[strategic-pivot-guard-integrity]] — and it must remain the headline.

**What this means for decisions going forward:**
- Anything that makes Pinned look like "another thing inside the agent loop" is wrong. The product is *outside the loop, watching it.*
- Anything that lets the agent silently disable, skip, or rewrite a pin without an audit trail is a P0 bug, not a polish item.
- Enforcement primitives (pre-commit hook, pre-push hook, CI gate, statusline alerts, AI-coder rule files that resist tampering) are core, not optional UX.
- Provider-analytics — "this agent / IDE / model produced this many weakened guards in your org last month" — is the durable upside. It is what neither Cursor nor Anthropic can ship for itself without conflict of interest.
- Higher ceiling than "PR helper" framing. Treat Pinned as category-relevant if it owns the independent-guardrail position, not just as a CI test generator.

### Three things the product must actually do to hold the position

1. **Be tamper-proof.** The agent cannot quietly weaken or delete a pin — only a human, with consent + an audit trail (exactly how the middleware retire worked this session). That audit trail is the proof of independence. If an agent can silently soften it, the whole position collapses, so this has to be airtight. Treat any path that lets an agent edit/skip/disable a pin without surfacing it as a P0 bug.
2. **Be agent-neutral.** Works across Claude / GPT / Cursor / Copilot. Pinned is the Switzerland — the IDEs are bound to their own model; we are not. Neutrality across providers is itself a moat the incumbents can't copy. Do not accept feature requests that would tie Pinned to a single vendor's runtime.
3. **Lean hard into provider-mistake analytics.** "Across your codebase, this agent ships host-conditional bugs 3× more often than that one" — a neutral auditor's report card on the agents. It's our single strongest proof that we are the independent party: we grade them, we're not one of them. Make it the hero, not a footnote, in the product surface.

### Moat + caveat

- **Moat:** neutrality + tamper-proof enforcement + cross-provider analytics. Orgs buy an independent check they control specifically because they don't trust the vendor's agent to vouch for itself.
- **Caveat (don't break our own thesis):**
  - Stay independent. The moment Pinned gets bundled into / acquired-by one agent vendor, we lose the neutrality that *is* the value. Push back on partnerships that compromise it.
  - Keep the tamper-proofness genuinely airtight. Any silent-weakening path is a thesis-breaker, not a polish item.

### Unified banner with Cipherwake (one coherent story)

- **Pinned** = the independent verifier of what agents *write* (functional correctness).
- **Cipherwake** = the independent verifier of what agents *deploy* (security / trust posture).
- **Together** = *"the independent, agent-neutral verification layer for everything AI agents ship."*

That is the long-term reason a suite/combine eventually makes sense — same positioning, two surfaces. **The unbiased third-party referee for autonomous AI development.** Most defensible position available; the IDEs and labs structurally can't take it. Hold the two lines that make it true: **stay neutral, and make the guardrail genuinely un-weakenable.**

**Cipherwake stays a separate product** with its own surface (site / deploy / public trust). Same philosophical position, different telemetry. Do not let the two leak into each other's framing per [[readme-rewrite-spec]].

---

## Locked decisions (do not re-debate)

These were settled after a long iteration. If the user asks "should we rename / repivot / add a SaaS dashboard / etc.", remind them of the rationale here before agreeing.

### Naming
- **Project + npm name**: `pinnedai`. Picked over `claimlock`, `sigil`, `proofci`, `claimkit`, `etchd`, `vowly`, `pinned-ci`, `MergeProof`, `ChangeProof`, `Inferred`, `AI Change Verifier`, `AI Commit Reviewer`.
- **Binary name**: `pinned` (shorter, the verb).
- Reasoning: `.ai` TLD signal for the AI-coding audience + the metaphor IS the product (pin a claim to CI) + every cleaner alternative is already taken on npm. `sigil` was the runner-up brand pick but the npm name was reserved (unpublished 2013) and every reasonable domain was registered.

### Idea framing
The iteration went: Migration Guard → AI Change Verifier → Pinned (claims-as-tests) → MergeProof (preview deploy diff) → Inferred (LLM diff-to-claim) → settled on **Pinned**. The user explicitly closed the iteration with: "every time i ask ill get a new idea/answer, so how do I know what the best one is". The answer: stop polling LLMs, ship the simplest viable wedge, let real users select the next pivot. **Don't reopen the idea debate.**

### Architecture pillars (the five things that must hold)

1. **Constrained generation only.** The LLM never writes test logic. It fills slots in deterministic templates (route name, rate, threshold) AND extracts structured `Claim` objects from PR descriptions. Both use the same constrained-output shape. If you find yourself wanting the LLM to write a test from scratch, that's scope creep — push back.
2. **Tests live in the customer's repo.** Not on our cloud. Cancelling Pinned means losing nothing — the tests stay. That's the moat working.
3. **LLM-on-every-call, with regex as a cost-saver.** The parser runs regex AND LLM on every PR, unions the results, dedupes by `template:route:meta` key. Cache by SHA-256 content hash (30-day TTL) so PR sync events don't re-bill. Coverage is the value proposition — regex-only would silently miss half of natural-language claims. See `[[always-llm-architecture]]` memory.
4. **Keyless onboarding via OIDC.** The GitHub Action authenticates to our hosted endpoint with the GitHub-issued OIDC JWT — no API keys, no secrets, no signup gate for Free tier. The customer's *repo* is the identity. See `[[oidc-hosted-endpoint-mvp]]` memory.
5. **Split repo: CLI public, Worker private.** `apps/cli/` and `apps/landing/` ship to a public repo (Apache 2.0) — the CLI runs in customer CI and security teams demand auditability. `apps/edge/` (Worker) ships to a private repo because it contains the system prompt, advanced detection rules, and future Pro-tier features — all genuinely valuable IP that competitors should not be able to copy with a `git clone`. Auto-commit, custom templates, Bug Scout (v0.2+) all live in the private Worker. See `[[repo-split-public-private]]` memory.

### Default behavior
- Default to **auto mode** in `pinned init` — enables auto-protect (safe mode), pre-commit hook, pre-push hook, Claude statusline, and AI-coder rules in one prompt. Manual mode asks each individually. Auto-commit (PR side, GitHub Action) is also Free as of v0.1 — see updated tier model below for full Free/Pro split.

### Testing rule (LOCKED — every code change must run this before "done")

**HARD TRIGGER:** Before writing any of these words — `tested` / `ready` / `complete` / `done` / `ready to push` / `ready to ship` / `matrix passed` / `shippable` / `verified` — you MUST emit the checklist below with `[x]` or `[ ]` per box. **If any box is `[ ]`, you cannot use the trigger word.** Either do the missing work, or say "skipped X because Y" explicitly. No exceptions.

```
- [ ] Built clean (typecheck + tsup)
- [ ] Positive-catch case ran end-to-end against new code path
- [ ] Negative-skip case ran end-to-end against new code path
- [ ] Dyad-apps sweep regression (6 repos, exit=0, no novel errors)
- [ ] Network-touching: server-error path ran (402/429/5xx/unreachable)
- [ ] vitest existing suite green
```

Before reporting any code change as complete — feature, fix, refactor, or "tiny" cleanup — you MUST run BOTH halves of the matrix. "Built clean + existing vitest pass" is NOT sufficient.

1. **Positive-catch cases** — assemble a fresh minimal repo (or use a known-good fixture) that the new code SHOULD trigger / fire / catch / upload / write on. Run the changed code path end-to-end and verify the expected observable side-effect actually occurred (network request received, file written, exit code expected, output line matches). Do NOT trust "no error thrown" as proof — per [[feature-audit-signals-must-be-falsifiable]] every test must name the specific observable signal.

2. **Negative-skip cases** — assemble a repo (or set of env conditions) that the new code SHOULD NOT trigger on. Run and verify the side-effect did NOT occur. Disabled / unconfigured / missing-token / wrong-shape — at least one explicit "expected to do nothing" test.

3. **Dyad-apps regression sweep** — per [[fp-check-everything-with-real-tests]] Rule #1, run the changed code path against the dyad-apps real repos (back-in-play / myhpifinal / TradingAndArbIB / aiconciergeairbnb / socialideagen / quantasyte) and verify (a) no crashes, (b) no novel-FP errors introduced. Even when the change isn't a detector edit, sweep-path edits, hook edits, config-write edits, and statusline edits all need this.

4. **Network-touching changes** add a 4th case: the **server-error path**. Stand up a stub server that returns the failure mode (402 / 429 / 5xx / unreachable) and verify the CLI handles it without crashing and writes a usable `lastUploadResult` (or equivalent diagnostic) so the user can see what failed.

If any of those four is "I didn't run it" — say so honestly to the user instead of claiming "tested." Do NOT roll forward to commit/publish until you've actually verified the matrix. The user has caught the "tested → didn't actually test" pattern multiple times in this project; treat this as a P0 rule per [[dont-defer-buildable-fixes]] mentality.

Operational checklist when finishing a code change:
- [ ] Built clean
- [ ] vitest green (existing + any new matrix you added)
- [ ] Positive-catch case ran end-to-end against the new code path
- [ ] Negative-skip case ran end-to-end against the new code path
- [ ] Dyad-apps sweep regression (6 repos, exit=0 expected, no novel errors)
- [ ] Network-touching: server-error path ran; lastUploadResult or equivalent populated
- [ ] If any box is unchecked, explicitly tell the user before saying "ready to push"

### What we are NOT

- **Not a code-review bot** (CodeRabbit, Greptile, Copilot Workspace own that)
- **Not a runtime smoke tester** (Chromatic, Percy, Argos own that)
- **Not a dependency scanner** (Socket, Snyk own that)
- **Not a secrets scanner** (Gitleaks, GitHub native own that)
- **Not a SaaS dashboard** (until proven; Free + Pro should be 100% GitHub-Action-based)

Pinned does exactly one thing: **transforms PR claims into runnable, persistent CI artifacts.** Everything else is out of scope until the wedge is proven.

---

## Tier model (current — v0.1 ship target; see `[[tier-structure-v01]]` memory for older state)

| Tier | Price | **LLM calls/mo** | Pins | Auto-commit | BYOK | Auto-protect (today's features) | Other |
|---|---|---|---|---|---|---|---|
| **Free** | $0 | **1,000 public · 100 private** | **Unlimited** | ✅ Yes | ❌ | ✅ All modes (safe / ask / off) · hooks · watch · statusline | All 8 templates, no API key (OIDC) |
| **Founder Pro** (early) | **$9.99/mo** | 5,000 (fair use) | Unlimited | ✅ Yes | ✅ Anthropic/OpenAI key | ✅ All | Custom templates, priority LLM model, `@pinned fix` (v0.1.1). Founder pricing **locked while subscription remains active**. Reserved for early users before the wider launch. |
| **Pro** (post-launch) | $19/mo | 5,000 (fair use) | Unlimited | ✅ Yes | ✅ Anthropic/OpenAI key | ✅ All | Same Pro features as Founder Pro. Standard rate for users who join after the founder cohort. |
| **Team** | $199/mo | 50,000 | Unlimited | ✅ Yes | ✅ | ✅ All | Org policies, audit log, Slack alerts, CODEOWNERS routing |
| **Enterprise** | $20K+/yr | 1,000,000 OR self-host | Unlimited | ✅ Yes | ✅ | ✅ All | Self-hosted Worker (zero LLM cost to us), SSO, SOC 2 evidence export |

**Founder pricing rules (locked):**
- $9.99/mo for early users who subscribe before the wider launch.
- Rate locked while the subscription remains active. Cancel + resubscribe loses the founder rate.
- "Fair-use limits apply" — we don't promise "unlimited forever." If a tier-level cap changes, founder customers see the same limits as standard Pro (only price is locked).
- Marketing copy: *"Early users get founder pricing, locked while active."* Do NOT use phrases like "lifetime unlimited," "permanent unlimited," "50% off forever" — those trap us legally.
- Stripe payment links must be reviewed before launch to confirm the rate is `$9.99` (price ID: TBD-at-launch).

**Cost-bounded knob is LLM calls, not pins.** The Worker enforces a per-org/per-repo monthly LLM-call ceiling (D1 counter). Pin count is unlimited at every tier — capping pins caps the moat (compounding artifact accumulation). License keys do NOT exist; subscription is keyed by `repository_owner` (GitHub org) from the OIDC JWT.

**Why the model changed mid-build (do not relitigate):**
- Pin count is the moat metric — capping it caps the moat. Unlimited at every tier.
- LLM volume is the cost driver. That's what tiers gate.
- Auto-commit + auto-protect + hooks + statusline are all **client-side** (we don't pay for them). Locking them behind paywall would suppress adoption with no cost upside.
- Conversion happens on LLM-call exhaustion + Pro features (BYOK, custom templates, priority model).

**Strategic reasoning for the tier shape:**
- **Unlimited pins on Free** — the moat IS pin accumulation; capping pins caps the moat. Free users build real registries, feel the compounding value, become advocates.
- **All auto-protect features on Free** — the "feel alive" experience (auto-pinning on commit, statusline that grows, watch mode) is what makes Pinned compelling at first touch. Locking these creates a dead-feeling free tier.
- **Public + private on Free** — most professional dev work is in private repos. CodeRabbit gates by visibility *because* their cost structure (entire-diff LLM review) requires it. Our cost-per-call is 10-50× lower, so we don't need that gate. Maximum evaluation surface wins.
- **BYOK as Pro-only** — clean four-stack Pro value-prop (5K calls + BYOK escape + custom templates + priority model). Putting BYOK on Free creates a "why pay?" loophole.
- **Conversion target: 3% Free → Pro within 90 days of evaluation** — driven by LLM-cap exhaustion + Pro feature pull. See `[[OPS.md]]`.

**The Free-tier wedge**: keyless onboarding via OIDC. The GitHub Action requests an OIDC token (`permissions: id-token: write`); our private Worker validates against GitHub's JWKS, extracts the repo claim cryptographically, meters monthly quota in D1, and proxies the LLM call. Customer never creates an account, never sets a secret, never sees an API key. See `[[oidc-hosted-endpoint-mvp]]` memory.

**The Enterprise wedge**: every change has a runnable, signed audit-trail entry. PINS.md *is* SOC 2 / ISO 27001 / FedRAMP change-management evidence — except runnable, not a Notion doc. Cross-sell story with the user's other project (Quantasyte) which has compliance content.

---

## Current state (end of week 1)

What's done:
- ✅ Folder + pnpm workspace + TypeScript config
- ✅ `pinnedai@0.0.1` published to npm (name reserved, content placeholder — bump to 0.0.2 next publish)
- ✅ GitHub Action manifest at `action/action.yml`
- ✅ Self-CI workflow at `.github/workflows/ci.yml`
- ✅ **CLI fully wired** — every command does real work:
  - `pinned try` (default; bare `npx pinnedai` runs this) — zero-config demo: parses a sample PR body, prints the generated Vitest file
  - `pinned check [--description] [--json]` — regex-based claim parser, JSON mode for the Action
  - `pinned generate --pr-id X [--description] [--out-dir] [--dry-run]` — writes test files to `tests/pinned/`
  - `pinned init [--force]` — scaffolds `.github/workflows/pinned.yml` + `tests/pinned/` skeleton in the customer's repo
  - `pinned list [--include-retired]` — browses pinned claims for daily visibility
  - `pinned retire <claim-id> --reason="..."` — moves to `tests/pinned/retired/` + writes `<id>.audit.json`
- ✅ Claim parser at `apps/cli/src/claimParser.ts` — handles `"rate-limit(s|ed) /route to N req/min"` + `"rate-limit /route to N rpm/rps/rph"` forms, dedupes, returns `Claim[]`
- ✅ Template generator at `apps/cli/src/templates/rateLimit.ts` — emits a burst-parallel Vitest file (fires `RATE+1` requests, asserts ≥1 returns 429)
- ✅ Library entry at `apps/cli/src/index.ts` — re-exports `parseClaims`, `generateRateLimitTest`, types. **Browser-safe** (no Node imports). Used by the landing page demo for single-source-of-truth.
- ✅ **Landing page at `apps/landing/`** — Vite + React + plain CSS, ~49KB gzip. Lives at `pinnedai.dev` when deployed. Sections: hero, **interactive live demo** (paste a PR body → see the parsed claims + generated test update live), regression-simulator button (shows the FAIL output with back-reference to PR — the moat demo), why-different-from-code-review-bots grid, 4-tier pricing card, footer. Vite aliases `pinnedai` → `../cli/src/index.ts` so the demo runs the exact same code the CLI ships.
- ✅ Full lifecycle smoke-tested in a tempdir: generate → list → retire → list. Both pnpm `build` and per-package `typecheck` pass clean.

**Newly shipped in week-1.5 (stickiness features identified during planning):**
- ✅ **`tests/pinned/PINS.md`** — auto-maintained human-readable registry. Visible "behavioral contract" of the repo; every dev browsing on GitHub sees it. Compounds the moat: more pins → more value. Backed by `tests/pinned/.registry.json` as machine-readable source of truth.
- ✅ **`pinned scan-diff`** — the "No proof found" daily-loop habit trigger. Reads git diff against base ref, pattern-matches risk surfaces (new routes via Next.js app/pages router, webhook handlers, middleware changes, env file edits), cross-references coverage in PR body + existing pins. Outputs human/JSON/markdown.
- ✅ **`pinned check` + `pinned scan-diff` wired into the init workflow YAML** — generated `.github/workflows/pinned.yml` posts a PR comment with pin suggestions via `gh pr comment` (uses `GITHUB_TOKEN`).
- ✅ **Template 2: `auth-required`** — single GET without Authorization header, asserts 401/403.
- ✅ **Template 3: `idempotent`** — POST same payload twice, asserts byte-identical response (status + body).
- ✅ **Parser handles all 3 templates** — regex covers `auth required on /X`, `/X requires auth`, `makes /X idempotent on event_id`, `/X is idempotent by msg_id`, and `idempotent /X using y-id` forms.
- ✅ **Unit tests** — 25 parser tests + 13 scanDiff tests = 38 green.

What's NOT yet done (next concrete tasks):
- ⏳ LLM fallback path in the parser (regex first, hosted OIDC Worker only if regex returns 0 claims). Seam exists; the Worker is the missing piece.
- ⏳ **Hosted Cloudflare Worker** (`apps/edge/`) — JWT validation against GitHub JWKS, D1 quota counter (Free: 100 calls/repo/mo), OpenAI proxy with constrained extraction prompt. **Week 3 work.** See `[[oidc-hosted-endpoint-mvp]]` memory.
- ⏳ GitHub Action integration: also post the generated test content in the PR comment (current workflow posts scan-diff suggestions only; generated-test paste-mode is v0.1.1 polish).
- ⏳ Domain registration (`pinnedai.dev`) + Vercel deploy of `apps/landing` — week 4.
- ⏳ Push initial scaffold to `github.com/pinnedai/pinnedai` (new org per [[github-org-decision]] discussion) — week 0 carry-over.
- ⏳ Marketplace submission for `pinnedai/pinnedai` (root action.yml) — week 4.
- ⏳ `npm publish pinnedai@0.1.0` (bump from placeholder 0.0.1) — week 5 launch.

---

## Architecture (current)

```
/Users/michaelzon/dyad-apps/pinnedai/
├── package.json                    # pnpm workspace root
├── pnpm-workspace.yaml             # workspaces: apps/*
├── tsconfig.json                   # shared TS config (strict, ESM, Bundler resolution)
├── LICENSE                         # Apache 2.0
├── README.md                       # public-facing pitch (kept thin — landing page is the real one)
├── ROADMAP.md                      # week 0 → week 4 task list
├── CLAUDE.md                       # THIS FILE — handoff to future Claudes
├── .github/workflows/ci.yml        # self-CI: typecheck + build on PR
├── action/action.yml               # GitHub Action wrapping `npx pinnedai`
└── apps/
    ├── cli/                        # the `pinnedai` npm package — binary `pinned`
    │   ├── package.json            # name: "pinnedai", bin: "pinned", v0.0.1 (published, placeholder)
    │   ├── tsconfig.json
    │   └── src/
    │       ├── cli.ts              # Command shell — try / check / generate / init / list / retire / scan-diff
    │       ├── claimParser.ts      # parseClaims() + claimSlug() — regex-only, BROWSER-SAFE
    │       ├── claimParser.test.ts # 25 unit tests (rate-limit / auth-required / idempotent / dedup / edge cases)
    │       ├── scanDiff.ts         # scanDiff() — "No proof found" detector, BROWSER-SAFE (pure detection)
    │       ├── scanDiff.test.ts    # 13 unit tests (routes, webhooks, middleware, env, coverage suppression)
    │       ├── registry.ts         # Registry I/O + PINS.md renderer (uses node:fs — NODE-ONLY)
    │       ├── index.ts            # library entry — re-exports the browser-safe pieces + generateTest dispatcher
    │       └── templates/
    │           ├── rateLimit.ts    # generateRateLimitTest() — BROWSER-SAFE
    │           ├── authRequired.ts # generateAuthRequiredTest() — BROWSER-SAFE
    │           └── idempotent.ts   # generateIdempotentTest() — BROWSER-SAFE
    └── landing/                    # pinnedai.dev landing page — Vite + React + plain CSS
        ├── package.json            # name: "pinnedai-landing", private
        ├── vite.config.ts          # aliases `pinnedai` -> ../cli/src/index.ts
        ├── tsconfig.json
        ├── index.html
        └── src/
            ├── main.tsx
            ├── App.tsx             # hero + sections
            ├── Demo.tsx            # interactive live demo + regression simulator
            └── styles.css          # dark theme, amber accent
```

**Browser-safety contract** (load-bearing — protects the landing demo):
- `claimParser.ts`, `templates/*.ts`, `index.ts` must NOT import Node-only modules (`node:fs`, `node:path`, `node:process`, etc).
- Node-only code (fs writes, stdin, env, exit) lives ONLY in `cli.ts` and any future fs-touching modules.
- See `[[landing-page-only-marketing]]` memory for the why.

---

## The 4-week MVP roadmap (see ROADMAP.md for the full version)

### Week 1 — Foundation + Template 1 (rate-limit)
- Claim parser: regex + LLM fallback. Returns `{template: "rate-limit", route, rate}`.
- Test generator for `rate-limit:<route>:<rate>`. Emits a Vitest test file.
- Local end-to-end: `pinned generate pr-1247` writes test file, vitest runs it against a localhost rate-limited server.

### Week 2 — GitHub Action + PR comment + paste mode
- Action triggers on `pull_request: [opened, synchronize, edited]`.
- Generates test file as a string + posts in a PR comment ("paste-in-comment" mode).
- Multi-claim support.

### Week 3 — Templates 2 + 3 + retire flow
- `auth-required:<route>` template
- `idempotent:<webhook>:<id-field>` template
- `pinned retire <claim-id> --reason="..."` — moves test to `tests/pinned/retired/`
- First end-to-end demo on a real repo

### Week 4 — Polish + landing + design partners
- Auto-commit mode (Pro)
- Landing page at `pinnedai.dev`
- `npm publish pinnedai@0.1.0`
- GitHub Marketplace submission
- Outreach to 20 Cursor / Claude Code / Devin power-users → 3 design partners signed up

---

## How to run

```bash
cd /Users/michaelzon/dyad-apps/pinnedai
pnpm install            # one-time
pnpm build              # builds apps/cli/dist/cli.js
pnpm dev                # runs `tsx apps/cli/src/cli.ts` via the workspace alias

# Smoke test
node apps/cli/dist/cli.js --version
node apps/cli/dist/cli.js check --description "Rate-limits /api/users to 60 req/min."

# Direct workspace invocation
pnpm --filter pinnedai dev -- check --description "Auth required on /api/admin/export"
```

---

## Stack + dependencies

- **Node 20+** (`engines.node` in apps/cli/package.json)
- **TypeScript 5.6**
- **pnpm 9** (matches user's other projects)
- **commander 12** for CLI (matches Quantasyte's CLI pattern)
- **tsup** for ESM bundling
- **vitest** (target test framework for generated tests; not yet installed)

When adding the claim parser:
- For regex-first matching: pure JS, no dep
- For LLM fallback: `openai` SDK (gpt-4o-mini). Set `OPENAI_API_KEY` env var. Only call when regex fails.

---

## Distribution strategy

Mirrors the Quantasyte CLI approach (user's other project, same patterns):

1. **npm**: publish `pinnedai` unscoped (the scoped form is overkill for the first product).
2. **GitHub Marketplace**: separate repo `pinnedai/pinnedai` (root action.yml) so the action versioning is independent of the CLI.
3. **Landing page**: `pinnedai.dev` (domain to register). Single-page Vite + React. Tagline, demo GIF, install command, 4-tier price card. Pattern matches `quantasyte.com`.
4. **Launch posts**: Show HN, r/devsecops, r/javascript, dev.to. The demo GIF (open PR → comment → break claim → CI fails) IS the marketing.

---

## What the user has flagged

- **Verify before committing decisions**: the user has explicitly said they're done with idea-shopping. If they ask for a name change or pivot, push back once with the rationale here, then defer to them.
- **Ship-fast bias**: prefer the cheap, shippable path over the architecturally pure one. Hard cutoff at week 4 for v0.1.0 on npm.
- **Time-to-validation > idea quality**: real-user feedback in 4 weeks beats another month of LLM iteration.

---

## Related projects (for cross-reference)

- **Quantasyte** (`/Users/michaelzon/dyad-apps/quantasyte/`) — user's main project. Post-quantum security scanner. Pinned shares the OSS-CLI-on-npm distribution pattern + the GitHub-Action wrapper architecture. Code patterns to reuse: `apps/cli/src/cli.ts` shape, `apps/cli/scripts/publish.mjs` dual-publish pattern. **Don't pull Quantasyte source directly — pinnedai is independent. But the patterns are battle-tested.**
- The user runs both projects solo with AI tooling. Operating cost target during MVP: **~$0–5/mo Cloudflare + ~$50/mo OpenAI at design-partner scale**. v0.1 ships a small hosted Worker for the keyless OIDC Free tier; see `[[oidc-hosted-endpoint-mvp]]` memory. (Earlier "no API server" plan was reversed deliberately to optimize onboarding friction over operational footprint — do not undo this.)

---

## Outstanding TODOs (not yet started, in rough priority)

1. Reserve `pinnedai` on npm (zero-content publish — `npm publish` with a placeholder version so a squatter can't grab the name before week-4 v0.1.0 ships).
2. Register `pinnedai.dev` domain.
3. Create GitHub repo `pinnedai/pinnedai`, push initial scaffold.
4. Build the claim parser (week 1 day 1-3 task).
5. Build the rate-limit test generator (week 1 day 4-7 task).

---

## Honest risks (from ROADMAP.md, copied here for visibility)

| Risk | Mitigation |
|---|---|
| LLM hallucinates wrong claim → wrong test → user loses trust | Constrained template generation. LLM only fills slots. Only ship templates where the pattern is deterministic. |
| Behavioral tests need a running app | v1 requires `PREVIEW_URL` env var. v0.2 adds local-server mode. |
| Auto-generated tests in repos feel intrusive | Default is paste-in-comment, not auto-commit. Auto-commit is opt-in (Pro). |
| CodeRabbit / Greptile ships the same feature | Persistence is the moat. Generating *tests in the codebase* is architecturally different. They can't pivot easily. |
| Customer has no preview deploy | v0.2 adds unit-test mode with mocks. Weaker evidence but works. |

---

## Quick contact / context for the user

- **Founder**: Michael Zon (michaelzon7@gmail.com — verified working inbox)
- **Other project**: Quantasyte (compliance scanner, also pre-revenue, also AI-assisted solo build)
- **Tool stack the user is fluent in**: TypeScript, pnpm, Vite, React, Fastify, Supabase, Fly.io, Vercel, GitHub Actions
- **Style preference**: terse responses, no padding, no "let me know if I can help" trailing lines. Surface specific paths + line numbers when referencing code.

---

**If you're picking this up fresh: start by running `pnpm install && pnpm build`, then read ROADMAP.md, then start week 1 task 1 (claim parser).** Don't re-debate the name, the wedge, or the moat unless the user explicitly asks.

<!-- pinnedai:start -->
## Pinned

This repo uses Pinned to protect important behavior with tests in `tests/pinned/`. See `tests/pinned/AGENT.md` for the full reference (claim shapes, commands, examples).

Rules:
1. Before marking coding work complete, run the relevant test suite, including Pinned tests when affected.
2. Do not delete, weaken, skip, or rewrite tests in `tests/pinned/` unless the user explicitly asks to retire a pin.
3. If a Pinned test fails, assume the protected behavior may have been broken. Fix the application code first.
4. If the intended behavior changed, ask the user before retiring or updating the pin.
5. If you changed auth, payments, webhooks, booking, env vars, or public API routes, mention that Pinned should check the change.
<!-- pinnedai:end -->