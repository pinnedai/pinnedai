// Template: auth-required
//
// Two-direction integration test:
//   Direction 1 — no-auth → 401/403   (always runs given PREVIEW_URL)
//                 catches the removal class: auth check stripped
//   Direction 2 — authed → 2xx        (runs if PREVIEW_TEST_TOKEN_AUTH env present)
//                 catches the over-tightening class: route accidentally
//                 blocked for legitimate authenticated users
//
// Per-direction skipIf gates each independently. Customers without
// a test token get direction-1 only — still catches the most common
// regression (auth removed entirely). Customers who configure the
// token get both directions for free.

import type { AuthRequiredClaim } from "../claimParser.js";
import { claimSlug, badCaseForClaim } from "../claimParser.js";
import type { GenerateOpts, GeneratedTest } from "./rateLimit.js";
import { PINNED_FETCH_HELPER_SRC } from "./sharedFetch.js";

export function generateAuthRequiredTest(
  claim: AuthRequiredClaim,
  opts: GenerateOpts
): GeneratedTest {
  const slug = claimSlug(claim);
  const claimId = `${opts.prId}-${slug}`;
  const filename = `${claimId}.test.ts`;

  const content = `// ═══════════════════════════════════════════════════════════════
// ◆ Pinned by pinnedai — https://pinnedai.dev
// ═══════════════════════════════════════════════════════════════
// Original PR claim: ${JSON.stringify(claim.raw)}
// Source PR:         ${opts.prId}
// Template:          auth-required
// Permanent:         this test fails if the claim is ever regressed.
//
// Retire when no longer applicable:
//   pinned retire ${claimId} --reason="..."
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll } from "vitest";
${PINNED_FETCH_HELPER_SRC}
const PREVIEW_URL = process.env.PREVIEW_URL;
const ROUTE = ${JSON.stringify(claim.route)};
const ORIGINAL_PR = ${JSON.stringify(opts.prId)};
const ORIGINAL_CLAIM = ${JSON.stringify(claim.raw)};
const BAD_CASE = ${JSON.stringify(badCaseForClaim(claim))};
const TEST_FILENAME = ${JSON.stringify(filename)};
// Optional fixture token for the "authed → 2xx" direction. When
// present, the with-auth direction runs and catches over-tightening
// regressions (route accidentally blocked even for authenticated users).
// When absent, that direction skips silently.
const TOKEN_AUTH = process.env.PREVIEW_TEST_TOKEN_AUTH;

function repairPrompt(actualStatus: number): string {
  return [
    "",
    "═══ PINNED FAILURE — paste this into Claude Code / Cursor ═══",
    "",
    "Fix the failing pinned claim in this test file:",
    "  Claim: " + ORIGINAL_CLAIM,
    "  Original PR: " + ORIGINAL_PR,
    "  Route: " + ROUTE,
    "  Bad case: " + BAD_CASE,
    "  Expected: unauthenticated GET to " + ROUTE + " returns 401 or 403",
    "  Actual: returned " + actualStatus,
    "",
    "Restore the auth check on " + ROUTE + ". Likely candidates:",
    "  - middleware.ts or src/middleware.ts (Next.js / Hono / generic)",
    "  - The route handler file for " + ROUTE,
    "  - Auth provider config (Clerk / Auth.js / Supabase / Lucia)",
    "Preserve authenticated behavior. Do not modify this pinned test file.",
    "",
    "After fixing, re-run:  npx vitest run tests/pinned/" + TEST_FILENAME,
    "═══════════════════════════════════════════════════════════════",
    "",
  ].join("\\n");
}

describe("pinned: auth-required on " + ROUTE, () => {
  // Skip — not fail — when PREVIEW_URL is unset. Lets background
  // post-commit auto-runs pass on machines that don't have it
  // configured. Manual runs still see a helpful message via the skip
  // reason. To force failure on missing env, set PINNED_REQUIRE_PREVIEW_URL=1.
  const previewMissing = !PREVIEW_URL;
  const forceRequire = process.env.PINNED_REQUIRE_PREVIEW_URL === "1";

  beforeAll(() => {
    if (previewMissing && forceRequire) {
      throw new Error(
        "PREVIEW_URL env var required for pinned auth-required tests. " +
          "See https://pinnedai.dev/docs/preview-url"
      );
    }
  });

  // Direction 1 — REMOVAL CHECK (always runs given PREVIEW_URL)
  // Catches: auth check stripped from the route entirely.
  it.skipIf(previewMissing && !forceRequire)("returns 401 or 403 when called without an Authorization header", async () => {
    const url = PREVIEW_URL!.replace(/\\/$/, "") + ROUTE;
    const res = await pinnedFetch(url, { method: "GET" });
    if (![401, 403].includes(res.status)) {
      throw new Error(repairPrompt(res.status));
    }
    expect([401, 403].includes(res.status)).toBe(true);
  });

  // Direction 2 — OVER-TIGHTENING CHECK (gated on PREVIEW_TEST_TOKEN_AUTH)
  // Catches: route accidentally blocked for authenticated users
  // ("we tightened auth and broke legit traffic"). Lower-stakes
  // than direction 1 but real — refactors that turn 200s into 403s
  // for the wrong reasons are a known AI mistake class.
  const authTokenMissing = !TOKEN_AUTH;
  it.skipIf((previewMissing || authTokenMissing) && !forceRequire)(
    "accepts authenticated requests with 2xx",
    async () => {
      const url = PREVIEW_URL!.replace(/\\/$/, "") + ROUTE;
      const res = await pinnedFetch(url, {
        method: "GET",
        headers: { Authorization: "Bearer " + TOKEN_AUTH! },
      });
      if (res.status < 200 || res.status >= 300) {
        const msg = [
          "",
          "═══ PINNED FAILURE — paste this into Claude Code / Cursor ═══",
          "",
          "Fix the failing pinned claim in this test file:",
          "  Claim: " + ORIGINAL_CLAIM,
          "  Original PR: " + ORIGINAL_PR,
          "  Route: " + ROUTE,
          "  Direction: with-auth (over-tightening check)",
          "  Expected: 2xx for an authenticated GET to " + ROUTE,
          "  Actual: returned " + res.status + " (route may be over-restricted — legit authenticated users are blocked)",
          "",
          "Investigate why authenticated requests are failing on " + ROUTE + ".",
          "Likely candidates:",
          "  - Auth middleware now requires extra claims the token doesn't carry",
          "  - Route handler added new authorization checks that exclude the test user",
          "  - Session validation tightened too aggressively",
          "Preserve the no-auth → 401/403 contract (direction 1). Do not modify this pinned test file.",
          "",
          "After fixing, re-run:  npx vitest run tests/pinned/" + TEST_FILENAME,
          "═══════════════════════════════════════════════════════════════",
          "",
        ].join("\\n");
        throw new Error(msg);
      }
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
    }
  );
});
`;

  return { filename, content, claimId };
}
