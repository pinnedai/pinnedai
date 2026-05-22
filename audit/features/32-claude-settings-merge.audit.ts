// FEATURE: `pinned init` preserves user's existing `.claude/settings.json`
// SIGNAL: After init --auto on a repo that already has .claude/settings.json:
//   - the file at .claude/settings.json is parseable JSON
//   - all pre-existing top-level keys are present byte-identical
//   - all pre-existing nested keys (under hooks.*, permissions, etc.)
//     are preserved
//   - statusLine.command is now the Pinned statusline command
//   - hooks.UserPromptSubmit contains BOTH the user's pre-existing
//     hook AND the new pinnedai hook-failure entry
//   - a backup file at .claude/settings.json.bak exists with the
//     original pre-install content byte-identical
// FALSIFIABILITY:
//   - POS: pre-populate a settings.json with model, theme, permissions,
//     hooks.PostToolUse + hooks.UserPromptSubmit. Run init --auto.
//     Every original key must survive AND .bak must match the original.
//   - NEG: if statusLine.command is already user-set (not pinned),
//     install must return "conflict" (no overwrite, no .bak corruption).
//   - POS-EMPTY: if no settings.json exists pre-install, no .bak is
//     created (nothing to back up).

import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runCli, makeTempRepo } from "./runCli.js";

const USER_SETTINGS = {
  model: "claude-opus-4-7",
  theme: "dark",
  permissions: {
    allow: ["Bash(npm install:*)", "Edit", "Read"],
    deny: ["Bash(rm -rf:*)"],
  },
  env: {
    MY_CUSTOM_VAR: "value-the-user-set",
  },
  hooks: {
    PostToolUse: [
      { matcher: "Edit", command: "echo 'user post-edit hook'" },
    ],
    UserPromptSubmit: [
      { matcher: "*", command: "echo 'user prompt hook'" },
    ],
  },
};

describe("FEATURE-AUDIT: .claude/settings.json deep-merge + backup", () => {
  it("POSITIVE: preserves all user keys + adds pinned statusline + appends pinned UserPromptSubmit hook", async () => {
    const cwd = makeTempRepo();

    // Pre-populate the user's settings.json with arbitrary keys.
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    const settingsPath = join(cwd, ".claude", "settings.json");
    const originalText = JSON.stringify(USER_SETTINGS, null, 2);
    writeFileSync(settingsPath, originalText);

    const r = await runCli(["init", "--auto", "--quiet"], { cwd });
    expect(r.exitCode).toBe(0);

    expect(existsSync(settingsPath)).toBe(true);
    const merged = JSON.parse(readFileSync(settingsPath, "utf8"));

    // 1. All user top-level keys survived
    expect(merged.model).toBe("claude-opus-4-7");
    expect(merged.theme).toBe("dark");
    expect(merged.permissions.allow).toEqual([
      "Bash(npm install:*)",
      "Edit",
      "Read",
    ]);
    expect(merged.permissions.deny).toEqual(["Bash(rm -rf:*)"]);
    expect(merged.env.MY_CUSTOM_VAR).toBe("value-the-user-set");

    // 2. User's PostToolUse hook is untouched
    expect(merged.hooks.PostToolUse).toEqual([
      { matcher: "Edit", command: "echo 'user post-edit hook'" },
    ]);

    // 3. UserPromptSubmit has BOTH user's hook AND pinned's hook
    const userPromptHooks = merged.hooks.UserPromptSubmit as Array<{
      matcher: string;
      command: string;
    }>;
    expect(userPromptHooks.length).toBe(2);
    expect(userPromptHooks.some((h) => h.command === "echo 'user prompt hook'")).toBe(true);
    expect(userPromptHooks.some((h) => h.command.includes("hook-failure"))).toBe(true);

    // 4. statusLine was set (was absent before)
    expect(merged.statusLine?.command).toMatch(/pinned.*statusline|statusline/);

    // 5. Backup file exists with the ORIGINAL pre-install content byte-identical
    const backupPath = settingsPath + ".bak";
    expect(existsSync(backupPath)).toBe(true);
    expect(readFileSync(backupPath, "utf8")).toBe(originalText);
  });

  it("NEGATIVE: no .bak file written when settings.json did not exist pre-install", async () => {
    const cwd = makeTempRepo();
    // NB: no .claude/settings.json pre-existing.

    const r = await runCli(["init", "--auto", "--quiet"], { cwd });
    expect(r.exitCode).toBe(0);

    const settingsPath = join(cwd, ".claude", "settings.json");
    const backupPath = settingsPath + ".bak";
    expect(existsSync(settingsPath)).toBe(true);
    // No prior file = nothing to back up. .bak should NOT appear.
    expect(existsSync(backupPath)).toBe(false);
  });

  it("POSITIVE (forward-back): running `init --auto` a SECOND time preserves the original .bak — never overwrites it with post-Pinned state", async () => {
    const cwd = makeTempRepo();

    mkdirSync(join(cwd, ".claude"), { recursive: true });
    const settingsPath = join(cwd, ".claude", "settings.json");
    const originalText = JSON.stringify(USER_SETTINGS, null, 2);
    writeFileSync(settingsPath, originalText);

    // First install — captures the user's true original into .bak.
    const r1 = await runCli(["init", "--auto", "--quiet"], { cwd });
    expect(r1.exitCode).toBe(0);

    const backupPath = settingsPath + ".bak";
    expect(existsSync(backupPath)).toBe(true);
    expect(readFileSync(backupPath, "utf8")).toBe(originalText);

    // Second install — settings.json is now the post-Pinned merged state.
    // The .bak MUST still be the user's original, NOT the merged state.
    // This is the regression guard for the "second install clobbers .bak"
    // bug fixed via `filesTouchedThisProcess` + `!existsSync(.bak)` guard.
    const r2 = await runCli(["init", "--auto", "--quiet"], { cwd });
    expect(r2.exitCode).toBe(0);

    expect(readFileSync(backupPath, "utf8")).toBe(originalText);
  });

  it("NEGATIVE: refuses to overwrite a user-set statusLine.command (no silent stomping)", async () => {
    const cwd = makeTempRepo();

    mkdirSync(join(cwd, ".claude"), { recursive: true });
    const settingsPath = join(cwd, ".claude", "settings.json");
    const conflicting = {
      statusLine: { command: "echo 'user has their own statusline'" },
    };
    writeFileSync(settingsPath, JSON.stringify(conflicting, null, 2));

    const r = await runCli(["init", "--auto", "--quiet"], { cwd });
    // init still succeeds overall (hook install can still happen), but
    // the statusLine command must NOT have been overwritten.
    expect(r.exitCode).toBe(0);

    const after = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(after.statusLine.command).toBe("echo 'user has their own statusline'");
  });
});
