// FEATURE: cli-exits-zero template
// SIGNAL: when the spawned binary exits with code 0, the generated
//   test PASSES. When the binary exits non-zero, the test FAILS with
//   PINNED FAILURE.
// FALSIFIABILITY: catches a regression where the template stopped
//   asserting on result.status or started accepting any exit code.

import { describe, it, expect } from "vitest";
import { generateCliExitsZeroTest } from "../../apps/cli/src/templates/cliExitsZero.js";
import { runGeneratedTest } from "../fixtures/runGenerated.js";
import { resolve } from "node:path";

const FIXTURE = resolve(
  new URL(import.meta.url).pathname,
  "..",
  "..",
  "fixtures",
  "cli-fixture.mjs"
);

const claim = {
  template: "cli-exits-zero" as const,
  route: `node ${FIXTURE}`,
  raw: `\`node fixture\` exits 0.`,
};

describe("FEATURE-AUDIT: cli-exits-zero template", () => {
  it("POSITIVE CONTROL: generated test PASSES when fixture exits 0", async () => {
    const gen = generateCliExitsZeroTest(claim, { prId: "audit" });
    const result = await runGeneratedTest(gen.content, {
      env: { PINNED_AUDIT_EXIT: "0" },
    });
    expect(result.exitCode).toBe(0);
  });

  it("NEGATIVE CONTROL: generated test FAILS when fixture exits 1, with PINNED FAILURE header + claim text", async () => {
    const gen = generateCliExitsZeroTest(claim, { prId: "audit" });
    const result = await runGeneratedTest(gen.content, {
      env: { PINNED_AUDIT_EXIT: "1" },
    });
    expect(result.exitCode).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toContain("PINNED FAILURE");
    expect(combined).toContain(claim.raw);
  });
});
