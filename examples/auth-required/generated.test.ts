// Pinned by pinnedai — claim from ex.
// Original PR claim: "Auth required on /api/admin/export"
// Pinned to fail if this is ever regressed.
//
// Retire when no longer applicable:
//   pinned retire ex-auth-required-api-admin-export-rw7ne7 --reason="..."

import { describe, it, expect, beforeAll } from "vitest";

const PREVIEW_URL = process.env.PREVIEW_URL;
const ROUTE = "/api/admin/export";
const ORIGINAL_PR = "ex";
const ORIGINAL_CLAIM = "Auth required on /api/admin/export";
const TEST_FILENAME = "ex-auth-required-api-admin-export-rw7ne7.test.ts";

function repairPrompt(actualStatus: number): string {
  return [
    "",
    "═══ PINNED FAILURE — paste this into Claude Code / Cursor ═══",
    "",
    "Fix the failing pinned claim in this test file:",
    "  Claim: " + ORIGINAL_CLAIM,
    "  Original PR: " + ORIGINAL_PR,
    "  Route: " + ROUTE,
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
  ].join("\n");
}

describe("pinned: auth-required on " + ROUTE, () => {
  beforeAll(() => {
    if (!PREVIEW_URL) {
      throw new Error(
        "PREVIEW_URL env var required for pinned auth-required tests. " +
          "See https://pinnedai.dev/docs/preview-url"
      );
    }
  });

  it("returns 401 or 403 when called without an Authorization header", async () => {
    const url = PREVIEW_URL!.replace(/\/$/, "") + ROUTE;
    const res = await fetch(url, { method: "GET" });
    if (![401, 403].includes(res.status)) {
      throw new Error(repairPrompt(res.status));
    }
    expect([401, 403].includes(res.status)).toBe(true);
  });
});
