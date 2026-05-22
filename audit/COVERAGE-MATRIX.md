# Feature coverage matrix

> Every user-perceivable feature, with: the **signal** when healthy, how a
> real **regression would be caught** (true positive), how we avoid
> **false positives** when behavior changes legitimately, and audit
> coverage status.

**Legend**:
- ✅ **AUDITED** — pos+neg controls in `audit/`, falsifiable
- 🟡 **PARTIAL** — covered by unit tests or partially audited; missing pos+neg shape
- ⚠ **GAP** — no test currently catches this. Recommend audit.

**Status counts**: 47 ✅ · 18 🟡 · 31 ⚠ · **96 total feature surfaces tracked**

The ⚠ GAP rows are the work-list for v0.1.1+ audit expansion.

---

## A. CLI commands & flags (perceivable user actions)

### A.1 — Top-level commands

| # | Feature | Signal when healthy | True-positive trigger | No-false-positive guard | Status | File |
|---|---|---|---|---|---|---|
| A1 | `npx pinnedai` runs the demo | stdout contains `pinnedai try` + `Parsed N claim(s)` + `Generated test file` + `Next:` block | Any of those 4 strings disappears | Refactoring internal slug/hash format → onboarding strings stay stable | ✅ | `audit/features/01-bare-npx-demo.audit.ts` |
| A2 | `pinned --version` prints package version | stdout = the exact value in apps/cli/package.json's `version` field | Hardcoded version drift, or `.version()` call dropped from Commander | Bumping the version is intentional — audit reads from package.json | ⚠ | needs `09b-version-prints.audit.ts` |
| A3 | `pinned --help` lists every command | stdout contains: `try`, `check`, `generate`, `init`, `list`, `retire`, `scan-diff`, `baseline`, `doctor` | A command is added/removed from Commander setup | Renaming an internal arg doesn't remove the subcommand | ⚠ | needs `00-help-lists-commands.audit.ts` |
| A4 | `pinned try` produces a sample claim + generated test (same as A1) | Identical to A1 | Same as A1 | Same as A1 | ✅ | `audit/features/01-bare-npx-demo.audit.ts` |
| A5 | `pinned init` scaffolds 5 expected files + workflow has id-token + contents perms | All 5 file paths exist; workflow YAML contains both perm strings | Any scaffolded path missing or perm dropped from workflow template | Comment changes to YAML don't break the assertions (we grep for specific strings) | ✅ | `audit/features/02-init-scaffold.audit.ts` |
| A6 | `pinned check` parses claims and reports count | stdout `Found N claim(s):` with N = expected count; canonical prefix per template | Parser regex breaks; template prefix string changes | Description prose around the claim doesn't affect count | ✅ | `audit/features/03-check-parses.audit.ts` |
| A7 | `pinned generate` writes test files + updates registry + PINS.md | N test files appear with `<prId>-` prefix; registry has N active entries; PINS.md lists each route | Generator dispatcher drops a template; registry write skipped | Different fixtures still produce the SAME shape (path + json keys); only counts and presence asserted | ✅ | `audit/features/04-generate-writes.audit.ts` |
| A8 | `pinned list` reports pin count + filenames | stdout `Pinned claims (N):` with N matching the directory's `.test.ts` files | List read path breaks; counting fails | Reordering doesn't matter (we assert each filename present, not order) | ✅ | `audit/features/05-list-shows.audit.ts` |
| A9 | `pinned retire <id>` moves file + writes audit + flips registry status | File moves to `retired/`; `<id>.audit.json` appears with reason; registry status = "retired" | Move skipped, audit write skipped, registry status not updated | Different `--reason` strings still produce same file movements (we assert `reason` field matches input) | ✅ | `audit/features/06-retire-moves.audit.ts` |
| A10 | `pinned scan-diff` detects new routes as risk surfaces | stdout names the new route; suggests claim in canonical phrasing | Heuristic breaks (router pattern changes); base ref handling breaks | Unrelated file changes (README) don't produce false suggestions | ✅ | `audit/features/07-scan-diff-detects.audit.ts` |
| A11 | `pinned baseline` finds candidate pins in working tree | stdout contains each app/api route + "candidate / suggested / risk-surface" | Walk function breaks; detector breaks | Adding an unrelated file (lib.ts) doesn't show as a candidate (only known risk patterns flagged) | ✅ | `audit/features/08-baseline-finds.audit.ts` |
| A12 | `pinned doctor` reports ✓ per check in healthy repo, exit 0 | Each of 5 named checks appears with ✓; stdout `All checks passed`; exit 0 | A check disappears, exit code stops reflecting failures | Pin count changes don't fail doctor; only declared-perm/file checks gate exit | ✅ | `audit/features/09-doctor-reports.audit.ts` |

### A.2 — Flag combinations

| # | Feature | Signal | TP trigger | No-FP guard | Status | File |
|---|---|---|---|---|---|---|
| A13 | `pinned check --json` emits valid JSON array of claims | stdout parses as JSON; each item has `template` + `route`/`functionName` field; exit 0 | JSON formatting drops; field renamed | Adding a new template adds a new array entry, doesn't break shape | ⚠ | needs `03b-check-json.audit.ts` |
| A14 | `pinned check` reads `GITHUB_PR_BODY` env when --description omitted | Without `--description`, body comes from env; output matches A6 signal | Env var lookup skipped or wrong name | Whitespace-only env doesn't false-pass; falls through to stdin | ⚠ | needs `03c-check-env-input.audit.ts` |
| A15 | `pinned check` reads stdin when no --description and no env | Piped body produces parse output identical to --description | Stdin reader broken; size cap | Empty stdin doesn't crash — produces "No PR description provided" | ⚠ | needs `03d-check-stdin.audit.ts` |
| A16 | `pinned generate --dry-run` writes NO files; prints test content | Filesystem unchanged after run; stdout contains generated test content | Dry-run flag ignored | Real run without flag DOES write — proves flag is honored | ✅ | `audit/features/04-generate-writes.audit.ts` (NEGATIVE CONTROL) |
| A17 | `pinned generate --out-dir <path>` writes to custom dir | Files appear at the custom path, not `tests/pinned/` | Hardcoded path | Default path still works without flag | ⚠ | needs `04b-generate-outdir.audit.ts` |
| A18 | `pinned generate --pr-id <unsafe>` rejected | stderr `Invalid --pr-id`; exit non-zero; no files written | assertSafeId stops validating | Safe ids like `pr-1247` still work | ⚠ | needs `04c-generate-prid-safety.audit.ts` |
| A19 | `pinned scan-diff --markdown` emits PR-comment-shaped output | stdout contains markdown headings (`###`), table separators or bullet list with backtick code spans | Renderer breaks; double-escapes | Plain text mode (no --markdown) still works | ⚠ | needs `07b-scan-diff-markdown.audit.ts` |
| A20 | `pinned scan-diff --json` emits valid JSON suggestions array | stdout parses; each item has `template`, `route`, `reason`, `files` | JSON shape drift | Adding new detector keeps existing shape | ⚠ | needs `07c-scan-diff-json.audit.ts` |
| A21 | `pinned baseline --json` emits JSON suggestions array | Same as A20 | Same | Same | ⚠ | needs `08b-baseline-json.audit.ts` |
| A22 | `pinned baseline --markdown` emits valid Markdown | Same as A19 | Same | Same | ⚠ | needs `08c-baseline-markdown.audit.ts` |
| A23 | `pinned list --include-retired` shows Retired section | stdout `Retired (N):` AND separate `Pinned claims (M):` sections | Section split breaks; counts merge | Without flag, retired section is hidden — flag is gating | ⚠ | needs `05b-list-include-retired.audit.ts` |
| A24 | `pinned init --force` overwrites existing files | Existing workflow content is replaced with current template | Force flag silently ignored | Without --force, existing files preserved (we audit this in A5 negative) | ⚠ | needs `02b-init-force.audit.ts` |
| A25 | `pinned init` second run is idempotent | Running twice in same dir is no-op (skips existing); exit 0 | Second run errors out | Force flag still overwrites — proves the idempotency is intentional | ⚠ | needs `02c-init-idempotent.audit.ts` |

---

## B. Template behaviors

Each template has 3 distinct surfaces:
- **B-extract**: parser correctly extracts the claim from PR description
- **B-generate**: generator emits a runnable Vitest file with the correct shape
- **B-execute**: the generated test, when run, correctly verifies the claim

| # | Template | Signal | TP trigger | No-FP guard | Status | File |
|---|---|---|---|---|---|---|
| B1 | rate-limit extract | parser returns `{template:"rate-limit", route, rate, window}` for canonical phrasing | Regex breaks; window-word table drops a synonym | "Rate-limit" inside a code span doesn't auto-extract (regex bounded) | ✅ | `claimParser.test.ts` + `audit/templates/rate-limit.audit.ts` (pos via generated test) |
| B2 | rate-limit generate | Vitest file with `burstSize = RATE+1`, asserts `statuses.includes(429)` | Generator drops the burst loop or 429 assertion | Different rate values produce different test contents (we deep-check on the rate) | 🟡 | covered indirectly via B3 + `templates.test.ts` |
| B3 | rate-limit execute | Generated test passes against fixture with limiter; fails with PINNED FAILURE against fixture without | Behavior drift | Both fixtures are byte-identical except for rate-limit logic | ✅ | `audit/templates/rate-limit.audit.ts` |
| B4 | auth-required extract | parser returns `{template:"auth-required", route}` | Synonyms (authentication, requires auth) regex drops | "auth" inside a code span without surrounding context doesn't auto-extract | ✅ | parser unit tests + audit (B6) |
| B5 | auth-required generate | Vitest file with no Auth header, asserts `[401, 403].includes(status)` | Generator drops the header-less GET | Different routes produce different test content (JSON-stringified route appears) | 🟡 | indirect via B6 |
| B6 | auth-required execute | Generated test passes against fixture that 401s without header; fails against fixture that 200s | Behavior drift | Both fixtures share routing; only auth check differs | ✅ | `audit/templates/auth-required.audit.ts` |
| B7 | idempotent extract | parser returns `{template:"idempotent", route, idField}` | "Idempotent" synonyms (on, by, using, via, keyed-on) regex breaks | Backticked code "idempotent" without surrounding context excluded | ✅ | parser unit tests + audit |
| B8 | idempotent generate | Vitest file with 2 POSTs of identical body, deep-compare on status + body bytes | Generator drops second POST or body comparison | Different idField values change generated content | 🟡 | indirect via B9 |
| B9 | idempotent execute | Generated test passes against fixture that dedups by idField; fails against fixture that returns unique bodies | Behavior drift | Idempotent server with DIFFERENT idField still works (template doesn't false-match) | ✅ | `audit/templates/idempotent.audit.ts` |
| B10 | cli-output-contains extract | parser returns `{template:"cli-output-contains", route, text}` | Verb synonyms (outputs, prints, reports, emits, shows) regex breaks | "contains" intentionally excluded — too ambiguous (covered in unit tests) | ✅ | parser unit tests + audit |
| B11 | cli-output-contains generate | Vitest with `execFileSync` (no shell), pre-tokenized argv, stdout substring assertion | Generator switches to `shell: true` (vuln!) | Different commands produce different ARGV arrays | ✅ | `templates.test.ts` + audit |
| B12 | cli-output-contains execute | Generated test passes when fixture stdout = expected; fails when stdout differs | Behavior drift | Exit code 0 with WRONG stdout still fails (signal is substring, not exit) | ✅ | `audit/templates/cli-output-contains.audit.ts` |
| B13 | cli-exits-zero extract | parser returns `{template:"cli-exits-zero", route}` for "exits 0" + synonyms | Regex breaks on "exits cleanly/successfully" | "exits 1" or other non-zero codes are NOT matched | ✅ | parser unit tests + audit |
| B14 | cli-exits-zero generate | Vitest with `spawnSync`, asserts `result.status === 0` | Generator stops checking status | Different commands produce different ARGV; same status check | 🟡 | indirect via B15 |
| B15 | cli-exits-zero execute | Generated test passes when fixture exits 0; fails when exits 1 | Behavior drift | Slow exit (delayed by setImmediate) still works (we don't fail on timing) | ✅ | `audit/templates/cli-exits-zero.audit.ts` |
| B16 | cli-creates-file extract | parser returns `{template:"cli-creates-file", route, filePath}` | Synonyms (creates, writes, produces, generates) regex breaks | Absolute paths in filePath rejected at parse time | ✅ | parser unit tests + audit |
| B17 | cli-creates-file generate | Vitest in tempdir with `existsSync` check; refuses absolute paths at runtime | Generator stops creating tempdir or stops asserting existence | PINNED_CLI_CWD override path still works | ✅ | `templates.test.ts` + audit |
| B18 | cli-creates-file execute | Generated test passes when fixture creates expected file; fails when nothing created | Behavior drift | File created in different dir doesn't false-pass (test runs in isolated tempdir) | ✅ | `audit/templates/cli-creates-file.audit.ts` |
| B19 | cli-flag-supported extract | parser returns `{template:"cli-flag-supported", route, flag}` for both forward + reverse forms | Forward ("supports") or reverse ("Adds X to Y") regex breaks | Backticked words without leading dash NOT matched | ✅ | parser unit tests + audit |
| B20 | cli-flag-supported generate | Vitest spawns `<cmd> --help`, concatenates stdout+stderr, checks flag presence | Generator stops appending --help | Different flags produce different FLAG string in generated test | 🟡 | indirect via B21 |
| B21 | cli-flag-supported execute | Generated test passes when --help mentions flag; fails when absent | Behavior drift | Help to stderr (not stdout) still works (we concatenate both) | ✅ | `audit/templates/cli-flag-supported.audit.ts` |
| B22 | library-returns extract | parser returns `{template:"library-returns", functionName, modulePath, expected}` | Regex breaks; JSON.parse of expected fails | Non-JSON expected ("the answer") rejected at parse time | ✅ | parser unit tests + audit |
| B23 | library-returns generate | Vitest imports the named export, calls with args, JSON-deep-equals return | Generator stops embedding args literal | Different expected values produce different EXPECTED constant | 🟡 | indirect via B24 |
| B24 | library-returns execute | Generated test passes when function returns expected; fails when return differs | Behavior drift | Function that returns DEEP-equivalent (e.g. {a:1,b:2} vs {b:2,a:1}) still passes (we JSON-stringify, order-sensitive) | ✅ | `audit/templates/library-returns.audit.ts` |

---

## C. Artifacts & filesystem behavior

| # | Feature | Signal | TP trigger | No-FP guard | Status | File |
|---|---|---|---|---|---|---|
| C1 | `.registry.json` has version 1 schema | `{version: 1, claims: [...]}` shape | Schema drift | Empty registry still has version: 1 | ✅ | `registry.test.ts` |
| C2 | Atomic write (no corruption mid-write) | Temp file + rename pattern (process.pid in temp name) | Direct write replaces atomicWrite | Concurrent writes don't observe partial state | 🟡 | registry unit tests; no end-to-end crash audit |
| C3 | Idempotent add (same claimId twice) | Second `addEntry` is no-op; registry size unchanged | Duplication on collision | Different claimId DOES add (proves no-op is gated) | ✅ | `registry.test.ts` |
| C4 | Corrupt registry → fail-closed (no silent reset) | `readRegistry` throws on malformed JSON or wrong shape | Silently resets to empty | Valid registry still reads | ✅ | `registry.test.ts` |
| C5 | PINS.md "## Active" section renders rows | Each active claim has a row with route + PR + actor + date | Renderer breaks | Empty registry shows placeholder, not empty table | ✅ | `audit/sticky/pins-md-renders.audit.ts` |
| C6 | PINS.md "## Retired" section appears after retire | Retire moves row from Active to Retired with reason column | Section split breaks | Active-only registry shows no Retired section | ✅ | `audit/sticky/pins-md-renders.audit.ts` |
| C7 | PINS.md escapes markdown-cell metacharacters | `|`, backticks, newlines in route/idField encoded safely | Raw inclusion lets users break PINS.md formatting | Normal characters unchanged | ✅ | `registry.test.ts` (escapeMarkdownCell) |
| C8 | Workflow YAML has id-token: write + contents: write | Both strings in the file | Permission dropped from template | Comment changes don't affect grep | ✅ | A5 |
| C9 | Workflow YAML has `@pinned add:` issue_comment trigger | YAML contains `issue_comment` event + author_association gate | Trigger removed | Other trigger types still work | ⚠ | needs `02d-init-workflow-shape.audit.ts` |
| C10 | Workflow YAML concurrency block per PR | YAML contains `concurrency:` with PR-number group | Concurrency removed → race conditions | Different group names still concurrency-protected | ⚠ | needs same as C9 |
| C11 | Generated test filename = `<prId>-<template>-<route-slug>-<hash>.test.ts` | Regex match on filename | Slug shape drift | Different rates with same route produce DIFFERENT filenames (hash disambiguates) | ✅ | `templates.test.ts` |
| C12 | Retired file: `tests/pinned/retired/<id>.test.ts` + `<id>.audit.json` | Both files exist; audit.json has correct schema | Audit file skipped | Different reasons produce different audit.json content (reason field) | ✅ | A9 |
| C13 | tests/pinned/README.md content | File exists with retire/list usage examples | File missing from init | Content tweaks don't break presence check | 🟡 | A5 checks presence, not content |

---

## D. Worker endpoints

| # | Endpoint | Signal | TP trigger | No-FP guard | Status | File |
|---|---|---|---|---|---|---|
| D1 | `/healthz` returns 200 + `{ok: true, service: "pinnedai-edge"}` | Status 200, JSON body shape | Endpoint removed or response shape drift | Hitting other paths returns 404 — proves /healthz is gating | ⚠ | unit test exists; no E2E audit |
| D2 | `/v1/extract` requires Bearer token | Missing token → 401 with `missing bearer token` | Auth check skipped | Valid token + invalid claims still rejected (downstream) | 🟡 | unit test exists |
| D3 | `/v1/extract` enforces 50KB body cap BEFORE OIDC | 51KB body → 413 without consuming JWKS/D1 | Cap moved after OIDC (perf regression + DoS surface) | 49KB body still processes | ⚠ | unit test partial; no ordering audit |
| D4 | `/v1/extract` validates OIDC JWT (signature + iss + aud + exp + nbf) | Tampered token → 401 `oidc validation failed` | Validation skipped | Valid token passes through | 🟡 | jwt.test.ts; no full request audit |
| D5 | `/v1/extract` looks up subscription by org from OIDC `repository_owner` | Paid org → fair_use_cap; free org → free cap | Lookup misses or wrong cap | Case differences in org (Acme vs acme) still resolve | ✅ | `audit/worker/subscription-lookup.audit.ts` |
| D6 | `/v1/extract` cache hit doesn't bill quota | Same body → cached claims returned without quota row update | Cache bypassed or quota always increments | Different body still hits OpenAI (and bills) | ✅ | `audit/worker/cache-deduplicates.audit.ts` + `quota-org-isolation.audit.ts` |
| D7 | `/v1/extract` quota increment is per-(org, month) | Each call bumps org's counter; over-cap → 429 with upgrade message | Counter doesn't increment; doesn't reset per month | Different orgs don't share quota | ✅ | `audit/worker/quota-org-isolation.audit.ts` |
| D8 | `/v1/extract` aggregate budget cap (free tier hard ceiling) | Across all free orgs, SUM(calls) >= cap → 429 with solo-founder message | Aggregate check skipped or paid orgs counted | Paid orgs' calls EXCLUDED from sum | ✅ | `audit/worker/quota-aggregate-cap.audit.ts` |
| D9 | `/v1/extract` 429 message contains solo-founder honest copy | Response includes "I'm a solo dev growing this", "Upgrade to Pro", "BYOK" | Generic 429 message; copy edited away | Other 429 reasons (per-org cap) have DIFFERENT message | ⚠ | needs `worker/honest-429-copy.audit.ts` |
| D10 | `/v1/extract` visibility-aware quota (public vs private) | Public repo → FREE_QUOTA_PUBLIC_PER_MONTH; private → PRIVATE; default falls back to FREE_QUOTA_PER_MONTH | Visibility ignored | Same org with public + private repos still works (visibility is per-call, org-level cap is aggregate) | ⚠ | needs `worker/quota-visibility.audit.ts` |
| D11 | `/v1/plan` returns plan WITHOUT touching quota or cache | Plan returned; quota row unchanged | Falls through to /v1/extract path | /v1/extract DOES touch them — proves /v1/plan path is distinct | ✅ | `audit/worker/plan-endpoint-no-quota-burn.audit.ts` |
| D12 | `/admin/stats` requires X-Admin-Key OR Authorization: Bearer | Missing/wrong key → 401 | Auth check skipped | Either header form works | 🟡 | unit test partial |
| D13 | `/admin/stats` returns active orgs + total calls + cache size + top consumers + active subscriptions count | JSON with all 5 fields | Field dropped | Data drift doesn't break shape | ⚠ | needs `worker/admin-stats.audit.ts` |
| D14 | `/admin/subscription` creates sub + returns 201 | POST creates row in subscriptions table | Insert skipped or wrong table | Invalid github_org rejected with clear error | 🟡 | subscriptions unit test exists |
| D15 | `/admin/*` rejects query-param key (header-only) | `/admin/stats?key=...` → 401 | Query param accepted (leaks via logs) | Header still works | ⚠ | needs `worker/admin-header-only.audit.ts` |
| D16 | `/badge/<org>/<repo>` returns SVG with pin count | Content-Type: image/svg+xml; SVG contains count | Endpoint broken; count wrong | 404 for missing PINS.md doesn't crash | ⚠ | needs `worker/badge-svg.audit.ts` |

---

## E. BYOK opt-in

| # | Feature | Signal | TP trigger | No-FP guard | Status | File |
|---|---|---|---|---|---|---|
| E1 | `PINNEDAI_BYOK=anthropic` → BYOK active | `activeByokProvider()` returns "anthropic" | Default changes to auto-discovery | "Anthropic" (capital A) also accepted | ✅ | `audit/sticky/byok-routes-direct.audit.ts` |
| E2 | `PINNEDAI_BYOK=openai` → BYOK active | Returns "openai" | Provider parsing breaks | Case-insensitive | ✅ | same |
| E3 | Bare `ANTHROPIC_API_KEY` does NOT trigger BYOK (no auto-discovery) | Returns null when PINNEDAI_BYOK unset, even with ANTHROPIC_API_KEY present | Auto-discovery silently re-introduced (privacy regression) | Both env vars set + PINNEDAI_BYOK set DOES activate | ✅ | same |
| E4 | `PINNEDAI_ANTHROPIC_KEY` alone (no PINNEDAI_BYOK) is inert | Returns null | Key without opt-in starts being used | Key + opt-in works | ✅ | same |
| E5 | Invalid PINNEDAI_BYOK ("off", "yes", typo) is inert | Returns null for any non-"anthropic"/"openai" value | Typo accepted as truthy | Empty string also rejected | ✅ | same |
| E6 | BYOK requires paid plan via /v1/plan check | Free org with BYOK env → falls through to Worker (not direct call) | Free orgs accidentally allowed to use direct providers | Paid org with BYOK → direct call | 🟡 | llmExtract logic; not a dedicated audit |
| E7 | BYOK Anthropic uses x-api-key header | Network request goes to api.anthropic.com with x-api-key | Wrong header name | Different model versions still work | ⚠ | needs `byok-anthropic-headers.audit.ts` (mock fetch) |
| E8 | BYOK OpenAI uses Authorization: Bearer | Network request to api.openai.com with Bearer token | Wrong scheme | Different model still works | ⚠ | needs `byok-openai-headers.audit.ts` |

---

## F. Generated test behaviors (cross-template)

| # | Feature | Signal | TP trigger | No-FP guard | Status | File |
|---|---|---|---|---|---|---|
| F1 | Repair prompt header in failure output | `PINNED FAILURE — paste this into Claude Code / Cursor` exact string | Header text changed; failure swallows it | Passing tests don't show the header | ✅ | `audit/sticky/repair-prompt-presence.audit.ts` |
| F2 | Back-reference to original PR in failure | `Original PR: <prId>` line | prId variable not embedded | Different prIds produce different lines | ✅ | F1 |
| F3 | Original claim text quoted in failure | `Claim: <claim.raw>` line | Claim text not embedded; quoted incorrectly | Different claims produce different lines | ✅ | F1 |
| F4 | Re-run command in failure footer | `After fixing, re-run: npx vitest run tests/pinned/<filename>` | Footer dropped | Path matches actual filename | 🟡 | F1 implicitly |
| F5 | Retire hint comment in test file header | Top of file: `pinned retire <claimId> --reason="..."` | Hint dropped | claimId matches the slug | ✅ | `templates.test.ts` |
| F6 | Web templates throw clearly when PREVIEW_URL unset | `beforeAll` throws `PREVIEW_URL env var required for ...` | Missing-env check removed | URL set still works | 🟡 | generator code; no dedicated audit |
| F7 | CLI templates use execFileSync (no shell) | Generated content does NOT contain `shell: true` / `shell:true` | Shell escape introduced | Different commands still get pre-tokenized argv | ✅ | `templates.test.ts` |
| F8 | Adversarial claim text is JSON-encoded, not interpolated | Backticks, quotes, semicolons in route/text appear ONLY inside `JSON.stringify()` output | Direct string interpolation introduced | Normal route/text still embeds cleanly | ✅ | `templates.test.ts` |
| F9 | cli-creates-file generated test refuses absolute / .. paths at runtime | Generated test checks `EXPECTED_FILE.startsWith("/")` + `.includes("..")` | Defense removed | Repo-relative paths work | ✅ | `templates.test.ts` |

---

## G. Landing page

| # | Feature | Signal | TP trigger | No-FP guard | Status | File |
|---|---|---|---|---|---|---|
| G1 | `/pinnedai.dev` loads with hero copy | HTML contains "AI writes the code. Pinned makes sure it keeps working." | Copy regressed in App.tsx | Other section copy changes don't break hero check | ⚠ | needs browser audit (Playwright) |
| G2 | Demo updates live on input change | Editing the textarea triggers parseClaims re-run; chip list updates | React state stops re-rendering | Identical input doesn't re-render unnecessarily | ⚠ | needs browser audit |
| G3 | Demo uses canonical parser (via vite alias) | `import { parseClaims } from "pinnedai"` resolves to `../cli/src/index.ts` | Alias removed; demo drifts from product | Demo doesn't re-implement parser | 🟡 | vite.config.ts alias check |
| G4 | `?welcome=true` shows welcome banner | URLSearchParams check renders banner | Banner removed; param check dropped | No-param URL doesn't show banner | ⚠ | needs browser audit |
| G5 | `/for-nextjs`, `/for-claude-code`, `/for-cursor` SEO routes render | Pathname-based switch renders the correct component | Switch case dropped | `/` and unknown paths fall back to <App /> | ⚠ | needs browser audit |
| G6 | Pricing card shows current tier numbers | "1,000 LLM calls/mo public", "100 LLM calls/mo private" | Numbers desync from Worker config | Layout changes don't affect numbers | ⚠ | needs content audit (read App.tsx + grep) |
| G7 | OG meta tags present | `<meta property="og:title">`, `og:description`, `og:image` | Tags removed | Tag content updates don't break shape | 🟡 | index.html unit-test-able but no audit |
| G8 | Build output ≤ 100KB gzipped | `dist/assets/index-*.js.gz` size ≤ threshold | Bundle bloat | Adding 1 import doesn't blow budget by orders of magnitude | ⚠ | needs `landing-bundle-size.audit.ts` |

---

## H. GitHub Action flow (customer-side)

| # | Feature | Signal | TP trigger | No-FP guard | Status | File |
|---|---|---|---|---|---|---|
| H1 | Workflow YAML emitted by `pinned init` triggers on PR open | YAML contains `on: pull_request:` with `types: [opened, synchronize, edited]` | Trigger types reduced | Different YAML formatting still has the trigger | ⚠ | needs YAML structural audit (parse YAML, check) |
| H2 | @pinned add: trigger fires only on PR comment from OWNER/MEMBER/COLLABORATOR | YAML contains `author_association` gate listing those roles | Gate removed → outside contributor can trigger commits | Different role names (e.g. CONTRIBUTOR) explicitly NOT in list | ⚠ | needs YAML structural audit |
| H3 | Auto-commit step uses pinned[bot] identity | YAML sets `git config user.name "pinned[bot]"` | Identity changed; uses real user accidentally | Email also matches pattern | ⚠ | same |
| H4 | Auto-commit step gated by `PINNEDAI_AUTOCOMMIT != 'false'` repo variable | `if:` condition checks the var | Always-on or always-off | Default (unset) is ON | ⚠ | same |
| H5 | scan-diff output via `gh pr comment` | YAML uses `gh pr comment "$PR_NUM" --body "..."` | Wrong gh command | Different PR numbers work | ⚠ | same |
| H6 | concurrency: group prevents PR-open + @pinned add races | YAML has `concurrency:` block with PR-number group | Removed → race conditions on registry | Different events on same PR contend | ⚠ | same |
| H7 | Customer-facing `action/action.yml` mirrors the init-emitted workflow | Composite action's steps map to init-emitted YAML | Drift between init and action | Adding a step to one doesn't silently miss in the other | ⚠ | needs `action-mirrors-init.audit.ts` |

---

## I. Error handling / graceful failures

| # | Feature | Signal | TP trigger | No-FP guard | Status | File |
|---|---|---|---|---|---|---|
| I1 | Malformed PR description → "no claims found" (not crash) | Exit 0; stdout contains the friendly message | Exception thrown | Real claims still extracted | ✅ | A6 negative |
| I2 | Empty input → "No PR description provided" error | Exit 1; stderr clear message | Crash on empty | --description with content still works | ⚠ | needs `check-empty-input.audit.ts` |
| I3 | Unsafe pr-id → assertSafeId message + exit 1 | stderr `Invalid --pr-id`; exit non-zero; no files written | Validation skipped | Safe ids work | ⚠ | A18 |
| I4 | Corrupt registry → fail-closed error (not silent reset) | `readRegistry` throws with diagnostic message; exit non-zero | Silent reset | Valid registry reads | ✅ | C4 |
| I5 | Missing PREVIEW_URL → clear test error | `beforeAll` throws with doc link | Silent skip | URL set → test runs | ⚠ | F6 |
| I6 | OIDC unavailable (local CLI) → no-oidc-context return | llmExtract returns `{ok:false, reason:"no-oidc-context"}`; CLI still works on regex-only | Crash | GHA env DOES set up OIDC — distinct path | ⚠ | needs `llm-extract-no-oidc.audit.ts` |
| I7 | Worker 429 (free cap) → CLI surfaces the upgrade/BYOK options | stdout/stderr contains "upgrade" + "BYOK" hints | Generic error | Other Worker errors have DIFFERENT messages | ⚠ | needs `cli-429-surface.audit.ts` |
| I8 | Worker 401 (OIDC fail) → clear "oidc validation failed" | CLI stderr names OIDC explicitly | Generic auth error | Worker 429 has different message | ⚠ | same family |

---

## J. Security guards

| # | Feature | Signal | TP trigger | No-FP guard | Status | File |
|---|---|---|---|---|---|---|
| J1 | --out-dir path traversal blocked | `--out-dir ../../etc` → stderr `Path escape detected`; exit 1 | Validation skipped | Repo-relative paths work | ⚠ | needs `path-traversal.audit.ts` |
| J2 | --dir path traversal blocked (list/scan-diff/baseline/retire) | Same as J1 across all flags | Same | Same | ⚠ | same |
| J3 | Symlinks not followed in `pinned baseline` walk | Symlink → loop avoided; escape via symlink doesn't reach /etc/passwd | lstatSync replaced with statSync | Regular files still walked | ⚠ | needs `baseline-no-symlink.audit.ts` |
| J4 | Stdin cap at 200KB (fail-closed) | 201KB stdin → throws "stdin exceeded" | Cap removed | 199KB stdin works | ⚠ | needs `stdin-cap.audit.ts` |
| J5 | Body cap at 50KB UTF-8 bytes (multi-byte safe) | Body with 50KB of multi-byte chars still rejected (not just 50K codepoints) | Switched to .length (UTF-16 code units) | 49KB body works | ⚠ | jwt body-size unit test exists |
| J6 | Workflow YAML doesn't interpolate ${{ }} into bash | All step values passed via `env:` blocks, never `run: echo ${{ github.event.... }}` | Interpolation re-introduced | Workflow comments mentioning ${{ }} OK | ⚠ | needs YAML lint audit |
| J7 | @pinned add: triggers ONLY for trusted commenters | YAML contains `author_association` check | Gate removed | Comment from OWNER works | ⚠ | H2 |
| J8 | Generated test argv pre-tokenized (no shell at runtime) | Generated content uses `execFileSync(bin, args, ...)` not `exec(string)` | Shell escape | Different commands still produce safe argv | ✅ | F7 |
| J9 | Admin auth header-only (no query param) | `?key=` query param ignored | Query param accepted | Header (X-Admin-Key or Bearer) works | ⚠ | D15 |

---

## K. Distribution & packaging

| # | Feature | Signal | TP trigger | No-FP guard | Status | File |
|---|---|---|---|---|---|---|
| K1 | npm package contains README + dist + LICENSE | `npm pack --dry-run` lists all three | Files array drops one | Adding test files doesn't break packaging | ⚠ | needs `npm-pack-contents.audit.ts` |
| K2 | npm package binary is `pinned` | `bin: { pinned: "dist/cli.js" }` resolves; `pinned --version` works after install | Binary name changes | Different versions don't affect binary | ⚠ | needs install-and-run audit |
| K3 | Library imports from "pinnedai" work browser-safely | `import { parseClaims } from "pinnedai"` doesn't pull in node:fs | Browser-unsafe import added to index.ts | Server-side still works | ⚠ | needs `lib-browser-safe.audit.ts` |
| K4 | Action manifest has proper inputs | `cli-version`, `auto-commit`, `byok` declared | Input dropped | Default values still work | ⚠ | needs YAML structural audit |
| K5 | Action manifest steps include preflight (.git check) | Composite action checks for .git before running | Preflight removed → confusing errors when checkout missing | Different preflight logic OK as long as it fails fast | ⚠ | needs action.yml audit |

---

## Summary by priority

**High-leverage gaps (recommended before launch — top 10)**:

1. **A2 / A3** — `pinned --version` and `pinned --help` output. These are the first commands a customer runs to verify install worked.
2. **A13** — `pinned check --json` shape. The GitHub Action consumes this for downstream steps.
3. **A18** — `pinned generate --pr-id` safety. A real security guard with no current audit.
4. **D1 / D3 / D4** — Worker `/healthz`, body-cap-before-OIDC, and OIDC validation end-to-end. The Worker is the customer's only access path; these need confidence before deploy.
5. **H1 / H2** — Workflow YAML structural audits, especially the `@pinned add:` author_association gate. Removing it accidentally would let outside contributors trigger auto-commits on public repos.
6. **J1 / J2** — Path traversal in --out-dir and --dir flags. Security regression here is silent.
7. **J6** — Workflow YAML never interpolates `${{ }}` into bash. A real injection surface.
8. **K1 / K2** — `npm pack --dry-run` listing + `pinned --version` after install. Verifies the package customers actually receive.
9. **I7** — CLI surfaces the Worker 429 message (upgrade + BYOK options). The honest-founder message needs to actually reach the user.
10. **G1 / G6** — Landing page hero copy + pricing card numbers match Worker config. Pricing drift between landing and Worker would erode trust.

**The matrix tells you**: what you're verifying (47), what you're partially verifying (18), and what would silently regress without anyone noticing (31).

Adding the top 10 gaps as audits would take ~1 day. Audit suite size goes from 26 files → ~40 files, assertion count from 68 → ~110.
