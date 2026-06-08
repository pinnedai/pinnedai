// Shared fetch helper — embedded as source into every generated
// web-template test file. Two responsibilities:
//
// 1. **X-Pinned-Test header**: every Pinned-generated request carries
//    `X-Pinned-Test: 1`. This is a documented convention (see
//    tests/pinned/AGENT.md) so customers can exclude Pinned's test
//    traffic from rate limiting, billing-tier counters, analytics,
//    and audit logs. Without this header, a rate-limit pin would
//    consume the user's actual rate budget every time it ran.
//
// 2. **Retry-with-backoff**: transient 5xx responses or network
//    errors are silently retried up to 2 times with a 500ms / 1s
//    backoff. Cold-start serverless previews (Vercel, Fly, Cloudflare
//    Workers) frequently return 502/503 on the first request after
//    inactivity — without retry, pins false-fail every time. This
//    is the highest-impact false-positive mitigation we ship.
//
// Why embed as source rather than import: each generated test file
// is fully self-contained (lives in customer's repo, has no runtime
// dependency on the pinnedai package). Pasting the helper into the
// file body adds ~25 lines but keeps tests portable — they survive
// uninstalling pinnedai entirely. The compounding-tests moat depends
// on that property.

export const PINNED_FETCH_HELPER_SRC = `
// ─── Shared by Pinned templates (do not edit; regenerated per-pin) ───
// Wraps global fetch with:
//   - X-Pinned-Test: 1 header (so your app can exclude Pinned traffic
//     from rate limits, billing counters, analytics — see
//     https://pinnedai.dev/docs/x-pinned-test-header)
//   - Retry-with-backoff on transient 5xx and network errors (mitigates
//     cold-start preview false-positives — Vercel/Fly/Cloudflare often
//     return 502/503 on the first request after inactivity)
//   - Infra-failure classification: after retries are exhausted, throws
//     a tagged "PINNED_INFRA_FAILURE" error. The test wrapper catches
//     this and emits a "PINNED INFRA FAILURE" prompt instead of the
//     "PINNED FAILURE" catch prompt — so infra issues don't pollute
//     the catch ledger as real regressions.
class PinnedInfraFailure extends Error {
  pinnedInfraFailure = true;
  constructor(public reason: string, public details: string) {
    super("PINNED_INFRA_FAILURE: " + reason + " — " + details);
  }
}
async function pinnedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const baseHeaders = (init.headers ?? {}) as Record<string, string>;
  const headers = { ...baseHeaders, "X-Pinned-Test": "1" };
  const finalInit = { ...init, headers };
  let lastError: unknown;
  let lastTransientStatus: number | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, finalInit);
      // Retry transient gateway errors (502/503/504) but NOT 500 — a
      // genuine application bug should still surface. 5xx other than
      // 500 is almost always edge/proxy.
      if (res.status === 502 || res.status === 503 || res.status === 504) {
        lastTransientStatus = res.status;
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          continue;
        }
        // Retries exhausted on transient 5xx → infra failure, not catch.
        throw new PinnedInfraFailure(
          "gateway-error",
          "received " + res.status + " from " + url + " after " + (attempt + 1) + " retries (preview may be down)"
        );
      }
      return res;
    } catch (e) {
      // If it's already an infra-failure (from the 5xx branch above), rethrow.
      if (e && (e as { pinnedInfraFailure?: boolean }).pinnedInfraFailure) {
        throw e;
      }
      lastError = e;
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
    }
  }
  // Network error after retries — infra failure, not catch.
  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  throw new PinnedInfraFailure(
    "network-error",
    "failed to reach " + url + ": " + msg + " (preview may be unreachable — check DNS / VPN / firewall)"
  );
}

// Helper for templates: wrap an it() body so that PinnedInfraFailure
// errors mark the test as SKIPPED (vitest \`ctx.skip()\`) instead of
// throwing — Cipherwake-reported (0.5.0-beta.9): the prior version
// re-threw with a "NOT a catch" label, but vitest still reported RED
// and \`pinned test\` / hook-failure cached it as a regression. The
// label was advisory text; vitest didn't know.
//
// New behavior: ctx.skip() makes vitest report the test as SKIPPED
// (yellow ⏭️). The catch ledger sees skipped, not failed. Hook-failure
// stops spamming.
//
// Real assertion failures still throw → fall through to the usual
// "PINNED FAILURE" red path.
//
// PINNED_TREAT_INFRA_AS_CATCH=1 reverts to the old throw-and-fail
// behavior for users who genuinely want infra-fails counted.
function pinnedWrapInfra(
  reason: string,
  body: (ctx: { skip: (note?: string) => void }) => Promise<void>
): (ctx: { skip: (note?: string) => void }) => Promise<void> {
  return async (ctx) => {
    try {
      await body(ctx);
    } catch (e) {
      if (e && (e as { pinnedInfraFailure?: boolean }).pinnedInfraFailure) {
        const details = (e as { details: string }).details;
        const treatAsCatch =
          (globalThis as any).process?.env?.PINNED_TREAT_INFRA_AS_CATCH === "1";
        const msg = [
          "",
          "═══ PINNED INFRA FAILURE — preview environment issue, NOT a catch ═══",
          "",
          "  Direction: " + reason,
          "  Cause: " + details,
          "",
          "  Pinned classified this as INFRASTRUCTURE failure (preview down,",
          "  DNS, network blip), NOT a regression catch. The test is SKIPPED",
          "  and the catch ledger will NOT increment.",
          "",
          "  Fix the preview deployment, then re-run.",
          "  To treat infra as a real catch: PINNED_TREAT_INFRA_AS_CATCH=1",
          "═══════════════════════════════════════════════════════════════════",
          "",
        ].join("\\n");
        if (treatAsCatch) {
          throw new Error(msg);
        }
        if (typeof console !== "undefined") console.warn(msg);
        // Mark vitest's task as skipped — yellow, not red. ledger doesn't
        // count skipped tests as catches.
        try { ctx.skip("pinned [infra]: " + reason); } catch { /* older vitest */ }
        return;
      }
      throw e;
    }
  };
}

// Production-URL guard: detect when PREVIEW_URL looks like a real
// production domain rather than a preview/staging environment. Pins
// that fire bursts of traffic (rate-limit, idempotent retries, tier-
// cap probing) against production are dangerous:
//   - rate-limit pin's 61-request burst → DOS your own users for 30s
//   - idempotent pin's duplicate POST → real side effect (charge,
//     email send, DB write)
//   - tier-cap pin's at-cap test → consumes real customer's quota
// Block with a loud warning unless PINNED_ALLOW_PRODUCTION_URL=1 is
// set. The list of "preview-like" markers is conservative.
function pinnedAssertNonProductionUrl(url: string, riskyTemplate: string): void {
  if (process.env.PINNED_ALLOW_PRODUCTION_URL === "1") return;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const isLikelyPreview =
      host === "localhost" ||
      host === "127.0.0.1" ||
      host.startsWith("127.") ||
      host.endsWith(".local") ||
      host.includes("preview") ||
      host.includes("staging") ||
      host.includes("stage") ||
      host.includes("dev.") ||
      host.includes(".dev.") ||
      host.endsWith(".dev") && host !== "vercel.dev" /* keep loose */ ||
      host.endsWith(".test") ||
      host.includes("test.") ||
      host.endsWith(".pages.dev") /* Cloudflare Pages preview */ ||
      host.endsWith(".vercel.app") /* Vercel preview */ ||
      host.endsWith(".onrender.com") /* Render */ ||
      host.endsWith(".fly.dev") /* Fly */ ||
      host.endsWith(".railway.app") /* Railway PR env */ ||
      host.endsWith(".trycloudflare.com") /* CF tunnel */ ||
      host.includes("review-app") ||
      host.includes("pr-");
    if (!isLikelyPreview) {
      throw new Error([
        "",
        "═══ PINNED PRODUCTION-URL GUARD — refusing to run " + riskyTemplate + " against " + host + " ═══",
        "",
        "  PREVIEW_URL points at what looks like a production domain.",
        "  " + riskyTemplate + " pins fire bursts/retries/duplicate writes that",
        "  could damage real customers:",
        "    - rate-limit:  61 requests in seconds → DOS your own traffic",
        "    - idempotent:  duplicate POST → real charge/email/DB write",
        "    - tier-cap:    at-cap probing → consumes real quota",
        "",
        "  To run anyway (you've confirmed " + host + " is safe):",
        "    PINNED_ALLOW_PRODUCTION_URL=1 npx vitest run",
        "",
        "  Recommended: point PREVIEW_URL at a staging/preview deploy.",
        "  See https://pinnedai.dev/docs/preview-url",
        "═══════════════════════════════════════════════════════════════════",
        "",
      ].join("\\n"));
    }
  } catch (e) {
    // If e is the production-guard error we threw, rethrow.
    if (e instanceof Error && e.message.includes("PRODUCTION-URL GUARD")) {
      throw e;
    }
    // URL parse failure — let the test deal with it.
  }
}
// ─────────────────────────────────────────────────────────────────────

// ─── Static-mode helper (shared by auth-required, rate-limit, idempotent,
//     permission-required when carrying a staticVerify fingerprint) ──
// Reads the source file the protection was added to, strips comments,
// normalizes whitespace/trailing commas (so lint reformatters don't
// produce false-positive catches per [[lint-format-false-positives]])
// and asserts the captured signature substring is still present.
// Returns null on pass; on fail returns a structured detail object the
// caller turns into a template-specific repair prompt + throws.
import { readFileSync, existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
function pinnedStaticVerify(
  sv: { filePath: string; signature: string }
): { kind: "file-missing" } | { kind: "signature-missing" } | null {
  const abs = resolvePath(process.cwd(), sv.filePath);
  if (!existsSync(abs)) return { kind: "file-missing" };
  const raw = readFileSync(abs, "utf8");
  const content = raw
    .split("\\n")
    .map((l: string) => l.replace(/\\/\\/.*$/, ""))
    .join("\\n")
    .replace(/\\/\\*[\\s\\S]*?\\*\\//g, "");
  const normalize = (s: string) => s.replace(/\\s+/g, "").replace(/,(?=[)\\]}])/g, "");
  if (!normalize(content).includes(normalize(sv.signature))) {
    return { kind: "signature-missing" };
  }
  return null;
}
// ─────────────────────────────────────────────────────────────────────
`;
