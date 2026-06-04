// Template: edge-function-write (0.2.19+)
//
// Pins the write surface of a Supabase Edge Function. Edge Functions
// run in Deno, not Node — direct invoke from vitest isn't feasible.
// Instead the pin reads the source at test time and asserts:
//   1. The function file still exists at the captured path.
//   2. The recognized write expression (insert/upsert/update/delete
//      via supabase-js, file upload, paid API call, etc.) still
//      appears in the body.
//   3. The auth-gate function call (when captured) still appears.
//
// Catches: AI deletes the function ("dead code cleanup"), removes
// the write call, weakens the auth gate (drops the `requireAuth()`
// guard the user originally put in front of the `admin.from(...)`
// insert).

import type { EdgeFunctionWriteClaim } from "../claimParser.js";
import { claimSlug } from "../claimParser.js";
import type { GenerateOpts, GeneratedTest } from "./rateLimit.js";

export function generateEdgeFunctionWriteTest(
  claim: EdgeFunctionWriteClaim,
  opts: GenerateOpts
): GeneratedTest {
  const slug = claimSlug(claim);
  const claimId = `${opts.prId}-${slug}`;
  const filename = `${claimId}.test.ts`;

  // Build the write-shape regex for the assertion. Conservative —
  // matches the write-method call on a recognized client identifier.
  // Same widened identifier set the detector uses (supabase / admin /
  // db / sb / supa / etc.).
  const writeMethodForKind: Record<EdgeFunctionWriteClaim["writeKind"], string> = {
    "db-insert": "insert",
    "db-update": "update",
    "db-upsert": "upsert",
    "db-delete": "delete",
    "email": "send",
    "queue": "(?:add|enqueue|push|publish|send)",
    "http-post": "create",
    "file-upload": "upload",
  };
  const writeMethod = writeMethodForKind[claim.writeKind];

  const content = `// ═══════════════════════════════════════════════════════════════
// ◆ Pinned by pinnedai — https://pinnedai.dev
// generated-by: pinnedai@${opts.pinnedVersion}
// ═══════════════════════════════════════════════════════════════
// Supabase Edge Function: ${claim.functionName}
// File:                   ${claim.filePath}
// Write:                  ${claim.writeKind} → ${claim.writeTarget} (${claim.writeLibrary})
${claim.authGate ? `// Auth gate:              ${claim.authGate}()\n` : ""}//
// Original claim:  ${JSON.stringify(claim.raw)}
// Source PR:       ${opts.prId}
// Template:        edge-function-write
//
// What this checks: reads \`${claim.filePath}\` from disk and asserts:
//   1. The file exists (function not deleted)
//   2. The ${claim.writeKind} call on "${claim.writeTarget}" still appears
${claim.authGate ? `//   3. ${claim.authGate}() (the auth gate) still appears in the file\n` : ""}//
// Catches: AI deletes the Edge Function, removes the write,
// weakens the auth gate. HTTP-route detection structurally misses
// these — Edge Functions run in Deno via Deno.serve / serve().
//
// To retire:
//   pinned retire ${claimId} --reason="..."
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const FUNCTION_FILE = ${JSON.stringify(claim.filePath)};
const FUNCTION_NAME = ${JSON.stringify(claim.functionName)};
const WRITE_TARGET = ${JSON.stringify(claim.writeTarget)};
const WRITE_METHOD = ${JSON.stringify(writeMethod)};
const AUTH_GATE: string | null = ${claim.authGate ? JSON.stringify(claim.authGate) : "null"};

describe(\`Supabase Edge Function \${FUNCTION_NAME} still writes \${WRITE_TARGET}\`, () => {
  const fullPath = join(process.cwd(), FUNCTION_FILE);
  const fileExists = existsSync(fullPath);

  it.skipIf(!fileExists)("function file is present", () => {
    expect(fileExists, \`Edge Function file \${FUNCTION_FILE} no longer exists. If the function was moved/renamed, re-record the pin against the new path. If it was deleted intentionally, retire the pin.\`).toBe(true);
  });

  it.skipIf(!fileExists)(\`writes \${WRITE_TARGET} via \${WRITE_METHOD}\`, () => {
    const content = readFileSync(fullPath, "utf8");
    const stripped = content.replace(/\\/\\/.*$/gm, "").replace(/\\/\\*[\\s\\S]*?\\*\\//g, "");
    // Match \`<client>.from("<target>").<method>\` or \`<client>.storage.from("<bucket>").upload\`
    // or generic write shapes per kind.
    const targetEscaped = WRITE_TARGET.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&");
    const dbRe = new RegExp(
      "\\\\b(?:supabase|supabaseAdmin|admin|adminClient|db|sb|supa|client|userClient|serviceClient|sbAdmin|supabaseClient)\\\\s*\\\\.\\\\s*from\\\\s*\\\\(\\\\s*['\\"\\\`]" + targetEscaped + "['\\"\\\`]\\\\s*\\\\)\\\\s*\\\\.\\\\s*" + WRITE_METHOD + "\\\\b"
    );
    const storageRe = new RegExp(
      "\\\\.\\\\s*storage\\\\s*\\\\.\\\\s*from\\\\s*\\\\(\\\\s*['\\"\\\`]" + targetEscaped + "['\\"\\\`]\\\\s*\\\\)\\\\s*\\\\.\\\\s*upload\\\\b"
    );
    const found = dbRe.test(stripped) || storageRe.test(stripped);
    const failMsg =
      "Edge Function " + FUNCTION_NAME + " no longer writes to \\"" + WRITE_TARGET + "\\" via " + WRITE_METHOD + "(). " +
      "The write call may have been removed or refactored beyond recognition. " +
      "If intentional, retire the pin: pinned retire ${claimId} --reason=\\"...\\"";
    expect(found, failMsg).toBe(true);
  });

  it.skipIf(!fileExists || !AUTH_GATE)("auth gate still appears", () => {
    if (!AUTH_GATE) return;
    const content = readFileSync(fullPath, "utf8");
    const stripped = content.replace(/\\/\\/.*$/gm, "").replace(/\\/\\*[\\s\\S]*?\\*\\//g, "");
    const escaped = AUTH_GATE.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&");
    const authRe = new RegExp("\\\\b" + escaped + "\\\\s*\\\\(");
    const found = authRe.test(stripped);
    const failMsg =
      "Auth gate " + AUTH_GATE + "() no longer appears in " + FUNCTION_FILE + ". " +
      "AI may have removed the authentication check — Edge Function would write to \\"" + WRITE_TARGET + "\\" without verifying the caller. " +
      "If intentional (e.g. moved to middleware), retire the pin: pinned retire ${claimId} --reason=\\"...\\"";
    expect(found, failMsg).toBe(true);
  });
});
`;

  return { filename, content, claimId };
}
