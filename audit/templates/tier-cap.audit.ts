// FEATURE: tier-cap template
// SIGNAL: when a route correctly enforces a billing-tier cap (under-cap
//   → 2xx, at-cap → 4xx, paid → 2xx), the generated test PASSES.
//   When the route returns 200 regardless of token (cap stripped),
//   the test FAILS with PINNED FAILURE + claim text.
// FALSIFIABILITY: catches a regression where the template stops
//   firing all 3 directions, accepts wrong status codes, or loses
//   the PINNED FAILURE block in the failure message.
//
// Coverage notes: the broken-fixture returns 200 to all tokens. The
// at-cap direction is the one that fires the catch (expected 4xx,
// got 200 — REVENUE LEAK pattern). The at-cap direction is gated on
// PREVIEW_TEST_TOKEN_TIER_<TIER>_AT_CAP, so we supply that fixture
// token via the test env. The other directions skip silently without
// their fixtures (under-cap and paid).

import { describe, it, expect, afterEach } from "vitest";
import { generateTierCapTest } from "../../apps/cli/src/templates/tierCap.js";
import { startFixtureServer, type FixtureServer } from "../fixtures/server.js";
import { runGeneratedTest } from "../fixtures/runGenerated.js";

const ROUTE = "/api/audit-target-projects";
const TIER = "free";
const claim = {
  template: "tier-cap" as const,
  route: ROUTE,
  tier: TIER,
  cap: 3,
  resource: "projects",
  raw: `POST ${ROUTE} is capped at 3 projects for ${TIER} tier.`,
};

let server: FixtureServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

describe("FEATURE-AUDIT: tier-cap template", () => {
  it("POSITIVE CONTROL: generated test PASSES against a healthy tier-cap route (at-cap → 4xx)", async () => {
    server = await startFixtureServer({
      kind: "tier-cap-healthy",
      route: ROUTE,
      underCapToken: "test-under-cap-token",
      atCapToken: "test-at-cap-token",
      paidToken: "test-paid-token",
    });
    const gen = generateTierCapTest(claim, { prId: "audit" });
    // Supply only the at-cap fixture token — the other two directions
    // skip silently. The at-cap direction is the one that catches the
    // revenue-leak regression, so it's the load-bearing direction.
    const result = await runGeneratedTest(gen.content, {
      env: {
        PREVIEW_URL: server.url,
        PREVIEW_TEST_TOKEN_TIER_FREE_AT_CAP: "test-at-cap-token",
      },
    });
    expect(result.exitCode).toBe(0);
  });

  it("NEGATIVE CONTROL: generated test FAILS against a route with cap stripped (always 200), with PINNED FAILURE header + claim text + revenue-leak marker", async () => {
    server = await startFixtureServer({
      kind: "tier-cap-broken",
      route: ROUTE,
    });
    const gen = generateTierCapTest(claim, { prId: "audit" });
    const result = await runGeneratedTest(gen.content, {
      env: {
        PREVIEW_URL: server.url,
        PREVIEW_TEST_TOKEN_TIER_FREE_AT_CAP: "test-at-cap-token",
      },
    });
    expect(result.exitCode).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toContain("PINNED FAILURE");
    expect(combined).toContain(claim.raw);
    // The failure should specifically name the at-cap direction and
    // surface the revenue-leak framing.
    expect(combined).toContain("at-cap");
    expect(combined.toUpperCase()).toContain("REVENUE LEAK");
  });

  // Direction-3 specific test: paid customer incorrectly blocked
  // (cap over-applied). Catches "we made the cap apply to everyone,
  // including paying tiers" — direct refund risk.
  it("DIRECTION-3 (paid over-applied): generated test FAILS when paid token gets 4xx (cap over-applied to paying customers)", async () => {
    server = await startFixtureServer({
      kind: "tier-cap-paid-rejected",
      route: ROUTE,
      underCapToken: "test-under-cap-token",
      atCapToken: "test-at-cap-token",
      paidToken: "test-paid-token",
    });
    const gen = generateTierCapTest(claim, { prId: "audit" });
    const result = await runGeneratedTest(gen.content, {
      env: {
        PREVIEW_URL: server.url,
        // Set paid token so direction-3 runs.
        PREVIEW_TEST_TOKEN_PAID: "test-paid-token",
        // Set at-cap so direction-2 also runs and passes (fixture
        // correctly rejects at-cap with 402) — isolates direction-3
        // as the cause of failure.
        PREVIEW_TEST_TOKEN_TIER_FREE_AT_CAP: "test-at-cap-token",
      },
    });
    expect(result.exitCode).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toContain("PINNED FAILURE");
    expect(combined).toContain("paid-bypass");
    expect(combined).toContain("over-applied");
  });

  it("NO-CHANGE / SKIP DIRECTION: all fixture-dependent directions skip silently when tokens absent — no false fail", async () => {
    // The tier-cap-broken fixture returns 200 for everyone. With NO
    // tokens set, all 3 directions skip silently → test passes (no
    // catch fires because no direction actually ran). This is the
    // FP-prevention contract: missing fixtures never cause false fails.
    server = await startFixtureServer({
      kind: "tier-cap-broken",
      route: ROUTE,
    });
    const gen = generateTierCapTest(claim, { prId: "audit" });
    const result = await runGeneratedTest(gen.content, {
      env: {
        PREVIEW_URL: server.url,
        // No tier-cap fixture tokens set — all 3 directions skip.
      },
    });
    expect(result.exitCode).toBe(0);
  });
});
