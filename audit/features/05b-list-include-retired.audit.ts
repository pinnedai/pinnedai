// FEATURE: `pinned list --include-retired` (A23)
// SIGNAL: With --include-retired, stdout has BOTH a "Pinned claims (N):"
//   section AND a "Retired (M):" section. Without the flag, only the
//   active section appears.
// FALSIFIABILITY: catches a regression where --include-retired stops
//   surfacing retired claims, or where the active/retired counts
//   accidentally merge.

import { describe, it, expect } from "vitest";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runCli, makeTempRepo } from "./runCli.js";

describe("FEATURE-AUDIT: `pinned list --include-retired` surfaces retired claims", () => {
  it("POSITIVE CONTROL: after one retire, --include-retired shows both sections", async () => {
    const cwd = makeTempRepo();
    try {
      await runCli(["init"], { cwd, cleanup: false });
      // Create two pins
      await runCli(
        [
          "generate",
          "--pr-id",
          "p1",
          "--description",
          "Auth required on /api/a. Auth required on /api/b.",
        ],
        { cwd, cleanup: false }
      );
      const files = readdirSync(join(cwd, "tests/pinned")).filter((n) =>
        n.endsWith(".test.ts")
      );
      const toRetire = files[0].replace(/\.test\.ts$/, "");
      await runCli(
        ["retire", toRetire, "--reason=audit-retire"],
        { cwd, cleanup: false }
      );

      const result = await runCli(
        ["list", "--include-retired"],
        { cwd, cleanup: false }
      );
      expect(result.exitCode).toBe(0);
      // Header may be "Pinned claims (1)" or the v0.2+ rename
      // "Protected behaviors (1)". Both express the same signal.
      expect(result.stdout).toMatch(/(?:Pinned claims|Protected behaviors) \(1\)/);
      expect(result.stdout).toContain("Retired (1)");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("NEGATIVE CONTROL: without --include-retired, retired claims do NOT appear", async () => {
    const cwd = makeTempRepo();
    try {
      await runCli(["init"], { cwd, cleanup: false });
      await runCli(
        [
          "generate",
          "--pr-id",
          "p1",
          "--description",
          "Auth required on /api/a.",
        ],
        { cwd, cleanup: false }
      );
      const files = readdirSync(join(cwd, "tests/pinned")).filter((n) =>
        n.endsWith(".test.ts")
      );
      const toRetire = files[0].replace(/\.test\.ts$/, "");
      await runCli(
        ["retire", toRetire, "--reason=audit-retire"],
        { cwd, cleanup: false }
      );

      const result = await runCli(["list"], { cwd, cleanup: false });
      expect(result.exitCode).toBe(0);
      // No active pins left + no retired section either
      expect(result.stdout).not.toContain("Retired");
      // Empty-active-registry message — accept old ("No pinned tests
      // found"), new ("No pinned claims found"), and the v0.2+ variant
      // that distinguishes empty-vs-all-retired ("No active pinned
      // claims found in ...").
      expect(result.stdout).toMatch(/No (?:active )?pinned (?:tests|claims) found/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
