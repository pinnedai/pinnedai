// Template: tier-cap
//
// Billing-tier enforcement test. Three-direction integration test,
// each direction independently skipIf-gated on its own fixture
// credential env var. A failure in ANY direction is a genuine catch:
//
//   Direction 1 — tier-user UNDER cap   → 2xx   (requires PREVIEW_URL + PREVIEW_TEST_TOKEN_TIER_<TIER>_UNDER_CAP)
//   Direction 2 — tier-user AT cap      → 4xx   (requires PREVIEW_URL + PREVIEW_TEST_TOKEN_TIER_<TIER>_AT_CAP)
//   Direction 3 — paid user (any state) → 2xx   (requires PREVIEW_URL + PREVIEW_TEST_TOKEN_PAID)
//
// FP-bounded by per-direction skipIf: when a credential isn't set,
// only that direction skips — the others still run. The customer
// can add fixtures over time and catch coverage expands; until then
// no false fails.
//
// Why three directions (the "iterate in both directions" rule):
//   - removal direction:     at-cap → 2xx ⇒ cap stripped (REVENUE LEAK — the #1 thing this template exists to catch)
//   - over-tightening:       paid → 4xx   ⇒ cap over-applied (legit paying users blocked — refund risk)
//   - endpoint-broken check: under-cap → 4xx ⇒ endpoint broken (basic functionality test)
//
// Critical FP note: this template assumes the gated action is a
// MUTATING request (POST/PUT/PATCH/DELETE). For pure GETs the test
// uses POST anyway — most cap-enforcement happens on writes. If the
// customer's quota check is GET-side too, the at-cap direction may
// not fire correctly; they should retire and use returns-status
// instead. Documented in the failure prompt.

import type { TierCapClaim } from "../claimParser.js";
import { claimSlug, badCaseForClaim } from "../claimParser.js";
import type { GenerateOpts, GeneratedTest } from "./rateLimit.js";
import { PINNED_FETCH_HELPER_SRC } from "./sharedFetch.js";

export function generateTierCapTest(
  claim: TierCapClaim,
  opts: GenerateOpts
): GeneratedTest {
  const slug = claimSlug(claim);
  const claimId = `${opts.prId}-${slug}`;
  const filename = `${claimId}.test.ts`;
  // Env var suffix for the tier-specific fixture tokens. Uppercased
  // + snake-cased so PREVIEW_TEST_TOKEN_TIER_FREE_AT_CAP /
  // PREVIEW_TEST_TOKEN_TIER_HOBBY_AT_CAP read naturally.
  const tierEnvSuffix = claim.tier.toUpperCase().replace(/[^A-Z0-9]+/g, "_");

  const content = `// ═══════════════════════════════════════════════════════════════
// ◆ Pinned by pinnedai — https://pinnedai.dev
// ═══════════════════════════════════════════════════════════════
// Original PR claim: ${JSON.stringify(claim.raw)}
// Source PR:         ${opts.prId}
// Template:          tier-cap
// Permanent:         this test fails if the claim is ever regressed.
//
// Retire when no longer applicable:
//   pinned retire ${claimId} --reason="..."
//
// REQUIRED ENV VARS for full coverage:
//   PREVIEW_URL                                          — base URL (always required)
//   PREVIEW_TEST_TOKEN_TIER_${tierEnvSuffix}_UNDER_CAP   — a ${claim.tier}-tier user UNDER the ${claim.cap}-${claim.resource} cap
//   PREVIEW_TEST_TOKEN_TIER_${tierEnvSuffix}_AT_CAP      — a ${claim.tier}-tier user AT the ${claim.cap}-${claim.resource} cap
//   PREVIEW_TEST_TOKEN_PAID                              — a paid-tier user (any state)
//
// Without those fixture tokens, the corresponding direction skips
// silently. Add tokens to your preview env over time; this pin's
// catch coverage upgrades automatically.
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll } from "vitest";
${PINNED_FETCH_HELPER_SRC}
const PREVIEW_URL = process.env.PREVIEW_URL;
const ROUTE = ${JSON.stringify(claim.route)};
const TIER = ${JSON.stringify(claim.tier)};
const CAP = ${claim.cap};
const RESOURCE = ${JSON.stringify(claim.resource)};
const ORIGINAL_PR = ${JSON.stringify(opts.prId)};
const ORIGINAL_CLAIM = ${JSON.stringify(claim.raw)};
const BAD_CASE = ${JSON.stringify(badCaseForClaim(claim))};
const TEST_FILENAME = ${JSON.stringify(filename)};

// Per-direction fixture tokens. Each is gated by its own env var —
// missing fixtures cause that direction to skip, NOT to fail.
const TOKEN_UNDER_CAP = process.env["PREVIEW_TEST_TOKEN_TIER_${tierEnvSuffix}_UNDER_CAP"];
const TOKEN_AT_CAP = process.env["PREVIEW_TEST_TOKEN_TIER_${tierEnvSuffix}_AT_CAP"];
const TOKEN_PAID = process.env.PREVIEW_TEST_TOKEN_PAID;

function repairPrompt(direction: string, expected: string, actual: string): string {
  return [
    "",
    "═══ PINNED FAILURE — paste this into Claude Code / Cursor ═══",
    "",
    "Fix the failing pinned claim in this test file:",
    "  Claim: " + ORIGINAL_CLAIM,
    "  Original PR: " + ORIGINAL_PR,
    "  Route: " + ROUTE,
    "  Tier: " + TIER + " (capped at " + CAP + " " + RESOURCE + ")",
    "  Bad case: " + BAD_CASE,
    "  Direction: " + direction,
    "  Expected: " + expected,
    "  Actual: " + actual,
    "",
    "Restore the tier cap on " + ROUTE + ". Likely candidates:",
    "  - The route handler — look for quota / cap / limit checks",
    "  - Billing middleware that injects current-usage counts",
    "  - The TIER_LIMITS / QUOTAS config (constants table)",
    "  - The subscription / plan-tier lookup before the gated action",
    "Preserve paid-tier access. Do not modify this pinned test file.",
    "",
    "After fixing, re-run:  npx vitest run tests/pinned/" + TEST_FILENAME,
    "═══════════════════════════════════════════════════════════════",
    "",
  ].join("\\n");
}

describe("pinned: tier-cap " + TIER + " ≤ " + CAP + " " + RESOURCE + " on " + ROUTE, () => {
  const previewMissing = !PREVIEW_URL;
  const forceRequire = process.env.PINNED_REQUIRE_PREVIEW_URL === "1";
  const underCapMissing = !TOKEN_UNDER_CAP;
  const atCapMissing = !TOKEN_AT_CAP;
  const paidMissing = !TOKEN_PAID;

  beforeAll(() => {
    if (previewMissing && forceRequire) {
      throw new Error(
        "PREVIEW_URL env var required for pinned tier-cap tests. " +
          "See https://pinnedai.dev/docs/preview-url"
      );
    }
    if (PREVIEW_URL) {
      pinnedAssertNonProductionUrl(PREVIEW_URL, "tier-cap");
    }
  });

  // Direction 1 — ENDPOINT WORKS CHECK
  // Catches: the endpoint is broken or the cap is over-applied to
  // legitimate under-cap users. Less critical than direction 2 but
  // protects against "we broke the gated action entirely" regressions.
  it.skipIf((previewMissing || underCapMissing) && !forceRequire)(
    TIER + "-user UNDER the cap can perform the gated action (2xx)",
    async () => {
      const url = PREVIEW_URL!.replace(/\\/$/, "") + ROUTE;
      const res = await pinnedFetch(url, {
        method: "POST",
        headers: { Authorization: "Bearer " + TOKEN_UNDER_CAP! },
      });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(repairPrompt(
          "under-cap",
          "2xx for " + TIER + "-user under the " + CAP + "-" + RESOURCE + " cap",
          "returned " + res.status + " (endpoint broken or cap over-applied — legit " + TIER + " users are blocked)"
        ));
      }
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
    }
  );

  // Direction 2 — REMOVAL CHECK (the #1 reason this pin exists)
  // Catches: cap stripped, quota check bypassed, billing-tier
  // enforcement removed. AI refactor common case: "simplified" the
  // limit check and lost it. This is the revenue-leak catch.
  it.skipIf((previewMissing || atCapMissing) && !forceRequire)(
    TIER + "-user AT the cap is rejected (4xx)",
    async () => {
      const url = PREVIEW_URL!.replace(/\\/$/, "") + ROUTE;
      const res = await pinnedFetch(url, {
        method: "POST",
        headers: { Authorization: "Bearer " + TOKEN_AT_CAP! },
      });
      if (res.status >= 200 && res.status < 400) {
        throw new Error(repairPrompt(
          "at-cap",
          "4xx (typically 402, 403, or 429) for " + TIER + "-user at the " + CAP + "-" + RESOURCE + " cap",
          "returned " + res.status + " (BILLING-TIER ENFORCEMENT REMOVED — " + TIER + " users can exceed the cap)"
        ));
      }
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
  );

  // Direction 3 — OVER-TIGHTENING CHECK
  // Catches: cap applied to paid users (which would block legit
  // revenue and trigger refunds). Lower-stakes than direction 2 but
  // catches the "we made the limit too aggressive" mistake.
  it.skipIf((previewMissing || paidMissing) && !forceRequire)(
    "paid-tier user is not subject to the " + TIER + " cap (2xx)",
    async () => {
      const url = PREVIEW_URL!.replace(/\\/$/, "") + ROUTE;
      const res = await pinnedFetch(url, {
        method: "POST",
        headers: { Authorization: "Bearer " + TOKEN_PAID! },
      });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(repairPrompt(
          "paid-bypass",
          "2xx for paid-tier user (cap should not apply)",
          "returned " + res.status + " (cap over-applied — paying customer is being blocked)"
        ));
      }
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
    }
  );
});
`;

  return { filename, content, claimId };
}
