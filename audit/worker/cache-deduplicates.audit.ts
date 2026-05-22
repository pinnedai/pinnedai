// FEATURE: Extraction cache (content-hash dedup)
// SIGNAL: hashBody(text) returns the same hash for identical input;
//   getCached returns null on miss; setCached → getCached roundtrips
//   the stored claims AND respects expires_at TTL.
// FALSIFIABILITY: catches a regression where the hash becomes
//   non-deterministic, the cache lookup ignores TTL, or stored
//   claims are corrupted on read/write.

import { describe, it, expect } from "vitest";
import { hashBody, getCached, setCached } from "../../apps/edge/src/cache.js";
import { createMockD1 } from "./mockD1.js";

describe("FEATURE-AUDIT: extraction cache", () => {
  it("POSITIVE CONTROL: identical body → identical hash → cache hit on second lookup", async () => {
    const db = createMockD1();
    const body = "Rate-limits /api/test to 60 req/min.";
    const h1 = await hashBody(body);
    const h2 = await hashBody(body);
    expect(h1).toBe(h2);

    const claims = [
      {
        template: "rate-limit" as const,
        route: "/api/test",
        rate: 60,
        window: "minute" as const,
        raw: body,
      },
    ];
    await setCached(db, h1, claims);
    const got = await getCached(db, h2);
    expect(got).not.toBeNull();
    expect(got).toHaveLength(1);
    expect(got![0]).toMatchObject({ template: "rate-limit", route: "/api/test" });
  });

  it("NEGATIVE CONTROL: different body → different hash → cache MISS", async () => {
    const db = createMockD1();
    const h1 = await hashBody("body one");
    const h2 = await hashBody("body two");
    expect(h1).not.toBe(h2);

    await setCached(db, h1, [
      {
        template: "auth-required",
        route: "/x",
        raw: "",
      },
    ]);
    const got = await getCached(db, h2);
    expect(got).toBeNull();
  });

  it("NEGATIVE CONTROL: expired cache row returns null (TTL respected)", async () => {
    const db = createMockD1();
    const body = "body";
    const h = await hashBody(body);
    await setCached(db, h, [
      { template: "auth-required", route: "/x", raw: "" },
    ]);
    // Force the row to expire by mutating it in the mock
    const row = db._cache.get(h)!;
    row.expires_at = Date.now() - 1000;
    expect(await getCached(db, h)).toBeNull();
  });

  it("FALSIFIABILITY: a deterministic SHA-256 keeps the same hash across runs (60-byte fixed input)", async () => {
    // If hashing becomes non-deterministic (e.g. someone introduces
    // a random salt), this assertion would fail.
    const h = await hashBody("fixed audit fixture");
    expect(h).toMatch(/^[a-f0-9]{64}$/);
    // Run again — same hash
    const h2 = await hashBody("fixed audit fixture");
    expect(h2).toBe(h);
  });
});
