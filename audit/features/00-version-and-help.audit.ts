// FEATURE: `pinned --version` + `pinned --help` (A2, A3)
// SIGNAL: --version prints the exact value in package.json's version
//   field; --help lists each subcommand by name.
// FALSIFIABILITY: catches Commander mis-registration, version drift,
//   or a subcommand silently dropped.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runCli } from "./runCli.js";

const PKG_VERSION = JSON.parse(
  readFileSync(
    resolve(
      new URL(import.meta.url).pathname,
      "..",
      "..",
      "..",
      "apps",
      "cli",
      "package.json"
    ),
    "utf8"
  )
).version;

describe("FEATURE-AUDIT: `pinned --version` prints package.json version", () => {
  it("POSITIVE CONTROL: stdout matches apps/cli/package.json version exactly", async () => {
    const result = await runCli(["--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(PKG_VERSION);
  });

  it("FALSIFIABILITY: version is semver-shaped (catches accidental version-string drift)", () => {
    expect(PKG_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("FEATURE-AUDIT: `pinned --help` lists every subcommand", () => {
  it("POSITIVE CONTROL: stdout names all 11 subcommands", async () => {
    const result = await runCli(["--help"]);
    expect(result.exitCode).toBe(0);
    const expected = [
      "try",
      "check",
      "generate",
      "init",
      "list",
      "retire",
      "scan",
      "baseline",
      "doctor",
      "ai-rules",
      "pr-comment",
    ];
    for (const cmd of expected) {
      expect(result.stdout).toContain(cmd);
    }
  });

  it("NEGATIVE CONTROL: --help doesn't mention non-existent commands", async () => {
    const result = await runCli(["--help"]);
    expect(result.stdout).not.toContain("nuclear-launch");
    expect(result.stdout).not.toContain("delete-all-data");
  });
});
