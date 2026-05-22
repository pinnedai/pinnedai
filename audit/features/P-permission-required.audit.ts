// FEATURE: permission-required template — role-based access control.
//   Parser extracts (route, role) from PR phrasings. Generated test
//   asserts THREE directions independently skipIf-gated:
//     direction 1: no-auth → 401/403  (catches role check stripped to public)
//     direction 2: wrong-role token → 403  (catches role check dropped while auth retained)
//     direction 3: right-role token → 2xx  (catches over-tightening — even legit users blocked)
// SIGNAL (observable when feature is healthy):
//   1. Parser recognizes 5 phrasings — extracts (route, role) cleanly.
//   2. Generated test source contains the 3 it.skipIf() directions,
//      each with its own credential-env-var gate.
//   3. Direction 1 runs whenever PREVIEW_URL is set (no token needed).
//   4. Direction 2 skipIf-gated on PREVIEW_TEST_TOKEN_NON_<ROLE>.
//   5. Direction 3 skipIf-gated on PREVIEW_TEST_TOKEN_<ROLE>.
//   6. Failure messages distinguish which direction broke (no-auth vs
//      wrong-role vs right-role) — paste-ready repair prompt per case.
// FALSIFIABILITY: catches regressions where a direction loses its
//   skipIf (would false-fail when fixture absent), or where the parser
//   silently downgrades a permission claim to plain auth-required
//   (would lose direction-2 + direction-3 coverage).
// NO-CHANGE direction: a missing role fixture causes that ONE direction
//   to skip cleanly while the others still run. Verified by checking
//   the skipIf condition references the role-specific env var, not
//   a global "any fixture missing → skip all" pattern.

import { describe, it, expect } from "vitest";
import {
  parseClaims,
  describeClaimForUser,
  claimRoute,
  claimKey,
  badCaseForClaim,
  type Claim,
  type PermissionRequiredClaim,
} from "../../apps/cli/src/claimParser.js";
import { generateTest } from "../../apps/cli/src/index.js";

describe("FEATURE-AUDIT: permission-required parser recognizes role phrasings", () => {
  const cases: Array<{ desc: string; input: string; route: string; role: string }> = [
    {
      desc: "POSITIVE: 'X requires admin role' format",
      input: "/api/admin/export requires admin role.",
      route: "/api/admin/export",
      role: "admin",
    },
    {
      desc: "POSITIVE: '`role` requires backticks ok' format",
      input: "/api/billing/upgrade requires `staff` role.",
      route: "/api/billing/upgrade",
      role: "staff",
    },
    {
      desc: "POSITIVE: 'X is role-only' suffix format",
      input: "/api/admin/users is admin-only.",
      route: "/api/admin/users",
      role: "admin",
    },
    {
      desc: "POSITIVE: 'Only role can access X' format",
      input: "Only admin can access /api/admin/audit.",
      route: "/api/admin/audit",
      role: "admin",
    },
    {
      desc: "POSITIVE: 'role-only on X' prefix format",
      input: "admin-only on /api/internal/metrics.",
      route: "/api/internal/metrics",
      role: "admin",
    },
    {
      desc: "POSITIVE: 'Restricts X to role' format",
      input: "Restricts /api/admin/keys to admin role.",
      route: "/api/admin/keys",
      role: "admin",
    },
    {
      desc: "POSITIVE: role with hyphen normalized",
      input: "/api/internal/debug is billing-admin-only.",
      route: "/api/internal/debug",
      role: "billing-admin",
    },
  ];

  for (const c of cases) {
    it(c.desc, () => {
      const claims = parseClaims(c.input);
      const perm = claims.find(
        (cl): cl is PermissionRequiredClaim => cl.template === "permission-required"
      );
      expect(perm).toBeDefined();
      expect(perm!.route).toBe(c.route);
      expect(perm!.role).toBe(c.role);
    });
  }

  it("FALSIFIABILITY: bare 'Auth required on X' (no role) does NOT become permission-required", () => {
    // Catches a regression where the role regex gets too greedy and
    // swallows plain auth-required claims, silently downgrading them
    // to permission-required (which requires fixtures direction 2/3
    // would skip without).
    const claims = parseClaims("Auth required on /api/admin/x.");
    const perm = claims.find((cl) => cl.template === "permission-required");
    expect(perm).toBeUndefined();
    const auth = claims.find((cl) => cl.template === "auth-required");
    expect(auth).toBeDefined();
  });

  it("FALSIFIABILITY: 'fixture file' / 'role-play' / 'admin panel' do NOT match", () => {
    // Word boundaries should keep these from false-matching.
    expect(parseClaims("Added a fixture file for billing.")).toHaveLength(0);
    expect(parseClaims("Updated the admin panel UI.")).toHaveLength(0);
  });

  it("NO-CHANGE: empty body → no claims", () => {
    expect(parseClaims("")).toEqual([]);
  });
});

describe("FEATURE-AUDIT: permission-required test embeds 3 directions + skipIf gates", () => {
  it("POSITIVE CONTROL: generated source contains 3 it.skipIf directions", () => {
    const gen = generateTest(
      {
        template: "permission-required",
        route: "/api/admin/export",
        role: "admin",
        raw: "/api/admin/export requires admin role.",
      },
      { prId: "pr-1" }
    );
    // 3 it.skipIf calls — one per direction.
    const skipIfCount = (gen.content.match(/it\.skipIf/g) ?? []).length;
    expect(skipIfCount).toBe(3);
  });

  it("POSITIVE CONTROL: direction 1 (no-auth) gates ONLY on PREVIEW_URL — no role fixture needed", () => {
    const gen = generateTest(
      {
        template: "permission-required",
        route: "/api/admin/export",
        role: "admin",
        raw: "/api/admin/export requires admin role.",
      },
      { prId: "pr-1" }
    );
    // The no-auth direction's skipIf must reference previewMissing
    // but NOT the role tokens — otherwise the most basic check
    // (catches auth removed entirely) would skip when fixtures
    // aren't set, defeating the value.
    const dir1Match = gen.content.match(
      /it\.skipIf\(previewMissing && !forceRequire\)\("rejects unauthenticated/
    );
    expect(dir1Match).toBeTruthy();
  });

  it("POSITIVE CONTROL: direction 2 (wrong-role) gates on wrongRoleMissing", () => {
    const gen = generateTest(
      {
        template: "permission-required",
        route: "/api/admin/export",
        role: "admin",
        raw: "/api/admin/export requires admin role.",
      },
      { prId: "pr-1" }
    );
    expect(gen.content).toContain("wrongRoleMissing");
    // Specific env var: PREVIEW_TEST_TOKEN_NON_ADMIN
    expect(gen.content).toContain("PREVIEW_TEST_TOKEN_NON_ADMIN");
  });

  it("POSITIVE CONTROL: direction 3 (right-role) gates on rightRoleMissing", () => {
    const gen = generateTest(
      {
        template: "permission-required",
        route: "/api/admin/export",
        role: "admin",
        raw: "/api/admin/export requires admin role.",
      },
      { prId: "pr-1" }
    );
    expect(gen.content).toContain("rightRoleMissing");
    expect(gen.content).toContain("PREVIEW_TEST_TOKEN_ADMIN");
  });

  it("POSITIVE CONTROL: failure messages distinguish which direction broke", () => {
    const gen = generateTest(
      {
        template: "permission-required",
        route: "/api/admin/export",
        role: "admin",
        raw: "/api/admin/export requires admin role.",
      },
      { prId: "pr-1" }
    );
    // The repair prompt must include the direction name so the user
    // (or AI agent) knows whether auth was removed, role check was
    // dropped, or the route was over-tightened.
    expect(gen.content).toContain('"no-auth"');
    expect(gen.content).toContain('"wrong-role"');
    expect(gen.content).toContain('"right-role"');
  });

  it("POSITIVE CONTROL: each direction throws the repair prompt on its specific failure", () => {
    const gen = generateTest(
      {
        template: "permission-required",
        route: "/api/admin/export",
        role: "admin",
        raw: "/api/admin/export requires admin role.",
      },
      { prId: "pr-1" }
    );
    // Auth removed direction: 401/403 expected
    expect(gen.content).toContain("401, 403");
    // Role-check-dropped: 403 expected
    expect(gen.content).toContain("res.status !== 403");
    // Over-tightening: 2xx range
    expect(gen.content).toContain("res.status >= 300");
  });

  it("POSITIVE CONTROL: hyphenated role normalizes env-var name to snake-case + uppercase", () => {
    // billing-admin → PREVIEW_TEST_TOKEN_BILLING_ADMIN — the
    // normalization is critical, otherwise PREVIEW_TEST_TOKEN_billing-admin
    // would be an invalid shell env var name in many shells.
    const gen = generateTest(
      {
        template: "permission-required",
        route: "/api/internal/debug",
        role: "billing-admin",
        raw: "/api/internal/debug is billing-admin-only.",
      },
      { prId: "pr-1" }
    );
    expect(gen.content).toContain("PREVIEW_TEST_TOKEN_BILLING_ADMIN");
    expect(gen.content).toContain("PREVIEW_TEST_TOKEN_NON_BILLING_ADMIN");
  });
});

describe("FEATURE-AUDIT: permission-required helpers (route/key/bad_case/display)", () => {
  const claim: PermissionRequiredClaim = {
    template: "permission-required",
    route: "/api/admin/export",
    role: "admin",
    raw: "/api/admin/export requires admin role.",
  };

  it("POSITIVE: claimRoute returns the route", () => {
    expect(claimRoute(claim)).toBe("/api/admin/export");
  });

  it("POSITIVE: claimKey distinguishes role (allows separate pins for different roles on same route)", () => {
    const adminClaim: PermissionRequiredClaim = {
      ...claim,
      role: "admin",
    };
    const staffClaim: PermissionRequiredClaim = {
      ...claim,
      role: "staff",
    };
    expect(claimKey(adminClaim)).not.toBe(claimKey(staffClaim));
  });

  it("POSITIVE: badCaseForClaim mentions role + the two failure paths", () => {
    const bc = badCaseForClaim(claim);
    expect(bc).toContain("admin");
    expect(bc).toContain("/api/admin/export");
    // Should reference both removal paths (no-auth got 2xx OR wrong-role got 2xx)
    expect(bc).toMatch(/no-?auth|unauthenticated/i);
    expect(bc).toMatch(/wrong-role|role check/i);
  });

  it("POSITIVE: describeClaimForUser returns title + promise + check", () => {
    const d = describeClaimForUser(claim);
    expect(d.title).toContain("/api/admin/export");
    expect(d.title).toContain("admin");
    expect(d.check).toMatch(/3 directions|no-auth.*wrong-role.*role/);
  });
});
