// Pinned by pinnedai — claim from ex.
// Original PR claim: "`parseConfig()` in `src/config.ts` returns `{\"version\": 1}`"
// Pinned to fail if this is ever regressed.
//
// Retire when no longer applicable:
//   pinned retire ex-library-returns-src-config-ts-parseconfig-1l7edw --reason="..."

import { describe, it, expect } from "vitest";
// @ts-ignore — module path is resolved at runtime in the consumer's repo.
import { parseConfig } from "../../src/config.ts";

const EXPECTED = {"version":1} as const;
const ORIGINAL_PR = "ex";
const ORIGINAL_CLAIM = "`parseConfig()` in `src/config.ts` returns `{\"version\": 1}`";
const TEST_FILENAME = "ex-library-returns-src-config-ts-parseconfig-1l7edw.test.ts";

function repairPrompt(actual: unknown): string {
  return [
    "",
    "═══ PINNED FAILURE — paste this into Claude Code / Cursor ═══",
    "",
    "Fix the failing pinned claim in this test file:",
    "  Claim: " + ORIGINAL_CLAIM,
    "  Original PR: " + ORIGINAL_PR,
    "  Function: parseConfig (from src/config.ts)",
    "  Expected return: " + JSON.stringify(EXPECTED),
    "  Actual return: " + JSON.stringify(actual),
    "",
    "Restore parseConfig's return value. Do not modify this pinned test file.",
    "",
    "After fixing, re-run:  npx vitest run tests/pinned/" + TEST_FILENAME,
    "═══════════════════════════════════════════════════════════════",
    "",
  ].join("\n");
}

describe("pinned: library-returns parseConfig() in src/config.ts", () => {
  it("returns the pinned expected value", () => {
    const actual = parseConfig();
    if (JSON.stringify(actual) !== JSON.stringify(EXPECTED)) {
      throw new Error(repairPrompt(actual));
    }
    expect(actual).toEqual(EXPECTED);
  });
});
