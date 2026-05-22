// FEATURE: `pinned check --json` (A13) emits a JSON array of Claim
//   objects suitable for piping into jq / consumed by the Action.
// SIGNAL: stdout is parseable JSON (an array); each element has
//   `template` + appropriate slots.
// FALSIFIABILITY: catches a regression where output is no longer
//   valid JSON, or where field names change silently (downstream
//   tools break).

import { describe, it, expect } from "vitest";
import { runCli } from "./runCli.js";

describe("FEATURE-AUDIT: `pinned check --json` shape", () => {
  it("POSITIVE CONTROL: stdout parses as JSON array of claim objects", async () => {
    const result = await runCli([
      "check",
      "--description",
      "Rate-limits /api/users to 60 req/min. Auth required on /api/admin.",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toHaveProperty("template");
    expect(parsed[0]).toHaveProperty("route");
    expect(parsed[0]).toHaveProperty("raw");
  });

  it("POSITIVE CONTROL: no claims → empty JSON array, not error", async () => {
    const result = await runCli([
      "check",
      "--description",
      "Just a typo fix.",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toEqual([]);
  });

  it("NEGATIVE CONTROL: human-mode (no --json) is NOT parseable JSON", async () => {
    const result = await runCli([
      "check",
      "--description",
      "Auth required on /api/x.",
    ]);
    expect(result.exitCode).toBe(0);
    expect(() => JSON.parse(result.stdout)).toThrow();
  });

  it("FALSIFIABILITY: JSON template values are exactly canonical names (catches renames)", async () => {
    const result = await runCli([
      "check",
      "--description",
      "Rate-limits /a to 1 req/min. Auth required on /b. Makes /c idempotent on id.",
      "--json",
    ]);
    const parsed = JSON.parse(result.stdout);
    const templates = parsed.map((c: { template: string }) => c.template).sort();
    expect(templates).toEqual(["auth-required", "idempotent", "rate-limit"]);
  });
});
