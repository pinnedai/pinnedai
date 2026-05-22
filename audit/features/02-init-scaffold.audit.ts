// FEATURE: `pinned init`
// SIGNAL: after running in a clean dir, these files exist:
//   .github/workflows/pinned.yml
//   tests/pinned/README.md
//   tests/pinned/.gitkeep
//   tests/pinned/.registry.json
//   tests/pinned/PINS.md
//   AND the workflow YAML contains "id-token: write" + "contents: write"
// FALSIFIABILITY: catches a regression where init stops scaffolding
//   any of the 5 expected files or the workflow drops a required
//   permission.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, makeTempRepo } from "./runCli.js";

describe("FEATURE-AUDIT: `pinned init` scaffolds the workflow + registry", () => {
  it("POSITIVE CONTROL: all 5 expected files exist + workflow has both permissions", async () => {
    const cwd = makeTempRepo();
    try {
      const result = await runCli(["init"], { cwd, cleanup: false });
      expect(result.exitCode).toBe(0);

      const expectedFiles = [
        ".github/workflows/pinned.yml",
        "tests/pinned/README.md",
        "tests/pinned/.gitkeep",
        "tests/pinned/.registry.json",
        "tests/pinned/PINS.md",
      ];
      for (const f of expectedFiles) {
        expect(existsSync(join(cwd, f))).toBe(true);
      }

      const workflow = readFileSync(
        join(cwd, ".github/workflows/pinned.yml"),
        "utf8"
      );
      expect(workflow).toContain("id-token: write");
      expect(workflow).toContain("contents: write");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("NEGATIVE CONTROL: skipping init leaves these files absent (proves positive isn't tautological)", async () => {
    const cwd = makeTempRepo();
    try {
      const expectedFiles = [
        ".github/workflows/pinned.yml",
        "tests/pinned/README.md",
        "tests/pinned/.registry.json",
        "tests/pinned/PINS.md",
      ];
      for (const f of expectedFiles) {
        expect(existsSync(join(cwd, f))).toBe(false);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
