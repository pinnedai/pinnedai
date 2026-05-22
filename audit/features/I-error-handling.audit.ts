// FEATURE: Error handling — graceful failures (I.2, I.5, I.6)
// SIGNAL: each error condition produces a specific, helpful message
//   AND non-zero exit code (where appropriate). No crashes, no
//   silent no-ops on documented edge cases.

import { describe, it, expect } from "vitest";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runCli, makeTempRepo } from "./runCli.js";

describe("FEATURE-AUDIT: I2 — empty input gracefully errors", () => {
  it("POSITIVE CONTROL: `pinned check` with no description + no stdin + no env → clear error, exit 1", async () => {
    const result = await runCli(["check"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No PR description provided");
  });

  it("NEGATIVE CONTROL: --description with real content does NOT trigger the error", async () => {
    const result = await runCli([
      "check",
      "--description",
      "Auth required on /api/x.",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("No PR description provided");
  });
});

describe("FEATURE-AUDIT: I6 — running outside GitHub Actions doesn't crash", () => {
  it("POSITIVE CONTROL: `pinned check` outside GHA succeeds (regex-only mode)", async () => {
    // GITHUB_ACTIONS is unset by default in tests; llmExtract returns
    // {ok:false, reason:"no-oidc-context"} and the CLI continues
    // with regex-only output. No crash.
    const result = await runCli([
      "check",
      "--description",
      "Auth required on /api/x.",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Found 1 claim(s)");
  });

  it("NEGATIVE CONTROL: explicit GITHUB_ACTIONS=true without OIDC vars surfaces an error", async () => {
    const result = await runCli(
      ["check", "--description", "Auth required on /api/x."],
      { env: { GITHUB_ACTIONS: "true" } }
    );
    // Regex still produces a claim (exit 0), but stderr should
    // mention the missing OIDC config because we tried the LLM path.
    expect(result.stdout).toContain("Found 1 claim(s)");
    expect(result.stderr.toLowerCase()).toMatch(
      /oidc|id-token|llm extraction failed/
    );
  });
});

describe("FEATURE-AUDIT: I5 — generated tests fail clearly when PREVIEW_URL is missing", () => {
  it("POSITIVE CONTROL: generated test file references PREVIEW_URL + a doc link in error message", async () => {
    const cwd = makeTempRepo();
    try {
      await runCli(["init"], { cwd, cleanup: false });
      await runCli(
        [
          "generate",
          "--pr-id",
          "audit",
          "--description",
          "Rate-limits /api/x to 5 req/min.",
        ],
        { cwd, cleanup: false }
      );
      const files = readdirSync(join(cwd, "tests/pinned")).filter((n) =>
        n.endsWith(".test.ts")
      );
      const { readFileSync } = await import("node:fs");
      const content = readFileSync(
        join(cwd, "tests/pinned", files[0]),
        "utf8"
      );
      expect(content).toContain("PREVIEW_URL");
      expect(content).toContain("pinnedai.dev/docs/preview-url");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
