// Subscription module tests — in-memory D1 mock keyed by github_org.

import { describe, it, expect, beforeEach } from "vitest";
import { validateSubscription, createSubscription } from "./subscriptions.js";

type SubRow = {
  github_org: string;
  customer_email: string;
  status: string;
  plan: string;
  fair_use_cap: number;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  created_at: number;
  updated_at: number;
  notes: string | null;
};

function createMockD1() {
  const rows = new Map<string, SubRow>();
  return {
    prepare(sql: string) {
      const upper = sql.replace(/\s+/g, " ").trim();
      return {
        _binds: [] as unknown[],
        bind(...args: unknown[]) {
          this._binds = args;
          return this;
        },
        async first<T>() {
          if (/SELECT \* FROM subscriptions WHERE github_org = \? AND status = 'active'/i.test(upper)) {
            const k = this._binds[0] as string;
            const row = rows.get(k);
            if (!row || row.status !== "active") return undefined;
            return row as T;
          }
          return undefined;
        },
        async all<T>(): Promise<{ results: T[] }> {
          // Mock parity with production D1: future admin endpoints
          // (e.g. /admin/subscriptions list) will call .all(); having
          // it on the mock prevents mock-incompleteness failures from
          // masking product bugs.
          return { results: [] };
        },
        async run() {
          if (/^INSERT INTO subscriptions/i.test(upper)) {
            const [
              github_org,
              customer_email,
              status,
              plan,
              fair_use_cap,
              stripe_customer_id,
              stripe_subscription_id,
              created_at,
              updated_at,
              notes,
            ] = this._binds as [string, string, string, string, number, string | null, string | null, number, number, string | null];
            // ON CONFLICT(github_org) DO UPDATE — overwrite in place
            rows.set(github_org, {
              github_org,
              customer_email,
              status,
              plan,
              fair_use_cap,
              stripe_customer_id,
              stripe_subscription_id,
              created_at,
              updated_at,
              notes,
            });
          }
          return { success: true };
        },
      };
    },
    _rows: rows,
  } as unknown as Parameters<typeof validateSubscription>[0] & {
    _rows: Map<string, SubRow>;
  };
}

describe("subscriptions — createSubscription", () => {
  let db: ReturnType<typeof createMockD1>;
  beforeEach(() => {
    db = createMockD1();
  });

  // POSITIVE CONTROL: a known-healthy input produces an active Pro
  // subscription row with the default fair-use cap (5000).
  it("POSITIVE CONTROL: createSubscription persists an active Pro row with fair_use_cap=5000", async () => {
    const sub = await createSubscription(db, {
      github_org: "acme",
      customer_email: "ops@acme.dev",
    });
    expect(sub.github_org).toBe("acme");
    expect(sub.plan).toBe("pro");
    expect(sub.fair_use_cap).toBe(5000);
    expect(sub.status).toBe("active");

    expect(db._rows.size).toBe(1);
    expect(db._rows.get("acme")).toMatchObject({
      github_org: "acme",
      customer_email: "ops@acme.dev",
      plan: "pro",
      status: "active",
      fair_use_cap: 5000,
    });
  });

  it("normalizes github_org to lowercase", async () => {
    const sub = await createSubscription(db, {
      github_org: "ACME-Corp",
      customer_email: "ops@acme.dev",
    });
    expect(sub.github_org).toBe("acme-corp");
  });

  it("respects an explicit plan with correct fair_use_cap (team/enterprise)", async () => {
    const team = await createSubscription(db, {
      github_org: "acme",
      customer_email: "team@acme.dev",
      plan: "team",
    });
    expect(team.plan).toBe("team");
    expect(team.fair_use_cap).toBe(50000);

    const ent = await createSubscription(db, {
      github_org: "bigco",
      customer_email: "ent@bigco.com",
      plan: "enterprise",
    });
    expect(ent.fair_use_cap).toBe(1_000_000);
  });

  it("rejects invalid github_org names (per GitHub's username rules)", async () => {
    await expect(
      createSubscription(db, {
        github_org: "not valid!",
        customer_email: "x@x.com",
      })
    ).rejects.toThrow(/Invalid GitHub org name/);
  });

  it("ON CONFLICT updates existing subscription in place (plan upgrade)", async () => {
    await createSubscription(db, {
      github_org: "acme",
      customer_email: "ops@acme.dev",
      plan: "pro",
    });
    await createSubscription(db, {
      github_org: "acme",
      customer_email: "ops@acme.dev",
      plan: "team",
    });
    expect(db._rows.size).toBe(1);
    expect(db._rows.get("acme")!.plan).toBe("team");
    expect(db._rows.get("acme")!.fair_use_cap).toBe(50000);
  });
});

describe("subscriptions — validateSubscription", () => {
  let db: ReturnType<typeof createMockD1>;
  beforeEach(() => {
    db = createMockD1();
  });

  // POSITIVE CONTROL: a freshly-created active Pro subscription
  // validates back as the same row.
  it("POSITIVE CONTROL: active subscription validates", async () => {
    await createSubscription(db, {
      github_org: "acme",
      customer_email: "ops@acme.dev",
    });
    const sub = await validateSubscription(db, "acme");
    expect(sub).not.toBeNull();
    expect(sub!.plan).toBe("pro");
    expect(sub!.customer_email).toBe("ops@acme.dev");
  });

  it("returns null for unknown org", async () => {
    expect(await validateSubscription(db, "nobody")).toBeNull();
  });

  it("returns null for empty input", async () => {
    expect(await validateSubscription(db, "")).toBeNull();
  });

  it("returns null for cancelled subscription", async () => {
    await createSubscription(db, {
      github_org: "acme",
      customer_email: "ops@acme.dev",
    });
    db._rows.get("acme")!.status = "cancelled";
    expect(await validateSubscription(db, "acme")).toBeNull();
  });

  it("returns null for past_due subscription", async () => {
    await createSubscription(db, {
      github_org: "acme",
      customer_email: "ops@acme.dev",
    });
    db._rows.get("acme")!.status = "past_due";
    expect(await validateSubscription(db, "acme")).toBeNull();
  });
});
