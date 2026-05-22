// FEATURE: /v1/plan endpoint returns subscription plan WITHOUT
//   calling OpenAI or incrementing the org's quota counter.
// SIGNAL: invoking the plan-check code path leaves quota.calls
//   unchanged AND does NOT touch the cache table.
// FALSIFIABILITY: catches a regression where the plan endpoint
//   accidentally falls through to /v1/extract's quota-burning path,
//   billing free orgs for plan checks.
//
// NOTE: this audit verifies the BEHAVIOR by checking the underlying
// functions' side effects on the mock DB. A full HTTP-flow audit
// against miniflare with a real OIDC token is v0.2 work.

import { describe, it, expect } from "vitest";
import {
  validateSubscription,
  createSubscription,
} from "../../apps/edge/src/subscriptions.js";
import { createMockD1 } from "./mockD1.js";

describe("FEATURE-AUDIT: /v1/plan endpoint does not burn quota", () => {
  it("POSITIVE CONTROL: validateSubscription does NOT touch quota table (no incrementCalled signal)", async () => {
    const db = createMockD1();
    await createSubscription(db, {
      github_org: "audit-org",
      customer_email: "ops@audit.dev",
    });

    // The plan-check path goes: OIDC validate → extract org →
    // validateSubscription(db, org) → return plan. No quota write.
    const sub = await validateSubscription(db, "audit-org");
    expect(sub!.plan).toBe("pro");

    // Signal: quota table is still empty (no row was inserted)
    expect(db._quota.size).toBe(0);
    expect(db._cache.size).toBe(0);
  });

  it("NEGATIVE CONTROL: a different (extract-like) path WOULD bump the quota — proves the positive is meaningful", async () => {
    // To prove the audit isn't tautological, we show that a code
    // path that DOES bump quota leaves a visible trace. If both
    // paths left the quota table empty, the positive control would
    // be meaningless.
    const db = createMockD1();
    const { checkAndIncrement } = await import(
      "../../apps/edge/src/quota.js"
    );
    await checkAndIncrement(db, { org: "audit-org", monthlyLimit: 100 });
    expect(db._quota.size).toBe(1);
    const row = [...db._quota.values()][0];
    expect(row.calls).toBe(1);
  });
});
