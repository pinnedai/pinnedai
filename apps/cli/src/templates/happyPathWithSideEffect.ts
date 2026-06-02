// Template: happy-path-with-side-effect
//
// Sends a valid POST/PUT/PATCH to the route with X-Pinned-Test: 1
// and asserts:
//   1. Status is 200 (or 201/202)
//   2. Response includes X-Pinned-Side-Effect header matching the
//      captured side-effect kind (db-write for v0.2)
//   3. X-Pinned-Side-Effect-Target matches the captured target table
//   4. X-Pinned-Side-Effect-Id is non-empty
//
// Why the header convention (Option C, locked 2026-06-02): a customer
// endpoint that returns 200 without actually doing the work is the
// worst-case Pinned failure mode (misleading-green). The header
// convention lets the customer's endpoint TELL Pinned what it did,
// without requiring Pinned to query the customer's DB or polling
// endpoint. Wrapper code is ~5-10 LOC, added by the customer's AI
// agent via the AGENT SETUP REQUIRED prompt emitted by `pinned init`.
//
// Once the wrapper is added, IT is itself protected by Pinned —
// future AI edits that remove the wrapper get caught recursively.

import type { HappyPathWithSideEffectClaim, ClaimFieldShape } from "../claimParser.js";
import { claimSlug } from "../claimParser.js";
import type { GenerateOpts, GeneratedTest } from "./rateLimit.js";
import { PINNED_FETCH_HELPER_SRC } from "./sharedFetch.js";

// Synthesize a body value that should satisfy `shape`. Deterministic
// (same shape → same value) so regenerate is idempotent and diffs
// against existing tests are stable. Mirrors `valueForFieldShape` in
// scanDiff.ts — duplicated here so the template stays browser-safe.
function valueForShape(shape: ClaimFieldShape): unknown {
  switch (shape.kind) {
    case "string": {
      if (shape.format === "email") return "pinned-test@example.com";
      if (shape.format === "url") return "https://example.com/pinned";
      if (shape.format === "uuid") return "00000000-0000-4000-8000-000000000000";
      if (shape.format === "cuid") return "c000000000000000000000000";
      if (shape.format === "date") return "2026-01-01";
      if (shape.format === "datetime") return "2026-01-01T00:00:00.000Z";
      const base = "pinned-test-value";
      if (shape.min && shape.min > base.length) return base.padEnd(shape.min, "x");
      return base;
    }
    case "number":
      return shape.min !== undefined ? shape.min : 1;
    case "boolean":
      return false;
    case "literal":
      return shape.value;
    case "enum":
      return shape.values[0];
    case "array":
      return [];
    case "unknown":
      return "pinned-test-value";
  }
}

export function generateHappyPathWithSideEffectTest(
  claim: HappyPathWithSideEffectClaim,
  opts: GenerateOpts
): GeneratedTest {
  const slug = claimSlug(claim);
  const claimId = `${opts.prId}-${slug}`;
  const filename = `${claimId}.test.ts`;

  // Synthesize the request body at generation time, from the claim's
  // bodyShape (populated when the validation detector could read the
  // route's zod schema). Falls back to a placeholder body when no
  // shape was captured (yup/joi/inline-validation cases). Bake the
  // value into the emitted test so the customer sees the actual body
  // Pinned will send and can edit it if needed.
  const synthesizedBody: Record<string, unknown> = {};
  let bodyKind: "schema-derived" | "placeholder";
  if (claim.bodyShape && Object.keys(claim.bodyShape).length > 0) {
    for (const [field, shape] of Object.entries(claim.bodyShape)) {
      synthesizedBody[field] = valueForShape(shape);
    }
    bodyKind = "schema-derived";
  } else {
    synthesizedBody.pinnedTest = true;
    synthesizedBody.placeholderField = "pinned-test-value";
    bodyKind = "placeholder";
  }

  const content = `// ═══════════════════════════════════════════════════════════════
// ◆ Pinned by pinnedai — https://pinnedai.dev
// ═══════════════════════════════════════════════════════════════
// Original PR claim: ${JSON.stringify(claim.raw)}
// Source PR:         ${opts.prId}
// Template:          happy-path-with-side-effect
// Permanent:         this test fails if the claim is ever regressed.
//
// Mechanism: sends a valid ${claim.method} to ${claim.route} with
// X-Pinned-Test: 1 and asserts the response includes
// X-Pinned-Side-Effect:${claim.sideEffectKind} +
// X-Pinned-Side-Effect-Target:${claim.sideEffectTarget} headers.
//
// REQUIRES: customer's route handler emits the X-Pinned-Side-Effect
// header on test-marked requests. See https://pinnedai.dev/docs/x-pinned-side-effect
// for the ~5-10 LOC wrapper.
//
// Retire when no longer applicable:
//   pinned retire ${claimId} --reason="..."
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll } from "vitest";
${PINNED_FETCH_HELPER_SRC}
const PREVIEW_URL = process.env.PREVIEW_URL;
const ROUTE = ${JSON.stringify(claim.route)};
const METHOD = ${JSON.stringify(claim.method)};
const EXPECTED_KIND = ${JSON.stringify(claim.sideEffectKind)};
const EXPECTED_TARGET = ${JSON.stringify(claim.sideEffectTarget)};
const ORIGINAL_PR = ${JSON.stringify(opts.prId)};
const ORIGINAL_CLAIM = ${JSON.stringify(claim.raw)};
const TEST_FILENAME = ${JSON.stringify(filename)};

function repairPrompt(message: string, status?: number, headers?: Record<string, string>): string {
  return [
    "",
    "═══ PINNED FAILURE — paste this into Claude Code / Cursor ═══",
    "",
    "Fix the failing pinned claim in this test file:",
    "  Claim: " + ORIGINAL_CLAIM,
    "  Original PR: " + ORIGINAL_PR,
    "  Route: " + METHOD + " " + ROUTE,
    "  Expected: 2xx + X-Pinned-Side-Effect: " + EXPECTED_KIND + " + X-Pinned-Side-Effect-Target: " + EXPECTED_TARGET,
    status !== undefined ? "  Status: " + status : "",
    headers ? "  Headers seen: " + JSON.stringify(headers) : "",
    "  Issue: " + message,
    "",
    "This pin asserts that " + METHOD + " " + ROUTE + " actually performs",
    "its side-effect (a " + EXPECTED_KIND + " to '" + EXPECTED_TARGET + "'), not just",
    "returns a happy status. If the endpoint stubbed out the side-effect,",
    "this test catches it.",
    "",
    "If the X-Pinned-Side-Effect headers are MISSING from the response:",
    "  Your route handler needs to emit them on requests carrying",
    "  X-Pinned-Test: 1. See https://pinnedai.dev/docs/x-pinned-side-effect",
    "  for the wrapper. Example (Next.js app router):",
    "",
    "    export async function " + METHOD + "(req: Request) {",
    "      const body = await req.json();",
    "      const result = await yourExistingHandler(body);",
    "      return Response.json(result, {",
    "        headers: req.headers.get('X-Pinned-Test') === '1' ? {",
    "          'X-Pinned-Side-Effect': '" + EXPECTED_KIND + "',",
    "          'X-Pinned-Side-Effect-Target': '" + EXPECTED_TARGET + "',",
    "          'X-Pinned-Side-Effect-Id': result.id || String(Date.now()),",
    "        } : {},",
    "      });",
    "    }",
    "",
    "If the headers ARE present but values don't match:",
    "  The side-effect type or target changed. Update the pin (intentional",
    "  change) by retiring + regenerating, OR fix the handler to match the",
    "  original contract.",
    "",
    "After fixing, re-run:  npx vitest run tests/pinned/" + TEST_FILENAME,
    "═══════════════════════════════════════════════════════════════",
    "",
  ].filter(Boolean).join("\\n");
}

// Body synthesized at pin-generation time from the route's validation
// schema (${bodyKind === "schema-derived" ? `zod schema for fields: ${Object.keys(synthesizedBody).join(", ")}` : "placeholder — no schema detected at pin time"}).
// Edit this if your endpoint needs a richer payload — the test file
// is yours to tweak. Regenerate (\`pinned regenerate ${claimId}\`)
// rebuilds this from the latest schema.
function buildValidBody(): Record<string, unknown> {
  return ${JSON.stringify(synthesizedBody, null, 2).split("\n").join("\n  ")};
}

describe("pinned: happy-path-with-side-effect " + METHOD + " " + ROUTE, () => {
  const previewMissing = !PREVIEW_URL;
  const forceRequire = process.env.PINNED_REQUIRE_PREVIEW_URL === "1";

  beforeAll(() => {
    if (previewMissing && forceRequire) {
      throw new Error(
        "PREVIEW_URL env var required for pinned happy-path-with-side-effect tests. " +
          "See https://pinnedai.dev/docs/preview-url"
      );
    }
  });

  it.skipIf(previewMissing && !forceRequire)(
    "valid request returns 2xx + side-effect emitted (or non-error body)",
    async () => {
      const url = PREVIEW_URL!.replace(/\\/$/, "") + ROUTE;
      const res = await pinnedFetch(url, {
        method: METHOD,
        headers: {
          "Content-Type": "application/json",
          "X-Pinned-Test": "1",
        },
        body: JSON.stringify(buildValidBody()),
      });

      // Tier 1 (MANDATORY): valid request must return 2xx. This alone
      // catches "valid-input → 4xx" regressions (the most common
      // happy-path failure — caught on socialideagen 2026-06-02 as
      // signup 400 + invite 400).
      if (res.status < 200 || res.status >= 300) {
        throw new Error(repairPrompt("non-2xx status (likely cause: the placeholder buildValidBody() doesn't satisfy the endpoint's validation schema, OR the endpoint genuinely regressed on the happy path — open this .test.ts and fix buildValidBody() to match your schema, then re-run)", res.status));
      }

      // Tier 2 (MANDATORY): response body must NOT carry failure
      // markers. A 200 with { error: "..." } / { skipped: true } /
      // { degraded: true } / { ok: true, skipped: true } is the
      // misleading-green case — endpoint returned 2xx but didn't
      // actually do its work. Closes the "graceful no-op pass" gap.
      let bodyText = "";
      let bodyJson: Record<string, unknown> | null = null;
      try {
        bodyText = await res.text();
        bodyJson = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : null;
      } catch {
        /* non-JSON body — fall through; tier-3 header checks still apply */
      }
      if (bodyJson && typeof bodyJson === "object") {
        if (bodyJson["error"] !== undefined) {
          throw new Error(repairPrompt("2xx but body contains 'error' field: " + JSON.stringify(bodyJson["error"]).slice(0, 200), res.status));
        }
        if (bodyJson["skipped"] === true) {
          throw new Error(repairPrompt("2xx but body says skipped:true — endpoint is in a degraded/stub state (e.g. missing env var → graceful no-op)", res.status));
        }
        if (bodyJson["degraded"] === true) {
          throw new Error(repairPrompt("2xx but body says degraded:true — endpoint reports it's in a fallback state", res.status));
        }
      }

      // Tier 3 (OPTIONAL — SOFT): X-Pinned-Side-Effect headers. When
      // present, we verify them. When ABSENT, we WARN once (so the
      // customer knows the strongest tier of verification is available
      // via the wrapper) but DON'T fail — the tier-1+tier-2 checks
      // already give meaningful protection without customer setup.
      // This removes the foot-gun where auto-emitted pins failed on
      // first run because the wrapper hadn't been installed yet.
      const sideEffectKind = res.headers.get("X-Pinned-Side-Effect") || res.headers.get("x-pinned-side-effect");
      const sideEffectTarget = res.headers.get("X-Pinned-Side-Effect-Target") || res.headers.get("x-pinned-side-effect-target");
      const sideEffectId = res.headers.get("X-Pinned-Side-Effect-Id") || res.headers.get("x-pinned-side-effect-id");

      if (!sideEffectKind) {
        // Soft note — doesn't fail, just signals the upgrade path.
        console.warn(
          "[pinned] " + METHOD + " " + ROUTE + ": 2xx + non-error body verified. " +
          "Upgrade to stronger verification: add the X-Pinned-Side-Effect response wrapper " +
          "(see https://pinnedai.dev/docs/x-pinned-side-effect) so this pin can also confirm " +
          "the " + EXPECTED_KIND + " to '" + EXPECTED_TARGET + "' actually happened."
        );
        expect(res.status).toBeGreaterThanOrEqual(200);
        expect(res.status).toBeLessThan(300);
        return;
      }

      // Wrapper is present — verify its claims.
      if (sideEffectKind !== EXPECTED_KIND) {
        throw new Error(
          repairPrompt(
            "X-Pinned-Side-Effect mismatch (got '" + sideEffectKind + "', expected '" + EXPECTED_KIND + "')",
            res.status
          )
        );
      }
      if (sideEffectTarget && sideEffectTarget.toLowerCase() !== EXPECTED_TARGET.toLowerCase()) {
        throw new Error(
          repairPrompt(
            "X-Pinned-Side-Effect-Target mismatch (got '" + sideEffectTarget + "', expected '" + EXPECTED_TARGET + "')",
            res.status
          )
        );
      }
      if (!sideEffectId) {
        throw new Error(
          repairPrompt(
            "X-Pinned-Side-Effect-Id missing — handler emitted side-effect type but not the resulting ID, which means we can't verify a unique work item was created",
            res.status
          )
        );
      }

      expect(sideEffectKind).toBe(EXPECTED_KIND);
      expect(sideEffectId).toBeTruthy();
    }
  );
});
`;

  return { filename, content, claimId };
}
