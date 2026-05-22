// FEATURE: `pinned generate --pr-id <id>` safety guard (A18, J-class)
// SIGNAL: unsafe --pr-id values (with slashes, dots-only, special
//   chars) are REJECTED with a clear error; safe ids like "pr-1247"
//   are accepted.
// FALSIFIABILITY: catches a regression where assertSafeId is
//   skipped or its regex loosens, allowing path-traversal via pr-id
//   into the registry filename.

import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runCli, makeTempRepo } from "./runCli.js";

const UNSAFE_IDS = [
  "../../etc/passwd",
  "../foo",
  "pr/with/slashes",
  "pr id with spaces",
  ".",
  "..",
  "pr; rm -rf /",
];

describe("FEATURE-AUDIT: `pinned generate --pr-id` rejects unsafe ids", () => {
  for (const unsafe of UNSAFE_IDS) {
    it(`POSITIVE CONTROL: rejects '${unsafe}' with clear error`, async () => {
      const cwd = makeTempRepo();
      try {
        await runCli(["init"], { cwd, cleanup: false });
        const result = await runCli(
          [
            "generate",
            "--pr-id",
            unsafe,
            "--description",
            "Auth required on /api/x.",
          ],
          { cwd, cleanup: false }
        );
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("Invalid");
        // No test files written
        const files = readdirSync(join(cwd, "tests/pinned")).filter((n) =>
          n.endsWith(".test.ts")
        );
        expect(files).toHaveLength(0);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  }

  it("NEGATIVE CONTROL: safe pr-id 'pr-1247' is accepted", async () => {
    const cwd = makeTempRepo();
    try {
      await runCli(["init"], { cwd, cleanup: false });
      const result = await runCli(
        [
          "generate",
          "--pr-id",
          "pr-1247",
          "--description",
          "Auth required on /api/x.",
        ],
        { cwd, cleanup: false }
      );
      expect(result.exitCode).toBe(0);
      const files = readdirSync(join(cwd, "tests/pinned")).filter((n) =>
        n.startsWith("pr-1247-")
      );
      expect(files.length).toBeGreaterThan(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
