// FEATURE: `pinned statusline` + `pinned hook-failure` (Claude Code
//   integration commands). The statusline is the always-on bottom-bar
//   indicator; hook-failure is the chat-injection content that fires
//   ONLY when a pinned test is failing.
// SIGNAL: statusline emits ONE short line (≤ 35 chars target) per
//   call. hook-failure emits content when status.failing, EMPTY
//   otherwise.
// FALSIFIABILITY: catches a regression where the statusline gets
//   verbose (≥ marketing/CLI-hint content), or the hook starts
//   firing on green builds (chat pollution), or fails to fire on red.

import { describe, it, expect, beforeEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  mkdtempSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../features/runCli.js";

// Strip ANSI color codes so structural assertions don't depend on
// whether the terminal renders color. The statusline output is color
// by default — we only care about the content here.
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function makeRepoWithStatus(status: "green" | "failing" | null): string {
  const cwd = mkdtempSync(join(tmpdir(), "pinned-statusline-audit-"));
  mkdirSync(join(cwd, "tests/pinned"), { recursive: true });
  writeFileSync(
    join(cwd, "tests/pinned/.registry.json"),
    JSON.stringify({
      version: 1,
      claims: Array.from({ length: 8 }, (_, i) => ({
        claimId: `pin-${i}`,
        prId: "audit",
        claim: {
          template: "auth-required",
          route: `/api/x${i}`,
          raw: "Auth required on /api/x.",
        },
        filename: `pin-${i}.test.ts`,
        pinnedAt: new Date().toISOString(),
        status: "active",
      })),
    })
  );
  if (status !== null) {
    writeFileSync(
      join(cwd, "tests/pinned/.last-status.json"),
      JSON.stringify({
        status,
        failingCount: status === "failing" ? 1 : 0,
        failingClaimIds:
          status === "failing" ? ["pin-0"] : [],
        totalPins: 8,
        updatedAt: new Date().toISOString(),
      })
    );
  }
  return cwd;
}

describe("FEATURE-AUDIT: pinned statusline — minimal output", () => {
  it("POSITIVE CONTROL: green state shows ✓ + age (always shown)", async () => {
    const cwd = makeRepoWithStatus("green");
    try {
      const r = await runCli(["statusline"], { cwd, cleanup: false });
      expect(r.exitCode).toBe(0);
      const out = stripAnsi(r.stdout.trim());
      // Calm-green statusline shapes (v0.1.1+):
      //   "◆ pinned · 8 pins · ✓"               (clean working tree)
      //   "◆ pinned · 8 pins · N change(s) queued"  (uncommitted edits)
      // Wall-clock age was removed because it was misleading (sitting
      // on the laptop for 3h doesn't decay verification).
      expect(out).toMatch(
        /^◆ pinned · 8 pins · (?:✓|\d+ changes? queued)$/
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("POSITIVE CONTROL: failing state with broken pins shows `✗ N broken` (red)", async () => {
    const cwd = makeRepoWithStatus("failing");
    try {
      const r = await runCli(["statusline"], { cwd, cleanup: false });
      expect(r.exitCode).toBe(0);
      const out = stripAnsi(r.stdout.trim());
      expect(out).toBe("◆ pinned · 8 pins · ✗ 1 broken");
      // ANSI red is present on the broken segment
      expect(r.stdout).toContain("\x1b[31m");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("POSITIVE CONTROL: not-tested state shows `?`", async () => {
    const cwd = makeRepoWithStatus(null);
    try {
      const r = await runCli(["statusline"], { cwd, cleanup: false });
      expect(r.exitCode).toBe(0);
      const out = stripAnsi(r.stdout.trim());
      expect(out).toBe("◆ pinned · 8 pins · ?");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("FALSIFIABILITY: statusline NEVER shows `✗ 0 broken` (failing with zero count must collapse to ✓)", async () => {
    // Construct a degenerate cache: status=failing but failingCount=0
    // (which is what happens if `pinned test`'s vitest invocation
    // errors out without finding any failing test files).
    const cwd = mkdtempSync(join(tmpdir(), "pinned-statusline-collapse-"));
    mkdirSync(join(cwd, "tests/pinned"), { recursive: true });
    writeFileSync(
      join(cwd, "tests/pinned/.registry.json"),
      JSON.stringify({
        version: 1,
        claims: Array.from({ length: 8 }, (_, i) => ({
          claimId: `pin-${i}`,
          prId: "audit",
          claim: {
            template: "auth-required",
            route: `/api/x${i}`,
            raw: "Auth required on /api/x.",
          },
          filename: `pin-${i}.test.ts`,
          pinnedAt: new Date().toISOString(),
          status: "active",
        })),
      })
    );
    writeFileSync(
      join(cwd, "tests/pinned/.last-status.json"),
      JSON.stringify({
        status: "failing",
        failingCount: 0, // ← the degenerate case
        failingClaimIds: [],
        totalPins: 8,
        updatedAt: new Date().toISOString(),
      })
    );
    try {
      const r = await runCli(["statusline"], { cwd, cleanup: false });
      const out = stripAnsi(r.stdout.trim());
      // The bug we're guarding against: "✗ 0 broken" reaching users.
      expect(out).not.toContain("✗ 0 broken");
      // It should collapse to the green path.
      expect(out).toMatch(/✓/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("NEGATIVE CONTROL: statusline NEVER contains marketing or upgrade prompts", async () => {
    const cwd = makeRepoWithStatus("green");
    try {
      const r = await runCli(["statusline"], { cwd, cleanup: false });
      const out = stripAnsi(r.stdout);
      expect(out).not.toContain("Upgrade");
      expect(out).not.toContain("Pro");
      expect(out).not.toContain("pnpm");
      expect(out).not.toContain("npm");
      expect(out).not.toContain("future AI errors");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("FALSIFIABILITY: statusline visible content is ≤ 50 characters (tight bottom-bar budget)", async () => {
    const cwd = makeRepoWithStatus("green");
    try {
      const r = await runCli(["statusline"], { cwd, cleanup: false });
      // Strip ANSI color codes before measuring — they don't take
      // visible space in a terminal.
      expect(stripAnsi(r.stdout.trim()).length).toBeLessThanOrEqual(50);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("NEGATIVE CONTROL: statusline NEVER emits the `◆ pinned vX.Y.Z` banner header (would corrupt the bottom-bar)", async () => {
    const cwd = makeRepoWithStatus("green");
    try {
      const r = await runCli(["statusline"], { cwd, cleanup: false });
      // The bottom-bar gets exactly ONE line. The banner header would
      // be a separate line — refuse.
      expect(r.stdout.split("\n").filter((l) => l.trim().length > 0)).toHaveLength(1);
      expect(r.stdout).not.toMatch(/◆ pinned v\d+\.\d+\.\d+/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("FEATURE-AUDIT: pinned hook-failure — fires only when failing", () => {
  it("POSITIVE CONTROL: failing state emits a multi-line catch celebration with `🛟 Pinned caught a regression`", async () => {
    // The chat-hook reframe in task 121 changed the leading emoji
    // from ⚠ (warning) to 🛟 (lifebuoy — the "save" framing). The
    // failure is still loud, but the message is positive: "Pinned
    // caught a regression" rather than "Pinned: N failing." This
    // is the load-bearing retention moment — convert a test failure
    // into the demo screenshot.
    const cwd = makeRepoWithStatus("failing");
    try {
      const r = await runCli(["hook-failure"], { cwd, cleanup: false });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("🛟 Pinned caught a regression");
      expect(r.stdout).toContain("protected behavior");
      expect(r.stdout).toContain("Do NOT delete");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("NEGATIVE CONTROL: green state emits NOTHING (empty stdout → no chat pollution)", async () => {
    const cwd = makeRepoWithStatus("green");
    try {
      const r = await runCli(["hook-failure"], { cwd, cleanup: false });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("NEGATIVE CONTROL: not-tested state ALSO emits nothing (don't warn for unknown state)", async () => {
    const cwd = makeRepoWithStatus(null);
    try {
      const r = await runCli(["hook-failure"], { cwd, cleanup: false });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("FALSIFIABILITY: a repo without tests/pinned/ emits nothing (hook is inert for non-pinned repos)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pinned-statusline-audit-empty-"));
    try {
      const r = await runCli(["hook-failure"], { cwd, cleanup: false });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
