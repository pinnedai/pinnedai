// ═══════════════════════════════════════════════════════════════
// ◆ Pinned by pinnedai — https://pinnedai.dev
// ═══════════════════════════════════════════════════════════════
// Original PR claim: "`node ./apps/cli/dist/cli.js show --help` exits 0"
// Source PR:         auto-20260521
// Template:          cli-exits-zero
// Permanent:         this test fails if the claim is ever regressed.
//
// Retire when no longer applicable:
//   pinned retire auto-20260521-cli-exits-zero-node-apps-cli-dist-cli-js-show-help-1pbzqd --reason="..."
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";

const COMMAND = "node ./apps/cli/dist/cli.js show --help";
const ARGV = ["node","./apps/cli/dist/cli.js","show","--help"];
const ORIGINAL_PR = "auto-20260521";
const ORIGINAL_CLAIM = "`node ./apps/cli/dist/cli.js show --help` exits 0";
const TEST_FILENAME = "auto-20260521-cli-exits-zero-node-apps-cli-dist-cli-js-show-help-1pbzqd.test.ts";

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
