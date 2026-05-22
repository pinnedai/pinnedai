// ═══════════════════════════════════════════════════════════════
// ◆ Pinned by pinnedai — https://pinnedai.dev
// ═══════════════════════════════════════════════════════════════
// Original PR claim: "/api/users returns 401 on missing token"
// Source PR:         v0-1-1
// Template:          returns-status
// Permanent:         this test fails if the claim is ever regressed.
//
// Mechanism: sends a POST to the route with a
// minimally-invalid body ("missing token") and
// asserts the response status code is 401.
//
// Retire when no longer applicable:
//   pinned retire v0-1-1-returns-status-api-users-um7t93 --reason="..."
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll } from "vitest";

const PREVIEW_URL = process.env.PREVIEW_URL;
const ROUTE = "/api/users";
const METHOD = "POST";
const EXPECTED_STATUS = 401;
const CONDITION = "missing token";
const ORIGINAL_PR = "v0-1-1";
const ORIGINAL_CLAIM = "/api/users returns 401 on missing token";
const TEST_FILENAME = "v0-1-1-returns-status-api-users-um7t93.test.ts";

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
  ].join("\n");
}

describe("pinned: returns-status " + METHOD + " " + ROUTE + " → " + EXPECTED_STATUS, () => {
  beforeAll(() => {
    if (!PREVIEW_URL) {
      throw new Error(
        "PREVIEW_URL env var required for pinned returns-status tests. " +
          "See https://pinnedai.dev/docs/preview-url"
      );
    }
  });

  it("returns " + EXPECTED_STATUS + " on " + CONDITION, async () => {
    const url = PREVIEW_URL!.replace(/\/$/, "") + ROUTE;
    const init: RequestInit = {
      method: METHOD,
      headers: { "Content-Type": "application/json" },
    };
    const body = JSON.stringify({});
    if (body !== undefined) (init as { body: string }).body = body;
    const res = await fetch(url, init);
    if (res.status !== EXPECTED_STATUS) {
      throw new Error(repairPrompt(res.status));
    }
    expect(res.status).toBe(EXPECTED_STATUS);
  });
});
