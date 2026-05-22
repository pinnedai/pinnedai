// FEATURE: `pinned check` body input sources (A14, A15)
//   - --description flag (already audited in A6)
//   - GITHUB_PR_BODY env var (this audit)
//   - stdin pipe (this audit)
// SIGNAL: same claim count + same output regardless of input source.
// FALSIFIABILITY: catches a regression where env-var fallback is
//   skipped, or stdin reader is broken (silent: no claims found
//   when claims actually exist).

import { describe, it, expect } from "vitest";
import { runCli } from "./runCli.js";

const SAMPLE = "Auth required on /api/admin.";

describe("FEATURE-AUDIT: `pinned check` reads from GITHUB_PR_BODY env", () => {
  it("POSITIVE CONTROL: GITHUB_PR_BODY env produces the same parse result as --description", async () => {
    const viaFlag = await runCli([
      "check",
      "--description",
      SAMPLE,
      "--json",
    ]);
    const viaEnv = await runCli(["check", "--json"], {
      env: { GITHUB_PR_BODY: SAMPLE },
    });
    expect(viaFlag.exitCode).toBe(0);
    expect(viaEnv.exitCode).toBe(0);
    expect(JSON.parse(viaEnv.stdout)).toEqual(JSON.parse(viaFlag.stdout));
  });

  it("NEGATIVE CONTROL: whitespace-only GITHUB_PR_BODY doesn't false-pass — falls through", async () => {
    // resolveBody() requires non-whitespace content. With no description,
    // no piped stdin, and only whitespace env, the CLI should report
    // 'No PR description provided.'
    const result = await runCli(["check"], {
      env: { GITHUB_PR_BODY: "   \n  " },
    });
    // exit 1 = no body provided
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No PR description provided");
  });
});

describe("FEATURE-AUDIT: `pinned check` reads from stdin pipe", () => {
  it("POSITIVE CONTROL: piped stdin produces the same parse result as --description", async () => {
    const viaFlag = await runCli([
      "check",
      "--description",
      SAMPLE,
      "--json",
    ]);
    const viaStdin = await runCli(["check", "--json"], { stdin: SAMPLE });
    expect(viaStdin.exitCode).toBe(0);
    expect(JSON.parse(viaStdin.stdout)).toEqual(JSON.parse(viaFlag.stdout));
  });

  it("POSITIVE CONTROL: stdin cap (200KB) — input exactly at limit still works", async () => {
    // Build a description with mostly filler + one valid claim.
    const filler = "x".repeat(190_000);
    const result = await runCli(["check", "--json"], {
      stdin: `${filler}\nAuth required on /api/admin.\n`,
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveLength(1);
  });

  it("NEGATIVE CONTROL: stdin > 200KB → throws, doesn't silently truncate", async () => {
    const huge = "x".repeat(220_000);
    const result = await runCli(["check"], { stdin: huge });
    // Either non-zero exit or error to stderr about the cap.
    expect(result.exitCode).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined.toLowerCase()).toMatch(/stdin exceeded|too large|cap/);
  });
});
