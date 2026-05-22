// FEATURE: chat-injection hook handles add-celebration (in addition
//   to failure messages).
// SIGNAL: formatChatHook returns:
//   - failure text when status === "failing" AND failingCount > 0
//   - one-shot celebration text when recentlyAddedAt fresh AND not
//     yet notified (returns a non-null stampAddNotifiedAt)
//   - empty text + null stamp otherwise
// FALSIFIABILITY:
//   - POS: fresh add emits celebration text + non-null stamp
//   - NEG: SAME add already notified emits empty text + null stamp
//     (one-shot semantics — never re-celebrates the same add event)
//   - NEG: failing pin trumps fresh add (no celebration shown)
//   - NEG: stale add (>2min) emits empty text

import { describe, it, expect } from "vitest";
import { formatChatHook, RECENTLY_ADDED_TTL_MS } from "../../apps/cli/src/statusline.js";

const baseGreen = {
  status: "green" as const,
  failingCount: 0,
  failingClaimIds: [],
  totalPins: 11,
  updatedAt: new Date().toISOString(),
};

describe("FEATURE-AUDIT: chat-hook add-celebration", () => {
  it("POSITIVE CONTROL: fresh add (1 minute ago) emits celebration + stamp", () => {
    const addedAt = new Date(Date.now() - 60 * 1000).toISOString();
    const r = formatChatHook({
      ...baseGreen,
      recentlyAddedCount: 2,
      recentlyAddedAt: addedAt,
    });
    expect(r.text).toContain("auto-pinned 2 new behaviors");
    expect(r.stampAddNotifiedAt).toBe(addedAt);
  });

  it("FALSIFIABILITY: SAME add already notified emits nothing (one-shot)", () => {
    const addedAt = new Date(Date.now() - 60 * 1000).toISOString();
    const r = formatChatHook({
      ...baseGreen,
      recentlyAddedCount: 2,
      recentlyAddedAt: addedAt,
      lastAddNotifiedAt: addedAt, // already shown for this add-event
    });
    expect(r.text).toBe("");
    expect(r.stampAddNotifiedAt).toBeNull();
  });

  it("FALSIFIABILITY: failing pin trumps celebration", () => {
    const addedAt = new Date(Date.now() - 60 * 1000).toISOString();
    const r = formatChatHook({
      ...baseGreen,
      status: "failing",
      failingCount: 1,
      failingClaimIds: ["pr-42"],
      recentlyAddedCount: 2,
      recentlyAddedAt: addedAt,
    });
    expect(r.text).toContain("failing");
    expect(r.text).not.toContain("auto-pinned");
    expect(r.stampAddNotifiedAt).toBeNull();
  });

  it("FALSIFIABILITY: stale add (> RECENTLY_ADDED_TTL_MS) emits nothing", () => {
    const tooOld = new Date(Date.now() - (RECENTLY_ADDED_TTL_MS + 60 * 1000)).toISOString();
    const r = formatChatHook({
      ...baseGreen,
      recentlyAddedCount: 2,
      recentlyAddedAt: tooOld,
    });
    expect(r.text).toBe("");
    expect(r.stampAddNotifiedAt).toBeNull();
  });

  it("FALSIFIABILITY: NEW add after a previously-notified one emits celebration", () => {
    // First add at T-10min (already notified). Second add at T-1min
    // (not yet notified). Hook should emit the second.
    const oldAdd = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const newAdd = new Date(Date.now() - 60 * 1000).toISOString();
    const r = formatChatHook({
      ...baseGreen,
      recentlyAddedCount: 1,
      recentlyAddedAt: newAdd,
      lastAddNotifiedAt: oldAdd, // notified the OLD add
    });
    expect(r.text).toContain("auto-pinned 1 new behavior");
    expect(r.stampAddNotifiedAt).toBe(newAdd);
  });
});
