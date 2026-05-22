// FEATURE: Subscription lookup by github_org
// SIGNAL: validateSubscription returns the inserted row when an
//   active subscription exists for the lowercased org name; returns
//   null when no row exists OR the row's status is not "active".
// FALSIFIABILITY: catches a regression where the lookup stops
//   lowercasing input, accepts cancelled/past_due rows as active,
//   or returns the wrong plan.

import { describe, it, expect } from "vitest";
import {
  validateSubscription,
  createSubscription,
} from "../../apps/edge/src/subscriptions.js";
import { createMockD1 } from "./mockD1.js";

describe("FEATURE-AUDIT: subscription lookup", () => {
  it("POSITIVE CONTROL: active sub returns the row; lookup is case-insensitive on org", async () => {
    const db = createMockD1();
    await createSubscription(db, {
      github_org: "Acme-Corp",
      customer_email: "ops@acme.dev",
      plan: "pro",
    });
    // Lowercase lookup
    const lower = await validateSubscription(db, "acme-corp");
    expect(lower).not.toBeNull();
    expect(lower!.plan).toBe("pro");
    expect(lower!.fair_use_cap).toBe(5000);
    expect(lower!.status).toBe("active");
  });

  it("NEGATIVE CONTROL: cancelled subscription does NOT validate (signal absent)", async () => {
    const db = createMockD1();
    await createSubscription(db, {
      github_org: "acme",
      customer_email: "ops@acme.dev",
    });
    // Mutate status to cancelled — simulates a customer who churned
    db._subs.get("acme")!.status = "cancelled";
    const result = await validateSubscription(db, "acme");
    expect(result).toBeNull();
  });

  it("NEGATIVE CONTROL: past_due subscription does NOT validate", async () => {
    const db = createMockD1();
    await createSubscription(db, {
      github_org: "acme",
      customer_email: "ops@acme.dev",
    });
    db._subs.get("acme")!.status = "past_due";
    expect(await validateSubscription(db, "acme")).toBeNull();
  });

  it("NEGATIVE CONTROL: unknown org returns null (not 'free' or 'undefined')", async () => {
    const db = createMockD1();
    expect(await validateSubscription(db, "no-such-org")).toBeNull();
  });
});
