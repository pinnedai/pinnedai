// FEATURE: cli-output-contains template
// SIGNAL: when the spawned binary prints the expected substring, the
//   generated test PASSES. When the binary prints something else,
//   the test FAILS with PINNED FAILURE.
// FALSIFIABILITY: catches a regression where the template stopped
//   using execFileSync (tokenized argv) or stopped grepping stdout.

import { describe, it, expect } from "vitest";
import { generateCliOutputContainsTest } from "../../apps/cli/src/templates/cliOutputContains.js";
import { runGeneratedTest } from "../fixtures/runGenerated.js";
import { resolve } from "node:path";

const FIXTURE = resolve(
  new URL(import.meta.url).pathname,
  "..",
  "..",
  "fixtures",
  "cli-fixture.mjs"
);

const EXPECTED_TEXT = "All checks passed.";
const claim = {
  template: "cli-output-contains" as const,
  route: `node ${FIXTURE}`,
  text: EXPECTED_TEXT,
  raw: `\`node fixture\` outputs \`${EXPECTED_TEXT}\`.`,
};

describe("FEATURE-AUDIT: cli-output-contains template", () => {
  it("POSITIVE CONTROL: generated test PASSES when fixture prints expected substring", async () => {
    const gen = generateCliOutputContainsTest(claim, { prId: "audit" });
    const result = await runGeneratedTest(gen.content, {
      env: { PINNED_AUDIT_STDOUT: EXPECTED_TEXT },
    });
    expect(result.exitCode).toBe(0);
  });

  it("NEGATIVE CONTROL: generated test FAILS when fixture prints something else, with PINNED FAILURE header + claim text", async () => {
    const gen = generateCliOutputContainsTest(claim, { prId: "audit" });
    const result = await runGeneratedTest(gen.content, {
      env: { PINNED_AUDIT_STDOUT: "totally different output" },
    });
    expect(result.exitCode).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toContain("PINNED FAILURE");
    expect(combined).toContain(claim.raw);
  });
});
