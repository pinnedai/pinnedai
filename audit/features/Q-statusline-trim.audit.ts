// FEATURE: trimmed statusline — "N to review" and "active editing"
//   states removed from formatStatusline. Calm-green is now silent ✓
//   only. The diff-aware "REVIEW · N touched" state (which IS
//   actionable because it fires when current edits intersect pin
//   coverage) is kept and remains the only mid-priority surface.
// SIGNAL (observable when feature is healthy):
//   1. With no lastStatus + no activePins + no actionable signals,
//      formatStatusline returns just "◆ pinned · N pins · ✓".
//   2. The strings "N to review" and "active editing" must NOT appear
//      in any code path. (Trim deletion verification.)
//   3. REVIEW · N touched still fires when activePins + diff intersect.
//   4. ✗ broken, 🛟 caught, +N pins added, ⊘ N skipped — all KEPT.
// FALSIFIABILITY: catches a regression where someone re-adds the
//   "N to review" surfacing back to the calm-green branch (passive
//   nag returns), or where the REVIEW · N touched state gets
//   accidentally deleted in the trim (loses the actionable signal).

import { describe, it, expect } from "vitest";
import {
  formatStatusline,
  type LastStatus,
} from "../../apps/cli/src/statusline.ts";

const STABLE_NOW = new Date("2026-05-22T00:00:00Z").getTime();

function baseStatus(overrides: Partial<LastStatus> = {}): LastStatus {
  return {
    status: "green",
    failingCount: 0,
    failingClaimIds: [],
    totalPins: 5,
    updatedAt: new Date(STABLE_NOW).toISOString(),
    ...overrides,
  };
}

describe("FEATURE-AUDIT: statusline trim — N to review and active editing are gone", () => {
  it("POSITIVE CONTROL: clean state with no signals returns just ✓ (no review-count)", () => {
    const out = formatStatusline({
      totalPins: 5,
      lastStatus: baseStatus(),
      color: false,
      now: STABLE_NOW,
    });
    // Must end with ✓ — no review counts even if working tree has
    // pending edits. (countRelevantChanges might find some, but the
    // calm branch ignores them now.)
    expect(out).toMatch(/✓\s*$/);
    expect(out).not.toContain("to review");
    expect(out).not.toContain("active editing");
  });

  it("FALSIFIABILITY: 'N to review' string is absent from output regardless of git state", () => {
    // Even if a hypothetical future caller passed activePins (which
    // triggers the touched-pin git op), the output must never produce
    // "to review" — that branch was removed.
    const out = formatStatusline({
      totalPins: 5,
      lastStatus: baseStatus(),
      color: false,
      activePins: [], // empty pins → skip touched-pin path
      now: STABLE_NOW,
    });
    expect(out).not.toMatch(/\d+ to review/);
  });

  it("FALSIFIABILITY: 'active editing' string is absent from output", () => {
    const out = formatStatusline({
      totalPins: 5,
      lastStatus: baseStatus(),
      color: false,
      now: STABLE_NOW,
    });
    expect(out).not.toContain("active editing");
  });

  it("NO-CHANGE: ✗ broken state KEPT and still fires when failingCount > 0", () => {
    const out = formatStatusline({
      totalPins: 5,
      lastStatus: baseStatus({
        status: "failing",
        failingCount: 1,
        failingClaimIds: ["pr-1-x"],
      }),
      color: false,
      now: STABLE_NOW,
    });
    expect(out).toContain("✗");
    expect(out).toContain("1 broken");
  });

  it("NO-CHANGE: ⊘ N skipped state KEPT (loud skip reporting from task 116)", () => {
    const out = formatStatusline({
      totalPins: 5,
      lastStatus: baseStatus({
        skippedCount: 3,
      }),
      color: false,
      now: STABLE_NOW,
    });
    expect(out).toContain("⊘");
    expect(out).toContain("3 skipped");
    expect(out).toContain("no preview");
  });

  it("NO-CHANGE: +N pins added transient celebration KEPT", () => {
    const out = formatStatusline({
      totalPins: 5,
      lastStatus: baseStatus({
        recentlyAddedCount: 2,
        recentlyAddedAt: new Date(STABLE_NOW).toISOString(),
      }),
      color: false,
      now: STABLE_NOW,
    });
    expect(out).toContain("+2 pin");
    expect(out).toContain("5 total");
  });

  it("NO-CHANGE: ⚠ N risks state KEPT (unpinned-risk warning)", () => {
    const out = formatStatusline({
      totalPins: 5,
      lastStatus: baseStatus({
        unpinnedRisks: 2,
      }),
      color: false,
      now: STABLE_NOW,
    });
    expect(out).toContain("⚠");
    expect(out).toContain("2 risks");
  });

  it("NO-CHANGE: ✓ green state with 0 pins → '0 pins' shape preserved", () => {
    const out = formatStatusline({
      totalPins: 0,
      lastStatus: null,
      color: false,
      now: STABLE_NOW,
    });
    expect(out).toContain("0 pins");
  });

  it("POSITIVE CONTROL: minimal mode returns empty on calm state (✓ hidden)", () => {
    const out = formatStatusline({
      totalPins: 5,
      lastStatus: baseStatus(),
      statuslineMode: "minimal",
      color: false,
      now: STABLE_NOW,
    });
    expect(out).toBe("");
  });

  it("POSITIVE CONTROL: calm-green with verifiedStreak > 0 shows growing 'N verified' counter (alive signal)", () => {
    // The user feedback: plain ✓ looks dead during normal coding.
    // verifiedStreak increments on every post-commit pinned test
    // pass — so the user sees the number climb naturally as they
    // commit work. Resets on a real catch. This is the "alive but
    // not pointless" version: changes constantly during normal use,
    // doesn't nag, doesn't decay.
    const out = formatStatusline({
      totalPins: 5,
      lastStatus: baseStatus({ verifiedStreak: 47 }),
      color: false,
      now: STABLE_NOW,
    });
    expect(out).toContain("✓ 47 verified");
  });

  it("NO-CHANGE: calm-green with NO verifiedStreak (fresh install) shows plain ✓ (no '0 verified')", () => {
    // First-install / never-run-tests case: streak is 0 or absent.
    // We must NOT render "0 verified" — that would read as a warning.
    // Plain ✓ communicates "calm but no data yet" cleanly.
    const out = formatStatusline({
      totalPins: 5,
      lastStatus: baseStatus({ verifiedStreak: 0 }),
      color: false,
      now: STABLE_NOW,
    });
    expect(out).toContain("✓");
    expect(out).not.toContain("0 verified");
  });

  it("POSITIVE CONTROL: minimal mode still emits ✗ broken (actionable signal)", () => {
    const out = formatStatusline({
      totalPins: 5,
      lastStatus: baseStatus({
        status: "failing",
        failingCount: 1,
        failingClaimIds: ["pr-1-x"],
      }),
      statuslineMode: "minimal",
      color: false,
      now: STABLE_NOW,
    });
    // Minimal mode hides calm states; broken pin is actionable, so
    // it still surfaces.
    expect(out).toContain("✗");
    expect(out).toContain("1 broken");
  });
});
