import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSmokeMarkers, rollupCoverage, findCoverageGaps } from "./smokeTier0.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pinned-smoke-tier0-"));
  mkdirSync(join(dir, "tests"), { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("findSmokeMarkers — inline markers", () => {
  it("picks up // @pinned-smoke <feature> happy", () => {
    writeFileSync(join(dir, "tests/x.test.ts"), `
      // @pinned-smoke image-generation happy
      import { it } from "vitest";
      it("returns svg", () => {});
    `);
    const ms = findSmokeMarkers(dir);
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({
      feature: "image-generation",
      caseKind: "happy",
    });
  });

  it("picks up multiple case kinds in one file", () => {
    writeFileSync(join(dir, "tests/y.test.ts"), `
      // @pinned-smoke create-user happy
      // @pinned-smoke create-user guard
      // @pinned-smoke create-user failure
      it("...", () => {});
    `);
    const ms = findSmokeMarkers(dir);
    expect(ms.map((m) => m.caseKind).sort()).toEqual(["failure", "guard", "happy"]);
    expect(new Set(ms.map((m) => m.feature))).toEqual(new Set(["create-user"]));
  });

  it("is whitespace-tolerant and case-insensitive on the case kind", () => {
    writeFileSync(join(dir, "tests/z.test.ts"), `
      //@pinned-smoke webhook-stripe FAILURE
      /* @pinned-smoke webhook-stripe Guard */
      it("...", () => {});
    `);
    const ms = findSmokeMarkers(dir);
    expect(ms.map((m) => m.caseKind).sort()).toEqual(["failure", "guard"]);
  });

  it("rejects malformed markers (missing case kind)", () => {
    writeFileSync(join(dir, "tests/bad.test.ts"), `
      // @pinned-smoke missing-case
      // @pinned-smoke feature bogus
      it("...", () => {});
    `);
    const ms = findSmokeMarkers(dir);
    expect(ms).toHaveLength(0);
  });
});

describe("findSmokeMarkers — filename pattern", () => {
  it("recognizes *.smoke.test.ts with no inline marker as unknown-case", () => {
    writeFileSync(join(dir, "tests/job.smoke.test.ts"), `
      it("smoke", () => {});
    `);
    const ms = findSmokeMarkers(dir);
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ feature: "job", caseKind: "unknown" });
  });

  it("does NOT double-count when inline markers are present in a .smoke.test.ts", () => {
    writeFileSync(join(dir, "tests/job.smoke.test.ts"), `
      // @pinned-smoke job happy
      // @pinned-smoke job failure
      it("smoke", () => {});
    `);
    const ms = findSmokeMarkers(dir);
    // No "unknown" entry should appear — only the two inline markers
    expect(ms).toHaveLength(2);
    expect(ms.every((m) => m.caseKind !== "unknown")).toBe(true);
  });

  it("ignores non-test files even if they contain the marker (false-positive guard)", () => {
    writeFileSync(join(dir, "tests/notes.md"), `// @pinned-smoke fake happy`);
    writeFileSync(join(dir, "tests/source.ts"), `// @pinned-smoke fake happy`);
    const ms = findSmokeMarkers(dir);
    expect(ms).toHaveLength(0);
  });

  it("ignores node_modules, dist, .git", () => {
    mkdirSync(join(dir, "node_modules/lib/tests"), { recursive: true });
    mkdirSync(join(dir, "dist/tests"), { recursive: true });
    writeFileSync(join(dir, "node_modules/lib/tests/x.smoke.test.ts"), `it("",()=>{})`);
    writeFileSync(join(dir, "dist/tests/x.smoke.test.ts"), `it("",()=>{})`);
    const ms = findSmokeMarkers(dir);
    expect(ms).toHaveLength(0);
  });
});

describe("rollupCoverage + findCoverageGaps", () => {
  it("rolls up multiple markers per feature into a single coverage row", () => {
    writeFileSync(join(dir, "tests/a.test.ts"), `
      // @pinned-smoke image-gen happy
      // @pinned-smoke image-gen failure
      it("",()=>{})
    `);
    writeFileSync(join(dir, "tests/b.test.ts"), `
      // @pinned-smoke image-gen guard
      it("",()=>{})
    `);
    const ms = findSmokeMarkers(dir);
    const cov = rollupCoverage(ms);
    expect(cov).toHaveLength(1);
    expect(cov[0]).toMatchObject({
      feature: "image-gen",
      hasHappy: true,
      hasGuard: true,
      hasFailure: true,
    });
    expect(cov[0].files.sort()).toEqual(["tests/a.test.ts", "tests/b.test.ts"]);
  });

  it("surfaces gap when failure-case is missing (the load-bearing gap)", () => {
    writeFileSync(join(dir, "tests/c.test.ts"), `
      // @pinned-smoke checkout happy
      // @pinned-smoke checkout guard
      it("",()=>{})
    `);
    const gaps = findCoverageGaps(rollupCoverage(findSmokeMarkers(dir)));
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      feature: "checkout",
      missing: ["failure"],
    });
  });

  it("sorts features with worst coverage first", () => {
    writeFileSync(join(dir, "tests/full.test.ts"), `
      // @pinned-smoke complete happy
      // @pinned-smoke complete guard
      // @pinned-smoke complete failure
      it("",()=>{})
    `);
    writeFileSync(join(dir, "tests/partial.test.ts"), `
      // @pinned-smoke partial happy
      it("",()=>{})
    `);
    const cov = rollupCoverage(findSmokeMarkers(dir));
    expect(cov[0].feature).toBe("partial");
    expect(cov[1].feature).toBe("complete");
  });

  it("returns no gaps when feature has all three cases", () => {
    writeFileSync(join(dir, "tests/d.test.ts"), `
      // @pinned-smoke ok happy
      // @pinned-smoke ok guard
      // @pinned-smoke ok failure
      it("",()=>{})
    `);
    const gaps = findCoverageGaps(rollupCoverage(findSmokeMarkers(dir)));
    expect(gaps).toHaveLength(0);
  });
});
