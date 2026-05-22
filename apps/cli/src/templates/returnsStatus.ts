// Template: returns-status
//
// Sends a minimally-invalid request to the route and asserts the
// expected status code. "Minimally invalid" depends on the claim:
//
//   missing F  → body is `{}` (everything missing — also covers F)
//   invalid F  → body is `{ [F]: "INVALID_FOR_PINNED_TEST" }` (just F invalid)
//   empty body → body is `{}` (same shape as missing-F)
//   (none)     → body is `{}` for POST/PUT/PATCH; no body for GET/DELETE
//
// LIMITATION: this template does not synthesize a "fully valid request
// except for F" — that would require knowledge of the rest of the
// schema. We send the minimal counter-example and trust the API's
// validator to flag the violation. Real customers can replace the body
// after generation if they need more nuance.

import type { ReturnsStatusClaim } from "../claimParser.js";
import { claimSlug, badCaseForClaim } from "../claimParser.js";
import type { GenerateOpts, GeneratedTest } from "./rateLimit.js";
import { PINNED_FETCH_HELPER_SRC } from "./sharedFetch.js";

export function generateReturnsStatusTest(
  claim: ReturnsStatusClaim,
  opts: GenerateOpts
): GeneratedTest {
  const slug = claimSlug(claim);
  const claimId = `${opts.prId}-${slug}`;
  const filename = `${claimId}.test.ts`;

  // Decide on a body shape. For "invalid F" we send `{F: "INVALID..."}`.
  // For everything else we send `{}` (or no body for GET/DELETE).
  const hasBody =
    claim.method === "POST" || claim.method === "PUT" || claim.method === "PATCH";
  const isInvalid = claim.conditionKind === "invalid" && claim.field;
  const bodyExpr = !hasBody
    ? "undefined"
    : isInvalid
      ? `JSON.stringify({ ${JSON.stringify(claim.field)}: "INVALID_FOR_PINNED_TEST" })`
      : `JSON.stringify({})`;

  const conditionLabel = claim.condition ?? "minimally invalid body";

  const content = `// ═══════════════════════════════════════════════════════════════
// ◆ Pinned by pinnedai — https://pinnedai.dev
// ═══════════════════════════════════════════════════════════════
// Original PR claim: ${JSON.stringify(claim.raw)}
// Source PR:         ${opts.prId}
// Template:          returns-status
// Permanent:         this test fails if the claim is ever regressed.
//
// Mechanism: sends a ${claim.method} to the route with a
// minimally-invalid body (${JSON.stringify(conditionLabel)}) and
// asserts the response status code is ${claim.status}.
//
// Retire when no longer applicable:
//   pinned retire ${claimId} --reason="..."
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll } from "vitest";
${PINNED_FETCH_HELPER_SRC}
const PREVIEW_URL = process.env.PREVIEW_URL;
const ROUTE = ${JSON.stringify(claim.route)};
const METHOD = ${JSON.stringify(claim.method)};
const EXPECTED_STATUS = ${claim.status};
const CONDITION = ${JSON.stringify(conditionLabel)};
const ORIGINAL_PR = ${JSON.stringify(opts.prId)};
const ORIGINAL_CLAIM = ${JSON.stringify(claim.raw)};
const BAD_CASE = ${JSON.stringify(badCaseForClaim(claim))};
const TEST_FILENAME = ${JSON.stringify(filename)};

function repairPrompt(actualStatus: number): string {
  return [
    "",
    "═══ PINNED FAILURE — paste this into Claude Code / Cursor ═══",
    "",
    "Fix the failing pinned claim in this test file:",
    "  Claim: " + ORIGINAL_CLAIM,
    "  Original PR: " + ORIGINAL_PR,
    "  Route: " + METHOD + " " + ROUTE,
    "  Condition: " + CONDITION,
    "  Bad case: " + BAD_CASE,
    "  Expected: status " + EXPECTED_STATUS,
    "  Actual: returned " + actualStatus,
    "",
    "Restore the validation (or response code) on " + ROUTE + ". Common causes:",
    "  - Validation library removed or weakened (Zod, Joi, Yup, Valibot)",
    "  - Route handler short-circuits before validation",
    "  - Middleware reordered so validation runs after auth",
    "Preserve healthy-input behavior. Do not modify this pinned test file.",
    "",
    "After fixing, re-run:  npx vitest run tests/pinned/" + TEST_FILENAME,
    "═══════════════════════════════════════════════════════════════",
    "",
  ].join("\\n");
}

describe("pinned: returns-status " + METHOD + " " + ROUTE + " → " + EXPECTED_STATUS, () => {
  const previewMissing = !PREVIEW_URL;
  const forceRequire = process.env.PINNED_REQUIRE_PREVIEW_URL === "1";

  beforeAll(() => {
    if (previewMissing && forceRequire) {
      throw new Error(
        "PREVIEW_URL env var required for pinned returns-status tests. " +
          "See https://pinnedai.dev/docs/preview-url"
      );
    }
  });

  it.skipIf(previewMissing && !forceRequire)("returns " + EXPECTED_STATUS + " on " + CONDITION, async () => {
    const url = PREVIEW_URL!.replace(/\\/$/, "") + ROUTE;
    const init: RequestInit = {
      method: METHOD,
      headers: { "Content-Type": "application/json" },
    };
    const body = ${bodyExpr};
    if (body !== undefined) (init as { body: string }).body = body;
    const res = await pinnedFetch(url, init);
    if (res.status !== EXPECTED_STATUS) {
      throw new Error(repairPrompt(res.status));
    }
    expect(res.status).toBe(EXPECTED_STATUS);
  });
});
`;

  return { filename, content, claimId };
}
