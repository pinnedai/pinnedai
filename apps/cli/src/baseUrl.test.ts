import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBaseUrl, cacheBaseUrl, formatLoudSkipMessage, templateInlineResolverSource } from "./baseUrl.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pinned-baseurl-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveBaseUrl — env override priority", () => {
  it("PINNED_SMOKE_BASE_URL beats every other env var", () => {
    const r = resolveBaseUrl({
      cwd: dir,
      env: {
        PINNED_SMOKE_BASE_URL: "http://localhost:3000",
        PINNED_BASE_URL: "https://wrong",
        VERCEL_URL: "wrong.vercel.app",
      },
    });
    expect(r?.url).toBe("http://localhost:3000");
    expect(r?.source).toBe("env:PINNED_SMOKE_BASE_URL");
  });

  it("PINNED_BASE_URL is honored when PINNED_SMOKE_BASE_URL is missing", () => {
    const r = resolveBaseUrl({ cwd: dir, env: { PINNED_BASE_URL: "https://my-app.local" } });
    expect(r?.url).toBe("https://my-app.local");
    expect(r?.source).toBe("env:PINNED_BASE_URL");
  });

  it("legacy PREVIEW_URL still works", () => {
    const r = resolveBaseUrl({ cwd: dir, env: { PREVIEW_URL: "https://preview.example" } });
    expect(r?.url).toBe("https://preview.example");
    expect(r?.source).toBe("env:PREVIEW_URL");
  });
});

describe("resolveBaseUrl — CI platform auto-detect (zero config)", () => {
  it("Vercel: VERCEL_BRANCH_URL wins (per-branch preview)", () => {
    const r = resolveBaseUrl({
      cwd: dir,
      env: {
        VERCEL_BRANCH_URL: "feature-x-myapp-abc123.vercel.app",
        VERCEL_URL: "myapp-abc123.vercel.app",
        VERCEL_PROJECT_PRODUCTION_URL: "myapp.com",
      },
    });
    expect(r?.url).toBe("https://feature-x-myapp-abc123.vercel.app");
    expect(r?.source).toBe("vercel");
  });

  it("Vercel: VERCEL_URL is second choice (auto-prefixes https://)", () => {
    const r = resolveBaseUrl({ cwd: dir, env: { VERCEL_URL: "myapp-abc123.vercel.app" } });
    expect(r?.url).toBe("https://myapp-abc123.vercel.app");
    expect(r?.source).toBe("vercel");
  });

  it("Netlify: DEPLOY_PRIME_URL is the per-PR preview", () => {
    const r = resolveBaseUrl({ cwd: dir, env: { DEPLOY_PRIME_URL: "https://deploy-preview-42.netlify.app" } });
    expect(r?.url).toBe("https://deploy-preview-42.netlify.app");
    expect(r?.source).toBe("netlify");
  });

  it("Netlify: bare URL only counts when NETLIFY=true is set (avoid collision with other 'URL' vars)", () => {
    const collision = resolveBaseUrl({ cwd: dir, env: { URL: "https://something-else" } });
    expect(collision).toBeNull();
    const netlify = resolveBaseUrl({ cwd: dir, env: { URL: "https://app.netlify.app", NETLIFY: "true" } });
    expect(netlify?.source).toBe("netlify");
  });

  it("Cloudflare Pages: CF_PAGES_URL", () => {
    const r = resolveBaseUrl({ cwd: dir, env: { CF_PAGES_URL: "https://app.pages.dev" } });
    expect(r?.source).toBe("cf-pages");
  });

  it("Render: RENDER_EXTERNAL_URL", () => {
    const r = resolveBaseUrl({ cwd: dir, env: { RENDER_EXTERNAL_URL: "https://app.onrender.com" } });
    expect(r?.source).toBe("render");
  });

  it("explicit overrides beat CI auto-detect", () => {
    const r = resolveBaseUrl({
      cwd: dir,
      env: {
        VERCEL_BRANCH_URL: "wrong.vercel.app",
        PINNED_BASE_URL: "https://override",
      },
    });
    expect(r?.url).toBe("https://override");
  });
});

describe("cacheBaseUrl + cache read", () => {
  it("written cache is read on subsequent resolve when no env vars set", () => {
    cacheBaseUrl(dir, "http://localhost:3000", "pinned-dev");
    const r = resolveBaseUrl({ cwd: dir, env: {} });
    expect(r?.url).toBe("http://localhost:3000");
    expect(r?.source).toBe("cache");
  });

  it("env vars beat the cache", () => {
    cacheBaseUrl(dir, "http://localhost:3000", "pinned-dev");
    const r = resolveBaseUrl({ cwd: dir, env: { VERCEL_BRANCH_URL: "ci.vercel.app" } });
    expect(r?.source).toBe("vercel");
  });

  it("corrupt cache file does not throw — falls through", () => {
    mkdirSync(join(dir, ".pinned"), { recursive: true });
    writeFileSync(join(dir, ".pinned/base-url.json"), "{not json");
    const r = resolveBaseUrl({ cwd: dir, env: {}, defaultBaseUrl: "http://localhost:3000" });
    expect(r?.source).toBe("claim-default");
  });
});

describe("resolveBaseUrl — fallback + null", () => {
  it("falls back to defaultBaseUrl when no env / no cache", () => {
    const r = resolveBaseUrl({ cwd: dir, env: {}, defaultBaseUrl: "http://localhost:3000" });
    expect(r?.url).toBe("http://localhost:3000");
    expect(r?.source).toBe("claim-default");
  });

  it("returns null when nothing resolves (caller emits loud skip)", () => {
    expect(resolveBaseUrl({ cwd: dir, env: {} })).toBeNull();
  });
});

describe("formatLoudSkipMessage", () => {
  it("is a single concrete actionable line, not a vague warning", () => {
    const m = formatLoudSkipMessage();
    expect(m).toContain("no base URL");
    expect(m).toContain("pinned dev");
    expect(m).toContain("PINNED_BASE_URL");
    expect(m.split("\n").length).toBe(1);
  });
});

describe("templateInlineResolverSource — embedded in smoke .test.ts", () => {
  it("emits a function named __pinnedResolveBaseUrl that resolves the same chain", () => {
    const src = templateInlineResolverSource();
    expect(src).toContain("__pinnedResolveBaseUrl");
    expect(src).toContain("PINNED_SMOKE_BASE_URL");
    expect(src).toContain("VERCEL_BRANCH_URL");
    expect(src).toContain("DEPLOY_PRIME_URL");
    expect(src).toContain("CF_PAGES_URL");
    expect(src).toContain("RENDER_EXTERNAL_URL");
  });

  it("inline resolver evaluates to the same priority order as resolveBaseUrl", () => {
    // Evaluate the inline source in a controlled scope + verify it
    // matches the Node-side resolver for the same env.
    const src = templateInlineResolverSource();
    const factory = new Function(`${src}; return __pinnedResolveBaseUrl;`);
    const inlineResolve = factory() as (def?: string) => string | null;
    const fakeEnv = { PINNED_BASE_URL: "https://override", VERCEL_URL: "wrong" };
    // Patch globalThis.process briefly.
    const origProc = (globalThis as any).process;
    (globalThis as any).process = { env: fakeEnv };
    try {
      expect(inlineResolve()).toBe("https://override");
    } finally {
      (globalThis as any).process = origProc;
    }
  });
});
