// FEATURE: Security guards — path traversal + symlinks + body caps
//   (J.1, J.2, J.3, J.5, J.6, J.7, J.8, J.9)
// SIGNAL: each unsafe input is REJECTED with a specific error message
//   AND no unsafe filesystem/network side effects occur.

import { describe, it, expect } from "vitest";
import {
  existsSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { runCli, makeTempRepo } from "./runCli.js";

describe("FEATURE-AUDIT: J1 — `--out-dir` path traversal blocked", () => {
  it("POSITIVE CONTROL: --out-dir '../../etc' is rejected with 'Path escape detected'", async () => {
    const cwd = makeTempRepo();
    try {
      const result = await runCli(
        [
          "generate",
          "--pr-id",
          "audit",
          "--description",
          "Auth required on /api/x.",
          "--out-dir",
          "../../escape",
        ],
        { cwd, cleanup: false }
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Path escape detected");
      // Nothing written outside cwd
      expect(existsSync(join(cwd, "../escape"))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("NEGATIVE CONTROL: relative path inside cwd is accepted", async () => {
    const cwd = makeTempRepo();
    try {
      const result = await runCli(
        [
          "generate",
          "--pr-id",
          "audit",
          "--description",
          "Auth required on /api/x.",
          "--out-dir",
          "custom-pins",
        ],
        { cwd, cleanup: false }
      );
      expect(result.exitCode).toBe(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("FEATURE-AUDIT: J2 — `--dir` path traversal blocked across commands", () => {
  for (const cmd of ["list", "scan", "baseline"]) {
    it(`POSITIVE CONTROL: \`pinned ${cmd} --dir ../escape\` is rejected`, async () => {
      const cwd = makeTempRepo();
      try {
        const args = [cmd, "--dir", "../escape"];
        if (cmd === "scan") args.push("--base", "HEAD");
        const result = await runCli(args, { cwd, cleanup: false });
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("Path escape detected");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  }
});

describe("FEATURE-AUDIT: J3 — symlinks not followed in baseline walk", () => {
  it("POSITIVE CONTROL: a symlinked directory pointing OUTSIDE the repo is not walked", async () => {
    const cwd = makeTempRepo();
    try {
      // Real route file inside the repo — baseline should find it
      mkdirSync(join(cwd, "app/api/real"), { recursive: true });
      writeFileSync(
        join(cwd, "app/api/real/route.ts"),
        "export const GET = () => new Response('real');"
      );
      // Create a symlink pointing OUTSIDE cwd. If baseline follows
      // symlinks, it'd walk into /tmp or wherever and potentially
      // expose unrelated content. Pinned should ignore symlinks.
      const outsideDir = join(cwd, "..", "outside-target");
      mkdirSync(outsideDir, { recursive: true });
      mkdirSync(join(outsideDir, "app/api/secret"), { recursive: true });
      writeFileSync(
        join(outsideDir, "app/api/secret/route.ts"),
        "export const GET = () => new Response('secret');"
      );
      try {
        symlinkSync(outsideDir, join(cwd, "symlink-outside"));
      } catch {
        // Some systems may refuse symlink creation — skip the assertion
        return;
      }

      await runCli(["init"], { cwd, cleanup: false });
      const result = await runCli(["baseline"], { cwd, cleanup: false });
      expect(result.exitCode).toBe(0);
      // Found the real internal route
      expect(result.stdout).toContain("/api/real");
      // Did NOT follow the symlink — /api/secret is NOT in the output
      expect(result.stdout).not.toContain("/api/secret");
      rmSync(outsideDir, { recursive: true, force: true });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("FEATURE-AUDIT: J5 — stdin cap is UTF-8 byte-length aware", () => {
  it("POSITIVE CONTROL: 50KB of multi-byte UTF-8 still gets rejected (> 200KB UTF-8)", async () => {
    // Each "你" = 3 bytes in UTF-8. 80,000 of these = 240,000 bytes.
    // That exceeds the 200KB stdin cap REGARDLESS of UTF-16 .length
    // (which would see 80,000 < 200,000).
    const huge = "你".repeat(80_000);
    const result = await runCli(["check"], { stdin: huge });
    expect(result.exitCode).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined.toLowerCase()).toMatch(/stdin exceeded|too large|cap/);
  });
});

describe("FEATURE-AUDIT: J6 — workflow YAML does not interpolate ${{ }} into shell bodies", () => {
  it("POSITIVE CONTROL: every `${{ github.event.* }}` value is passed via env: blocks, not into run: strings", async () => {
    const cwd = makeTempRepo();
    try {
      await runCli(["init"], { cwd, cleanup: false });
      const { readFileSync } = await import("node:fs");
      const yml = readFileSync(
        join(cwd, ".github/workflows/pinned.yml"),
        "utf8"
      );
      // Split into "run: |" blocks and check none contain ${{ github... }}
      // Look for any "run:" line followed by a block that interpolates
      // dangerous expressions in-line.
      const runBlocks = yml.match(
        /run: \|[\s\S]*?(?=\n\s{2,6}- |\n\s*$|\njobs:|\nname:)/g
      ) ?? [];
      // It's OK to interpolate ${{ vars.* }} or ${{ secrets.* }} in
      // env: blocks; the dangerous pattern is in `run:` body.
      for (const block of runBlocks) {
        // Allow the "$DELIM" reference (which IS inside run blocks)
        // and "$RUN_ID" via env. Refuse direct ${{ github.event.* }}
        // / ${{ steps.*.outputs.* }} interpolation in bash.
        expect(block).not.toMatch(/\$\{\{\s*github\.event\./);
        expect(block).not.toMatch(/\$\{\{\s*steps\./);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("FEATURE-AUDIT: J7 — @pinned add: trigger gated to trusted commenters", () => {
  it("POSITIVE CONTROL: workflow YAML restricts issue_comment to OWNER|MEMBER|COLLABORATOR", async () => {
    const cwd = makeTempRepo();
    try {
      await runCli(["init"], { cwd, cleanup: false });
      const { readFileSync } = await import("node:fs");
      const yml = readFileSync(
        join(cwd, ".github/workflows/pinned.yml"),
        "utf8"
      );
      // The author_association check must list these three roles.
      expect(yml).toContain('"OWNER"');
      expect(yml).toContain('"MEMBER"');
      expect(yml).toContain('"COLLABORATOR"');
      // Reverse the falsifiability — non-trusted roles must NOT be
      // listed (outside contributor would be able to trigger commits).
      expect(yml).not.toContain('"CONTRIBUTOR"');
      expect(yml).not.toContain('"FIRST_TIME_CONTRIBUTOR"');
      expect(yml).not.toContain('"NONE"');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("FEATURE-AUDIT: J8 — generated CLI tests use execFileSync (no shell injection)", () => {
  it("POSITIVE CONTROL: generated cli-* test embeds argv as JSON array, not shell string", async () => {
    const cwd = makeTempRepo();
    try {
      await runCli(["init"], { cwd, cleanup: false });
      await runCli(
        [
          "generate",
          "--pr-id",
          "audit",
          "--description",
          "`pinned doctor` outputs `All checks passed`.",
        ],
        { cwd, cleanup: false }
      );
      const files = readdirSync(join(cwd, "tests/pinned")).filter((n) =>
        n.includes("cli-output-contains")
      );
      const { readFileSync } = await import("node:fs");
      const content = readFileSync(
        join(cwd, "tests/pinned", files[0]),
        "utf8"
      );
      // ARGV is a JSON array
      expect(content).toMatch(/const ARGV = \[/);
      // No shell:true
      expect(content).not.toContain("shell: true");
      expect(content).not.toContain("shell:true");
      // execFileSync used (not exec / spawnSync with shell)
      expect(content).toContain("execFileSync");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
