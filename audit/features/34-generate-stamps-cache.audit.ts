// FEATURE: `pinned generate` (and `pinned protect`) must update
//   .last-status.json so the statusline reflects the new pin count
//   immediately, with a fresh `updatedAt` + `recentlyAddedAt` stamp.
// SIGNAL:
//   After `pinned generate --description "..."` writes N pin files:
//   - .last-status.json exists
//   - lastStatus.totalPins matches the new active count
//   - lastStatus.recentlyAddedCount === N
//   - lastStatus.recentlyAddedAt is within the last few seconds
//   - lastStatus.updatedAt is within the last few seconds
// FALSIFIABILITY:
//   Regression guard: a previous build wrote pin files but left the
//   cache stale, so the statusline showed "✓ 10h" right after adding
//   pins. This audit fails if generate ever stops stamping the cache.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runCli, makeTempRepo } from "./runCli.js";

function setupGitRepo(cwd: string): void {
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.email", "audit@pinnedai.dev"], { cwd });
  execFileSync("git", ["config", "user.name", "audit"], { cwd });
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd });
}

describe("FEATURE-AUDIT: `pinned generate` stamps .last-status.json", () => {
  it("POSITIVE CONTROL: cache has fresh updatedAt + recentlyAddedAt right after generate", async () => {
    const cwd = makeTempRepo();
    setupGitRepo(cwd);

    // Use a tightly-scoped claim that's guaranteed to parse.
    const description =
      "Auth required on /api/admin/export. POST /api/signup returns 400 on missing email.";
    const tBefore = Date.now();
    const r = await runCli(
      ["generate", "--pr-id", "audit-stamp", "--description", description, "--quiet"],
      { cwd }
    );
    expect(r.exitCode).toBe(0);
    const tAfter = Date.now();

    const cachePath = join(cwd, "tests", "pinned", ".last-status.json");
    expect(existsSync(cachePath)).toBe(true);

    const cache = JSON.parse(readFileSync(cachePath, "utf8"));
    expect(cache.recentlyAddedCount).toBeGreaterThan(0);
    expect(cache.totalPins).toBe(cache.recentlyAddedCount);

    const recentlyAddedAt = new Date(cache.recentlyAddedAt).getTime();
    expect(recentlyAddedAt).toBeGreaterThanOrEqual(tBefore - 1000);
    expect(recentlyAddedAt).toBeLessThanOrEqual(tAfter + 1000);

    const updatedAt = new Date(cache.updatedAt).getTime();
    expect(updatedAt).toBeGreaterThanOrEqual(tBefore - 1000);
    expect(updatedAt).toBeLessThanOrEqual(tAfter + 1000);
  });

  it("FALSIFIABILITY: --dry-run does NOT stamp the cache (no files written, no cache write)", async () => {
    const cwd = makeTempRepo();
    setupGitRepo(cwd);
    const r = await runCli(
      [
        "generate",
        "--pr-id",
        "audit-dryrun",
        "--description",
        "Auth required on /api/x.",
        "--dry-run",
        "--quiet",
      ],
      { cwd }
    );
    expect(r.exitCode).toBe(0);
    // Cache file should NOT exist (no real writes happened).
    const cachePath = join(cwd, "tests", "pinned", ".last-status.json");
    expect(existsSync(cachePath)).toBe(false);
  });
});
