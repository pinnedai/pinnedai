// Tests for the bugs Cipherwake's dogfood Claude reported on
// socialideagen against 0.5.0-beta.8. Five P0s, all in one file
// because they form a single discipline check: "trust-killer false
// positives on a healthy repo."
//
// Bug #1 — page-render pin fetches literal /preview/[slug] → 404.
// Bug #2 — infra-failure labeled but vitest still RED.
// Bug #3 — journey pins auto-written despite LOW deferral.
// Bug #4 — stale-template hint missing from failure prompt.
// Bug #6 — last-edit-context.json silently absent.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { detectNewPagesInDiff } from "./scanDiff.js";
import { generatePageRendersTest } from "./templates/pageRenders.js";
import { PINNED_FETCH_HELPER_SRC } from "./templates/sharedFetch.js";
import { recordEditContext } from "./aiModel.js";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "dogfood-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("[bug #1] detectNewPagesInDiff drops dynamic-route page-renders", () => {
  it("does NOT emit a page-renders pin for /preview/[slug]", () => {
    const diff = new Map<string, string[]>();
    diff.set("app/preview/[slug]/page.tsx", [
      "export default function PreviewPage({ params }: any) {",
      "  return <div>{params.slug}</div>;",
      "}",
    ]);
    const hits = detectNewPagesInDiff(diff);
    // Dynamic-route page should be filtered out.
    expect(hits.some((h) => h.route.includes("["))).toBe(false);
  });

  it("DOES emit a page-renders pin for non-dynamic routes (control)", () => {
    const diff = new Map<string, string[]>();
    diff.set("app/about/page.tsx", [
      "export default function About() { return <div>About</div>; }",
    ]);
    const hits = detectNewPagesInDiff(diff);
    expect(hits.some((h) => h.route === "/about")).toBe(true);
  });

  it("template-level guard: if a dynamic route somehow slips through, the emitted test SKIPS via isDynamicRoute", () => {
    const out = generatePageRendersTest(
      { template: "page-renders", route: "/preview/[slug]", raw: "test" },
      { prId: "pr-1", pinnedVersion: "0.5.0-beta.9" }
    );
    expect(out.content).toMatch(/isDynamicRoute/);
    // The skipIf clause now includes isDynamicRoute.
    expect(out.content).toMatch(/skipIf.*isDynamicRoute/);
    // And a stderr warning to direct the user to render-collection.
    expect(out.content).toMatch(/render add.*from collection-getter/);
  });
});

describe("[bug #2] pinnedWrapInfra now calls ctx.skip() instead of throwing", () => {
  it("the shared fetch helper passes ctx into the body function", () => {
    // The signature changed: pinnedWrapInfra(reason, body: (ctx) => ...).
    // Static assertion that the source carries the new signature.
    expect(PINNED_FETCH_HELPER_SRC).toMatch(/ctx\.skip\(/);
    expect(PINNED_FETCH_HELPER_SRC).toMatch(/SKIPPED/i);
  });

  it("emitted page-renders test calls the wrapper with a ctx-aware body", () => {
    const out = generatePageRendersTest(
      { template: "page-renders", route: "/", raw: "test" },
      { prId: "pr-1", pinnedVersion: "0.5.0-beta.9" }
    );
    expect(out.content).toMatch(/pinnedWrapInfra\([^,]+, async \(ctx\)/);
  });

  it("PINNED_TREAT_INFRA_AS_CATCH=1 reverts to throw-and-fail (escape hatch preserved)", () => {
    expect(PINNED_FETCH_HELPER_SRC).toMatch(/PINNED_TREAT_INFRA_AS_CATCH/);
  });
});

describe("[bug #3] init --auto defers journey templates alongside page-renders / happy-path", () => {
  it("LOW_VALUE_TEMPLATES set in cli.ts includes journey", () => {
    const src = readFileSync(join(process.cwd(), "src/cli.ts"), "utf8");
    expect(src).toMatch(/LOW_VALUE_TEMPLATES[^]*"journey"/);
  });

  it("retroJourneys path is gated by lowDeferredJourneyCount (not auto-written)", () => {
    const src = readFileSync(join(process.cwd(), "src/cli.ts"), "utf8");
    expect(src).toMatch(/lowDeferredJourneyCount/);
    // The original `for (const j of retroJourneys)` loop is now `for (const j of [] as typeof retroJourneys)`
    // so the body never executes.
    expect(src).toMatch(/for \(const j of \[\] as typeof retroJourneys\)/);
  });

  it("the deferral summary line includes total (suggestions + journeys)", () => {
    const src = readFileSync(join(process.cwd(), "src/cli.ts"), "utf8");
    expect(src).toMatch(/totalLowDeferred/);
  });
});

describe("[bug #4] failureMessage carries the stale-template regenerate hint", () => {
  it("statusline.ts emits a `pinned regenerate --all` hint in failure messages", () => {
    const src = readFileSync(join(process.cwd(), "src/statusline.ts"), "utf8");
    expect(src).toMatch(/pinned regenerate --all/);
    // The hint specifically mentions the phantom-regression class.
    expect(src).toMatch(/phantom.*regression|dynamic-route 404|dead-port/);
  });
});

describe("[bug #6] recordEditContext is observable in stderr", () => {
  it("writes to stderr on success", () => {
    let captured = "";
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (c: any) => {
      captured += typeof c === "string" ? c : c.toString();
      return true;
    };
    try {
      recordEditContext(dir, {
        model: "anthropic:claude:sonnet-4",
        tool: "claude-code",
        signal: "test",
      });
    } finally {
      (process.stderr as any).write = orig;
    }
    expect(captured).toMatch(/pinned \[edit-context\]: wrote/);
    expect(captured).toMatch(/model=anthropic:claude:sonnet-4/);
    // And the file IS on disk.
    expect(existsSync(join(dir, ".pinned", "last-edit-context.json"))).toBe(true);
  });

  it("writes to stderr on failure (mkdirSync throw)", () => {
    // Pass a clearly-invalid path to force a write failure. We
    // simulate by writing to an unwriteable parent — easiest is to
    // pass a null character which fs rejects.
    let captured = "";
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (c: any) => {
      captured += typeof c === "string" ? c : c.toString();
      return true;
    };
    try {
      recordEditContext("/dev/null/cant-mkdir-under-this", {
        model: "x",
        tool: "y",
        signal: "z",
      });
    } finally {
      (process.stderr as any).write = orig;
    }
    expect(captured).toMatch(/pinned \[edit-context\]: FAILED/);
  });
});
