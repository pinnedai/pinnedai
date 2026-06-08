// Cipherwake Feature 4 — Self-verifying CLI commands.
//
// The recurring meta-bug (four times across 0.4.x): a command prints
// ✓ / "done" without doing the work. Each time it shipped because
// the acceptance check looked at the command's stdout, not at the
// disk state afterwards. This file is the discipline catalog:
//
//   - It lists every state-mutating command Pinned exposes.
//   - For each entry, it asserts an E2E test file exists.
//   - Each E2E test file is grep-asserted to contain a real
//     filesystem / JSON-state assertion (not just a stdout match).
//
// Adding a new state-mutating command WITHOUT a matching E2E entry
// is now a build failure. Editing the E2E to remove its real-state
// assertion is also detected.
//
// Why a catalog test rather than a lint/AST rule:
//   - The set of state-mutating commands is small and changes slowly
//     (~15 entries). A hand-curated list keeps the discipline visible
//     and reviewable in a single file.
//   - An AST-level "every commander.action() with a write effect must
//     have a probe" is hard to make precise without false positives.
//     The catalog is what we'd write anyway as a checklist; this
//     just enforces it.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Each entry: a command (or command-action pair) that mutates state
// in the user's repo or in global config. For each, name the E2E
// test file that proves the post-state.
type CatalogEntry = {
  command: string;
  // The expected behavior the E2E must cover. Free-text so the
  // diagnostic is informative when something's missing.
  effect: string;
  // The E2E test file under src/ that should cover it.
  e2eTestFile: string;
  // Regex(es) the e2eTestFile MUST contain — these prove the test
  // asserts on real state, not on stdout. At least one must match.
  stateAssertionPatterns: RegExp[];
};

const CATALOG: CatalogEntry[] = [
  {
    command: "pinned init --auto",
    effect: "creates .github/workflows/pinned.yml, tests/pinned/, .pinnedai/, wires hooks",
    e2eTestFile: "cli.integration.test.ts",
    stateAssertionPatterns: [/existsSync\([^)]*pinned/i, /readFileSync\([^)]*\.yml/i],
  },
  {
    command: "pinned uninstall --yes",
    effect: "removes .github/workflows/pinned.yml, .pinnedai/, .pinned/, settings.json hooks",
    e2eTestFile: "uninstall.e2e.test.ts",
    stateAssertionPatterns: [
      /expect\(existsSync\([^)]*\)\)\.toBe\(false\)/,
      /readFileSync\([^)]*settings\.json/,
    ],
  },
  {
    command: "pinned hook-postedit",
    effect: "edit-event → blast-radius → vitest exec against affected pins",
    e2eTestFile: "hookPostedit.realedit.test.ts",
    stateAssertionPatterns: [
      /buildDependencyGraph\(/,
      /affectedSmokePins\(/,
      /execFileSync\(/,
    ],
  },
  {
    command: "pinned hook-postedit (early shape — kept for regression coverage)",
    effect: "wiring-level coverage (preceded the realedit version)",
    e2eTestFile: "hookPostedit.e2e.test.ts",
    stateAssertionPatterns: [/execFileSync\(/, /CLI/],
  },
  {
    command: "pinned render add --browser",
    effect: "writes tests/pinned/<id>-browser.test.ts that runs Playwright against routes",
    e2eTestFile: "renderCollectionBrowser.e2e.test.ts",
    stateAssertionPatterns: [
      /spawnAsync\(.*vitest/i,
      /broken images/i,
    ],
  },
];

// Detector-only invariants — these aren't state mutators of the
// user's repo, but they ARE behavior contracts whose E2E should
// exist. Kept separate to make the failure messages clearer.
type DetectorEntry = {
  detector: string;
  e2eTestFile: string;
  stateAssertionPatterns: RegExp[];
};

const DETECTORS: DetectorEntry[] = [
  {
    detector: "blastRadius — path aliases + dynamic routes",
    e2eTestFile: "blastRadius.dynamic-route.test.ts",
    stateAssertionPatterns: [/deriveLikelyPageFilesForRoute/],
  },
  {
    detector: "detectVisibilityDiscriminant (Cipherwake Feature 3)",
    e2eTestFile: "visibilityDiscriminantDetect.test.ts",
    stateAssertionPatterns: [/detectVisibilityDiscriminant/, /toHaveLength\(/],
  },
];

const SRC_DIR = join(process.cwd(), "src");

function loadTestFile(name: string): string | null {
  const p = join(SRC_DIR, name);
  if (!existsSync(p)) return null;
  try { return readFileSync(p, "utf8"); } catch { return null; }
}

describe("[Feature 4] state-mutating commands have state-asserting E2Es", () => {
  for (const entry of CATALOG) {
    it(`'${entry.command}' has ${entry.e2eTestFile} that asserts on real post-state`, () => {
      const src = loadTestFile(entry.e2eTestFile);
      expect(src, `expected ${entry.e2eTestFile} to exist for "${entry.command}" — adds-without-tests must be caught here`).not.toBeNull();
      const matched = entry.stateAssertionPatterns.some((re) => re.test(src!));
      expect(
        matched,
        `${entry.e2eTestFile} should contain at least one real-state assertion ` +
        `matching one of: ${entry.stateAssertionPatterns.map((p) => p.source).join(" | ")}. ` +
        `Effect under test: ${entry.effect}. Don't assert on stdout — assert on disk / JSON state.`
      ).toBe(true);
    });
  }
});

describe("[Feature 4] high-value detectors have behavior-asserting tests", () => {
  for (const entry of DETECTORS) {
    it(`'${entry.detector}' has ${entry.e2eTestFile}`, () => {
      const src = loadTestFile(entry.e2eTestFile);
      expect(src, `expected ${entry.e2eTestFile} to exist for "${entry.detector}"`).not.toBeNull();
      const matched = entry.stateAssertionPatterns.some((re) => re.test(src!));
      expect(matched, `${entry.e2eTestFile} should reference: ${entry.stateAssertionPatterns.map((p) => p.source).join(" | ")}`).toBe(true);
    });
  }
});

// 0.5.0-beta: catch the inverse pattern too — every *.e2e.test.ts
// file in src/ must appear in the catalog. New e2e files added
// without a catalog entry slip through this guard otherwise.
describe("[Feature 4] catalog is in sync with disk", () => {
  it("every *.e2e.test.ts file in src/ is registered in the catalog", () => {
    const allE2eFiles = readdirSync(SRC_DIR)
      .filter((f) => /\.e2e\.test\.ts$/.test(f));
    const registered = new Set([
      ...CATALOG.map((c) => c.e2eTestFile),
      ...DETECTORS.map((d) => d.e2eTestFile),
    ]);
    const orphans = allE2eFiles.filter((f) => !registered.has(f));
    expect(
      orphans,
      `These E2E files exist but aren't registered in CATALOG/DETECTORS: ${orphans.join(", ")}. ` +
      `Register them so the discipline catalog stays comprehensive.`
    ).toEqual([]);
  });
});
