// FEATURE: `pinned init --auto` installs everything in one shot
// SIGNAL: After init --auto, the following exist:
//   - .pinnedai/config.json with auto_protect: "safe"
//   - .git/hooks/pre-commit with the pinnedai:pre-commit marker
//   - .git/hooks/pre-push with the pinnedai:pre-push marker
//   - .claude/settings.json with pinned statusline + failure hook
//   - CLAUDE.md with the pinnedai marker block
//   - tests/pinned/{README.md, AGENT.md, .registry.json, PINS.md}
// FALSIFIABILITY:
//   - POS: every file above exists and contains the expected marker.
//   - NEG: init --manual (with stdin closed) installs none of the
//     git hooks / Claude settings.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runCli, makeTempRepo } from "./runCli.js";

function setupGitRepo(cwd: string): void {
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.email", "audit@pinnedai.dev"], { cwd });
  execFileSync("git", ["config", "user.name", "audit"], { cwd });
}

describe("FEATURE-AUDIT: `pinned init --auto` installs everything", () => {
  it("POSITIVE CONTROL: all 6 install targets land after a single --auto invocation", async () => {
    const cwd = makeTempRepo();
    setupGitRepo(cwd);

    const r = await runCli(["init", "--auto", "--quiet"], { cwd });
    expect(r.exitCode).toBe(0);

    // 1. Config file with safe mode
    const cfgPath = join(cwd, ".pinnedai", "config.json");
    expect(existsSync(cfgPath)).toBe(true);
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    expect(cfg.auto_protect).toBe("safe");

    // 2. Pre-commit hook (with marker + executable)
    const preCommit = join(cwd, ".git", "hooks", "pre-commit");
    expect(existsSync(preCommit)).toBe(true);
    expect(readFileSync(preCommit, "utf8")).toContain("# pinnedai:pre-commit");
    expect(statSync(preCommit).mode & 0o111).not.toBe(0); // executable

    // 3. Pre-push hook
    const prePush = join(cwd, ".git", "hooks", "pre-push");
    expect(existsSync(prePush)).toBe(true);
    expect(readFileSync(prePush, "utf8")).toContain("# pinnedai:pre-push");

    // 4. Claude settings (statusline + failure hook)
    const claudePath = join(cwd, ".claude", "settings.json");
    expect(existsSync(claudePath)).toBe(true);
    const settings = JSON.parse(readFileSync(claudePath, "utf8"));
    expect(settings.statusLine?.command).toMatch(/statusline/);
    expect(
      settings.hooks?.UserPromptSubmit?.some((h: { command?: string }) =>
        h.command?.includes("hook-failure")
      )
    ).toBe(true);

    // 5. CLAUDE.md with marker block
    const claudeMd = join(cwd, "CLAUDE.md");
    expect(existsSync(claudeMd)).toBe(true);
    const claudeMdContent = readFileSync(claudeMd, "utf8");
    expect(claudeMdContent).toContain("<!-- pinnedai:start -->");
    expect(claudeMdContent).toContain("<!-- pinnedai:end -->");

    // 6. tests/pinned scaffold
    expect(existsSync(join(cwd, "tests", "pinned", "AGENT.md"))).toBe(true);
    expect(existsSync(join(cwd, "tests", "pinned", "PINS.md"))).toBe(true);
    expect(existsSync(join(cwd, "tests", "pinned", ".registry.json"))).toBe(true);
  });

  it("FALSIFIABILITY: --manual (non-TTY) installs NEITHER pre-commit hook NOR Claude statusline", async () => {
    const cwd = makeTempRepo();
    setupGitRepo(cwd);

    const r = await runCli(["init", "--manual", "--no-claude-rules", "--quiet"], { cwd });
    expect(r.exitCode).toBe(0);

    // NEG: hooks NOT installed in manual + non-TTY (no prompt opportunity).
    expect(existsSync(join(cwd, ".git", "hooks", "pre-commit"))).toBe(false);
    expect(existsSync(join(cwd, ".git", "hooks", "pre-push"))).toBe(false);
    // NEG: Claude settings NOT installed.
    expect(existsSync(join(cwd, ".claude", "settings.json"))).toBe(false);
    // POS: but the config still gets written (with default mode).
    expect(existsSync(join(cwd, ".pinnedai", "config.json"))).toBe(true);
  });
});

describe("FEATURE-AUDIT: pre-commit hook is idempotent", () => {
  it("POSITIVE CONTROL: running init --auto twice doesn't duplicate the pre-commit body", async () => {
    const cwd = makeTempRepo();
    setupGitRepo(cwd);
    await runCli(["init", "--auto", "--quiet"], { cwd });
    await runCli(["init", "--auto", "--quiet"], { cwd });
    const hook = readFileSync(join(cwd, ".git", "hooks", "pre-commit"), "utf8");
    // The marker should appear exactly once. If init duplicates the
    // block on re-run, we'd see two `# pinnedai:pre-commit` lines.
    const matches = hook.match(/# pinnedai:pre-commit/g) ?? [];
    expect(matches.length).toBe(1);
  });
});
