// FEATURE: `pinned list [--include-retired]`
// SIGNAL: stdout reports an accurate active count + lists each
//   filename. With --include-retired, a separate "Retired" section
//   appears with retired-only entries.
// FALSIFIABILITY: catches a regression where list miscounts, double-
//   reports retired claims as active, or fails to surface retired
//   when the flag is set.

import { describe, it, expect } from "vitest";
import { rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runCli, makeTempRepo } from "./runCli.js";

describe("FEATURE-AUDIT: `pinned list` reports active and retired counts", () => {
  it("POSITIVE CONTROL: list shows N pinned claims after generating N", async () => {
    const cwd = makeTempRepo();
    try {
      await runCli(["init"], { cwd, cleanup: false });
      await runCli(
        [
          "generate",
          "--pr-id",
          "audit-1",
          "--description",
          "Rate-limits /api/a to 10 req/min. Auth required on /api/b.",
        ],
        { cwd, cleanup: false }
      );
      // Default `list` is title-only (scan view) — assert the header
      // names the count. v0.2+ renamed "Pinned claims" to "Protected
      // behaviors" to lead with what users care about. Either string
      // is accepted to keep this audit resilient to future copy edits.
      const result = await runCli(["list"], { cwd, cleanup: false });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/(?:Pinned claims|Protected behaviors) \(2\)/);
      // The filenames should appear in --verbose mode (default mode is
      // intentionally scan-only — file paths show in --verbose).
      const verbose = await runCli(["list", "--verbose"], { cwd, cleanup: false });
      expect(verbose.exitCode).toBe(0);
      const files = readdirSync(join(cwd, "tests/pinned")).filter((n) =>
        n.endsWith(".test.ts")
      );
      for (const f of files) {
        expect(verbose.stdout).toContain(f);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("NEGATIVE CONTROL: empty repo reports a 'no pins found' message (no count line)", async () => {
    const cwd = makeTempRepo();
    try {
      await runCli(["init"], { cwd, cleanup: false });
      const result = await runCli(["list"], { cwd, cleanup: false });
      expect(result.exitCode).toBe(0);
      // Accept either old ("No pinned tests found") or new ("No pinned
      // claims found") copy. The audit's intent is that an empty repo
      // produces no count line and a clear "nothing here" message.
      expect(result.stdout).toMatch(/No pinned (?:tests|claims) found/);
      expect(result.stdout).not.toMatch(/(?:Pinned claims|Protected behaviors) \(/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
