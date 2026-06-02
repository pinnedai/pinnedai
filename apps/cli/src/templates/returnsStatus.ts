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
import { readFileSync, existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
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
// Static-mode fingerprint — present when this pin was generated
// from the diff-aware validation detector. Lets the test verify
// the captured validation signature is still in source even
// without a live server. Same shape as the auth-required template.
const STATIC_VERIFY = ${JSON.stringify(claim.staticVerify ?? null)};

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

    // Route-missing disambiguation (same fix as validation-rejects-bad):
    // when the expected status is 4xx, a deleted route returning 404/405/501
    // would silently match an over-broad assertion. EXPECTED_STATUS check
    // below is exact, but we still surface a clearer failure message if
    // the route appears missing and our expected isn't itself 404/405/501.
    const ROUTE_MISSING = [404, 405, 501];
    if (
      ROUTE_MISSING.includes(res.status) &&
      !ROUTE_MISSING.includes(EXPECTED_STATUS)
    ) {
      throw new Error([
        repairPrompt(res.status),
        "",
        "[route appears missing: status " + res.status + " — the handler may have been deleted or the method changed]",
        "",
      ].join("\\n"));
    }

    if (res.status !== EXPECTED_STATUS) {
      throw new Error(repairPrompt(res.status));
    }

    // Body-marker (tier-2): if the expected status is 2xx, the route
    // could be returning 200 with { error: "..." } / { skipped: true } /
    // { degraded: true }. Same misleading-green close as the other
    // 2xx-asserting templates.
    if (EXPECTED_STATUS >= 200 && EXPECTED_STATUS < 300) {
      try {
        const respBody = await res.clone().text();
        const json = respBody ? JSON.parse(respBody) as Record<string, unknown> : null;
        if (json && typeof json === "object") {
          if (json["error"] !== undefined) {
            throw new Error([
              repairPrompt(res.status),
              "",
              "[matched expected 2xx, but body contains 'error' field — handler is in a degraded state]",
              "",
            ].join("\\n"));
          }
          if (json["skipped"] === true || json["degraded"] === true) {
            throw new Error([
              repairPrompt(res.status),
              "",
              "[matched expected 2xx, but body says skipped:true or degraded:true]",
              "",
            ].join("\\n"));
          }
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes("PINNED FAILURE")) throw e;
        /* swallow non-JSON parse errors */
      }
    }

    expect(res.status).toBe(EXPECTED_STATUS);
  });

  // Static-mode check — same role as the auth-required template's.
  // Reads the route's source file and asserts the validation
  // signature is still present. Catches deletions/refactors of the
  // validation code even when PREVIEW_URL is unset.
  it.skipIf(!STATIC_VERIFY)(
    "source still contains the validation signature captured at pin time",
    () => {
      const sv = STATIC_VERIFY!;
      const abs = resolvePath(process.cwd(), sv.filePath);
      if (!existsSync(abs)) {
        throw new Error(
          [
            "",
            "═══ PINNED FAILURE — paste this into Claude Code / Cursor ═══",
            "",
            "Pinned returns-status pin failed (static check):",
            "  Claim: " + ORIGINAL_CLAIM,
            "  Original PR: " + ORIGINAL_PR,
            "  Route: " + METHOD + " " + ROUTE,
            "  Expected file: " + sv.filePath + " (missing)",
            "",
            "The handler file that originally contained the validation no",
            "longer exists. Either it was renamed/moved, or the validation",
            "was removed along with the file.",
            "═══════════════════════════════════════════════════════════════",
            "",
          ].join("\\n")
        );
      }
      const raw = readFileSync(abs, "utf8");
      // Comment-stripped match — see the auth-required template for
      // the same reasoning. "// TODO: add Zod schema" in a parent
      // file should not falsely satisfy a Zod-signature pin.
      const content = raw
        .split("\\n")
        .map((l: string) => l.replace(/\\/\\/.*$/, ""))
        .join("\\n")
        .replace(/\\/\\*[\\s\\S]*?\\*\\//g, "");
      // Format-normalize: lint reformat (Prettier) collapses multi-line
      // expressions to single line, making the captured signature
      // text-differ from parent content even when the logic is the same.
      // See [[lint-format-false-positives]].
      const normalizeForSig = (s: string) => s.replace(/\\s+/g, "").replace(/,(?=[)\\]}])/g, "");
      const contentN = normalizeForSig(content);
      const sigN = normalizeForSig(sv.signature);
      if (!contentN.includes(sigN)) {
        throw new Error(
          [
            "",
            "═══ PINNED FAILURE — paste this into Claude Code / Cursor ═══",
            "",
            "Pinned returns-status pin failed (static check):",
            "  Claim: " + ORIGINAL_CLAIM,
            "  Original PR: " + ORIGINAL_PR,
            "  Route: " + METHOD + " " + ROUTE,
            "  File: " + sv.filePath,
            "  Missing validation signature: " + sv.signature,
            "",
            "The validation that protects " + ROUTE + " was removed or",
            "rewritten. The original fix introduced the snippet above; it's",
            "no longer present in the file.",
            "═══════════════════════════════════════════════════════════════",
            "",
          ].join("\\n")
        );
      }
      expect(contentN.includes(sigN)).toBe(true);
    }
  );
});
`;

  return { filename, content, claimId };
}
