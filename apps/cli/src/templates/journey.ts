// Template: journey
//
// Multi-step user-journey walker. Walks N HTTP steps with a shared
// cookie jar so session-bearing journeys (signup → /me; login →
// /dashboard; checkout → /orders/:id) can be pinned end-to-end.
//
// Why this template exists: single-route pins (auth-required,
// page-renders, returns-status, happy-path-with-side-effect) can only
// catch regressions inside one request/response. A bug like "signup
// returns 200 but /me returns the WRONG email after" is structurally
// unreachable by single-step pins. Journey catches it directly:
// step 1 = POST /signup; step 2 = GET /me, expect bodyIncludes the
// new email. The cookie jar carries the session between them.
//
// Per-step assertions (each optional, all combine):
//   status: exact code or {min, max} range
//   bodyIncludes: substrings that MUST appear in the body
//   bodyForbids: substrings that MUST NOT appear (e.g. "expired",
//     "error", "Application error: a client-side exception")
//   setsCookie: cookie name that MUST be in Set-Cookie
//   redirectIncludes: substring that MUST appear in the Location header
//
// Tier-2 misleading-green: each step also checks for the same body
// markers as happy-path-with-side-effect ({error}, {skipped:true},
// {degraded:true}). Applied per-step automatically — closes the
// degraded-200 gap for every step of every journey without per-step
// opt-in.

import type { JourneyClaim } from "../claimParser.js";
import { claimSlug } from "../claimParser.js";
import type { GenerateOpts, GeneratedTest } from "./rateLimit.js";
import { PINNED_FETCH_HELPER_SRC } from "./sharedFetch.js";

export function generateJourneyTest(
  claim: JourneyClaim,
  opts: GenerateOpts
): GeneratedTest {
  const slug = claimSlug(claim);
  const claimId = `${opts.prId}-${slug}`;
  const filename = `${claimId}.test.ts`;
  const pathSummary = claim.steps.map((s) => `${s.method} ${s.route}`).join(" → ");

  const content = `// ═══════════════════════════════════════════════════════════════
// ◆ Pinned by pinnedai — https://pinnedai.dev
// ═══════════════════════════════════════════════════════════════
// Original PR claim: ${JSON.stringify(claim.raw)}
// Source PR:         ${opts.prId}
// Template:          journey
// Journey label:     ${JSON.stringify(claim.label)}
// Path:              ${pathSummary}
// Permanent:         this test fails if the journey is ever regressed.
//
// Mechanism: walks ${claim.steps.length} HTTP step(s) with a shared
// cookie jar. Per step: asserts status, body inclusions/forbids, and
// any expected Set-Cookie / redirect. Tier-2 body-marker check
// (no error/skipped:true/degraded:true) is applied to every step.
//
// Retire when no longer applicable:
//   pinned retire ${claimId} --reason="..."
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll } from "vitest";
${PINNED_FETCH_HELPER_SRC}

const PREVIEW_URL = process.env.PREVIEW_URL;
const ORIGINAL_PR = ${JSON.stringify(opts.prId)};
const ORIGINAL_CLAIM = ${JSON.stringify(claim.raw)};
const TEST_FILENAME = ${JSON.stringify(filename)};
const JOURNEY_LABEL = ${JSON.stringify(claim.label)};
const STEPS = ${JSON.stringify(claim.steps, null, 2)};

// Minimal cookie jar — stores name=value pairs (drops attributes like
// HttpOnly / Secure / Path; not needed for the simple journeys this
// template targets). When a step Set-Cookies a value, subsequent
// steps send it back via the Cookie header.
function parseSetCookie(headerVal: string | null): Array<{ name: string; value: string }> {
  if (!headerVal) return [];
  // fetch in node spec-folds multiple Set-Cookie headers into a comma-
  // separated string. Naive split-on-comma breaks date attributes
  // (Expires=...,GMT) — so split on \`, [A-Za-z_]+=\` boundaries.
  const parts = headerVal.split(/,\\s*(?=[A-Za-z_][\\w-]*=)/);
  const out: Array<{ name: string; value: string }> = [];
  for (const p of parts) {
    const semi = p.indexOf(";");
    const kv = (semi >= 0 ? p.slice(0, semi) : p).trim();
    const eq = kv.indexOf("=");
    if (eq <= 0) continue;
    out.push({ name: kv.slice(0, eq), value: kv.slice(eq + 1) });
  }
  return out;
}

function buildCookieHeader(jar: Map<string, string>): string | undefined {
  if (jar.size === 0) return undefined;
  return Array.from(jar.entries())
    .map(([k, v]) => k + "=" + v)
    .join("; ");
}

function repairPrompt(stepIdx: number, step: typeof STEPS[number], reason: string, actual: string): string {
  return [
    "",
    "═══ PINNED FAILURE — paste this into Claude Code / Cursor ═══",
    "",
    "Fix the failing pinned claim in this test file:",
    "  Claim: " + ORIGINAL_CLAIM,
    "  Original PR: " + ORIGINAL_PR,
    "  Journey: " + JOURNEY_LABEL,
    "  Failed at step " + (stepIdx + 1) + " of " + STEPS.length + ": " + step.method + " " + step.route,
    "  Reason: " + reason,
    "  Actual: " + actual,
    "",
    "Multi-step journeys regress when one step breaks the implicit",
    "contract the next step depends on. Common causes:",
    "  - Session cookie name changed (later steps lose auth)",
    "  - Earlier step returns 2xx but actually no-op'd (next step has no",
    "    data to read)",
    "  - Redirect target changed",
    "  - Validation tightened so the synthesized body is rejected",
    "",
    "After fixing, re-run:  npx vitest run tests/pinned/" + TEST_FILENAME,
    "═══════════════════════════════════════════════════════════════",
    "",
  ].join("\\n");
}

describe("pinned: journey " + JOURNEY_LABEL, () => {
  const previewMissing = !PREVIEW_URL;
  const forceRequire = process.env.PINNED_REQUIRE_PREVIEW_URL === "1";

  beforeAll(() => {
    if (previewMissing && forceRequire) {
      throw new Error(
        "PREVIEW_URL env var required for pinned journey tests. " +
          "See https://pinnedai.dev/docs/preview-url"
      );
    }
    if (PREVIEW_URL) pinnedAssertNonProductionUrl(PREVIEW_URL, "journey");
  });

  it.skipIf(previewMissing && !forceRequire)(JOURNEY_LABEL, async () => {
    const base = PREVIEW_URL!.replace(/\\/$/, "");
    const jar = new Map<string, string>();

    for (let i = 0; i < STEPS.length; i++) {
      const step = STEPS[i];
      const url = base + step.route;
      const headers: Record<string, string> = {
        ...(step.headers ?? {}),
      };
      const cookieHeader = buildCookieHeader(jar);
      if (cookieHeader) headers["Cookie"] = cookieHeader;
      const init: RequestInit = {
        method: step.method,
        headers,
        redirect: step.followRedirects ? "follow" : "manual",
      };
      if (step.body !== undefined && step.method !== "GET" && step.method !== "DELETE") {
        headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
        (init as { body: string }).body = JSON.stringify(step.body);
      }

      const res = await pinnedFetch(url, init);

      // Collect Set-Cookie into the jar.
      const setCookie = res.headers.get("set-cookie");
      for (const c of parseSetCookie(setCookie)) {
        jar.set(c.name, c.value);
      }

      // Status assertion.
      const expect_ = step.expect ?? {};
      if (typeof expect_.status === "number") {
        if (res.status !== expect_.status) {
          throw new Error(
            repairPrompt(i, step, "status mismatch (expected " + expect_.status + ")", "got " + res.status)
          );
        }
      } else if (expect_.status && typeof expect_.status === "object") {
        const { min, max } = expect_.status;
        if (res.status < min || res.status > max) {
          throw new Error(
            repairPrompt(i, step, "status outside [" + min + "," + max + "]", "got " + res.status)
          );
        }
      }

      // redirectIncludes assertion (when configured).
      if (expect_.redirectIncludes) {
        const loc = res.headers.get("location") || "";
        if (!loc.includes(expect_.redirectIncludes)) {
          throw new Error(
            repairPrompt(i, step, "redirect missing expected substring \\"" + expect_.redirectIncludes + "\\"", "Location: " + loc)
          );
        }
      }

      // setsCookie assertion.
      if (expect_.setsCookie) {
        if (!jar.has(expect_.setsCookie)) {
          throw new Error(
            repairPrompt(i, step, "expected Set-Cookie for \\"" + expect_.setsCookie + "\\"", "set-cookie header: " + (setCookie ?? "(none)"))
          );
        }
      }

      // Body inclusions / forbids.
      const needBody =
        (expect_.bodyIncludes && expect_.bodyIncludes.length > 0) ||
        (expect_.bodyForbids && expect_.bodyForbids.length > 0) ||
        // Always read body for tier-2 marker check on 2xx responses.
        (res.status >= 200 && res.status < 300);
      let bodyText = "";
      if (needBody) {
        try {
          bodyText = await res.text();
        } catch {
          /* binary or unreadable body — skip body assertions */
        }
      }

      if (expect_.bodyIncludes) {
        for (const sub of expect_.bodyIncludes) {
          if (!bodyText.includes(sub)) {
            throw new Error(
              repairPrompt(i, step, "body missing required substring \\"" + sub + "\\"", "body (first 200 chars): " + bodyText.slice(0, 200))
            );
          }
        }
      }
      if (expect_.bodyForbids) {
        for (const sub of expect_.bodyForbids) {
          if (bodyText.includes(sub)) {
            throw new Error(
              repairPrompt(i, step, "body contains forbidden substring \\"" + sub + "\\"", "body (first 200 chars): " + bodyText.slice(0, 200))
            );
          }
        }
      }

      // Tier-2 misleading-green check (same shape as happy-path-with-
      // side-effect). 2xx with { error: "..." } / { skipped: true } /
      // { degraded: true } means this step succeeded on paper but no-op'd
      // — the next step has no real state to act on.
      if (res.status >= 200 && res.status < 300 && bodyText.length > 0) {
        try {
          const json = JSON.parse(bodyText) as Record<string, unknown>;
          if (json && typeof json === "object") {
            if (json["error"] !== undefined) {
              throw new Error(
                repairPrompt(i, step, "2xx but body contains 'error' field — step is degraded", JSON.stringify(json["error"]).slice(0, 200))
              );
            }
            if (json["skipped"] === true) {
              throw new Error(
                repairPrompt(i, step, "2xx but body says skipped:true — step is in a fallback state", bodyText.slice(0, 200))
              );
            }
            if (json["degraded"] === true) {
              throw new Error(
                repairPrompt(i, step, "2xx but body says degraded:true — step is in a fallback state", bodyText.slice(0, 200))
              );
            }
          }
        } catch (e) {
          // Re-throw repair-prompt failures. Swallow JSON parse errors
          // — non-JSON 2xx responses (HTML pages, plain text) are fine.
          if (e instanceof Error && e.message.includes("PINNED FAILURE")) throw e;
        }
      }
    }

    expect(STEPS.length).toBeGreaterThan(0);
  });
});
`;

  return { filename, content, claimId };
}
