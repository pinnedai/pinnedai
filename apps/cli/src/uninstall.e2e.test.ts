// E2E test for `pinned uninstall --yes` — drives the bundled CLI as a
// subprocess and asserts the FILESYSTEM AFTER, not the command's
// stdout.
//
// 0.4.4 shipped with `pinned uninstall --yes` as a complete no-op
// that printed ✓ for every step while actually deleting nothing:
//   (1) `require("node:fs")` calls — tsup never emitted the
//       `__require` shim, so every unlink/rmSync threw a
//       ReferenceError that the inner `catch {}` ate silently.
//   (2) PostToolUse hook substring check looked for
//       "pinned hook-postedit" but the installed command is
//       "npx --no-install pinnedai hook-postedit". The substring
//       never matched, so PostToolUse was never planned for removal.
//   (3) UserPromptSubmit / hook-failure had no removal logic at all.
//
// These tests would have failed in 0.4.4. Each asserts on
// existsSync / settings.json contents AFTER the subprocess exits,
// matching the discipline from [[positive-and-negative-tests-required]]
// ("Built + existing vitest pass" is NOT sufficient).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const CLI = join(process.cwd(), "dist/cli.js");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "uninstall-e2e-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function setupFullyInstalled() {
  mkdirSync(join(dir, ".claude"), { recursive: true });
  mkdirSync(join(dir, ".github/workflows"), { recursive: true });
  mkdirSync(join(dir, ".pinnedai"), { recursive: true });
  mkdirSync(join(dir, ".pinned"), { recursive: true });
  mkdirSync(join(dir, "tests/pinned"), { recursive: true });

  // The exact shape `pinned init` installs (verified against
  // claudeSettings.ts and the PostToolUse installer in cli.ts).
  writeFileSync(
    join(dir, ".claude/settings.json"),
    JSON.stringify({
      statusLine: { type: "command", command: "npx pinnedai statusline" },
      hooks: {
        PostToolUse: [
          {
            matcher: "Edit|Write|MultiEdit",
            hooks: [{ type: "command", command: "npx --no-install pinnedai hook-postedit" }],
          },
        ],
        UserPromptSubmit: [
          {
            matcher: "",
            hooks: [{ type: "command", command: "npx pinnedai hook-failure" }],
          },
        ],
      },
    }, null, 2)
  );
  writeFileSync(join(dir, ".github/workflows/pinned.yml"), "name: pinned\n");
  writeFileSync(join(dir, ".pinnedai/config.json"), "{}\n");
  writeFileSync(join(dir, ".pinned/ai-lessons.md"), "lesson 1\n");
  writeFileSync(
    join(dir, "tests/pinned/.registry.json"),
    '{"version":1,"claims":[]}\n'
  );
  writeFileSync(join(dir, "tests/pinned/example.test.ts"), "// pin file\n");
}

function runUninstall(extra: string[] = []): { stdout: string; stderr: string; exit: number } {
  let stdout = "";
  let stderr = "";
  let exit = 0;
  try {
    stdout = execFileSync("node", [CLI, "uninstall", "--yes", "--quiet", ...extra], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 20000,
    });
  } catch (e: any) {
    exit = e.status ?? 1;
    stdout = e.stdout?.toString() ?? "";
    stderr = e.stderr?.toString() ?? "";
  }
  return { stdout, stderr, exit };
}

describe("pinned uninstall --yes — filesystem assertions, not stdout", () => {
  it("removes .github/workflows/pinned.yml from disk", () => {
    setupFullyInstalled();
    runUninstall();
    expect(existsSync(join(dir, ".github/workflows/pinned.yml"))).toBe(false);
  });

  it("removes .pinnedai/ from disk", () => {
    setupFullyInstalled();
    runUninstall();
    expect(existsSync(join(dir, ".pinnedai"))).toBe(false);
  });

  it("removes .pinned/ from disk", () => {
    setupFullyInstalled();
    runUninstall();
    expect(existsSync(join(dir, ".pinned"))).toBe(false);
  });

  it("removes the PostToolUse hook entry from .claude/settings.json (Cipherwake bug 2)", () => {
    setupFullyInstalled();
    runUninstall();
    const s = JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf8"));
    const post = s.hooks?.PostToolUse ?? [];
    const hasPinned = post.some((e: any) =>
      (e.hooks ?? []).some((h: any) =>
        typeof h.command === "string" && h.command.toLowerCase().includes("hook-postedit")
      )
    );
    expect(hasPinned).toBe(false);
  });

  it("removes the UserPromptSubmit hook entry from .claude/settings.json (Cipherwake bug 3)", () => {
    setupFullyInstalled();
    runUninstall();
    const s = JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf8"));
    const ups = s.hooks?.UserPromptSubmit ?? [];
    const hasPinned = ups.some((e: any) =>
      (e.hooks ?? []).some((h: any) =>
        typeof h.command === "string" && h.command.toLowerCase().includes("hook-failure")
      )
    );
    expect(hasPinned).toBe(false);
  });

  it("removes statusLine entry from .claude/settings.json", () => {
    setupFullyInstalled();
    runUninstall();
    const s = JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf8"));
    expect(s.statusLine).toBeUndefined();
  });

  it("preserves tests/pinned/ by default", () => {
    setupFullyInstalled();
    runUninstall();
    expect(existsSync(join(dir, "tests/pinned"))).toBe(true);
    expect(existsSync(join(dir, "tests/pinned/.registry.json"))).toBe(true);
    expect(existsSync(join(dir, "tests/pinned/example.test.ts"))).toBe(true);
  });

  it("removes tests/pinned/ when --tests is passed", () => {
    setupFullyInstalled();
    runUninstall(["--tests"]);
    expect(existsSync(join(dir, "tests/pinned"))).toBe(false);
  });

  it("exits 0 when the install was clean and everything got removed", () => {
    setupFullyInstalled();
    const r = runUninstall();
    expect(r.exit).toBe(0);
  });

  it("emits ✓ lines whose path matches what was actually planned", () => {
    setupFullyInstalled();
    const r = runUninstall();
    // Every ✓ line corresponds to a real removal; we now verify the
    // post-state separately. Just sanity-check that ✓ shows up at all.
    expect(r.stdout).toMatch(/✓ \.github\/workflows\/pinned\.yml/);
    expect(r.stdout).toMatch(/✓ \.pinnedai\//);
    expect(r.stdout).toMatch(/✓ \.pinned\//);
  });
});

describe("pinned uninstall --yes — robustness", () => {
  it("handles a settings.json with only Pinned (file becomes effectively empty)", () => {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude/settings.json"),
      JSON.stringify({
        statusLine: { type: "command", command: "npx pinnedai statusline" },
        hooks: {
          PostToolUse: [
            { matcher: "Edit", hooks: [{ type: "command", command: "npx pinnedai hook-postedit" }] },
          ],
        },
      })
    );
    runUninstall();
    const s = JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf8"));
    expect(s.statusLine).toBeUndefined();
    expect(s.hooks).toBeUndefined();
  });

  it("preserves non-Pinned hook entries (compose-aware)", () => {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude/settings.json"),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            { matcher: "Edit", hooks: [{ type: "command", command: "npx pinnedai hook-postedit" }] },
            { matcher: "Edit", hooks: [{ type: "command", command: "some-other-tool" }] },
          ],
        },
      })
    );
    runUninstall();
    const s = JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf8"));
    const post = s.hooks?.PostToolUse ?? [];
    // Pinned entry gone, the other one stays.
    expect(post.length).toBe(1);
    expect(post[0].hooks[0].command).toBe("some-other-tool");
  });

  it("nothing-installed: clean exit, no error", () => {
    // Empty repo — uninstall should report nothing to remove.
    const r = runUninstall();
    expect(r.exit).toBe(0);
    expect(r.stdout).toMatch(/Pinned doesn't appear to be installed/);
  });
});
