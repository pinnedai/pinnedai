// FEATURE: `pinned auto-protect` is diff-aware on MODIFIED files
// SIGNAL: A new `program.command("X")` line added to an existing
//   (modified) cli.ts triggers a SAFE auto-pin in safe mode.
//   Existing `program.command()` calls in the same file do NOT
//   re-fire — they're not in the diff's added lines.
// FALSIFIABILITY:
//   - POS: an existing file with one pre-existing command, then a
//     commit that adds a NEW command, produces ONE new safe auto-pin
//     for the new command (not two).
//   - NEG: a refactor commit that only edits an existing command body
//     (no new program.command() lines) produces ZERO new safe auto-pins.

import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runCli, makeTempRepo } from "./runCli.js";

function setupRepo(cwd: string): void {
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.email", "audit@pinnedai.dev"], { cwd });
  execFileSync("git", ["config", "user.name", "audit"], { cwd });
  // Initial commit with one pre-existing Commander command in cli.ts.
  // Also create a dummy dist/cli.js so detectBinPath() returns a binPath
  // (required for the classifier to look for Commander patterns).
  mkdirSync(join(cwd, "src"), { recursive: true });
  mkdirSync(join(cwd, "dist"), { recursive: true });
  writeFileSync(join(cwd, "dist", "cli.js"), "// dummy bin entry");
  writeFileSync(
    join(cwd, "src", "cli.ts"),
    [
      `import { Command } from "commander";`,
      `const program = new Command();`,
      ``,
      `program`,
      `  .command("existing-cmd")`,
      `  .description("an existing command")`,
      `  .action(() => {});`,
      ``,
      `program.parse();`,
    ].join("\n")
  );
  mkdirSync(join(cwd, ".pinnedai"), { recursive: true });
  writeFileSync(
    join(cwd, ".pinnedai", "config.json"),
    JSON.stringify({
      version: 1,
      auto_protect: "safe",
      safety_budget_per_run: 5,
      show_pending_changes: false,
    })
  );
  mkdirSync(join(cwd, "tests", "pinned"), { recursive: true });
  writeFileSync(
    join(cwd, "tests", "pinned", ".registry.json"),
    JSON.stringify({ version: 1, claims: [] })
  );
  execFileSync("git", ["add", "-A"], { cwd });
  execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd });
}

describe("FEATURE-AUDIT: auto-protect diff-awareness on modified files", () => {
  it("POSITIVE CONTROL: adding a NEW program.command() to an existing cli.ts triggers exactly ONE safe auto-pin", async () => {
    const cwd = makeTempRepo();
    setupRepo(cwd);

    // Modify cli.ts to ADD a new command. The diff added-lines should
    // contain only the new `program.command("newly-added")` block.
    writeFileSync(
      join(cwd, "src", "cli.ts"),
      [
        `import { Command } from "commander";`,
        `const program = new Command();`,
        ``,
        `program`,
        `  .command("existing-cmd")`,
        `  .description("an existing command")`,
        `  .action(() => {});`,
        ``,
        `program`,
        `  .command("newly-added")`,
        `  .description("a brand-new command")`,
        `  .action(() => {});`,
        ``,
        `program.parse();`,
      ].join("\n")
    );
    execFileSync("git", ["add", "-A"], { cwd });
    execFileSync("git", ["commit", "-q", "-m", "add newly-added command"], { cwd });

    // Run auto-protect against the diff between HEAD~1 and HEAD.
    const r = await runCli(
      ["auto-protect", "--base", "HEAD~1", "--quiet"],
      { cwd }
    );
    expect(r.exitCode).toBe(0);

    // POS CONTROL: exactly one cli-exits-zero pin landed, and it's
    // for the newly-added command, NOT the existing one.
    const pinFiles = readdirSync(join(cwd, "tests", "pinned")).filter(
      (f) => f.endsWith(".test.ts")
    );
    const cliExitPins = pinFiles.filter((f) => f.includes("cli-exits-zero"));
    expect(cliExitPins.length).toBe(1);
    expect(cliExitPins[0]).toMatch(/newly-added/);
    expect(cliExitPins[0]).not.toMatch(/existing-cmd/);
  });

  it("FALSIFIABILITY: a refactor commit (no new program.command lines) adds ZERO new safe auto-pins", async () => {
    const cwd = makeTempRepo();
    setupRepo(cwd);

    // Modify cli.ts ONLY by editing an existing command's description
    // (no new program.command() lines).
    writeFileSync(
      join(cwd, "src", "cli.ts"),
      [
        `import { Command } from "commander";`,
        `const program = new Command();`,
        ``,
        `program`,
        `  .command("existing-cmd")`,
        `  .description("an existing command (revised wording)")`,
        `  .action(() => { /* no-op refactor */ });`,
        ``,
        `program.parse();`,
      ].join("\n")
    );
    execFileSync("git", ["add", "-A"], { cwd });
    execFileSync("git", ["commit", "-q", "-m", "refactor existing-cmd"], { cwd });

    const r = await runCli(
      ["auto-protect", "--base", "HEAD~1", "--quiet"],
      { cwd }
    );
    expect(r.exitCode).toBe(0);

    // NEG CONTROL: zero pin files exist — no auto-pinning fired.
    const pinFiles = readdirSync(join(cwd, "tests", "pinned")).filter(
      (f) => f.endsWith(".test.ts")
    );
    expect(pinFiles.length).toBe(0);
  });

  it("FALSIFIABILITY: adding the SAME new command twice doesn't double-pin", async () => {
    const cwd = makeTempRepo();
    setupRepo(cwd);

    writeFileSync(
      join(cwd, "src", "cli.ts"),
      [
        `import { Command } from "commander";`,
        `const program = new Command();`,
        ``,
        `program.command("once-added").description("x").action(() => {});`,
        ``,
        `program.parse();`,
      ].join("\n")
    );
    execFileSync("git", ["add", "-A"], { cwd });
    execFileSync("git", ["commit", "-q", "-m", "add once-added"], { cwd });

    // First auto-protect: adds the pin.
    await runCli(["auto-protect", "--base", "HEAD~1", "--quiet"], { cwd });
    const after1 = readdirSync(join(cwd, "tests", "pinned")).filter((f) =>
      f.endsWith(".test.ts")
    ).length;
    expect(after1).toBe(1);

    // Second auto-protect on the same diff: should add nothing (already pinned).
    await runCli(["auto-protect", "--base", "HEAD~1", "--quiet"], { cwd });
    const after2 = readdirSync(join(cwd, "tests", "pinned")).filter((f) =>
      f.endsWith(".test.ts")
    ).length;
    expect(after2).toBe(1); // no double-pin
  });
});
