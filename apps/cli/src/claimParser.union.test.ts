import { describe, it, expect } from "vitest";
import { unionClaims, claimKey } from "./claimParser.js";
import type { Claim } from "./claimParser.js";

const regexHit: Claim = {
  template: "rate-limit",
  route: "/api/users",
  rate: 60,
  window: "minute",
  raw: "Rate-limits /api/users to 60 req/min",
};

const sameClaimViaLlm: Claim = {
  template: "rate-limit",
  route: "/api/users",
  rate: 60,
  window: "minute",
  raw: "[llm] /api/users 60/minute",
};

const newClaimFromLlm: Claim = {
  template: "auth-required",
  route: "/api/admin",
  raw: "[llm] auth-required /api/admin",
};

describe("unionClaims", () => {
  // POSITIVE CONTROL: known-healthy input (a rate-limit claim from
  // regex + the same claim via LLM) produces the documented signal —
  // exactly one Claim in the output with raw === regexHit.raw.
  // Per [[feature-audit-signals-must-be-falsifiable]].
  it("POSITIVE CONTROL: dedupes claims with identical keys (regex wins)", () => {
    const out = unionClaims([regexHit], [sameClaimViaLlm]);
    expect(out).toHaveLength(1);
    expect(out[0].raw).toBe(regexHit.raw); // regex source preserved
  });

  it("merges two empty sources to empty", () => {
    expect(unionClaims([], [])).toEqual([]);
  });

  it("preserves claims that exist only in one source", () => {
    const out = unionClaims([regexHit], [newClaimFromLlm]);
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.template).sort()).toEqual([
      "auth-required",
      "rate-limit",
    ]);
  });

  it("is order-stable: regex claims come first, then LLM-unique", () => {
    const out = unionClaims([regexHit], [newClaimFromLlm, sameClaimViaLlm]);
    expect(out[0].template).toBe("rate-limit");
    expect(out[1].template).toBe("auth-required");
  });

  it("handles all three template types", () => {
    const out = unionClaims(
      [],
      [
        regexHit,
        newClaimFromLlm,
        {
          template: "idempotent",
          route: "/webhooks/stripe",
          idField: "event_id",
          raw: "",
        },
      ]
    );
    expect(out).toHaveLength(3);
  });
});

describe("claimKey", () => {
  it("rate-limit key includes route+rate+window", () => {
    expect(claimKey(regexHit)).toBe("rate-limit:/api/users:60:minute");
  });

  it("auth-required key includes route only", () => {
    expect(claimKey(newClaimFromLlm)).toBe("auth-required:/api/admin");
  });

  it("two rate-limits on same route but different rates have different keys", () => {
    const k1 = claimKey({ ...regexHit, rate: 60 });
    const k2 = claimKey({ ...regexHit, rate: 100 });
    expect(k1).not.toBe(k2);
  });
});
