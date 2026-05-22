// Helper for template audits: write a generated test file to a
// tempdir, run vitest on it (with optional env), capture exit code +
// stderr. Used by every template audit to actually execute the
// generated test against a controlled fixture.

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

export type RunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  cwd: string;
};

// IMPORTANT: this runner MUST be async. spawnSync would block the
// parent's event loop, which means any fixture HTTP server running in
// the parent process can't accept connections from the child vitest
// — fetches would time out at the test-timeout boundary.
export async function runGeneratedTest(
  generatedTestContent: string,
  opts: { env?: Record<string, string>; cwd?: string; filename?: string } = {}
): Promise<RunResult> {
  const dir = opts.cwd ?? mkdtempSync(join(tmpdir(), "pinned-audit-"));
  const filename = opts.filename ?? "audit.test.ts";
  const testPath = join(dir, filename);

  writeFileSync(testPath, generatedTestContent);

  // Drop a minimal vitest config into the tempdir so vitest doesn't
  // walk up to find the audit/ config (which would scope-exclude this
  // file). Explicit empty include means "test the file passed on the
  // CLI" without inheriting the outer config's filter.
  writeFileSync(
    join(dir, "vitest.config.ts"),
    `import { defineConfig } from "vitest/config";\n` +
      `export default defineConfig({ test: { include: ["**/*.test.ts"], testTimeout: 30000 } });\n`
  );

  // Use the in-repo vitest binary (apps/cli's devDependency). The
  // audit runs from the repo root so this path is stable.
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
      dir,
      "--config",
      join(dir, "vitest.config.ts"),
      "--no-color",
    ],
    {
      cwd: dir,
      env: { ...process.env, ...opts.env, CI: "true" },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const exitCode = await new Promise<number>((res) => {
    child.on("close", (code) => res(code ?? -1));
    child.on("error", () => res(-1));
  });

  // Best-effort cleanup if we created the dir.
  if (!opts.cwd) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  return { exitCode, stdout, stderr, cwd: dir };
}
