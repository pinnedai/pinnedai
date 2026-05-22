// FEATURE: scan-diff coverage suppression
// SIGNAL: when the PR description already makes a claim about a
//   risk surface introduced in the diff, scan-diff does NOT suggest
//   pinning that same surface. The claim is "covered."
// FALSIFIABILITY: catches a regression where the coverage check
//   stops cross-referencing prBodyClaims OR stops comparing on the
//   right template+route key, causing duplicate suggestions for
//   already-claimed routes.

import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runCli, makeTempRepo } from "../features/runCli.js";

function gitInit(cwd: string) {
  const opts = { cwd, stdio: "ignore" as const };
  spawnSync("git", ["init", "-b", "main"], opts);
  spawnSync("git", ["config", "user.email", "audit@example.com"], opts);
  spawnSync("git", ["config", "user.name", "Audit"], opts);
  spawnSync("git", ["config", "commit.gpgsign", "false"], opts);
}
function gitCommitAll(cwd: string, msg: string) {
  const opts = { cwd, stdio: "ignore" as const };
  spawnSync("git", ["add", "-A"], opts);
  spawnSync("git", ["commit", "--allow-empty", "-m", msg], opts);
}

describe("FEATURE-AUDIT: scan-diff coverage suppression", () => {
  it("POSITIVE CONTROL: introducing a route + claiming auth in description → suggestion is SUPPRESSED ('No risk surfaces' shown)", async () => {
    const cwd = makeTempRepo();
    try {
      gitInit(cwd);
      gitCommitAll(cwd, "initial");
      mkdirSync(join(cwd, "app/api/protected"), { recursive: true });
      writeFileSync(
        join(cwd, "app/api/protected/route.ts"),
        "export const GET = () => new Response('ok');"
      );
      gitCommitAll(cwd, "add route");

      const result = await runCli(
        [
          "scan-diff",
          "--base",
          "HEAD~1",
          "--description",
          "Auth required on /api/protected.",
        ],
        { cwd, cleanup: false }
      );
      expect(result.exitCode).toBe(0);
      // Signal: with the claim in the description, scan-diff suppresses
      // the warning. Output reads as "everything's protected" — positive
      // marker (✓) and the word "protected", without the dev-jargon
      // phrase "risk surfaces".
      expect(result.stdout).toMatch(/✓/);
      expect(result.stdout).toContain("protected");
      expect(result.stdout).not.toContain("risk surfaces");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("POSITIVE CONTROL: existing pin in registry → coverage section names the file", async () => {
    const cwd = makeTempRepo();
    try {
      gitInit(cwd);
      gitCommitAll(cwd, "initial");
      await runCli(["init"], { cwd, cleanup: false });
      // Pre-pin /api/protected via the registry
      await runCli(
        [
          "generate",
          "--pr-id",
          "pr-prior",
          "--description",
          "Auth required on /api/protected.",
        ],
        { cwd, cleanup: false }
      );
      gitCommitAll(cwd, "init + pin");
      // Now introduce the actual route file
      mkdirSync(join(cwd, "app/api/protected"), { recursive: true });
      writeFileSync(
        join(cwd, "app/api/protected/route.ts"),
        "export const GET = () => new Response('ok');"
      );
      gitCommitAll(cwd, "add route");

      const result = await runCli(["scan-diff", "--base", "HEAD~1"], {
        cwd,
        cleanup: false,
      });
      expect(result.exitCode).toBe(0);
      // Signal: coverage section appears, naming the file
      expect(result.stdout.toLowerCase()).toMatch(/guarded by existing pins/);
      expect(result.stdout).toContain("app/api/protected/route.ts");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("NEGATIVE CONTROL: same diff WITHOUT the claim → scan-diff DOES suggest a pin for the new route", async () => {
    const cwd = makeTempRepo();
    try {
      gitInit(cwd);
      gitCommitAll(cwd, "initial");
      mkdirSync(join(cwd, "app/api/unprotected"), { recursive: true });
      writeFileSync(
        join(cwd, "app/api/unprotected/route.ts"),
        "export const GET = () => new Response('ok');"
      );
      gitCommitAll(cwd, "add route");

      const result = await runCli(
        ["scan-diff", "--base", "HEAD~1"], // no --description
        { cwd, cleanup: false }
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("/api/unprotected");
      // Should produce a suggested pin in natural-language shape
      expect(result.stdout.toLowerCase()).toMatch(
        /auth required|rate-limit|idempotent/
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
