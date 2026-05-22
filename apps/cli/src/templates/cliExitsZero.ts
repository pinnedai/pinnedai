// Template: cli-exits-zero
//
// Spawns the command via execFileSync and asserts a clean exit (status
// 0). Argv is tokenized at generation time — no shell.

import type { CliExitsZeroClaim } from "../claimParser.js";
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

export function generateCliExitsZeroTest(
  claim: CliExitsZeroClaim,
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
// Template:          cli-exits-zero
// Permanent:         this test fails if the claim is ever regressed.
//
// Retire when no longer applicable:
//   pinned retire ${claimId} --reason="..."
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";

const COMMAND = ${JSON.stringify(claim.route)};
const ARGV = ${JSON.stringify(argv)};
const ORIGINAL_PR = ${JSON.stringify(opts.prId)};
const ORIGINAL_CLAIM = ${JSON.stringify(claim.raw)};
const TEST_FILENAME = ${JSON.stringify(filename)};

function repairPrompt(status: number | null, stderr: string): string {
  const stderrPreview = stderr.length > 2000
    ? stderr.slice(0, 2000) + "\\n... [truncated " + (stderr.length - 2000) + " bytes]"
    : stderr;
  return [
    "",
    "═══ PINNED FAILURE — paste this into Claude Code / Cursor ═══",
    "",
    "Fix the failing pinned claim in this test file:",
    "  Claim: " + ORIGINAL_CLAIM,
    "  Original PR: " + ORIGINAL_PR,
    "  Command: " + COMMAND,
    "  Expected: exit code 0",
    "  Actual: exit code " + status,
    "  Stderr:",
    stderrPreview,
    "",
    "Restore the command's success behavior. Do not modify this pinned test file.",
    "",
    "After fixing, re-run:  npx vitest run tests/pinned/" + TEST_FILENAME,
    "═══════════════════════════════════════════════════════════════",
    "",
  ].join("\\n");
}

describe("pinned: cli-exits-zero \`" + COMMAND + "\`", () => {
  it("exits with code 0", () => {
    if (ARGV.length === 0) {
      throw new Error(
        "[pinned skip] empty command after parsing — claim text appears malformed."
      );
    }
    const [bin, ...args] = ARGV;
    const result = spawnSync(bin, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    });
    if (result.status !== 0) {
      throw new Error(repairPrompt(result.status, result.stderr ?? ""));
    }
    expect(result.status).toBe(0);
  });
});
`;

  return { filename, content, claimId };
}
