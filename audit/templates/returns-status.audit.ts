// FEATURE: returns-status template
// SIGNAL: when a route correctly returns the expected status code on
//   the bad-input scenario, the generated test PASSES. When the same
//   route returns 200 instead (validation removed/weakened), the test
//   FAILS with PINNED FAILURE + claim text.
// FALSIFIABILITY: catches a regression where the template stops
//   sending the minimally-invalid body, asserts on the wrong status
//   code, or no longer surfaces the PINNED FAILURE block.

import { describe, it, expect, afterEach } from "vitest";
import { generateReturnsStatusTest } from "../../apps/cli/src/templates/returnsStatus.js";
import { startFixtureServer, type FixtureServer } from "../fixtures/server.js";
import { runGeneratedTest } from "../fixtures/runGenerated.js";

const ROUTE = "/api/signup";
const claim = {
  template: "returns-status" as const,
  route: ROUTE,
  method: "POST" as const,
  status: 400,
  condition: "missing email",
  field: "email",
  conditionKind: "missing" as const,
  raw: `POST ${ROUTE} returns 400 on missing email.`,
};

let server: FixtureServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

describe("FEATURE-AUDIT: returns-status template", () => {
  it("POSITIVE CONTROL: generated test PASSES against a route that returns the expected 400 on invalid body", async () => {
    server = await startFixtureServer({
      kind: "returns-status-healthy",
      route: ROUTE,
      method: "POST",
      expectedStatus: 400,
    });
    const gen = generateReturnsStatusTest(claim, { prId: "audit" });
    const result = await runGeneratedTest(gen.content, {
      env: { PREVIEW_URL: server.url },
    });
    expect(result.exitCode).toBe(0);
  });

  it("NEGATIVE CONTROL: generated test FAILS against a route that returns 200 (validation removed), with PINNED FAILURE header + claim text", async () => {
    server = await startFixtureServer({
      kind: "returns-status-broken",
      route: ROUTE,
    });
    const gen = generateReturnsStatusTest(claim, { prId: "audit" });
    const result = await runGeneratedTest(gen.content, {
      env: { PREVIEW_URL: server.url },
    });
    expect(result.exitCode).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toContain("PINNED FAILURE");
    expect(combined).toContain(claim.raw);
  });
});
