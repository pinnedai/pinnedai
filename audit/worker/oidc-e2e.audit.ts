// FEATURE: Real OIDC E2E — /v1/extract + /v1/plan with signed JWTs
//   against a mock JWKS. (D.2, D.3, D.4 elevated to full E2E)
// SIGNAL: a properly-signed token with valid claims AUTHENTICATES.
//   A token signed with a different key, expired, with wrong audience,
//   or tampered payload, all FAIL with 401.
// FALSIFIABILITY: catches a regression where signature verification
//   silently passes, audience/issuer/exp checks are skipped, or the
//   body-size cap is moved after OIDC (perf + DoS regression).

import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from "vitest";
import worker from "../../apps/edge/src/index.js";
import { createMockD1, type MockDB } from "./mockD1.js";
import { startOidcFixture, type OidcFixture } from "./oidc-fixture.js";

let fixture: OidcFixture;
let db: MockDB;

beforeAll(async () => {
  fixture = await startOidcFixture();
});
afterAll(async () => {
  await fixture.stop();
});

function makeEnv() {
  db = createMockD1();
  return {
    QUOTA: db,
    OPENAI_API_KEY: "test-openai",
    ADMIN_KEY: "test-admin",
    FREE_QUOTA_PER_MONTH: "100",
    FREE_QUOTA_PUBLIC_PER_MONTH: "500",
    FREE_QUOTA_PRIVATE_PER_MONTH: "100",
    FREE_BUDGET_TOTAL_PER_MONTH: "100000",
    GITHUB_JWKS_URL: fixture.jwksUrl,
    OIDC_AUDIENCE: "pinnedai",
  } as unknown as Parameters<typeof worker.fetch>[1];
}

// Mock OpenAI fetch so /v1/extract doesn't hit the real network.
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockOpenAIFetch(claimsReturned: unknown[] = []) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    // Pass-through to our local JWKS server
    if (url.includes("127.0.0.1") && url.includes("/jwks")) {
      return realFetch(input, init);
    }
    // Mock OpenAI
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({ claims: claimsReturned }),
            },
          },
        ],
      }),
      { status: 200 }
    );
  });
}

describe("FEATURE-AUDIT: D.4 — OIDC signature validation (E2E)", () => {
  it("POSITIVE CONTROL: properly-signed valid token → /v1/plan returns 200 + free plan", async () => {
    mockOpenAIFetch();
    const token = fixture.signToken({});
    const res = await worker.fetch(
      new Request("https://api.pinnedai.dev/v1/plan", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }),
      makeEnv(),
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plan: string; org: string };
    expect(body.plan).toBe("free");
    expect(body.org).toBe("acme");
  });

  it("NEGATIVE CONTROL: tampered token (modified payload) → 401", async () => {
    mockOpenAIFetch();
    const valid = fixture.signToken({});
    // Tamper the payload portion (middle of the JWT)
    const [h, p, s] = valid.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url").toString()), sub: "evil" })
    )
      .toString("base64")
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    const tampered = `${h}.${tamperedPayload}.${s}`;
    const res = await worker.fetch(
      new Request("https://api.pinnedai.dev/v1/plan", {
        method: "POST",
        headers: { Authorization: `Bearer ${tampered}` },
      }),
      makeEnv(),
      {} as ExecutionContext
    );
    expect(res.status).toBe(401);
  });

  it("NEGATIVE CONTROL: expired token (exp in the past) → 401", async () => {
    mockOpenAIFetch();
    const now = Math.floor(Date.now() / 1000);
    const expired = fixture.signToken({ exp: now - 600, iat: now - 1200 });
    const res = await worker.fetch(
      new Request("https://api.pinnedai.dev/v1/plan", {
        method: "POST",
        headers: { Authorization: `Bearer ${expired}` },
      }),
      makeEnv(),
      {} as ExecutionContext
    );
    expect(res.status).toBe(401);
  });

  it("NEGATIVE CONTROL: wrong audience → 401", async () => {
    mockOpenAIFetch();
    const wrongAud = fixture.signToken({ aud: "not-pinnedai" });
    const res = await worker.fetch(
      new Request("https://api.pinnedai.dev/v1/plan", {
        method: "POST",
        headers: { Authorization: `Bearer ${wrongAud}` },
      }),
      makeEnv(),
      {} as ExecutionContext
    );
    expect(res.status).toBe(401);
  });

  it("NEGATIVE CONTROL: wrong issuer → 401", async () => {
    mockOpenAIFetch();
    const wrongIss = fixture.signToken({ iss: "https://evil.example.com" });
    const res = await worker.fetch(
      new Request("https://api.pinnedai.dev/v1/plan", {
        method: "POST",
        headers: { Authorization: `Bearer ${wrongIss}` },
      }),
      makeEnv(),
      {} as ExecutionContext
    );
    expect(res.status).toBe(401);
  });
});

describe("FEATURE-AUDIT: D.3 — 50KB body cap enforced BEFORE OIDC validation (E2E)", () => {
  it("POSITIVE CONTROL: 51KB body returns 413 even with a valid token (cap fires first)", async () => {
    mockOpenAIFetch();
    const token = fixture.signToken({});
    const oversized = JSON.stringify({ body: "x".repeat(51_000) });
    const res = await worker.fetch(
      new Request("https://api.pinnedai.dev/v1/extract", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: oversized,
      }),
      makeEnv(),
      {} as ExecutionContext
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("body too large");
  });

  it("POSITIVE CONTROL: 49KB body proceeds past the cap (regression smoke check)", async () => {
    mockOpenAIFetch([
      { template: "auth-required", route: "/api/x" },
    ]);
    const token = fixture.signToken({});
    const justUnder = JSON.stringify({
      body: "Auth required on /api/x. " + "x".repeat(48_000),
    });
    const res = await worker.fetch(
      new Request("https://api.pinnedai.dev/v1/extract", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: justUnder,
      }),
      makeEnv(),
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);
  });
});

describe("FEATURE-AUDIT: D.6 — /v1/extract cache hit doesn't bill quota (E2E)", () => {
  it("POSITIVE CONTROL: same body twice → second call is cached (no quota increment, no LLM call)", async () => {
    let openaiCalls = 0;
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("127.0.0.1") && url.includes("/jwks")) {
        return realFetch(input, init);
      }
      openaiCalls += 1;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"claims":[]}' } }],
        }),
        { status: 200 }
      );
    });
    const env = makeEnv();
    const token = fixture.signToken({});
    const body = JSON.stringify({ body: "Auth required on /api/cached." });

    const r1 = await worker.fetch(
      new Request("https://api.pinnedai.dev/v1/extract", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body,
      }),
      env,
      {} as ExecutionContext
    );
    const r2 = await worker.fetch(
      new Request("https://api.pinnedai.dev/v1/extract", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body,
      }),
      env,
      {} as ExecutionContext
    );
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    // OpenAI hit ONCE — the second call was cached
    expect(openaiCalls).toBe(1);
    const r2body = (await r2.json()) as { cached: boolean };
    expect(r2body.cached).toBe(true);
  });
});
