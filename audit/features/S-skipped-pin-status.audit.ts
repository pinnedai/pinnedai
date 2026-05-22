// FEATURE: pinned list / status MUST NOT label skipped pins as ✓ verified.
//
// SIGNAL: when `.last-status.json` has skippedCount > 0, the list view
//   shows the skipped pins with "?" (not-yet-verified) icon — never
//   "✓ verified" — and surfaces a footer explaining how to enable
//   verification (set PREVIEW_URL / fixture tokens).
//
// FALSIFIABILITY: catches a regression where someone changes
//   `statusIcon = failingSet.has(claimId) ? "✗" : last ? "✓" : "?"`
//   without accounting for the skippedCount > 0 case. This would
//   give users false confidence that skipped pins are protecting
//   them, when they aren't.
//
// Why this is CATASTROPHIC: GPT review's #1 launch-blocker. A user
// who installs Pinned without setting PREVIEW_URL sees "✓ verified"
// next to their pins — they think they're protected. They aren't.

import { describe, it, expect } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runCli, makeTempRepo } from "./runCli.js";

function gitInit(cwd: string) {
  const opts = { cwd, stdio: "ignore" as const };
  spawnSync("git", ["init", "-b", "main"], opts);
  spawnSync("git", ["config", "user.email", "audit@example.com"], opts);
  spawnSync("git", ["config", "user.name", "Audit"], opts);
  spawnSync("git", ["config", "commit.gpgsign", "false"], opts);
}

describe("FEATURE-AUDIT: pinned list/status never falsely claims 'verified' for skipped pins", () => {
  it("POSITIVE CONTROL: when last-status reports skippedCount > 0, pinned list shows ? for non-failing pins (not ✓)", async () => {
    const cwd = makeTempRepo();
    try {
      gitInit(cwd);
      await runCli(["init", "--force"], { cwd, cleanup: false });
      await runCli(
        [
          "generate",
          "--pr-id",
          "pr-1",
          "--description",
          "Auth required on /api/admin/export.",
          "--no-verify",
        ],
        { cwd, cleanup: false }
      );
      // Hand-author a .last-status.json that says "1 pin skipped, 0 failing"
      // — simulates a `pinned test` run where PREVIEW_URL was unset.
      const statusPath = join(cwd, "tests", "pinned", ".last-status.json");
      writeFileSync(
        statusPath,
        JSON.stringify(
          {
            status: "green",
            failingCount: 0,
            failingClaimIds: [],
            totalPins: 1,
            skippedCount: 1,
            updatedAt: "2026-05-22T00:00:00Z",
          },
          null,
          2
        )
      );

      const list = await runCli(["list"], { cwd, cleanup: false });
      expect(list.exitCode).toBe(0);
      // The pin row MUST NOT show "✓" — that would imply verification.
      // It SHOULD show "?" (unknown/not-yet-checked).
      const lines = list.stdout.split("\n");
      const pinLine = lines.find((l) => l.includes("/api/admin/export"));
      expect(pinLine).toBeDefined();
      expect(pinLine!).not.toContain("✓");
      expect(pinLine!).toMatch(/[?⊘]/); // either ? or ⊘
      // The footer should explain the skip + point at docs.
      expect(list.stdout).toContain("skipped");
      expect(list.stdout).toContain("PREVIEW_URL");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("POSITIVE CONTROL: --verbose mode also avoids '✓ verified' when skippedCount > 0", async () => {
    const cwd = makeTempRepo();
    try {
      gitInit(cwd);
      await runCli(["init", "--force"], { cwd, cleanup: false });
      await runCli(
        [
          "generate",
          "--pr-id",
          "pr-1",
          "--description",
          "Auth required on /api/admin/export.",
          "--no-verify",
        ],
        { cwd, cleanup: false }
      );
      const statusPath = join(cwd, "tests", "pinned", ".last-status.json");
      writeFileSync(
        statusPath,
        JSON.stringify(
          {
            status: "green",
            failingCount: 0,
            failingClaimIds: [],
            totalPins: 1,
            skippedCount: 1,
            updatedAt: "2026-05-22T00:00:00Z",
          },
          null,
          2
        )
      );

      const list = await runCli(["list", "--verbose"], {
        cwd,
        cleanup: false,
      });
      expect(list.exitCode).toBe(0);
      const lines = list.stdout.split("\n");
      const titleLine = lines.find((l) =>
        l.includes("/api/admin/export is not publicly accessible")
      );
      expect(titleLine).toBeDefined();
      expect(titleLine!).not.toContain("✓");
      expect(titleLine!).toMatch(/[?⊘]/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("NO-CHANGE: with skippedCount === 0 (everything actually verified), ✓ icon DOES appear", async () => {
    // Inverse case: when the last test run had ZERO skipped pins,
    // ✓ verified is the correct label. Without this falsifiability
    // check, our skip-detection could over-trigger and never show ✓.
    const cwd = makeTempRepo();
    try {
      gitInit(cwd);
      await runCli(["init", "--force"], { cwd, cleanup: false });
      await runCli(
        [
          "generate",
          "--pr-id",
          "pr-1",
          "--description",
          "Auth required on /api/admin/export.",
          "--no-verify",
        ],
        { cwd, cleanup: false }
      );
      const statusPath = join(cwd, "tests", "pinned", ".last-status.json");
      writeFileSync(
        statusPath,
        JSON.stringify(
          {
            status: "green",
            failingCount: 0,
            failingClaimIds: [],
            totalPins: 1,
            skippedCount: 0, // ← all verified
            updatedAt: "2026-05-22T00:00:00Z",
          },
          null,
          2
        )
      );

      const list = await runCli(["list"], { cwd, cleanup: false });
      expect(list.exitCode).toBe(0);
      const lines = list.stdout.split("\n");
      const pinLine = lines.find((l) => l.includes("/api/admin/export"));
      expect(pinLine).toBeDefined();
      expect(pinLine!).toContain("✓");
      // Footer should NOT mention skipped pins when there are none.
      expect(list.stdout).not.toContain("pin(s) skipped");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("NO-CHANGE: with failing pins, ✗ icon takes precedence over skip handling", async () => {
    // Failing pins are loudly broken (✗) regardless of whether other
    // pins skipped. Falsifiability check: skip-handling must not
    // override the failure signal.
    const cwd = makeTempRepo();
    try {
      gitInit(cwd);
      await runCli(["init", "--force"], { cwd, cleanup: false });
      await runCli(
        [
          "generate",
          "--pr-id",
          "pr-1",
          "--description",
          "Auth required on /api/admin/export.",
          "--no-verify",
        ],
        { cwd, cleanup: false }
      );
      const statusPath = join(cwd, "tests", "pinned", ".last-status.json");
      // Find the claimId for the pin we just generated.
      const registry = JSON.parse(
        require("node:fs").readFileSync(
          join(cwd, "tests", "pinned", ".registry.json"),
          "utf8"
        )
      );
      const claimId = registry.claims[0].claimId;

      writeFileSync(
        statusPath,
        JSON.stringify(
          {
            status: "failing",
            failingCount: 1,
            failingClaimIds: [claimId],
            totalPins: 1,
            skippedCount: 0,
            updatedAt: "2026-05-22T00:00:00Z",
          },
          null,
          2
        )
      );

      const list = await runCli(["list"], { cwd, cleanup: false });
      expect(list.exitCode).toBe(0);
      const lines = list.stdout.split("\n");
      const pinLine = lines.find((l) => l.includes("/api/admin/export"));
      expect(pinLine).toBeDefined();
      expect(pinLine!).toContain("✗"); // failing icon must show
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
