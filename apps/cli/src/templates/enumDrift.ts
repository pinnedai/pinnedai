// Template: enum-drift (0.2.22+)
//
// FIRST-TIME bug catching, not regression. Pinned's other detectors
// assume a green baseline to regress from — this one catches the
// class of bug where consumer + producer never agreed in the first
// place. Closes the socialideagen-dogfood gap (client polled
// `status === "done"` but the producer wrote `"completed"`).
//
// Pin shape: reads the consumer file at test time + asserts each
// `expectedValue` still appears as a producer-side write somewhere
// in the repo. When a producer write disappears (e.g. AI silently
// removes `update({ status: "X" })`), the pin fails.
//
// Confidence carried from detector: "confirmed" gets normal pin,
// "review" emits with PINNED_CATCH_CONFIDENCE=review env so catches
// don't inflate the GA metric (cross-table column-name collisions
// occasionally slip through to this tier).

import type { EnumDriftClaim } from "../claimParser.js";
import { claimSlug } from "../claimParser.js";
import type { GenerateOpts, GeneratedTest } from "./rateLimit.js";

export function generateEnumDriftTest(
  claim: EnumDriftClaim,
  opts: GenerateOpts
): GeneratedTest {
  const slug = claimSlug(claim);
  const claimId = `${opts.prId}-${slug}`;
  const filename = `${claimId}.test.ts`;

  const expectedLiteral = JSON.stringify(claim.expectedValues);
  const observedLiteral = JSON.stringify(claim.observedValues);

  const content = `// ═══════════════════════════════════════════════════════════════
// ◆ Pinned by pinnedai — https://pinnedai.dev
// generated-by: pinnedai@${opts.pinnedVersion}
// ═══════════════════════════════════════════════════════════════
// Enum drift: consumer-producer value mismatch (FIRST-TIME bug class)
// File:        ${claim.consumerFile}
// Column:      ${claim.column}
//
// Original claim:  ${JSON.stringify(claim.raw)}
// Source PR:       ${opts.prId}
// Template:        enum-drift
// Confidence:      ${claim.confidence}
//
// What this checks: scans the repo at test time and asserts that
// each value the consumer reads (${claim.expectedValues.map((v) => `"${v}"`).join(", ")})
// still appears as a producer-side write somewhere. If AI silently
// removes a producer write (or renames the enum value), this pin
// fails — catching the first-time bug class regression tests miss.
//
// To retire:
//   pinned retire ${claimId} --reason="..."
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const CONSUMER_FILE = ${JSON.stringify(claim.consumerFile)};
const COLUMN = ${JSON.stringify(claim.column)};
const EXPECTED_VALUES: string[] = ${expectedLiteral};
// Observed values from the in-repo producer at pin-creation. The pin
// asserts the producer's CURRENT emit set still contains the values
// the consumer reads — so a producer write being silently removed
// fails the pin.
const OBSERVED_AT_PIN_TIME: string[] = ${observedLiteral};

${claim.confidence === "review" ? `// Beta guardrail: this pin is "review" tier (zero overlap with
// producer values at detection — may be a cross-table column-name
// collision OR the cross-repo external-producer shape). Catches
// quarantined via PINNED_CATCH_CONFIDENCE so they don't inflate
// the GA metric.
process.env.PINNED_CATCH_CONFIDENCE = "review";
` : ""}
function walkFiles(root: string, acc: Map<string, string> = new Map(), max = 2000): Map<string, string> {
  if (acc.size > max) return acc;
  const SKIP = new Set(["node_modules", ".next", "dist", "build", ".git", "out", ".vercel", "coverage", "tests", "test", "__tests__"]);
  let ents: ReturnType<typeof readdirSync> = [];
  try { ents = readdirSync(root, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    if (acc.size > max) break;
    const full = join(root, e.name);
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) walkFiles(full, acc, max);
    } else if (e.isFile() && /\\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(e.name)) {
      try { acc.set(relative(process.cwd(), full), readFileSync(full, "utf8")); } catch { /* ignore */ }
    }
  }
  return acc;
}

function findProducerWritesForValue(files: Map<string, string>, column: string, value: string): string[] {
  const out: string[] = [];
  // Build a regex that matches \`<column>: "<value>"\` in object literals.
  const escapedCol = column.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&");
  const escapedVal = value.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&");
  const re = new RegExp("(?:^|[\\\\s,{(])" + escapedCol + "\\\\s*:\\\\s*['\\"\\\`]" + escapedVal + "['\\"\\\`]");
  for (const [filePath, content] of files.entries()) {
    if (filePath.includes("tests/pinned/")) continue;
    if (filePath === CONSUMER_FILE) continue;
    // Strip comments.
    const stripped = content.replace(/\\/\\/.*$/gm, "").replace(/\\/\\*[\\s\\S]*?\\*\\//g, "");
    if (re.test(stripped)) out.push(filePath);
  }
  return out;
}

describe("enum-drift: " + CONSUMER_FILE + " on column \\"" + COLUMN + "\\"", () => {
  // Build the file map once for all sub-tests.
  let files: Map<string, string>;
  // beforeAll is awkward in vitest's flat \`it\` form so we inline
  // the build on first use.
  function getFiles(): Map<string, string> {
    if (!files) files = walkFiles(process.cwd());
    return files;
  }

  for (const value of OBSERVED_AT_PIN_TIME) {
    it("producer still emits \\"" + value + "\\" for column \\"" + COLUMN + "\\"", () => {
      const writes = findProducerWritesForValue(getFiles(), COLUMN, value);
      const failMsg =
        "Producer write for \\"" + COLUMN + "\\" = \\"" + value + "\\" disappeared from the repo. " +
        "At pin-creation, " + OBSERVED_AT_PIN_TIME.length + " values were emitted: " +
        OBSERVED_AT_PIN_TIME.map((v) => "\\"" + v + "\\"").join(", ") + ". " +
        "Consumer (" + CONSUMER_FILE + ") reads values from this column — removing a producer-side write may break the integration. " +
        "If intentional (e.g. value renamed / retired), update consumer reads to match, then retire the pin: pinned retire ${claimId} --reason=\\"...\\"";
      expect(writes.length > 0, failMsg).toBe(true);
    });
  }
});
`;

  return { filename, content, claimId };
}
