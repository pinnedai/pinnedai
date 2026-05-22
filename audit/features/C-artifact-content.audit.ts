// FEATURE: Generated artifact content (C.13)
// SIGNAL: tests/pinned/README.md (the customer-facing one created by
//   init) contains the load-bearing guidance — retire usage, list
//   usage, link to pinnedai.dev.

import { describe, it, expect } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runCli, makeTempRepo } from "./runCli.js";

describe("FEATURE-AUDIT: C.13 — tests/pinned/README.md content", () => {
  it("POSITIVE CONTROL: README contains retire usage + list usage + pinnedai.dev link", async () => {
    const cwd = makeTempRepo();
    try {
      await runCli(["init"], { cwd, cleanup: false });
      const content = readFileSync(
        join(cwd, "tests/pinned/README.md"),
        "utf8"
      );
      expect(content).toContain("pinnedai");
      expect(content).toContain("retire");
      expect(content).toContain("list");
      expect(content).toContain("pinnedai.dev");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
