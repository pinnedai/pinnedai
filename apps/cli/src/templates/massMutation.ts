// Template: mass-mutation (0.2.24+)
//
// Catches `.from("X").update({...})` / `.from("X").delete()` calls
// that no longer have a filter clause. Mass-mutates the entire table
// on first execution — catastrophic data loss / unwanted state change.
// AI commonly drops `.eq()` filters during refactors.

import type { MassMutationClaim } from "../claimParser.js";
import { claimSlug } from "../claimParser.js";
import type { GenerateOpts, GeneratedTest } from "./rateLimit.js";

export function generateMassMutationTest(
  claim: MassMutationClaim,
  opts: GenerateOpts
): GeneratedTest {
  const slug = claimSlug(claim);
  const claimId = `${opts.prId}-${slug}`;
  const filename = `${claimId}.test.ts`;

  const content = `// ═══════════════════════════════════════════════════════════════
// ◆ Pinned by pinnedai — https://pinnedai.dev
// generated-by: pinnedai@${opts.pinnedVersion}
// ═══════════════════════════════════════════════════════════════
// Mass-mutation safety pin
// File:       ${claim.filePath}:${claim.line}
// Operation:  ${claim.operation.toUpperCase()} on table "${claim.table}"
//
// At pin-creation, this site had at least one filter clause (.eq /
// .match / .in / .gt / etc) on the ${claim.operation} chain. This pin
// asserts a filter is STILL present. AI dropping a filter clause is
// the load-bearing cause of accidental mass-mutation bugs.
//
// The pin passes when:
//   * The ${claim.operation} call still has at least one filter, OR
//   * The ${claim.operation} call was removed entirely.
//
// The pin fails when:
//   * The ${claim.operation} call survives but every filter clause is gone.
//
// To retire: pinned retire ${claimId} --reason="..."
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const SOURCE_FILE = ${JSON.stringify(claim.filePath)};
const TABLE = ${JSON.stringify(claim.table)};
const OPERATION = ${JSON.stringify(claim.operation)};

const SUPABASE_CLIENT_NAMES = "supabase|supabaseAdmin|admin|adminClient|db|sb|supa|client|userClient|serviceClient|sbAdmin|supabaseClient";
const FILTER_METHODS = "eq|neq|in|match|gt|gte|lt|lte|like|ilike|is|contains|containedBy|rangeGt|rangeLt|rangeGte|rangeLte|rangeAdjacent|overlaps|textSearch|filter|or|not|maybeSingle|single|limit|range";

describe("mass-mutation safety: " + OPERATION.toUpperCase() + " on " + TABLE + " keeps a filter", () => {
  const fullPath = join(process.cwd(), SOURCE_FILE);
  const fileExists = existsSync(fullPath);

  it.skipIf(!fileExists)(OPERATION + " on \\"" + TABLE + "\\" has a filter OR is removed entirely", () => {
    const content = readFileSync(fullPath, "utf8");
    const stripped = content.replace(/\\/\\/.*$/gm, "").replace(/\\/\\*[\\s\\S]*?\\*\\//g, "");
    const escapedTable = TABLE.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&");
    const chainRe = new RegExp(
      "\\\\b(?:" + SUPABASE_CLIENT_NAMES + ")\\\\s*\\\\.\\\\s*from\\\\s*\\\\(\\\\s*['\\"\\\`]" + escapedTable + "['\\"\\\`]\\\\s*\\\\)\\\\s*\\\\.\\\\s*" + OPERATION + "\\\\s*\\\\(",
      "g"
    );
    let m: RegExpExecArray | null = chainRe.exec(stripped);
    if (!m) {
      // Call removed entirely — pin passes.
      return;
    }
    // For each occurrence on this table+operation, ensure at least one
    // filter method appears on the chain before \`;\` or block-end.
    const checkedSites: Array<{ line: number; chainTail: string }> = [];
    while (m !== null) {
      let depth = 1;
      let j = m.index + m[0].length;
      while (j < stripped.length && depth > 0) {
        const c = stripped[j];
        if (c === '"' || c === "'" || c === "\\\`") {
          const q = c;
          j += 1;
          while (j < stripped.length && stripped[j] !== q) {
            if (stripped[j] === "\\\\") j += 1;
            j += 1;
          }
        } else if (c === "(") depth += 1;
        else if (c === ")") depth -= 1;
        j += 1;
      }
      const after = stripped.slice(j, j + 600);
      let pd = 0;
      let semiIdx = after.length;
      for (let i = 0; i < after.length; i++) {
        const c = after[i];
        if (c === "(" || c === "[" || c === "{") pd += 1;
        else if (c === ")" || c === "]" || c === "}") pd -= 1;
        else if (c === ";" && pd === 0) { semiIdx = i; break; }
      }
      const chainTail = after.slice(0, semiIdx);
      const filterRe = new RegExp("\\\\.\\\\s*(?:" + FILTER_METHODS + ")\\\\s*\\\\(");
      const hasFilter = filterRe.test(chainTail);
      if (!hasFilter) {
        const line = (stripped.slice(0, m.index).match(/\\n/g) || []).length + 1;
        checkedSites.push({ line, chainTail: chainTail.slice(0, 200) });
      }
      m = chainRe.exec(stripped);
    }
    const failMsg =
      OPERATION.toUpperCase() + " on \\"" + TABLE + "\\" at " + SOURCE_FILE +
      " no longer has a filter clause at " + checkedSites.length + " site(s): " +
      checkedSites.map((s) => "line " + s.line).join(", ") +
      ". This will mutate every row in the table on first execution. " +
      "Add an .eq() / .match() / .in() filter, or if intentional (full-table reset), retire: " +
      "pinned retire ${claimId} --reason=\\"...\\"";
    expect(checkedSites.length === 0, failMsg).toBe(true);
  });
});
`;

  return { filename, content, claimId };
}
