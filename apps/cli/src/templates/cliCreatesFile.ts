// Template: cli-creates-file
//
// Spawns the command in a fresh tempdir and asserts the named file
// exists relative to that tempdir afterward. Argv is tokenized at
// generation time — no shell.
//
// We use a tempdir (not the repo root) so the test is repeatable
// without leaving artifacts in the customer's project. The customer
// can override via PINNED_CLI_CWD if the command requires their actual
// repo state.

import type { CliCreatesFileClaim } from "../claimParser.js";
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

export function generateCliCreatesFileTest(
  claim: CliCreatesFileClaim,
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
// Template:          cli-creates-file
// Permanent:         this test fails if the claim is ever regressed.
//
// Retire when no longer applicable:
//   pinned retire ${claimId} --reason="..."
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const COMMAND = ${JSON.stringify(claim.route)};
const ARGV = ${JSON.stringify(argv)};
const EXPECTED_FILE = ${JSON.stringify(claim.filePath)};
const ORIGINAL_PR = ${JSON.stringify(opts.prId)};
const ORIGINAL_CLAIM = ${JSON.stringify(claim.raw)};
const TEST_FILENAME = ${JSON.stringify(filename)};

function repairPrompt(cwd: string, status: number | null, stderr: string): string {
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
    "  Run in: " + cwd,
    "  Expected file: " + EXPECTED_FILE,
    "  Command exit code: " + status,
    "  Stderr:",
    stderrPreview,
    "",
    "Restore the file-creation behavior. Do not modify this pinned test file.",
    "",
    "After fixing, re-run:  npx vitest run tests/pinned/" + TEST_FILENAME,
    "═══════════════════════════════════════════════════════════════",
    "",
  ].join("\\n");
}

describe("pinned: cli-creates-file \`" + COMMAND + "\` -> " + EXPECTED_FILE, () => {
  it("creates the expected file when run in a clean tempdir", () => {
    if (ARGV.length === 0) {
      throw new Error(
        "[pinned skip] empty command after parsing — claim text appears malformed."
      );
    }
    // Defense-in-depth: refuse expected paths that escape the tempdir.
    if (EXPECTED_FILE.startsWith("/") || EXPECTED_FILE.includes("..")) {
      throw new Error(
        "[pinned skip] expected file path \\"" + EXPECTED_FILE + "\\" is not safely repo-relative."
      );
    }

    const cwd = process.env.PINNED_CLI_CWD
      ? resolve(process.env.PINNED_CLI_CWD)
      : mkdtempSync(join(tmpdir(), "pinned-creates-file-"));
    const cleanup = !process.env.PINNED_CLI_CWD;
    try {
      const [bin, ...args] = ARGV;
      const result = spawnSync(bin, args, {
        encoding: "utf8",
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 10 * 1024 * 1024,
      });
      const expected = join(cwd, EXPECTED_FILE);
      // The path must still be inside cwd after the join — extra paranoia.
      if (!resolve(expected).startsWith(resolve(cwd))) {
        throw new Error("expected file escapes tempdir: " + expected);
      }
      if (!existsSync(expected)) {
        throw new Error(repairPrompt(cwd, result.status, result.stderr ?? ""));
      }
      expect(existsSync(expected)).toBe(true);
    } finally {
      if (cleanup) rmSync(cwd, { recursive: true, force: true });
    }
  });
});
`;

  return { filename, content, claimId };
}
