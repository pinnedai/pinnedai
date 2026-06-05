// Template: nullable-result (0.2.23+)
import type { NullableResultClaim } from "../claimParser.js";
import { claimSlug } from "../claimParser.js";
import type { GenerateOpts, GeneratedTest } from "./rateLimit.js";

export function generateNullableResultTest(
  claim: NullableResultClaim,
  opts: GenerateOpts
): GeneratedTest {
  const slug = claimSlug(claim);
  const claimId = `${opts.prId}-${slug}`;
  const filename = `${claimId}.test.ts`;

  const content = `// ═══════════════════════════════════════════════════════════════
// ◆ Pinned by pinnedai — https://pinnedai.dev
// generated-by: pinnedai@${opts.pinnedVersion}
// ═══════════════════════════════════════════════════════════════
// Nullable-result-used pin
// File:    ${claim.filePath}:${claim.line}
// Source:  ${claim.source}
//
// At pin-creation, ${claim.filePath}:${claim.line} used the result of
// ${claim.source} WITHOUT a null guard, in a server-side request handler.
// First edge-case input would crash the route with a 500.
//
// This pin asserts EITHER:
//   * The unguarded use site got a null guard added, OR
//   * The .find/.match/.exec call was removed entirely.
//
// To retire:  pinned retire ${claimId} --reason="..."
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const HANDLER_FILE = ${JSON.stringify(claim.filePath)};
const NULLABLE_CALL_SOURCE = ${JSON.stringify(claim.source)};

describe("nullable-result: " + HANDLER_FILE + " guards .find/.match/.exec results", () => {
  const fullPath = join(process.cwd(), HANDLER_FILE);
  const fileExists = existsSync(fullPath);

  it.skipIf(!fileExists)("either the call is removed OR a null guard was added", () => {
    const content = readFileSync(fullPath, "utf8");
    const stripped = content.replace(/\\/\\/.*$/gm, "").replace(/\\/\\*[\\s\\S]*?\\*\\//g, "");
    // (a) The unguarded call source no longer appears. AI may have
    //     removed the .find/.match/.exec entirely — fine.
    const callPresent = stripped.includes(NULLABLE_CALL_SOURCE);
    if (!callPresent) return;
    // (b) The call IS still present. Look for any null-guard pattern
    //     adjacent to it: \`if (!name)\` / \`name?.\` / \`name ?? \` / etc.
    // Extract the variable name: the LHS of \`const X = ...\`.
    const declRe = new RegExp("\\\\bconst\\\\s+(\\\\w+)\\\\s*=\\\\s*" + NULLABLE_CALL_SOURCE.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&"));
    const dm = declRe.exec(stripped);
    if (!dm) {
      // Source moved or refactored beyond recognition. Treat as fine.
      return;
    }
    const name = dm[1];
    const after = stripped.slice(dm.index + dm[0].length, dm.index + dm[0].length + 1500);
    const guardRe = new RegExp(
      "\\\\bif\\\\s*\\\\(\\\\s*!?\\\\s*" + name + "\\\\s*[)\\\\?\\\\&\\\\|]" +
      "|\\\\b" + name + "\\\\s*\\\\?\\\\." +
      "|\\\\b" + name + "\\\\s*\\\\?\\\\?\\\\s" +
      "|\\\\b" + name + "\\\\s*===\\\\s*(?:null|undefined)" +
      "|\\\\b" + name + "\\\\s*!==\\\\s*(?:null|undefined)"
    );
    const guarded = guardRe.test(after);
    const failMsg =
      "In " + HANDLER_FILE + ", the result of " + NULLABLE_CALL_SOURCE + " is still used without a null guard. " +
      "First edge-case input crashes the route with a 500. Add: if (!" + name + ") return ...; before the use, " +
      "or use " + name + "?. property access. " +
      "If the call was intentionally moved to library code (no longer a server handler), retire: pinned retire ${claimId} --reason=\\"...\\"";
    expect(guarded, failMsg).toBe(true);
  });
});
`;
  return { filename, content, claimId };
}
