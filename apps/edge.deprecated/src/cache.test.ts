// Cache module tests — hash determinism + in-memory get/set roundtrip
// + expires_at enforcement.
//
// Per bundle-4 spec: assert on the mock D1's stored rows, not just the
// return values.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { hashBody, getCached, setCached } from "./cache.js";

function createMockD1() {
  const rows = new Map<string, { content_hash: string; claims: string; expires_at: number; cached_at: number }>();
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
          if (/SELECT claims FROM extraction_cache WHERE content_hash = \?/i.test(upper)) {
            const [hash, now] = this._binds as [string, number];
            const row = rows.get(hash);
            if (!row || row.expires_at <= now) return undefined;
            return { claims: row.claims } as T;
          }
          return undefined;
        },
        async all<T>(): Promise<{ results: T[] }> {
          // Mock parity with production D1: prepared statements expose
          // both .first<T>() and .all<T>(). Current cache code only
          // calls .first(), but future code (e.g. admin listing) may
          // call .all(); having it here prevents mock-incompleteness
          // failures from masking product bugs.
          return { results: [] };
        },
        async run() {
          if (/^INSERT INTO extraction_cache/i.test(upper)) {
            const [hash, claims, cached_at, expires_at] = this._binds as [
              string,
              string,
              number,
              number,
            ];
            rows.set(hash, { content_hash: hash, claims, cached_at, expires_at });
          }
          return { success: true };
        },
      };
    },
    _rows: rows,
  } as unknown as Parameters<typeof getCached>[0] & {
    _rows: Map<string, { content_hash: string; claims: string; expires_at: number; cached_at: number }>;
  };
}

describe("cache — hashBody", () => {
  // POSITIVE CONTROL: a known input produces a known-shape hash.
  it("POSITIVE CONTROL: produces a 64-character hex digest", async () => {
    const h = await hashBody("hello world");
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is deterministic for the same input", async () => {
    const a = await hashBody("the same body");
    const b = await hashBody("the same body");
    expect(a).toBe(b);
  });

  it("differs for different inputs", async () => {
    const a = await hashBody("body one");
    const b = await hashBody("body two");
    expect(a).not.toBe(b);
  });

  it("handles unicode", async () => {
    const h = await hashBody("こんにちは PR description with 🎉");
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });

  it("handles very long bodies", async () => {
    const long = "x".repeat(40_000);
    const h = await hashBody(long);
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("cache — get/set roundtrip", () => {
  let db: ReturnType<typeof createMockD1>;
  beforeEach(() => {
    db = createMockD1();
  });

  it("returns null on cache miss", async () => {
    expect(await getCached(db, "deadbeef")).toBeNull();
  });

  // POSITIVE CONTROL: setCached → getCached returns the stored claims
  // AND the underlying row has the expected expires_at TTL.
  it("POSITIVE CONTROL: setCached stores a row with future expires_at; getCached returns it", async () => {
    const before = Date.now();
    const claims = [
      { template: "rate-limit", route: "/api/x", rate: 60, window: "minute", raw: "" },
    ] as const;
    await setCached(db, "abc123", claims as unknown as Parameters<typeof setCached>[2]);

    // Stored row shape:
    expect(db._rows.size).toBe(1);
    const row = db._rows.get("abc123");
    expect(row).toBeDefined();
    expect(row!.expires_at).toBeGreaterThan(before);
    // TTL is 90 days from cached_at:
    expect(row!.expires_at - row!.cached_at).toBe(90 * 24 * 60 * 60 * 1000);

    // Retrieval:
    const got = await getCached(db, "abc123");
    expect(got).not.toBeNull();
    expect(got!).toHaveLength(1);
    expect(got![0].template).toBe("rate-limit");
  });

  it("overwrites on second set (UPSERT semantics)", async () => {
    await setCached(db, "k", [
      { template: "auth-required", route: "/api/old", raw: "" },
    ] as Parameters<typeof setCached>[2]);
    await setCached(db, "k", [
      { template: "auth-required", route: "/api/new", raw: "" },
    ] as Parameters<typeof setCached>[2]);
    const got = await getCached(db, "k");
    // got![0] is a Claim — narrow before reading route.
    const claim = got![0];
    if (claim.template !== "auth-required") {
      throw new Error("expected auth-required claim back");
    }
    expect(claim.route).toBe("/api/new");

    // Still ONE row, not two — the mock simulates upsert correctly.
    expect(db._rows.size).toBe(1);
  });
});

describe("cache — expires_at enforcement (synthetic time)", () => {
  let db: ReturnType<typeof createMockD1>;

  beforeEach(() => {
    db = createMockD1();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // POSITIVE CONTROL: a cache entry seeded with expires_at < now MUST
  // return null from getCached (proves the freshness gate works).
  it("POSITIVE CONTROL: expired cache row returns null from getCached", async () => {
    // Set time to 2026-05-01
    vi.setSystemTime(new Date(Date.UTC(2026, 4, 1, 12, 0, 0)));

    // Seed a row that's already expired (expires_at < now)
    await setCached(db, "expired-hash", [
      { template: "rate-limit", route: "/api/x", rate: 60, window: "minute", raw: "" },
    ] as Parameters<typeof setCached>[2]);

    // Manually set expires_at into the past
    const row = db._rows.get("expired-hash")!;
    row.expires_at = Date.now() - 1000; // 1 second ago

    expect(await getCached(db, "expired-hash")).toBeNull();
  });

  it("cache entry still valid before TTL expires", async () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 4, 1, 12, 0, 0)));
    await setCached(db, "fresh", [
      { template: "rate-limit", route: "/api/y", rate: 60, window: "minute", raw: "" },
    ] as Parameters<typeof setCached>[2]);

    // Advance 89 days — still inside the 90-day TTL
    vi.setSystemTime(Date.now() + 89 * 24 * 60 * 60 * 1000);
    const got = await getCached(db, "fresh");
    expect(got).not.toBeNull();
    const claim = got![0];
    if (claim.template !== "rate-limit") {
      throw new Error("expected rate-limit claim back");
    }
    expect(claim.route).toBe("/api/y");
  });

  it("cache entry expires at the 90-day mark", async () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 4, 1, 12, 0, 0)));
    await setCached(db, "stale", [
      { template: "rate-limit", route: "/api/z", rate: 60, window: "minute", raw: "" },
    ] as Parameters<typeof setCached>[2]);

    // Advance 91 days — past TTL
    vi.setSystemTime(Date.now() + 91 * 24 * 60 * 60 * 1000);
    expect(await getCached(db, "stale")).toBeNull();
  });
});
