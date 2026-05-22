// FEATURE: permission-required template
// SIGNAL: when a route correctly enforces RBAC (401 for no-auth, 403
//   for wrong-role, 200 for right-role), the generated test PASSES.
//   When the route returns 200 regardless of headers (role check
//   stripped), the test FAILS with PINNED FAILURE + claim text.
// FALSIFIABILITY: catches a regression where the template stops
//   firing its 3-direction sequence, accepts wrong status codes, or
//   loses the PINNED FAILURE block in the failure message.
//
// Coverage of "iterate in both directions": the broken fixture
// returns 200 to ALL requests, so direction-1 (no-auth → expected
// 401/403) is the one that fires the catch. This is the most
// universally-supported direction (no fixture credentials needed)
// so we test that one in the negative control. Directions 2 + 3 are
// fixture-gated and would skip in this audit's env anyway.

import { describe, it, expect, afterEach } from "vitest";
import { generatePermissionRequiredTest } from "../../apps/cli/src/templates/permissionRequired.js";
import { startFixtureServer, type FixtureServer } from "../fixtures/server.js";
import { runGeneratedTest } from "../fixtures/runGenerated.js";

const ROUTE = "/api/admin/audit-target";
const ROLE = "admin";
const claim = {
  template: "permission-required" as const,
  route: ROUTE,
  role: ROLE,
  raw: `${ROUTE} requires ${ROLE} role.`,
};

let server: FixtureServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

describe("FEATURE-AUDIT: permission-required template", () => {
  it("POSITIVE CONTROL: generated test PASSES against a healthy RBAC route (401 without auth)", async () => {
    server = await startFixtureServer({
      kind: "permission-required-healthy",
      route: ROUTE,
      rightRoleToken: "test-admin-token",
      wrongRoleToken: "test-member-token",
    });
    const gen = generatePermissionRequiredTest(claim, { prId: "audit" });
    // Without role-fixture env vars, only direction-1 (no-auth → 401/403)
    // runs. Directions 2 + 3 skip silently. That's exactly the contract:
    // the audit runs with the minimum fixture surface and still proves
    // the template's primary direction works.
    const result = await runGeneratedTest(gen.content, {
      env: { PREVIEW_URL: server.url },
    });
    expect(result.exitCode).toBe(0);
  });

  it("NEGATIVE CONTROL: generated test FAILS against a route with role check stripped (always 200), with PINNED FAILURE header + claim text", async () => {
    server = await startFixtureServer({
      kind: "permission-required-broken",
      route: ROUTE,
    });
    const gen = generatePermissionRequiredTest(claim, { prId: "audit" });
    const result = await runGeneratedTest(gen.content, {
      env: { PREVIEW_URL: server.url },
    });
    expect(result.exitCode).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toContain("PINNED FAILURE");
    expect(combined).toContain(claim.raw);
    // The failure should specifically name direction-1 (no-auth).
    expect(combined).toContain("no-auth");
  });

  // Direction-2 specific test: wrong-role token gets accepted (role
  // check stripped while auth retained). This is the most insidious
  // RBAC regression because direction-1 still passes — without the
  // direction-2 fixture token, the test would silently miss it. This
  // audit proves direction-2 catches it when the fixture IS set.
  it("DIRECTION-2 (wrong-role): generated test FAILS when wrong-role token gets 200 (role check stripped, auth retained)", async () => {
    server = await startFixtureServer({
      kind: "permission-required-wrong-role-accepted",
      route: ROUTE,
      rightRoleToken: "test-admin-token",
      wrongRoleToken: "test-member-token",
    });
    const gen = generatePermissionRequiredTest(claim, { prId: "audit" });
    const result = await runGeneratedTest(gen.content, {
      env: {
        PREVIEW_URL: server.url,
        PREVIEW_TEST_TOKEN_NON_ADMIN: "test-member-token",
        // Don't set right-role token — keep direction-3 skipped to
        // isolate direction-2 as the cause of the failure.
      },
    });
    expect(result.exitCode).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toContain("PINNED FAILURE");
    expect(combined).toContain("wrong-role");
  });

  // Direction-3 specific test: right-role token incorrectly rejected
  // (route over-tightened, legit admins blocked). Direction-1 + 2
  // both pass here — only direction-3 catches it.
  it("DIRECTION-3 (right-role over-tightening): generated test FAILS when right-role token gets 403 (route over-restricted)", async () => {
    server = await startFixtureServer({
      kind: "permission-required-right-role-rejected",
      route: ROUTE,
      rightRoleToken: "test-admin-token",
    });
    const gen = generatePermissionRequiredTest(claim, { prId: "audit" });
    const result = await runGeneratedTest(gen.content, {
      env: {
        PREVIEW_URL: server.url,
        PREVIEW_TEST_TOKEN_ADMIN: "test-admin-token",
        // Don't set wrong-role token — keep direction-2 skipped to
        // isolate direction-3 as the cause of the failure.
      },
    });
    expect(result.exitCode).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toContain("PINNED FAILURE");
    expect(combined).toContain("right-role");
    expect(combined).toContain("over-tightened");
  });

  it("NO-CHANGE / SKIP DIRECTION: directions 2 + 3 skip silently when their fixture tokens absent — no false fail", async () => {
    // Against the wrong-role-accepted fixture (which WOULD fail
    // direction-2 if its fixture token were set), the test must PASS
    // when PREVIEW_TEST_TOKEN_NON_ADMIN is absent. Only direction-1
    // runs and the fixture answers 401 for unauth → direction-1 OK.
    // FP-prevention contract.
    server = await startFixtureServer({
      kind: "permission-required-wrong-role-accepted",
      route: ROUTE,
      rightRoleToken: "test-admin-token",
      wrongRoleToken: "test-member-token",
    });
    const gen = generatePermissionRequiredTest(claim, { prId: "audit" });
    const result = await runGeneratedTest(gen.content, {
      env: {
        PREVIEW_URL: server.url,
        // No PREVIEW_TEST_TOKEN_ADMIN or _NON_ADMIN — direction-2 + 3 skip.
      },
    });
    expect(result.exitCode).toBe(0);
  });
});
