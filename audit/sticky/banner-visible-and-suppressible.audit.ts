// FEATURE: ◆ pinned banner header — visible signal that pinned is
//   active on every CLI command that touches the registry, with an
//   opt-out via PINNEDAI_QUIET=1 / --quiet / --json / --markdown.
// SIGNAL: stderr begins with "◆ pinned v" string followed by the
//   active pin count.
// FALSIFIABILITY: catches a regression where the banner stops being
//   emitted (UX regression — customer doesn't see pinned is active)
//   OR where suppression flags stop working (CI log noise / corrupted
//   JSON output downstream).

import { describe, it, expect } from "vitest";
import { runCli, makeTempRepo } from "../features/runCli.js";
import { rmSync } from "node:fs";

describe("FEATURE-AUDIT: pinned banner header (visible + suppressible)", () => {
  it("POSITIVE CONTROL: `pinned list` emits the banner with active pin count", async () => {
    const cwd = makeTempRepo();
    try {
      await runCli(["init"], { cwd, cleanup: false });
      // Pin a claim so the banner reports a real count, not "0 pins".
      await runCli(
        [
          "generate",
          "--pr-id",
          "audit",
          "--description",
          "Auth required on /api/x.",
        ],
        { cwd, cleanup: false }
      );
      const result = await runCli(["list"], { cwd, cleanup: false });
      expect(result.exitCode).toBe(0);
      // Banner is on stderr so it doesn't pollute stdout pipes
      expect(result.stderr).toContain("◆ pinned v");
      expect(result.stderr).toContain("1 active pin");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("POSITIVE CONTROL: banner adapts to 0-pin state with helpful nudge", async () => {
    const cwd = makeTempRepo();
    try {
      await runCli(["init"], { cwd, cleanup: false });
      const result = await runCli(["list"], { cwd, cleanup: false });
      expect(result.exitCode).toBe(0);
      // Empty registry → friendly nudge instead of "0 active pins"
      expect(result.stderr).toContain("◆ pinned v");
      expect(result.stderr).toContain("0 pins");
      expect(result.stderr).toContain("pinned baseline");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("POSITIVE CONTROL: `pinned check` emits the banner", async () => {
    const result = await runCli([
      "check",
      "--description",
      "Auth required on /api/x.",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("◆ pinned v");
  });

  it("NEGATIVE CONTROL: PINNEDAI_QUIET=1 suppresses the banner", async () => {
    const result = await runCli(
      ["check", "--description", "Auth required on /api/x."],
      { env: { PINNEDAI_QUIET: "1" } }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("◆ pinned v");
    // The command itself still produces its normal output
    expect(result.stdout).toContain("Found 1 claim");
  });

  it("NEGATIVE CONTROL: --quiet flag suppresses the banner", async () => {
    const result = await runCli([
      "check",
      "--description",
      "Auth required on /api/x.",
      "--quiet",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("◆ pinned v");
  });

  it("NEGATIVE CONTROL: --json mode suppresses banner (clean JSON for jq)", async () => {
    const result = await runCli([
      "check",
      "--description",
      "Auth required on /api/x.",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("◆ pinned v");
    // And stdout is parseable JSON
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
  });

  it("FALSIFIABILITY: --version doesn't print banner (Commander's --version short-circuits action)", async () => {
    // Commander handles --version before our action runs, so the
    // banner isn't emitted. This is the documented design — if --version
    // ever DID print the banner, this assertion would catch the
    // unintended behavior change.
    const result = await runCli(["--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("◆ pinned v");
    // The version string itself is on stdout
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("FEATURE-AUDIT: generated test files stamped with pinnedai header", () => {
  it("POSITIVE CONTROL: generated test top-of-file contains '◆ Pinned by pinnedai' + URL", async () => {
    const cwd = makeTempRepo();
    try {
      await runCli(["init"], { cwd, cleanup: false });
      await runCli(
        [
          "generate",
          "--pr-id",
          "audit",
          "--description",
          "Auth required on /api/x.",
        ],
        { cwd, cleanup: false }
      );
      const { readdirSync, readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const files = readdirSync(join(cwd, "tests/pinned")).filter((n) =>
        n.endsWith(".test.ts")
      );
      expect(files).toHaveLength(1);
      const content = readFileSync(join(cwd, "tests/pinned", files[0]), "utf8");
      // Reviewers + CI log readers see this header and KNOW it's pinned
      expect(content).toContain("◆ Pinned by pinnedai");
      expect(content).toContain("https://pinnedai.dev");
      expect(content).toContain("Template:");
      expect(content).toContain("Source PR:");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
