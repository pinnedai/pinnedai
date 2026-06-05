// Template: supabase-column (0.2.23+)
import type { SupabaseColumnClaim } from "../claimParser.js";
import { claimSlug } from "../claimParser.js";
import type { GenerateOpts, GeneratedTest } from "./rateLimit.js";

export function generateSupabaseColumnTest(
  claim: SupabaseColumnClaim,
  opts: GenerateOpts
): GeneratedTest {
  const slug = claimSlug(claim);
  const claimId = `${opts.prId}-${slug}`;
  const filename = `${claimId}.test.ts`;
  const colsLiteral = JSON.stringify(claim.referencedColumns);
  const sourcesLiteral = JSON.stringify(claim.schemaSources);

  const content = `// ═══════════════════════════════════════════════════════════════
// ◆ Pinned by pinnedai — https://pinnedai.dev
// generated-by: pinnedai@${opts.pinnedVersion}
// ═══════════════════════════════════════════════════════════════
// Supabase column-exists pin
// Table:           ${claim.table}
// Schema sources:  ${claim.schemaSources.join(", ")}
//
// Asserts every column the code currently references on this table
// is still declared in the schema (migrations / database.types.ts).
// Catches AI silently removing a column from migrations while the
// code keeps querying it — runtime error on first query.
//
// To retire:  pinned retire ${claimId} --reason="..."
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const TABLE = ${JSON.stringify(claim.table)};
const REFERENCED_COLUMNS: string[] = ${colsLiteral};
const SCHEMA_SOURCES_AT_PIN: string[] = ${sourcesLiteral};

const SKIP = new Set(["node_modules",".next","dist","build",".git","out",".vercel","coverage"]);
function walkSchemaFiles(root: string, acc: Map<string, string> = new Map(), max = 3000): Map<string, string> {
  if (acc.size > max) return acc;
  let ents: ReturnType<typeof readdirSync> = [];
  try { ents = readdirSync(root, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    if (acc.size > max) break;
    const full = join(root, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walkSchemaFiles(full, acc, max); }
    else if (e.isFile()) {
      const rel = relative(process.cwd(), full);
      if (/(?:^|\\/)supabase\\/migrations\\/[^/]+\\.sql$/.test(rel) ||
          /(?:^|\\/)(?:database|db)\\.types\\.ts$/.test(rel) ||
          /(?:^|\\/)types\\/database\\.ts$/.test(rel) ||
          /(?:^|\\/)types\\/supabase\\.ts$/.test(rel)) {
        try { acc.set(rel, readFileSync(full, "utf8")); } catch { /* ignore */ }
      }
    }
  }
  return acc;
}

function declaredColumnsForTable(table: string, schemaFiles: Map<string, string>): Set<string> {
  const cols = new Set<string>();
  for (const [, content] of schemaFiles) {
    // SQL CREATE TABLE
    const cleaned = content.replace(/\\/\\*[\\s\\S]*?\\*\\//g, "").replace(/--.*$/gm, "");
    const createRe = new RegExp("CREATE\\\\s+TABLE\\\\s+(?:IF\\\\s+NOT\\\\s+EXISTS\\\\s+)?(?:public\\\\.|\\"public\\"\\\\.)?[\\"\`]?" + table.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&") + "[\\"\`]?\\\\s*\\\\(([\\\\s\\\\S]*?)\\\\)\\\\s*;", "i");
    const m = createRe.exec(cleaned);
    if (m) {
      const body = m[1];
      let depth = 0; let start = 0;
      const parts: string[] = [];
      for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (c === "(" || c === "[") depth += 1;
        else if (c === ")" || c === "]") depth -= 1;
        else if (c === "," && depth === 0) { parts.push(body.slice(start, i)); start = i + 1; }
      }
      parts.push(body.slice(start));
      for (const p of parts) {
        const t = p.trim();
        if (/^(?:PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\\b/i.test(t)) continue;
        const cm = /^["\`]?(\\w+)["\`]?\\s/.exec(t);
        if (cm) cols.add(cm[1]);
      }
    }
    // ALTER TABLE ADD COLUMN
    const alterRe = new RegExp("ALTER\\\\s+TABLE\\\\s+(?:public\\\\.|\\"public\\"\\\\.)?[\\"\`]?" + table.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&") + "[\\"\`]?\\\\s+ADD\\\\s+(?:COLUMN\\\\s+)?(?:IF\\\\s+NOT\\\\s+EXISTS\\\\s+)?[\\"\`]?(\\\\w+)[\\"\`]?", "gi");
    let am: RegExpExecArray | null;
    while ((am = alterRe.exec(cleaned)) !== null) cols.add(am[1]);
    // database.types.ts — search for the table's Row block.
    const tableRe = new RegExp("\\\\b" + table.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&") + "\\\\s*:\\\\s*\\\\{[\\\\s\\\\S]*?Row\\\\s*:\\\\s*\\\\{([\\\\s\\\\S]*?)\\\\}", "");
    const tm = tableRe.exec(content);
    if (tm) {
      for (const km of tm[1].matchAll(/(?:^|\\n)\\s*(\\w+)\\s*[:?]/g)) cols.add(km[1]);
    }
  }
  return cols;
}

describe("supabase-column: table \\"" + TABLE + "\\" has all referenced columns", () => {
  let schemaFiles: Map<string, string> | null = null;
  function getSchema() {
    if (schemaFiles === null) schemaFiles = walkSchemaFiles(process.cwd());
    return schemaFiles;
  }

  it("schema source exists", () => {
    const m = getSchema();
    const failMsg = "No schema source found at pin-runtime. At pin-creation: " + SCHEMA_SOURCES_AT_PIN.join(", ") + ". If deleted, retire: pinned retire ${claimId} --reason=\\"...\\"";
    expect(m.size > 0, failMsg).toBe(true);
  });

  for (const col of REFERENCED_COLUMNS) {
    it("column \\"" + col + "\\" still declared", () => {
      const decl = declaredColumnsForTable(TABLE, getSchema());
      const failMsg = "Column \\"" + col + "\\" on table \\"" + TABLE + "\\" is referenced by code but NOT declared in schema. Available columns: " + Array.from(decl).sort().join(", ") + ". If column was renamed/dropped, update consumer code, then retire: pinned retire ${claimId} --reason=\\"...\\"";
      expect(decl.has(col), failMsg).toBe(true);
    });
  }
});
`;
  return { filename, content, claimId };
}
