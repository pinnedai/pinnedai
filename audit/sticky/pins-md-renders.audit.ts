// FEATURE: PINS.md auto-maintained registry
// SIGNAL: after `pinned generate`, the PINS.md file at
//   tests/pinned/PINS.md contains a Markdown row for each active pin
//   (with route + PR-link + actor + date) and a Retired section for
//   retired pins.
// FALSIFIABILITY: catches a regression where generate stops writing
//   PINS.md, retire stops updating it, or the rendering drops rows.

import { describe, it, expect } from "vitest";
import { readFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runCli, makeTempRepo } from "../features/runCli.js";

describe("FEATURE-AUDIT: PINS.md registry renders + updates", () => {
  it("POSITIVE CONTROL: active claims appear under '## Active' with route + PR id", async () => {
    const cwd = makeTempRepo();
    try {
      await runCli(["init"], { cwd, cleanup: false });
      await runCli(
        [
          "generate",
          "--pr-id",
          "audit-1",
          "--description",
          "Rate-limits /api/users to 60 req/min. Auth required on /api/admin.",
        ],
        { cwd, cleanup: false }
      );
      const pins = readFileSync(join(cwd, "tests/pinned/PINS.md"), "utf8");
      expect(pins).toContain("# Pinned Claims");
      expect(pins).toContain("## Active");
      expect(pins).toContain("/api/users");
      expect(pins).toContain("/api/admin");
      expect(pins).toContain("60/minute");
      expect(pins).not.toContain("## Retired");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("POSITIVE CONTROL: retired claims move from '## Active' to '## Retired' with the reason", async () => {
    const cwd = makeTempRepo();
    try {
      await runCli(["init"], { cwd, cleanup: false });
      await runCli(
        [
          "generate",
          "--pr-id",
          "audit-1",
          "--description",
          "Auth required on /api/admin.",
        ],
        { cwd, cleanup: false }
      );
      const files = readdirSync(join(cwd, "tests/pinned")).filter((n) =>
        n.endsWith(".test.ts")
      );
      const claimId = files[0].replace(/\.test\.ts$/, "");
      await runCli(
        ["retire", claimId, "--reason=endpoint-deprecated"],
        { cwd, cleanup: false }
      );
      const pins = readFileSync(join(cwd, "tests/pinned/PINS.md"), "utf8");
      expect(pins).toContain("## Retired");
      expect(pins).toContain("endpoint-deprecated");
      // /api/admin should appear in Retired section only — not in Active.
      const activeIdx = pins.indexOf("## Active");
      const retiredIdx = pins.indexOf("## Retired");
      // If both sections exist, /api/admin sits AFTER ## Retired
      if (activeIdx >= 0 && retiredIdx >= 0) {
        const adminPos = pins.indexOf("/api/admin");
        expect(adminPos).toBeGreaterThan(retiredIdx);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("NEGATIVE CONTROL: empty registry shows placeholder, no claim rows", async () => {
    const cwd = makeTempRepo();
    try {
      await runCli(["init"], { cwd, cleanup: false });
      const pins = readFileSync(join(cwd, "tests/pinned/PINS.md"), "utf8");
      expect(pins).toContain("No pins yet");
      expect(pins).not.toContain("## Active");
      expect(pins).not.toContain("## Retired");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
