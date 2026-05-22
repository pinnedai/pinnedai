// Pinned by pinnedai — claim from ex.
// Original PR claim: "`pinned init` exits 0"
// Pinned to fail if this is ever regressed.
//
// Retire when no longer applicable:
//   pinned retire ex-cli-exits-zero-pinned-init-wykwa --reason="..."

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";

const COMMAND = "pinned init";
const ARGV = ["pinned","init"];
const ORIGINAL_PR = "ex";
const ORIGINAL_CLAIM = "`pinned init` exits 0";
const TEST_FILENAME = "ex-cli-exits-zero-pinned-init-wykwa.test.ts";

function repairPrompt(status: number | null, stderr: string): string {
  const stderrPreview = stderr.length > 2000
    ? stderr.slice(0, 2000) + "\n... [truncated " + (stderr.length - 2000) + " bytes]"
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
  ].join("\n");
}

describe("pinned: cli-exits-zero `" + COMMAND + "`", () => {
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
