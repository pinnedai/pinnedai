// Pinned by pinnedai — claim from ex.
// Original PR claim: "`pinned doctor` outputs `tests/pinned/ directory`"
// Pinned to fail if this is ever regressed.
//
// Retire when no longer applicable:
//   pinned retire ex-cli-output-contains-pinned-doctor-1ixfce --reason="..."

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";

const COMMAND = "pinned doctor";
const ARGV = ["pinned","doctor"];
const EXPECTED_TEXT = "tests/pinned/ directory";
const ORIGINAL_PR = "ex";
const ORIGINAL_CLAIM = "`pinned doctor` outputs `tests/pinned/ directory`";

function repairPrompt(actualOutput: string): string {
  // Cap the captured output so a runaway CLI doesn't dump megabytes
  // into the test report.
  const preview = actualOutput.length > 2000
    ? actualOutput.slice(0, 2000) + "\n... [truncated " + (actualOutput.length - 2000) + " bytes]"
    : actualOutput;
  return [
    "",
    "═══ PINNED FAILURE — paste this into Claude Code / Cursor ═══",
    "",
    "Fix the failing pinned claim in this test file:",
    "  Claim: " + ORIGINAL_CLAIM,
    "  Original PR: " + ORIGINAL_PR,
    "  Command: " + COMMAND,
    "  Expected stdout to contain: " + JSON.stringify(EXPECTED_TEXT),
    "  Actual stdout:",
    preview,
    "",
    "Restore the output behavior — locate the CLI handler that should",
    "produce this string and re-emit it. Do not modify this pinned test file.",
    "",
    "After fixing, re-run:  npx vitest run tests/pinned/ex-cli-output-contains-pinned-doctor-1ixfce.test.ts",
    "═══════════════════════════════════════════════════════════════",
    "",
  ].join("\n");
}

describe("pinned: cli-output-contains `" + COMMAND + "`", () => {
  it("stdout contains " + JSON.stringify(EXPECTED_TEXT), () => {
    if (ARGV.length === 0) {
      throw new Error(
        "[pinned skip] empty command after parsing — claim text appears malformed. " +
          "Retire this pin via: pinned retire " + ORIGINAL_PR + "-... --reason=\"malformed\""
      );
    }
    const [bin, ...args] = ARGV;
    // execFileSync without a shell. Argv is fully tokenized at
    // generation time so claim text cannot escape into a shell.
    let stdout = "";
    try {
      stdout = execFileSync(bin, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        // Cap output at 10MB so a runaway CLI doesn't OOM the runner.
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (e) {
      // Even on non-zero exit the captured stdout may contain the
      // expected text — surface it for repairPrompt below.
      const err = e as { stdout?: Buffer | string; status?: number };
      if (err.stdout) {
        stdout = typeof err.stdout === "string"
          ? err.stdout
          : err.stdout.toString("utf8");
      }
      // Don't throw yet — let the assertion decide so failures show
      // the captured stdout in repairPrompt instead of a raw spawn error.
    }
    if (!stdout.includes(EXPECTED_TEXT)) {
      throw new Error(repairPrompt(stdout));
    }
    expect(stdout).toContain(EXPECTED_TEXT);
  });
});
