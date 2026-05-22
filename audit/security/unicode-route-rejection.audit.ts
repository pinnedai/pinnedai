// FEATURE: parser rejects routes containing dangerous Unicode chars.
// SIGNAL: claim text with fullwidth slashes (／), RTL-override (‮),
//   zero-width joiners (ZWJ), or other non-ASCII-slash characters
//   does NOT produce a permission-required / auth-required / etc.
//   pin with a "looks-like-route-but-isn't" value. Either the
//   parser captures only the ASCII portion OR rejects entirely.
// FALSIFIABILITY: catches a regression where someone broadens the
//   ROUTE regex to accept non-ASCII chars and Pinned starts pinning
//   routes that don't actually exist in the customer's app (because
//   their server only routes by ASCII paths).

import { describe, it, expect } from "vitest";
import { parseClaims } from "../../apps/cli/src/claimParser.js";

describe("FEATURE-AUDIT: route parser is ASCII-slash-only — rejects Unicode lookalikes", () => {
  it("POSITIVE CONTROL: legitimate ASCII route extracts normally", () => {
    const claims = parseClaims("Auth required on /api/admin/export.");
    expect(claims).toHaveLength(1);
    if ("route" in claims[0]) {
      expect(claims[0].route).toBe("/api/admin/export");
    }
  });

  it("FALSIFIABILITY: fullwidth slash (／) does NOT extract as ROUTE", () => {
    // The ROUTE regex uses ASCII `/` only. A claim with fullwidth
    // slashes can't match because there's no leading ASCII /.
    const claims = parseClaims("Auth required on ／api／admin／export.");
    // Either zero claims (regex didn't match) or the route doesn't
    // contain the fullwidth slash.
    for (const c of claims) {
      if ("route" in c) {
        expect(c.route).not.toContain("／");
      }
    }
    // The most likely outcome: 0 claims (no ASCII slash to anchor on).
    expect(claims.length).toBe(0);
  });

  it("FALSIFIABILITY: RTL-override character (U+202E) is stripped or rejected", () => {
    // RTL-override could visually reorder text. Our regex stops at
    // whitespace/punctuation but doesn't reject control characters
    // explicitly. Verify the captured route doesn't include the U+202E.
    const claims = parseClaims("Auth required on /api/admin‮/export.");
    for (const c of claims) {
      if ("route" in c) {
        expect(c.route).not.toContain("‮");
      }
    }
  });

  it("FALSIFIABILITY: zero-width joiner (U+200D) doesn't sneak into a route", () => {
    const claims = parseClaims("Auth required on /api/admin‍/export.");
    for (const c of claims) {
      if ("route" in c) {
        expect(c.route).not.toContain("‍");
      }
    }
  });

  it("NO-CHANGE: a route with percent-encoded chars (%65) extracts AS-IS (legitimate URL encoding)", () => {
    // Percent encoding is legitimate in URLs. The customer's app may
    // normalize /api/%65xport → /api/export. We capture as-is and
    // let the customer decide; this isn't a security boundary.
    const claims = parseClaims("Auth required on /api/%65xport.");
    expect(claims).toHaveLength(1);
    if ("route" in claims[0]) {
      // We don't normalize — pass-through.
      expect(claims[0].route).toBe("/api/%65xport");
    }
  });
});
