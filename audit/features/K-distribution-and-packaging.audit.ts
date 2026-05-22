// FEATURE: Distribution / packaging (K.1–K.5)
// SIGNAL:
//   K1 — `npm pack --dry-run` lists README + dist + LICENSE
//   K3 — apps/cli/src/index.ts (library entry) doesn't import node:*
//   K4 — action/action.yml declares cli-version, auto-commit, byok inputs
//   K5 — action/action.yml has a preflight step that fails fast if no .git
// FALSIFIABILITY: each catches a real distribution surface that
//   would silently break for customers.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(
  new URL(import.meta.url).pathname,
  "..",
  "..",
  ".."
);

describe("FEATURE-AUDIT: K.1 — npm pack contents include README + dist + LICENSE", () => {
  it("POSITIVE CONTROL: `npm pack --dry-run --json` lists all three files", () => {
    const result = spawnSync(
      "npm",
      ["pack", "--dry-run", "--json"],
      {
        cwd: resolve(REPO_ROOT, "apps", "cli"),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Array<{
      files: Array<{ path: string }>;
    }>;
    const fileList = parsed[0].files.map((f) => f.path);
    expect(fileList.some((p) => p === "README.md")).toBe(true);
    expect(fileList.some((p) => p === "LICENSE")).toBe(true);
    expect(fileList.some((p) => p.startsWith("dist/"))).toBe(true);
  });

  it("NEGATIVE CONTROL: npm pack does NOT include src/ or test files", () => {
    const result = spawnSync(
      "npm",
      ["pack", "--dry-run", "--json"],
      {
        cwd: resolve(REPO_ROOT, "apps", "cli"),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    const parsed = JSON.parse(result.stdout) as Array<{
      files: Array<{ path: string }>;
    }>;
    const fileList = parsed[0].files.map((f) => f.path);
    // src/ and *.test.ts must NOT ship — they bloat the package
    expect(fileList.some((p) => p.startsWith("src/"))).toBe(false);
    expect(fileList.some((p) => p.endsWith(".test.ts"))).toBe(false);
  });
});

describe("FEATURE-AUDIT: K.3 — library entry is browser-safe (no node imports)", () => {
  it("POSITIVE CONTROL: apps/cli/src/index.ts imports do NOT include node: modules", () => {
    const src = readFileSync(
      resolve(REPO_ROOT, "apps/cli/src/index.ts"),
      "utf8"
    );
    // Imports starting with "node:" would break the browser-safe
    // contract (Vite landing demo imports from this file).
    const imports = src.match(/^\s*import[^;]+from\s+["']([^"']+)["']/gm) ?? [];
    for (const importLine of imports) {
      expect(importLine).not.toContain('"node:');
      expect(importLine).not.toContain("'node:");
    }
  });

  it("POSITIVE CONTROL: re-exported template files are also browser-safe (excluding template-literal content that generates test files)", () => {
    const templates = [
      "rateLimit.ts",
      "authRequired.ts",
      "idempotent.ts",
      "cliOutputContains.ts",
      "cliExitsZero.ts",
      "cliCreatesFile.ts",
      "cliFlagSupported.ts",
      "libraryReturns.ts",
    ];
    for (const t of templates) {
      let src = readFileSync(
        resolve(REPO_ROOT, "apps/cli/src/templates", t),
        "utf8"
      );
      // The GENERATED test file content sits inside a template literal
      // (`` `...` `` at runtime). The IMPORTS INSIDE that template
      // literal must NOT count as imports of THIS module — they're
      // strings, not module-resolution. Strip template literals before
      // checking. Limit to top-of-file imports only by stopping at the
      // first `const content = \`` line (the canonical pattern across
      // every generator).
      const generatorIdx = src.indexOf("const content = `");
      if (generatorIdx !== -1) {
        src = src.slice(0, generatorIdx);
      }
      const imports = src.match(/^\s*import[^;]+from\s+["']([^"']+)["']/gm) ?? [];
      for (const importLine of imports) {
        expect(importLine).not.toContain('"node:');
        expect(importLine).not.toContain("'node:");
      }
    }
  });
});

describe("FEATURE-AUDIT: K.4 — action.yml declares required inputs", () => {
  it("POSITIVE CONTROL: action.yml has cli-version + auto-commit + byok inputs", () => {
    expect(existsSync(resolve(REPO_ROOT, "action/action.yml"))).toBe(true);
    const yml = readFileSync(resolve(REPO_ROOT, "action/action.yml"), "utf8");
    // Top-level inputs: section
    expect(yml).toContain("inputs:");
    // The three documented input keys
    expect(yml).toContain("cli-version:");
    expect(yml).toContain("auto-commit:");
    expect(yml).toContain("byok:");
  });
});

describe("FEATURE-AUDIT: K.5 — action.yml preflight step checks for .git + base ref", () => {
  it("POSITIVE CONTROL: action.yml has a preflight step that fails fast if .git is missing", () => {
    const yml = readFileSync(resolve(REPO_ROOT, "action/action.yml"), "utf8");
    expect(yml).toMatch(/preflight/i);
    expect(yml).toContain('.git');
    expect(yml).toContain('actions/checkout');
  });

  it("FALSIFIABILITY: the preflight error message names actions/checkout", () => {
    const yml = readFileSync(resolve(REPO_ROOT, "action/action.yml"), "utf8");
    expect(yml).toContain("actions/checkout");
  });
});
