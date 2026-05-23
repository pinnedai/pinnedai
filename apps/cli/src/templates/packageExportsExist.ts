// Template: package-exports-exist
//
// Dynamic-imports a module file (typically the package's `main` /
// `exports` entry) and asserts each named export is defined. Catches
// accidental rename / delete / relocate of public-API symbols.
//
// Deliberately does NOT call the function or assert return values:
//   - that's what library-returns is for
//   - cheap export-existence is the highest-confidence test we can
//     do without user-supplied expected values
//
// Path normalization: the modulePath is rewritten to drop the .ts /
// .tsx extension at vitest run time. Vite/vitest resolves the
// extension automatically, but a literal "/foo.ts" import in
// emitted JS would fail under most TypeScript build pipelines.

import type { PackageExportsClaim } from "../claimParser.js";
import { claimSlug } from "../claimParser.js";

export type GenerateOpts = {
  prId: string;
};

export type GeneratedTest = {
  filename: string;
  content: string;
  claimId: string;
};

export function generatePackageExportsExistTest(
  claim: PackageExportsClaim,
  opts: GenerateOpts
): GeneratedTest {
  const slug = claimSlug(claim);
  const claimId = `${opts.prId}-${slug}`;
  const filename = `${claimId}.test.ts`;

  // Strip a leading "./" and the .ts/.tsx/.js/.jsx extension for the
  // dynamic-import path. The customer's vitest config will resolve
  // the extension at run time.
  const importPath = claim.modulePath
    .replace(/^\.\//, "")
    .replace(/\.(ts|tsx|js|jsx)$/, "");

  const content = `// ═══════════════════════════════════════════════════════════════
// ◆ Pinned by pinnedai — https://pinnedai.dev
// ═══════════════════════════════════════════════════════════════
// Original PR claim: ${JSON.stringify(claim.raw)}
// Source PR:         ${opts.prId}
// Template:          package-exports-exist
// Permanent:         this test fails if the claim is ever regressed.
//
// Retire when an export intentionally moves / is renamed:
//   pinned retire ${claimId} --reason="..."
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { resolve } from "node:path";

const MODULE_PATH = ${JSON.stringify(claim.modulePath)};
const IMPORT_PATH = ${JSON.stringify(importPath)};
const REQUIRED_EXPORTS = ${JSON.stringify(claim.exports)};
const ORIGINAL_PR = ${JSON.stringify(opts.prId)};
const ORIGINAL_CLAIM = ${JSON.stringify(claim.raw)};
const TEST_FILENAME = ${JSON.stringify(filename)};

function repairPrompt(reason: string): string {
  return [
    "",
    "═══ PINNED FAILURE — paste this into Claude Code / Cursor ═══",
    "",
    "Package-exports pin failed:",
    "  Claim: " + ORIGINAL_CLAIM,
    "  Original PR: " + ORIGINAL_PR,
    "  Module: " + MODULE_PATH,
    "  Required exports: " + REQUIRED_EXPORTS.join(", "),
    "  Failure: " + reason,
    "",
    "Why this matters: at least one named export from this module was",
    "renamed, deleted, or relocated. Downstream consumers of the package",
    "will break — type errors, undefined-is-not-a-function at runtime,",
    "or silent behavior changes if a partial export survives.",
    "",
    "Two paths to resolve:",
    "  (a) If the rename was UNINTENTIONAL: restore the export name in",
    "      " + MODULE_PATH + ".",
    "  (b) If the rename was INTENTIONAL (breaking-change release):",
    "      ask the user to retire the pin so a fresh export-set is",
    "      captured under the new names:",
    "      pinned retire " + ${JSON.stringify(claimId)} + " --reason=\\"export rename: ...\\"",
    "",
    "Do not modify this pinned test file.",
    "",
    "After resolving, re-run:  npx vitest run tests/pinned/" + TEST_FILENAME,
    "═══════════════════════════════════════════════════════════════",
    "",
  ].join("\\n");
}

describe("pinned: package-exports-exist " + MODULE_PATH, () => {
  it("module continues to export all " + REQUIRED_EXPORTS.length + " required symbols", async () => {
    const abs = resolve(process.cwd(), IMPORT_PATH);
    let mod: Record<string, unknown>;
    try {
      mod = (await import(abs)) as Record<string, unknown>;
    } catch (e) {
      throw new Error(
        repairPrompt("could not import " + IMPORT_PATH + ": " + (e as Error).message)
      );
    }
    const missing: string[] = [];
    for (const name of REQUIRED_EXPORTS) {
      if (typeof mod[name] === "undefined") {
        missing.push(name);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        repairPrompt(
          "missing export(s): " + missing.join(", ") +
          ". Present exports: " + Object.keys(mod).slice(0, 20).join(", ") +
          (Object.keys(mod).length > 20 ? " (and " + (Object.keys(mod).length - 20) + " more)" : "")
        )
      );
    }
    expect(missing).toEqual([]);
  });
});
`;

  return { filename, content, claimId };
}
