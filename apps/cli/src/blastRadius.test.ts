import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDependencyGraph,
  affectedFiles,
  buildSmokePinIndex,
  filesForSmokeClaim,
  affectedSmokePins,
} from "./blastRadius.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blast-radius-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("buildDependencyGraph + affectedFiles", () => {
  it("finds direct importer of a file", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/util.ts"), "export const x = 1;");
    writeFileSync(join(dir, "src/main.ts"), `import { x } from "./util";`);
    const g = buildDependencyGraph(dir);
    expect(g.importers.get("src/util.ts")).toBeDefined();
    expect(g.importers.get("src/util.ts")!.has("src/main.ts")).toBe(true);
  });

  it("walks importers transitively (multi-hop blast-radius)", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/base.ts"), "export const b = 1;");
    writeFileSync(join(dir, "src/middle.ts"), `import { b } from "./base"; export const m = b;`);
    writeFileSync(join(dir, "src/top.ts"), `import { m } from "./middle"; export const t = m;`);
    const g = buildDependencyGraph(dir);
    const affected = affectedFiles(g, ["src/base.ts"]);
    expect(affected.has("src/base.ts")).toBe(true);
    expect(affected.has("src/middle.ts")).toBe(true);
    expect(affected.has("src/top.ts")).toBe(true);
  });

  it("respects maxDepth", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/a.ts"), "export const a = 1;");
    writeFileSync(join(dir, "src/b.ts"), `import "./a";`);
    writeFileSync(join(dir, "src/c.ts"), `import "./b";`);
    writeFileSync(join(dir, "src/d.ts"), `import "./c";`);
    const g = buildDependencyGraph(dir);
    const at1 = affectedFiles(g, ["src/a.ts"], { maxDepth: 1 });
    expect(at1.has("src/b.ts")).toBe(true);
    expect(at1.has("src/c.ts")).toBe(false);
  });

  it("does NOT follow bare module imports", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/main.ts"), `import { z } from "zod";`);
    const g = buildDependencyGraph(dir);
    // No internal edge created — "zod" is bare
    expect(g.importers.size).toBe(0);
  });

  it("ignores node_modules", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "node_modules/lib"), { recursive: true });
    writeFileSync(join(dir, "src/util.ts"), "export const x = 1;");
    writeFileSync(join(dir, "node_modules/lib/junk.ts"), `import "../../src/util";`);
    const g = buildDependencyGraph(dir);
    // node_modules wasn't walked so no edge from junk.ts
    expect(g.importers.get("src/util.ts")).toBeUndefined();
  });
});

describe("smoke pin index", () => {
  it("indexes fn entrypoint smoke pins by module path", () => {
    const idx = buildSmokePinIndex([
      {
        claimId: "p1",
        claim: {
          template: "smoke-functional",
          route: "greet",
          entrypoint: { kind: "fn", modulePath: "src/lib/greet.ts", exportName: "greet", args: [] },
        },
      },
      {
        claimId: "p2",
        claim: {
          template: "smoke-functional",
          route: "/api/x",
          entrypoint: { kind: "http-route", method: "GET" },
        },
      },
    ]);
    expect(idx.byFile["src/lib/greet.ts"]).toEqual(["p1"]);
    // http-route pins are not indexed by file
    expect(Object.keys(idx.byFile)).toEqual(["src/lib/greet.ts"]);
  });

  it("handles multiple pins on the same file", () => {
    const idx = buildSmokePinIndex([
      { claimId: "a", claim: { template: "smoke-functional", route: "x", entrypoint: { kind: "fn", modulePath: "src/shared.ts", exportName: "x" } } },
      { claimId: "b", claim: { template: "smoke-functional", route: "y", entrypoint: { kind: "fn", modulePath: "src/shared.ts", exportName: "y" } } },
    ]);
    expect(idx.byFile["src/shared.ts"].sort()).toEqual(["a", "b"]);
  });
});

describe("filesForSmokeClaim", () => {
  it("returns empty for http-route entrypoints", () => {
    expect(filesForSmokeClaim({ template: "smoke-functional", route: "/x", entrypoint: { kind: "http-route", method: "GET" } })).toEqual([]);
  });

  it("returns modulePath for fn entrypoints", () => {
    expect(filesForSmokeClaim({ template: "smoke-functional", route: "x", entrypoint: { kind: "fn", modulePath: "src/lib/x.ts", exportName: "x" } })).toEqual(["src/lib/x.ts"]);
  });

  it("returns submit modulePath for job entrypoints with fn submit", () => {
    expect(filesForSmokeClaim({
      template: "smoke-functional",
      route: "job1",
      entrypoint: { kind: "job", submit: { kind: "fn", ref: "src/jobs/run.ts#submitJob" }, poll: {} },
    })).toEqual(["src/jobs/run.ts"]);
  });

  it("returns empty for non-smoke-functional claims", () => {
    expect(filesForSmokeClaim({ template: "rate-limit", route: "/x" })).toEqual([]);
  });
});

describe("affectedSmokePins — the headline integration test", () => {
  it("returns smoke pins whose entrypoint is a dependent of the changed file", () => {
    // Synthetic repo: authHelper.ts is imported by signup.ts; smoke pin
    // p_signup exercises signup.ts. Editing authHelper.ts should trigger
    // p_signup via the blast-radius walk.
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/authHelper.ts"), "export const validate = () => true;");
    writeFileSync(join(dir, "src/signup.ts"), `import { validate } from "./authHelper"; export const signup = () => validate();`);
    const g = buildDependencyGraph(dir);
    const idx = buildSmokePinIndex([
      { claimId: "p_signup", claim: { template: "smoke-functional", route: "signup", entrypoint: { kind: "fn", modulePath: "src/signup.ts", exportName: "signup" } } },
    ]);
    const triggered = affectedSmokePins(idx, ["src/authHelper.ts"], g);
    expect(triggered).toEqual(["p_signup"]);
  });
});
