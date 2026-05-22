// FEATURE: `pinned generate --out-dir <path>` (A17) and --dry-run (A16)
// SIGNAL: --out-dir writes test files to the custom path, not the
//   default tests/pinned/. --dry-run writes NO files (prints to stdout).
// FALSIFIABILITY: catches a regression where --out-dir is silently
//   ignored, or --dry-run still writes to disk.

import { describe, it, expect } from "vitest";
import {
  existsSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { runCli, makeTempRepo } from "./runCli.js";

describe("FEATURE-AUDIT: `pinned generate --out-dir` writes to custom path", () => {
  it("POSITIVE CONTROL: --out-dir custom-pins writes test files there, not tests/pinned/", async () => {
    const cwd = makeTempRepo();
    try {
      const result = await runCli(
        [
          "generate",
          "--pr-id",
          "audit",
          "--description",
          "Auth required on /api/admin.",
          "--out-dir",
          "custom-pins",
        ],
        { cwd, cleanup: false }
      );
      expect(result.exitCode).toBe(0);
      // Custom dir has the test file
      const customFiles = existsSync(join(cwd, "custom-pins"))
        ? readdirSync(join(cwd, "custom-pins")).filter((n) => n.endsWith(".test.ts"))
        : [];
      expect(customFiles.length).toBeGreaterThan(0);
      // Default tests/pinned/ is empty (we never ran init either)
      expect(existsSync(join(cwd, "tests/pinned"))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("FEATURE-AUDIT: `pinned generate --dry-run` writes nothing", () => {
  it("POSITIVE CONTROL: --dry-run prints test content to stdout, leaves filesystem unchanged", async () => {
    const cwd = makeTempRepo();
    try {
      await runCli(["init"], { cwd, cleanup: false });
      const before = readdirSync(join(cwd, "tests/pinned")).filter((n) =>
        n.endsWith(".test.ts")
      );
      const result = await runCli(
        [
          "generate",
          "--pr-id",
          "audit",
          "--description",
          "Auth required on /api/admin.",
          "--dry-run",
        ],
        { cwd, cleanup: false }
      );
      expect(result.exitCode).toBe(0);
      // Test file content is in stdout
      expect(result.stdout).toContain("import { describe");
      expect(result.stdout).toContain("/api/admin");
      // No new files written
      const after = readdirSync(join(cwd, "tests/pinned")).filter((n) =>
        n.endsWith(".test.ts")
      );
      expect(after).toEqual(before);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
