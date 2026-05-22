// FEATURE: `npx pinnedai` zero-config demo
// SIGNAL: stdout contains "pinnedai try" header AND a parsed claim
//   count AND the line "Generated test file (would be written to"
//   AND a "Next:" section with install instructions.
// FALSIFIABILITY: catches a regression where the demo stops emitting
//   any of these load-bearing UX strings (silent breakage that
//   onboarding hinges on).

import { describe, it, expect } from "vitest";
import { runCli } from "./runCli.js";

describe("FEATURE-AUDIT: bare `npx pinnedai` runs the demo", () => {
  it("POSITIVE CONTROL: stdout contains every onboarding signal string", async () => {
    const result = await runCli(["try"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pinnedai try");
    expect(result.stdout).toContain("Parsed");
    expect(result.stdout).toContain("Generated test file");
    // The footer branches: if the repo isn't initialized (the tempdir
    // case in this audit), `try` shows a discoverability nudge. If it
    // IS initialized, it shows a "Next:" section. We accept either,
    // but BOTH branches must mention `pinnedai init` as the call to
    // action so onboarding remains obvious.
    expect(result.stdout).toMatch(/(?:Next:|isn't set up for Pinned)/);
    expect(result.stdout).toContain("npx pinnedai init");
  });

  it("NEGATIVE CONTROL: demo output is distinguishable from unrelated stdout", async () => {
    // Sanity check that the positive assertions above aren't passing
    // on coincidental string presence. We run `pinned --version` which
    // emits NONE of the demo signals; if any of the demo strings showed
    // up here, the positive control above would be a tautology.
    const result = await runCli(["--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("pinnedai try");
    expect(result.stdout).not.toContain("Generated test file");
    expect(result.stdout).not.toMatch(/Next:|isn't set up for Pinned/);
  });
});
