// FEATURE: idempotent template
// SIGNAL: when a route returns byte-identical bodies for repeated POSTs
//   with the same idField, the generated test PASSES. When the server
//   returns different bodies, the test FAILS with PINNED FAILURE.
// FALSIFIABILITY: catches a regression where the template stopped
//   POSTing twice, or stopped comparing bodies byte-for-byte.

import { describe, it, expect, afterEach } from "vitest";
import { generateIdempotentTest } from "../../apps/cli/src/templates/idempotent.js";
import { startFixtureServer, type FixtureServer } from "../fixtures/server.js";
import { runGeneratedTest } from "../fixtures/runGenerated.js";

const ROUTE = "/webhooks/audit";
const claim = {
  template: "idempotent" as const,
  route: ROUTE,
  idField: "event_id",
  raw: `Makes ${ROUTE} idempotent on event_id.`,
};

let server: FixtureServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

describe("FEATURE-AUDIT: idempotent template", () => {
  it("POSITIVE CONTROL: generated test PASSES against an idempotent server", async () => {
    server = await startFixtureServer({
      kind: "idempotent-healthy",
      route: ROUTE,
      idField: "event_id",
    });
    const gen = generateIdempotentTest(claim, { prId: "audit" });
    const result = await runGeneratedTest(gen.content, {
      env: { PREVIEW_URL: server.url },
    });
    expect(result.exitCode).toBe(0);
  });

  it("NEGATIVE CONTROL: generated test FAILS against a server that returns differing responses, with PINNED FAILURE header + claim text", async () => {
    server = await startFixtureServer({
      kind: "idempotent-broken",
      route: ROUTE,
    });
    const gen = generateIdempotentTest(claim, { prId: "audit" });
    const result = await runGeneratedTest(gen.content, {
      env: { PREVIEW_URL: server.url },
    });
    expect(result.exitCode).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toContain("PINNED FAILURE");
    expect(combined).toContain(claim.raw);
  });
});
