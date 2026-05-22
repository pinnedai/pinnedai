// FEATURE: auth-required template
// SIGNAL: when a route correctly returns 401/403 without auth, the
//   generated test PASSES. When the same route returns 200 (auth
//   missing), the test FAILS with PINNED FAILURE + claim text.
// FALSIFIABILITY: catches a regression where the template stopped
//   sending the Authorization-less request, or stopped accepting 401/403.

import { describe, it, expect, afterEach } from "vitest";
import { generateAuthRequiredTest } from "../../apps/cli/src/templates/authRequired.js";
import { startFixtureServer, type FixtureServer } from "../fixtures/server.js";
import { runGeneratedTest } from "../fixtures/runGenerated.js";

const ROUTE = "/api/admin/audit";
const claim = {
  template: "auth-required" as const,
  route: ROUTE,
  raw: `Auth required on ${ROUTE}.`,
};

let server: FixtureServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

describe("FEATURE-AUDIT: auth-required template", () => {
  it("POSITIVE CONTROL: generated test PASSES against a route that returns 401 without auth", async () => {
    server = await startFixtureServer({ kind: "auth-healthy", route: ROUTE });
    const gen = generateAuthRequiredTest(claim, { prId: "audit" });
    const result = await runGeneratedTest(gen.content, {
      env: { PREVIEW_URL: server.url },
    });
    expect(result.exitCode).toBe(0);
  });

  it("NEGATIVE CONTROL: generated test FAILS against a route that returns 200 without auth, with PINNED FAILURE header + claim text", async () => {
    server = await startFixtureServer({ kind: "auth-broken", route: ROUTE });
    const gen = generateAuthRequiredTest(claim, { prId: "audit" });
    const result = await runGeneratedTest(gen.content, {
      env: { PREVIEW_URL: server.url },
    });
    expect(result.exitCode).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toContain("PINNED FAILURE");
    expect(combined).toContain(claim.raw);
  });

  // Direction 2 — over-tightening — added in the v0.1 catch-rate round.
  // When the with-auth fixture token is set, the template runs an
  // additional `it.skipIf` that catches the case where auth was made
  // too strict (legit authenticated users blocked). Without the fixture
  // env var, this direction skips silently — verified by the POSITIVE
  // CONTROL test, which doesn't set the env var and still passes.
  it("OVER-TIGHTENING DIRECTION: generated test FAILS when authenticated requests return 4xx (auth made too strict), with PINNED FAILURE header", async () => {
    server = await startFixtureServer({
      kind: "auth-over-tightened",
      route: ROUTE,
      authToken: "test-auth-token",
    });
    const gen = generateAuthRequiredTest(claim, { prId: "audit" });
    const result = await runGeneratedTest(gen.content, {
      env: {
        PREVIEW_URL: server.url,
        // Setting the with-auth fixture token activates direction-2.
        PREVIEW_TEST_TOKEN_AUTH: "test-auth-token",
      },
    });
    expect(result.exitCode).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toContain("PINNED FAILURE");
    expect(combined).toContain("with-auth");
    expect(combined).toContain("over-restricted");
  });

  it("NO-CHANGE / SKIP DIRECTION: with-auth direction skips silently when PREVIEW_TEST_TOKEN_AUTH is absent — no false fail", async () => {
    // Even against the over-tightened fixture (which WOULD fail
    // direction-2 if it ran), the test must PASS when the auth token
    // env var is unset because direction-2's it.skipIf gates on its
    // absence. This is the FP-prevention contract.
    server = await startFixtureServer({
      kind: "auth-over-tightened",
      route: ROUTE,
      authToken: "test-auth-token",
    });
    const gen = generateAuthRequiredTest(claim, { prId: "audit" });
    const result = await runGeneratedTest(gen.content, {
      env: {
        PREVIEW_URL: server.url,
        // Intentionally omit PREVIEW_TEST_TOKEN_AUTH — direction-2
        // skips, only direction-1 runs (which the fixture satisfies).
      },
    });
    expect(result.exitCode).toBe(0);
  });
});
