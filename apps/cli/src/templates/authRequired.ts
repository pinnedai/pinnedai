// Template: auth-required
//
// Two-direction integration test:
//   Direction 1 — no-auth → 401/403   (always runs given PREVIEW_URL)
//                 catches the removal class: auth check stripped
//   Direction 2 — authed → 2xx        (runs if PREVIEW_TEST_TOKEN_AUTH env present)
//                 catches the over-tightening class: route accidentally
//                 blocked for legitimate authenticated users
//
// Per-direction skipIf gates each independently. Customers without
// a test token get direction-1 only — still catches the most common
// regression (auth removed entirely). Customers who configure the
// token get both directions for free.

import type { AuthRequiredClaim } from "../claimParser.js";
import { claimSlug, badCaseForClaim } from "../claimParser.js";
import type { GenerateOpts, GeneratedTest } from "./rateLimit.js";
import { PINNED_FETCH_HELPER_SRC } from "./sharedFetch.js";

export function generateAuthRequiredTest(
  claim: AuthRequiredClaim,
  opts: GenerateOpts
): GeneratedTest {
  const slug = claimSlug(claim);
  const claimId = `${opts.prId}-${slug}`;
  const filename = `${claimId}.test.ts`;

  const content = `// ═══════════════════════════════════════════════════════════════
// ◆ Pinned by pinnedai — https://pinnedai.dev
// ═══════════════════════════════════════════════════════════════
// Original PR claim: ${JSON.stringify(claim.raw)}
// Source PR:         ${opts.prId}
// Template:          auth-required
// Permanent:         this test fails if the claim is ever regressed.
//
// Retire when no longer applicable:
//   pinned retire ${claimId} --reason="..."
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
${PINNED_FETCH_HELPER_SRC}
const PREVIEW_URL = process.env.PREVIEW_URL;
const ROUTE = ${JSON.stringify(claim.route)};
const ORIGINAL_PR = ${JSON.stringify(opts.prId)};
const ORIGINAL_CLAIM = ${JSON.stringify(claim.raw)};
const BAD_CASE = ${JSON.stringify(badCaseForClaim(claim))};
const TEST_FILENAME = ${JSON.stringify(filename)};
// Static-mode fingerprint. Present when this pin was generated from
// a diff-aware detector that observed the auth check being added —
// the captured signature lets us verify the check is still present
// in source even without a live server. Production (PREVIEW_URL set)
// always uses the live fetch path; the static check runs in addition,
// catching the "AI deleted the auth code from source" failure mode
// that a live test can also catch but for which a static signal is
// faster + cheaper.
const STATIC_VERIFY = ${JSON.stringify(claim.staticVerify ?? null)};
// Optional fixture token for the "authed → 2xx" direction. When
// present, the with-auth direction runs and catches over-tightening
// regressions (route accidentally blocked even for authenticated users).
// When absent, that direction skips silently.
const TOKEN_AUTH = process.env.PREVIEW_TEST_TOKEN_AUTH;

// Auth-response validator — accepts 401/403, 3xx redirects to login,
// OR 200 with a login form. Returns a structured verdict so the
// repair prompt can explain WHY a response didn't qualify.
async function authResponseIsValid(res: Response): Promise<{ ok: boolean; reason: string }> {
  // Classic API auth — 401/403.
  if (res.status === 401 || res.status === 403) {
    return { ok: true, reason: res.status + " auth-error status" };
  }
  // Redirect to a login page — accept if Location points at a login URL.
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("location") || "";
    if (/\\b(login|signin|sign-in|auth|account)\\b/i.test(loc)) {
      return { ok: true, reason: res.status + " redirect to login (" + loc.slice(0, 80) + ")" };
    }
    return { ok: false, reason: res.status + " redirect to " + loc + " — Location doesn't look like a login page" };
  }
  // 2xx — only valid if the body actually looks like a login form.
  if (res.status >= 200 && res.status < 300) {
    let body = "";
    try { body = await res.text(); } catch {}
    const hasPasswordInput = /<input[^>]*type=["']?password["']?/i.test(body);
    const hasLoginWord = /\\b(sign\\s*in|log\\s*in|login|please\\s+sign|please\\s+log|unauthori[zs]ed|not\\s+signed)\\b/i.test(body);
    const hasLoginFormAction = /action=["'][^"']*\\/(login|signin|auth)\\b/i.test(body);
    if (hasPasswordInput && (hasLoginWord || hasLoginFormAction)) {
      return { ok: true, reason: "200 with login form (password input + sign-in copy)" };
    }
    if (hasLoginFormAction && hasLoginWord) {
      return { ok: true, reason: "200 with login form (form action + sign-in copy)" };
    }
    return { ok: false, reason: "200 OK but body has no login-form markers — looks like the route served protected content unauthenticated" };
  }
  return { ok: false, reason: res.status + " unexpected" };
}

function repairPrompt(actualStatus: number, reason: string): string {
  return [
    "",
    "═══ PINNED FAILURE — paste this into Claude Code / Cursor ═══",
    "",
    "Fix the failing pinned claim in this test file:",
    "  Claim: " + ORIGINAL_CLAIM,
    "  Original PR: " + ORIGINAL_PR,
    "  Route: " + ROUTE,
    "  Bad case: " + BAD_CASE,
    "  Expected: unauthenticated GET to " + ROUTE + " refuses to serve protected content",
    "  (Accepts: 401/403, 3xx redirect to login, or 200 with login form.)",
    "  Actual: " + actualStatus + " — " + reason,
    "",
    "Restore the auth check on " + ROUTE + ". Likely candidates:",
    "  - middleware.ts or src/middleware.ts (Next.js / Hono / generic)",
    "  - The route handler file for " + ROUTE,
    "  - Auth provider config (Clerk / Auth.js / Supabase / Lucia)",
    "Preserve authenticated behavior. Do not modify this pinned test file.",
    "",
    "After fixing, re-run:  npx vitest run tests/pinned/" + TEST_FILENAME,
    "═══════════════════════════════════════════════════════════════",
    "",
  ].join("\\n");
}

describe("pinned: auth-required on " + ROUTE, () => {
  // Skip — not fail — when PREVIEW_URL is unset. Lets background
  // post-commit auto-runs pass on machines that don't have it
  // configured. Manual runs still see a helpful message via the skip
  // reason. To force failure on missing env, set PINNED_REQUIRE_PREVIEW_URL=1.
  const previewMissing = !PREVIEW_URL;
  const forceRequire = process.env.PINNED_REQUIRE_PREVIEW_URL === "1";

  beforeAll(() => {
    if (previewMissing && forceRequire) {
      throw new Error(
        "PREVIEW_URL env var required for pinned auth-required tests. " +
          "See https://pinnedai.dev/docs/preview-url"
      );
    }
  });

  // Static-mode check — runs whenever the pin carries a fingerprint
  // (diff-aware pins always do; PR-claim-derived pins don't). Reads
  // the source file the auth check was added to and asserts the
  // captured signature is still present. Catches:
  //   - AI deleted the auth check from the route file
  //   - Refactor moved the route to a new file without the auth code
  // Does NOT catch: auth check replaced with a weaker one that
  // happens to contain the same signature substring (rare; live
  // mode catches that).
  it.skipIf(!STATIC_VERIFY)(
    "source still contains the auth check captured at pin time",
    () => {
      const sv = STATIC_VERIFY!;
      const abs = resolvePath(process.cwd(), sv.filePath);
      if (!existsSync(abs)) {
        throw new Error(
          [
            "",
            "═══ PINNED FAILURE — paste this into Claude Code / Cursor ═══",
            "",
            "Pinned auth-required pin failed (static check):",
            "  Claim: " + ORIGINAL_CLAIM,
            "  Original PR: " + ORIGINAL_PR,
            "  Route: " + ROUTE,
            "  Expected file: " + sv.filePath + " (missing)",
            "",
            "The route handler file that originally contained the auth check",
            "no longer exists. Either the file was renamed/moved, or the",
            "auth code was removed along with the file.",
            "",
            "If this is an intentional refactor, retire the pin:",
            "  pinned retire " + ORIGINAL_PR + " --reason=\\"refactor: route moved\\"",
            "═══════════════════════════════════════════════════════════════",
            "",
          ].join("\\n")
        );
      }
      const raw = readFileSync(abs, "utf8");
      // Strip comments before searching so a parent file's
      // "// TODO: add requireAuth()" doesn't falsely satisfy the
      // signature check and mask a real catch. Same comment-stripping
      // the diff-aware detector uses when it captures the signature
      // — keeps the two ends symmetric.
      const content = raw
        .split("\\n")
        .map((l: string) => l.replace(/\\/\\/.*$/, ""))
        .join("\\n")
        .replace(/\\/\\*[\\s\\S]*?\\*\\//g, "");
      // Format-normalize both content and signature before comparing.
      // Lint reformatters (Prettier, ESLint --fix) often collapse
      // multi-line expressions or rearrange trailing commas. Without
      // normalization, a captured single-line signature wouldn't match
      // the same logical code split across lines in the parent — producing
      // FALSE POSITIVE catches on pure lint commits.
      // See [[lint-format-false-positives]] memory.
      const normalizeForSig = (s: string) => s.replace(/\\s+/g, "").replace(/,(?=[)\\]}])/g, "");
      const contentN = normalizeForSig(content);
      const sigN = normalizeForSig(sv.signature);
      if (!contentN.includes(sigN)) {
        throw new Error(
          [
            "",
            "═══ PINNED FAILURE — paste this into Claude Code / Cursor ═══",
            "",
            "Pinned auth-required pin failed (static check):",
            "  Claim: " + ORIGINAL_CLAIM,
            "  Original PR: " + ORIGINAL_PR,
            "  Route: " + ROUTE,
            "  File: " + sv.filePath,
            "  Missing auth signature: " + sv.signature,
            "",
            "The auth check that protects " + ROUTE + " has been removed or",
            "changed. The original fix introduced the snippet above; it's",
            "no longer present in the file.",
            "",
            "Restore the auth check, OR — if the route legitimately no longer",
            "requires auth — retire the pin:",
            "  pinned retire " + ORIGINAL_PR + " --reason=\\"...\\"",
            "═══════════════════════════════════════════════════════════════",
            "",
          ].join("\\n")
        );
      }
      expect(contentN.includes(sigN)).toBe(true);
    }
  );

  // Direction 1 — REMOVAL CHECK (always runs given PREVIEW_URL)
  // Catches: auth check stripped from the route entirely.
  //
  // Accepts THREE shapes of "auth required" — strict 401/403 is the
  // classic API answer, but modern apps often:
  //   (a) redirect to /login (3xx with Location pointing at a login URL)
  //   (b) render a login form inline (200 with <input type=password>
  //       and sign-in copy — common in Next.js / Vite SPAs)
  // Demanding bare 401/403 would force these apps to degrade UX in
  // order to pass the pin. We accept any shape that demonstrates "this
  // endpoint refused to serve protected content without auth."
  it.skipIf(previewMissing && !forceRequire)("refuses to serve protected content without auth", async () => {
    const url = PREVIEW_URL!.replace(/\\/$/, "") + ROUTE;
    const res = await pinnedFetch(url, { method: "GET", redirect: "manual" });
    const verdict = await authResponseIsValid(res);
    if (!verdict.ok) {
      throw new Error(repairPrompt(res.status, verdict.reason));
    }
    expect(verdict.ok).toBe(true);
  });

  // Direction 2 — OVER-TIGHTENING CHECK (gated on PREVIEW_TEST_TOKEN_AUTH)
  // Catches: route accidentally blocked for authenticated users
  // ("we tightened auth and broke legit traffic"). Lower-stakes
  // than direction 1 but real — refactors that turn 200s into 403s
  // for the wrong reasons are a known AI mistake class.
  const authTokenMissing = !TOKEN_AUTH;
  it.skipIf((previewMissing || authTokenMissing) && !forceRequire)(
    "accepts authenticated requests with 2xx",
    async () => {
      const url = PREVIEW_URL!.replace(/\\/$/, "") + ROUTE;
      const res = await pinnedFetch(url, {
        method: "GET",
        headers: { Authorization: "Bearer " + TOKEN_AUTH! },
      });
      if (res.status < 200 || res.status >= 300) {
        const msg = [
          "",
          "═══ PINNED FAILURE — paste this into Claude Code / Cursor ═══",
          "",
          "Fix the failing pinned claim in this test file:",
          "  Claim: " + ORIGINAL_CLAIM,
          "  Original PR: " + ORIGINAL_PR,
          "  Route: " + ROUTE,
          "  Direction: with-auth (over-tightening check)",
          "  Expected: 2xx for an authenticated GET to " + ROUTE,
          "  Actual: returned " + res.status + " (route may be over-restricted — legit authenticated users are blocked)",
          "",
          "Investigate why authenticated requests are failing on " + ROUTE + ".",
          "Likely candidates:",
          "  - Auth middleware now requires extra claims the token doesn't carry",
          "  - Route handler added new authorization checks that exclude the test user",
          "  - Session validation tightened too aggressively",
          "Preserve the no-auth → 401/403 contract (direction 1). Do not modify this pinned test file.",
          "",
          "After fixing, re-run:  npx vitest run tests/pinned/" + TEST_FILENAME,
          "═══════════════════════════════════════════════════════════════",
          "",
        ].join("\\n");
        throw new Error(msg);
      }
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
    }
  );
});
`;

  return { filename, content, claimId };
}
