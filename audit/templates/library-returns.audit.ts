// FEATURE: library-returns template
// SIGNAL: when the imported function returns the expected value, the
//   generated test PASSES. When the function returns something
//   different, the test FAILS with PINNED FAILURE.
// FALSIFIABILITY: catches a regression where the template stopped
//   deep-equaling the return, or stopped resolving modulePath correctly.

import { describe, it, expect } from "vitest";
import { generateLibraryReturnsTest } from "../../apps/cli/src/templates/libraryReturns.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

// We can't reuse runGeneratedTest directly here because the generated
// test imports from a module path RELATIVE to its own location
// (`../../<modulePath>`). To make that resolve correctly we need to
// drop the test file at a known path and the module at the expected
// relative path.

const LIB_FIXTURE = resolve(
  new URL(import.meta.url).pathname,
  "..",
  "..",
  "fixtures",
  "lib-fixture.ts"
);

async function runWithFixtureLib(
  generatedContent: string,
  fixtureExportName: "parseConfigHealthy" | "parseConfigBroken"
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const root = mkdtempSync(join(tmpdir(), "pinned-audit-lib-"));
  // Mirror the expected layout: tests/pinned/<file>.test.ts + src/<module>.ts
  const testsDir = join(root, "tests", "pinned");
  const srcDir = join(root, "src");
  mkdirSync(testsDir, { recursive: true });
  mkdirSync(srcDir, { recursive: true });

  // Drop a config.ts that re-exports the chosen fixture under the
  // canonical name `parseConfig`.
  const configTs = `
import { ${fixtureExportName} } from "${LIB_FIXTURE.replace(/\.ts$/, ".js")}";
export const parseConfig = ${fixtureExportName};
`;
  writeFileSync(join(srcDir, "config.ts"), configTs);

  // Drop the generated test where the template expects it.
  writeFileSync(join(testsDir, "audit.test.ts"), generatedContent);

  // Minimal vitest config so the test discovers correctly.
  writeFileSync(
    join(root, "vitest.config.ts"),
    `import { defineConfig } from "vitest/config";\n` +
      `export default defineConfig({ test: { include: ["tests/pinned/**/*.test.ts"], testTimeout: 30000 } });\n`
  );

  const vitestBin = resolve(
    new URL(import.meta.url).pathname,
    "..",
    "..",
    "..",
    "apps",
    "cli",
    "node_modules",
    ".bin",
    "vitest"
  );

  const child = spawn(
    vitestBin,
    [
      "run",
      "--root",
      root,
      "--config",
      join(root, "vitest.config.ts"),
      "--no-color",
    ],
    {
      cwd: root,
      env: { ...process.env, CI: "true" },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
  child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
  const exitCode = await new Promise<number>((res) => {
    child.on("close", (code) => res(code ?? -1));
    child.on("error", () => res(-1));
  });
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  return { exitCode, stdout, stderr };
}

const claim = {
  template: "library-returns" as const,
  functionName: "parseConfig()",
  modulePath: "src/config.ts",
  expected: { version: 1 },
  raw: `\`parseConfig()\` in \`src/config.ts\` returns \`{"version": 1}\`.`,
};

describe("FEATURE-AUDIT: library-returns template", () => {
  it("POSITIVE CONTROL: generated test PASSES when imported function returns expected value", async () => {
    const gen = generateLibraryReturnsTest(claim, { prId: "audit" });
    const result = await runWithFixtureLib(gen.content, "parseConfigHealthy");
    expect(result.exitCode).toBe(0);
  });

  it("NEGATIVE CONTROL: generated test FAILS when function returns wrong value, with PINNED FAILURE header + claim text", async () => {
    const gen = generateLibraryReturnsTest(claim, { prId: "audit" });
    const result = await runWithFixtureLib(gen.content, "parseConfigBroken");
    expect(result.exitCode).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toContain("PINNED FAILURE");
    expect(combined).toContain(claim.raw);
  });
});
