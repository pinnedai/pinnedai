// FEATURE: Aggregate free-tier budget cap
// SIGNAL: when the SUM of free-tier (non-subscription) quota.calls
//   for the current month is >= the configured cap, checkAggregateBudget
//   returns {ok: false}. When under cap, returns {ok: true}. Paid
//   subscriptions' usage is EXCLUDED from the sum (their cost is
//   covered by their plan, not the free-tier budget).
// FALSIFIABILITY: catches a regression where the SUM stops counting
//   org rows OR the WHERE clause stops excluding active subscriptions
//   OR the threshold comparison flips boundary direction.

import { describe, it, expect } from "vitest";
import {
  checkAggregateBudget,
  checkAndIncrement,
} from "../../apps/edge/src/quota.js";
import { createSubscription } from "../../apps/edge/src/subscriptions.js";
import { createMockD1 } from "./mockD1.js";

describe("FEATURE-AUDIT: aggregate free-tier budget cap", () => {
  it("POSITIVE CONTROL: cap reached → checkAggregateBudget returns ok:false", async () => {
    const db = createMockD1();
    const CAP = 5;
    // Burn the cap with free-tier orgs
    for (let i = 0; i < CAP; i++) {
      await checkAndIncrement(db, { org: `free-${i}`, monthlyLimit: 1000 });
    }
    const result = await checkAggregateBudget(db, CAP);
    expect(result.ok).toBe(false);
    expect(result.total).toBeGreaterThanOrEqual(CAP);
  });

  it("POSITIVE CONTROL: under cap → checkAggregateBudget returns ok:true", async () => {
    const db = createMockD1();
    await checkAndIncrement(db, { org: "free-1", monthlyLimit: 1000 });
    const result = await checkAggregateBudget(db, 100);
    expect(result.ok).toBe(true);
    expect(result.total).toBe(1);
  });

  it("POSITIVE CONTROL: paid org usage is EXCLUDED from aggregate sum", async () => {
    const db = createMockD1();
    // 1 free call
    await checkAndIncrement(db, { org: "free-org", monthlyLimit: 1000 });
    // 1 paid org subscribed + a call (should NOT count)
    await createSubscription(db, {
      github_org: "paid-org",
      customer_email: "pay@paid.dev",
    });
    await checkAndIncrement(db, { org: "paid-org", monthlyLimit: 5000 });
    const result = await checkAggregateBudget(db, 100);
    expect(result.ok).toBe(true);
    expect(result.total).toBe(1); // ONLY the free org's call counts
  });

  it("NEGATIVE CONTROL: cap of 0 with zero usage still returns ok:false (boundary)", async () => {
    const db = createMockD1();
    // Even with 0 calls, cap=0 means "no headroom" → ok:false
    const result = await checkAggregateBudget(db, 0);
    expect(result.ok).toBe(false); // 0 >= 0
    expect(result.total).toBe(0);
  });

  it("FALSIFIABILITY: if SUM stopped excluding paid orgs, this assertion would catch it", async () => {
    const db = createMockD1();
    // Burn cap with PAID org usage — should NOT trigger cap
    await createSubscription(db, {
      github_org: "paid-heavy",
      customer_email: "p@p.dev",
      plan: "team",
    });
    for (let i = 0; i < 100; i++) {
      await checkAndIncrement(db, {
        org: "paid-heavy",
        monthlyLimit: 50000,
      });
    }
    // Free-tier cap is 5; paid org used 100 calls. If exclusion
    // failed, this would return ok:false. With correct exclusion, ok:true.
    const result = await checkAggregateBudget(db, 5);
    expect(result.ok).toBe(true);
    expect(result.total).toBe(0);
  });
});
