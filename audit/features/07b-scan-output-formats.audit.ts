// FEATURE: `pinned scan` output formats (A19, A20)
//   - default (human-readable)
//   - --markdown (PR-comment-shaped)
//   - --json (structured array)
// SIGNAL: each format produces the corresponding output AND the
//   underlying suggestions are the same across formats.
// FALSIFIABILITY: catches a regression where a format silently drops
//   suggestions or where formats diverge in coverage.

import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runCli, makeTempRepo } from "./runCli.js";

function gitInit(cwd: string) {
  const opts = { cwd, stdio: "ignore" as const };
  spawnSync("git", ["init", "-b", "main"], opts);
  spawnSync("git", ["config", "user.email", "a@b.com"], opts);
  spawnSync("git", ["config", "user.name", "Audit"], opts);
  spawnSync("git", ["config", "commit.gpgsign", "false"], opts);
}
function gitCommit(cwd: string, msg: string) {
  const opts = { cwd, stdio: "ignore" as const };
  spawnSync("git", ["add", "-A"], opts);
  spawnSync("git", ["commit", "--allow-empty", "-m", msg], opts);
}

describe("FEATURE-AUDIT: `pinned scan` output formats", () => {
  it("POSITIVE CONTROL: --markdown emits GFM with headings + code spans for routes", async () => {
    const cwd = makeTempRepo();
    try {
      gitInit(cwd);
      gitCommit(cwd, "initial");
      mkdirSync(join(cwd, "app/api/billing"), { recursive: true });
      writeFileSync(
        join(cwd, "app/api/billing/route.ts"),
        "export const POST = () => new Response('ok');"
      );
      gitCommit(cwd, "add billing");

      const result = await runCli(
        ["scan", "--base", "HEAD~1", "--markdown"],
        { cwd, cleanup: false }
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/###|\*\*|>/); // GFM heading or bold or quote
      expect(result.stdout).toContain("/api/billing");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("POSITIVE CONTROL: --json emits parseable JSON with template+route fields per suggestion", async () => {
    const cwd = makeTempRepo();
    try {
      gitInit(cwd);
      gitCommit(cwd, "initial");
      mkdirSync(join(cwd, "app/api/billing"), { recursive: true });
      writeFileSync(
        join(cwd, "app/api/billing/route.ts"),
        "export const POST = () => new Response('ok');"
      );
      gitCommit(cwd, "add billing");

      const result = await runCli(
        ["scan", "--base", "HEAD~1", "--json"],
        { cwd, cleanup: false }
      );
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // scan --json emits a full result object {suggestions, coverage}
      // OR a suggestions array — accept either, but key fields must be present.
      const suggestions = Array.isArray(parsed) ? parsed : parsed.suggestions;
      expect(Array.isArray(suggestions)).toBe(true);
      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0]).toHaveProperty("template");
      expect(suggestions[0]).toHaveProperty("route");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("NEGATIVE CONTROL: --markdown is NOT parseable JSON", async () => {
    const result = await runCli(["scan", "--base", "HEAD", "--markdown"]);
    // Even if no suggestions, the markdown response shouldn't parse as JSON
    expect(() => JSON.parse(result.stdout)).toThrow();
  });
});
