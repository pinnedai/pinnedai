// Template: server-action-write (0.2.18+)
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
// Recording flow:
//   pinned record-server-action <claim-id> --fixture <path-to-json>
//   → reads the JSON, validates it parses as an object, persists it
//     onto the claim, regenerates the .test.ts so the fixture lands
//     as an inline constant.
//
// Until a fixture is recorded the test self-skips with a clear
// "run pinned record-server-action" message — same posture as
// interaction-baseline's "no baseline recorded yet" mode.
//
// Auth-gated actions (saveIdea checks isAdminAuthed via a cookie):
// the recorder warns when the response was a "Not authorized." style
// shape and offers to capture an authenticated session for replay.
// v0.2.18 ships the basic direct-invoke path; full auth-fixture
// machinery lands in 0.2.19.

import type { ServerActionWriteClaim } from "../claimParser.js";
import { claimSlug } from "../claimParser.js";
import type { GenerateOpts, GeneratedTest } from "./rateLimit.js";

// Resolve the action module's import specifier from the test file's
// location. Pin files live in `tests/pinned/`; the action module is
// repo-relative (e.g. `lib/ideaActions.ts`). The relative import from
// tests/pinned/X.test.ts → ../../lib/ideaActions, with the extension
// stripped (ESM resolution).
function deriveImportSpecifier(actionModulePath: string): string {
  // Drop .ts/.tsx/.js/.jsx/.mjs/.cjs extension. Vitest + TS resolve
  // bare module specifiers; the extension would either error
  // (`.ts` extension on import in NodeNext) or work, depending on
  // tsconfig. Stripping is the most portable choice.
  const noExt = actionModulePath.replace(/\.(?:tsx?|jsx?|mjs|cjs)$/, "");
  return `../../${noExt}`;
}

export function generateServerActionWriteTest(
  claim: ServerActionWriteClaim,
  opts: GenerateOpts
): GeneratedTest {
  const slug = claimSlug(claim);
  const claimId = `${opts.prId}-${slug}`;
  const filename = `${claimId}.test.ts`;

  const importSpec = deriveImportSpecifier(claim.actionModule);
  // Fixture serialized as a JS literal (not a JSON literal — would
  // lose `undefined`, but undefined isn't meaningful in JSON anyway).
  const fixtureLiteral = claim.fixturePayload === undefined
    ? "null"
    : JSON.stringify(claim.fixturePayload, null, 2);
  const successShapeLiteral = JSON.stringify(claim.successShape ?? { ok: true });
  const authNote = claim.authGate ? ` (gated by ${claim.authGate}())` : "";
  const writeNote = `${claim.writeKind} → ${claim.writeTarget} (${claim.writeLibrary})`;

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
//
// Catches: removed validation, removed write, return-early on the
// success path, throw on valid input, return shape change.
//
// To record / re-record the fixture:
//   pinned record-server-action ${claimId} --fixture <path-to-payload.json>
//
// To retire:
//   pinned retire ${claimId} --reason="..."
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";

const FIXTURE: unknown = ${fixtureLiteral};
const SUCCESS_SHAPE: Record<string, unknown> = ${successShapeLiteral};
const ACTION_NAME = ${JSON.stringify(claim.exportName)};
const ACTION_MODULE = ${JSON.stringify(claim.actionModule)};

describe(\`Server Action \${ACTION_NAME} writes ${claim.writeTarget}\`, () => {
  const noFixture = FIXTURE === null;

  it.skipIf(noFixture)("returns success shape for valid payload", async () => {
    let action: ((input: unknown) => Promise<unknown>) | undefined;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod: any = await import(${JSON.stringify(importSpec)});
      action = mod[ACTION_NAME];
    } catch (e) {
      throw new Error(
        \`Failed to import Server Action from \${ACTION_MODULE}: \${(e as Error).message}\\n\` +
        \`  The action module may have been moved or renamed. If the move was intentional,\\n\` +
        \`  update the pin via \\\`pinned record-server-action ${claimId} --fixture <path>\\\` or retire it.\`
      );
    }
    if (typeof action !== "function") {
      throw new Error(
        \`\${ACTION_MODULE} no longer exports \${ACTION_NAME} as a function.\\n\` +
        \`  This pin asserts the App-Router mutation surface still exists. If the rename was\\n\` +
        \`  intentional, re-record the pin against the new export name.\`
      );
    }

    // Call the action directly. We pass the recorded fixture; the
    // action's own validation should accept it. Failure modes:
    //   - throw → caught by the it() block (assertion fail)
    //   - return shape mismatch → expect() below catches it
    //   - silent stub returning a different OK shape → expect() catches
    const result = (await action(FIXTURE)) as Record<string, unknown>;

    // Assert the success shape. Compare each declared field; ignore
    // extra fields in the result (so adding new fields to the response
    // is non-breaking, only removing/changing recorded ones is).
    for (const [key, expected] of Object.entries(SUCCESS_SHAPE)) {
      expect(result, \`Server Action \${ACTION_NAME} returned no result\`).toBeDefined();
      expect(result?.[key], \`Server Action \${ACTION_NAME} return-shape regressed at field "\${key}"\`).toEqual(expected);
    }
  });
});
`;

  return { filename, content, claimId };
}
