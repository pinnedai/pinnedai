// FEATURE: BYOK direct-provider call headers (E.7, E.8)
// SIGNAL: when BYOK is active + paid plan, the direct-call uses:
//   - Anthropic: `x-api-key` header + `anthropic-version` header
//   - OpenAI: `Authorization: Bearer` header
//   PR body never transits our Worker.
// FALSIFIABILITY: catches a regression where the wrong header
//   scheme is used (request would 401 at the provider; customer
//   sees confusing failure).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { extractDirect } from "../../apps/cli/src/llmDirect.js";

const originalFetch = globalThis.fetch;
const calls: Array<{ url: string; headers: Headers; body: string }> = [];

beforeEach(() => {
  calls.length = 0;
  // Replace fetch with a spy that captures URL + headers + body and
  // returns a minimal valid response so extractDirect doesn't throw.
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = new Headers(init?.headers);
    const body =
      typeof init?.body === "string"
        ? init.body
        : init?.body
          ? JSON.stringify(init.body)
          : "";
    calls.push({ url, headers, body });
    // Return shape that matches what each provider produces so
    // extractDirect's response parser doesn't crash.
    if (url.includes("anthropic")) {
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: '{"claims":[]}' }],
        }),
        { status: 200 }
      );
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: '{"claims":[]}' } }],
      }),
      { status: 200 }
    );
  });
  delete process.env.PINNEDAI_BYOK;
  delete process.env.PINNEDAI_ANTHROPIC_KEY;
  delete process.env.PINNEDAI_OPENAI_KEY;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("FEATURE-AUDIT: E.7 — BYOK Anthropic uses x-api-key + anthropic-version headers", () => {
  it("POSITIVE CONTROL: Anthropic call goes to api.anthropic.com with x-api-key header", async () => {
    process.env.PINNEDAI_BYOK = "anthropic";
    process.env.PINNEDAI_ANTHROPIC_KEY = "sk-ant-test-key-123";
    const result = await extractDirect("Auth required on /api/x.");
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("api.anthropic.com");
    expect(calls[0].headers.get("x-api-key")).toBe("sk-ant-test-key-123");
    expect(calls[0].headers.get("anthropic-version")).toBeTruthy();
  });

  it("NEGATIVE CONTROL: Anthropic call does NOT send Authorization: Bearer (wrong scheme)", async () => {
    process.env.PINNEDAI_BYOK = "anthropic";
    process.env.PINNEDAI_ANTHROPIC_KEY = "sk-ant-test-key-123";
    await extractDirect("Auth required on /api/x.");
    expect(calls[0].headers.get("Authorization")).toBeNull();
  });
});

describe("FEATURE-AUDIT: E.8 — BYOK OpenAI uses Authorization: Bearer header", () => {
  it("POSITIVE CONTROL: OpenAI call goes to api.openai.com with Bearer token", async () => {
    process.env.PINNEDAI_BYOK = "openai";
    process.env.PINNEDAI_OPENAI_KEY = "sk-openai-test-456";
    const result = await extractDirect("Auth required on /api/x.");
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("api.openai.com");
    expect(calls[0].headers.get("Authorization")).toBe(
      "Bearer sk-openai-test-456"
    );
  });

  it("NEGATIVE CONTROL: OpenAI call does NOT use x-api-key (Anthropic's scheme)", async () => {
    process.env.PINNEDAI_BYOK = "openai";
    process.env.PINNEDAI_OPENAI_KEY = "sk-openai-test";
    await extractDirect("Auth required on /api/x.");
    expect(calls[0].headers.get("x-api-key")).toBeNull();
  });
});

describe("FEATURE-AUDIT: E.7+E.8 falsifiability — provider calls go ONLY to the chosen provider", () => {
  it("Anthropic BYOK never calls api.openai.com", async () => {
    process.env.PINNEDAI_BYOK = "anthropic";
    process.env.PINNEDAI_ANTHROPIC_KEY = "sk-ant-x";
    await extractDirect("Auth required on /api/x.");
    expect(calls.every((c) => !c.url.includes("api.openai.com"))).toBe(true);
  });
  it("OpenAI BYOK never calls api.anthropic.com", async () => {
    process.env.PINNEDAI_BYOK = "openai";
    process.env.PINNEDAI_OPENAI_KEY = "sk-x";
    await extractDirect("Auth required on /api/x.");
    expect(calls.every((c) => !c.url.includes("api.anthropic.com"))).toBe(true);
  });
});
