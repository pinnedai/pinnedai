// 0.5.0-beta — browser-mode render-collection pin (Cipherwake
// Features 1+2). Same enumerate-each-route model as the HTTP-only
// render template; the difference is the assertion layer.
//
// The HTTP render template proves "the server responded with HTML."
// It doesn't prove the page actually works in a browser. Cipherwake
// reported two concrete failure classes the HTTP pin is structurally
// blind to:
//
//   1. A raw `&` in generated SVG text broke XML parsing → a
//      data-URI SVG hero image rendered 0×0. The page was HTTP 200
//      with full body, the render-collection pin passed, but the
//      hero was invisible.
//
//   2. A new CSP header would silently break client JS — page SSRs
//      to 200 OK, but the script tags blocked → blank in browser,
//      hydration failure, console errors. Identical at the HTTP
//      layer to a healthy page.
//
// Both are caught structurally by loading the page in a real browser
// and asserting:
//   - every <img> (including data:image/svg+xml) has naturalWidth > 0
//   - zero console.error / pageerror / CSP-violation events
//
// Beta posture (per [[anything-annoying-must-be-opt-in]] +
// [[full-stack-roadmap-2026-06-03]]):
//   - Playwright is an optional peer dep. If the import fails at run
//     time, the test SKIPS with a loud WARN — never blocks. Same
//     pattern the HTTP template uses for missing-PREVIEW_URL.
//   - Attach-only: resolveBaseUrl waterfall; never auto-boots.
//   - Severity:"review" so misfires don't inflate breaksCaught.
//   - File name carries `-browser` suffix.

import type { RenderCollectionClaim } from "../claimParser.js";
import { claimSlug } from "../claimParser.js";
import type { GenerateOpts, GeneratedTest } from "./rateLimit.js";

function lit(x: unknown): string {
  return JSON.stringify(x);
}

export function generateRenderCollectionBrowserTest(
  claim: RenderCollectionClaim,
  opts: GenerateOpts
): GeneratedTest {
  if (!claim.browser) {
    throw new Error("generateRenderCollectionBrowserTest called on a claim without .browser — call generateRenderCollectionTest for HTTP-only.");
  }
  const slug = claimSlug(claim) + "-browser";
  const claimId = `${opts.prId}-${slug}`;
  const filename = `${claimId}.test.ts`;

  const routes = claim.routes;
  const cap = claim.cap ?? {};
  const maxRoutes = cap.maxRoutes ?? 20;
  const sampleMode = cap.sample ?? "deterministic";

  const paramMatch = /\[(\w+)\]/.exec(claim.pathTemplate);
  const paramName = paramMatch ? paramMatch[1] : "slug";

  const checkImages = claim.browser.check.includes("images");
  const checkConsole = claim.browser.check.includes("console");
  const timeoutMs = claim.browser.timeoutMs ?? 30_000;
  const waitForNetworkIdle = claim.browser.waitForNetworkIdle !== false;

  const header = `// ═══════════════════════════════════════════════════════════════
// ◆ Pinned by pinnedai — https://pinnedai.dev  [BETA: browser-mode]
// generated-by: pinnedai@${opts.pinnedVersion}
// ═══════════════════════════════════════════════════════════════
// Render-collection BROWSER pin (Cipherwake Features 1+2 — BETA)
// Path template: ${claim.pathTemplate}
// Routes from:   ${routes.from}
// Checks:        ${claim.browser.check.join(", ")}
// Cap:           ${maxRoutes} routes (${sampleMode} sample)
//
// To retire: pinned retire ${claimId} --reason="..."
// ═══════════════════════════════════════════════════════════════
//
// This pin asserts what the HTTP render-collection pin can't:
//${checkImages ? "\n//   - every <img> has naturalWidth > 0 (no 0×0 / broken images)" : ""}${checkConsole ? "\n//   - zero console.error / pageerror / CSP violations" : ""}
//
// REQUIRES Playwright. To install:
//   npm i -D playwright && npx playwright install chromium
// If Playwright isn't installed the test SKIPS with WARN — never
// blocks CI. Adoption-first per Pinned's beta opt-in policy.
//
// REQUIRES a running server (same resolveBaseUrl waterfall as the
// HTTP template). Never auto-boots. Run \`pinned dev\` or set
// PREVIEW_URL / PINNED_BASE_URL.`;

  const body = `
import { describe, it, expect } from "vitest";

const PATH_TEMPLATE = ${lit(claim.pathTemplate)};
const PARAM_NAME = ${lit(paramName)};
const ROUTES_CONFIG: any = ${lit(routes)};
const MAX_ROUTES = ${maxRoutes};
const SAMPLE_MODE = ${lit(sampleMode)};
const CHECK_IMAGES = ${lit(checkImages)};
const CHECK_CONSOLE = ${lit(checkConsole)};
const PAGE_TIMEOUT_MS = ${timeoutMs};
const WAIT_FOR_NETWORK_IDLE = ${lit(waitForNetworkIdle)};

function env(name: string): string | undefined {
  return (globalThis as any).process?.env?.[name];
}

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
    if (!Array.isArray(items)) throw new Error(\`generateStaticParams returned non-array\`);
    return items.map((it: any) => String(it[PARAM_NAME])).filter(Boolean);
  }
  if (cfg.from === "collection-getter") {
    const mod: any = await import(/* @vite-ignore */ "/" + cfg.modulePath.replace(/^\\/+/, ""));
    const fn = cfg.exportName === "default" ? mod.default : mod[cfg.exportName];
    if (typeof fn !== "function") {
      throw new Error(\`collection-getter \${cfg.modulePath}#\${cfg.exportName} is not a function\`);
    }
    const items = await fn();
    if (!Array.isArray(items)) throw new Error(\`collection-getter returned non-array\`);
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
      try {
        const path = new URL(m[1]).pathname;
        if (path.startsWith(cfg.prefix)) locs.push(path.slice(cfg.prefix.length));
      } catch { /* skip malformed */ }
    }
    return locs;
  }
  throw new Error(\`Unknown routes.from: \${cfg.from}\`);
}

// Try to load Playwright. If it's not installed, return null and the
// test skips with WARN. Never blocks CI.
async function __pinnedLoadPlaywright(): Promise<any | null> {
  try {
    // Dynamic import keeps the test file parsable even with no
    // playwright in node_modules; failure path is the import itself.
    const pw = await import("playwright" as any).catch(() => null);
    if (pw && pw.chromium && typeof pw.chromium.launch === "function") return pw;
    return null;
  } catch {
    return null;
  }
}

describe(\`render-collection-browser (\${PATH_TEMPLATE}) [BETA]\`, () => {
  const baseUrl = resolveBaseUrl();
  if (!baseUrl) {
    if (typeof console !== "undefined") {
      console.warn("pinned [browser]: no base URL (Vercel/Netlify/CF Pages/Render none set; no local server). Run \`pinned dev\` or set PINNED_BASE_URL. SKIPPING this BETA pin — non-blocking.");
    }
    it.skip("pinned [browser]: no base URL — skipping (run \`pinned dev\` or set PINNED_BASE_URL)", () => {});
    return;
  }

  it("every route renders in a real browser (images + console)", async () => {
    const pw = await __pinnedLoadPlaywright();
    if (!pw) {
      console.warn(
        "pinned [browser]: Playwright not installed — skipping BETA browser pin. To enable:\\n" +
        "  npm i -D playwright && npx playwright install chromium\\n" +
        "Then re-run vitest. (Non-blocking by design.)"
      );
      return; // explicit pass — adoption-first
    }

    let allSlugs: string[];
    try {
      allSlugs = await __pinnedEnumerateRoutes(baseUrl);
    } catch (e) {
      throw new Error(\`route enumeration failed: \${(e as Error).message}\`);
    }
    if (allSlugs.length === 0) {
      throw new Error(\`route enumeration returned 0 slugs from \${ROUTES_CONFIG.from}\`);
    }

    const sortedSlugs = SAMPLE_MODE === "deterministic" ? __pinnedHashSort(allSlugs) : allSlugs;
    const slugs = sortedSlugs.slice(0, MAX_ROUTES);
    if (allSlugs.length > MAX_ROUTES) {
      console.log(\`pinned render-collection-browser: covered \${slugs.length}/\${allSlugs.length} routes (deterministic sample)\`);
    }

    const browser = await pw.chromium.launch({ headless: true });
    const failures: Array<{ slug: string; reasons: string[] }> = [];
    try {
      for (const slug of slugs) {
        const url = baseUrl + PATH_TEMPLATE.replace(\`[\${PARAM_NAME}]\`, encodeURIComponent(slug));
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        const consoleErrors: string[] = [];
        const pageErrors: string[] = [];
        const cspViolations: string[] = [];

        if (CHECK_CONSOLE) {
          page.on("console", (msg: any) => {
            if (msg.type() === "error") consoleErrors.push(String(msg.text()).slice(0, 500));
          });
          page.on("pageerror", (err: any) => {
            pageErrors.push(String(err?.message ?? err).slice(0, 500));
          });
          // CSP violations surface either as console errors OR as a
          // SecurityPolicyViolation event in the page; capture both.
          await page.addInitScript(() => {
            (globalThis as any).__pinnedCspViolations = [];
            (document as any).addEventListener("securitypolicyviolation", (e: any) => {
              (globalThis as any).__pinnedCspViolations.push({
                directive: e.violatedDirective,
                blocked: e.blockedURI,
                source: e.sourceFile,
              });
            });
          });
        }

        const slugFailures: string[] = [];
        try {
          const resp = await page.goto(url, {
            waitUntil: WAIT_FOR_NETWORK_IDLE ? "networkidle" : "load",
            timeout: PAGE_TIMEOUT_MS,
          });
          if (!resp) {
            slugFailures.push("navigation returned null response");
          } else if (resp.status() >= 400) {
            slugFailures.push(\`HTTP \${resp.status()} on initial navigation\`);
          }

          if (CHECK_IMAGES) {
            const brokenImages: Array<{ src: string; naturalWidth: number; complete: boolean }> = await page.evaluate(() => {
              const imgs = Array.from(document.querySelectorAll("img"));
              return imgs
                .filter((img) => img.complete && img.naturalWidth === 0)
                .map((img) => ({
                  src: (img.src || (img.getAttribute("src") ?? "")).slice(0, 200),
                  naturalWidth: img.naturalWidth,
                  complete: img.complete,
                }));
            });
            if (brokenImages.length > 0) {
              const list = brokenImages
                .map((b) => \`<img src="\${b.src}"> naturalWidth=0\`)
                .join("; ");
              slugFailures.push(\`broken images (\${brokenImages.length}): \${list}\`);
            }
          }

          if (CHECK_CONSOLE) {
            const csp = await page.evaluate(() => (globalThis as any).__pinnedCspViolations ?? []);
            for (const v of csp as any[]) {
              cspViolations.push(\`CSP violation: \${v.directive} blocked \${v.blocked}\`);
            }
            if (consoleErrors.length > 0) {
              slugFailures.push(\`console errors (\${consoleErrors.length}): \${consoleErrors.join(" | ")}\`);
            }
            if (pageErrors.length > 0) {
              slugFailures.push(\`uncaught page errors (\${pageErrors.length}): \${pageErrors.join(" | ")}\`);
            }
            if (cspViolations.length > 0) {
              slugFailures.push(cspViolations.join(" | "));
            }
          }
        } catch (e) {
          slugFailures.push(\`browser threw: \${(e as Error).message}\`);
        } finally {
          try { await ctx.close(); } catch {}
        }
        if (slugFailures.length > 0) failures.push({ slug, reasons: slugFailures });
      }
    } finally {
      try { await browser.close(); } catch {}
    }

    if (failures.length > 0) {
      const summary = failures
        .map((f) => \`  - /\${f.slug}:\\n      \${f.reasons.join("\\n      ")}\`)
        .join("\\n");
      throw new Error(
        \`Render-collection [BETA browser]: \${failures.length} of \${slugs.length} routes failed under \${PATH_TEMPLATE}\\n\${summary}\`
      );
    }
    expect(failures.length).toBe(0);
  }, 600_000);
});
`;

  return { filename, content: header + body, claimId };
}
