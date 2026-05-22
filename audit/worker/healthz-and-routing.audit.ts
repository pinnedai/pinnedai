// FEATURE: Worker `/healthz` + 404 + admin auth (D.1, D.12, D.15)
// SIGNAL: GET /healthz → 200 with {ok: true, service: "pinnedai-edge"}.
//   Unknown paths → 404. /admin/* without admin key → 401.
//   Query-param ?key= is REJECTED (header-only).
// FALSIFIABILITY: catches route registration drift, the admin
//   query-param leak being re-introduced, or the 404 fallback breaking.

import { describe, it, expect } from "vitest";
import worker from "../../apps/edge/src/index.js";
import { createMockD1 } from "./mockD1.js";

function makeEnv() {
  return {
    QUOTA: createMockD1(),
    OPENAI_API_KEY: "test-openai",
    ADMIN_KEY: "test-admin",
    FREE_QUOTA_PER_MONTH: "100",
    FREE_QUOTA_PUBLIC_PER_MONTH: "500",
    FREE_QUOTA_PRIVATE_PER_MONTH: "100",
    FREE_BUDGET_TOTAL_PER_MONTH: "1000",
    GITHUB_JWKS_URL: "https://example.invalid/jwks",
    OIDC_AUDIENCE: "pinnedai",
  } as unknown as Parameters<typeof worker.fetch>[1];
}

describe("FEATURE-AUDIT: Worker /healthz", () => {
  it("POSITIVE CONTROL: GET /healthz → 200 + JSON {ok:true, service:'pinnedai-edge'}", async () => {
    const res = await worker.fetch(
      new Request("https://api.pinnedai.dev/healthz"),
      makeEnv(),
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; service: string };
    expect(body.ok).toBe(true);
    expect(body.service).toBe("pinnedai-edge");
  });

  it("NEGATIVE CONTROL: POST /healthz returns 404 (only GET is registered)", async () => {
    const res = await worker.fetch(
      new Request("https://api.pinnedai.dev/healthz", { method: "POST" }),
      makeEnv(),
      {} as ExecutionContext
    );
    expect(res.status).toBe(404);
  });

  it("NEGATIVE CONTROL: GET /not-a-route → 404 (catch-all)", async () => {
    const res = await worker.fetch(
      new Request("https://api.pinnedai.dev/not-a-route"),
      makeEnv(),
      {} as ExecutionContext
    );
    expect(res.status).toBe(404);
  });
});

describe("FEATURE-AUDIT: D.15 — admin auth is header-only (query-param leak guard)", () => {
  it("POSITIVE CONTROL: X-Admin-Key header matching ADMIN_KEY succeeds", async () => {
    const res = await worker.fetch(
      new Request("https://api.pinnedai.dev/admin/stats", {
        headers: { "X-Admin-Key": "test-admin" },
      }),
      makeEnv(),
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);
  });

  it("POSITIVE CONTROL: Authorization: Bearer also succeeds", async () => {
    const res = await worker.fetch(
      new Request("https://api.pinnedai.dev/admin/stats", {
        headers: { Authorization: "Bearer test-admin" },
      }),
      makeEnv(),
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);
  });

  it("NEGATIVE CONTROL: query param ?key=... is IGNORED → 401", async () => {
    // This guards against the leak surface where query params end up
    // in server logs / GitHub Actions logs / browser history.
    const res = await worker.fetch(
      new Request("https://api.pinnedai.dev/admin/stats?key=test-admin"),
      makeEnv(),
      {} as ExecutionContext
    );
    expect(res.status).toBe(401);
  });

  it("NEGATIVE CONTROL: wrong header key → 401", async () => {
    const res = await worker.fetch(
      new Request("https://api.pinnedai.dev/admin/stats", {
        headers: { "X-Admin-Key": "wrong-key" },
      }),
      makeEnv(),
      {} as ExecutionContext
    );
    expect(res.status).toBe(401);
  });
});

describe("FEATURE-AUDIT: D.13 — /admin/stats returns expected fields", () => {
  it("POSITIVE CONTROL: response includes month + totalCalls + cachedHashes + topConsumers + activeSubscriptions", async () => {
    const res = await worker.fetch(
      new Request("https://api.pinnedai.dev/admin/stats", {
        headers: { "X-Admin-Key": "test-admin" },
      }),
      makeEnv(),
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("month");
    expect(body).toHaveProperty("totalCalls");
    expect(body).toHaveProperty("cachedHashes");
    expect(body).toHaveProperty("topConsumers");
    expect(body).toHaveProperty("activeSubscriptions");
    expect(body).toHaveProperty("estimatedOpenAICost");
  });
});
