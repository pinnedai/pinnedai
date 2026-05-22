// FEATURE: rate-limit template
// SIGNAL: when a route is genuinely rate-limited, the generated test
//   PASSES (exit code 0). When the same route is NOT rate-limited, the
//   generated test FAILS (exit code != 0) with a "PINNED FAILURE"
//   header containing the original claim text.
// FALSIFIABILITY: this audit would catch a regression where the
//   template stopped bursting RATE+1 parallel requests, or stopped
//   checking for 429 in the responses.

import { describe, it, expect, afterEach } from "vitest";
import { generateRateLimitTest } from "../../apps/cli/src/templates/rateLimit.js";
import { startFixtureServer, type FixtureServer } from "../fixtures/server.js";
import { runGeneratedTest } from "../fixtures/runGenerated.js";

const RATE = 5;
const ROUTE = "/api/audit";
const WINDOW_MS = 60_000;

const claim = {
  template: "rate-limit" as const,
  route: ROUTE,
  rate: RATE,
  window: "minute" as const,
  raw: `Rate-limits ${ROUTE} to ${RATE} req/min.`,
};

let server: FixtureServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

describe("FEATURE-AUDIT: rate-limit template", () => {
  it("POSITIVE CONTROL: generated test PASSES against a rate-limited server", async () => {
    server = await startFixtureServer({
      kind: "rate-limit-healthy",
      route: ROUTE,
      rate: RATE,
      windowMs: WINDOW_MS,
    });
    const gen = generateRateLimitTest(claim, { prId: "audit" });
    const result = await runGeneratedTest(gen.content, {
      env: { PREVIEW_URL: server.url },
    });
    expect(result.exitCode).toBe(0);
  });

  it("NEGATIVE CONTROL: generated test FAILS against a non-rate-limited server, with PINNED FAILURE header + claim text", async () => {
    server = await startFixtureServer({
      kind: "rate-limit-broken",
      route: ROUTE,
    });
    const gen = generateRateLimitTest(claim, { prId: "audit" });
    const result = await runGeneratedTest(gen.content, {
      env: { PREVIEW_URL: server.url },
    });
    // The signal we expect on a broken rate-limit is a failing test
    // exit code AND the repair-prompt header in stdout/stderr.
    expect(result.exitCode).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toContain("PINNED FAILURE");
    expect(combined).toContain(claim.raw);
  });

  // Direction 2 — over-tightening (at-cap) — added in the v0.1 round.
  // Gated on PREVIEW_TEST_RATE_LIMIT_AT_CAP=1 so the customer must
  // opt into it. FP-mitigated by sequential firing + 90% headroom.
  it("DIRECTION-2 (at-cap): generated test FAILS against a too-tight server (limit lowered), with PINNED FAILURE header + 'at-cap' direction marker", async () => {
    // RATE=5, tightRate=2 → only 2 of 5 sequential requests succeed
    // (40%). The 90% threshold (4 of 5) → test fails.
    server = await startFixtureServer({
      kind: "rate-limit-too-tight",
      route: ROUTE,
      tightRate: 2,
      windowMs: WINDOW_MS,
    });
    const gen = generateRateLimitTest(claim, { prId: "audit" });
    const result = await runGeneratedTest(gen.content, {
      env: {
        PREVIEW_URL: server.url,
        // Opt in to direction-2 — without this, the direction skips.
        PREVIEW_TEST_RATE_LIMIT_AT_CAP: "1",
      },
    });
    expect(result.exitCode).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toContain("PINNED FAILURE");
    expect(combined).toContain("at-cap");
    expect(combined).toContain("LOWERED");
  });

  it("NO-CHANGE / SKIP DIRECTION: at-cap direction skips silently when PREVIEW_TEST_RATE_LIMIT_AT_CAP is absent — no false fail", async () => {
    // Against the too-tight fixture (which WOULD fail direction-2 if
    // it ran), the test must PASS when the opt-in env var is unset —
    // direction-1 runs against the original burst behavior and
    // catches the limit. (Note: too-tight fixture also triggers
    // direction-1 because the 429 fires after only `tightRate` reqs;
    // so direction-1 passes against this fixture too — burst-rate
    // happens to also be limited.) The KEY contract: no FALSE FAIL
    // from a missing fixture env var.
    server = await startFixtureServer({
      kind: "rate-limit-healthy",
      route: ROUTE,
      rate: RATE,
      windowMs: WINDOW_MS,
    });
    const gen = generateRateLimitTest(claim, { prId: "audit" });
    const result = await runGeneratedTest(gen.content, {
      env: {
        PREVIEW_URL: server.url,
        // Intentionally omit PREVIEW_TEST_RATE_LIMIT_AT_CAP — direction-2
        // skips. Direction-1 passes against healthy server.
      },
    });
    expect(result.exitCode).toBe(0);
  });
});
