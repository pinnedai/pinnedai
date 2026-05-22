# pinnedai — 4-week MVP roadmap

Started **2026-05-18**. Target: working npm package + GitHub Action + landing page + hosted OIDC endpoint + 3 design partners signed up by **2026-06-22** (one-week slip from original 06-15 to accommodate the hosted Worker — explicit trade-off for keyless Free-tier onboarding; see `[[oidc-hosted-endpoint-mvp]]` memory).

- **npm**: `pinnedai` (binary: `pinned`)
- **Website**: `pinnedai.dev` (to register)
- **Repo**: `github.com/mzon7/pinnedai`

---

## Week 0 — scaffold

- [x] Folder structure, pnpm workspace, TypeScript config
- [x] CLI shell: `pinned check`, `pinned generate`, `pinned retire` commands stubbed
- [x] GitHub Action manifest (composite action wrapping `npx pinnedai`)
- [x] CI workflow on the repo itself
- [x] README + ROADMAP
- [x] `pnpm install && pnpm build` runs clean
- [x] Reserve `pinnedai` on npm — **published 0.0.1 as placeholder, name secured**
- [ ] First commit + push to `mzon7/pinnedai`
- [ ] Register `pinnedai.dev` domain

## Week 1 — Foundation + Template 1 (rate-limit)

- [x] Claim parser: regex matchers for `rate-limit(s|ed) /route to N req/min` and `rate-limit /route to N rpm` forms. Returns structured `{template, route, rate, window, raw}`.
- [x] Test generator for `rate-limit:<route>:<rate>`. Emits a burst-parallel Vitest test file.
- [x] `pinned generate --pr-id X --description "..."` writes test files to `tests/pinned/`. Idempotent (skips existing claims). `--dry-run` prints instead.
- [x] `pinned init` scaffolds `.github/workflows/pinned.yml` + `tests/pinned/` in the customer's repo (one-command onboarding).
- [x] `pinned list` shows pinned + retired claims for daily-loop visibility.
- [x] `pinned retire <id> --reason="..."` moves to `retired/` + writes `<id>.audit.json` audit entry.
- [x] **`pinned try` (default command)** — zero-config demo, runs end-to-end on a sample PR body. The tweet→terminal onboarding moment.
- [x] **Landing page at `apps/landing/`** with interactive live demo + regression simulator. Imports parser/template from `apps/cli/src/index.ts` (single source of truth, browser-safe).
- [x] Configurable `PREVIEW_URL` env var for behavioral tests (generated tests fail loudly if unset).
- [x] Vitest unit tests for the parser — 25 tests, all green.
- [x] **PINS.md auto-maintained registry** + `.registry.json` source-of-truth — rank-2 sticky feature.
- [x] **`pinned scan-diff`** — "No proof found" detector, rank-3 sticky feature. 13 unit tests green.
- [ ] LLM fallback when regex returns 0 claims (seam left clean — wires to Worker in week 3).
- [ ] Local end-to-end: spin up a localhost rate-limited toy server and confirm a generated test actually fails on regression.

## Week 2 — GitHub Action + PR comment + templates 2+3

- [x] Vitest unit tests for `claimParser.ts` — 25 tests green.
- [x] Vitest unit tests for `scanDiff.ts` — 13 tests green.
- [x] Action triggers on `pull_request: [opened, synchronize, edited]`, parses body from event payload.
- [x] PR comment posted via `gh pr comment` (uses `GITHUB_TOKEN`) — currently posts scan-diff suggestions, not generated tests.
- [x] Multi-claim support (one PR description → multiple test files written by `pinned generate`).
- [x] Friendly "no claims found" path with examples.
- [x] Template 2: `auth-required:<route>`. Single request to the route, expects 401/403.
- [x] Template 3: `idempotent:<webhook>:<id-field>`. Fires same payload twice, asserts byte-identical response.
- [ ] **Deferred to v0.1.1:** PR comment also includes the *generated test file content* for paste-in mode. (Today: comment includes pin suggestions only; customer runs `pinned generate` locally to write tests.)

## Week 3 — Hosted OIDC endpoint + always-LLM + abuse protection

- [x] Cloudflare Worker scaffolded at `apps/edge/` (private repo target).
- [x] OIDC JWT validation against `https://token.actions.githubusercontent.com/.well-known/jwks` (cache JWKS, verify signature, check audience).
- [x] Per-repo monthly quota counter in Cloudflare D1 (Free = 100 calls/repo/mo).
- [x] OpenAI proxy endpoint scaffolded — needs always-LLM + content-hash cache wiring.
- [x] CLI scaffolds the OIDC token fetch from Actions runtime (`ACTIONS_ID_TOKEN_REQUEST_URL`).
- [ ] **PIVOT: always-call LLM** (not "fallback when regex returns 0"). Run regex AND LLM, union results, dedupe. Drives coverage from ~70% to ~95%.
- [ ] **SHA-256 content-hash cache** in D1 (30-day TTL). Cache hits don't count toward quota — PR sync events become free.
- [ ] **BYOK paths in CLI** — detect `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` env vars (Pro tier feature), call directly without going through our Worker. License-check gates it.
- [ ] **Abuse protection layers**:
  - Per-repo monthly cap: 100 calls (Free) / 1,000 (Pro) / pooled 10K (Team)
  - Per-repo daily cap: 20 calls/day (Free) — prevents burning monthly cap in 1 hour
  - Per-IP rate limit: 30 req/min (Cloudflare native)
  - Body size cap: 50KB max (already in place)
  - Public-repo eval doesn't apply (we allow private on Free)
- [ ] `GET /admin/stats` JSON endpoint on Worker, auth-gated with `ADMIN_KEY` secret. Returns: active repos this month, total calls, OpenAI cost estimate, top consumers. v0.1.1 = visual dashboard reads this.
- [ ] Worker deployed to `https://api.pinnedai.dev`.
- [ ] **Repo split**: move `apps/edge/` to `pinnedai/pinnedai-edge` (private) before first public push. Keep `apps/cli/` + `apps/landing/` in `pinnedai/pinnedai` (public).

## Week 4 — Landing deploy + Marketplace + demo recording

- [ ] Landing page deployed to Vercel at `pinnedai.dev` (domain registered).
- [ ] Update Free-tier copy on landing: "100 LLM calls/repo/mo via OIDC — no API key needed."
- [ ] Record demo GIF: open PR with rate-limit claim → Action posts comment → paste test → merge → push regression commit → CI fails with back-reference.
- [ ] GitHub Marketplace submission for `pinnedai/pinnedai-action` repo.
- [ ] First end-to-end demo on a real toy repo (publicly linkable).

## Week 5 — Launch

- [ ] `npm publish pinnedai@0.1.0` (bump from placeholder 0.0.1).
- [ ] Launch posts: Show HN, r/devsecops, r/javascript, dev.to.
- [ ] Outreach to 20 names from X/Twitter network (Cursor / Claude Code / Devin power users).
- [ ] Goal: 3 design partners signed up by end of week.
- [ ] Monitor OpenAI bill daily during the first week; ratchet Free quota down if a single repo dominates spend.

## Deferred to v0.1.1 (post-launch)

- Per-org dashboard (if any users actually ask for it; otherwise keep it CLI-only).
- LLM-diff-to-claim inference ("Inferred" mode) — when PR description is bare, infer claims FROM the diff.
- Method slot in templates (GET vs POST for auth-required, etc.) — Claim type extension.
- `pinned doctor` checks PREVIEW_URL based on registry's active pins, not directory listing.

## Possible v0.2+ product feature

**Pinnedai-as-code-review-bundler.** The workflow we developed for shipping code to GPT (self-contained bundles with embedded prompts, round-numbering on iterations) could become a pinnedai feature itself: `pinned review-bundle` generates a self-contained text file with the review prompt + relevant source code, ready to paste into Claude / GPT / Gemini for a bug audit. Tied to the wedge because the bundles include the customer's pins as part of the review context. See `[[code-review-bundle-workflow]]` memory for the workflow that inspired this.

---

## Post-MVP (v0.2+) — expansion paths in priority order

### New claim templates (order driven by design-partner feedback)

Shipping with **9 templates** in v0.1: rate-limit, auth-required, idempotent, returns-status, cli-output-contains, cli-exits-zero, cli-creates-file, cli-flag-supported, library-returns.

Deferred templates — add the first 2-3 based on actual customer requests, NOT speculation:

| Template | Example claim | Why valuable |
|---|---|---|
| `response-shape` | "/api/users returns `{id, email}` only — never `password_hash`" | Data-leak protection. #1 AI regression class. |
| `row-limit` | "/api/list returns ≤100 items per page" | Pagination drift is silent + common. |
| `role-required` (with non-admin token fixture) | "/api/admin/export requires admin role" | True role-fixture testing. v0.1 maps this phrasing to auth-required (route-not-public). Real version needs `PINNEDAI_NONADMIN_TOKEN` env. |
| `env-required` | "Requires DATABASE_URL env var" | Already a scanDiff suggestion; just no template yet. |
| `cli-exits-nonzero` | "`pinned generate --pr-id ../etc` exits 1" | Inverse of cli-exits-zero — for error-path claims. |
| `schema-migration-reversible` | "Migration `0042_add_user_role` is reversible" | Database safety. Niche but compelling for compliance customers. |

The README's CLI table + `What you can claim` section both invite issue requests for templates not yet supported. We add when demand exists.

### Other v0.2+ expansion paths

1. **LLM diff-to-claim inference**: when PR description is garbage, infer claims FROM the diff (the "Inferred" framing — best v0.2 feature add)
2. **Custom claim templates**: customers define their own template patterns
3. **Org policies**: "every PR must pin ≥1 claim" (Team tier feature)
4. **Slack alerts** on claim breaks in main (Team tier)
5. **Multi-language**: today Vitest/Node only. Add Python/pytest, Go/test, Ruby/rspec.
6. **Self-hosted runner** (Enterprise tier)
7. **SOC 2 / ISO 27001 audit-trail export** — every claim becomes a signed change-management evidence entry

---

## Honest risks tracker

| Risk | Mitigation |
|---|---|
| LLM hallucinates wrong claim → wrong test → user loses trust | Constrained template generation — LLM only fills slots, never writes test logic. Only ship templates where the pattern is deterministic. |
| Behavioral tests need a running app | v1 requires `PREVIEW_URL` env var. Most Vercel/Netlify users already have this. v0.2 adds "spin up local server in CI" mode. |
| Auto-generated tests in customer repos feel intrusive | Default mode is "paste-in-comment", not auto-commit. Auto-commit is opt-in (Pro feature). |
| CodeRabbit / Greptile ships the same feature | Persistence is the moat. Generating *tests in the codebase* is architecturally different from posting review comments. Their codebase doesn't easily pivot. |
| Customer has no preview deploy | v0.2 adds "unit test mode" — generated tests use mocks instead of HTTP calls. Weaker evidence but works without preview deploys. |
