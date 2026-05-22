// FEATURE: `pinned retire <claim-id> --reason="..."`
// SIGNAL: the named test file disappears from tests/pinned/, a copy
//   appears at tests/pinned/retired/, a sibling <id>.audit.json
//   appears with the reason + timestamp + retiredBy, and the
//   registry entry's status flips to "retired".
// FALSIFIABILITY: catches a regression where retire stops moving the
//   file, skips the audit-log write, or fails to update the registry.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runCli, makeTempRepo } from "./runCli.js";

describe("FEATURE-AUDIT: `pinned retire` moves file + writes audit + updates registry", () => {
  it("POSITIVE CONTROL: retired file moves + audit.json appears + registry status flips", async () => {
    const cwd = makeTempRepo();
    try {
      await runCli(["init"], { cwd, cleanup: false });
      await runCli(
        [
          "generate",
          "--pr-id",
          "audit-1",
          "--description",
          "Rate-limits /api/users to 60 req/min.",
        ],
        { cwd, cleanup: false }
      );

      // Find the claim id from the generated filename
      const files = readdirSync(join(cwd, "tests/pinned")).filter((n) =>
        n.endsWith(".test.ts")
      );
      expect(files).toHaveLength(1);
      const claimId = files[0].replace(/\.test\.ts$/, "");

      const result = await runCli(
        ["retire", claimId, "--reason=audit-test"],
        { cwd, cleanup: false }
      );
      expect(result.exitCode).toBe(0);

      // File moved
      expect(existsSync(join(cwd, "tests/pinned", files[0]))).toBe(false);
      expect(existsSync(join(cwd, "tests/pinned/retired", files[0]))).toBe(
        true
      );
      // Audit log appeared
      const auditPath = join(cwd, "tests/pinned/retired", `${claimId}.audit.json`);
      expect(existsSync(auditPath)).toBe(true);
      const audit = JSON.parse(readFileSync(auditPath, "utf8")) as {
        claimId: string;
        reason: string;
        retiredBy: string;
        retiredAt: string;
      };
      expect(audit.claimId).toBe(claimId);
      expect(audit.reason).toBe("audit-test");
      expect(audit.retiredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      // Registry status flipped
      const reg = JSON.parse(
        readFileSync(join(cwd, "tests/pinned/.registry.json"), "utf8")
      ) as { claims: Array<{ claimId: string; status: string }> };
      const entry = reg.claims.find((c) => c.claimId === claimId);
      expect(entry?.status).toBe("retired");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("NEGATIVE CONTROL: retiring an unknown claimId fails with exit 1 and no filesystem changes", async () => {
    const cwd = makeTempRepo();
    try {
      await runCli(["init"], { cwd, cleanup: false });
      const result = await runCli(
        ["retire", "definitely-not-real", "--reason=test"],
        { cwd, cleanup: false }
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("No pinned claim found");
      // Retired dir wasn't created (no pin existed to retire)
      expect(existsSync(join(cwd, "tests/pinned/retired"))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
