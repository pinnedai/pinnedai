// Template: library-returns
//
// Imports the named function from a repo-relative module path, invokes
// it with the args literal embedded in the claim, and deep-equals the
// return against the expected JSON value.
//
// Args inside the function call (e.g. "parseConfig({foo: 1})") are
// captured as raw source text and re-embedded in the generated test
// verbatim — so they MUST be valid TypeScript expressions. Pinnedai
// validates the surrounding shape but does not parse arbitrary expr.
// If the claim's args contain anything that wouldn't compile, the
// generated test simply won't compile — failure is loud, not silent.

import type { LibraryReturnsClaim } from "../claimParser.js";
import { claimSlug } from "../claimParser.js";

export type GenerateOpts = {
  prId: string;
};

export type GeneratedTest = {
  filename: string;
  content: string;
  claimId: string;
};

export function generateLibraryReturnsTest(
  claim: LibraryReturnsClaim,
  opts: GenerateOpts
): GeneratedTest {
  const slug = claimSlug(claim);
  const claimId = `${opts.prId}-${slug}`;
  const filename = `${claimId}.test.ts`;

  // Split "name(args)" into name + args. The regex parser already
  // validated this shape, but we re-validate defensively here.
  const m = /^([A-Za-z_][\w]*)\((.*)\)$/.exec(claim.functionName);
  if (!m) {
    throw new Error(
      `generateLibraryReturnsTest: malformed functionName ${JSON.stringify(claim.functionName)}`
    );
  }
  const fn = m[1];
  const args = m[2];

  // We import from a repo-relative path with a leading "../../" so the
  // test (which sits in tests/pinned/) reaches up to the repo root.
  // Strip any leading "./" the customer may have included.
  const cleanPath = claim.modulePath.replace(/^\.\//, "");
  const importPath = `../../${cleanPath}`;

  const content = `// ═══════════════════════════════════════════════════════════════
// ◆ Pinned by pinnedai — https://pinnedai.dev
// ═══════════════════════════════════════════════════════════════
// Original PR claim: ${JSON.stringify(claim.raw)}
// Source PR:         ${opts.prId}
// Template:          library-returns
// Permanent:         this test fails if the claim is ever regressed.
//
// Retire when no longer applicable:
//   pinned retire ${claimId} --reason="..."
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
// @ts-ignore — module path is resolved at runtime in the consumer's repo.
import { ${fn} } from ${JSON.stringify(importPath)};

const EXPECTED = ${JSON.stringify(claim.expected)} as const;
const ORIGINAL_PR = ${JSON.stringify(opts.prId)};
const ORIGINAL_CLAIM = ${JSON.stringify(claim.raw)};
const TEST_FILENAME = ${JSON.stringify(filename)};

function repairPrompt(actual: unknown): string {
  return [
    "",
    "═══ PINNED FAILURE — paste this into Claude Code / Cursor ═══",
    "",
    "Fix the failing pinned claim in this test file:",
    "  Claim: " + ORIGINAL_CLAIM,
    "  Original PR: " + ORIGINAL_PR,
    "  Function: ${fn} (from ${cleanPath})",
    "  Expected return: " + JSON.stringify(EXPECTED),
    "  Actual return: " + JSON.stringify(actual),
    "",
    "Restore ${fn}'s return value. Do not modify this pinned test file.",
    "",
    "After fixing, re-run:  npx vitest run tests/pinned/" + TEST_FILENAME,
    "═══════════════════════════════════════════════════════════════",
    "",
  ].join("\\n");
}

describe("pinned: library-returns ${fn}() in ${cleanPath}", () => {
  it("returns the pinned expected value", () => {
    const actual = ${fn}(${args});
    if (JSON.stringify(actual) !== JSON.stringify(EXPECTED)) {
      throw new Error(repairPrompt(actual));
    }
    expect(actual).toEqual(EXPECTED);
  });
});
`;

  return { filename, content, claimId };
}
