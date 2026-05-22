// FEATURE: `pinned doctor`
// SIGNAL: in an init-ed repo with id-token+contents permissions in
//   the workflow, doctor reports ✓ for each of: tests/pinned/
//   directory, workflow file, OIDC permission, auto-commit permission,
//   PINS.md registry. Exit code is 0.
// FALSIFIABILITY: catches a regression where doctor stops checking
//   any of these surfaces, or where exit code stops reflecting the
//   number of failures.

import { describe, it, expect } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli, makeTempRepo } from "./runCli.js";

describe("FEATURE-AUDIT: `pinned doctor` health check", () => {
  it("POSITIVE CONTROL: init-ed repo reports ✓ for each load-bearing check, exit 0", async () => {
    const cwd = makeTempRepo();
    try {
      await runCli(["init"], { cwd, cleanup: false });
      const result = await runCli(["doctor"], { cwd, cleanup: false });
      expect(result.exitCode).toBe(0);
      // Each check appears with a ✓ symbol
      expect(result.stdout).toContain("tests/pinned/ directory");
      expect(result.stdout).toContain(".github/workflows/pinned.yml");
      expect(result.stdout).toContain("id-token: write declared");
      expect(result.stdout).toContain("contents: write declared");
      expect(result.stdout).toContain("PINS.md registry");
      expect(result.stdout).toContain("All checks passed");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("NEGATIVE CONTROL: a repo with missing dirs + missing workflow exits 1 with ✗ markers", async () => {
    const cwd = makeTempRepo();
    try {
      // Don't init — let doctor find broken state
      const result = await runCli(["doctor"], { cwd, cleanup: false });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("✗");
      expect(result.stdout).toContain("tests/pinned/ directory");
      expect(result.stdout).toContain("missing — run `pinned init`");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("NEGATIVE CONTROL: stale workflow missing id-token permission flags ✗ on OIDC check", async () => {
    const cwd = makeTempRepo();
    try {
      await runCli(["init"], { cwd, cleanup: false });
      // Tamper: write a broken workflow without id-token: write
      const brokenYaml = `name: pinned\non: pull_request\npermissions:\n  contents: write\njobs:\n  noop:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`;
      writeFileSync(join(cwd, ".github/workflows/pinned.yml"), brokenYaml);
      const result = await runCli(["doctor"], { cwd, cleanup: false });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("missing `id-token: write`");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
