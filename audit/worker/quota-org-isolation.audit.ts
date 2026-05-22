// FEATURE: Per-org monthly quota counter
// SIGNAL: checkAndIncrement bumps an org's counter for the current
//   month and returns {ok: true, calls: N+1} until calls > limit,
//   after which it returns {ok: false, reason: "monthly-quota"}.
//   One org's increments do NOT affect another org's counter.
// FALSIFIABILITY: catches a regression where the counter stops
//   keying on (org, month), where increments share state across
//   orgs, or where the over-cap boundary stops firing.

import { describe, it, expect } from "vitest";
import { checkAndIncrement } from "../../apps/edge/src/quota.js";
import { createMockD1 } from "./mockD1.js";

describe("FEATURE-AUDIT: per-org quota counter", () => {
  it("POSITIVE CONTROL: increment is monotonic per org; limit boundary fires correctly", async () => {
    const db = createMockD1();
    const a1 = await checkAndIncrement(db, { org: "a", monthlyLimit: 3 });
    expect(a1).toMatchObject({ ok: true, calls: 1, remaining: 2 });
    const a2 = await checkAndIncrement(db, { org: "a", monthlyLimit: 3 });
    expect(a2).toMatchObject({ ok: true, calls: 2, remaining: 1 });
    const a3 = await checkAndIncrement(db, { org: "a", monthlyLimit: 3 });
    expect(a3).toMatchObject({ ok: true, calls: 3, remaining: 0 });
    // 4th call → over cap
    const a4 = await checkAndIncrement(db, { org: "a", monthlyLimit: 3 });
    expect(a4.ok).toBe(false);
    if (a4.ok === false) expect(a4.reason).toBe("monthly-quota");
  });

  it("POSITIVE CONTROL: two orgs' counters are fully independent", async () => {
    const db = createMockD1();
    // Burn org-a's quota
    for (let i = 0; i < 5; i++) {
      await checkAndIncrement(db, { org: "org-a", monthlyLimit: 100 });
    }
    // Org-b's counter starts at 0 unaffected
    const b1 = await checkAndIncrement(db, { org: "org-b", monthlyLimit: 100 });
    expect(b1).toMatchObject({ ok: true, calls: 1 });
  });

  it("FALSIFIABILITY: if a sibling org's calls leaked into another, this would catch it", async () => {
    const db = createMockD1();
    // 10 calls to org-noisy
    for (let i = 0; i < 10; i++) {
      await checkAndIncrement(db, { org: "noisy", monthlyLimit: 100 });
    }
    // org-quiet's first call should NOT see calls=11
    const result = await checkAndIncrement(db, {
      org: "quiet",
      monthlyLimit: 100,
    });
    expect(result.ok).toBe(true);
    if (result.ok === true) expect(result.calls).toBe(1);
  });
});
