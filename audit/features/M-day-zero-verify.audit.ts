// FEATURE: `pinned generate` runs each newly-written pin against the
//   customer's CURRENT code immediately, surfacing PRs where the
//   claim doesn't hold against reality ("day-zero catch") BEFORE the
//   pin joins the test suite. False-positive protection: double-
//   confirm (re-run failing files after 500ms gap) + per-template
//   preflight skip (no PREVIEW_URL → skip silently, not catch).
// SIGNAL (observable when feature is healthy):
//   1. With PREVIEW_URL unset (the common solo-dev case), web-template
//      pins are SKIPPED with a clear "no PREVIEW_URL set" reason. They
//      are NOT reported as catches. (FP mitigation contract.)
//   2. With --no-verify, the verification step is bypassed entirely —
//      no "Verifying pins..." line appears, no skipped-pin summary.
//   3. When vitest is not installed in the repo, all pins are SKIPPED
//      with a clear "vitest not installed" reason — never reported
//      as catches. (FP mitigation contract.)
//   4. library-returns claim against a modulePath that DOES NOT EXIST
//      yet is SKIPPED with "module file ... doesn't exist yet" — not
//      reported as a catch. (Catches scaffold-PR scenario where the
//      module is added in a later commit.)
// FALSIFIABILITY: catches regressions where verification runs without
//   preflight (would false-fail every pin on a no-preview machine),
//   where --no-verify is silently ignored (would slow generate), or
//   where missing vitest is treated as a catch (would alarm users
//   who don't run vitest in their repo).

import { describe, it, expect } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runCli, makeTempRepo } from "./runCli.js";

function gitInit(cwd: string) {
  const opts = { cwd, stdio: "ignore" as const };
  spawnSync("git", ["init", "-b", "main"], opts);
  spawnSync("git", ["config", "user.email", "audit@example.com"], opts);
  spawnSync("git", ["config", "user.name", "Audit"], opts);
  spawnSync("git", ["config", "commit.gpgsign", "false"], opts);
}

describe("FEATURE-AUDIT: day-zero verify never false-fails on no-preview machines", () => {
  it("POSITIVE CONTROL: web-template pin without PREVIEW_URL → SKIPPED, not caught", async () => {
    const cwd = makeTempRepo();
    try {
      gitInit(cwd);
      await runCli(["init", "--force"], { cwd, cleanup: false });
      // Generate without PREVIEW_URL (the common solo-dev case).
      // Use an env override that strips PREVIEW_URL if it happens to
      // be set in the parent shell.
      const result = await runCli(
        [
          "generate",
          "--pr-id",
          "pr-1",
          "--description",
          "Auth required on /api/admin/export.",
        ],
        {
          cwd,
          cleanup: false,
          env: {
            // Explicitly unset PREVIEW_URL even if shell has it
            PREVIEW_URL: "",
          },
        }
      );
      expect(result.exitCode).toBe(0);
      // The user MUST see a clear skip reason — silence here would
      // make it look like the pin was verified when it wasn't.
      // Either "no PREVIEW_URL" (if vitest IS installed) OR
      // "vitest not installed" (if it isn't) — both are valid
      // skip outcomes; never a catch.
      const hasSkipReason =
        result.stdout.includes("no PREVIEW_URL") ||
        result.stdout.includes("vitest not installed");
      expect(hasSkipReason).toBe(true);
      // FP contract: must NOT be reported as a day-zero catch.
      expect(result.stdout).not.toContain("Day-zero catch");
      expect(result.stdout).not.toContain("don't hold against your current code");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("POSITIVE CONTROL: --no-verify bypasses verification entirely (fast-path)", async () => {
    const cwd = makeTempRepo();
    try {
      gitInit(cwd);
      await runCli(["init", "--force"], { cwd, cleanup: false });
      const result = await runCli(
        [
          "generate",
          "--pr-id",
          "pr-1",
          "--description",
          "Auth required on /api/admin/export.",
          "--no-verify",
        ],
        { cwd, cleanup: false }
      );
      expect(result.exitCode).toBe(0);
      // --no-verify should suppress the verification UI entirely —
      // CI pipelines and `pinned init` scaffolding flows want fast
      // generate without any vitest spin-up cost.
      expect(result.stdout).not.toContain("Verifying pins");
      expect(result.stdout).not.toContain("verified against");
      expect(result.stdout).not.toContain("Day-zero catch");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("POSITIVE CONTROL: library-returns claim with missing modulePath → SKIPPED with file-not-found reason", async () => {
    const cwd = makeTempRepo();
    try {
      gitInit(cwd);
      await runCli(["init", "--force"], { cwd, cleanup: false });
      // No src/config.ts exists in this tempdir. Day-zero verify
      // should recognize that and skip — not report a catch. Parser
      // shape: `func()` in `module` returns `value` (must be backtick-
      // quoted in that exact order — see claimParser.ts LIBRARY_RETURNS).
      const result = await runCli(
        [
          "generate",
          "--pr-id",
          "pr-1",
          "--description",
          '`parseConfig()` in `src/config.ts` returns `{"version": 1}`.',
        ],
        { cwd, cleanup: false }
      );
      expect(result.exitCode).toBe(0);
      // Either vitest-not-installed OR module-doesn't-exist-yet is
      // valid; never a catch.
      const hasSkipReason =
        result.stdout.includes("doesn't exist yet") ||
        result.stdout.includes("vitest not installed");
      expect(hasSkipReason).toBe(true);
      expect(result.stdout).not.toContain("Day-zero catch");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("FALSIFIABILITY: default generate (no --no-verify) DOES emit the 'Verifying pins' UI line", async () => {
    // This is the inverse falsifiability check for the --no-verify
    // test above: if --no-verify silently became the default (or
    // verification was removed entirely), the audit above would still
    // pass. So we also assert that the default IS to verify, by
    // detecting the verification line in stdout.
    const cwd = makeTempRepo();
    try {
      gitInit(cwd);
      await runCli(["init", "--force"], { cwd, cleanup: false });
      const result = await runCli(
        [
          "generate",
          "--pr-id",
          "pr-1",
          "--description",
          "Auth required on /api/admin/export.",
        ],
        { cwd, cleanup: false }
      );
      expect(result.exitCode).toBe(0);
      // Day-zero verify MUST be on by default. If this assertion
      // fails, someone disabled verification or made it opt-in.
      expect(result.stdout).toContain("Verifying pins");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
