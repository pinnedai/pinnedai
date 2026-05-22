// FEATURE: bug-fix detection + bad_case field — both attach high-
//   value metadata to each pin at generation time. bugFixOrigin tags
//   pins extracted from bug-fix PRs (more likely to catch regressions).
//   bad_case is a plain-English description of the specific scenario
//   the pin guards against — used in failure messages, CATCHES.md
//   ledger, AI chat-hook celebrations.
// SIGNAL (observable when feature is healthy):
//   1. detectBugFixPhrase("Fixed regression where ...") → "fix" (or
//      similar bug-fix-vocabulary phrase). Word-boundary regex avoids
//      false positives.
//   2. detectBugFixPhrase("Just shipped a fixture") → null. We must
//      NOT false-match on "fixture", "prefix", "racecondition".
//   3. After `pinned generate` on a bug-fix PR body, each new
//      registry entry has bugFixOrigin: true.
//   4. After `pinned generate` on a feature PR body (no bug-fix
//      vocab), each new entry has NO bugFixOrigin field (or false).
//   5. Every new registry entry has a non-empty badCase string.
//   6. Generated test files embed BAD_CASE constant and reference it
//      in the failure prompt.
//   7. PINS.md orders bug-fix pins FIRST, tags them with 🔁.
// FALSIFIABILITY: catches regressions where the bug-fix dictionary
//   gets too greedy (false-positive on "fixture"/"prefix"), where
//   addEntry forgets to call badCaseForClaim (every pin would have
//   empty badCase, breaking failure-message UX), or where PINS.md
//   ordering reverts to alphabetical (bug-fix signal lost).

import { describe, it, expect } from "vitest";
import {
  detectBugFixPhrase,
  badCaseForClaim,
} from "../../apps/cli/src/claimParser.js";
import {
  addEntry,
  renderPinsManifest,
  type Registry,
} from "../../apps/cli/src/registry.js";

describe("FEATURE-AUDIT: bug-fix phrase detection — positive, negative, no-change", () => {
  it("POSITIVE: detects 'fix' / 'fixes' / 'fixed' / 'fixing' as bug-fix vocabulary", () => {
    expect(detectBugFixPhrase("This PR fixes the auth bug")).toBe("fix");
    expect(detectBugFixPhrase("Fixed regression in webhook handler")).toBe(
      "fix"
    );
    expect(detectBugFixPhrase("Fixing rate limit edge case")).toBe("fix");
  });

  it("POSITIVE: detects 'regression' / 'no longer' / 'bypass' / 'race condition'", () => {
    expect(detectBugFixPhrase("Prevent regression where admin auth dropped")).toBe(
      "regression"
    );
    expect(
      detectBugFixPhrase("Free users no longer can exceed the 1-domain cap")
    ).toBe("no longer");
    expect(detectBugFixPhrase("Closes the auth bypass via X-Forwarded-Host")).toBe(
      "bypass"
    );
    expect(detectBugFixPhrase("Resolves race condition in webhook dedup")).toBe(
      "race condition"
    );
  });

  it("FALSIFIABILITY: does NOT false-match 'fixture' / 'prefix' / 'racecondition'", () => {
    // Catches a regression where someone weakens the word-boundary
    // regex (e.g., removes \b) and we start tagging every PR that
    // adds a test fixture or refactors a URL prefix as a bug-fix.
    expect(detectBugFixPhrase("Added new test fixture for billing")).toBeNull();
    expect(detectBugFixPhrase("Renamed prefix on routes")).toBeNull();
    // racecondition (one word, no space) should NOT match "race condition"
    expect(detectBugFixPhrase("racecondition.txt added")).toBeNull();
    // bug-related but NOT bug-fix
    expect(detectBugFixPhrase("Found a bug in the parser")).toBeNull();
  });

  it("NO-CHANGE: empty / feature PR text → null", () => {
    // Pure feature PRs without bug-fix vocab must return null so
    // their pins stay at regular priority. False-positive here would
    // promote every PR's pins to bug-fix-tier, defeating the signal.
    expect(detectBugFixPhrase("")).toBeNull();
    expect(detectBugFixPhrase("Added /api/users endpoint")).toBeNull();
    expect(
      detectBugFixPhrase("Implemented dashboard export with CSV download")
    ).toBeNull();
  });
});

describe("FEATURE-AUDIT: badCaseForClaim returns plain-English scenarios", () => {
  it("POSITIVE: auth-required generates an unauthenticated-access bad case", () => {
    const bc = badCaseForClaim({
      template: "auth-required",
      route: "/api/admin/export",
      raw: "Auth required on /api/admin/export.",
    });
    expect(bc).toContain("/api/admin/export");
    expect(bc).toMatch(/unauthenticated/i);
    expect(bc).toMatch(/401|403/);
  });

  it("POSITIVE: rate-limit generates a 'limit removed or weakened' bad case", () => {
    const bc = badCaseForClaim({
      template: "rate-limit",
      route: "/api/users",
      rate: 60,
      window: "minute",
      raw: "Rate-limits /api/users to 60 req/min.",
    });
    expect(bc).toContain("/api/users");
    expect(bc).toContain("61"); // rate + 1
    expect(bc).toMatch(/removed|weakened/);
  });

  it("POSITIVE: every claim template returns a NON-empty bad_case", () => {
    // Catches a regression where someone adds a new template but
    // forgets to add a case in badCaseForClaim — empty bad_case
    // would break failure messages + CATCHES.md ledger.
    const templates = [
      {
        template: "auth-required" as const,
        route: "/x",
        raw: "Auth required on /x.",
      },
      {
        template: "rate-limit" as const,
        route: "/x",
        rate: 10,
        window: "minute" as const,
        raw: "Rate-limits /x to 10/min.",
      },
      {
        template: "idempotent" as const,
        route: "/x",
        idField: "id",
        raw: "Makes /x idempotent on id.",
      },
      {
        template: "returns-status" as const,
        route: "/x",
        method: "POST" as const,
        status: 400,
        raw: "POST /x returns 400 on missing email.",
      },
      {
        template: "cli-output-contains" as const,
        route: "pinned x",
        text: "ok",
        raw: "`pinned x` outputs `ok`.",
      },
      {
        template: "cli-exits-zero" as const,
        route: "pinned x",
        raw: "`pinned x` exits 0.",
      },
      {
        template: "cli-creates-file" as const,
        route: "pinned x",
        filePath: "out.txt",
        raw: "`pinned x` creates `out.txt`.",
      },
      {
        template: "cli-flag-supported" as const,
        route: "pinned x",
        flag: "--json",
        raw: "`pinned x` supports `--json`.",
      },
      {
        template: "library-returns" as const,
        functionName: "fn",
        modulePath: "src/x.ts",
        expected: 1,
        raw: "`fn()` in `src/x.ts` returns `1`.",
      },
    ];
    for (const claim of templates) {
      const bc = badCaseForClaim(claim);
      expect(bc.length).toBeGreaterThan(20); // not empty, not trivial
      expect(bc).not.toContain("undefined");
      expect(bc).not.toContain("null");
    }
  });
});

describe("FEATURE-AUDIT: registry persists bugFixOrigin + badCase fields", () => {
  it("POSITIVE: addEntry with bugFixOrigin=true persists the flag", () => {
    const empty: Registry = { version: 1, claims: [] };
    const next = addEntry(empty, {
      claimId: "pr-1-x",
      prId: "pr-1",
      claim: {
        template: "auth-required",
        route: "/api/admin/x",
        raw: "Auth required on /api/admin/x.",
      },
      filename: "pr-1-x.test.ts",
      bugFixOrigin: true,
    });
    expect(next.claims[0].bugFixOrigin).toBe(true);
    expect(next.claims[0].badCase).toBeTruthy();
    expect(next.claims[0].badCase).toContain("/api/admin/x");
  });

  it("NO-CHANGE: addEntry without bugFixOrigin gets no field (not false)", () => {
    // bugFixOrigin should remain UNDEFINED (not stored) when not
    // passed, so feature pins stay distinguishable from explicit-
    // false in PINS.md ordering / .registry.json reading.
    const empty: Registry = { version: 1, claims: [] };
    const next = addEntry(empty, {
      claimId: "pr-2-y",
      prId: "pr-2",
      claim: {
        template: "auth-required",
        route: "/api/y",
        raw: "Auth required on /api/y.",
      },
      filename: "pr-2-y.test.ts",
    });
    expect(next.claims[0].bugFixOrigin).toBeUndefined();
    expect(next.claims[0].badCase).toBeTruthy(); // still has badCase
  });
});

describe("FEATURE-AUDIT: PINS.md orders bug-fix pins first and tags them", () => {
  it("POSITIVE: bug-fix pin appears BEFORE feature pin in the rendered table", () => {
    let reg: Registry = { version: 1, claims: [] };
    // Add feature pin FIRST (so without bug-fix ordering, it would
    // appear first by insertion order in the table).
    reg = addEntry(reg, {
      claimId: "pr-1-feat",
      prId: "pr-1",
      claim: {
        template: "auth-required",
        route: "/api/feature",
        raw: "Auth required on /api/feature.",
      },
      filename: "pr-1-feat.test.ts",
    });
    // Add bug-fix pin SECOND
    reg = addEntry(reg, {
      claimId: "pr-2-bugfix",
      prId: "pr-2",
      claim: {
        template: "auth-required",
        route: "/api/bugfix",
        raw: "Auth required on /api/bugfix.",
      },
      filename: "pr-2-bugfix.test.ts",
      bugFixOrigin: true,
    });
    const md = renderPinsManifest(reg);
    // The bug-fix pin's route must appear before the feature pin's
    // route in the rendered text. PINS.md is what readers scan on
    // GitHub; bug-fix-origin pins being at the top makes the
    // "Pinned protects the things you already had to fix" narrative
    // land.
    const bugfixIdx = md.indexOf("/api/bugfix");
    const featIdx = md.indexOf("/api/feature");
    expect(bugfixIdx).toBeGreaterThan(0);
    expect(featIdx).toBeGreaterThan(0);
    expect(bugfixIdx).toBeLessThan(featIdx);
    // The 🔁 tag must appear (next to the bug-fix pin).
    expect(md).toContain("🔁");
  });

  it("NO-CHANGE: registry with no bug-fix pins renders WITHOUT the legend", () => {
    // The 🔁 legend ("pin extracted from a bug-fix PR") should ONLY
    // appear when there's at least one bug-fix pin to explain.
    // Otherwise it's noise — extra text on every PINS.md for nothing.
    let reg: Registry = { version: 1, claims: [] };
    reg = addEntry(reg, {
      claimId: "pr-1-feat",
      prId: "pr-1",
      claim: {
        template: "auth-required",
        route: "/api/x",
        raw: "Auth required on /api/x.",
      },
      filename: "pr-1-feat.test.ts",
    });
    const md = renderPinsManifest(reg);
    expect(md).not.toContain("🔁");
    expect(md).not.toContain("bug-fix PR");
  });
});
