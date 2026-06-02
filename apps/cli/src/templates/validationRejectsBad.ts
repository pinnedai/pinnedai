// Template: validation-rejects-bad
//
// One pin with N sub-tests, one per bad-input case. Matches existing
// multi-direction pattern (auth-required: 2 dirs, permission-required:
// 3 dirs, this: N sub-tests).
//
// Sub-tests (each runs only if the corresponding case is in scope):
//   - missing-required:  one sub-test per required field (POST with
//                        that field deleted from a minimal body)
//   - malformed-json:    POST with non-JSON body, expect 4xx
//
// Each sub-test asserts `expect(status).toBeGreaterThanOrEqual(400)`
// and `toBeLessThan(500)`. If a route legitimately accepts oversized
// bodies (file upload) or coerces types, the customer can retire
// individual sub-tests by editing the test file — coarse but works.

import type { ValidationRejectsBadClaim } from "../claimParser.js";
import { claimSlug } from "../claimParser.js";
import type { GenerateOpts, GeneratedTest } from "./rateLimit.js";
import { PINNED_FETCH_HELPER_SRC } from "./sharedFetch.js";

export function generateValidationRejectsBadTest(
  claim: ValidationRejectsBadClaim,
  opts: GenerateOpts
): GeneratedTest {
  const slug = claimSlug(claim);
  const claimId = `${opts.prId}-${slug}`;
  const filename = `${claimId}.test.ts`;
  const fields = claim.requiredFields;

  const content = `// ═══════════════════════════════════════════════════════════════
// ◆ Pinned by pinnedai — https://pinnedai.dev
// ═══════════════════════════════════════════════════════════════
// Original PR claim: ${JSON.stringify(claim.raw)}
// Source PR:         ${opts.prId}
// Template:          validation-rejects-bad
// Permanent:         this test fails if the claim is ever regressed.
//
// Mechanism: sends a series of intentionally-bad ${claim.method} requests
// to ${claim.route} and asserts each returns 4xx (validation rejected).
// Sub-tests: one per required field (missing-required) + malformed-JSON.
//
// Retire when no longer applicable:
//   pinned retire ${claimId} --reason="..."
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll } from "vitest";
${PINNED_FETCH_HELPER_SRC}
const PREVIEW_URL = process.env.PREVIEW_URL;
const ROUTE = ${JSON.stringify(claim.route)};
const METHOD = ${JSON.stringify(claim.method)};
const REQUIRED_FIELDS = ${JSON.stringify(fields)};
const ORIGINAL_PR = ${JSON.stringify(opts.prId)};
const ORIGINAL_CLAIM = ${JSON.stringify(claim.raw)};
const TEST_FILENAME = ${JSON.stringify(filename)};

// Build a minimal "valid" body — one key per required field with a
// placeholder string. We then delete one field at a time and assert
// the endpoint rejects it. Placeholder is shaped to satisfy basic
// type checks (zod's z.string()) for the fields NOT being tested.
function buildValidBody(): Record<string, string> {
  const body: Record<string, string> = {};
  for (const f of REQUIRED_FIELDS) body[f] = "pinned-test-value";
  return body;
}

function repairPrompt(subtest: string, actualStatus: number, sentBody: string): string {
  return [
    "",
    "═══ PINNED FAILURE — paste this into Claude Code / Cursor ═══",
    "",
    "Fix the failing pinned claim in this test file:",
    "  Claim: " + ORIGINAL_CLAIM,
    "  Original PR: " + ORIGINAL_PR,
    "  Route: " + METHOD + " " + ROUTE,
    "  Sub-test: " + subtest,
    "  Expected: 4xx (validation rejection)",
    "  Actual: " + actualStatus,
    "  Sent body: " + sentBody.slice(0, 200),
    "",
    "The validation that protects " + ROUTE + " was removed or weakened.",
    "Common causes:",
    "  - Validation library removed (Zod / Yup / Joi / Valibot)",
    "  - Schema's required() / .required keys dropped",
    "  - Route handler short-circuits before validation",
    "  - Middleware reordered so validation runs after the handler",
    "",
    "After fixing, re-run:  npx vitest run tests/pinned/" + TEST_FILENAME,
    "═══════════════════════════════════════════════════════════════",
    "",
  ].join("\\n");
}

describe("pinned: validation-rejects-bad " + METHOD + " " + ROUTE, () => {
  const previewMissing = !PREVIEW_URL;
  const forceRequire = process.env.PINNED_REQUIRE_PREVIEW_URL === "1";

  beforeAll(() => {
    if (previewMissing && forceRequire) {
      throw new Error(
        "PREVIEW_URL env var required for pinned validation-rejects-bad tests. " +
          "See https://pinnedai.dev/docs/preview-url"
      );
    }
  });

  // Reject responses that look like "route doesn't exist" instead of
  // "validation rejected." A bare 404 / 405 in the 4xx range would
  // otherwise silently satisfy the assertion — a customer who deleted
  // the route entirely would see this pin still green. Same
  // wrong-direction failure mode the happy-path tier-2 check closes.
  function isRouteMissingResponse(status: number): boolean {
    return status === 404 || status === 405 || status === 501;
  }

  // Sub-test 1: malformed-JSON — POST with a non-JSON body. Endpoint
  // should reject (400 or 415, NOT 404/405).
  it.skipIf(previewMissing && !forceRequire)("rejects malformed JSON body", async () => {
    const url = PREVIEW_URL!.replace(/\\/$/, "") + ROUTE;
    const body = "this-is-not-json";
    const res = await pinnedFetch(url, {
      method: METHOD,
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (isRouteMissingResponse(res.status)) {
      throw new Error(
        repairPrompt(
          "malformed-json",
          res.status,
          body + "  [route appears missing: status " + res.status + " — not a validation failure, the handler is gone]"
        )
      );
    }
    if (res.status < 400 || res.status >= 500) {
      throw new Error(repairPrompt("malformed-json", res.status, body));
    }
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  // Sub-test 2 (per required field): missing-required — POST with that
  // one field deleted from an otherwise-minimal body. Endpoint should
  // reject (400 or 422, NOT 404/405).
  for (const field of REQUIRED_FIELDS) {
    it.skipIf(previewMissing && !forceRequire)(
      "rejects body missing required field: " + field,
      async () => {
        const url = PREVIEW_URL!.replace(/\\/$/, "") + ROUTE;
        const body = buildValidBody();
        delete body[field];
        const bodyStr = JSON.stringify(body);
        const res = await pinnedFetch(url, {
          method: METHOD,
          headers: { "Content-Type": "application/json" },
          body: bodyStr,
        });
        if (isRouteMissingResponse(res.status)) {
          throw new Error(
            repairPrompt(
              "missing-required:" + field,
              res.status,
              bodyStr + "  [route appears missing: status " + res.status + " — not a validation failure, the handler is gone]"
            )
          );
        }
        if (res.status < 400 || res.status >= 500) {
          throw new Error(repairPrompt("missing-required:" + field, res.status, bodyStr));
        }
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
      }
    );
  }

  // Fallback: if no required fields were extracted, the malformed-JSON
  // sub-test above is the only check (vs no test at all). Catches at
  // least the "validation removed entirely" failure mode.
  it.skipIf(REQUIRED_FIELDS.length > 0)("placeholder: required-fields list was empty at pin-time", () => {
    expect(true).toBe(true);
  });
});
`;

  return { filename, content, claimId };
}
