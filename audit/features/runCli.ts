// Shared helper for CLI command audits: spawns the built CLI binary
// against a controlled tempdir, captures stdout/stderr/exitCode.
// Async (uses spawn, not spawnSync) so fixtures that need a running
// event loop don't deadlock the audit.

import { resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_BIN = resolve(
  new URL(import.meta.url).pathname,
  "..",
  "..",
  "..",
  "apps",
  "cli",
  "dist",
  "cli.js"
);

export type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  cwd: string;
};

export async function runCli(
  args: string[],
  opts: {
    cwd?: string;
    env?: Record<string, string>;
    stdin?: string;
    cleanup?: boolean;
  } = {}
): Promise<CliResult> {
  const cwd =
    opts.cwd ?? mkdtempSync(join(tmpdir(), "pinned-audit-cli-"));
  const cleanup = opts.cleanup ?? !opts.cwd;

  const child = spawn("node", [CLI_BIN, ...args], {
    cwd,
    env: { ...process.env, ...opts.env },
    stdio: [opts.stdin ? "pipe" : "ignore", "pipe", "pipe"],
  });

  if (opts.stdin) {
    child.stdin!.write(opts.stdin);
    child.stdin!.end();
  }

  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
  child.stderr!.on("data", (c: Buffer) => (stderr += c.toString("utf8")));

  const exitCode = await new Promise<number>((res) => {
    child.on("close", (code) => res(code ?? -1));
    child.on("error", () => res(-1));
  });

  if (cleanup) {
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  return { exitCode, stdout, stderr, cwd };
}

export function makeTempRepo(opts: { vitest?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "pinned-audit-cli-"));
  // git init the tempdir so `pinned init` doesn't fail its preflight
  // (non-git-repo check). Audits exercise the real customer flow:
  // user has a git repo, then runs pinned init.
  spawnSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  spawnSync("git", ["config", "user.email", "audit@example.com"], {
    cwd: dir,
    stdio: "ignore",
  });
  spawnSync("git", ["config", "user.name", "Audit"], { cwd: dir, stdio: "ignore" });
  spawnSync("git", ["config", "commit.gpgsign", "false"], {
    cwd: dir,
    stdio: "ignore",
  });
  // Default to seeding a package.json that declares vitest in
  // devDependencies. `pinned init --auto` refuses to complete (exits 2)
  // if vitest isn't available in the repo — matching the "Pinned is
  // inert without a test runner" contract. Most audits want to test
  // the HAPPY path where init succeeds, so seeding vitest is the right
  // default. Audits that specifically test the "no vitest" failure path
  // can pass `{ vitest: false }`.
  if (opts.vitest !== false) {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        {
          name: "audit-fixture",
          private: true,
          devDependencies: { vitest: "^2.0.0" },
        },
        null,
        2
      )
    );
  }
  return dir;
}
