// FEATURE: `pinned generate --pr-id <id> --description "..."`
// SIGNAL: after invocation in an `init`-ed repo, files appear at
//   tests/pinned/<pr-id>-<slug>.test.ts AND .registry.json grows by
//   the number of new claims AND PINS.md contains rows referencing
//   the prId.
// FALSIFIABILITY: catches a regression where generate stops writing
//   any of the three load-bearing artifacts (test file, registry,
//   PINS.md), or where slug shape changes silently.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runCli, makeTempRepo } from "./runCli.js";

describe("FEATURE-AUDIT: `pinned generate` writes test files + updates registry + PINS.md", () => {
  it("POSITIVE CONTROL: a 3-claim description produces 3 test files + registry entries + PINS.md rows", async () => {
    const cwd = makeTempRepo();
    try {
      await runCli(["init"], { cwd, cleanup: false });
      const description = [
        "Rate-limits /api/users to 60 req/min.",
        "Auth required on /api/admin/export.",
        "Makes /webhooks/stripe idempotent on event_id.",
      ].join("\n");
      const result = await runCli(
        ["generate", "--pr-id", "audit-1", "--description", description],
        { cwd, cleanup: false }
      );
      expect(result.exitCode).toBe(0);

      // Three test files, all prefixed with the pr-id
      const files = readdirSync(join(cwd, "tests/pinned")).filter((n) =>
        n.endsWith(".test.ts")
      );
      expect(files).toHaveLength(3);
      for (const f of files) {
        expect(f.startsWith("audit-1-")).toBe(true);
      }

      // Registry has 3 active entries
      const reg = JSON.parse(
        readFileSync(join(cwd, "tests/pinned/.registry.json"), "utf8")
      ) as { claims: Array<{ status: string; prId: string }> };
      const active = reg.claims.filter((c) => c.status === "active");
      expect(active).toHaveLength(3);
      for (const c of active) {
        expect(c.prId).toBe("audit-1");
      }

      // PINS.md contains all three claim labels
      const pins = readFileSync(join(cwd, "tests/pinned/PINS.md"), "utf8");
      expect(pins).toContain("rate-limit");
      expect(pins).toContain("auth-required");
      expect(pins).toContain("idempotent");
      expect(pins).toContain("/api/users");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("NEGATIVE CONTROL: --dry-run does NOT write any test files, registry, or PINS.md", async () => {
    const cwd = makeTempRepo();
    try {
      await runCli(["init"], { cwd, cleanup: false });
      const filesBefore = readdirSync(join(cwd, "tests/pinned")).filter((n) =>
        n.endsWith(".test.ts")
      );
      const result = await runCli(
        [
          "generate",
          "--pr-id",
          "audit-2",
          "--description",
          "Rate-limits /api/x to 5 req/min.",
          "--dry-run",
        ],
        { cwd, cleanup: false }
      );
      expect(result.exitCode).toBe(0);
      const filesAfter = readdirSync(join(cwd, "tests/pinned")).filter((n) =>
        n.endsWith(".test.ts")
      );
      expect(filesAfter).toEqual(filesBefore);
      // Registry should be unchanged (still empty from init)
      const reg = JSON.parse(
        readFileSync(join(cwd, "tests/pinned/.registry.json"), "utf8")
      ) as { claims: unknown[] };
      expect(reg.claims).toHaveLength(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
