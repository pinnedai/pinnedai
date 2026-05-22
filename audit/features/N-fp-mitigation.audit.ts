// FEATURE: FP-mitigation infrastructure embedded in generated tests:
//   (1) X-Pinned-Test: 1 header on every Pinned-generated fetch
//   (2) Retry-with-backoff on transient 5xx + network errors
//   (3) Loud skip reporting in statusline (⊘ N skipped) when pins
//       couldn't actually verify due to missing preview/env
// SIGNAL (observable when feature is healthy):
//   1. Every web-template generated source contains "X-Pinned-Test"
//      header AND the pinnedFetch helper function declaration.
//   2. Every web-template generated source replaces raw fetch() with
//      pinnedFetch() at all call sites.
//   3. AGENT.md (the AI-rules file pinned init writes) explains the
//      X-Pinned-Test convention so the customer's AI knows to honor
//      it when writing rate-limit / billing / analytics code.
// FALSIFIABILITY: catches regressions where a template adds a new
//   raw fetch() call without going through pinnedFetch (silent FP
//   risk — that single request would skip retry + miss the header),
//   or where the helper accidentally gets removed during a refactor
//   (every test would silently lose retry + header behavior).

import { describe, it, expect } from "vitest";
import { generateTest } from "../../apps/cli/src/index.js";
import { AGENT_MD } from "../../apps/cli/src/agentRules.js";

describe("FEATURE-AUDIT: FP-mitigation infrastructure in generated tests", () => {
  it("POSITIVE CONTROL: auth-required template embeds X-Pinned-Test header + pinnedFetch helper", () => {
    const gen = generateTest(
      {
        template: "auth-required",
        route: "/api/admin/export",
        raw: "Auth required on /api/admin/export.",
      },
      { prId: "pr-1" }
    );
    expect(gen.content).toContain("X-Pinned-Test");
    expect(gen.content).toContain("async function pinnedFetch");
    expect(gen.content).toContain("pinnedFetch(url");
    // FP-protection contract: no raw fetch() call should appear OUTSIDE
    // the helper itself. Inside the helper body, `fetch(url, finalInit)`
    // is the legitimate inner call — count only call sites that aren't
    // part of the helper definition.
    const rawFetchOutsideHelper = countCallsOutsideHelper(
      gen.content,
      /\bfetch\(/
    );
    expect(rawFetchOutsideHelper).toBe(0);
  });

  it("POSITIVE CONTROL: rate-limit template uses pinnedFetch for burst requests", () => {
    const gen = generateTest(
      {
        template: "rate-limit",
        route: "/api/users",
        rate: 60,
        window: "minute",
        raw: "Rate-limits /api/users to 60 req/min.",
      },
      { prId: "pr-1" }
    );
    expect(gen.content).toContain("X-Pinned-Test");
    expect(gen.content).toContain("pinnedFetch(url");
    const rawFetchOutsideHelper = countCallsOutsideHelper(
      gen.content,
      /\bfetch\(/
    );
    expect(rawFetchOutsideHelper).toBe(0);
  });

  it("POSITIVE CONTROL: idempotent template uses pinnedFetch on both replay calls", () => {
    const gen = generateTest(
      {
        template: "idempotent",
        route: "/webhooks/stripe",
        idField: "event_id",
        raw: "Makes /webhooks/stripe idempotent on event_id.",
      },
      { prId: "pr-1" }
    );
    expect(gen.content).toContain("X-Pinned-Test");
    expect(gen.content).toContain("pinnedFetch(url");
    const rawFetchOutsideHelper = countCallsOutsideHelper(
      gen.content,
      /\bfetch\(/
    );
    expect(rawFetchOutsideHelper).toBe(0);
  });

  it("POSITIVE CONTROL: returns-status template uses pinnedFetch", () => {
    const gen = generateTest(
      {
        template: "returns-status",
        route: "/api/signup",
        method: "POST",
        status: 400,
        condition: "missing email",
        field: "email",
        conditionKind: "missing",
        raw: "POST /api/signup returns 400 on missing email.",
      },
      { prId: "pr-1" }
    );
    expect(gen.content).toContain("X-Pinned-Test");
    expect(gen.content).toContain("pinnedFetch(url");
    const rawFetchOutsideHelper = countCallsOutsideHelper(
      gen.content,
      /\bfetch\(/
    );
    expect(rawFetchOutsideHelper).toBe(0);
  });

  it("POSITIVE CONTROL: pinnedFetch helper retries on transient 5xx", () => {
    // We can't easily run the helper here (no test server), but we can
    // assert the source contains the retry-on-5xx logic. Catches a
    // regression where someone removes the retry branch.
    const gen = generateTest(
      {
        template: "auth-required",
        route: "/api/x",
        raw: "Auth required on /api/x.",
      },
      { prId: "pr-1" }
    );
    expect(gen.content).toContain("res.status === 502");
    expect(gen.content).toContain("res.status === 503");
    expect(gen.content).toContain("res.status === 504");
    // Should also have a retry loop with attempts.
    expect(gen.content).toContain("attempt < 2");
    // 500ms base backoff multiplied per attempt.
    expect(gen.content).toContain("500 * (attempt + 1)");
  });

  it("POSITIVE CONTROL: AGENT.md documents the X-Pinned-Test header convention for customers", () => {
    // Catches a regression where someone removes the header-convention
    // section from AGENT.md, leaving customers' AIs unaware that they
    // should exclude Pinned traffic from rate limiting / billing /
    // analytics. Without this guidance, customers will silently get
    // rate-limit FP every time a pin runs.
    expect(AGENT_MD).toContain("X-Pinned-Test");
    expect(AGENT_MD).toContain("rate-limit");
    expect(AGENT_MD).toContain("billing");
  });

  it("FALSIFIABILITY: a template emitting raw fetch() outside the helper would FAIL this audit", () => {
    // Sanity check that countCallsOutsideHelper actually detects raw
    // fetch() outside the helper boundary. We construct a fake source
    // with proper helper sentinels AND a raw fetch outside them. The
    // counter must return 1 (the outside call) — proving the audit
    // would catch a regression where a template emits raw fetch.
    const fakeSource = `
// ─── Shared by Pinned templates (do not edit; regenerated per-pin) ───
async function pinnedFetch(url, init) {
  return fetch(url, init);
}
// ─────────────────────────────────────────────────────────────────────

// Bug: raw fetch outside helper
const res = await fetch("https://example.com");
`;
    expect(countCallsOutsideHelper(fakeSource, /\bfetch\(/)).toBe(1);
  });
});

// Count regex matches in source that are NOT inside the pinnedFetch
// helper function body. The helper definition contains one
// legitimate `fetch(url, finalInit)` call — we don't want to count
// that. Everything outside is a template-emitted fetch and MUST go
// through pinnedFetch.
//
// We locate the helper boundary via the sentinel comment lines that
// PINNED_FETCH_HELPER_SRC wraps the helper in (`// ─── Shared by
// Pinned templates ...` opener and a matching line of em-dashes as
// closer). Brace-tracking the function signature would be tripped up
// by the `RequestInit = {}` default-value inside the signature.
const HELPER_OPEN_SENTINEL = "// ─── Shared by Pinned templates";
const HELPER_CLOSE_SENTINEL =
  "// ─────────────────────────────────────────────────────────────────────";
function countCallsOutsideHelper(source: string, pattern: RegExp): number {
  const openIdx = source.indexOf(HELPER_OPEN_SENTINEL);
  const closeIdx = source.indexOf(HELPER_CLOSE_SENTINEL);
  if (openIdx === -1 || closeIdx === -1 || closeIdx < openIdx) {
    // No helper sentinels — count all matches (used by the
    // falsifiability check to verify the counter detects raw fetches
    // when no helper is present).
    return Array.from(source.matchAll(new RegExp(pattern.source, "g"))).length;
  }
  const before = source.slice(0, openIdx);
  const after = source.slice(closeIdx + HELPER_CLOSE_SENTINEL.length);
  const flagged = new RegExp(pattern.source, "g");
  const beforeCount = Array.from(before.matchAll(flagged)).length;
  const afterCount = Array.from(after.matchAll(flagged)).length;
  return beforeCount + afterCount;
}
