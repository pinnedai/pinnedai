// FEATURE: `pinned init` flags (A24, A25)
//   - --force overwrites existing files
//   - without --force, second run is idempotent (skips existing)
// SIGNAL: --force replaces existing workflow content; idempotent
//   path leaves files untouched.
// FALSIFIABILITY: catches a regression where --force is silently
//   ignored, OR where idempotent init errors out / clobbers files.

import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runCli, makeTempRepo } from "./runCli.js";

describe("FEATURE-AUDIT: `pinned init --force` overwrites", () => {
  it("POSITIVE CONTROL: --force replaces a tampered workflow file", async () => {
    const cwd = makeTempRepo();
    try {
      await runCli(["init"], { cwd, cleanup: false });
      // Tamper: write a broken workflow
      writeFileSync(
        join(cwd, ".github/workflows/pinned.yml"),
        "name: broken\non: push\n"
      );
      const tampered = readFileSync(
        join(cwd, ".github/workflows/pinned.yml"),
        "utf8"
      );
      expect(tampered).not.toContain("id-token: write");

      // Re-init with --force
      const result = await runCli(["init", "--force"], {
        cwd,
        cleanup: false,
      });
      expect(result.exitCode).toBe(0);
      const restored = readFileSync(
        join(cwd, ".github/workflows/pinned.yml"),
        "utf8"
      );
      expect(restored).toContain("id-token: write");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("NEGATIVE CONTROL: without --force, init preserves tampered workflow + reports skip", async () => {
    const cwd = makeTempRepo();
    try {
      await runCli(["init"], { cwd, cleanup: false });
      writeFileSync(
        join(cwd, ".github/workflows/pinned.yml"),
        "name: tampered\n"
      );
      const result = await runCli(["init"], { cwd, cleanup: false });
      expect(result.exitCode).toBe(0);
      // Skip notice
      expect(result.stdout).toContain("skipping");
      const after = readFileSync(
        join(cwd, ".github/workflows/pinned.yml"),
        "utf8"
      );
      expect(after).toBe("name: tampered\n");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("FEATURE-AUDIT: `pinned init` is idempotent across runs", () => {
  it("POSITIVE CONTROL: running init twice in a fresh repo exits 0 both times", async () => {
    const cwd = makeTempRepo();
    try {
      const first = await runCli(["init"], { cwd, cleanup: false });
      expect(first.exitCode).toBe(0);
      const second = await runCli(["init"], { cwd, cleanup: false });
      expect(second.exitCode).toBe(0);
      // Second run should report skipping
      expect(second.stdout).toMatch(/skipping/i);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
