// Template: cli-output-contains
//
// Given a CliOutputContainsClaim (command + expected stdout substring)
// emit a Vitest file that spawns the command via execFileSync and
// asserts the substring appears in stdout. Argv is constructed from a
// parsed command string — NEVER passed to a shell, so claim text can't
// break out and inject shell commands.
//
// The generated test reads PINNED_CLI_BIN at runtime if the customer
// wants to run a locally-built binary (e.g. node ./dist/cli.js); falls
// back to invoking the command as-is via the PATH.

import type { CliOutputContainsClaim } from "../claimParser.js";
import { claimSlug } from "../claimParser.js";

export type GenerateOpts = {
  prId: string;
};

export type GeneratedTest = {
  filename: string;
  content: string;
  claimId: string;
};

export function generateCliOutputContainsTest(
  claim: CliOutputContainsClaim,
  opts: GenerateOpts
): GeneratedTest {
  const slug = claimSlug(claim);
  const claimId = `${opts.prId}-${slug}`;
  const filename = `${claimId}.test.ts`;
  const gen_filename = filename;

  // We split the command string into argv at generation time so the
  // generated test never touches a shell. Splitting on unquoted
  // whitespace is sufficient for CLI claims (no piping, no env-prefixes).
  const argv = parseSimpleArgv(claim.route);

  const content = `// ═══════════════════════════════════════════════════════════════
// ◆ Pinned by pinnedai — https://pinnedai.dev
// ═══════════════════════════════════════════════════════════════
// Original PR claim: ${JSON.stringify(claim.raw)}
// Source PR:         ${opts.prId}
// Template:          cli-output-contains
// Permanent:         this test fails if the claim is ever regressed.
//
// Retire when no longer applicable:
//   pinned retire ${claimId} --reason="..."
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";

const COMMAND = ${JSON.stringify(claim.route)};
const ARGV = ${JSON.stringify(argv)};
const EXPECTED_TEXT = ${JSON.stringify(claim.text)};
const ORIGINAL_PR = ${JSON.stringify(opts.prId)};
const ORIGINAL_CLAIM = ${JSON.stringify(claim.raw)};

function repairPrompt(actualOutput: string): string {
  // Cap the captured output so a runaway CLI doesn't dump megabytes
  // into the test report.
  const preview = actualOutput.length > 2000
    ? actualOutput.slice(0, 2000) + "\\n... [truncated " + (actualOutput.length - 2000) + " bytes]"
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
    "After fixing, re-run:  npx vitest run tests/pinned/${gen_filename}",
    "═══════════════════════════════════════════════════════════════",
    "",
  ].join("\\n");
}

describe("pinned: cli-output-contains \`" + COMMAND + "\`", () => {
  it("stdout contains " + JSON.stringify(EXPECTED_TEXT), () => {
    if (ARGV.length === 0) {
      throw new Error(
        "[pinned skip] empty command after parsing — claim text appears malformed. " +
          "Retire this pin via: pinned retire " + ORIGINAL_PR + "-... --reason=\\"malformed\\""
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
`;

  return { filename, content, claimId };
}

// Bare-minimum argv splitter for CLI commands embedded in PR
// descriptions. Handles:
//   - whitespace-separated tokens
//   - single- and double-quoted strings (no nested quotes)
// Doesn't handle backslash escapes, env-prefix syntax (FOO=bar cmd),
// or shell metacharacters. If a customer's CLI claim needs more, they
// can hand-edit the generated test.
export function parseSimpleArgv(input: string): string[] {
  const out: string[] = [];
  let i = 0;
  const s = input.trim();
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      let token = "";
      while (i < s.length && s[i] !== quote) {
        token += s[i];
        i++;
      }
      i++; // skip closing quote
      out.push(token);
      continue;
    }
    let token = "";
    while (i < s.length && !/\s/.test(s[i]) && s[i] !== '"' && s[i] !== "'") {
      token += s[i];
      i++;
    }
    if (token) out.push(token);
  }
  return out;
}
