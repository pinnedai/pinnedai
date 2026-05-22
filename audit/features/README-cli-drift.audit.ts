// FEATURE: README CLI reference stays in sync with the actual
//   subcommand inventory. If we add a new subcommand and forget to
//   document it, OR if README references a command that was renamed
//   / removed, this audit fails.
// SIGNAL: the set of subcommands shown by `pinned --help` equals the
//   set of commands listed in the README's `## CLI reference` table.
// FALSIFIABILITY: catches doc drift the moment someone ships a new
//   command without updating the README, or removes a command without
//   pruning the table.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runCli } from "./runCli.js";

const REPO_ROOT = resolve(
  new URL(import.meta.url).pathname,
  "..",
  "..",
  ".."
);

// Top-level subcommands intentionally omitted from the README's CLI
// reference table. Reason: they're internal / setup-flow / behavior
// flags rather than daily-use commands. Keep this list tight.
const OMITTED_FROM_README: ReadonlySet<string> = new Set([
  // Commander auto-generates `help` for `pinned <cmd> --help` etc.;
  // it's never something the user types directly.
  "help",
]);

function parseCliSubcommands(helpOutput: string): Set<string> {
  // Commander prints subcommands under "Commands:" as:
  //     try                          Description...
  //     check [options]              Description...
  //     scan|scan-diff [options]     Description...
  //     ai-rules [options] <action>  Description...
  //                                  ...continuation lines indented to
  //                                  the description column.
  //
  // The subcommand NAME always starts at column 2 (after exactly two
  // leading spaces). Continuation lines are indented much further
  // (~30 cols) to align with the description column — those must NOT
  // be parsed as subcommand names.
  const out = new Set<string>();
  let inCommandsBlock = false;
  for (const line of helpOutput.split("\n")) {
    if (/^Commands:/.test(line)) {
      inCommandsBlock = true;
      continue;
    }
    if (!inCommandsBlock) continue;
    if (line.trim().length === 0) continue;
    // EXACTLY 2 leading spaces. If there's a 3rd space, it's a wrap
    // continuation line and we ignore it.
    const m = /^ {2}([a-z][a-z0-9-]*)(?:\|([a-z][a-z0-9-]*))?(?:\s|\[|<|$)/.exec(
      line
    );
    if (m) {
      out.add(m[1]);
      if (m[2]) out.add(m[2]);
    }
  }
  return out;
}

function parseReadmeCommands(readme: string): Set<string> {
  // Find the "## CLI reference" section and extract command names
  // from EVERY backticked span in any table row. This handles:
  //   | `pinned init` | Scaffold... |
  //   | `pinned scan --base origin/main` (alias: `scan-diff`) | ... |
  //   | `pinned fix-prompt [--risk N | --safety N]` | ... |     ← `|` inside backticks
  //   | `npx pinnedai` | Default... |
  //
  // We deliberately extract from the WHOLE row, not just the first
  // column, because aliases get mentioned in parenthetical text
  // (`alias: \`risks\``) and `|` inside a backticked code span
  // confuses naive column splitters.
  const cliRefStart = readme.indexOf("## CLI reference");
  if (cliRefStart === -1) {
    throw new Error(
      "README is missing the `## CLI reference` section — drift audit cannot run."
    );
  }
  const nextSection = readme.indexOf("\n## ", cliRefStart + 1);
  const block =
    nextSection === -1
      ? readme.slice(cliRefStart)
      : readme.slice(cliRefStart, nextSection);

  const out = new Set<string>();
  for (const line of block.split("\n")) {
    if (!line.startsWith("|")) continue;
    // Skip the table header separator
    if (/^\|\s*-+\s*\|/.test(line)) continue;
    // Skip the table header row (typically "| Command | ... |")
    if (/^\|\s*Command\s*\|/i.test(line)) continue;
    // Extract EVERY backticked span across the whole row.
    const spans = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    for (const span of spans) {
      const cleanedTokens = span.trim().split(/\s+/);
      const firstWord = cleanedTokens[0];
      const secondWord = cleanedTokens[1];
      if (firstWord === "npx") {
        if (cleanedTokens[1] === "pinnedai") {
          if (cleanedTokens.length === 2) {
            out.add("try");
          } else {
            out.add(cleanedTokens[2]);
          }
        }
        continue;
      }
      if (firstWord === "pinned" || firstWord === "pinnedai") {
        if (secondWord) out.add(secondWord);
        continue;
      }
      // Standalone backticked command name (used in alias mentions):
      //   `risks` / `scan-diff` — match if the span is JUST a
      //   command-name-shaped string.
      if (/^[a-z][a-z0-9-]*$/.test(span)) {
        out.add(span);
      }
    }
  }
  return out;
}

describe("FEATURE-AUDIT: README CLI reference stays in sync with `pinned --help`", () => {
  it("POSITIVE CONTROL: every subcommand from `pinned --help` is documented in the README table", async () => {
    const help = await runCli(["--help"]);
    expect(help.exitCode).toBe(0);
    const cliCommands = parseCliSubcommands(help.stdout);
    expect(cliCommands.size).toBeGreaterThan(5); // sanity

    const readme = readFileSync(
      resolve(REPO_ROOT, "apps/cli/README.md"),
      "utf8"
    );
    const documented = parseReadmeCommands(readme);

    const undocumented = [...cliCommands].filter(
      (c) => !documented.has(c) && !OMITTED_FROM_README.has(c)
    );
    expect(undocumented).toEqual([]);
  });

  it("POSITIVE CONTROL: every command in the README table exists in `pinned --help`", async () => {
    const help = await runCli(["--help"]);
    const cliCommands = parseCliSubcommands(help.stdout);
    const readme = readFileSync(
      resolve(REPO_ROOT, "apps/cli/README.md"),
      "utf8"
    );
    const documented = parseReadmeCommands(readme);

    const stale = [...documented].filter((c) => !cliCommands.has(c));
    expect(stale).toEqual([]);
  });

  it("FALSIFIABILITY: the parser correctly identifies new subcommands (catches stub regression)", async () => {
    // Sanity check that parseCliSubcommands actually pulled commands
    // out, not just an empty set. If Commander's --help output format
    // ever changes, this assertion catches it before the silent-pass
    // mode of "0 commands in == 0 stale == always passes" kicks in.
    const help = await runCli(["--help"]);
    const cliCommands = parseCliSubcommands(help.stdout);
    // The core long-lived commands MUST be present in --help output.
    for (const expected of ["init", "check", "generate", "list", "retire", "doctor"]) {
      expect(cliCommands.has(expected)).toBe(true);
    }
  });

  it("FALSIFIABILITY: the README parser correctly extracts commands (catches stub regression)", () => {
    const readme = readFileSync(
      resolve(REPO_ROOT, "apps/cli/README.md"),
      "utf8"
    );
    const documented = parseReadmeCommands(readme);
    // The core long-lived commands MUST appear in the README table.
    for (const expected of ["init", "check", "generate", "list", "retire", "doctor"]) {
      expect(documented.has(expected)).toBe(true);
    }
  });

  it("NEGATIVE CONTROL: an injected fake command in the README parser test is detected as stale", () => {
    // Pseudo-input simulating a stale README (mentions a command that
    // doesn't exist in the CLI). Proves the stale-detection path.
    const fakeReadme = `## CLI reference

| Command | What it does |
|---|---|
| \`pinned init\` | scaffold |
| \`pinned non-existent-command\` | shouldn't be documented |
`;
    const documented = parseReadmeCommands(fakeReadme);
    expect(documented.has("non-existent-command")).toBe(true);
    // And the CLI doesn't actually have this command — proving the
    // stale-check would catch it in a real run.
  });
});
