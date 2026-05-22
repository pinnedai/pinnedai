// FEATURE: `pinned baseline`
// SIGNAL: when the working tree contains a recognized risk surface
//   (e.g. an existing app/api/<X>/route.ts), baseline emits a
//   numbered suggestion list with at least one candidate referencing
//   the file. When the working tree has no risk surfaces, baseline
//   reports "No candidate pins detected".
// FALSIFIABILITY: catches a regression where baseline stops walking
//   the working tree, stops applying detectors, or stops emitting a
//   suggested-pin sentence per finding.

import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runCli, makeTempRepo } from "./runCli.js";

describe("FEATURE-AUDIT: `pinned baseline` finds unprotected promises in current repo state", () => {
  it("POSITIVE CONTROL: existing app/api routes are detected as candidate pins", async () => {
    const cwd = makeTempRepo();
    try {
      // Set up an App Router structure with two routes
      mkdirSync(join(cwd, "app/api/users"), { recursive: true });
      mkdirSync(join(cwd, "app/api/admin"), { recursive: true });
      writeFileSync(
        join(cwd, "app/api/users/route.ts"),
        "export const GET = () => new Response('users');"
      );
      writeFileSync(
        join(cwd, "app/api/admin/route.ts"),
        "export const GET = () => new Response('admin');"
      );
      // Init the pinned dir so baseline doesn't error
      await runCli(["init"], { cwd, cleanup: false });

      const result = await runCli(["baseline"], { cwd, cleanup: false });
      expect(result.exitCode).toBe(0);
      // Both routes appear in suggestion output
      expect(result.stdout).toContain("/api/users");
      expect(result.stdout).toContain("/api/admin");
      // Output includes a "Found N candidate" header or per-suggestion text
      expect(result.stdout).toMatch(/candidate|risk-surface|Suggested/i);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("NEGATIVE CONTROL: empty repo reports 'No candidate pins detected'", async () => {
    const cwd = makeTempRepo();
    try {
      await runCli(["init"], { cwd, cleanup: false });
      const result = await runCli(["baseline"], { cwd, cleanup: false });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No candidate pins");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
