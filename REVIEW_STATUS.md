# pinnedai — code review tracker

> Operational file. Stays in the private monorepo (never synced to public mirror).
>
> See `[[gpt-review-before-launch]]` memory rule: every bundle must be ✅ signed-off
> with zero outstanding CRITICAL/HIGH findings before v0.1 launch.

Last updated: 2026-05-22

---

## Bundle status

| Bundle | Files | Current version | Last review | Outstanding HIGH | Outstanding MEDIUM | Outstanding LOW | Signed off? |
|---|---|---|---|---|---|---|---|
| **bundle-1-cli-src** | `apps/cli/src/cli.ts`, `claimParser.ts`, `scanDiff.ts`, `registry.ts`, `statusline.ts`, `dayZeroVerify.ts` (new), `agentRules.ts`, `llmExtract.ts`, `llmDirect.ts`, `index.ts`, `templates/{rateLimit,authRequired,permissionRequired (new),idempotent,returnsStatus,cliOutputContains,cliExitsZero,cliCreatesFile,cliFlagSupported,libraryReturns,sharedFetch (new)}.ts` + package.json + tsconfig.json | **v12** (day-zero verify, coverage mapping, permission-required template, FP infra, bad_case, multi-tool rule install, --from-agent flag) | 2026-05-20 | 0 | 0 | 0 | 🔴 needs re-review of v12 — major surface added |
| **bundle-2-cli-tests** | All CLI `*.test.ts` files + full `audit/` suite (now 35 audit files: 14 CLI features incl. J/K/L/M/N/O/P/Q/R, 8 templates, 5 Worker, 4 sticky + e2e dogfood with 15 phases) | **v10** (62 new audit cases added across L/M/N/O/P/Q/R; e2e expanded to 15 phases) | 2026-05-20 | 0 | 0 | 0 | 🔴 needs re-review of v10 — many new audits |
| **bundle-3-edge-src** | `apps/edge/src/{index,jwt,quota,cache,openai,subscriptions,badge}.ts` + wrangler.toml + schema.sql | **v7** (no functional change since v6) | 2026-05-20 | 0 | 0 | 0 | 🟡 pending re-review of v7 (unchanged this round, but never signed off) |
| **bundle-4-edge-tests** | All Worker `*.test.ts` files | **v7** (no functional change since v6) | 2026-05-20 | 0 | 0 | 0 | 🟡 pending re-review of v7 (unchanged this round) |
| **bundle-5-landing** | `apps/landing/src/{main,App,Demo}.tsx`, `seo/*.tsx`, styles.css, index.html, vite.config.ts | **v8** (Guardrail positioning hero/subhead/lede, FAQ FP entry, "Bugs Pinned catches" section, permission-required chip + failure-block, REVIEW · N touched mention) | 2026-05-20 | 0 | 0 | 0 | 🔴 needs re-review of v8 — copy + section added |
| **bundle-6-configs** | Root configs, action manifest, all 3 workflows, PR template, dogfood + audit configs, scripts/*, NEW: `apps/vscode-extension/` (manifest, src/, README, PUBLISHING.md) | **v10** (vscode-extension package + publish scripts added) | 2026-05-20 | 0 | 0 | 0 | 🔴 needs re-review of v10 — new package surface |

## Launch-readiness gate

v0.1 cannot ship until **every bundle is ✅ signed off**. Currently:
- 4 bundles touched this round (1, 2, 5, 6) — all need fresh review at their new version
- 2 bundles unchanged this round (3, 4) — pending re-review of v7 from last batch
- 0 of 6 bundles fully signed off for v0.1 launch

### What to send for review next

Run `bash scripts/make-review-bundles.sh --bumped 1,2,5,6` to assemble the four touched bundles at their new versions for GPT review. The bundles unchanged this round (3, 4) can be re-sent at their existing version when convenient.

Once GPT review completes for all six:
1. Apply any BLOCKING / HIGH findings.
2. Re-run `pnpm run audit:features` + `pnpm test` + `bash audit/e2e/fake-project-dogfood.sh` to confirm fixes didn't regress anything.
3. Bump `apps/cli/package.json` from 0.0.1 → 0.1.0.
4. Tag the release in git, push to GitHub.
5. Publish to npm.
6. Submit GitHub Action to Marketplace.
7. Deploy Worker to Cloudflare with production env vars.
8. Publish VS Code extension to OpenVSX (day 0) + VS Code Marketplace (day 1-2).

## Round history for bundle-1-cli-src

| Round | Version sent | Issues found | Fixed this round | Deferred to v0.1.1 |
|---|---|---|---|---|
| 1 | v1 | 20 (5H sec, 3H corr, 8M, 4L) | 19 | method-slot |
| 2 | v2 | 17 | 14 | cross-file txn, method-slot, registry-lock |
| 3 | v3 | 13 | 9 | license validity, registry-lock, doctor-from-registry, cross-file txn |
| 4 | v4 | 13 | 7 | license validity (intentional v0.1 design), method-slot, cross-file txn, registry-lock |
| 5 (new prompt) | v5 | 4 (all NICE-TO-HAVE) | 4 | none |

## Round history for bundle-2-cli-tests

| Round | Version sent | Issues found | Fixed this round | Deferred |
|---|---|---|---|---|
| 1 (new prompt) | v1 | 3 NICE-TO-HAVE + 1 misc | 4 | none |
| 2 | v2 | 2 NICE-TO-HAVE (both same finding: weak assertion in adversarial markdown test) | 2 (strengthened to assert escape-encoding + table-column-count) | none |

## Round history for bundle-3-edge-src

| Round | Version sent | Issues found | Fixed this round | Deferred |
|---|---|---|---|---|
| 1 (new prompt) | v1 | **1 BLOCKING** + 4 NICE-TO-HAVE | 5 | none |

Round 1 BLOCKING resolved:
- 🚨 `index.ts` — 50KB body cap was enforced AFTER OIDC validation + license DB lookup AND used `body.body.length` (UTF-16 code units, not bytes). → Now reads raw text first, applies `new TextEncoder().encode(raw).byteLength <= 50_000` BEFORE OIDC + license work; oversized requests reject without burning expensive auth cycles.

Round 1 NICE-TO-HAVE resolved:
- `jwt.ts` — `exp` boundary used `<` (accepted exact-second tokens) → now `<=` per JWT spec.
- `licenses.ts` — plain `INSERT` could throw on the astronomical-but-possible UUID collision → now `ON CONFLICT(license_key) DO NOTHING` + retry loop (3 attempts, throws after).
- `index.ts` — admin auth accepted `?key=` query param (leaks via logs/history) → header-only now (`X-Admin-Key` or `Authorization: Bearer`).
- `wrangler.toml` + `schema.sql` — `FREE_QUOTA_PER_MONTH = "25"` confused customer-facing pin cap with Worker abuse-defense → set to 100, comments updated to clarify the two distinct limits.

## Round history for bundle-4-edge-tests

| Round | Version sent | Issues found | Fixed this round | Deferred |
|---|---|---|---|---|
| 1 (new prompt) | v1 | 6 NICE-TO-HAVE (assert on stored rows, mock ON CONFLICT, monthly reset, expires_at, license status transition, malformed long keys) | 6 (added 11 new tests with POSITIVE CONTROL markers, synthetic-time fakers for month boundary + cache expiry) | none |

## Round history for bundle-5-landing

| Round | Version sent | Issues found | Fixed this round | Deferred |
|---|---|---|---|---|
| 1 (new prompt) | v1 | 1 NICE-TO-HAVE (incomplete OG meta tags) + 1 misc (footer GitHub URL mismatched CLI's `repository.url`) | 2 (added og:type/url/image + twitter:card; aligned CLI package.json to github.com/pinnedai/pinnedai + added bugs URL) | none |
| 2 | v2 | All ✓ verified. 1 conditional NICE-TO-HAVE flagging that the URL would need updating IF we end up using a different org than pinnedai/pinnedai — but per `[[repo-split-public-private]]` memory, pinnedai/pinnedai is the locked target. | 0 (no fix needed; URL is at documented target) | none |

## Round history for bundle-6-configs

| Round | Version sent | Issues found | Fixed this round | Deferred |
|---|---|---|---|---|
| 1 (new prompt) | v1 | **2 BLOCKING** + 3 NICE-TO-HAVE | 5 | none |
| 2 | v2 | All ✓ verified. 1 NICE-TO-HAVE: composite action didn't enforce caller-side `actions/checkout` precondition. | 1 (added preflight step that fails fast with a clear error if `.git` missing or `origin/$BASE_REF` not fetched) | none |

Round 1 BLOCKING items resolved:
- 🚨 `action/action.yml` was a parser-only stub that diverged from `pinned init`'s workflow → rewrote as full composite action (check + scan-diff + PR comment + auto-commit, mirroring the init-emitted workflow).
- 🚨 `.github/workflows/ci.yml` did not run tests → added `pnpm test` step + added root `test` script that calls `pnpm -r --if-present test`.

Round 1 NICE-TO-HAVE items resolved:
- `action/action.yml` `${{ inputs.cli-version }}` interpolated into bash → now via `CLI_VERSION` env var.
- `scripts/sync-public.sh` didn't refuse on untracked files → added `git ls-files --others --exclude-standard` check.
- Root `lint` script called `eslint` without `eslint` in devDeps → removed the broken lint script (linting was never wired; defer to v0.1.1 if needed).

## Deferred findings (cleared exceptions — not blocking launch)

These are explicitly accepted as v0.1 limitations:

- **~~License local validation by format only~~** — **RESOLVED v0.1.1**: license keys removed entirely. Plan is determined server-side by the Worker via OIDC `repository_owner` → `subscriptions` table lookup. There is no client-side validation path to bypass. BYOK is now an explicit opt-in (`byok: anthropic|openai` action input + `PINNEDAI_ANTHROPIC_KEY`/`PINNEDAI_OPENAI_KEY` secret) and is gated by Worker-confirmed paid plan via the new `/v1/plan` endpoint.
- **Method slot in claim templates (GET vs POST)** — v0.1.1 work. Requires Claim type change + parser update + landing demo update + extra regex test cases.
- **Cross-file transactional writes (.registry.json + PINS.md)** — single-file atomic suffices for v0.1 failure modes. `pinned doctor` could regenerate PINS.md from registry if drift is observed.
- **`pinned doctor` PREVIEW_URL check uses directory listing not registry** — v0.1.1. Low impact; the warning fires on the same conditions either way.
- **Local concurrent CLI registry race** — workflow `concurrency:` block handles the Actions case; local races are rare and not catastrophic.

## How to update this file

- After every code change touching a bundle, manually mark that bundle as "🟡 pending re-review of v<N>".
- After running `bash scripts/make-review-bundles.sh --bumped N` post-fix, increment that bundle's current version + add a row to its round history.
- Before claiming launch-ready, every bundle row must be ✅ signed off with 0 outstanding HIGH.
