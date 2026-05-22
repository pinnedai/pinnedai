// FEATURE: CATCHES.md ledger + chat-hook celebration
//   When `pinned test` detects a previously-passing pin now failing,
//   two things happen that didn't before: (1) a structured catch
//   entry is appended to tests/pinned/CATCHES.md with the bad_case
//   description, origin PR, and bug-fix tag; (2) the failure-hook
//   chat injection includes the bad_case in human terms so the AI
//   agent communicates concrete impact to the user.
// SIGNAL (observable when feature is healthy):
//   1. renderCatchesMarkdown with empty history → "No catches yet"
//      message (calm default state, not error).
//   2. renderCatchesMarkdown with one catch → entry contains the
//      claim text, bad_case, origin PR, and a link to the test file.
//   3. failureMessage (chat-hook content) starts with "🛟 Pinned
//      caught a regression" and includes the bad_case for each
//      currently-failing pin.
//   4. bug-fix-origin catches get the 🔁 tag in CATCHES.md.
//   5. Both surfaces show the lifetime "breaks caught" count.
// FALSIFIABILITY: catches regressions where renderCatchesMarkdown
//   silently drops the bad_case field (would lose the human-impact
//   narrative), where the chat-hook reverts to test-name-only output
//   (would lose the "what was caught" framing), or where bug-fix
//   tagging stops propagating from registry → catch record.
// NO-CHANGE direction: with empty catchHistory and breaksCaught=0,
//   CATCHES.md renders the "no catches yet" calm-default state, NOT
//   an error or warning.

import { describe, it, expect } from "vitest";
import { renderCatchesMarkdown } from "../../apps/cli/src/registry.js";
import {
  formatFailureHook,
  type LastStatus,
} from "../../apps/cli/src/statusline.js";

describe("FEATURE-AUDIT: CATCHES.md ledger renders catch evidence", () => {
  it("NO-CHANGE: empty catchHistory renders the calm 'no catches yet' default", () => {
    const md = renderCatchesMarkdown({
      catchHistory: [],
      breaksCaught: 0,
    });
    expect(md).toContain("# Pinned catches");
    expect(md).toContain("No catches yet");
    // Must NOT have any catch entries.
    expect(md).not.toMatch(/^## \d{4}-\d{2}-\d{2}/m);
  });

  it("POSITIVE CONTROL: single catch renders date, claim, bad_case, origin PR, test link", () => {
    const md = renderCatchesMarkdown({
      catchHistory: [
        {
          caughtAt: "2026-05-22T03:45:12Z",
          claimId: "pr-42-auth-required-api-admin-export-abc123",
          claimText: "Auth required on /api/admin/export.",
          template: "auth-required",
          route: "/api/admin/export",
          badCase:
            "an unauthenticated request to /api/admin/export returned 2xx instead of 401/403",
          originPr: "pr-42",
        },
      ],
      breaksCaught: 1,
    });
    expect(md).toContain("Lifetime catches:** 1");
    expect(md).toContain("2026-05-22");
    expect(md).toContain("auth-required on /api/admin/export");
    expect(md).toContain("Auth required on /api/admin/export.");
    expect(md).toContain("Without Pinned, this would have shipped:");
    expect(md).toContain("unauthenticated request to /api/admin/export");
    expect(md).toContain("Originally pinned in:");
    expect(md).toContain("#42");
    expect(md).toContain("Test that caught it:");
    expect(md).toContain("pr-42-auth-required-api-admin-export-abc123");
  });

  it("POSITIVE CONTROL: bug-fix-origin catch gets the 🔁 tag + legend", () => {
    const md = renderCatchesMarkdown({
      catchHistory: [
        {
          caughtAt: "2026-05-22T03:45:12Z",
          claimId: "pr-7-rate-limit-api-users-xyz",
          claimText: "Fixed regression where /api/users rate limit could be bypassed.",
          template: "rate-limit",
          route: "/api/users",
          badCase: "rate limit removed or weakened",
          originPr: "pr-7",
          bugFixOrigin: true,
        },
      ],
      breaksCaught: 1,
    });
    expect(md).toContain("🔁");
    expect(md).toContain("re-caught a regression that was already fixed");
  });

  it("NO-CHANGE: catch entry without bad_case still renders (graceful fallback)", () => {
    // Pre-v0.1 catch records (from cache files written before bad_case
    // was added) don't have the field. The render must NOT crash, just
    // omit the line.
    const md = renderCatchesMarkdown({
      catchHistory: [
        {
          caughtAt: "2026-04-01T00:00:00Z",
          claimId: "pr-1-x",
          claimText: "Some claim.",
          template: "auth-required",
        },
      ],
      breaksCaught: 1,
    });
    expect(md).not.toContain("undefined");
    expect(md).toContain("Some claim");
    // No bad_case line should appear when the field is missing.
    expect(md).not.toContain("Without Pinned, this would have shipped:");
  });

  it("POSITIVE CONTROL: multiple catches render in given order (caller controls sort)", () => {
    const md = renderCatchesMarkdown({
      catchHistory: [
        {
          caughtAt: "2026-05-22T00:00:00Z",
          claimId: "p1",
          template: "auth-required",
          route: "/api/admin",
          claimText: "Auth required on /api/admin.",
        },
        {
          caughtAt: "2026-05-21T00:00:00Z",
          claimId: "p2",
          template: "rate-limit",
          route: "/api/users",
          claimText: "Rate-limits /api/users to 60/min.",
        },
      ],
      breaksCaught: 2,
    });
    const p1Idx = md.indexOf("/api/admin");
    const p2Idx = md.indexOf("/api/users");
    expect(p1Idx).toBeLessThan(p2Idx);
    expect(md).toContain("Lifetime catches:** 2");
  });
});

describe("FEATURE-AUDIT: chat-hook failure message speaks in human terms", () => {
  const baseStatus = (overrides: Partial<LastStatus> = {}): LastStatus => ({
    status: "failing",
    failingCount: 1,
    failingClaimIds: ["pr-42-auth-required-api-admin-export-abc"],
    totalPins: 5,
    updatedAt: "2026-05-22T03:45:12Z",
    ...overrides,
  });

  it("POSITIVE CONTROL: failure message starts with 🛟 Pinned caught a regression", () => {
    const msg = formatFailureHook(baseStatus());
    expect(msg).toMatch(/🛟 Pinned caught a regression/);
  });

  it("POSITIVE CONTROL: failure message includes bad_case for currently-failing pin", () => {
    const status = baseStatus({
      catchHistory: [
        {
          caughtAt: "2026-05-22T03:45:12Z",
          claimId: "pr-42-auth-required-api-admin-export-abc",
          claimText: "Auth required on /api/admin/export.",
          template: "auth-required",
          route: "/api/admin/export",
          badCase:
            "an unauthenticated request to /api/admin/export returned 2xx instead of 401/403",
          originPr: "pr-42",
        },
      ],
    });
    const msg = formatFailureHook(status);
    expect(msg).toContain("Without Pinned, this would have shipped:");
    expect(msg).toContain("unauthenticated request to /api/admin/export");
    expect(msg).toContain("(originally pinned in pr-42)");
  });

  it("POSITIVE CONTROL: failure message includes lifetime catch count + CATCHES.md pointer when > 0", () => {
    const status = baseStatus({
      breaksCaught: 3,
      catchHistory: [
        {
          caughtAt: "2026-05-22T03:45:12Z",
          claimId: "pr-42-auth-required-api-admin-export-abc",
          template: "auth-required",
          route: "/api/admin/export",
        },
      ],
    });
    const msg = formatFailureHook(status);
    expect(msg).toContain("tests/pinned/CATCHES.md");
    expect(msg).toContain("Pinned has caught 3 regressions");
  });

  it("NO-CHANGE: failure message gracefully handles missing catchHistory (pre-v0.1 cache)", () => {
    // Old cache files may not have the catchHistory field. The message
    // must still render without crashing, just without the human-impact
    // bad_case line.
    const msg = formatFailureHook(baseStatus());
    expect(msg).toContain("🛟 Pinned caught a regression");
    expect(msg).toContain("tests/pinned/pr-42-auth-required-api-admin-export-abc.test.ts");
    expect(msg).not.toContain("undefined");
  });

  it("POSITIVE CONTROL: failure message reminds AI to double-confirm before fixing code", () => {
    // The FP-mitigation guidance: catches are double-confirmed, but
    // re-run vitest once if a failure looks unrelated. This protects
    // against AI agents over-eagerly "fixing" code on a flake.
    const msg = formatFailureHook(baseStatus());
    expect(msg).toContain("double-confirmed");
    expect(msg).toContain("re-run");
  });

  it("POSITIVE CONTROL: failure message tells the AI not to weaken pinned tests", () => {
    const msg = formatFailureHook(baseStatus());
    expect(msg).toContain("Do NOT delete or weaken");
  });
});
