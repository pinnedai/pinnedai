// FEATURE: cli-creates-file template
// SIGNAL: when the spawned binary creates the expected file in cwd,
//   the generated test PASSES. When the file is not created, the test
//   FAILS with PINNED FAILURE.
// FALSIFIABILITY: catches a regression where the template stopped
//   asserting existsSync(expected), or stopped running in a clean tempdir.

import { describe, it, expect } from "vitest";
import { generateCliCreatesFileTest } from "../../apps/cli/src/templates/cliCreatesFile.js";
import { runGeneratedTest } from "../fixtures/runGenerated.js";
import { resolve } from "node:path";

const FIXTURE = resolve(
  new URL(import.meta.url).pathname,
  "..",
  "..",
  "fixtures",
  "cli-fixture.mjs"
);

const EXPECTED_FILE = "audit-output.txt";
const claim = {
  template: "cli-creates-file" as const,
  route: `node ${FIXTURE}`,
  filePath: EXPECTED_FILE,
  raw: `\`node fixture\` creates \`${EXPECTED_FILE}\`.`,
};

describe("FEATURE-AUDIT: cli-creates-file template", () => {
  it("POSITIVE CONTROL: generated test PASSES when fixture creates the expected file", async () => {
    const gen = generateCliCreatesFileTest(claim, { prId: "audit" });
    const result = await runGeneratedTest(gen.content, {
      env: { PINNED_AUDIT_CREATE_FILE: EXPECTED_FILE },
    });
    expect(result.exitCode).toBe(0);
  });

  it("NEGATIVE CONTROL: generated test FAILS when fixture doesn't create the file, with PINNED FAILURE header + claim text", async () => {
    const gen = generateCliCreatesFileTest(claim, { prId: "audit" });
    const result = await runGeneratedTest(gen.content, {
      env: {}, // no PINNED_AUDIT_CREATE_FILE → fixture creates nothing
    });
    expect(result.exitCode).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toContain("PINNED FAILURE");
    expect(combined).toContain(claim.raw);
  });
});
