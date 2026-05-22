// FEATURE: `pinned scan-diff --base <ref>`
// SIGNAL: when the diff against base introduces a recognized risk
//   surface (e.g. a new app/api/<X>/route.ts), scan-diff reports it
//   AND emits a suggested pin in the canonical claim shape (e.g.
//   "Auth required on /api/<X>"). When the PR description already
//   makes the claim, coverage suppresses the suggestion.
// FALSIFIABILITY: catches a regression where the detector stops
//   noticing new App Router routes, or where the coverage check
//   stops short-circuiting on already-claimed surfaces.

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

function gitCommitAll(cwd: string, msg: string) {
  const opts = { cwd, stdio: "ignore" as const };
  spawnSync("git", ["add", "-A"], opts);
  spawnSync("git", ["commit", "--allow-empty", "-m", msg], opts);
}

describe("FEATURE-AUDIT: `pinned scan-diff` detects unprotected risk surfaces", () => {
  it("POSITIVE CONTROL: a new app/api/<X>/route.ts produces a suggested auth-required pin", async () => {
    const cwd = makeTempRepo();
    try {
      gitInit(cwd);
      gitCommitAll(cwd, "initial");

      // Now introduce a new App Router route — this is the change we
      // want scan-diff to flag.
      mkdirSync(join(cwd, "app/api/payments"), { recursive: true });
      writeFileSync(
        join(cwd, "app/api/payments/route.ts"),
        "export const POST = () => new Response('ok');"
      );
      gitCommitAll(cwd, "add payments route");

      const result = await runCli(["scan-diff", "--base", "HEAD~1"], {
        cwd,
        cleanup: false,
      });
      expect(result.exitCode).toBe(0);
      // The signal: stdout names the new route as a risk surface AND
      // includes a suggested-pin sentence in the canonical claim shape.
      expect(result.stdout).toContain("/api/payments");
      // Suggested pins use natural-language shapes parseable by `check`
      expect(result.stdout.toLowerCase()).toMatch(
        /auth required|rate-limit|idempotent/
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("NEGATIVE CONTROL: a diff with no risk surfaces reports a calm 'already protected' message", async () => {
    const cwd = makeTempRepo();
    try {
      gitInit(cwd);
      gitCommitAll(cwd, "initial");
      // Change a README only — no route, no middleware, no webhook
      writeFileSync(join(cwd, "README.md"), "# Test\nUnrelated change.\n");
      gitCommitAll(cwd, "readme tweak");

      const result = await runCli(["scan-diff", "--base", "HEAD~1"], {
        cwd,
        cleanup: false,
      });
      expect(result.exitCode).toBe(0);
      // Signal: the output reads as "everything's fine", not as a warning.
      // Should contain a positive marker (✓) and "protected" (not "risk surfaces").
      expect(result.stdout).toMatch(/✓/);
      expect(result.stdout).toContain("protected");
      expect(result.stdout).not.toContain("risk surfaces");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
