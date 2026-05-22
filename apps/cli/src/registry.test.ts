import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readRegistry,
  writeRegistry,
  addEntry,
  retireEntry,
  countActivePins,
  renderPinsManifest,
} from "./registry.js";
import type { Registry } from "./registry.js";
import type { Claim } from "./claimParser.js";

const rateLimitClaim: Claim = {
  template: "rate-limit",
  route: "/api/users",
  rate: 60,
  window: "minute",
  raw: "Rate-limits /api/users to 60 req/min",
};

const authClaim: Claim = {
  template: "auth-required",
  route: "/api/admin/export",
  raw: "Auth required on /api/admin/export",
};

const idempClaim: Claim = {
  template: "idempotent",
  route: "/webhooks/stripe",
  idField: "event_id",
  raw: "Makes /webhooks/stripe idempotent on event_id",
};

describe("registry — addEntry", () => {
  it("adds a new claim to an empty registry", () => {
    const r = addEntry(
      { version: 1, claims: [] },
      { claimId: "pr-1-rl", prId: "pr-1", claim: rateLimitClaim, filename: "x.test.ts" }
    );
    expect(r.claims).toHaveLength(1);
    expect(r.claims[0].status).toBe("active");
    expect(r.claims[0].claimId).toBe("pr-1-rl");
  });

  it("is idempotent for the same claimId", () => {
    let r: Registry = { version: 1, claims: [] };
    r = addEntry(r, { claimId: "pr-1-rl", prId: "pr-1", claim: rateLimitClaim, filename: "x.test.ts" });
    r = addEntry(r, { claimId: "pr-1-rl", prId: "pr-1", claim: rateLimitClaim, filename: "x.test.ts" });
    expect(r.claims).toHaveLength(1);
  });

  it("captures pinnedBy from GITHUB_ACTOR env", () => {
    process.env.GITHUB_ACTOR = "test-user-123";
    const r = addEntry(
      { version: 1, claims: [] },
      { claimId: "pr-1-rl", prId: "pr-1", claim: rateLimitClaim, filename: "x.test.ts" }
    );
    expect(r.claims[0].pinnedBy).toBe("test-user-123");
    delete process.env.GITHUB_ACTOR;
  });

  it("records ISO timestamp for pinnedAt", () => {
    const before = Date.now();
    const r = addEntry(
      { version: 1, claims: [] },
      { claimId: "pr-1-rl", prId: "pr-1", claim: rateLimitClaim, filename: "x.test.ts" }
    );
    const ts = new Date(r.claims[0].pinnedAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe("registry — retireEntry", () => {
  it("marks a claim as retired with reason", () => {
    let r: Registry = { version: 1, claims: [] };
    r = addEntry(r, { claimId: "pr-1-rl", prId: "pr-1", claim: rateLimitClaim, filename: "x.test.ts" });
    r = retireEntry(r, "pr-1-rl", "endpoint deprecated", "alice");
    expect(r.claims[0].status).toBe("retired");
    expect(r.claims[0].retireReason).toBe("endpoint deprecated");
    expect(r.claims[0].retiredBy).toBe("alice");
    expect(r.claims[0].retiredAt).toBeTruthy();
  });

  it("only affects matching claimId", () => {
    let r: Registry = { version: 1, claims: [] };
    r = addEntry(r, { claimId: "pr-1-rl", prId: "pr-1", claim: rateLimitClaim, filename: "x.test.ts" });
    r = addEntry(r, { claimId: "pr-2-auth", prId: "pr-2", claim: authClaim, filename: "y.test.ts" });
    r = retireEntry(r, "pr-1-rl", "x", "alice");
    expect(r.claims.find((c) => c.claimId === "pr-1-rl")?.status).toBe("retired");
    expect(r.claims.find((c) => c.claimId === "pr-2-auth")?.status).toBe("active");
  });

  it("is a no-op for unknown claimId", () => {
    let r: Registry = { version: 1, claims: [] };
    r = addEntry(r, { claimId: "pr-1-rl", prId: "pr-1", claim: rateLimitClaim, filename: "x.test.ts" });
    const out = retireEntry(r, "pr-99-nope", "x", "alice");
    expect(out.claims[0].status).toBe("active");
  });
});

describe("registry — countActivePins", () => {
  it("returns 0 for an empty registry", () => {
    expect(countActivePins({ version: 1, claims: [] })).toBe(0);
  });

  it("counts only active claims", () => {
    let r: Registry = { version: 1, claims: [] };
    r = addEntry(r, { claimId: "a", prId: "p1", claim: rateLimitClaim, filename: "a.test.ts" });
    r = addEntry(r, { claimId: "b", prId: "p2", claim: authClaim, filename: "b.test.ts" });
    r = addEntry(r, { claimId: "c", prId: "p3", claim: idempClaim, filename: "c.test.ts" });
    r = retireEntry(r, "b", "removed", "alice");
    expect(countActivePins(r)).toBe(2);
  });
});

// Pin counts are uncapped at every tier — the moat IS pin accumulation,
// so capping pins would cap the very thing that makes pinnedai valuable.
// Cost is bounded by the Worker's monthly LLM-call cap instead.

describe("registry — readRegistry / writeRegistry I/O", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pinned-registry-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty registry when .registry.json does not exist", () => {
    const r = readRegistry(dir);
    expect(r).toEqual({ version: 1, claims: [] });
  });

  it("writes + reads back JSON identically", () => {
    let r: Registry = { version: 1, claims: [] };
    r = addEntry(r, { claimId: "a", prId: "p1", claim: rateLimitClaim, filename: "a.test.ts" });
    writeRegistry(dir, r);
    const round = readRegistry(dir);
    expect(round.claims).toHaveLength(1);
    expect(round.claims[0].claimId).toBe("a");
  });

  it("writeRegistry also emits PINS.md", () => {
    let r: Registry = { version: 1, claims: [] };
    r = addEntry(r, { claimId: "a", prId: "pr-42", claim: rateLimitClaim, filename: "a.test.ts" });
    writeRegistry(dir, r);
    const pinsPath = join(dir, "PINS.md");
    expect(existsSync(pinsPath)).toBe(true);
    const content = readFileSync(pinsPath, "utf8");
    expect(content).toContain("# Pinned Claims");
    expect(content).toContain("rate-limit");
    expect(content).toContain("/api/users");
  });

  it("throws on corrupted JSON (fail-closed)", () => {
    writeFileSync(join(dir, ".registry.json"), "{not valid json");
    expect(() => readRegistry(dir)).toThrow(/not valid JSON|malformed/i);
  });

  it("throws on malformed shape (e.g. missing claims array)", () => {
    writeFileSync(join(dir, ".registry.json"), '{"version": 1}');
    expect(() => readRegistry(dir)).toThrow(/malformed/i);
  });
});

describe("registry — renderPinsManifest", () => {
  it("emits the placeholder for an empty registry", () => {
    const md = renderPinsManifest({ version: 1, claims: [] });
    expect(md).toContain("# Pinned Claims");
    expect(md).toContain("No pins yet");
  });

  it("renders an Active section with rate-limit details", () => {
    let r: Registry = { version: 1, claims: [] };
    r = addEntry(r, { claimId: "x", prId: "pr-42", claim: rateLimitClaim, filename: "x.test.ts" });
    const md = renderPinsManifest(r);
    expect(md).toContain("## Active");
    expect(md).toContain("60/minute");
    expect(md).toContain("#42");
  });

  it("renders auth-required without rate metadata", () => {
    let r: Registry = { version: 1, claims: [] };
    r = addEntry(r, { claimId: "x", prId: "pr-7", claim: authClaim, filename: "x.test.ts" });
    const md = renderPinsManifest(r);
    expect(md).toContain("auth-required");
    expect(md).toContain("/api/admin/export");
    expect(md).not.toContain("60/minute");
  });

  it("renders idempotent with key", () => {
    let r: Registry = { version: 1, claims: [] };
    r = addEntry(r, { claimId: "x", prId: "pr-3", claim: idempClaim, filename: "x.test.ts" });
    const md = renderPinsManifest(r);
    expect(md).toContain("idempotent");
    expect(md).toContain("event_id");
  });

  it("separates Active and Retired sections", () => {
    let r: Registry = { version: 1, claims: [] };
    r = addEntry(r, { claimId: "a", prId: "p1", claim: rateLimitClaim, filename: "a.test.ts" });
    r = addEntry(r, { claimId: "b", prId: "p2", claim: authClaim, filename: "b.test.ts" });
    r = retireEntry(r, "b", "route removed", "carol");
    const md = renderPinsManifest(r);
    expect(md).toContain("## Active");
    expect(md).toContain("## Retired");
    expect(md).toContain("route removed");
  });

  it("renders pinnedBy as @username GitHub link", () => {
    process.env.GITHUB_ACTOR = "alice";
    let r: Registry = { version: 1, claims: [] };
    r = addEntry(r, { claimId: "a", prId: "p1", claim: rateLimitClaim, filename: "a.test.ts" });
    delete process.env.GITHUB_ACTOR;
    const md = renderPinsManifest(r);
    expect(md).toContain("[@alice](https://github.com/alice)");
  });

  it("uses em-dash for missing actor", () => {
    let r: Registry = { version: 1, claims: [] };
    r = addEntry(r, { claimId: "a", prId: "p1", claim: rateLimitClaim, filename: "a.test.ts" });
    // pinnedBy will be undefined (no GITHUB_ACTOR or USER env)
    delete process.env.GITHUB_ACTOR;
    delete process.env.USER;
    let md = renderPinsManifest({ ...r, claims: r.claims.map((c) => ({ ...c, pinnedBy: undefined })) });
    expect(md).toContain("—");
  });
});
