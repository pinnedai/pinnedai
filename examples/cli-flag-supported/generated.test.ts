// Pinned by pinnedai — claim from ex.
// Original PR claim: "`pinned check` supports `--json`"
// Pinned to fail if this is ever regressed.
//
// Retire when no longer applicable:
//   pinned retire ex-cli-flag-supported-pinned-check-1enye1 --reason="..."

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";

const COMMAND = "pinned check";
const ARGV = ["pinned","check"];
const FLAG = "--json";
const ORIGINAL_PR = "ex";
const ORIGINAL_CLAIM = "`pinned check` supports `--json`";
const TEST_FILENAME = "ex-cli-flag-supported-pinned-check-1enye1.test.ts";

function repairPrompt(helpOutput: string): string {
  const preview = helpOutput.length > 2000
    ? helpOutput.slice(0, 2000) + "\n... [truncated " + (helpOutput.length - 2000) + " bytes]"
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
  ].join("\n");
}

describe("pinned: cli-flag-supported `" + COMMAND + "` " + FLAG, () => {
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
