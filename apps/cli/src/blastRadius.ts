// Blast-radius computation for cross-feature smoke triggers.
//
// Per task #154 + the build plan's "Blast-radius / cross-feature
// smoke" spec: on an edit, identify which smoke pins exercise
// importers/dependents of the changed files, so PostToolUse can
// re-run THOSE pins (not just the one being built).
//
// "Edited authHelper → re-smoked 4 dependents, signup went red."
//
// MVP: dependency walker traverses import statements from the
// CHANGED file outward (each file that imports the changed file,
// recursively, up to a max depth). Cross-references the resulting
// file set against the smoke-pin registry (each Tier 1 smoke pin
// declares which file/route it exercises) to produce the list of
// affected pins.
//
// Hard rule (zero network): pure filesystem traversal.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";

export type DependencyGraph = {
  // file → set of files that IMPORT this file (reverse edges; what
  // we actually need for blast-radius).
  importers: Map<string, Set<string>>;
};

const CODE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".turbo",
  "out", "coverage", ".pinned", ".cache",
]);

// Match `import ... from "X"`, `from "X"`, `require("X")`, dynamic
// `import("X")`, AND side-effect-only `import "X"`. We're permissive
// — we'd rather over-include than miss.
const IMPORT_REGEX = /(?:from|require\s*\(|import\s*\(|import\s+)\s*["']([^"']+)["']/g;

function isCodeFile(name: string): boolean {
  return CODE_EXTENSIONS.some((ext) => name.endsWith(ext));
}

function walkDir(root: string, found: string[], maxFiles = 5000): void {
  if (found.length >= maxFiles) return;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true, encoding: "utf8" });
  } catch { return; }
  for (const e of entries) {
    if (found.length >= maxFiles) return;
    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name)) continue;
      walkDir(join(root, e.name), found, maxFiles);
    } else if (e.isFile() && isCodeFile(e.name)) {
      found.push(join(root, e.name));
    }
  }
}

// Resolve a relative import specifier to an actual file path in the
// repo. Conservative — only tries common extensions + index files.
// Returns null when the specifier is a bare module name (node_modules).
function resolveImport(fromAbsFile: string, spec: string, repoRoot: string): string | null {
  if (!spec.startsWith(".") && !spec.startsWith("/") && !spec.startsWith("~")) {
    return null; // bare package import — not in repo
  }
  const baseDir = dirname(fromAbsFile);
  let candidate: string;
  if (spec.startsWith("/")) candidate = join(repoRoot, spec);
  else if (spec.startsWith("~")) candidate = join(repoRoot, spec.slice(1));
  else candidate = resolve(baseDir, spec);

  // Strip trailing .js / .ts to attempt extension matching.
  const stripped = candidate.replace(/\.(?:[mc]?[jt]sx?|cjs|mjs)$/, "");

  const tries = [
    candidate,
    ...CODE_EXTENSIONS.map((ext) => stripped + ext),
    ...CODE_EXTENSIONS.map((ext) => join(stripped, "index" + ext)),
  ];
  for (const t of tries) {
    if (existsSync(t)) return t;
  }
  return null;
}

export function buildDependencyGraph(repoRoot: string, opts: { maxFiles?: number } = {}): DependencyGraph {
  const maxFiles = opts.maxFiles ?? 5000;
  const files: string[] = [];
  walkDir(repoRoot, files, maxFiles);
  const importers = new Map<string, Set<string>>();
  for (const file of files) {
    let content: string;
    try { content = readFileSync(file, "utf8"); } catch { continue; }
    IMPORT_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMPORT_REGEX.exec(content)) !== null) {
      const target = resolveImport(file, m[1], repoRoot);
      if (!target) continue;
      const relTarget = relative(repoRoot, target);
      if (!importers.has(relTarget)) importers.set(relTarget, new Set());
      importers.get(relTarget)!.add(relative(repoRoot, file));
    }
  }
  return { importers };
}

// Walk the importers transitively from each changed file up to
// `maxDepth` hops. Returns the union of every file that depends on
// the changed set (directly or transitively).
export function affectedFiles(
  graph: DependencyGraph,
  changedFiles: string[],
  opts: { maxDepth?: number } = {}
): Set<string> {
  const maxDepth = opts.maxDepth ?? 4;
  const out = new Set<string>(changedFiles);
  let frontier = new Set<string>(changedFiles);
  for (let d = 0; d < maxDepth; d++) {
    const next = new Set<string>();
    for (const f of frontier) {
      const direct = graph.importers.get(f);
      if (!direct) continue;
      for (const importer of direct) {
        if (!out.has(importer)) {
          out.add(importer);
          next.add(importer);
        }
      }
    }
    if (next.size === 0) break;
    frontier = next;
  }
  return out;
}

// Cross-reference: which smoke claim IDs touch which file? Computed
// at sweep/pin-emit time. The shape mirrors the existing registry but
// only tracks the (claimId, filePath) edges relevant to blast-radius.
export type SmokePinIndex = {
  version: 1;
  // claimId → file paths the smoke pin's entrypoint reaches.
  byClaim: Record<string, string[]>;
  // Inverse — file → claimIds that exercise it.
  byFile: Record<string, string[]>;
};

export function emptyIndex(): SmokePinIndex {
  return { version: 1, byClaim: {}, byFile: {} };
}

// Given a smoke claim, extract the file paths it conceptually touches.
// http-route: no file (the route is a runtime address, not a static
// file we can name from the claim alone). fn: the modulePath. cli:
// the command bin (best-effort skipped — usually not a repo file).
// job: same as http for http-submit, fn for fn-submit.
export function filesForSmokeClaim(claim: {
  template: string;
  route: string;
  entrypoint?: any;
}): string[] {
  if (claim.template !== "smoke-functional") return [];
  const ep = claim.entrypoint;
  if (!ep) return [];
  if (ep.kind === "fn") return [ep.modulePath];
  if (ep.kind === "job" && ep.submit?.kind === "fn" && typeof ep.submit.ref === "string") {
    // job.submit.ref shape: "module#export"
    const [modulePath] = String(ep.submit.ref).split("#");
    return modulePath ? [modulePath] : [];
  }
  return [];
}

export function buildSmokePinIndex(claims: Array<{ claimId: string; claim: any }>): SmokePinIndex {
  const idx = emptyIndex();
  for (const { claimId, claim } of claims) {
    const files = filesForSmokeClaim(claim);
    if (files.length === 0) continue;
    idx.byClaim[claimId] = files;
    for (const f of files) {
      if (!idx.byFile[f]) idx.byFile[f] = [];
      if (!idx.byFile[f].includes(claimId)) idx.byFile[f].push(claimId);
    }
  }
  return idx;
}

// Final API: given changed files + the smoke-pin index, return the
// list of smoke claim IDs to re-run.
export function affectedSmokePins(
  index: SmokePinIndex,
  changedFiles: string[],
  graph: DependencyGraph,
  opts: { maxDepth?: number } = {}
): string[] {
  const blast = affectedFiles(graph, changedFiles, opts);
  const claimIds = new Set<string>();
  for (const f of blast) {
    const pins = index.byFile[f];
    if (pins) for (const id of pins) claimIds.add(id);
  }
  return Array.from(claimIds);
}
