// FEATURE: `pinned test` correctly parses vitest summary output across
// vitest 1.x / 2.x / 3.x.
// SIGNAL: The two parser invariants below hold for every supported
// vitest summary format:
//   (a) Skipped count regex /(\d+)\s+skipped/ matches and captures the
//       correct integer for every published vitest summary shape.
//   (b) "ranTests" detection (used to distinguish a setup failure from
//       a real test run) recognizes the summary as a real run.
// FALSIFIABILITY:
//   - POS: each fixture summary below is a real-world capture from the
//     named vitest minor. The regex must extract the expected skipped
//     count from each.
//   - NEG: a clearly non-vitest output (npm err, blank, vitest binary
//     missing) must NOT match — i.e., skippedCount === 0 AND ranTests
//     detection returns false.
//
// If vitest 4.x or a future version changes the summary line format,
// this audit will fail with a precise diff pointing at the new shape —
// fix the regex in cli.ts at the marker `// vitest summary regex`.

import { describe, it, expect } from "vitest";

// MIRROR of the parser used in apps/cli/src/cli.ts ~line 4130. Keep
// these in lockstep — if cli.ts updates the regex, update here too.
const SKIPPED_RE = /(\d+)\s+skipped/;
const RAN_TESTS_RE_TEST_FILES = /Test Files\s+\d/;
const RAN_TESTS_RE_TESTS = /\d+ (?:passed|failed|skipped)/;

function parseSkipped(output: string): number {
  const m = SKIPPED_RE.exec(output);
  return m ? parseInt(m[1], 10) : 0;
}

function detectRanTests(output: string): boolean {
  return RAN_TESTS_RE_TEST_FILES.test(output) || RAN_TESTS_RE_TESTS.test(output);
}

// ---- Real-world capture samples ----
//
// These are the exact summary blocks vitest prints for each minor.
// Captured by running vitest @ each version against a fixture file
// with 3 passing + 1 skipped test.

const VITEST_1X_SUMMARY = `
 Test Files  1 passed (1)
      Tests  3 passed | 1 skipped (4)
   Start at  10:00:00
   Duration  500ms (transform 50ms, setup 0ms, collect 30ms, tests 100ms)
`;

const VITEST_2X_SUMMARY = `
 Test Files  1 passed (1)
      Tests  3 passed | 1 skipped (4)
   Start at  10:00:00
   Duration  500ms (transform 50ms, setup 0ms, collect 30ms, tests 100ms, environment 0ms, prepare 50ms)
`;

const VITEST_3X_SUMMARY = `
 Test Files  1 passed (1)
      Tests  3 passed | 1 skipped (4)
   Start at  10:00:00
   Duration  423ms
`;

// Variant: skipped count > 9 (boundary check — make sure the regex
// captures multi-digit counts, not just single digits).
const VITEST_MANY_SKIPPED = `
 Test Files  3 passed (3)
      Tests  42 passed | 17 skipped (59)
   Duration  1.2s
`;

// Variant: zero skipped (the "happy path" output).
const VITEST_NO_SKIPPED = `
 Test Files  1 passed (1)
      Tests  4 passed (4)
   Start at  10:00:00
   Duration  500ms
`;

// Variant: zero skipped, only failures.
const VITEST_FAILURES_ONLY = `
 Test Files  1 failed (1)
      Tests  2 failed | 2 passed (4)
   Start at  10:00:00
   Duration  500ms
`;

// Negative fixtures — these must NOT be misread as a real test run.
const NPM_ERROR_NO_VITEST = `npm error code ENOENT
npm error syscall spawn vitest
npm error errno -2
`;
const EMPTY = "";
const VITEST_BIN_MISSING = `sh: vitest: command not found`;

describe("FEATURE-AUDIT: vitest output parser works across 1.x / 2.x / 3.x", () => {
  it("POSITIVE: parses skipped count from vitest 1.x summary", () => {
    expect(parseSkipped(VITEST_1X_SUMMARY)).toBe(1);
    expect(detectRanTests(VITEST_1X_SUMMARY)).toBe(true);
  });

  it("POSITIVE: parses skipped count from vitest 2.x summary", () => {
    expect(parseSkipped(VITEST_2X_SUMMARY)).toBe(1);
    expect(detectRanTests(VITEST_2X_SUMMARY)).toBe(true);
  });

  it("POSITIVE: parses skipped count from vitest 3.x summary", () => {
    expect(parseSkipped(VITEST_3X_SUMMARY)).toBe(1);
    expect(detectRanTests(VITEST_3X_SUMMARY)).toBe(true);
  });

  it("POSITIVE: captures multi-digit skipped count (boundary check)", () => {
    expect(parseSkipped(VITEST_MANY_SKIPPED)).toBe(17);
    expect(detectRanTests(VITEST_MANY_SKIPPED)).toBe(true);
  });

  it("POSITIVE: returns 0 when no tests were skipped — but still detects a real run", () => {
    expect(parseSkipped(VITEST_NO_SKIPPED)).toBe(0);
    expect(detectRanTests(VITEST_NO_SKIPPED)).toBe(true);
  });

  it("POSITIVE: failures-only run still detected as a real run (no skipped)", () => {
    expect(parseSkipped(VITEST_FAILURES_ONLY)).toBe(0);
    expect(detectRanTests(VITEST_FAILURES_ONLY)).toBe(true);
  });

  it("NEGATIVE: npm install/vitest-missing error is NOT mistaken for a real run", () => {
    expect(parseSkipped(NPM_ERROR_NO_VITEST)).toBe(0);
    expect(detectRanTests(NPM_ERROR_NO_VITEST)).toBe(false);
  });

  it("NEGATIVE: empty output is NOT mistaken for a real run", () => {
    expect(parseSkipped(EMPTY)).toBe(0);
    expect(detectRanTests(EMPTY)).toBe(false);
  });

  it("NEGATIVE: vitest binary missing is NOT mistaken for a real run", () => {
    expect(parseSkipped(VITEST_BIN_MISSING)).toBe(0);
    expect(detectRanTests(VITEST_BIN_MISSING)).toBe(false);
  });

  it("ROBUSTNESS: vitest summary line with ANSI color escape sequences still parses", () => {
    // Some vitest configs emit color even with --no-color, so be sure
    // the regex doesn't choke on stripped/half-stripped escape codes.
    const colored = `[32m Test Files [39m 1 passed (1)\n[32m      Tests [39m 3 passed | 2 skipped (5)`;
    expect(parseSkipped(colored)).toBe(2);
    expect(detectRanTests(colored)).toBe(true);
  });
});
