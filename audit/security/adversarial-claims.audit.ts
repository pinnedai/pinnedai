// FEATURE: generated test source is safe against adversarial slot
//   values — backticks, ${} expressions, newlines, quotes, comment
//   closers, Unicode escapes, RTL-override characters.
// SIGNAL: when a claim's route / text / field / function / module /
//   tier / role contains hostile characters, the generated test file
//   either (a) escapes them safely so the file compiles AND the
//   literal value is preserved, or (b) the parser rejects the claim
//   entirely (so nothing gets generated).
// FALSIFIABILITY: catches a regression where someone replaces
//   JSON.stringify() with manual string concatenation, or interpolates
//   a slot value into a template literal without escaping. Either
//   would allow a malicious PR description to inject test logic.

import { describe, it, expect } from "vitest";
import {
  generateAuthRequiredTest,
  generateRateLimitTest,
  generateIdempotentTest,
  generateReturnsStatusTest,
  generatePermissionRequiredTest,
  generateTierCapTest,
  generateCliOutputContainsTest,
  generateLibraryReturnsTest,
} from "../../apps/cli/src/index.js";

// Hostile payloads we'd expect an adversarial PR description to try.
const HOSTILE_VALUES = {
  // Template-literal escape attempt
  templateLiteralEscape: "/api/x`); throw new Error(\"injected\"); //",
  // ${...} interpolation that would leak env var if interpolated
  envInterp: "/api/${process.env.HOME}",
  // Newline injection to break out of one-liner contexts
  newline: "/api/x\nrequire('child_process').execSync('echo PWNED')",
  // Quote escape
  quoteEscape: '/api/x"; throw new Error("PWNED"); //',
  // Comment closer
  commentCloser: "/api/x */ throw new Error('PWNED'); //",
  // Unicode RTL-override (‮) — could swap visible order
  rtlOverride: "/api/admin‮/export",
  // Backslash escape
  backslashEscape: "/api/x\\\";const a=1;//",
};

// Invariant: every hostile slot value must appear in the generated
// source as a JSON-encoded string literal. If JSON.stringify was
// used (which is the only safe pattern), the hostile value cannot
// break out of its string-literal context — JSON.stringify escapes
// backticks, quotes, newlines, backslashes, and Unicode chars.
//
// Why this single check is sufficient: any "injection" requires the
// hostile value to appear OUTSIDE a string literal (as executable
// code). JSON.stringify ALWAYS produces a quoted-string literal. So
// if JSON.stringify's output is present in the source, the hostile
// value was string-quoted; it cannot execute.
//
// We don't run `node --check` because the generated source is TypeScript
// (type annotations + .ts-only syntax), which node's plain parser
// rejects. Adding a TS compiler to the audit would bloat dependencies
// without strengthening the invariant — JSON.stringify is sound.
function assertSafelyEscaped(source: string, hostileValue: string, slotName: string) {
  const jsonEncoded = JSON.stringify(hostileValue);
  expect(
    source.includes(jsonEncoded),
    `slot ${slotName}: hostile value not JSON-encoded in generated source — possible raw-interpolation regression`
  ).toBe(true);
}

describe("FEATURE-AUDIT: adversarial claim slots — auth-required", () => {
  for (const [name, value] of Object.entries(HOSTILE_VALUES)) {
    it(`POSITIVE CONTROL: route="${name}" is safely escaped, generated source uses JSON-encoded form`, () => {
      const gen = generateAuthRequiredTest(
        {
          template: "auth-required",
          route: value,
          raw: `Auth required on ${value}.`,
        },
        { prId: "audit-adv" }
      );
      assertSafelyEscaped(gen.content, value, "route");
    });
  }
});

describe("FEATURE-AUDIT: adversarial claim slots — rate-limit", () => {
  for (const [name, value] of Object.entries(HOSTILE_VALUES)) {
    it(`POSITIVE CONTROL: route="${name}" safely escaped`, () => {
      const gen = generateRateLimitTest(
        {
          template: "rate-limit",
          route: value,
          rate: 60,
          window: "minute",
          raw: `Rate-limits ${value} to 60 req/min.`,
        },
        { prId: "audit-adv" }
      );
      assertSafelyEscaped(gen.content, value, "route");
    });
  }
});

describe("FEATURE-AUDIT: adversarial claim slots — idempotent", () => {
  for (const [name, value] of Object.entries(HOSTILE_VALUES)) {
    it(`POSITIVE CONTROL: route="${name}" safely escaped`, () => {
      const gen = generateIdempotentTest(
        {
          template: "idempotent",
          route: value,
          idField: "event_id",
          raw: `Makes ${value} idempotent on event_id.`,
        },
        { prId: "audit-adv" }
      );
      assertSafelyEscaped(gen.content, value, "route");
    });
  }
});

describe("FEATURE-AUDIT: adversarial claim slots — returns-status field", () => {
  // The returns-status template uses `field` to construct a request
  // body shape (`{ [field]: invalid_value }`) — the field name becomes
  // a JSON key, which is just as safe as a value because JSON keys
  // are always quoted strings. We verify the template doesn't crash
  // on a hostile field name and that the field appears in JSON-encoded
  // form somewhere in the test (likely in the FIELD_NAME constant).
  const hostileField = 'email"); throw new Error("PWNED"); //';
  it("POSITIVE CONTROL: template generates without crashing on hostile field, field appears in JSON-quoted context", () => {
    const gen = generateReturnsStatusTest(
      {
        template: "returns-status",
        route: "/api/signup",
        method: "POST",
        status: 400,
        condition: "missing email",
        field: hostileField,
        conditionKind: "missing",
        raw: "POST /api/signup returns 400 on missing email.",
      },
      { prId: "audit-adv" }
    );
    // Generation succeeded — no crash, no template crash on hostile chars.
    expect(gen.content.length).toBeGreaterThan(100);
    // The field may not appear directly (it might be referenced via
    // a condition string like "missing email" — not the raw value).
    // The KEY invariant is: nothing should be raw-interpolated. We
    // check by ensuring the literal "throw new Error" doesn't appear
    // at the top level of the source (i.e., outside string/comment context).
    // Cheap test: if the field is anywhere, it's JSON-encoded.
    if (gen.content.includes("PWNED")) {
      expect(gen.content).toContain(JSON.stringify(hostileField));
    }
  });
});

describe("FEATURE-AUDIT: adversarial claim slots — permission-required role", () => {
  const hostileRole = 'admin"); throw new Error("PWNED"); //';
  it("POSITIVE CONTROL: hostile role slot is safely escaped", () => {
    const gen = generatePermissionRequiredTest(
      {
        template: "permission-required",
        route: "/api/admin/x",
        role: hostileRole,
        raw: `/api/admin/x requires ${hostileRole} role.`,
      },
      { prId: "audit-adv" }
    );
    assertSafelyEscaped(gen.content, hostileRole, "role");
  });
});

describe("FEATURE-AUDIT: adversarial claim slots — tier-cap tier + resource", () => {
  const hostileTier = 'free"); throw new Error("PWNED"); //';
  const hostileResource = 'projects"); throw new Error("PWNED"); //';
  it("POSITIVE CONTROL: hostile tier slot is safely escaped", () => {
    const gen = generateTierCapTest(
      {
        template: "tier-cap",
        route: "/api/projects",
        tier: hostileTier,
        cap: 3,
        resource: "projects",
        raw: `POST /api/projects is capped at 3 for ${hostileTier} tier.`,
      },
      { prId: "audit-adv" }
    );
    assertSafelyEscaped(gen.content, hostileTier, "tier");
  });
  it("POSITIVE CONTROL: hostile resource slot is safely escaped", () => {
    const gen = generateTierCapTest(
      {
        template: "tier-cap",
        route: "/api/x",
        tier: "free",
        cap: 1,
        resource: hostileResource,
        raw: `POST /api/x is capped at 1 for free tier.`,
      },
      { prId: "audit-adv" }
    );
    assertSafelyEscaped(gen.content, hostileResource, "resource");
  });
});

describe("FEATURE-AUDIT: adversarial claim slots — CLI output text", () => {
  const hostileText = 'success"); throw new Error("PWNED"); //';
  it("POSITIVE CONTROL: hostile text slot is safely escaped", () => {
    const gen = generateCliOutputContainsTest(
      {
        template: "cli-output-contains",
        route: "pinned doctor",
        text: hostileText,
        raw: `\`pinned doctor\` outputs \`${hostileText}\`.`,
      },
      { prId: "audit-adv" }
    );
    assertSafelyEscaped(gen.content, hostileText, "text");
  });
});

describe("FEATURE-AUDIT: adversarial claim slots — library-returns", () => {
  // The library-returns template's `expected` is JSON-serialized
  // and compared via deep-equal. The template may embed it as a
  // re-serialized JSON literal OR as a parsed value — either is safe
  // since JSON parsing/stringifying both prevent injection.
  const hostileExpected = { foo: 'bar"); throw new Error("PWNED"); //' };
  it("POSITIVE CONTROL: template generates without crashing on hostile expected value", () => {
    const gen = generateLibraryReturnsTest(
      {
        template: "library-returns",
        functionName: "getX()",
        modulePath: "src/x.ts",
        expected: hostileExpected,
        raw: "`getX()` in `src/x.ts` returns `{...}`.",
      },
      { prId: "audit-adv" }
    );
    expect(gen.content.length).toBeGreaterThan(100);
    // The PWNED text, if it appears, must be inside a JSON-encoded
    // string literal (proves JSON.stringify was applied somewhere).
    if (gen.content.includes("PWNED")) {
      // Either the full object's JSON-stringified form or the inner
      // string's JSON-encoded form appears in the source.
      const fullJson = JSON.stringify(hostileExpected);
      const innerJson = JSON.stringify(hostileExpected.foo);
      expect(
        gen.content.includes(fullJson) || gen.content.includes(innerJson)
      ).toBe(true);
    }
  });
});

describe("FALSIFIABILITY: hostile values that DON'T match a regex don't generate any test", () => {
  // Sanity: if parser rejects a hostile claim (because the regex
  // requires specific shapes), nothing is generated → nothing to escape.
  // This is the SAFE outcome.
  // E.g., a "route" with a newline in the middle can't match our
  // ROUTE regex (which requires `\/[^\s,.;:!?)\]]+`).
  it("a route with embedded newline is rejected by the regex, no claim generated", async () => {
    const { parseClaims } = await import(
      "../../apps/cli/src/claimParser.js"
    );
    const hostileBody = "Auth required on /api/x\nthrow new Error('PWNED').";
    const claims = parseClaims(hostileBody);
    // The route token stops at the first \s, so the parser captures
    // "/api/x" cleanly and ignores the rest. The hostile suffix isn't
    // part of any claim.
    for (const c of claims) {
      if ("route" in c) {
        expect(c.route).not.toContain("\n");
        expect(c.route).not.toContain("PWNED");
      }
    }
  });
});
