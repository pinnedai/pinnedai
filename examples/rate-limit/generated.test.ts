// Pinned by pinnedai — claim from ex.
// Original PR claim: "Rate-limits /api/users to 60 req/min"
// Pinned to fail if this is ever regressed.
//
// Retire when no longer applicable:
//   pinned retire ex-rate-limit-api-users-13b4b9 --reason="..."

import { describe, it, expect, beforeAll } from "vitest";

const PREVIEW_URL = process.env.PREVIEW_URL;
const ROUTE = "/api/users";
const RATE = 60;
const WINDOW = "minute";
const ORIGINAL_PR = "ex";
const ORIGINAL_CLAIM = "Rate-limits /api/users to 60 req/min";

function repairPrompt(actualStatuses: number[]): string {
  return [
    "",
    "═══ PINNED FAILURE — paste this into Claude Code / Cursor ═══",
    "",
    "Fix the failing pinned claim in this test file:",
    "  Claim: " + ORIGINAL_CLAIM,
    "  Original PR: " + ORIGINAL_PR,
    "  Route: " + ROUTE,
    "  Expected: " + (RATE + 1) + " parallel requests should yield at least one 429",
    "  Actual: got statuses " + actualStatuses.join(","),
    "",
    "Find where /api requests are rate-limited (middleware, route handler, or upstream proxy)",
    "and restore enforcement for " + ROUTE + " at " + RATE + "/" + WINDOW + ".",
    "Preserve all other behavior. Do not modify this pinned test file.",
    "",
    "After fixing, re-run:  npx vitest run tests/pinned/ex-rate-limit-api-users-13b4b9.test.ts",
    "═══════════════════════════════════════════════════════════════",
    "",
  ].join("\n");
}

describe("pinned: rate-limit on " + ROUTE + " (" + RATE + "/" + WINDOW + ")", () => {
  beforeAll(() => {
    if (!PREVIEW_URL) {
      throw new Error(
        "PREVIEW_URL env var required for pinned rate-limit tests. " +
          "See https://pinnedai.dev/docs/preview-url"
      );
    }
  });

  it("returns 429 after exceeding " + RATE + " requests per " + WINDOW, async () => {
    const url = PREVIEW_URL!.replace(/\/$/, "") + ROUTE;

    // Burst-parallel: fire RATE + 1 requests at once so we exceed the
    // limiter regardless of how its bucket refills. Capped at 101 to
    // protect CI runners against very-high-RATE claims that would
    // otherwise blow the runner's memory or socket pool.
    const burstSize = Math.min(RATE + 1, 101);

    // If RATE >= 100, the default burst can't reliably reach the limit.
    // Skip explicitly (vitest reports a "skipped" status, not a pass)
    // and surface a clear manual-test prompt so the customer knows
    // this pin is NOT effectively guarding the claim.
    if (RATE >= 100) {
      throw new Error(
        "[pinned skip] rate-limit claim of " + RATE + "/" + WINDOW +
          " exceeds the default test burst size (100 parallel requests). " +
          "The generated default test cannot reliably exercise this limit. " +
          "Replace this test with a custom manual implementation, or " +
          "retire this pin via 'pinned retire " + ORIGINAL_PR + "-...' if " +
          "the limit is not safety-critical."
      );
    }

    const statuses = await Promise.all(
      Array.from({ length: burstSize }, () =>
        fetch(url, { method: "GET" }).then((r) => r.status)
      )
    );

    if (!statuses.includes(429)) {
      throw new Error(repairPrompt(statuses));
    }
    expect(statuses.includes(429)).toBe(true);
  });
});
