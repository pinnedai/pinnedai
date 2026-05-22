// Template: permission-required
//
// Role-based access control. Three-direction integration test, each
// direction independently skipIf-gated on its own fixture credential
// env var. A failure in ANY direction is a genuine catch:
//
//   Direction 1 — no auth   → 401 or 403   (requires PREVIEW_URL)
//   Direction 2 — wrong role → 403         (requires PREVIEW_TEST_TOKEN_NON_<ROLE>)
//   Direction 3 — right role → 2xx         (requires PREVIEW_TEST_TOKEN_<ROLE>)
//
// FP-bounded by per-direction skipIf: when a credential isn't set, only
// that direction skips — the others still run. So a customer with
// only the admin token can catch direction-1 + direction-3 regressions
// without false-failing direction-2. As fixtures get added over time,
// catch coverage expands without retiring the pin.
//
// Why three directions (the "iterate in both directions" rule):
//   - removal direction:        no-auth → 2xx ⇒ auth check stripped
//   - over-tightening direction: right-role → 4xx ⇒ legit users blocked
//   - cross-role direction:     wrong-role → 2xx ⇒ role check stripped
// Together these catch: auth removed, auth tightened too much, role
// check dropped while auth retained (the most common AI regression).

import type { PermissionRequiredClaim } from "../claimParser.js";
import { claimSlug, badCaseForClaim } from "../claimParser.js";
import type { GenerateOpts, GeneratedTest } from "./rateLimit.js";
import { PINNED_FETCH_HELPER_SRC } from "./sharedFetch.js";

export function generatePermissionRequiredTest(
  claim: PermissionRequiredClaim,
  opts: GenerateOpts
): GeneratedTest {
  const slug = claimSlug(claim);
  const claimId = `${opts.prId}-${slug}`;
  const filename = `${claimId}.test.ts`;
  // Env var name for the role-specific test token. Uppercased + snake-
  // cased so PREVIEW_TEST_TOKEN_ADMIN / PREVIEW_TEST_TOKEN_STAFF /
  // PREVIEW_TEST_TOKEN_BILLING_ADMIN read naturally. Customers
  // populate these in their preview-deploy env.
  const roleEnvSuffix = claim.role.toUpperCase().replace(/[^A-Z0-9]+/g, "_");

  const content = `// ═══════════════════════════════════════════════════════════════
// ◆ Pinned by pinnedai — https://pinnedai.dev
// ═══════════════════════════════════════════════════════════════
// Original PR claim: ${JSON.stringify(claim.raw)}
// Source PR:         ${opts.prId}
// Template:          permission-required
// Permanent:         this test fails if the claim is ever regressed.
//
// Retire when no longer applicable:
//   pinned retire ${claimId} --reason="..."
//
// REQUIRED ENV VARS for full coverage:
//   PREVIEW_URL                      — base URL (always required)
//   PREVIEW_TEST_TOKEN_${roleEnvSuffix}      — a token with the ${claim.role} role
//   PREVIEW_TEST_TOKEN_NON_${roleEnvSuffix}  — a token WITHOUT the ${claim.role} role
//
// Without those tokens, the corresponding direction skips silently —
// the test never false-fails. Add tokens to your preview env over
// time; this pin upgrades its catch coverage automatically.
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll } from "vitest";
${PINNED_FETCH_HELPER_SRC}
const PREVIEW_URL = process.env.PREVIEW_URL;
const ROUTE = ${JSON.stringify(claim.route)};
const ROLE = ${JSON.stringify(claim.role)};
const ORIGINAL_PR = ${JSON.stringify(opts.prId)};
const ORIGINAL_CLAIM = ${JSON.stringify(claim.raw)};
const BAD_CASE = ${JSON.stringify(badCaseForClaim(claim))};
const TEST_FILENAME = ${JSON.stringify(filename)};

// Per-direction fixture credentials. Each is gated by its own env
// var — missing fixtures cause that direction to skip, not fail.
const TOKEN_RIGHT_ROLE = process.env["PREVIEW_TEST_TOKEN_${roleEnvSuffix}"];
const TOKEN_WRONG_ROLE = process.env["PREVIEW_TEST_TOKEN_NON_${roleEnvSuffix}"];

function repairPrompt(direction: string, expected: string, actual: string): string {
  return [
    "",
    "═══ PINNED FAILURE — paste this into Claude Code / Cursor ═══",
    "",
    "Fix the failing pinned claim in this test file:",
    "  Claim: " + ORIGINAL_CLAIM,
    "  Original PR: " + ORIGINAL_PR,
    "  Route: " + ROUTE,
    "  Required role: " + ROLE,
    "  Bad case: " + BAD_CASE,
    "  Direction: " + direction,
    "  Expected: " + expected,
    "  Actual: " + actual,
    "",
    "Restore the role check on " + ROUTE + ". Likely candidates:",
    "  - The route handler (look for role assertions on the session/user object)",
    "  - Auth middleware (check that role is read from the JWT/session, not just presence-of-auth)",
    "  - RBAC/permission helper functions (.canAccess, .hasRole, .require, etc.)",
    "Preserve " + ROLE + "-role access. Do not modify this pinned test file.",
    "",
    "After fixing, re-run:  npx vitest run tests/pinned/" + TEST_FILENAME,
    "═══════════════════════════════════════════════════════════════",
    "",
  ].join("\\n");
}

describe("pinned: permission-required " + ROLE + " on " + ROUTE, () => {
  const previewMissing = !PREVIEW_URL;
  const forceRequire = process.env.PINNED_REQUIRE_PREVIEW_URL === "1";
  const wrongRoleMissing = !TOKEN_WRONG_ROLE;
  const rightRoleMissing = !TOKEN_RIGHT_ROLE;

  beforeAll(() => {
    if (previewMissing && forceRequire) {
      throw new Error(
        "PREVIEW_URL env var required for pinned permission-required tests. " +
          "See https://pinnedai.dev/docs/preview-url"
      );
    }
  });

  // Direction 1 — REMOVAL CHECK
  // Catches: auth-check stripped entirely.
  it.skipIf(previewMissing && !forceRequire)("rejects unauthenticated requests with 401 or 403", async () => {
    const url = PREVIEW_URL!.replace(/\\/$/, "") + ROUTE;
    const res = await pinnedFetch(url, { method: "GET" });
    if (![401, 403].includes(res.status)) {
      throw new Error(repairPrompt(
        "no-auth",
        "401 or 403",
        "returned " + res.status + " (auth check may have been removed)"
      ));
    }
    expect([401, 403].includes(res.status)).toBe(true);
  });

  // Direction 2 — CROSS-ROLE CHECK
  // Catches: role check dropped while auth retained (most common AI regression
  // in this class — refactor "simplifies" middleware but loses the role test).
  it.skipIf((previewMissing || wrongRoleMissing) && !forceRequire)("rejects wrong-role tokens with 403", async () => {
    const url = PREVIEW_URL!.replace(/\\/$/, "") + ROUTE;
    const res = await pinnedFetch(url, {
      method: "GET",
      headers: { Authorization: "Bearer " + TOKEN_WRONG_ROLE! },
    });
    if (res.status !== 403) {
      throw new Error(repairPrompt(
        "wrong-role",
        "403",
        "returned " + res.status + " (role check may be missing — wrong-role user got through)"
      ));
    }
    expect(res.status).toBe(403);
  });

  // Direction 3 — OVER-TIGHTENING CHECK
  // Catches: legit users blocked (auth made too strict / role gate too narrow).
  it.skipIf((previewMissing || rightRoleMissing) && !forceRequire)("accepts " + ROLE + "-role tokens with 2xx", async () => {
    const url = PREVIEW_URL!.replace(/\\/$/, "") + ROUTE;
    const res = await pinnedFetch(url, {
      method: "GET",
      headers: { Authorization: "Bearer " + TOKEN_RIGHT_ROLE! },
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(repairPrompt(
        "right-role",
        "2xx for " + ROLE + "-role token",
        "returned " + res.status + " (route may be over-tightened — even " + ROLE + " is blocked)"
      ));
    }
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
  });
});
`;

  return { filename, content, claimId };
}
