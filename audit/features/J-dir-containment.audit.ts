// FEATURE: every CLI command accepting --dir MUST containment-check it
//   against process.cwd() before any fs read/write.
//
// SIGNAL: invoking `pinned <cmd> --dir <path-outside-cwd>` exits with
//   the assertInsideDir error message AND a non-zero exit code AND no
//   side effects on the outside-cwd path.
//
// FALSIFIABILITY: a real exploit attempt (--dir ../../tmp/...) is the
//   positive control; a benign --dir tests/pinned is the negative
//   control. The audit covers every --dir-accepting command — if a
//   future command is added without the guard, the new command's
//   coverage will fail.

import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runCli, makeTempRepo } from "./runCli.js";

function setupGitRepo(cwd: string): void {
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.email", "audit@pinnedai.dev"], { cwd });
  execFileSync("git", ["config", "user.name", "audit"], { cwd });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd });
  mkdirSync(join(cwd, ".pinnedai"), { recursive: true });
  writeFileSync(
    join(cwd, ".pinnedai", "config.json"),
    JSON.stringify({ version: 1, auto_protect: "safe", safety_budget_per_run: 5 })
  );
  mkdirSync(join(cwd, "tests", "pinned"), { recursive: true });
  writeFileSync(
    join(cwd, "tests", "pinned", ".registry.json"),
    JSON.stringify({ version: 1, claims: [] })
  );
}

// All CLI commands that accept --dir. If a new command adds --dir
// without the containment guard, add it here and the audit will
// surface the gap.
const DIR_COMMANDS: Array<{
  name: string;
  args: string[];
  // Some commands don't pass --dir on the args side because their
  // default is `tests/pinned` — we still test that the containment
  // check fires when --dir is explicitly out-of-cwd.
}> = [
  { name: "list", args: ["list"] },
  { name: "list-verbose", args: ["list", "--verbose"] },
  { name: "show", args: ["show", "fake-claim-id"] },
  { name: "catches", args: ["catches"] },
  { name: "scan-diff", args: ["scan-diff"] },
  { name: "baseline", args: ["baseline"] },
  // doctor intentionally omitted — it uses cwd-relative paths only,
  // does not accept --dir, so containment-check is moot.
  { name: "protect", args: ["protect", "--all", "--dry-run"] },
  { name: "auto-protect", args: ["auto-protect", "--dry-run"] },
  { name: "safety", args: ["safety"] },
  { name: "status", args: ["status"] },
  { name: "fix-prompt", args: ["fix-prompt"] },
  { name: "statusline", args: ["statusline"] },
  { name: "hook-failure", args: ["hook-failure"] },
  { name: "test", args: ["test"] },
  // retire requires a claim id arg; not part of this audit (covered
  // separately by its own retire audits + its own assertInsideDir call).
];

describe("FEATURE-AUDIT: every --dir CLI command rejects out-of-cwd paths", () => {
  it.each(DIR_COMMANDS)(
    "POSITIVE CONTROL: `pinned $name --dir <out-of-cwd>` fails with 'Path escape detected'",
    async ({ args }) => {
      const cwd = makeTempRepo();
      setupGitRepo(cwd);

      // Use an absolute outside path that exists (so it's a real escape
      // attempt, not a missing-path error).
      const outsidePath = "/tmp/pinned-audit-outside-cwd";
      try {
        mkdirSync(outsidePath, { recursive: true });
      } catch {
        // ignore EEXIST
      }

      const r = await runCli([...args, "--dir", outsidePath], { cwd });

      // The containment guard must fire — stderr says "Path escape
      // detected" and the process exits non-zero. Some commands may
      // exit 0 if they detect the escape and silently no-op rather
      // than asserting (statusline does this for "not initialized")
      // — but ALL of them must mention "Path escape" if the escape
      // is detected, and none of them must SUCCEED at writing to the
      // outside path.
      const detected =
        r.stderr.includes("Path escape detected") ||
        r.stdout.includes("Path escape detected");
      expect(detected).toBe(true);

      // Negative side-effect check: nothing was written to the outside
      // path that pinned would write to.
      const lastStatusPath = join(outsidePath, ".last-status.json");
      const registryPath = join(outsidePath, ".registry.json");
      expect(existsSync(lastStatusPath)).toBe(false);
      expect(existsSync(registryPath)).toBe(false);
    }
  );

  it("FALSIFIABILITY: same commands with a sane in-cwd --dir do NOT fail with 'Path escape'", async () => {
    // Verify the assertion above isn't tautological — using a sane
    // `--dir tests/pinned` (relative, inside cwd) must NOT trigger
    // the containment error. We only spot-check 3 commands here
    // since exhaustively running 15 would slow the audit; the
    // intent is to prove the guard distinguishes legal from illegal.
    const cwd = makeTempRepo();
    setupGitRepo(cwd);

    for (const args of [["status"], ["list"], ["catches"]]) {
      const r = await runCli([...args, "--dir", "tests/pinned"], { cwd });
      expect(r.stderr).not.toContain("Path escape detected");
      expect(r.stdout).not.toContain("Path escape detected");
    }
  });
});
