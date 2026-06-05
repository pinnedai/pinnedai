// Tier 0 smoke-test convention recognizer + coverage gap reporter.
//
// Per the wedge plan: Tier 0 is the agent-authored ladder rung — the
// AI writes happy / guard / failure tests via the prompt in
// agentRules.ts; Pinned RECOGNIZES them via filename pattern or inline
// markers, tracks coverage per feature, and surfaces the gap report.
//
// Recognition rules:
//   1. Filename pattern: tests/**/*.smoke.test.ts (any subdir).
//   2. Inline marker:    // @pinned-smoke <feature> <case>
//      where <case> ∈ { happy | guard | failure }.
//
// A "feature" is a free-form string declared by the author. Multiple
// markers in the same file = multiple features tracked from one file.
// A test file matching the filename pattern but lacking markers is
// counted as a single feature named after the file (stem-minus-suffix).
//
// Coverage report output: per feature, do we have a happy / guard /
// failure case? The selling output is the gap: "Feature X has happy
// but no failure case" — which is precisely the "AI only tested the
// happy path" failure mode the agent prompt warns against.
//
// Browser-safety contract: this module reads the filesystem (Node-
// only). It's used by `pinned report` and `pinned sweep`, both of
// which are CLI-only — never imported from the landing demo.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export type SmokeCaseKind = "happy" | "guard" | "failure";

export type SmokeMarker = {
  // Free-form feature identifier from `// @pinned-smoke <feature> ...`
  // or (for filename-only matches) the file stem.
  feature: string;
  // Which case the marker declared. For filename-only matches this is
  // `"unknown"` — the file is tracked but we can't tell which of the
  // three cases the author intended without inline markers. The
  // coverage report surfaces this as a "no-case-tag" warning.
  caseKind: SmokeCaseKind | "unknown";
  filePath: string;     // repo-relative
  line: number;         // 1-based
};

export type FeatureCoverage = {
  feature: string;
  hasHappy: boolean;
  hasGuard: boolean;
  hasFailure: boolean;
  // Files that contributed any marker for this feature — used for the
  // "list the test files we know about" output and for `pinned show`.
  files: string[];
  // Marker locations for navigation.
  markers: { caseKind: SmokeCaseKind | "unknown"; filePath: string; line: number }[];
};

// Stable regex — capture the feature (greedy non-whitespace runs) and
// the case kind. Whitespace-tolerant for stylistic variants.
//
//   // @pinned-smoke   image-generation   happy
//   //@pinned-smoke create-user guard
//   /* @pinned-smoke webhook-stripe failure */
//
// The case kind MUST appear; if it doesn't the marker is ignored (we
// surface the unparseable line via a separate scan if needed — not in
// v1 because the agent prompt is explicit about the three-token form).
const MARKER_REGEX =
  /@pinned-smoke\s+([A-Za-z0-9][A-Za-z0-9_\-./:]*)\s+(happy|guard|failure)\b/i;

// Filename pattern. Captures `<stem>.smoke.test.{ts,tsx,js,jsx,mjs}`.
const SMOKE_FILENAME_REGEX = /\.smoke\.test\.(?:[mc]?[jt]sx?|cjs|mjs)$/i;

export type ScanOpts = {
  // Repo-relative roots to walk. Default: ["tests", "src", "apps", "packages"].
  roots?: string[];
  // Ignore these dirname segments anywhere in the path. Default:
  // node_modules, dist, build, .next, .git, .pinned/tmp.
  ignoreDirs?: string[];
  // Cap on files visited per scan to keep sweep fast.
  maxFiles?: number;
};

const DEFAULT_ROOTS = ["tests", "src", "apps", "packages"];
const DEFAULT_IGNORE = new Set([
  "node_modules", "dist", "build", ".next", ".git", ".turbo",
  "out", "coverage", ".pinned",
]);
const TEST_FILE_REGEX = /\.test\.(?:[mc]?[jt]sx?|cjs|mjs)$/i;

function listFilesRec(
  root: string,
  ignore: Set<string>,
  found: string[],
  maxFiles: number
): void {
  if (found.length >= maxFiles) return;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return;
  }
  for (const e of entries) {
    if (found.length >= maxFiles) return;
    if (e.isDirectory()) {
      if (ignore.has(e.name)) continue;
      listFilesRec(join(root, e.name), ignore, found, maxFiles);
    } else if (e.isFile()) {
      // Only consider .test.* files — the marker is meaningful only in
      // executable test files, and rejecting non-test files keeps the
      // scan fast.
      if (TEST_FILE_REGEX.test(e.name)) {
        found.push(join(root, e.name));
      }
    }
  }
}

export function findSmokeMarkers(cwd: string, opts: ScanOpts = {}): SmokeMarker[] {
  const roots = opts.roots ?? DEFAULT_ROOTS;
  const ignore = new Set([...DEFAULT_IGNORE, ...(opts.ignoreDirs ?? [])]);
  const maxFiles = opts.maxFiles ?? 5000;
  const markers: SmokeMarker[] = [];

  const visited = new Set<string>();
  const files: string[] = [];
  for (const root of roots) {
    const abs = join(cwd, root);
    try {
      const s = statSync(abs);
      if (!s.isDirectory()) continue;
    } catch {
      continue;
    }
    if (visited.has(abs)) continue;
    visited.add(abs);
    listFilesRec(abs, ignore, files, maxFiles);
  }

  for (const absFile of files) {
    const rel = relative(cwd, absFile);
    let content: string;
    try {
      content = readFileSync(absFile, "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    const filenameMatch = SMOKE_FILENAME_REGEX.test(absFile.split(sep).pop() ?? "");

    let foundInlineMarker = false;
    for (let i = 0; i < lines.length; i++) {
      const m = MARKER_REGEX.exec(lines[i]);
      if (m) {
        foundInlineMarker = true;
        markers.push({
          feature: m[1],
          caseKind: m[2].toLowerCase() as SmokeCaseKind,
          filePath: rel,
          line: i + 1,
        });
      }
    }

    // Filename-only match (no inline markers in the file): track as
    // one feature using the stem. The case kind is "unknown" so the
    // coverage gap report can prompt the author to add markers.
    if (filenameMatch && !foundInlineMarker) {
      const stem = (absFile.split(sep).pop() ?? "").replace(SMOKE_FILENAME_REGEX, "");
      markers.push({
        feature: stem || rel,
        caseKind: "unknown",
        filePath: rel,
        line: 1,
      });
    }
  }
  return markers;
}

export function rollupCoverage(markers: SmokeMarker[]): FeatureCoverage[] {
  const byFeature = new Map<string, FeatureCoverage>();
  for (const m of markers) {
    let cov = byFeature.get(m.feature);
    if (!cov) {
      cov = {
        feature: m.feature,
        hasHappy: false,
        hasGuard: false,
        hasFailure: false,
        files: [],
        markers: [],
      };
      byFeature.set(m.feature, cov);
    }
    if (m.caseKind === "happy") cov.hasHappy = true;
    if (m.caseKind === "guard") cov.hasGuard = true;
    if (m.caseKind === "failure") cov.hasFailure = true;
    if (!cov.files.includes(m.filePath)) cov.files.push(m.filePath);
    cov.markers.push({ caseKind: m.caseKind, filePath: m.filePath, line: m.line });
  }
  // Stable order: features with the most gaps first (worst coverage
  // at the top, since gaps are the selling output).
  const arr = Array.from(byFeature.values());
  arr.sort((a, b) => {
    const ga = Number(!a.hasHappy) + Number(!a.hasGuard) + Number(!a.hasFailure);
    const gb = Number(!b.hasHappy) + Number(!b.hasGuard) + Number(!b.hasFailure);
    if (ga !== gb) return gb - ga;
    return a.feature.localeCompare(b.feature);
  });
  return arr;
}

export type CoverageGap = {
  feature: string;
  missing: SmokeCaseKind[];
  files: string[];
};

export function findCoverageGaps(coverage: FeatureCoverage[]): CoverageGap[] {
  const gaps: CoverageGap[] = [];
  for (const c of coverage) {
    const missing: SmokeCaseKind[] = [];
    if (!c.hasHappy) missing.push("happy");
    if (!c.hasGuard) missing.push("guard");
    if (!c.hasFailure) missing.push("failure");
    if (missing.length > 0) {
      gaps.push({ feature: c.feature, missing, files: c.files });
    }
  }
  return gaps;
}
