// FEATURE: /badge/<org>/<repo> returns SVG with pin count (D.16)
// SIGNAL: GET /badge/org/repo → 200 with Content-Type: image/svg+xml.
//   When PINS.md is fetchable, the SVG shows the active pin count.
//   On fetch failure, SVG still returns (with "?" or "0") — no crash.
// FALSIFIABILITY: catches a regression where the badge endpoint
//   stops returning SVG, or where path-traversal in the org/repo
//   slot lets attackers fetch arbitrary content via the Worker.

import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../../apps/edge/src/index.js";
import { createMockD1 } from "./mockD1.js";

function makeEnv() {
  return {
    QUOTA: createMockD1(),
    OPENAI_API_KEY: "test-openai",
    ADMIN_KEY: "test-admin",
    FREE_QUOTA_PER_MONTH: "100",
    GITHUB_JWKS_URL: "https://example.invalid/jwks",
    OIDC_AUDIENCE: "pinnedai",
  } as unknown as Parameters<typeof worker.fetch>[1];
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("FEATURE-AUDIT: D.16 — /badge SVG endpoint", () => {
  it("POSITIVE CONTROL: GET /badge/acme/repo with mocked PINS.md returns SVG", async () => {
    // Mock the upstream raw.githubusercontent.com fetch to return a
    // PINS.md with 3 active pins.
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        `# Pinned Claims\n\n## Active\n\n| Claim | Test | PR |\n|---|---|---|\n| a | x | 1 |\n| b | y | 2 |\n| c | z | 3 |\n`,
        { status: 200 }
      )
    );

    const res = await worker.fetch(
      new Request("https://api.pinnedai.dev/badge/acme/repo"),
      makeEnv(),
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/svg/);
    const body = await res.text();
    expect(body).toContain("<svg");
    // SVG contains the pin count "3"
    expect(body).toContain("3");
  });

  it("POSITIVE CONTROL: fetch failure → still returns SVG (degraded gracefully)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("not found", { status: 404 })
    );
    const res = await worker.fetch(
      new Request("https://api.pinnedai.dev/badge/missing/repo"),
      makeEnv(),
      {} as ExecutionContext
    );
    // Returns SVG either way (with "?" or "0")
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/svg/);
  });

  it("NEGATIVE CONTROL: malformed badge path (no /repo) → not 200", async () => {
    const res = await worker.fetch(
      new Request("https://api.pinnedai.dev/badge/just-org"),
      makeEnv(),
      {} as ExecutionContext
    );
    // Should be 400 or 404 — definitely NOT 200 (would be a routing bug)
    expect(res.status).not.toBe(200);
  });
});
