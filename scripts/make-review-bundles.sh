#!/usr/bin/env bash
# Regenerate the GPT code-review bundles in ~/Downloads/pinnedai/_review/
# with PER-BUNDLE versioning.
#
# Each bundle has its own -v<N> suffix. A bundle's version increments
# by 1 each time THAT bundle has been sent for review and feedback-
# driven fixes have been applied.
#
# Usage:
#   bash scripts/make-review-bundles.sh                 # refresh all bundles in place (no version changes)
#   bash scripts/make-review-bundles.sh --bumped 1      # only bundle-1 advances; others refresh in place
#   bash scripts/make-review-bundles.sh --bumped 1,3,5  # multiple bundles advance
#   bash scripts/make-review-bundles.sh --bumped all    # every bundle advances
#
# Each bundle's prompt now includes:
#   - WHAT pinnedai is (context)
#   - PRIORITY AREAS for THIS bundle, with per-file expected behavior
#   - EXPLICITLY DEFERRED items (so GPT doesn't re-flag them)
#   - 2-tier severity (BLOCKING / NICE-TO-HAVE) — cleaner than CRITICAL/HIGH/MEDIUM/LOW
#   - Explicit "verified ✓" requirement per area when nothing is flagged

set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
DST_ROOT="${PINNEDAI_REVIEW_DIR:-$HOME/Downloads/pinnedai}"
DST="$DST_ROOT/_review"
ARCHIVE="$DST/_archive"

BUMPED=""
if [ "${1:-}" = "--bumped" ]; then
  BUMPED="$2"
fi

mkdir -p "$DST_ROOT" "$ARCHIVE" "$DST"

rsync -a \
  --exclude='node_modules' --exclude='dist' --exclude='.git' \
  --exclude='.DS_Store' --exclude='.playwright-mcp' --exclude='pnpm-lock.yaml' \
  --exclude='_review' \
  "$SRC/" "$DST_ROOT/"

cd "$DST_ROOT"

# ---------- Bundle definitions ----------

files_for() {
  case "$1" in
    "1-cli-src")
      printf '%s\n' \
        apps/cli/package.json apps/cli/tsconfig.json \
        apps/cli/src/cli.ts apps/cli/src/index.ts \
        apps/cli/src/claimParser.ts apps/cli/src/scanDiff.ts \
        apps/cli/src/registry.ts apps/cli/src/llmExtract.ts apps/cli/src/llmDirect.ts \
        apps/cli/src/llmSummarize.ts apps/cli/src/safetyPass.ts apps/cli/src/agentRules.ts \
        apps/cli/src/prComment.ts apps/cli/src/statusline.ts apps/cli/src/autoProtect.ts \
        apps/cli/src/config.ts apps/cli/src/gitHooks.ts apps/cli/src/claudeSettings.ts \
        apps/cli/src/vitestSetup.ts \
        apps/cli/src/templates/rateLimit.ts apps/cli/src/templates/authRequired.ts \
        apps/cli/src/templates/idempotent.ts apps/cli/src/templates/returnsStatus.ts \
        apps/cli/src/templates/cliOutputContains.ts apps/cli/src/templates/cliExitsZero.ts \
        apps/cli/src/templates/cliCreatesFile.ts apps/cli/src/templates/cliFlagSupported.ts \
        apps/cli/src/templates/libraryReturns.ts \
        apps/cli/scripts/postinstall.cjs
      ;;
    "2-cli-tests")
      printf '%s\n' \
        apps/cli/src/claimParser.test.ts apps/cli/src/claimParser.union.test.ts \
        apps/cli/src/scanDiff.test.ts apps/cli/src/registry.test.ts \
        apps/cli/src/templates.test.ts apps/cli/src/cli.integration.test.ts \
        audit/README.md audit/GPT-AUDIT-PROMPT.md audit/vitest.config.ts \
        audit/fixtures/server.ts audit/fixtures/cli-fixture.mjs audit/fixtures/lib-fixture.ts audit/fixtures/runGenerated.ts \
        audit/features/runCli.ts \
        audit/features/01-bare-npx-demo.audit.ts audit/features/02-init-scaffold.audit.ts \
        audit/features/03-check-parses.audit.ts audit/features/04-generate-writes.audit.ts \
        audit/features/05-list-shows.audit.ts audit/features/06-retire-moves.audit.ts \
        audit/features/07-scan-diff-detects.audit.ts audit/features/08-baseline-finds.audit.ts \
        audit/features/09-doctor-reports.audit.ts \
        audit/templates/rate-limit.audit.ts audit/templates/auth-required.audit.ts \
        audit/templates/idempotent.audit.ts audit/templates/cli-output-contains.audit.ts \
        audit/templates/cli-exits-zero.audit.ts audit/templates/cli-creates-file.audit.ts \
        audit/templates/cli-flag-supported.audit.ts audit/templates/library-returns.audit.ts \
        audit/worker/mockD1.ts audit/worker/subscription-lookup.audit.ts \
        audit/worker/quota-aggregate-cap.audit.ts audit/worker/cache-deduplicates.audit.ts \
        audit/worker/quota-org-isolation.audit.ts audit/worker/plan-endpoint-no-quota-burn.audit.ts \
        audit/sticky/pins-md-renders.audit.ts audit/sticky/repair-prompt-presence.audit.ts \
        audit/sticky/scan-diff-coverage-suppression.audit.ts audit/sticky/byok-routes-direct.audit.ts
      ;;
    "3-edge-src")
      printf '%s\n' \
        apps/edge/package.json apps/edge/tsconfig.json apps/edge/wrangler.toml apps/edge/schema.sql \
        apps/edge/src/index.ts apps/edge/src/jwt.ts apps/edge/src/quota.ts \
        apps/edge/src/cache.ts apps/edge/src/openai.ts apps/edge/src/subscriptions.ts apps/edge/src/badge.ts
      ;;
    "4-edge-tests")
      printf '%s\n' \
        apps/edge/src/quota.test.ts apps/edge/src/cache.test.ts \
        apps/edge/src/subscriptions.test.ts apps/edge/src/badge.test.ts
      ;;
    "5-landing")
      printf '%s\n' \
        apps/landing/package.json apps/landing/tsconfig.json apps/landing/vite.config.ts \
        apps/landing/index.html apps/landing/src/main.tsx apps/landing/src/App.tsx \
        apps/landing/src/Demo.tsx apps/landing/src/styles.css
      ;;
    "6-configs")
      printf '%s\n' \
        package.json pnpm-workspace.yaml tsconfig.json .gitignore vitest.dogfood.config.ts \
        action/action.yml .github/PULL_REQUEST_TEMPLATE.md \
        .github/workflows/ci.yml .github/workflows/pinned.yml .github/workflows/release.yml \
        scripts/sync-public.sh scripts/make-review-bundles.sh
      ;;
  esac
}

description_for() {
  case "$1" in
    "1-cli-src")    echo "the npm package source — CLI commands, parser, registry, scan-diff, templates, LLM paths" ;;
    "2-cli-tests")  echo "the CLI test suite" ;;
    "3-edge-src")   echo "the Cloudflare Worker source — OIDC, quota, cache, OpenAI proxy, subscriptions, badge" ;;
    "4-edge-tests") echo "the Worker test suite" ;;
    "5-landing")    echo "the landing page — Vite + React, interactive demo widget" ;;
    "6-configs")    echo "root configs, GitHub Action manifest, sync + bundle scripts" ;;
  esac
}

# Pre-articulated expected behavior for each file in a bundle.
# This is the SPEC GPT verifies the code against — the highest-leverage
# change in this script. Without it, GPT re-discovers the spec every round.
priority_areas_for() {
  case "$1" in
    "1-cli-src")
      cat <<'AREAS'
(1) cli.ts — Commander-based CLI dispatcher; also generates the WORKFLOW_YAML for `pinned init`.
    MUST: validate --pr-id / --claim-id with assertSafeId (alphanumeric + -_, no path separators);
          assertInsideDir(path, process.cwd()) for --dir and --out-dir before any fs op;
          pass body to llmExtract using Buffer.byteLength for size checks (NOT .length);
          readStdin fail-CLOSED (throw) at 200KB, never return partial data;
          WORKFLOW_YAML emits every github.event.* and step.* value via env: blocks, never
          interpolates them directly into a run: shell command;
          @pinned add: trigger gated to OWNER|MEMBER|COLLABORATOR via author_association;
          all `npx -y pinnedai` invocations pin the exact published version.
    MUST NOT: interpolate ${{ github.* }} or step outputs into bash. There are NO local
              license keys — the Worker is the sole source of plan truth via OIDC.

(2) registry.ts — Persistent pin registry + PINS.md renderer.
    MUST: atomicWrite via temp file + renameSync for BOTH .registry.json AND PINS.md;
          throw clear error on corrupt/malformed JSON (fail-closed — never silently reset);
          escapeMarkdownCell on every user-controlled cell value (route, idField, filename,
          retireReason, actor); encodeMarkdownLinkTarget on href values;
          countActivePins counts status==="active". Pin count is UNLIMITED — there is
          no client-side pin cap. Any FREE_TIER_*_PIN_CAP or similar constant would be stale.
    MUST NOT: silently reset on parse failure (would wipe customer pins); reintroduce
              any pin-count cap (the cost gate is LLM calls at the Worker, not pin count);
              reintroduce client-side license-key parsing (license keys do NOT exist in this
              product — subscription is keyed by repository_owner from the OIDC JWT).

(3) claimParser.ts — Regex parser for PR descriptions; defines Claim union + dedup keys.
    MUST: parseClaims supports rate-limit / auth-required / idempotent canonical forms +
          common variants (rpm/rps/rph units, "requires auth" alternates, "idempotent by/on/using/keyed on");
          dedupe via claimKey across regex variants; claimSlug includes a hash so same-route
          claims with different rate/window/idField don't collide on filename;
          unionClaims preserves the first source on collision (regex wins over LLM).

(4) scanDiff.ts — Risk-surface heuristics for diffs + "no proof found" PR comments.
    MUST: detect Next.js App Router (app/api/.../route.ts) and Pages Router (pages/api/.*) routes;
          webhook handlers (webhook in path); middleware changes; .env file changes;
          cross-reference prBodyClaims + active existingPins for coverage suppression;
          renderSuggestionsMarkdown escapes inline code (escapeInlineCode) and table cells.
    MUST NOT: leak un-escaped user content (filenames, routes, suggestedPin text) into
              the markdown output that GitHub renders.

(5) llmExtract.ts — Hosted Worker call path (formerly llmFallback.ts).
    MUST: only fire in GITHUB_ACTIONS context;
          use Buffer.byteLength(body, "utf8") for the 50KB cap (NOT String.length);
          fetch OIDC token from ACTIONS_ID_TOKEN_REQUEST_URL with audience=pinnedai;
          return structured LLMExtractResult.
    MUST NOT: pass a license header — license keys do NOT exist in this product.
              The Worker derives the subscription tier from the OIDC JWT's
              repository_owner claim, looking up the (lowercase) org in the
              D1 subscriptions table that Stripe webhook populates.

(6) llmDirect.ts — BYOK Anthropic/OpenAI direct call (skips our Worker).
    MUST: only fire when the user has EXPLICITLY opted in to BYOK by setting:
          PINNEDAI_BYOK=anthropic | openai
          + PINNEDAI_ANTHROPIC_KEY=<key> (or PINNEDAI_OPENAI_KEY=<key>)
          Both env vars are required — the opt-in flag AND the prefixed key.
          Number.isInteger for rate validation (reject 1.5 req/min);
          validate JSON response shape; drop malformed claims;
          provider-agnostic mapping to Claim shape.
    MUST NOT: auto-discover bare ANTHROPIC_API_KEY / OPENAI_API_KEY env vars
              (would silently exfiltrate the user's API key to our flow without
              their explicit consent — bad security posture). The PINNEDAI_-prefixed
              vars + the explicit PINNEDAI_BYOK opt-in are the only valid path.

(7) templates/*.ts — Vitest test generators (rate-limit, auth-required, idempotent).
    MUST: emit syntactically valid TypeScript (no broken backticks in nested template literals);
          include the "═══ PINNED FAILURE ═══" repair-prompt sentinel on failure paths;
          include back-reference to ORIGINAL_PR id;
          rate-limit: cap burst at min(RATE+1, 101) AND throw explicit skip error for RATE >= 100
          so vitest reports failure (not silent pass);
          auth-required: GET unauthenticated, assert 401 or 403;
          idempotent: POST same payload twice, accept any 2xx first + identical-or-409/410/422 second.

(8) index.ts — Public library entry.
    MUST: re-export ONLY browser-safe pieces (parser, templates, claim types, generateTest
          dispatcher); NO node:fs / node:path / node:url leaks; covers all Claim union
          variants in generateTest switch (exhaustiveness check).
AREAS
      ;;

    "2-cli-tests")
      cat <<'AREAS'
(1) ALL tests MUST satisfy the falsifiable-signal rule:
    - Name a specific observable signal the feature produces when healthy
      (e.g. "PINS.md contains row matching X", "stdout contains substring Y",
      "file at path Z exists").
    - Include at least one positive control — a known-healthy input that
      produces the signal — at the top of each test file or describe block.
    - NO "no error thrown" / "test passes" as the only assertion.

(2) Integration tests in cli.integration.test.ts MUST:
    - Use a fresh tempdir per test (mkdtempSync in beforeEach, rmSync in afterEach).
    - Invoke the built CLI binary via spawnSync (not import the source) — proves the
      bundled CLI actually works, not just the unbundled TypeScript.
    - Cover both "init creates expected files" and "init --force overwrites".
    - NOTE: pin counts are UNLIMITED at every tier — there is NO 25-pin Free
      cap. If you see tests asserting an unlimited-pin policy across tiers,
      that is correct behavior. The cost gate lives in the Worker (monthly
      LLM-call ceiling), NOT in the CLI's pin count.

(3) Adversarial input coverage MUST include:
    - Multibyte / emoji PR bodies (relevant for byte-length cap).
    - Path-traversal attempts in --pr-id / --claim-id / --dir.
    - Markdown-breaking characters in claim routes (|, backticks, newlines).
    - Whitespace-only and empty inputs.

(4) Test file structure MUST:
    - Group related assertions with describe() blocks.
    - Use toMatch(regex) for hash-suffixed filenames instead of hard-coded strings
      (so claimSlug hash changes don't break unrelated tests).
AREAS
      ;;

    "3-edge-src")
      cat <<'AREAS'
(1) jwt.ts — Hand-rolled GitHub Actions OIDC JWT validator.
    MUST: verify RS256 signature against GitHub's JWKS at
          https://token.actions.githubusercontent.com/.well-known/jwks;
          reject alg=none and any non-RS256 alg before any further work;
          validate iss == "https://token.actions.githubusercontent.com",
          aud === expected audience, exp > now, nbf <= now (if present);
          cache JWKS for 1 hour; on KID rotation: refetch ONCE then fail.
    MUST NOT: parse the payload before signature verification; allow
              infinite JWKS refetch loops; trust the JWT without validating
              audience (would let any GitHub Action call our Worker).

(2) quota.ts — Per-org monthly quota counter (Cloudflare D1).
    MUST: atomic INSERT ... ON CONFLICT DO UPDATE — never read-then-write
          (race condition); bucket by org extracted from OIDC repository_owner
          claim (or the prefix of "repository"); return ok: false with
          reason: "monthly-quota" on overage; the FREE_QUOTA_PER_MONTH var
          drives the cap (currently 100, hidden as abuse defense).

(3) cache.ts — Content-hash cache (SHA-256(body)).
    MUST: cache HITS skip quota increment AND skip OpenAI call;
          90-day TTL via expires_at column; deterministic hash across reruns;
          INSERT with ON CONFLICT DO UPDATE for refresh-on-collision.

(4) openai.ts — gpt-4o-mini constrained-extraction proxy.
    MUST: use response_format: { type: "json_object" } (JSON mode);
          validate the response shape (must be { claims: [...] }) before
          surfacing to the caller; drop individual malformed claims silently
          rather than propagating LLM garbage; bubble HTTP errors as 502.
    MUST NOT: log raw PR bodies (privacy); embed any user-controlled string
              into a separate API call without escaping.

(5) subscriptions.ts — Pro/Team/Enterprise subscription lookup by GitHub org.
    MUST: validateSubscription returns null for unknown/cancelled/past_due rows;
          createSubscription lowercases + validates github_org against GitHub's
          username regex; ON CONFLICT(github_org) DO UPDATE for upsert (so plan
          upgrades and resubscribes overwrite cleanly); fair_use_cap defaults are
          5000/50000/1000000 for pro/team/enterprise; store customer_email + stripe ids.
    MUST NOT: trust client-supplied org (only OIDC repository_owner); store license
              keys (we removed those in v0.1.1 — identity is the OIDC org).

(6) badge.ts — Public README badge SVG endpoint.
    MUST: be public (no auth required); fetch raw PINS.md from
          raw.githubusercontent.com with 1-hour cache; count rows in the
          "## Active" section only (stop at the next "## " heading);
          ignore separator rows (|---|---|) and header rows ("| Claim |");
          return SVG with appropriate Content-Type for direct README embed.
    MUST NOT: leak private-repo state; allow path bypass via /badge/../foo.

(7) index.ts — Request router + handler glue + admin endpoints.
    MUST: enforce 50KB body cap (UTF-8 byteLength) BEFORE OIDC, DB, or OpenAI;
          require valid OIDC JWT BEFORE subscription lookup or quota increment;
          extract github_org from oidc.repository_owner (lowercased) for sub lookup;
          check content cache BEFORE quota increment (cache hits are free);
          /admin/stats and /admin/subscription require valid ADMIN_KEY header;
          paid orgs use subscription.fair_use_cap; free orgs use FREE_QUOTA_PER_MONTH;
          /v1/plan endpoint validates OIDC + returns plan without running the LLM
          or burning quota (for BYOK customers to verify paid status cheaply).
    MUST NOT: leak ADMIN_KEY into error responses; allow path bypass on /admin/*;
              permit /v1/extract or /v1/plan without OIDC; read trust signals from
              client headers (license header was removed in v0.1.1).

(8) wrangler.toml + schema.sql — Worker config + D1 schema.
    MUST: D1 binding named QUOTA; schema includes quota, extraction_cache,
          subscriptions tables (subscriptions keyed by github_org, with
          fair_use_cap + status + plan columns) with appropriate indices;
          secrets (OPENAI_API_KEY, ADMIN_KEY) referenced via wrangler secret,
          never committed to source.
AREAS
      ;;

    "4-edge-tests")
      cat <<'AREAS'
(1) ALL Worker tests MUST satisfy the falsifiable-signal rule:
    - The mock D1's stored state IS the observable signal — assert on rows.
    - Each test has a positive control input known to produce a specific row.

(2) Mock D1 implementation MUST:
    - Correctly simulate ON CONFLICT DO UPDATE semantics for the UPSERT tests.
    - Support .first<T>() and .all<T>() return shapes that match production D1.

(3) Coverage MUST include:
    - Quota: org isolation (one org's increment doesn't affect another's), over-quota
      response shape, monthly reset boundary (synthetic time).
    - Cache: hit/miss roundtrip, expires_at enforcement, deterministic hash for
      same input.
    - Subscriptions: org normalization (case-insensitive lookup), status transitions
      (active → cancelled, active → past_due), ON CONFLICT upsert (plan upgrades),
      invalid org name rejection.
    - Badge: PINS.md parsing for various row counts, 404 fallback for missing repos,
      stopping at "## Retired" so retired count doesn't bleed into active.
AREAS
      ;;

    "5-landing")
      cat <<'AREAS'
(1) App.tsx + Demo.tsx — Vite + React landing.
    MUST: be PURE client-side — no secrets, no auth tokens, no API keys in source;
          read URLSearchParams for ?welcome=true and show banner accordingly;
          live demo imports the actual pinnedai CLI parser/templates (via
          vite.config.ts alias) — NOT a copy/paste — so the demo can't drift
          from the shipped product;
          Stripe payment link is a clearly-marked placeholder URL until the
          customer creates their Stripe Payment Link.
    MUST NOT: ship analytics scripts that capture PR-body content; reference
              the closed-source Worker source repo by URL.

(2) styles.css — design tokens + layout.
    MUST: be self-contained; no external CDN font/script imports without a
          documented privacy/CSP rationale.

(3) vite.config.ts — build config.
    MUST: define the `pinnedai` import alias mapping to ../cli/src/index.ts
          (so the demo always uses the canonical parser source).

(4) index.html — entry point.
    MUST: include <title> and <meta name="description">; OG meta tags for
          social previews; no inline scripts beyond Vite's module loader.
AREAS
      ;;

    "6-configs")
      cat <<'AREAS'
(1) action/action.yml — GitHub Marketplace action manifest.
    MUST: declare runs.using composite; declare any inputs the workflow uses;
          the action's steps SHOULD match the workflow YAML emitted by
          `pinned init` (or document the divergence).

(2) .github/workflows/ci.yml — self-CI for the monorepo (private side).
    MUST: pnpm install, typecheck, test, and build all workspace packages
          on pull_request and push to main.

(3) scripts/sync-public.sh — public-mirror sync.
    MUST: refuse if destination directory doesn't exist;
          refuse if destination has uncommitted changes (verified via git diff);
          fatal-fail (exit 2) if apps/edge/, OPS.md, CLAUDE.md, or ROADMAP.md
          would leak into the public destination — defense in depth.

(4) scripts/make-review-bundles.sh — this very script.
    MUST: auto-detect current per-bundle version from on-disk filenames;
          only advance versions for bundles listed in --bumped;
          archive the previous top-level file when bumping;
          for un-bumped bundles, refresh content at the same version (overwrite in place).

(5) Root configs — pnpm-workspace.yaml, tsconfig.json, package.json.
    MUST: workspaces glob covers apps/*; root tsconfig sets target: ES2022,
          module: ESNext, moduleResolution: Bundler, strict: true.
AREAS
      ;;
  esac
}

# ---------- Versioning + bumping ----------

current_version_of() {
  local slug="$1"
  local existing
  existing=$(ls "$DST/bundle-$slug-v"*.txt 2>/dev/null | sed -E 's/.*-v([0-9]+)\.txt$/\1/' | sort -n | tail -1 || true)
  if [ -n "$existing" ]; then echo "$existing"; else echo "1"; fi
}

should_bump() {
  local idx="$1"
  [ "$BUMPED" = "all" ] && return 0
  [ -z "$BUMPED" ] && return 1
  local IFS=','; read -ra arr <<< "$BUMPED"
  for x in "${arr[@]}"; do
    [ "$x" = "$idx" ] && return 0
  done
  return 1
}

# ---------- Prompt header ----------

make_header() {
  local version="$1"
  local slug="$2"

  cat <<HEADER_EOF
════════════════════════════════════════════════════════════════════════════════
PINNEDAI — CODE REVIEW REQUEST
Bundle: bundle-$slug-v$version    |    Reviewing: $(description_for "$slug")
════════════════════════════════════════════════════════════════════════════════

CONTEXT
───────
Pinnedai is a GitHub Action + npm CLI + hosted Cloudflare Worker. It parses
behavioral claims from PR descriptions ("Rate-limits /api/users to 60 req/min",
"Auth required on /api/admin/export", "Makes /webhooks/stripe idempotent on
event_id") and turns each into a permanent CI test file in the customer's
tests/pinned/ directory. Future regressions fail CI with a back-reference to
the original PR.

Tier model (current — v0.1 ship target):
  Free  \$0   — UNLIMITED pins, OIDC keyless, public + private repos,
                500 LLM calls/mo public + 100/mo private, all auto-protect
                features (safe/ask/off modes, hooks, watch, statusline).
  Pro   \$19  — UNLIMITED pins, 5,000 LLM calls/mo (fair use),
                BYOK (Anthropic/OpenAI), custom templates, priority model.
  Team  \$199 — UNLIMITED pins, 50,000 LLM calls/mo, org policies,
                audit log, Slack alerts, CODEOWNERS routing.
  Ent   \$20K — UNLIMITED pins, 1M LLM calls/mo OR self-hosted Worker,
                SSO, SOC 2 evidence export.

  IMPORTANT: pin count is unlimited at EVERY tier — capping pins caps the
  moat (compounding artifact accumulation). The cost-bounded knob is LLM
  calls, NOT pins. There is no "25-pin Free cap" anywhere in this product;
  if you see code or tests asserting a pin cap, it's stale and should be
  flagged. The Worker enforces a per-org/per-repo monthly LLM-call ceiling
  in D1; the CLI never enforces pin count. License keys do NOT exist —
  subscription is keyed by repository_owner from the OIDC JWT.

Architecture:
  CLI    (open-source Apache 2.0, npm: pinnedai)   — runs in customer's CI
  Worker (private source, Cloudflare)             — validates OIDC, meters quota
  Landing (Vite + React)                          — pinnedai.dev marketing

────────────────────────────────────────────────────────────────────────────────
PRIORITY AREAS — verify the code matches each spec below
────────────────────────────────────────────────────────────────────────────────

For each numbered area, the code MUST behave as described. Read the bundle
and check that the actual implementation satisfies each rule.

If a rule is satisfied, output: "(N) {file} — verified ✓"
If a rule is violated, output a 🚨 BLOCKING or ⚠ NICE-TO-HAVE finding with
the exact file:line range, the spec rule that's violated, the exploit or
correctness scenario, and a one-line suggested fix.

$(priority_areas_for "$slug")

────────────────────────────────────────────────────────────────────────────────
EXPLICITLY DEFERRED — do NOT re-flag these (already known)
────────────────────────────────────────────────────────────────────────────────

These items are accepted as v0.1 limitations and tracked in REVIEW_STATUS.md.
Do NOT include them in your findings unless you have a new exploit scenario
not previously considered.

(D1) Method slot (GET vs POST/PUT/PATCH) in claim templates — v0.1.1 work
     requiring Claim type change + parser update + landing demo update.
     Generated tests currently default to GET (auth-required, rate-limit)
     or POST (idempotent).

(D2) Cross-file transactional writes of .registry.json + PINS.md — accepted
     because .registry.json is authoritative; \`pinned doctor\` can detect
     drift and rebuild PINS.md if a crash leaves them out of sync. True 2PC
     is impossible on standard filesystems.

(D3) Local concurrent CLI registry race — workflow concurrency: block in
     the emitted YAML handles the Actions case; humans running
     \`pinned generate\` twice simultaneously in their terminal is not
     a realistic trigger.

────────────────────────────────────────────────────────────────────────────────
YOUR JOB
────────────────────────────────────────────────────────────────────────────────

Two-tier severity:
  🚨 BLOCKING — must fix before v0.1 launch (real exploit OR functional bug
                that hits typical customers OR data-corruption risk).
  ⚠ NICE-TO-HAVE — real risk but not deploy-blocking.

OUTPUT FORMAT:

  ## Priority area check
  (1) cli.ts — verified ✓     [or:]
  (1) cli.ts — 🚨 BLOCKING — apps/cli/src/cli.ts:142-149 — assertSafeId
      is missing on the retire command's claim-id arg.
      Scenario: "pinned retire ../../etc/passwd --reason=x" would move
      arbitrary files. Fix: add assertSafeId("claim id", claimId) before
      the join().

  (2) registry.ts — verified ✓
  ...

  ## Other findings (outside priority areas)
  - ⚠ NICE-TO-HAVE — file:line — finding + fix

DISCIPLINE:
- If everything in a priority area is correct, write "verified ✓" — DO NOT
  invent issues to look thorough.
- Don't re-flag the EXPLICITLY DEFERRED items (D1–D4).
- Don't pad with "the code looks well-written" preambles. We need signal.

════════════════════════════════════════════════════════════════════════════════
SOURCE CODE BUNDLE BEGINS BELOW
════════════════════════════════════════════════════════════════════════════════
HEADER_EOF
}

write_bundle() {
  local idx="$1"; local slug="$2"; local version="$3"; local total="$4"
  local out="$DST/bundle-$slug-v$version.txt"
  {
    make_header "$version" "$slug"
    echo ""
    echo "Bundle $idx of $total ($(description_for "$slug")) — v$version"
    echo ""
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      if [ -f "$f" ]; then
        echo ""
        echo "════════════════════════════════════════════════════════════════"
        echo "FILE: $f"
        echo "════════════════════════════════════════════════════════════════"
        cat "$f"
        echo ""
      fi
    done < <(files_for "$slug")
  } > "$out"
  echo "  wrote $out"
}

echo "Generating review bundles..."
echo "  source:      $SRC"
echo "  destination: $DST"
[ -n "$BUMPED" ] && echo "  bumped:      $BUMPED" || echo "  bumped:      (none — refreshing content at current versions)"
echo ""

for entry in \
  "1:1-cli-src" \
  "2:2-cli-tests" \
  "3:3-edge-src" \
  "4:4-edge-tests" \
  "5:5-landing" \
  "6:6-configs"; do
  idx="${entry%%:*}"
  slug="${entry#*:}"
  current=$(current_version_of "$slug")

  if should_bump "$idx"; then
    new_version=$((current + 1))
    if [ -f "$DST/bundle-$slug-v$current.txt" ]; then
      mv "$DST/bundle-$slug-v$current.txt" "$ARCHIVE/"
      echo "  archived bundle-$slug-v$current.txt"
    fi
    echo "  bundle-$slug: v$current → v$new_version (bumped)"
    write_bundle "$idx" "$slug" "$new_version" 6
  else
    echo "  bundle-$slug: v$current (refresh, no version change)"
    write_bundle "$idx" "$slug" "$current" 6
  fi
done

cat > "$DST/README.txt" <<'README_EOF'
============================================================
PINNEDAI CODE REVIEW BUNDLES — per-bundle versioning
============================================================

Each bundle has its own version. The version increments by 1 each
time that bundle has been sent for review and received feedback
that fixes have been applied for.

  -v1 = never reviewed (send first for that bundle)
  -v2 = received feedback once + fixed, ready for round 2
  -v3 = ... and so on

PROMPT FORMAT (new — based on the Quantapact pattern):
  - CONTEXT (what pinnedai is)
  - PRIORITY AREAS with pre-articulated expected behavior PER FILE
  - EXPLICITLY DEFERRED list (D1-D4) — GPT must NOT re-flag these
  - Two-tier severity: 🚨 BLOCKING / ⚠ NICE-TO-HAVE
  - GPT must say "verified ✓" per area when nothing's flagged

WORKFLOW:
  1. Pick a bundle, send the highest-v file for that bundle to GPT/Claude
  2. GPT returns findings → bring them to the dev session
  3. After fixes: bash scripts/make-review-bundles.sh --bumped <N>
     (only the reviewed bundle advances; others refresh in place)
  4. Re-send the bumped bundle for round 2

The _archive/ directory keeps every previously-sent version for
audit trail of what GPT saw at each round.
README_EOF

echo ""
echo "===CURRENT TOP-LEVEL STATE==="
ls -1 "$DST"/bundle-*.txt | sed 's|.*/||'

if [ -d "$ARCHIVE" ] && ls -1 "$ARCHIVE"/bundle-*.txt 2>/dev/null >/dev/null; then
  echo ""
  echo "===ARCHIVE (previous rounds)==="
  ls "$ARCHIVE" | head -10
fi
