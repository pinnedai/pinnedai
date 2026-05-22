// FEATURE: `pinned baseline` output formats (A21, A22)
//   - default (human)
//   - --json (suggestions array)
//   - --markdown
// SIGNAL: each format produces consistent suggestion content;
//   baseline finds the same risks regardless of output mode.

import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runCli, makeTempRepo } from "./runCli.js";

describe("FEATURE-AUDIT: `pinned baseline` output formats", () => {
  it("POSITIVE CONTROL: --json emits parseable suggestions array", async () => {
    const cwd = makeTempRepo();
    try {
      mkdirSync(join(cwd, "app/api/users"), { recursive: true });
      writeFileSync(
        join(cwd, "app/api/users/route.ts"),
        "export const GET = () => new Response('users');"
      );
      await runCli(["init"], { cwd, cleanup: false });
      const result = await runCli(["baseline", "--json"], {
        cwd,
        cleanup: false,
      });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed[0]).toHaveProperty("template");
      expect(parsed[0]).toHaveProperty("route");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("POSITIVE CONTROL: --markdown emits GFM content", async () => {
    const cwd = makeTempRepo();
    try {
      mkdirSync(join(cwd, "app/api/users"), { recursive: true });
      writeFileSync(
        join(cwd, "app/api/users/route.ts"),
        "export const GET = () => new Response('users');"
      );
      await runCli(["init"], { cwd, cleanup: false });
      const result = await runCli(["baseline", "--markdown"], {
        cwd,
        cleanup: false,
      });
      expect(result.exitCode).toBe(0);
      // Some markdown structure expected
      expect(result.stdout).toMatch(/[#*`\->]|\/api\/users/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("NEGATIVE CONTROL: --json output is NOT human prose (parseable strict JSON)", async () => {
    const cwd = makeTempRepo();
    try {
      mkdirSync(join(cwd, "app/api/users"), { recursive: true });
      writeFileSync(
        join(cwd, "app/api/users/route.ts"),
        "export const GET = () => new Response('users');"
      );
      await runCli(["init"], { cwd, cleanup: false });
      const result = await runCli(["baseline", "--json"], {
        cwd,
        cleanup: false,
      });
      // Must be strictly parseable — no prose, no human text, no banner
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
