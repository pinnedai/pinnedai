// FEATURE: cli-flag-supported template
// SIGNAL: when `<cmd> --help` output mentions the flag, the generated
//   test PASSES. When the flag is absent from help, the test FAILS
//   with PINNED FAILURE.
// FALSIFIABILITY: catches a regression where the template stopped
//   appending --help, or stopped checking both stdout and stderr.

import { describe, it, expect } from "vitest";
import { generateCliFlagSupportedTest } from "../../apps/cli/src/templates/cliFlagSupported.js";
import { runGeneratedTest } from "../fixtures/runGenerated.js";
import { resolve } from "node:path";

const FIXTURE = resolve(
  new URL(import.meta.url).pathname,
  "..",
  "..",
  "fixtures",
  "cli-fixture.mjs"
);

const FLAG = "--audit-flag";
const claim = {
  template: "cli-flag-supported" as const,
  route: `node ${FIXTURE}`,
  flag: FLAG,
  raw: `\`node fixture\` supports \`${FLAG}\` flag.`,
};

describe("FEATURE-AUDIT: cli-flag-supported template", () => {
  it("POSITIVE CONTROL: generated test PASSES when --help mentions the flag", async () => {
    const gen = generateCliFlagSupportedTest(claim, { prId: "audit" });
    const result = await runGeneratedTest(gen.content, {
      env: {
        PINNED_AUDIT_HELP_TEXT: `Usage: fixture [options]\n\nOptions:\n  ${FLAG}    A test flag\n`,
      },
    });
    expect(result.exitCode).toBe(0);
  });

  it("NEGATIVE CONTROL: generated test FAILS when --help doesn't mention the flag, with PINNED FAILURE header + claim text", async () => {
    const gen = generateCliFlagSupportedTest(claim, { prId: "audit" });
    const result = await runGeneratedTest(gen.content, {
      env: {
        PINNED_AUDIT_HELP_TEXT:
          "Usage: fixture [options]\n\nOptions:\n  --some-other-flag    Something else\n",
      },
    });
    expect(result.exitCode).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toContain("PINNED FAILURE");
    expect(combined).toContain(claim.raw);
  });
});
