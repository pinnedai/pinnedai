// FEATURE: statusline mode-aware states + "caught N break" + decay
// SIGNAL: For each cache state, the statusline emits a specific
//   substring (stripped of ANSI). Priority is fixed.
// FALSIFIABILITY:
//   - POS: each priority level produces the expected substring.
//   - NEG: `off` mode suppresses `+N suggested` even when the cache
//     holds suggestedCount > 0 (regression guard against accidentally
//     re-enabling suggestions in off mode).
//   - NEG: `caught` decays after RECENTLY_CAUGHT_TTL_MS (won't show
//     "caught 1 break" forever).

import { describe, it, expect } from "vitest";
import { formatStatusline, type LastStatus } from "../../apps/cli/src/statusline.js";

function strip(s: string): string {
  // strip ANSI color escape sequences
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

const baseStatus: LastStatus = {
  status: "green",
  failingCount: 0,
  failingClaimIds: [],
  totalPins: 11,
  updatedAt: new Date().toISOString(),
};

describe("FEATURE-AUDIT: statusline `+N suggested` is suppressed in off mode", () => {
  it("POSITIVE CONTROL: ask mode shows `+N suggested` when cache has suggestedCount > 0", () => {
    const out = formatStatusline({
      totalPins: 11,
      lastStatus: { ...baseStatus, suggestedCount: 3 },
      mode: "ask",
      color: false,
    });
    expect(strip(out)).toContain("+3 suggested");
  });

  it("FALSIFIABILITY: off mode does NOT show `+N suggested` even with suggestedCount = 3", () => {
    const out = formatStatusline({
      totalPins: 11,
      lastStatus: { ...baseStatus, suggestedCount: 3 },
      mode: "off",
      color: false,
    });
    // Falls through to calm-green: either plain ✓ (clean tree) or
    // "N changes queued" (uncommitted edits — also a positive state,
    // just signaling there's pending work). Neither is "suggested".
    expect(strip(out)).not.toContain("suggested");
    // Calm-green state can now be: ✓ (clean), "N to review" (Pinned-
    // relevant edits), or "active editing" (non-relevant edits). All
    // three are "positive" outcomes for this test.
    expect(strip(out)).toMatch(/✓|\d+ to review|active editing/);
  });
});

describe("FEATURE-AUDIT: statusline shows transient `+N pins · M total` after auto-protect", () => {
  it("POSITIVE CONTROL: recentlyAdded shown within decay window using `+N pins · M total` format", () => {
    const oneMinAgo = new Date(Date.now() - 60 * 1000).toISOString();
    const out = formatStatusline({
      totalPins: 13,
      lastStatus: {
        ...baseStatus,
        recentlyAddedCount: 2,
        recentlyAddedAt: oneMinAgo,
      },
      mode: "safe",
      color: false,
    });
    expect(strip(out)).toContain("+2 pins");
    expect(strip(out)).toContain("13 total");
  });

  it("FALSIFIABILITY: recentlyAdded decays — 3-min-old stamp falls through to green", () => {
    const threeMinAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    const out = formatStatusline({
      totalPins: 13,
      lastStatus: {
        ...baseStatus,
        recentlyAddedCount: 2,
        recentlyAddedAt: threeMinAgo,
      },
      mode: "safe",
      color: false,
    });
    expect(strip(out)).not.toContain("+2 pins");
    // Calm-green state can now be: ✓ (clean), "N to review" (Pinned-
    // relevant edits), or "active editing" (non-relevant edits). All
    // three are "positive" outcomes for this test.
    expect(strip(out)).toMatch(/✓|\d+ to review|active editing/);
  });
});

describe("FEATURE-AUDIT: statusline shows transient `🛟 caught 1 break` after regression", () => {
  it("POSITIVE CONTROL: lastCatchAt within 30min triggers the caught state", () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const out = formatStatusline({
      totalPins: 11,
      lastStatus: {
        ...baseStatus,
        lastCatchAt: tenMinAgo,
        lastCatchClaimId: "pr-42-auth-required-api-admin-export",
        breaksCaught: 3,
      },
      mode: "safe",
      color: false,
    });
    expect(strip(out)).toContain("caught 1 break");
  });

  it("FALSIFIABILITY: lastCatchAt 31min old does NOT show the caught state", () => {
    const thirtyOneMinAgo = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    const out = formatStatusline({
      totalPins: 11,
      lastStatus: {
        ...baseStatus,
        lastCatchAt: thirtyOneMinAgo,
        breaksCaught: 3,
      },
      mode: "safe",
      color: false,
    });
    expect(strip(out)).not.toContain("caught");
  });
});

describe("FEATURE-AUDIT: priority hierarchy — broken > caught > risks > notes", () => {
  it("POSITIVE CONTROL: broken pin trumps a recent catch (red over green)", () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const out = formatStatusline({
      totalPins: 11,
      lastStatus: {
        ...baseStatus,
        status: "failing",
        failingCount: 1,
        failingClaimIds: ["pr-42"],
        lastCatchAt: tenMinAgo,
        breaksCaught: 3,
      },
      mode: "safe",
      color: false,
    });
    expect(strip(out)).toContain("✗ 1 broken");
    expect(strip(out)).not.toContain("caught");
  });

  it("FALSIFIABILITY: never shows `✗ 0 broken` when failingCount = 0 with status=failing", () => {
    // Guards against a buggy state combination where status==='failing'
    // but no actual failing claims were parsed (e.g. test runner crashed).
    const out = formatStatusline({
      totalPins: 11,
      lastStatus: {
        ...baseStatus,
        status: "failing",
        failingCount: 0,
      },
      mode: "safe",
      color: false,
    });
    expect(strip(out)).not.toContain("✗ 0 broken");
  });
});

describe("FEATURE-AUDIT: `check pending` is opt-in + stale-gated", () => {
  // The state surfaces ONLY when: showPendingChanges=true AND working
  // tree differs from cache AND last check is > 10min old. This combo
  // prevents it from showing during normal active editing.
  it("POSITIVE CONTROL: drifted + stale cache + opt-in flag → shows `check pending`", () => {
    const elevenMinAgo = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    const out = formatStatusline({
      totalPins: 11,
      lastStatus: {
        ...baseStatus,
        updatedAt: elevenMinAgo,
        lastCheckedSha: "abc123" + "0".repeat(34),
        lastCheckedDirtyHash: "deadbeef0000beef",
      },
      mode: "safe",
      color: false,
      showPendingChanges: true,
    });
    expect(strip(out)).toContain("check pending");
  });

  it("FALSIFIABILITY: drifted + stale BUT opt-in flag OFF → does NOT show `check pending`", () => {
    const elevenMinAgo = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    const out = formatStatusline({
      totalPins: 11,
      lastStatus: {
        ...baseStatus,
        updatedAt: elevenMinAgo,
        lastCheckedSha: "abc123" + "0".repeat(34),
        lastCheckedDirtyHash: "deadbeef0000beef",
      },
      mode: "safe",
      color: false,
      showPendingChanges: false,
    });
    expect(strip(out)).not.toContain("pending");
  });

  it("FALSIFIABILITY: drifted but fresh cache (5min) → does NOT show `check pending`", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const out = formatStatusline({
      totalPins: 11,
      lastStatus: {
        ...baseStatus,
        updatedAt: fiveMinAgo,
        lastCheckedSha: "abc123" + "0".repeat(34),
        lastCheckedDirtyHash: "deadbeef0000beef",
      },
      mode: "safe",
      color: false,
      showPendingChanges: true,
    });
    expect(strip(out)).not.toContain("check pending");
  });

  it("FALSIFIABILITY: text uses 'check pending', NOT the old 'unchecked' or 'changes pending' wording", () => {
    const elevenMinAgo = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    const out = formatStatusline({
      totalPins: 11,
      lastStatus: {
        ...baseStatus,
        updatedAt: elevenMinAgo,
        lastCheckedSha: "abc123" + "0".repeat(34),
        lastCheckedDirtyHash: "deadbeef0000beef",
      },
      mode: "safe",
      color: false,
      showPendingChanges: true,
    });
    expect(strip(out)).not.toContain("unchecked");
    expect(strip(out)).not.toContain("changes pending");
  });
});
