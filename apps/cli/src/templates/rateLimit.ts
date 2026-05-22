// Template: rate-limit
//
// Given a `RateLimitClaim` (route + rate + window) emit a Vitest file
// that bursts `rate + 1` parallel requests at the route and asserts at
// least one response is 429. Burst-parallel rather than sequential so
// we always exceed token-bucket / sliding-window limiters regardless
// of refill rate.
//
// The generated test reads `PREVIEW_URL` at runtime — Pinned does not
// spin up the app itself. v0.2 will add an opt-in local-server mode.

import type { RateLimitClaim } from "../claimParser.js";
import { claimSlug, badCaseForClaim } from "../claimParser.js";
import { PINNED_FETCH_HELPER_SRC } from "./sharedFetch.js";

export type GenerateOpts = {
  prId: string;
};

export type GeneratedTest = {
  filename: string;
  content: string;
  claimId: string;
};

export function generateRateLimitTest(
  claim: RateLimitClaim,
  opts: GenerateOpts
): GeneratedTest {
  const slug = claimSlug(claim);
  const claimId = `${opts.prId}-${slug}`;
  const filename = `${claimId}.test.ts`;
  const gen_filename = filename;

  const content = `// ═══════════════════════════════════════════════════════════════
// ◆ Pinned by pinnedai — https://pinnedai.dev
// ═══════════════════════════════════════════════════════════════
// Original PR claim: ${JSON.stringify(claim.raw)}
// Source PR:         ${opts.prId}
// Template:          rate-limit
// Permanent:         this test fails if the claim is ever regressed.
//
// Retire when no longer applicable:
//   pinned retire ${claimId} --reason="..."
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll } from "vitest";
${PINNED_FETCH_HELPER_SRC}
const PREVIEW_URL = process.env.PREVIEW_URL;
const ROUTE = ${JSON.stringify(claim.route)};
const RATE = ${claim.rate};
const WINDOW = ${JSON.stringify(claim.window)};
const ORIGINAL_PR = ${JSON.stringify(opts.prId)};
const ORIGINAL_CLAIM = ${JSON.stringify(claim.raw)};
const BAD_CASE = ${JSON.stringify(badCaseForClaim(claim))};
const TEST_FILENAME = ${JSON.stringify(filename)};

function repairPrompt(actualStatuses: number[]): string {
  return [
    "",
    "═══ PINNED FAILURE — paste this into Claude Code / Cursor ═══",
    "",
    "Fix the failing pinned claim in this test file:",
    "  Claim: " + ORIGINAL_CLAIM,
    "  Original PR: " + ORIGINAL_PR,
    "  Route: " + ROUTE,
    "  Bad case: " + BAD_CASE,
    "  Expected: " + (RATE + 1) + " parallel requests should yield at least one 429",
    "  Actual: got statuses " + actualStatuses.join(","),
    "",
    "Find where /api requests are rate-limited (middleware, route handler, or upstream proxy)",
    "and restore enforcement for " + ROUTE + " at " + RATE + "/" + WINDOW + ".",
    "Preserve all other behavior. Do not modify this pinned test file.",
    "",
    "After fixing, re-run:  npx vitest run tests/pinned/${gen_filename}",
    "═══════════════════════════════════════════════════════════════",
    "",
  ].join("\\n");
}

describe("pinned: rate-limit on " + ROUTE + " (" + RATE + "/" + WINDOW + ")", () => {
  // Skip — not fail — when PREVIEW_URL is unset. Background post-commit
  // auto-runs need this; manual runs can force failure via
  // PINNED_REQUIRE_PREVIEW_URL=1.
  const previewMissing = !PREVIEW_URL;
  const forceRequire = process.env.PINNED_REQUIRE_PREVIEW_URL === "1";

  beforeAll(() => {
    if (previewMissing && forceRequire) {
      throw new Error(
        "PREVIEW_URL env var required for pinned rate-limit tests. " +
          "See https://pinnedai.dev/docs/preview-url"
      );
    }
    if (PREVIEW_URL) {
      pinnedAssertNonProductionUrl(PREVIEW_URL, "rate-limit");
    }
  });

  it.skipIf(previewMissing && !forceRequire)("returns 429 after exceeding " + RATE + " requests per " + WINDOW, async () => {
    const url = PREVIEW_URL!.replace(/\\/$/, "") + ROUTE;

    // Burst-parallel: fire RATE + 1 requests at once so we exceed the
    // limiter regardless of how its bucket refills. Capped at 101 to
    // protect CI runners against very-high-RATE claims that would
    // otherwise blow the runner's memory or socket pool.
    const burstSize = Math.min(RATE + 1, 101);

    // If RATE >= 100, the default burst can't reliably reach the limit.
    // Skip explicitly (vitest reports a "skipped" status, not a pass)
    // and surface a clear manual-test prompt so the customer knows
    // this pin is NOT effectively guarding the claim.
    if (RATE >= 100) {
      throw new Error(
        "[pinned skip] rate-limit claim of " + RATE + "/" + WINDOW +
          " exceeds the default test burst size (100 parallel requests). " +
          "The generated default test cannot reliably exercise this limit. " +
          "Replace this test with a custom manual implementation, or " +
          "retire this pin via 'pinned retire " + ORIGINAL_PR + "-...' if " +
          "the limit is not safety-critical."
      );
    }

    const statuses = await Promise.all(
      Array.from({ length: burstSize }, () =>
        pinnedFetch(url, { method: "GET" }).then((r) => r.status)
      )
    );

    if (!statuses.includes(429)) {
      throw new Error(repairPrompt(statuses));
    }
    expect(statuses.includes(429)).toBe(true);
  });

  // Direction 2 — OVER-TIGHTENING CHECK (opt-in via env var)
  // Catches: "limit lowered" regressions where the cap was tightened
  // below the documented value (e.g., 60 → 30, breaking legit users).
  //
  // FP mitigations (3 layers):
  //   1. Opt-in: only runs if PREVIEW_TEST_RATE_LIMIT_AT_CAP=1 is set.
  //      Customer enables once they trust the at-cap test won't flake.
  //   2. SEQUENTIAL fire (not parallel): avoids triggering global
  //      concurrency limits / IP throttles that could 429 spuriously.
  //   3. 90% headroom: assert at least 90% of the RATE requests succeed
  //      (not 100%). Tolerates cold-start latency or a single transient
  //      5xx without false-failing — a real "limit lowered" regression
  //      would cause >>10% failures anyway.
  const atCapOptIn = process.env.PREVIEW_TEST_RATE_LIMIT_AT_CAP === "1";
  it.skipIf((previewMissing || !atCapOptIn) && !forceRequire)(
    "allows up to " + RATE + " requests per " + WINDOW + " without 429 (at-cap)",
    async () => {
      const url = PREVIEW_URL!.replace(/\\/$/, "") + ROUTE;
      // Sequential — one at a time. Avoids artificial concurrency
      // limits and gives the limiter's bucket time to refill if it's
      // a sliding-window implementation.
      const successCount = await (async () => {
        let okCount = 0;
        for (let i = 0; i < RATE; i++) {
          try {
            const r = await pinnedFetch(url, { method: "GET" });
            if (r.status >= 200 && r.status < 300) okCount += 1;
          } catch {
            // Network error counts as a non-success but doesn't fail
            // the test by itself — the 90% threshold absorbs flakes.
          }
        }
        return okCount;
      })();

      // 90% threshold (round down). A real limit-lowered regression
      // would block far more than 10% of within-cap requests.
      const threshold = Math.floor(RATE * 0.9);
      if (successCount < threshold) {
        const msg = [
          "",
          "═══ PINNED FAILURE — paste this into Claude Code / Cursor ═══",
          "",
          "Fix the failing pinned claim in this test file:",
          "  Claim: " + ORIGINAL_CLAIM,
          "  Original PR: " + ORIGINAL_PR,
          "  Route: " + ROUTE,
          "  Direction: at-cap (over-tightening check)",
          "  Expected: at least " + threshold + " of " + RATE + " sequential requests succeed within the " + WINDOW + " window",
          "  Actual: only " + successCount + " of " + RATE + " succeeded (rate limit may have been LOWERED below " + RATE + ", blocking legit traffic)",
          "",
          "Investigate why under-cap requests are being rejected.",
          "Likely causes:",
          "  - Rate limit accidentally lowered below " + RATE + " (regression)",
          "  - Per-IP throttle triggered (your test runner's IP needs an allowlist)",
          "  - Cold-start preview returning 5xx for the first few requests",
          "Preserve the over-cap → 429 contract (direction 1). Do not modify this pinned test file.",
          "",
          "After fixing, re-run:  npx vitest run tests/pinned/" + TEST_FILENAME,
          "═══════════════════════════════════════════════════════════════",
          "",
        ].join("\\n");
        throw new Error(msg);
      }
      expect(successCount).toBeGreaterThanOrEqual(threshold);
    }
  );
});
`;

  return { filename, content, claimId };
}
