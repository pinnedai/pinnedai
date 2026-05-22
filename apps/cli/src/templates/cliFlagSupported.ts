// Template: cli-flag-supported
//
// Spawns `<command> --help` and asserts the flag appears in stdout.
// "Supported" means "documented in --help" — that's the public-API
// surface contract. If the flag is implemented but undocumented, the
// claim still fails (correctly: the docs lied).

import type { CliFlagSupportedClaim } from "../claimParser.js";
import { claimSlug } from "../claimParser.js";
import { parseSimpleArgv } from "./cliOutputContains.js";

export type GenerateOpts = {
  prId: string;
};

export type GeneratedTest = {
  filename: string;
  content: string;
  claimId: string;
};

export function generateCliFlagSupportedTest(
  claim: CliFlagSupportedClaim,
  opts: GenerateOpts
): GeneratedTest {
  const slug = claimSlug(claim);
  const claimId = `${opts.prId}-${slug}`;
  const filename = `${claimId}.test.ts`;
  const argv = parseSimpleArgv(claim.route);

  const content = `// ═══════════════════════════════════════════════════════════════
// ◆ Pinned by pinnedai — https://pinnedai.dev
// ═══════════════════════════════════════════════════════════════
// Original PR claim: ${JSON.stringify(claim.raw)}
// Source PR:         ${opts.prId}
// Template:          cli-flag-supported
// Permanent:         this test fails if the claim is ever regressed.
//
// Retire when no longer applicable:
//   pinned retire ${claimId} --reason="..."
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";

const COMMAND = ${JSON.stringify(claim.route)};
const ARGV = ${JSON.stringify(argv)};
const FLAG = ${JSON.stringify(claim.flag)};
const ORIGINAL_PR = ${JSON.stringify(opts.prId)};
const ORIGINAL_CLAIM = ${JSON.stringify(claim.raw)};
const TEST_FILENAME = ${JSON.stringify(filename)};

function repairPrompt(helpOutput: string): string {
  const preview = helpOutput.length > 2000
    ? helpOutput.slice(0, 2000) + "\\n... [truncated " + (helpOutput.length - 2000) + " bytes]"
    : helpOutput;
  return [
    "",
    "═══ PINNED FAILURE — paste this into Claude Code / Cursor ═══",
    "",
    "Fix the failing pinned claim in this test file:",
    "  Claim: " + ORIGINAL_CLAIM,
    "  Original PR: " + ORIGINAL_PR,
    "  Command: " + COMMAND,
    "  Expected --help output to document: " + FLAG,
    "  Actual --help output:",
    preview,
    "",
    "Re-add the " + FLAG + " flag to " + COMMAND + " and ensure it's documented.",
    "Do not modify this pinned test file.",
    "",
    "After fixing, re-run:  npx vitest run tests/pinned/" + TEST_FILENAME,
    "═══════════════════════════════════════════════════════════════",
    "",
  ].join("\\n");
}

describe("pinned: cli-flag-supported \`" + COMMAND + "\` " + FLAG, () => {
  it("--help output mentions " + FLAG, () => {
    if (ARGV.length === 0) {
      throw new Error(
        "[pinned skip] empty command after parsing — claim text appears malformed."
      );
    }
    const [bin, ...args] = ARGV;
    // Append --help (so the test is safe even on commands that perform
    // mutations when run without args).
    const result = spawnSync(bin, [...args, "--help"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    });
    // Many CLIs print help to stdout, some to stderr. Concatenate both
    // so we don't false-fail on convention differences.
    const combined = (result.stdout ?? "") + (result.stderr ?? "");
    if (!combined.includes(FLAG)) {
      throw new Error(repairPrompt(combined));
    }
    expect(combined).toContain(FLAG);
  });
});
`;

  return { filename, content, claimId };
}
