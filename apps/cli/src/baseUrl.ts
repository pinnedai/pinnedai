// Zero-config base URL resolution for smoke/render-collection pins.
//
// Per Cipherwake-dogfood Gap 3b: the reason pins skip locally is they
// wait for a base URL nobody wants to configure. Fix is not "document
// the env var better" — it's never ask for it.
//
// Resolution chain (priority order — first match wins):
//   1. Explicit override env vars:
//        PINNED_SMOKE_BASE_URL  (most specific — smoke runs)
//        PINNED_BASE_URL        (general — all pin runs)
//        PREVIEW_URL            (legacy)
//        PINNED_CI_BASE_URL     (legacy)
//   2. CI platform auto-detect:
//        Vercel:   VERCEL_BRANCH_URL > VERCEL_URL > VERCEL_PROJECT_PRODUCTION_URL
//        Netlify:  DEPLOY_PRIME_URL > URL
//        CF Pages: CF_PAGES_URL
//        Render:   RENDER_EXTERNAL_URL
//        (These vars are injected by the platform on every deploy.
//         The repo on Vercel CI Just Works — zero configuration.)
//   3. Last-known-good cache: .pinned/base-url.json (written by
//        `pinned dev` when it boots a local server, or by any prior
//        run that resolved a URL via 1 or 2).
//   4. Author-declared defaultBaseUrl on the claim.
//   5. nothing → return null. Caller surfaces a LOUD single-line
//        diagnostic via formatLoudSkipMessage() — never a silent skip.
//
// Browser-safety: this module is Node-only (reads filesystem + env).
// The smoke template emits the resolution logic INLINE (as JS source)
// rather than importing this module at runtime — `templateInlineSource()`
// returns the resolveBaseUrl function body as a string for that.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

export type ResolvedBaseUrl = {
  url: string;
  source:
    | "env:PINNED_SMOKE_BASE_URL"
    | "env:PINNED_BASE_URL"
    | "env:PREVIEW_URL"
    | "env:PINNED_CI_BASE_URL"
    | "vercel"
    | "netlify"
    | "cf-pages"
    | "render"
    | "cache"
    | "claim-default";
};

const CACHE_PATH = ".pinned/base-url.json";

function normalizeUrl(raw: string): string {
  // CI-provider env vars often come without https:// prefix
  // (VERCEL_URL = "myapp-abc123.vercel.app"). Add it.
  if (!/^https?:\/\//i.test(raw)) return `https://${raw}`;
  return raw.replace(/\/+$/, "");
}

// Pure-function resolver — used by the CLI side. The smoke template
// embeds an INLINE copy of the same logic so customer vitest runs
// don't depend on importing pinnedai at runtime.
export function resolveBaseUrl(opts: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  defaultBaseUrl?: string;
} = {}): ResolvedBaseUrl | null {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();

  // 1. Explicit overrides — honor but never required.
  if (env.PINNED_SMOKE_BASE_URL) return { url: normalizeUrl(env.PINNED_SMOKE_BASE_URL), source: "env:PINNED_SMOKE_BASE_URL" };
  if (env.PINNED_BASE_URL)        return { url: normalizeUrl(env.PINNED_BASE_URL),       source: "env:PINNED_BASE_URL" };
  if (env.PREVIEW_URL)            return { url: normalizeUrl(env.PREVIEW_URL),           source: "env:PREVIEW_URL" };
  if (env.PINNED_CI_BASE_URL)     return { url: normalizeUrl(env.PINNED_CI_BASE_URL),    source: "env:PINNED_CI_BASE_URL" };

  // 2. CI platform auto-detect. Order matters — VERCEL_BRANCH_URL is
  // the per-branch preview (what we usually want); VERCEL_URL is the
  // current deployment alias; VERCEL_PROJECT_PRODUCTION_URL is the
  // primary domain (last resort).
  if (env.VERCEL_BRANCH_URL)               return { url: normalizeUrl(env.VERCEL_BRANCH_URL),               source: "vercel" };
  if (env.VERCEL_URL)                      return { url: normalizeUrl(env.VERCEL_URL),                      source: "vercel" };
  if (env.VERCEL_PROJECT_PRODUCTION_URL)   return { url: normalizeUrl(env.VERCEL_PROJECT_PRODUCTION_URL),   source: "vercel" };
  if (env.DEPLOY_PRIME_URL)                return { url: normalizeUrl(env.DEPLOY_PRIME_URL),                source: "netlify" };
  if (env.URL && env.NETLIFY === "true")   return { url: normalizeUrl(env.URL),                             source: "netlify" };
  if (env.CF_PAGES_URL)                    return { url: normalizeUrl(env.CF_PAGES_URL),                    source: "cf-pages" };
  if (env.RENDER_EXTERNAL_URL)             return { url: normalizeUrl(env.RENDER_EXTERNAL_URL),             source: "render" };

  // 3. Last-known-good cache.
  const cachePath = join(cwd, CACHE_PATH);
  if (existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, "utf8")) as { url?: string; writtenAt?: string };
      if (typeof cached.url === "string" && cached.url) {
        return { url: normalizeUrl(cached.url), source: "cache" };
      }
    } catch { /* corrupt cache — fall through */ }
  }

  // 4. Author-declared default.
  if (opts.defaultBaseUrl) return { url: normalizeUrl(opts.defaultBaseUrl), source: "claim-default" };

  return null;
}

// Cache the resolved URL so subsequent `pinned test` runs reuse it.
// `pinned dev` calls this after booting a local server; CI runs may
// also call it after first successful resolve.
export function cacheBaseUrl(cwd: string, url: string, sourceTag: string): void {
  const cachePath = join(cwd, CACHE_PATH);
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(
    cachePath,
    JSON.stringify({ url: normalizeUrl(url), source: sourceTag, writtenAt: new Date().toISOString() }, null, 2) + "\n"
  );
}

// Loud single-line skip diagnostic. Per Gap 3b spec: "a silent
// `20 skipped` that reads as 'all clear' is the actual trap; a skip
// must announce itself." Caller emits this on a single console.warn
// / stderr line so it's visible in any test report.
export function formatLoudSkipMessage(): string {
  return `pinned: no base URL (not on a known CI provider, no local server). Run \`pinned dev\` or set PINNED_BASE_URL.`;
}

// Returns the JS source for the inline resolver embedded in every
// smoke .test.ts. Same logic as resolveBaseUrl() above but as a
// string the template can splice in. Keeping a single source of
// truth here means future env-var additions only touch one place.
//
// IMPORTANT: the inline version reads from `globalThis.process?.env`
// so the same code works in Node test contexts. It does NOT read the
// .pinned/base-url.json cache from inside the test — that's the
// CLI's job (pinned dev writes the cache, then the test resolver
// reads via the PINNED_SMOKE_BASE_URL env var that pinned dev sets
// before spawning vitest). Keeps the test code filesystem-free.
export function templateInlineResolverSource(): string {
  return `
function __pinnedResolveBaseUrl(defaultBaseUrl) {
  const env = (globalThis.process && globalThis.process.env) || {};
  const norm = (s) => { if (!s) return null; const t = /^https?:\\/\\//i.test(s) ? s : 'https://' + s; return t.replace(/\\/+$/, ''); };
  return norm(env.PINNED_SMOKE_BASE_URL)
      || norm(env.PINNED_BASE_URL)
      || norm(env.PREVIEW_URL)
      || norm(env.PINNED_CI_BASE_URL)
      || norm(env.VERCEL_BRANCH_URL)
      || norm(env.VERCEL_URL)
      || norm(env.VERCEL_PROJECT_PRODUCTION_URL)
      || norm(env.DEPLOY_PRIME_URL)
      || (env.NETLIFY === 'true' && norm(env.URL))
      || norm(env.CF_PAGES_URL)
      || norm(env.RENDER_EXTERNAL_URL)
      || norm(defaultBaseUrl)
      || null;
}
function __pinnedLoudSkipMsg() {
  return 'pinned: no base URL (not on a known CI provider, no local server). Run \\\`pinned dev\\\` or set PINNED_BASE_URL.';
}
`.trim();
}
