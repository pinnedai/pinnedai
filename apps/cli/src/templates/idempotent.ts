// Template: idempotent
//
// Fires the same payload twice and asserts the second response is
// byte-identical to the first (status + body). That's the strongest
// black-box property of an idempotent endpoint and matches the
// RFC-7231 / Stripe-style contract.
//
// Generated test ships with a skeleton payload containing only the
// claimed idempotency field — customers will typically need to add
// the other required fields for their endpoint. The header is left
// as a clear EDIT ME so it's discoverable.

import type { IdempotentClaim } from "../claimParser.js";
import { claimSlug, badCaseForClaim } from "../claimParser.js";
import type { GenerateOpts, GeneratedTest } from "./rateLimit.js";
import { PINNED_FETCH_HELPER_SRC } from "./sharedFetch.js";

export function generateIdempotentTest(
  claim: IdempotentClaim,
  opts: GenerateOpts
): GeneratedTest {
  const slug = claimSlug(claim);
  const claimId = `${opts.prId}-${slug}`;
  const filename = `${claimId}.test.ts`;

  const content = `// Pinned by pinnedai — claim from ${opts.prId}.
// Original PR claim: ${JSON.stringify(claim.raw)}
// Pinned to fail if this is ever regressed.
//
// Retire when no longer applicable:
//   pinned retire ${claimId} --reason="..."
//
// EDIT ME: if your endpoint requires extra fields beyond the
// idempotency key, add them to the \`payload\` object below.

import { describe, it, expect, beforeAll } from "vitest";
${PINNED_FETCH_HELPER_SRC}
const PREVIEW_URL = process.env.PREVIEW_URL;
const ROUTE = ${JSON.stringify(claim.route)};
const ID_FIELD = ${JSON.stringify(claim.idField)};
const ORIGINAL_PR = ${JSON.stringify(opts.prId)};
const ORIGINAL_CLAIM = ${JSON.stringify(claim.raw)};
const BAD_CASE = ${JSON.stringify(badCaseForClaim(claim))};
const TEST_FILENAME = ${JSON.stringify(filename)};

function repairPrompt(kind: "status" | "body" | "first-call-not-2xx", first: string, second: string): string {
  return [
    "",
    "═══ PINNED FAILURE — paste this into Claude Code / Cursor ═══",
    "",
    "Fix the failing pinned claim in this test file:",
    "  Claim: " + ORIGINAL_CLAIM,
    "  Original PR: " + ORIGINAL_PR,
    "  Route: " + ROUTE + " (POST)",
    "  Idempotency key: " + ID_FIELD,
    "  Bad case: " + BAD_CASE,
    kind === "first-call-not-2xx"
      ? "  Expected: first POST returns a 2xx (the endpoint must succeed before duplicate detection can be tested)"
      : "  Expected: two POSTs with the same " + ID_FIELD + " return byte-identical response",
    kind === "first-call-not-2xx"
      ? "  Actual: first POST returned " + first + " — " + second
      : "  Actual: differing " + kind + " — first=" + first + " second=" + second,
    "",
    "Restore idempotency on " + ROUTE + ". The handler should detect duplicate",
    ID_FIELD + " values and return the cached response (or 409). Likely candidates:",
    "  - The route handler for " + ROUTE,
    "  - A request-deduplication middleware",
    "  - Database upsert vs insert logic",
    "Preserve all other behavior. Do not modify this pinned test file.",
    "",
    "After fixing, re-run:  npx vitest run tests/pinned/" + TEST_FILENAME,
    "═══════════════════════════════════════════════════════════════",
    "",
  ].join("\\n");
}

describe("pinned: idempotent on " + ROUTE + " (key: " + ID_FIELD + ")", () => {
  const previewMissing = !PREVIEW_URL;
  const forceRequire = process.env.PINNED_REQUIRE_PREVIEW_URL === "1";

  beforeAll(() => {
    if (previewMissing && forceRequire) {
      throw new Error(
        "PREVIEW_URL env var required for pinned idempotent tests. " +
          "See https://pinnedai.dev/docs/preview-url"
      );
    }
    if (PREVIEW_URL) {
      pinnedAssertNonProductionUrl(PREVIEW_URL, "idempotent");
    }
  });

  it.skipIf(previewMissing && !forceRequire)("returns byte-identical response when called twice with the same " + ID_FIELD, async () => {
    const url = PREVIEW_URL!.replace(/\\/$/, "") + ROUTE;
    const payload: Record<string, unknown> = {
      [ID_FIELD]: "pinned-idem-" + Math.random().toString(36).slice(2, 12),
      // EDIT ME: add any other required fields here.
    };

    const fire = () =>
      pinnedFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

    const first = await fire();
    const firstBody = await first.text();
    const second = await fire();
    const secondBody = await second.text();

    // First call MUST be a real success. Otherwise both calls could
    // return identical non-2xx (e.g. two 404s on a missing route or
    // two 500s on a broken endpoint) and the equality check below
    // would wrongly pass as "idempotent." A genuinely idempotent
    // endpoint must actually succeed on first call.
    if (first.status < 200 || first.status >= 300) {
      throw new Error(repairPrompt(
        "first-call-not-2xx",
        String(first.status),
        "expected 2xx (endpoint must succeed before duplicate-detection applies)"
      ));
    }

    // 409 / 410 / 422 on the SECOND call is also valid idempotency —
    // the handler explicitly rejected the duplicate. Accept it.
    const DUPLICATE_STATUSES = [409, 410, 422];
    if (DUPLICATE_STATUSES.includes(second.status)) {
      return;
    }

    // Otherwise: second call must mirror the first byte-for-byte.
    if (second.status !== first.status) {
      throw new Error(repairPrompt("status", String(first.status), String(second.status)));
    }
    if (secondBody !== firstBody) {
      throw new Error(repairPrompt("body", firstBody.slice(0, 80), secondBody.slice(0, 80)));
    }
    expect(second.status).toBe(first.status);
    expect(secondBody).toBe(firstBody);
  });
});
`;

  return { filename, content, claimId };
}
