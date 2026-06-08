// Worker quota tests using an in-memory D1 mock.
// Validates per-org counter, monthly bucket, over-quota response, extractOrg.
//
// Per bundle-4 spec: "The mock D1's stored state IS the observable signal —
// assert on rows." So most tests assert on `db._store` row shape, not just
// the return value.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { checkAndIncrement, extractOrg } from "./quota.js";

type Row = Record<string, unknown>;

function createMockD1() {
  const store = new Map<string, Row>();

  function key(table: string, row: Row): string {
    if (table === "quota") return `${table}:${row.org}:${row.month}`;
    return `${table}:${JSON.stringify(row)}`;
  }

  const prepare = (sql: string) => {
    const upper = sql.replace(/\s+/g, " ").trim();
    return {
      _sql: upper,
      _binds: [] as unknown[],
      bind(...args: unknown[]) {
        this._binds = args;
        return this;
      },
      async first<T = Row>(): Promise<T | undefined> {
        if (/^SELECT calls FROM quota WHERE org = \? AND month = \?/i.test(this._sql)) {
          const k = key("quota", { org: this._binds[0], month: this._binds[1] });
          return store.get(k) as T | undefined;
        }
        return undefined;
      },
      async all<T = Row>(): Promise<{ results: T[] }> {
        return { results: [] };
      },
      async run() {
        if (/^INSERT INTO quota .* ON CONFLICT\(org, month\) DO UPDATE/i.test(this._sql)) {
          const [org, month, , now2] = this._binds as [string, string, number, number];
          const k = key("quota", { org, month });
          const existing = store.get(k);
          if (existing) {
            existing.calls = (existing.calls as number) + 1;
            existing.last_call_at = now2;
          } else {
            store.set(k, { org, month, calls: 1, last_call_at: now2 });
          }
        }
        return { success: true };
      },
    };
  };

  return {
    prepare,
    _store: store,
  } as unknown as Parameters<typeof checkAndIncrement>[0] & {
    _store: Map<string, Row>;
  };
}

describe("quota — extractOrg", () => {
  // POSITIVE CONTROL: the canonical input shape ("owner/repo") produces
  // the documented signal (just the owner).
  it("POSITIVE CONTROL: extracts owner from a normal repo string", () => {
    expect(extractOrg("mzon7/quantasyte")).toBe("mzon7");
  });

  it("returns the input unchanged when no slash", () => {
    expect(extractOrg("standalone")).toBe("standalone");
  });

  it("handles org/repo-with-many-dashes", () => {
    expect(extractOrg("acme-corp/api-server-v2")).toBe("acme-corp");
  });
});

describe("quota — checkAndIncrement", () => {
  let db: ReturnType<typeof createMockD1>;
  beforeEach(() => {
    db = createMockD1();
  });

  // POSITIVE CONTROL: a single call to checkAndIncrement produces
  // EXACTLY ONE row in the quota store with calls=1, last_call_at
  // populated, and the right (org, month) key.
  it("POSITIVE CONTROL: first call produces a quota row with calls=1", async () => {
    const r = await checkAndIncrement(db, { org: "acme", monthlyLimit: 25 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.calls).toBe(1);
      expect(r.limit).toBe(25);
      expect(r.remaining).toBe(24);
    }

    // Assert on the stored state, not just the return value.
    expect(db._store.size).toBe(1);
    const rows = Array.from(db._store.values());
    expect(rows[0]).toMatchObject({
      org: "acme",
      calls: 1,
    });
    expect(rows[0].month).toMatch(/^\d{4}-\d{2}$/);
    expect(typeof rows[0].last_call_at).toBe("number");
  });

  it("increments stored row's calls field across multiple calls", async () => {
    for (let i = 0; i < 5; i++) {
      await checkAndIncrement(db, { org: "acme", monthlyLimit: 25 });
    }
    const r = await checkAndIncrement(db, { org: "acme", monthlyLimit: 25 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.calls).toBe(6);

    // Still one row — calls field grew, not a new row per call.
    expect(db._store.size).toBe(1);
    const row = Array.from(db._store.values())[0];
    expect(row.calls).toBe(6);
  });

  it("returns ok=false AND stored row reflects overage when over monthly limit", async () => {
    for (let i = 0; i < 25; i++) {
      await checkAndIncrement(db, { org: "acme", monthlyLimit: 25 });
    }
    const r = await checkAndIncrement(db, { org: "acme", monthlyLimit: 25 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("monthly-quota");
      expect(r.calls).toBe(26);
    }
    // The row IS incremented past the cap — the function doesn't
    // refuse-and-not-store. That's by design (we count attempts) and
    // we want the test to verify that explicitly.
    const row = Array.from(db._store.values())[0];
    expect(row.calls).toBe(26);
  });

  it("orgs are stored in separate rows (key includes org)", async () => {
    for (let i = 0; i < 20; i++) {
      await checkAndIncrement(db, { org: "alice", monthlyLimit: 25 });
    }
    const r = await checkAndIncrement(db, { org: "bob", monthlyLimit: 25 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.calls).toBe(1);

    // Two distinct rows, one per org.
    expect(db._store.size).toBe(2);
    const aliceRows = Array.from(db._store.values()).filter((r) => r.org === "alice");
    const bobRows = Array.from(db._store.values()).filter((r) => r.org === "bob");
    expect(aliceRows[0].calls).toBe(20);
    expect(bobRows[0].calls).toBe(1);
  });

  it("respects the configured limit (100 not 25)", async () => {
    for (let i = 0; i < 100; i++) {
      await checkAndIncrement(db, { org: "acme", monthlyLimit: 100 });
    }
    const r = await checkAndIncrement(db, { org: "acme", monthlyLimit: 100 });
    expect(r.ok).toBe(false);
  });
});

describe("quota — monthly reset boundary (synthetic time)", () => {
  let db: ReturnType<typeof createMockD1>;

  beforeEach(() => {
    db = createMockD1();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // POSITIVE CONTROL: a quota increment in May 2026 creates a row keyed
  // to "2026-05"; advancing the clock to June creates a SEPARATE row
  // keyed to "2026-06" with calls=1 (fresh quota).
  it("POSITIVE CONTROL: new month creates a fresh quota row, doesn't carry over", async () => {
    // Start in mid-May 2026
    vi.setSystemTime(new Date(Date.UTC(2026, 4, 15, 12, 0, 0)));
    await checkAndIncrement(db, { org: "acme", monthlyLimit: 25 });
    await checkAndIncrement(db, { org: "acme", monthlyLimit: 25 });
    await checkAndIncrement(db, { org: "acme", monthlyLimit: 25 });

    // Should have one row at "2026-05" with calls=3
    expect(db._store.size).toBe(1);
    const mayRow = Array.from(db._store.values())[0];
    expect(mayRow.month).toBe("2026-05");
    expect(mayRow.calls).toBe(3);

    // Advance to mid-June 2026
    vi.setSystemTime(new Date(Date.UTC(2026, 5, 15, 12, 0, 0)));
    const r = await checkAndIncrement(db, { org: "acme", monthlyLimit: 25 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.calls).toBe(1); // Fresh — not 4

    // Now two rows: one per month
    expect(db._store.size).toBe(2);
    const juneRow = Array.from(db._store.values()).find((r) => r.month === "2026-06");
    expect(juneRow).toBeDefined();
    expect(juneRow!.calls).toBe(1);
  });

  it("December → January rolls year correctly", async () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 11, 31, 23, 30, 0)));
    await checkAndIncrement(db, { org: "acme", monthlyLimit: 25 });
    expect(Array.from(db._store.values())[0].month).toBe("2026-12");

    vi.setSystemTime(new Date(Date.UTC(2027, 0, 1, 0, 30, 0)));
    await checkAndIncrement(db, { org: "acme", monthlyLimit: 25 });
    expect(db._store.size).toBe(2);
    const janRow = Array.from(db._store.values()).find((r) => r.month === "2027-01");
    expect(janRow).toBeDefined();
    expect(janRow!.calls).toBe(1);
  });
});
