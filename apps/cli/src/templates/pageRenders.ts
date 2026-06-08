// Template: page-renders
//
// Asserts a server-rendered HTML page returns 200 + body contains no
// known render-error markers + body length above a minimum threshold.
// The simplest "this page didn't explode" smoke check — closes the
// gap Claude session feedback flagged: "GET / renders without crashing."
//
// Auth-gated pages re-use authResponseIsValid (same shape as the
// auth-required template) to accept login-redirect / login-form / 401
// as legitimate "this page is gated but not broken" responses. The
// auth-required pin for the same route handles the auth contract; this
// pin only catches "page actively crashed when rendered."

import type { PageRendersClaim } from "../claimParser.js";
import { claimSlug } from "../claimParser.js";
import type { GenerateOpts, GeneratedTest } from "./rateLimit.js";
import { PINNED_FETCH_HELPER_SRC } from "./sharedFetch.js";

export function generatePageRendersTest(
  claim: PageRendersClaim,
  opts: GenerateOpts
): GeneratedTest {
  const slug = claimSlug(claim);
  const claimId = `${opts.prId}-${slug}`;
  const filename = `${claimId}.test.ts`;
  const minBodyBytes = claim.minBodyBytes ?? 500;

  const content = `// ═══════════════════════════════════════════════════════════════
// ◆ Pinned by pinnedai — https://pinnedai.dev
// ═══════════════════════════════════════════════════════════════
// Original PR claim: ${JSON.stringify(claim.raw)}
// Source PR:         ${opts.prId}
// Template:          page-renders
// Permanent:         this test fails if the claim is ever regressed.
//
// Mechanism: GET ${claim.route} with Accept: text/html, assert 200/304
// + HTML body > ${minBodyBytes} bytes + no React/Next/Vite error markers.
// Auth-gated pages (3xx-to-login, 200-with-login-form, 401/403) skip
// the body check — the auth-required pin for this route covers auth.
//
// Retire when no longer applicable:
//   pinned retire ${claimId} --reason="..."
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll } from "vitest";
${PINNED_FETCH_HELPER_SRC}
const PREVIEW_URL = process.env.PREVIEW_URL;
const ROUTE = ${JSON.stringify(claim.route)};
const MIN_BODY_BYTES = ${minBodyBytes};
const ORIGINAL_PR = ${JSON.stringify(opts.prId)};
const ORIGINAL_CLAIM = ${JSON.stringify(claim.raw)};
const TEST_FILENAME = ${JSON.stringify(filename)};

// Render-error markers — exact-substring matches found in actually-
// crashed pages from Next.js / Vite / React / Vue. Order by likelihood
// of appearance so the most common failure surfaces first in the
// repair prompt.
const ERROR_MARKERS = [
  "Application error: a client-side exception",  // Next.js client error overlay
  "Internal Server Error",                         // Next.js default 500
  "__NEXT_ERROR_CODE",                             // Next.js error boundary marker
  "[vite] Internal server error",                  // Vite SSR error
  "Error: ENOENT",                                 // missing file
  "Uncaught (in promise)",                         // unhandled rejection
  "Cannot read properties of undefined",            // common React render crash
  "Cannot read property",                          // older React render crash
  "ReferenceError:",                                // bundler swallowing failed
  "TypeError:",                                     // ditto
  "[Vue warn]",                                     // Vue render error
];

// Soft-404 markers — Next.js renders a 404 page with HTTP status 200
// in several configurations (custom not-found.tsx, error.tsx fallback,
// CDN cache hit on a now-missing page). Without these, a missing/renamed
// page would silently pass the page-renders pin since 200 + non-empty
// HTML body is technically present. Same wrong-direction failure mode
// the validation-rejects-bad pin's 404/405 check closes.
const SOFT_404_MARKERS = [
  "404 - This page could not be found",     // Next.js default 404
  "Page Not Found</h1>",                      // very common custom 404 H1
  "Page not found</h1>",                      // case variant
  "<title>404</title>",                       // bare 404 title tag
  "<title>404:",                              // prefixed 404 title
  "This page could not be found",            // Next.js default body
  "NEXT_NOT_FOUND",                          // Next.js notFound() exception name
];

// 0.5.0-beta.2 (Cipherwake P0): the page-renders pin is structurally
// asking "does this page render without crashing?" — and a 3xx
// REDIRECT is not "the page rendered." The original detector tried
// to recognize only login-shaped redirects (matching login / signin /
// auth / account in the Location header), which missed:
//   - root-redirect for unauthenticated users (admin route to /)
//   - tenant-redirect (foo route to /tenant-picker)
//   - rate-limit shed (any route to /try-again-later)
//   - any custom redirect path that doesn't carry the magic words
//
// In every one of those, the page-renders pin would fail with "non-
// success status" and the hook-failure mechanism would surface it
// as a regression in chat on every prompt. That's the phantom-
// regression class Cipherwake reported.
//
// Fix: page-renders pins SKIP on ANY 3xx. The pin's contract is
// "the resolved page rendered correctly"; if the framework chose to
// redirect, that's outside the page-renders pin's scope (an
// auth-required pin / redirect-shape pin can assert on it instead).
async function looksAuthGated(res: Response): Promise<boolean> {
  if (res.status === 401 || res.status === 403) return true;
  // ANY 3xx redirect = out of scope for page-renders. This includes
  // 301/302/303/307/308 to login, root, tenant-picker, retry-later,
  // and anything else the framework / middleware decided to do.
  if (res.status >= 300 && res.status < 400) return true;
  if (res.status >= 200 && res.status < 300) {
    const body = await res.clone().text().catch(() => "");
    const hasPasswordInput = /<input[^>]*type=["']?password["']?/i.test(body);
    const hasLoginCopy = /\\b(sign\\s*in|log\\s*in|please\\s+sign|please\\s+log)\\b/i.test(body);
    if (hasPasswordInput && hasLoginCopy) return true;
  }
  return false;
}

function repairPrompt(actualStatus: number, reason: string): string {
  return [
    "",
    "═══ PINNED FAILURE — paste this into Claude Code / Cursor ═══",
    "",
    "Fix the failing pinned claim in this test file:",
    "  Claim: " + ORIGINAL_CLAIM,
    "  Original PR: " + ORIGINAL_PR,
    "  Route: GET " + ROUTE,
    "  Expected: HTML page rendered successfully (200/304 + body > " + MIN_BODY_BYTES + "b + no error markers)",
    "  Actual: " + actualStatus + " — " + reason,
    "",
    "Likely causes:",
    "  - A page component throws on mount or during SSR (missing import,",
    "    failed data fetch, undefined-prop access)",
    "  - Bundler dropped a dependency or shipped a syntax error",
    "  - Route handler was deleted / renamed",
    "  - 500 response page was cached as 200 by CDN",
    "",
    "Open the page in a browser to see the actual error. Common fixes:",
    "  - Restore the missing/broken page component",
    "  - Wrap async data fetches in error boundaries",
    "  - Check the deploy log for build errors hidden by silent fallbacks",
    "",
    "After fixing, re-run:  npx vitest run tests/pinned/" + TEST_FILENAME,
    "═══════════════════════════════════════════════════════════════",
    "",
  ].join("\\n");
}

describe("pinned: page-renders GET " + ROUTE, () => {
  const previewMissing = !PREVIEW_URL;
  const forceRequire = process.env.PINNED_REQUIRE_PREVIEW_URL === "1";
  // 0.5.0-beta.9 (Cipherwake dogfood bug #1): if a page-renders pin
  // was created with a dynamic-route shape (\`/preview/[slug]\`), the
  // fetch would request the literal bracketed path → 404 every time
  // → phantom regression on every prompt. Detect and SKIP — the
  // user wants \`pinned render add --from collection-getter ...\`
  // for dynamic routes, not page-renders.
  const isDynamicRoute = /\\[[^\\]]+\\]/.test(ROUTE);

  beforeAll(() => {
    if (previewMissing && forceRequire) {
      throw new Error(
        "PREVIEW_URL env var required for pinned page-renders tests. " +
          "See https://pinnedai.dev/docs/preview-url"
      );
    }
    if (isDynamicRoute && typeof console !== "undefined") {
      console.warn(
        "pinned [page-renders]: " + ROUTE + " is a dynamic route (contains [param]). " +
        "Skipping — page-renders can't substitute concrete params. " +
        "Use \`pinned render add --path '" + ROUTE + "' --from collection-getter --module <getter-path> --export <export-name>\` instead. " +
        "Run \`pinned retire " + ORIGINAL_PR + "-<slug>\` to remove this pin."
      );
    }
  });

  // 0.5.0-beta.2 (Cipherwake P0): wrap the test body in pinnedWrapInfra
  // so PinnedInfraFailure thrown by pinnedFetch on ECONNREFUSED /
  // DNS / timeout / 502-503-504-retries-exhausted does NOT register
  // as a catch. The infra failure prompt explicitly tells the user
  // "preview environment issue, NOT a catch — \`pinned test\`'s
  // catch ledger will NOT increment." Without this wrap, a dead
  // PREVIEW_URL (e.g. the dev server stopped) would surface as a
  // regression in chat on every prompt — the phantom-regression
  // class.
  it.skipIf((previewMissing && !forceRequire) || isDynamicRoute)("renders without crashing", pinnedWrapInfra(\`page-renders GET \${ROUTE}\`, async (ctx) => {
    void ctx;
    const url = PREVIEW_URL!.replace(/\\/$/, "") + ROUTE;
    const res = await pinnedFetch(url, {
      method: "GET",
      headers: { Accept: "text/html" },
      redirect: "manual",
    });

    // Out of scope: any 3xx redirect (auth, root, tenant-picker, etc.)
    // and login-shaped 2xx pages. See looksAuthGated above. The
    // auth-required pin handles the gating contract separately.
    if (await looksAuthGated(res)) return;

    if (res.status !== 200 && res.status !== 304) {
      throw new Error(repairPrompt(res.status, "non-success status"));
    }
    const body = await res.text();
    if (body.length < MIN_BODY_BYTES) {
      throw new Error(
        repairPrompt(
          res.status,
          "body too small (" + body.length + "b < " + MIN_BODY_BYTES + "b min) — page may be a skeleton/loading state"
        )
      );
    }
    if (!/<html/i.test(body)) {
      throw new Error(repairPrompt(res.status, "no <html> tag found — body looks like JSON or plain text, not a rendered page"));
    }
    for (const marker of ERROR_MARKERS) {
      if (body.includes(marker)) {
        throw new Error(repairPrompt(res.status, "body contains render-error marker: " + JSON.stringify(marker)));
      }
    }
    // Soft-404: 200 status but body is a not-found page. Same shape
    // as the validation-rejects-bad 404/405 disambiguation — without
    // this, a deleted page would silently keep its pin green.
    for (const marker of SOFT_404_MARKERS) {
      if (body.includes(marker)) {
        throw new Error(
          repairPrompt(
            res.status,
            "soft-404: page returned " + res.status + " but body is a not-found page (marker: " + JSON.stringify(marker) + "). " +
            "The route was likely deleted/renamed; the framework's catch-all is rendering a 404 page with a 200 status."
          )
        );
      }
    }
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(400);
  }));
});
`;

  return { filename, content, claimId };
}
