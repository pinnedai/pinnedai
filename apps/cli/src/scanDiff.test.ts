import { describe, it, expect } from "vitest";
import { scanDiff, findTouchedPins } from "./scanDiff.js";
import type { ChangedFile } from "./scanDiff.js";
import type { RegistryEntry } from "./registry.js";

const empty = { prBodyClaims: [], existingPins: [] };

// Test-helper: build a minimal active pin entry for the given claim.
// Most pin fields don't affect findTouchedPins; we only need claim,
// status, and (optionally) covers. covers defaults to undefined so we
// also exercise the coverageFromClaim() fallback path.
function activePin(
  claimId: string,
  claim: RegistryEntry["claim"],
  covers?: RegistryEntry["covers"]
): RegistryEntry {
  return {
    claimId,
    prId: "pr-test",
    claim,
    filename: `${claimId}.test.ts`,
    pinnedAt: "2026-05-21T00:00:00Z",
    status: "active",
    covers,
  };
}

describe("scanDiff — Next.js App Router routes", () => {
  it("flags a new app/api route as needing auth-required", () => {
    const changed: ChangedFile[] = [
      { path: "app/api/admin/export/route.ts", status: "added" },
    ];
    const out = scanDiff({ changedFiles: changed, ...empty });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      template: "auth-required",
      route: "/api/admin/export",
    });
  });

  it("handles src/app/ prefix", () => {
    const changed: ChangedFile[] = [
      { path: "src/app/api/users/route.tsx", status: "added" },
    ];
    const out = scanDiff({ changedFiles: changed, ...empty });
    expect(out[0]).toMatchObject({
      template: "auth-required",
      route: "/api/users",
    });
  });

  it("does not flag modifications, only adds", () => {
    const changed: ChangedFile[] = [
      { path: "app/api/users/route.ts", status: "modified" },
    ];
    expect(scanDiff({ changedFiles: changed, ...empty })).toHaveLength(0);
  });
});

describe("scanDiff — Next.js Pages Router routes", () => {
  it("flags a new pages/api file", () => {
    const changed: ChangedFile[] = [
      { path: "pages/api/admin/export.ts", status: "added" },
    ];
    const out = scanDiff({ changedFiles: changed, ...empty });
    expect(out[0]).toMatchObject({
      template: "auth-required",
      route: "/api/admin/export",
    });
  });
});

describe("scanDiff — webhooks", () => {
  it("flags a webhook handler as needing idempotent", () => {
    const changed: ChangedFile[] = [
      { path: "app/webhooks/stripe/route.ts", status: "modified" },
    ];
    const out = scanDiff({ changedFiles: changed, ...empty });
    const idem = out.find((s) => s.template === "idempotent");
    expect(idem).toBeDefined();
    expect(idem!.route).toBe("/webhooks/stripe");
  });

  it("guesses provider name from webhook path", () => {
    const changed: ChangedFile[] = [
      { path: "src/handlers/webhook-shopify.ts", status: "added" },
    ];
    const out = scanDiff({ changedFiles: changed, ...empty });
    const idem = out.find((s) => s.template === "idempotent");
    expect(idem?.route).toBe("/webhooks/shopify");
  });
});

describe("scanDiff — middleware + env", () => {
  it("middleware changes surface as risk hints, NOT auto-pin suggestions", () => {
    // Middleware.ts protects a set of routes (via its export const config
    // matcher), not a single one. Emitting a concrete pin would produce
    // a placeholder like `/api/<your-route>` which fails round-trip
    // parseability — so we filter empty-suggestedPin items out at the
    // scanDiffFull tail. Asserting the suggestion list is EMPTY here
    // is the regression guard against re-introducing junk middleware pins.
    const changed: ChangedFile[] = [
      { path: "middleware.ts", status: "modified" },
    ];
    const out = scanDiff({ changedFiles: changed, ...empty });
    expect(out).toHaveLength(0);
  });

  it("flags env file changes", () => {
    const changed: ChangedFile[] = [
      { path: ".env.example", status: "modified" },
    ];
    const out = scanDiff({ changedFiles: changed, ...empty });
    expect(out[0].template).toBe("env-required");
  });
});

describe("scanDiff — coverage suppression", () => {
  it("suppresses suggestion when PR body already claims the same route", () => {
    const changed: ChangedFile[] = [
      { path: "app/api/admin/export/route.ts", status: "added" },
    ];
    const out = scanDiff({
      changedFiles: changed,
      prBodyClaims: [
        {
          template: "auth-required",
          route: "/api/admin/export",
          raw: "Auth required on /api/admin/export",
        },
      ],
      existingPins: [],
    });
    expect(out).toHaveLength(0);
  });

  it("suppresses suggestion when route is already actively pinned", () => {
    const changed: ChangedFile[] = [
      { path: "app/api/admin/export/route.ts", status: "added" },
    ];
    const out = scanDiff({
      changedFiles: changed,
      prBodyClaims: [],
      existingPins: [
        {
          claimId: "pr-100-auth-required-api-admin-export",
          prId: "pr-100",
          claim: {
            template: "auth-required",
            route: "/api/admin/export",
            raw: "",
          },
          filename: "pr-100-auth-required-api-admin-export.test.ts",
          pinnedAt: "2026-01-01T00:00:00Z",
          status: "active",
        },
      ],
    });
    expect(out).toHaveLength(0);
  });

  it("does NOT suppress when the existing pin is retired", () => {
    const changed: ChangedFile[] = [
      { path: "app/api/admin/export/route.ts", status: "added" },
    ];
    const out = scanDiff({
      changedFiles: changed,
      prBodyClaims: [],
      existingPins: [
        {
          claimId: "pr-100-auth-required-api-admin-export",
          prId: "pr-100",
          claim: {
            template: "auth-required",
            route: "/api/admin/export",
            raw: "",
          },
          filename: "pr-100-auth-required-api-admin-export.test.ts",
          pinnedAt: "2026-01-01T00:00:00Z",
          status: "retired",
          retireReason: "endpoint removed",
        },
      ],
    });
    expect(out).toHaveLength(1);
  });
});

describe("scanDiff — empty and multi-file inputs", () => {
  // POSITIVE CONTROL: known-healthy input — a new Next.js App Router
  // route file should ALWAYS produce an auth-required suggestion.
  // Per [[feature-audit-signals-must-be-falsifiable]] — the benign-
  // refactor test below is a NEGATIVE check, but if rule detection
  // broke entirely, only this positive control catches it.
  it("POSITIVE CONTROL: new app/api/.../route.ts produces an auth-required suggestion", () => {
    const changed: ChangedFile[] = [
      { path: "app/api/admin/export/route.ts", status: "added" },
    ];
    const out = scanDiff({ changedFiles: changed, ...empty });
    expect(out).toHaveLength(1);
    expect(out[0].template).toBe("auth-required");
    expect(out[0].route).toBe("/api/admin/export");
  });

  it("returns nothing for a benign refactor", () => {
    const changed: ChangedFile[] = [
      { path: "components/Button.tsx", status: "modified" },
      { path: "lib/format.ts", status: "added" },
    ];
    expect(scanDiff({ changedFiles: changed, ...empty })).toEqual([]);
  });

  it("groups multiple files under one suggestion when they trigger the same rule", () => {
    // Two webhook handlers for the same provider should collapse into
    // ONE suggestion (template:route key). Previously this test used
    // middleware.ts × 2 — those no longer emit pins (risk hint only).
    const changed: ChangedFile[] = [
      { path: "src/webhooks/stripe/handler.ts", status: "modified" },
      { path: "src/webhooks/stripe/on-event.ts", status: "modified" },
    ];
    const out = scanDiff({ changedFiles: changed, ...empty });
    expect(out).toHaveLength(1);
    expect(out[0].files).toHaveLength(2);
  });
});

describe("findTouchedPins — diff intersection with existing pins", () => {
  it("POSITIVE CONTROL: auth-required pin is touched when its route file is modified", () => {
    const pin = activePin("p1", {
      template: "auth-required",
      route: "/api/admin/export",
      raw: "Auth required on /api/admin/export.",
    });
    const changed: ChangedFile[] = [
      { path: "app/api/admin/export/route.ts", status: "modified" },
    ];
    const touched = findTouchedPins({
      changedFiles: changed,
      prBodyClaims: [],
      existingPins: [pin],
    });
    expect(touched).toHaveLength(1);
    expect(touched[0].pin.claimId).toBe("p1");
    expect(touched[0].matchedRoutes).toHaveLength(1);
    expect(touched[0].matchedRoutes[0].route).toBe("/api/admin/export");
    expect(touched[0].matchedRoutes[0].files).toEqual([
      "app/api/admin/export/route.ts",
    ]);
  });

  it("FALSIFIABILITY: pin is NOT touched when an unrelated file is modified", () => {
    const pin = activePin("p1", {
      template: "auth-required",
      route: "/api/admin/export",
      raw: "Auth required on /api/admin/export.",
    });
    const changed: ChangedFile[] = [
      { path: "src/lib/utils.ts", status: "modified" },
      { path: "README.md", status: "modified" },
    ];
    const touched = findTouchedPins({
      changedFiles: changed,
      prBodyClaims: [],
      existingPins: [pin],
    });
    expect(touched).toEqual([]);
  });

  it("rate-limit pin is touched when its Pages-Router route file changes", () => {
    const pin = activePin("p1", {
      template: "rate-limit",
      route: "/api/users",
      rate: 60,
      window: "minute",
      raw: "Rate-limits /api/users to 60 req/min.",
    });
    const changed: ChangedFile[] = [
      { path: "pages/api/users.ts", status: "modified" },
    ];
    const touched = findTouchedPins({
      changedFiles: changed,
      prBodyClaims: [],
      existingPins: [pin],
    });
    expect(touched).toHaveLength(1);
    expect(touched[0].matchedRoutes[0].route).toBe("/api/users");
  });

  it("idempotent webhook pin is touched when its webhook handler changes", () => {
    const pin = activePin("p1", {
      template: "idempotent",
      route: "/webhooks/stripe",
      idField: "event_id",
      raw: "Makes /webhooks/stripe idempotent on event_id.",
    });
    const changed: ChangedFile[] = [
      { path: "src/webhooks/stripe.ts", status: "modified" },
    ];
    const touched = findTouchedPins({
      changedFiles: changed,
      prBodyClaims: [],
      existingPins: [pin],
    });
    expect(touched).toHaveLength(1);
  });

  it("library-returns pin is touched when its modulePath is edited", () => {
    const pin = activePin("p1", {
      template: "library-returns",
      functionName: "parseConfig",
      modulePath: "src/config.ts",
      expected: { version: 1 },
      raw: "Adds parseConfig() that returns { version: 1 } in src/config.ts.",
    });
    const changed: ChangedFile[] = [
      { path: "src/config.ts", status: "modified" },
    ];
    const touched = findTouchedPins({
      changedFiles: changed,
      prBodyClaims: [],
      existingPins: [pin],
    });
    expect(touched).toHaveLength(1);
    expect(touched[0].matchedFiles).toEqual(["src/config.ts"]);
    expect(touched[0].matchedRoutes).toEqual([]);
  });

  it("CLI-output pins NEVER surface as touched (covers intentionally empty)", () => {
    // CLI-output/exits-zero/flag-supported pins don't have reliable
    // source-file inference, so they're silent in findTouchedPins.
    // Verifying this contract so a future refactor doesn't accidentally
    // turn them into false positives.
    const pin = activePin("p1", {
      template: "cli-output-contains",
      route: "pinned doctor",
      text: "Pinned status",
      raw: "`pinned doctor` outputs `Pinned status`.",
    });
    const changed: ChangedFile[] = [
      { path: "apps/cli/src/cli.ts", status: "modified" },
    ];
    const touched = findTouchedPins({
      changedFiles: changed,
      prBodyClaims: [],
      existingPins: [pin],
    });
    expect(touched).toEqual([]);
  });

  it("retired pins are never touched, even on a direct route hit", () => {
    const pin: RegistryEntry = {
      ...activePin("p1", {
        template: "auth-required",
        route: "/api/admin/export",
        raw: "Auth required on /api/admin/export.",
      }),
      status: "retired",
      retiredAt: "2026-05-20T00:00:00Z",
      retireReason: "test",
    };
    const changed: ChangedFile[] = [
      { path: "app/api/admin/export/route.ts", status: "modified" },
    ];
    const touched = findTouchedPins({
      changedFiles: changed,
      prBodyClaims: [],
      existingPins: [pin],
    });
    expect(touched).toEqual([]);
  });

  it("deleted files don't count as touched (deletion is its own signal)", () => {
    const pin = activePin("p1", {
      template: "auth-required",
      route: "/api/admin/export",
      raw: "Auth required on /api/admin/export.",
    });
    const changed: ChangedFile[] = [
      { path: "app/api/admin/export/route.ts", status: "deleted" },
    ];
    const touched = findTouchedPins({
      changedFiles: changed,
      prBodyClaims: [],
      existingPins: [pin],
    });
    expect(touched).toEqual([]);
  });

  it("backward-compat: pre-v0.1 pin without covers field still surfaces via coverageFromClaim()", () => {
    // The registry entry was written before v0.1 added the covers
    // field — covers is undefined. findTouchedPins should backfill
    // via coverageFromClaim() on the fly.
    const pin = activePin(
      "p1",
      {
        template: "library-returns",
        functionName: "parseConfig",
        modulePath: "src/config.ts",
        expected: { version: 1 },
        raw: "Adds parseConfig() returning { version: 1 } in src/config.ts.",
      }
      // No covers argument — defaults to undefined.
    );
    expect(pin.covers).toBeUndefined();
    const changed: ChangedFile[] = [
      { path: "src/config.ts", status: "modified" },
    ];
    const touched = findTouchedPins({
      changedFiles: changed,
      prBodyClaims: [],
      existingPins: [pin],
    });
    expect(touched).toHaveLength(1);
    expect(touched[0].matchedFiles).toEqual(["src/config.ts"]);
  });
});
