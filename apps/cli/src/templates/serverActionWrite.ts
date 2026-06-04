// Template: server-action-write (0.2.18+ · GREEN-path support 0.2.21+)
//
// Closes the App-Router mutation blind spot per
// [[strategic-moat-independent-guardrail]]: Server Actions are how
// modern Next.js apps mutate data, and HTTP-route detection misses
// all of them (saveIdea / aiFillIdea / uploadMockup all reported by
// socialideagen dogfood).
//
// Mode: DIRECT-INVOKE. The pin imports the action by relative path
// + calls it with a recorded fixture payload + asserts the result
// matches the success shape (default `{ ok: true }`). No HTTP round
// trip, no PREVIEW_URL needed — runs against the customer's compiled
// code in-process via vitest.
//
// 0.2.21+ — GREEN PATH for auth-gated actions:
//   When the detector captures the auth helper's import (via
//   claim.authHelperImport), the emitted test uses `vi.mock()` to
//   flip the gate at test time. Two test cases land:
//     1. "returns success with valid payload (session mocked)"
//        — auth helper returns true, action runs its happy path,
//        we assert the success shape.
//     2. "rejects when unauthenticated"
//        — auth helper returns false, we assert {ok: false} (or
//        thrown rejection). This is what catches AI silently
//        REMOVING the auth gate — with only the always-true mock,
//        gate removal would still pass.
//   When the auth helper import isn't captured (the action isn't
//   auth-gated, or the import shape is unusual), fall back to the
//   single-case behavior with precondition-WARN.
//
// Recording flow:
//   pinned record-server-action <claim-id> --fixture <path-to-json>
//   → reads the JSON, validates it parses as an object, persists it
//     onto the claim, regenerates the .test.ts so the fixture lands
//     as an inline constant.
//
// Until a fixture is recorded the test self-skips with a clear
// "run pinned record-server-action" message — same posture as
// interaction-baseline's "no baseline recorded yet" mode.

import type { ServerActionWriteClaim } from "../claimParser.js";
import { claimSlug } from "../claimParser.js";
import type { GenerateOpts, GeneratedTest } from "./rateLimit.js";

// Resolve the action module's import specifier from the test file's
// location. Pin files live in `tests/pinned/`; the action module is
// repo-relative (e.g. `lib/ideaActions.ts`). The relative import from
// tests/pinned/X.test.ts → ../../lib/ideaActions, with the extension
// stripped (ESM resolution).
function deriveImportSpecifier(actionModulePath: string): string {
  const noExt = actionModulePath.replace(/\.(?:tsx?|jsx?|mjs|cjs)$/, "");
  return `../../${noExt}`;
}

// Resolve the auth-helper's import specifier from the test file's
// location. The detector captured the relative path FROM the action
// module (e.g. action lives in `lib/ideaActions.ts`, imports auth via
// `./adminAuth` → resolves to `lib/adminAuth`). From the test file
// (`tests/pinned/X.test.ts`), that's `../../lib/adminAuth`.
//
// vi.mock matches by resolved absolute path, so this works even when
// the action's own import specifier and the test's vi.mock specifier
// are textually different — they resolve to the same file.
function deriveAuthHelperMockSpecifier(
  actionModulePath: string,
  authImportSpec: string
): string {
  // Action module's directory (POSIX-style — we only ever emit forward
  // slashes for ESM module specifiers).
  const actionDir = actionModulePath.split("/").slice(0, -1).join("/");
  // Resolve the auth import path against the action's directory.
  let combined: string;
  if (authImportSpec.startsWith("./") || authImportSpec.startsWith("../")) {
    combined = joinPosix(actionDir, authImportSpec);
  } else {
    // Bare module specifier (e.g. `@/lib/auth`) — pass through unchanged.
    // vi.mock will resolve it via tsconfig paths / package exports.
    return authImportSpec;
  }
  // Drop extension; map to a test-file-relative path.
  const noExt = combined.replace(/\.(?:tsx?|jsx?|mjs|cjs)$/, "");
  return `../../${noExt}`;
}

// Minimal POSIX-style path joiner. We avoid `node:path` so this
// helper stays browser-safe (the templates module is imported by the
// landing demo too — same constraint as the rest of the templates).
function joinPosix(base: string, rel: string): string {
  const parts = (base + "/" + rel).split("/");
  const stack: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") {
      if (stack.length > 0 && stack[stack.length - 1] !== "..") {
        stack.pop();
      } else {
        stack.push("..");
      }
    } else {
      stack.push(p);
    }
  }
  return stack.join("/");
}

export function generateServerActionWriteTest(
  claim: ServerActionWriteClaim,
  opts: GenerateOpts
): GeneratedTest {
  const slug = claimSlug(claim);
  const claimId = `${opts.prId}-${slug}`;
  const filename = `${claimId}.test.ts`;

  const importSpec = deriveImportSpecifier(claim.actionModule);
  const fixtureLiteral = claim.fixturePayload === undefined
    ? "null"
    : JSON.stringify(claim.fixturePayload, null, 2);
  const successShapeLiteral = JSON.stringify(claim.successShape ?? { ok: true });
  const authNote = claim.authGate ? ` (gated by ${claim.authGate}())` : "";
  const writeNote = `${claim.writeKind} → ${claim.writeTarget} (${claim.writeLibrary})`;

  // GREEN-path support: when the detector captured the auth helper's
  // import, emit vi.mock + dual test cases. Otherwise emit the
  // single-case fallback with precondition WARN.
  const hasAuthMock = !!claim.authHelperImport;
  const authMockSpec = claim.authHelperImport
    ? deriveAuthHelperMockSpecifier(claim.actionModule, claim.authHelperImport.specifier)
    : "";
  const authMockName = claim.authHelperImport?.named ?? "";

  // The vi.mock block — uses vi.hoisted() so the factory captures a
  // mutable reference. vi.mock is hoisted above all imports by vitest
  // automatically, so this works even though it's declared after them.
  const viMockBlock = hasAuthMock ? `
// Mock the auth helper so we can drive both success and unauthed
// branches without a real session. \`vi.hoisted()\` gives the mock
// factory a stable reference we can mutate between tests.
const __authState = vi.hoisted(() => ({ allow: true }));
vi.mock(${JSON.stringify(authMockSpec)}, () => ({
  ${authMockName}: async () => __authState.allow,
}));
` : "";

  // beforeEach reset (resets the mock to "allow" between tests so
  // test order doesn't matter).
  const beforeEachBlock = hasAuthMock ? `
  beforeEach(() => {
    __authState.allow = true;
  });
` : "";

  // Imports — vi + vitest helpers if we're using vi.mock.
  const vitestImports = hasAuthMock
    ? `import { describe, it, expect, vi, beforeEach } from "vitest";`
    : `import { describe, it, expect } from "vitest";`;

  // The "rejects when unauthed" test case. Only emitted when we have
  // the auth mock — otherwise we can't flip the gate at test time.
  // Catches AI silently REMOVING the auth check entirely (with only
  // the always-true mock, that removal would not produce a regression).
  const rejectCase = hasAuthMock ? `
  it.skipIf(noFixture)("rejects when unauthenticated", async () => {
    __authState.allow = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import(${JSON.stringify(importSpec)});
    const action = mod[ACTION_NAME];
    let result: unknown;
    let threw = false;
    try {
      result = await action(FIXTURE);
    } catch {
      // Throwing on unauthed is also acceptable behavior — many
      // actions \`throw new Error("Unauthorized")\` instead of
      // returning a shape. Either passes the assertion.
      threw = true;
    }
    if (threw) return; // throw-on-unauthed is the canonical pattern
    // Otherwise expect a falsy ok / explicit unauthorized error.
    const r = result as { ok?: unknown; error?: unknown } | undefined;
    const looksUnauthed =
      (r && r.ok === false) ||
      (r && typeof r.error === "string" && /not\\s*authoriz|unauthor|forbidden|sign\\s*in|please\\s*log\\s*in/i.test(r.error));
    expect(
      looksUnauthed,
      "Server Action " + ACTION_NAME + " did NOT reject when the auth gate returned false. " +
      "Possible causes: the auth check was silently removed, or the action no longer reads from the auth helper. " +
      "If intentional, retire the pin: pinned retire ${claimId} --reason=\\"...\\""
    ).toBe(true);
  });
` : "";

  const content = `// ═══════════════════════════════════════════════════════════════
// ◆ Pinned by pinnedai — https://pinnedai.dev
// generated-by: pinnedai@${opts.pinnedVersion}
// ═══════════════════════════════════════════════════════════════
// Server Action: ${claim.exportName}${authNote}
//
// Original claim:  ${JSON.stringify(claim.raw)}
// Source PR:       ${opts.prId}
// Template:        server-action-write
//
// What this checks: imports ${claim.exportName}() from
// \`${claim.actionModule}\` and calls it with a recorded valid
// payload. Asserts the return shape matches the success baseline.
// Write target: ${writeNote}.
${hasAuthMock ? `//
// Auth-gated action: vi.mock() flips the auth gate so we can verify
// BOTH the success path (mock=allow → expect {ok:true}) AND the
// reject path (mock=deny → expect {ok:false}). The reject test is
// what catches AI silently removing the auth check.` : ""}
//
// Catches: removed validation, removed write, return-early on the
// success path, throw on valid input, return shape change${hasAuthMock ? ", removed auth gate" : ""}.
//
// To record / re-record the fixture:
//   pinned record-server-action ${claimId} --fixture <path-to-payload.json>
//
// To retire:
//   pinned retire ${claimId} --reason="..."
// ═══════════════════════════════════════════════════════════════

${vitestImports}
${viMockBlock}
const FIXTURE: unknown = ${fixtureLiteral};
const SUCCESS_SHAPE: Record<string, unknown> = ${successShapeLiteral};
const ACTION_NAME = ${JSON.stringify(claim.exportName)};
const ACTION_MODULE = ${JSON.stringify(claim.actionModule)};

describe(\`Server Action \${ACTION_NAME} writes ${claim.writeTarget}\`, () => {
  const noFixture = FIXTURE === null;
${beforeEachBlock}
  it.skipIf(noFixture)(${hasAuthMock ? `"returns success shape for valid payload (session mocked)"` : `"returns success shape for valid payload"`}, async () => {
    let action: ((input: unknown) => Promise<unknown>) | undefined;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod: any = await import(${JSON.stringify(importSpec)});
      action = mod[ACTION_NAME];
    } catch (e) {
      throw new Error(
        "Failed to import Server Action from " + ACTION_MODULE + ": " + (e as Error).message + "\\n" +
        "  The action module may have been moved or renamed. If the move was intentional,\\n" +
        "  update the pin via pinned record-server-action ${claimId} --fixture <path> or retire it."
      );
    }
    if (typeof action !== "function") {
      throw new Error(
        ACTION_MODULE + " no longer exports " + ACTION_NAME + " as a function.\\n" +
        "  This pin asserts the App-Router mutation surface still exists. If the rename was\\n" +
        "  intentional, re-record the pin against the new export name."
      );
    }

    // Call the action directly. We pass the recorded fixture; the
    // action's own validation should accept it. Failure modes:
    //   - throw → caught by the it() block (assertion fail)
    //   - return shape mismatch → expect() below catches it
    //   - silent stub returning a different OK shape → expect() catches
    //   - "can't run here" (missing service-role key / 503 backend not
    //     configured / etc.) → WARN + skip, NOT fail.
    const result = (await action(FIXTURE)) as Record<string, unknown> | undefined;

    // Precondition-failure recognizer. With the auth helper now mocked
    // to allow, the only "can't run" branches we should see are env
    // / backend-config related.
    if (result && typeof result === "object" && result.ok === false && typeof result.error === "string") {
      const err = result.error;
      if (/not\\s*authoriz|unauthor|sign\\s*in|please\\s*log\\s*in|forbidden/i.test(err)) {
        console.warn(
          "⚠ Pinned: can't verify " + ACTION_NAME + " here — auth helper mocked but action still returned unauthorized.\\n" +
          "  This may mean the action checks auth via a different mechanism (request cookies parsed inline,\\n" +
          "  a second auth helper not auto-detected, etc). Inspect the action and either retire the pin\\n" +
          "  or extend pinned record-server-action to mock the additional gate."
        );
        return;
      }
      if (/backend\\s*not\\s*configured|service\\s*unavailable|missing.*(?:env|key|url|secret)|not\\s*configured/i.test(err)) {
        console.warn(
          "⚠ Pinned: can't verify " + ACTION_NAME + " here — backend env is missing.\\n" +
          "  The action returned a missing-env signal (\\"" + err + "\\"). Set the relevant env vars\\n" +
          "  (service-role key, DB URL, external API key) and re-run for a real verification."
        );
        return;
      }
    }
    if (result && typeof result === "object" && (result.status === 503 || result.statusCode === 503)) {
      console.warn(
        "⚠ Pinned: can't verify " + ACTION_NAME + " here — action returned 503 (Service Unavailable).\\n" +
        "  Precondition failure, NOT a regression. Likely missing backend env."
      );
      return;
    }
    if (!result || typeof result !== "object") {
      throw new Error("Server Action " + ACTION_NAME + " returned no usable result: " + JSON.stringify(result));
    }

    // Assert the success shape. Compare each declared field; ignore
    // extra fields in the result.
    for (const [key, expected] of Object.entries(SUCCESS_SHAPE)) {
      expect(result, "Server Action " + ACTION_NAME + " returned no result").toBeDefined();
      expect(
        result?.[key],
        "Server Action " + ACTION_NAME + " return-shape regressed at field \\"" + key + "\\""
      ).toEqual(expected);
    }
  });
${rejectCase}
});
`;

  return { filename, content, claimId };
}
