// FEATURE: `pinned ai-rules install` adds pinnedai block to CLAUDE.md
//   / .cursorrules with explicit consent. `uninstall` removes it.
//   Idempotent (running install twice doesn't double-append).
// SIGNAL: target file (CLAUDE.md by default) contains the
//   `<!-- pinnedai:start -->` marker + the 5 rules + `<!-- pinnedai:end -->`
//   marker after install. After uninstall, both markers + content gone.
// FALSIFIABILITY: catches a regression where install stops writing
//   the marked block (Claude won't follow our rules), uninstall fails
//   to remove cleanly (markers leak), or idempotency breaks (block
//   duplicates on re-run).

import { describe, it, expect } from "vitest";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdtempSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "./runCli.js";
import { spawnSync } from "node:child_process";

function makeTempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "pinned-audit-ai-rules-"));
  // git init the tempdir so `pinned init` doesn't fail its non-git
  // preflight check (added in task 153).
  spawnSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  spawnSync("git", ["config", "user.email", "audit@example.com"], {
    cwd: dir,
    stdio: "ignore",
  });
  spawnSync("git", ["config", "user.name", "Audit"], { cwd: dir, stdio: "ignore" });
  spawnSync("git", ["config", "commit.gpgsign", "false"], {
    cwd: dir,
    stdio: "ignore",
  });
  return dir;
}

describe("FEATURE-AUDIT: `pinned ai-rules install` opt-in flow", () => {
  it("POSITIVE CONTROL: install with --yes creates CLAUDE.md with marker block", async () => {
    const cwd = makeTempCwd();
    try {
      const result = await runCli(["ai-rules", "install", "--yes"], {
        cwd,
        cleanup: false,
      });
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(cwd, "CLAUDE.md"))).toBe(true);
      const content = readFileSync(join(cwd, "CLAUDE.md"), "utf8");
      expect(content).toContain("<!-- pinnedai:start -->");
      expect(content).toContain("<!-- pinnedai:end -->");
      expect(content).toContain("## Pinned");
      // All 5 rules from the canonical block
      expect(content).toContain("1. Before marking coding work complete");
      expect(content).toContain("5. If you changed auth");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("POSITIVE CONTROL: install appends to existing .cursorrules without overwriting prior content", async () => {
    const cwd = makeTempCwd();
    try {
      const priorContent = "# My Cursor rules\n\nAlways use TypeScript.\n";
      writeFileSync(join(cwd, ".cursorrules"), priorContent);

      const result = await runCli(
        ["ai-rules", "install", "--yes", "--target", ".cursorrules"],
        { cwd, cleanup: false }
      );
      expect(result.exitCode).toBe(0);
      const content = readFileSync(join(cwd, ".cursorrules"), "utf8");
      // Prior content preserved
      expect(content).toContain("Always use TypeScript.");
      // Pinned block appended
      expect(content).toContain("<!-- pinnedai:start -->");
      expect(content).toContain("<!-- pinnedai:end -->");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("POSITIVE CONTROL: idempotent — second install with --yes is no-op (no duplicate block)", async () => {
    const cwd = makeTempCwd();
    try {
      await runCli(["ai-rules", "install", "--yes"], { cwd, cleanup: false });
      const after1 = readFileSync(join(cwd, "CLAUDE.md"), "utf8");
      await runCli(["ai-rules", "install", "--yes"], { cwd, cleanup: false });
      const after2 = readFileSync(join(cwd, "CLAUDE.md"), "utf8");
      // Same content — second install is no-op
      expect(after2).toBe(after1);
      // Exactly one marker pair
      const startMatches = after2.match(/<!-- pinnedai:start -->/g) ?? [];
      expect(startMatches).toHaveLength(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("POSITIVE CONTROL: uninstall removes the marked block cleanly", async () => {
    const cwd = makeTempCwd();
    try {
      writeFileSync(
        join(cwd, "CLAUDE.md"),
        "# My CLAUDE.md\n\nMy own content.\n"
      );
      await runCli(["ai-rules", "install", "--yes"], { cwd, cleanup: false });
      const withBlock = readFileSync(join(cwd, "CLAUDE.md"), "utf8");
      expect(withBlock).toContain("<!-- pinnedai:start -->");

      await runCli(["ai-rules", "uninstall"], { cwd, cleanup: false });
      const withoutBlock = readFileSync(join(cwd, "CLAUDE.md"), "utf8");
      expect(withoutBlock).not.toContain("<!-- pinnedai:start -->");
      expect(withoutBlock).not.toContain("<!-- pinnedai:end -->");
      expect(withoutBlock).not.toContain("## Pinned");
      // User's original content survived
      expect(withoutBlock).toContain("My own content.");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("NEGATIVE CONTROL: install in non-TTY shell without --yes fails (no silent mutation)", async () => {
    const cwd = makeTempCwd();
    try {
      // runCli's spawn uses stdio: 'ignore' for stdin → no TTY
      const result = await runCli(["ai-rules", "install"], {
        cwd,
        cleanup: false,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("requires --yes");
      expect(existsSync(join(cwd, "CLAUDE.md"))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("FALSIFIABILITY: 'pinned init' creates tests/pinned/AGENT.md as the file we own", async () => {
    const cwd = makeTempCwd();
    try {
      await runCli(["init", "--no-claude-rules"], { cwd, cleanup: false });
      // We own this file. It must exist after init regardless of
      // whether the customer opted into CLAUDE.md updates.
      expect(existsSync(join(cwd, "tests/pinned/AGENT.md"))).toBe(true);
      const content = readFileSync(join(cwd, "tests/pinned/AGENT.md"), "utf8");
      expect(content).toContain("AGENT.md — pinnedai rules for AI coding agents");
      expect(content).toContain("Rules for the AI agent working in this repo");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
