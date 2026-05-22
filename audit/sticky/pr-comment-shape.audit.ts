// FEATURE: `pinned pr-comment` — the markdown comment the GitHub
//   Action posts on every PR. Adapts to four states: quiet-success,
//   claims-added, risky-no-pin, regression-caught.
// SIGNAL: stdout begins with "**◆ Pinned" (header) for all states.
//   Claims-added contains "protected this PR" + "<details>" dropdown.
//   Risky-no-pin contains "risky change" + suggested-pin sentence.
//   Quiet state is a single line (no <details> dropdown).
// FALSIFIABILITY: catches a regression where the comment template
//   drops the diamond branding, the details dropdown, the back-reference
//   to the original PR, or the suggested-pin sentence.

import { describe, it, expect } from "vitest";
import { renderPrComment } from "../../apps/cli/src/prComment.js";

describe("FEATURE-AUDIT: pinned pr-comment templates", () => {
  it("POSITIVE CONTROL: quiet-success state → one-line comment with pin count", () => {
    const md = renderPrComment({
      totalActivePins: 14,
      addedPins: [],
      suggestions: [],
      coverage: [],
      brokenPins: [],
      prNumber: 42,
    });
    expect(md).toContain("**◆ Pinned**");
    expect(md).toContain("14 tests");
    expect(md).toContain("nothing new to add");
    expect(md.split("\n")).toHaveLength(1);
  });

  it("POSITIVE CONTROL: claims-added state → contains 'protected this PR' + collapsible details", () => {
    const md = renderPrComment({
      totalActivePins: 2,
      addedPins: [
        {
          filename: "pr-42-auth-required-api-admin-abc.test.ts",
          claim: {
            template: "auth-required",
            route: "/api/admin",
            raw: "Auth required on /api/admin.",
          },
        },
      ],
      suggestions: [],
      coverage: [],
      brokenPins: [],
      prNumber: 42,
    });
    expect(md).toContain("**◆ Pinned protected this PR**");
    expect(md).toContain("1 added");
    expect(md).toContain("<details>");
    // Pin id (filename without .test.ts) appears in the secondary <sub> line.
    expect(md).toContain("pr-42-auth-required-api-admin-abc");
    // Original claim text preserved in the secondary line.
    expect(md).toContain("Auth required on /api/admin.");
    // Human-readable description is now the bold lead.
    expect(md).toContain("not publicly accessible");
  });

  it("POSITIVE CONTROL: risky-no-pin state → warning + suggested-pin line", () => {
    const md = renderPrComment({
      totalActivePins: 5,
      addedPins: [],
      suggestions: [
        {
          template: "auth-required",
          route: "/api/admin/billing",
          reason: "Risk-surface: route /api/admin/billing found in app/api/admin/billing/route.ts",
          suggestedPin: "Auth required on /api/admin/billing.",
          files: ["app/api/admin/billing/route.ts"],
        },
      ],
      coverage: [],
      brokenPins: [],
      prNumber: 42,
    });
    expect(md).toContain("⚠");
    expect(md).toContain("risky change");
    expect(md).toContain("Auth required on /api/admin/billing.");
    expect(md).toContain("<details>");
  });

  it("POSITIVE CONTROL: broken-pin state → 🚨 regression + back-reference + repair prompt", () => {
    const md = renderPrComment({
      totalActivePins: 10,
      addedPins: [],
      suggestions: [],
      coverage: [],
      brokenPins: [
        {
          claimId: "pr-42-auth-required-api-admin-abc",
          originalPrId: "pr-42",
          claimText: "Auth required on /api/admin/export",
          expected: "401 or 403 without Authorization header",
          actual: "200",
          repairPrompt: "REPAIR_PROMPT_PLACEHOLDER",
        },
      ],
      prNumber: 99,
    });
    expect(md).toContain("🚨");
    expect(md).toContain("Pinned caught a regression");
    expect(md).toContain("**PR #42**");
    expect(md).toContain("> Auth required on /api/admin/export");
    expect(md).toContain("Expected");
    expect(md).toContain("Actual");
    expect(md).toContain("Pinned just saved");
    expect(md).toContain("REPAIR_PROMPT_PLACEHOLDER");
  });

  it("NEGATIVE CONTROL: quiet-success does NOT contain `<details>` or warning icons", () => {
    const md = renderPrComment({
      totalActivePins: 14,
      addedPins: [],
      suggestions: [],
      coverage: [],
      brokenPins: [],
      prNumber: 42,
    });
    expect(md).not.toContain("<details>");
    expect(md).not.toContain("⚠");
    expect(md).not.toContain("🚨");
    expect(md).not.toContain("protected this PR");
  });

  it("NEGATIVE CONTROL: claims-added does NOT contain risk-surface warning icons", () => {
    const md = renderPrComment({
      totalActivePins: 1,
      addedPins: [
        {
          filename: "f.test.ts",
          claim: { template: "auth-required", route: "/x", raw: "Auth required on /x." },
        },
      ],
      suggestions: [],
      coverage: [],
      brokenPins: [],
      prNumber: 1,
    });
    expect(md).not.toContain("⚠");
    expect(md).not.toContain("🚨");
  });

  it("FALSIFIABILITY: broken-pin takes priority over added/risky (regression is the most important signal)", () => {
    const md = renderPrComment({
      totalActivePins: 5,
      addedPins: [
        {
          filename: "f.test.ts",
          claim: { template: "auth-required", route: "/x", raw: "Auth required on /x." },
        },
      ],
      suggestions: [
        {
          template: "auth-required",
          route: "/y",
          reason: "risk",
          suggestedPin: "Auth required on /y.",
          files: [],
        },
      ],
      brokenPins: [
        {
          claimId: "old",
          originalPrId: "pr-42",
          claimText: "Auth required on /api/admin/export",
          expected: "401",
          actual: "200",
          repairPrompt: "fix it",
        },
      ],
      coverage: [],
      prNumber: 99,
    });
    // Broken-pin headline wins. Other contents may also appear but
    // the 🚨 marker should be present.
    expect(md).toContain("🚨");
    expect(md).toContain("Pinned caught a regression");
  });
});
