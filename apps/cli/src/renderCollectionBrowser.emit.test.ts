// Emit-shape unit tests for the [BETA] browser render template.
// These run in ~100ms (no browser launch) and lock the
// non-execution invariants — the failure paths that would have
// shipped silently in 0.5.0-beta without coverage.

import { describe, it, expect } from "vitest";
import { generateRenderCollectionBrowserTest } from "./templates/renderCollectionBrowser.js";

const baseClaim = {
  template: "render-collection" as const,
  pathTemplate: "/preview/[slug]",
  route: "/preview/[slug]",
  routes: { from: "collection-getter" as const, modulePath: "lib/ideas.ts", exportName: "getAll", slugField: "slug" },
  expect: { status: 200 },
  cap: { maxRoutes: 20, sample: "deterministic" as const },
  raw: "test",
};

describe("renderCollectionBrowser emit", () => {
  it("filename carries a -browser suffix so it's visible in PINS.md / vitest", () => {
    const out = generateRenderCollectionBrowserTest(
      { ...baseClaim, browser: { check: ["images", "console"] } },
      { prId: "pr-1", pinnedVersion: "0.5.0-beta" }
    );
    expect(out.filename).toMatch(/-browser\.test\.ts$/);
    expect(out.claimId).toMatch(/-browser$/);
  });

  it("emitted code labels BETA in the describe block", () => {
    const out = generateRenderCollectionBrowserTest(
      { ...baseClaim, browser: { check: ["images", "console"] } },
      { prId: "pr-1", pinnedVersion: "0.5.0-beta" }
    );
    expect(out.content).toMatch(/\[BETA\]/);
  });

  it("emitted code does NOT statically import 'playwright' (must be runtime dynamic import — keeps the test parsable when Playwright is missing)", () => {
    const out = generateRenderCollectionBrowserTest(
      { ...baseClaim, browser: { check: ["images", "console"] } },
      { prId: "pr-1", pinnedVersion: "0.5.0-beta" }
    );
    // The static import line would be `import .* from "playwright"` —
    // exclude TS-flavored shapes that COULD legitimately appear in a
    // comment. We just check there's no top-level static import.
    const lines = out.content.split("\n");
    const staticPwImport = lines.find((l) =>
      /^import\b[^"']*\bfrom\s+["']playwright["']/.test(l)
    );
    expect(staticPwImport).toBeUndefined();
    expect(out.content).toMatch(/await import\("playwright"/);
  });

  it("emitted code skips with WARN when Playwright import fails (adoption-first)", () => {
    const out = generateRenderCollectionBrowserTest(
      { ...baseClaim, browser: { check: ["images", "console"] } },
      { prId: "pr-1", pinnedVersion: "0.5.0-beta" }
    );
    expect(out.content).toMatch(/Playwright not installed/);
    expect(out.content).toMatch(/npm i -D playwright/);
  });

  it("emitted code reads PREVIEW_URL / PINNED_BASE_URL and skips when none is set", () => {
    const out = generateRenderCollectionBrowserTest(
      { ...baseClaim, browser: { check: ["images", "console"] } },
      { prId: "pr-1", pinnedVersion: "0.5.0-beta" }
    );
    expect(out.content).toMatch(/PINNED_BASE_URL/);
    expect(out.content).toMatch(/PREVIEW_URL/);
    expect(out.content).toMatch(/no base URL/);
  });

  it("emitted code includes the image-check branch when check includes 'images'", () => {
    const out = generateRenderCollectionBrowserTest(
      { ...baseClaim, browser: { check: ["images"] } },
      { prId: "pr-1", pinnedVersion: "0.5.0-beta" }
    );
    expect(out.content).toMatch(/naturalWidth === 0/);
    expect(out.content).toMatch(/broken images/i);
    // Should still parse: const CHECK_IMAGES = true; CHECK_CONSOLE = false
    expect(out.content).toMatch(/CHECK_IMAGES = true/);
    expect(out.content).toMatch(/CHECK_CONSOLE = false/);
  });

  it("emitted code includes the console-check branch when check includes 'console'", () => {
    const out = generateRenderCollectionBrowserTest(
      { ...baseClaim, browser: { check: ["console"] } },
      { prId: "pr-1", pinnedVersion: "0.5.0-beta" }
    );
    expect(out.content).toMatch(/securitypolicyviolation/);
    expect(out.content).toMatch(/CSP violation/);
    expect(out.content).toMatch(/CHECK_CONSOLE = true/);
    expect(out.content).toMatch(/CHECK_IMAGES = false/);
  });

  it("throws when called on a claim without .browser (caller should dispatch to HTTP template)", () => {
    expect(() =>
      generateRenderCollectionBrowserTest(
        { ...baseClaim, browser: undefined },
        { prId: "pr-1", pinnedVersion: "0.5.0-beta" }
      )
    ).toThrow(/without \.browser/);
  });

  it("respects the maxRoutes cap from claim.cap", () => {
    const out = generateRenderCollectionBrowserTest(
      { ...baseClaim, cap: { maxRoutes: 7, sample: "deterministic" }, browser: { check: ["images"] } },
      { prId: "pr-1", pinnedVersion: "0.5.0-beta" }
    );
    expect(out.content).toMatch(/MAX_ROUTES = 7/);
  });

  it("respects the per-route timeoutMs from claim.browser", () => {
    const out = generateRenderCollectionBrowserTest(
      { ...baseClaim, browser: { check: ["images"], timeoutMs: 9999 } },
      { prId: "pr-1", pinnedVersion: "0.5.0-beta" }
    );
    expect(out.content).toMatch(/PAGE_TIMEOUT_MS = 9999/);
  });

  it("respects waitForNetworkIdle=false from claim.browser", () => {
    const out = generateRenderCollectionBrowserTest(
      { ...baseClaim, browser: { check: ["images"], waitForNetworkIdle: false } },
      { prId: "pr-1", pinnedVersion: "0.5.0-beta" }
    );
    expect(out.content).toMatch(/WAIT_FOR_NETWORK_IDLE = false/);
    expect(out.content).toMatch(/waitUntil: WAIT_FOR_NETWORK_IDLE \? "networkidle" : "load"/);
  });
});
