// Template generator for render-collection pins (Cipherwake Gap 1).
//
// Renders EVERY route in a collection (idea slugs, blog posts, product
// pages, etc.) — not just a single literal slug. Catches the dominant
// failure mode on multi-tenant / template-per-row apps: a malformed
// row crashes only its own route while every other route stays green.
//
// Repro from the socialideagen session:
//   generateStaticParams() prerendered 33 slugs.
//   resolveIdea() 404'd anything with status="draft" (9 of them).
//   The single-slug benchmob pin was green. 9 routes invisible.
// This pin closes that gap structurally.
//
// Browser-safety: the emitted test code uses dynamic import() to
// reach generateStaticParams / collection-getter modules at run time.
// Vitest can resolve TS files via its own module loader — the test
// runner already supports this. The template emitter (this file) is
// browser-safe (no Node imports).

import type { RenderCollectionClaim } from "../claimParser.js";
import { claimSlug } from "../claimParser.js";
import type { GenerateOpts, GeneratedTest } from "./rateLimit.js";

function lit(x: unknown): string {
  return JSON.stringify(x);
}

export function generateRenderCollectionTest(
  claim: RenderCollectionClaim,
  opts: GenerateOpts
): GeneratedTest {
  const slug = claimSlug(claim);
  const claimId = `${opts.prId}-${slug}`;
  const filename = `${claimId}.test.ts`;

  const routes = claim.routes;
  const expect = claim.expect;
  const cap = claim.cap ?? {};
  const maxRoutes = cap.maxRoutes ?? 20;
  const sampleMode = cap.sample ?? "deterministic";

  // The path template: "/preview/[slug]" → at runtime we'll substitute
  // the param values. Detect the param name from the [bracket] token.
  const paramMatch = /\[(\w+)\]/.exec(claim.pathTemplate);
  const paramName = paramMatch ? paramMatch[1] : "slug";

  const header = `// ═══════════════════════════════════════════════════════════════
// ◆ Pinned by pinnedai — https://pinnedai.dev
// generated-by: pinnedai@${opts.pinnedVersion}
// ═══════════════════════════════════════════════════════════════
// Render-collection pin (Cipherwake Gap 1)
// Path template: ${claim.pathTemplate}
// Routes from:   ${routes.from}
// Cap:           ${maxRoutes} routes (${sampleMode} sample)
//
// To retire: pinned retire ${claimId} --reason="..."
// ═══════════════════════════════════════════════════════════════
//
// What this pin asserts: every route in the declared collection
// renders healthily. Catches the "malformed row crashes only its own
// route" failure mode that single-slug pins are blind to.
//
// Adding a new row covers it AUTOMATICALLY — no pin edit. That's
// the whole point.
//
// WARN-on-missing-env: skips with a loud single line if no base URL
// is resolvable (Vercel CI / pinned dev / explicit env). Never silent.`;

  const body = `
import { describe, it, expect } from "vitest";

const PATH_TEMPLATE = ${lit(claim.pathTemplate)};
const PARAM_NAME = ${lit(paramName)};
const ROUTES_CONFIG: any = ${lit(routes)};
const EXPECT_CONFIG: any = ${lit(expect)};
const MAX_ROUTES = ${maxRoutes};
const SAMPLE_MODE = ${lit(sampleMode)};

function env(name: string): string | undefined {
  return (globalThis as any).process?.env?.[name];
}

// Cipherwake Gap 3b — zero-config base URL resolution.
function __pinnedNormUrl(s: string | undefined): string | null {
  if (!s) return null;
  const t = /^https?:\\/\\//i.test(s) ? s : "https://" + s;
  return t.replace(/\\/+$/, "");
}
function resolveBaseUrl(): string | null {
  return __pinnedNormUrl(env("PINNED_SMOKE_BASE_URL"))
      || __pinnedNormUrl(env("PINNED_BASE_URL"))
      || __pinnedNormUrl(env("PREVIEW_URL"))
      || __pinnedNormUrl(env("PINNED_CI_BASE_URL"))
      || __pinnedNormUrl(env("VERCEL_BRANCH_URL"))
      || __pinnedNormUrl(env("VERCEL_URL"))
      || __pinnedNormUrl(env("VERCEL_PROJECT_PRODUCTION_URL"))
      || __pinnedNormUrl(env("DEPLOY_PRIME_URL"))
      || (env("NETLIFY") === "true" ? __pinnedNormUrl(env("URL")) : null)
      || __pinnedNormUrl(env("CF_PAGES_URL"))
      || __pinnedNormUrl(env("RENDER_EXTERNAL_URL"))
      || null;
}
function __pinnedLoudSkipMsg(): string {
  return "pinned: no base URL (not on a known CI provider, no local server). Run \\\`pinned dev\\\` or set PINNED_BASE_URL.";
}

// Deterministic hash → stable sample order. Same input always returns
// the same N items, so re-runs cover the same set.
function __pinnedHashSort(items: string[]): string[] {
  function hash(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return h;
  }
  return [...items].sort((a, b) => hash(a) - hash(b));
}

async function __pinnedEnumerateRoutes(baseUrl: string): Promise<string[]> {
  const cfg = ROUTES_CONFIG;
  if (cfg.from === "generate-static-params") {
    const mod: any = await import(/* @vite-ignore */ "/" + cfg.modulePath.replace(/^\\/+/, ""));
    const fn = mod.generateStaticParams;
    if (typeof fn !== "function") {
      throw new Error(\`generate-static-params source \${cfg.modulePath} does not export generateStaticParams\`);
    }
    const items = await fn();
    if (!Array.isArray(items)) {
      throw new Error(\`generateStaticParams returned non-array (\${typeof items})\`);
    }
    return items.map((it: any) => String(it[PARAM_NAME])).filter(Boolean);
  }
  if (cfg.from === "collection-getter") {
    const mod: any = await import(/* @vite-ignore */ "/" + cfg.modulePath.replace(/^\\/+/, ""));
    const fn = cfg.exportName === "default" ? mod.default : mod[cfg.exportName];
    if (typeof fn !== "function") {
      throw new Error(\`collection-getter \${cfg.modulePath}#\${cfg.exportName} is not a function\`);
    }
    const items = await fn();
    if (!Array.isArray(items)) {
      throw new Error(\`collection-getter returned non-array (\${typeof items})\`);
    }
    const field = cfg.slugField ?? "slug";
    return items.map((it: any) => String(it[field])).filter(Boolean);
  }
  if (cfg.from === "sitemap") {
    const res = await fetch(baseUrl + "/sitemap.xml");
    if (!res.ok) throw new Error(\`sitemap fetch failed: \${res.status}\`);
    const xml = await res.text();
    const locs: string[] = [];
    const re = /<loc>\\s*([^<]+?)\\s*<\\/loc>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
      const url = m[1];
      const prefix = cfg.prefix;
      try {
        const path = new URL(url).pathname;
        if (path.startsWith(prefix)) locs.push(path.slice(prefix.length));
      } catch { /* skip malformed */ }
    }
    return locs;
  }
  throw new Error(\`Unknown routes.from: \${cfg.from}\`);
}

// Error-boundary detection. Looks for Next/React error markers in
// the rendered HTML. Same heuristic as page-renders pins.
function __pinnedHasErrorBoundary(html: string): { found: boolean; marker?: string } {
  const markers = [
    "__next_error__",
    "react-router-error-boundary",
    "Application error: a client-side exception",
    "This page could not be rendered",
    "Unhandled Runtime Error",
    "Hydration failed because",
  ];
  for (const m of markers) {
    if (html.includes(m)) return { found: true, marker: m };
  }
  return { found: false };
}

function __pinnedHasNotFoundShape(_html: string, status: number): boolean {
  // 0.4.1 Bug 2 fix (Cipherwake-reported): the body-substring heuristic
  // ("This page could not be found", "Page Not Found", "404 -")
  // false-positives on every healthy 200 page in Next.js App Router.
  // Reason: Next embeds the not-found boundary in EVERY page's streamed
  // RSC payload — so a healthy 200 page also contains those markers
  // (from the not-found component that exists in the tree but isn't
  // shown). Trust the HTTP status instead. notFound() in Next.js
  // returns 404 (both Pages and App routers), so the status check IS
  // the signal. The visibility-invariant pin gets this right — render-
  // collection now matches.
  return status === 404;
}

describe(\`render-collection (\${PATH_TEMPLATE})\`, () => {
  const baseUrl = resolveBaseUrl();
  if (!baseUrl) {
    if (typeof console !== "undefined") console.warn(__pinnedLoudSkipMsg());
    it.skip(__pinnedLoudSkipMsg(), () => {});
    return;
  }
  // Hoist route enumeration so each slug becomes its own \`it\` —
  // this is what makes vitest's report say WHICH slug failed.
  // Vitest doesn't easily support async-collected dynamic \`it\`
  // entries, so we run all slugs inside a single it() that
  // aggregates per-slug failures and throws once with the
  // full list.
  it("every route in the collection renders healthily", async () => {
    let allSlugs: string[];
    try {
      allSlugs = await __pinnedEnumerateRoutes(baseUrl);
    } catch (e) {
      throw new Error(\`route enumeration failed: \${(e as Error).message}\`);
    }
    if (allSlugs.length === 0) {
      throw new Error(\`route enumeration returned 0 slugs from \${ROUTES_CONFIG.from}\`);
    }
    // Bounded cost — deterministic sample.
    const sortedSlugs = SAMPLE_MODE === "deterministic" ? __pinnedHashSort(allSlugs) : allSlugs;
    const slugs = sortedSlugs.slice(0, MAX_ROUTES);
    if (allSlugs.length > MAX_ROUTES) {
      console.log(\`pinned render-collection: covered \${slugs.length}/\${allSlugs.length} routes (deterministic sample)\`);
    }

    const failures: Array<{ slug: string; reason: string }> = [];
    const expectedStatus = EXPECT_CONFIG.status ?? 200;
    const minBytes = EXPECT_CONFIG.minBodyBytes ?? 500;
    const checkBoundary = EXPECT_CONFIG.noErrorBoundary !== false;
    const notFoundOk = EXPECT_CONFIG.notFoundOk === true;

    for (const slug of slugs) {
      const url = baseUrl + PATH_TEMPLATE.replace(\`[\${PARAM_NAME}]\`, encodeURIComponent(slug));
      try {
        const r = await fetch(url, { redirect: "manual" });
        if (r.status !== expectedStatus) {
          if (!notFoundOk || r.status !== 404) {
            failures.push({ slug, reason: \`expected status \${expectedStatus}, got \${r.status}\` });
            continue;
          }
        }
        const html = await r.text();
        if (html.length < minBytes) {
          failures.push({ slug, reason: \`body too short (\${html.length} bytes; min \${minBytes})\` });
          continue;
        }
        if (checkBoundary) {
          const b = __pinnedHasErrorBoundary(html);
          if (b.found) {
            failures.push({ slug, reason: \`error boundary marker present: "\${b.marker}"\` });
            continue;
          }
        }
        if (!notFoundOk && __pinnedHasNotFoundShape(html, r.status)) {
          failures.push({ slug, reason: \`notFound() shape detected (prerendered but resolver 404s)\` });
          continue;
        }
      } catch (e) {
        failures.push({ slug, reason: \`fetch threw: \${(e as Error).message}\` });
      }
    }

    if (failures.length > 0) {
      const summary = failures.map((f) => \`  - \${f.slug}: \${f.reason}\`).join("\\n");
      throw new Error(
        \`Render-collection: \${failures.length} of \${slugs.length} routes failed under \${PATH_TEMPLATE}\\n\${summary}\`
      );
    }
    expect(failures.length).toBe(0);
  }, 240_000);
});
`;

  const content = header + body;
  return { filename, content, claimId };
}
