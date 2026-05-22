// FEATURE: Repair prompt embedded in generated test failures
// SIGNAL: when a generated pin fails, stderr/stdout contains a
//   "PINNED FAILURE" header AND the original claim text AND a
//   "paste this into Claude Code / Cursor" instruction AND a
//   re-run command line.
// FALSIFIABILITY: catches a regression where the template stops
//   embedding the repair prompt or drops any of the load-bearing
//   strings ("PINNED FAILURE", "paste this into Claude Code",
//   "re-run").

import { describe, it, expect, afterEach } from "vitest";
import { generateAuthRequiredTest } from "../../apps/cli/src/templates/authRequired.js";
import { generateRateLimitTest } from "../../apps/cli/src/templates/rateLimit.js";
import { startFixtureServer, type FixtureServer } from "../fixtures/server.js";
import { runGeneratedTest } from "../fixtures/runGenerated.js";

let server: FixtureServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

describe("FEATURE-AUDIT: repair prompt + back-reference in failure output", () => {
  it("POSITIVE CONTROL: failing auth-required test prints all five load-bearing repair-prompt strings", async () => {
    server = await startFixtureServer({
      kind: "auth-broken",
      route: "/api/x",
    });
    const claim = {
      template: "auth-required" as const,
      route: "/api/x",
      raw: "Auth required on /api/x.",
    };
    const gen = generateAuthRequiredTest(claim, { prId: "audit-pr-42" });
    const result = await runGeneratedTest(gen.content, {
      env: { PREVIEW_URL: server.url },
    });
    expect(result.exitCode).not.toBe(0);
    const combined = result.stdout + result.stderr;
    // Five load-bearing strings the repair prompt MUST include
    expect(combined).toContain("PINNED FAILURE");
    expect(combined).toContain("paste this into Claude Code");
    expect(combined).toContain("Auth required on /api/x.");
    expect(combined).toContain("Original PR: audit-pr-42");
    expect(combined).toContain("re-run");
  });

  it("POSITIVE CONTROL: failing rate-limit test ALSO prints the repair prompt", async () => {
    server = await startFixtureServer({
      kind: "rate-limit-broken",
      route: "/api/y",
    });
    const claim = {
      template: "rate-limit" as const,
      route: "/api/y",
      rate: 5,
      window: "minute" as const,
      raw: "Rate-limits /api/y to 5 req/min.",
    };
    const gen = generateRateLimitTest(claim, { prId: "audit-pr-99" });
    const result = await runGeneratedTest(gen.content, {
      env: { PREVIEW_URL: server.url },
    });
    expect(result.exitCode).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toContain("PINNED FAILURE");
    expect(combined).toContain("Rate-limits /api/y to 5 req/min.");
    expect(combined).toContain("Original PR: audit-pr-99");
  });

  it("NEGATIVE CONTROL: PASSING test does NOT print the repair prompt (signal absent when feature is healthy)", async () => {
    server = await startFixtureServer({
      kind: "auth-healthy",
      route: "/api/x",
    });
    const claim = {
      template: "auth-required" as const,
      route: "/api/x",
      raw: "Auth required on /api/x.",
    };
    const gen = generateAuthRequiredTest(claim, { prId: "audit-pr-42" });
    const result = await runGeneratedTest(gen.content, {
      env: { PREVIEW_URL: server.url },
    });
    expect(result.exitCode).toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).not.toContain("PINNED FAILURE");
    expect(combined).not.toContain("paste this into Claude Code");
  });
});
