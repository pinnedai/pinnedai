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

// 0.4.3 P0 fix (Cipherwake): TypeScript path-alias support.
// Real Next.js apps use `@/components/Hero` (mapped from
// `tsconfig.json#compilerOptions.paths`). Without parsing tsconfig,
// the graph treats every aliased import as a bare-package import →
// edge never added → editing a component never bubbles up to the
// page → pin never flagged.
//
// We parse tsconfig.json / jsconfig.json with a tolerant JSON-with-
// comments stripper, extract paths, and resolve aliases before the
// "is it relative?" check.
type PathAliases = Array<{
  // Prefix to match (no trailing *). E.g. "@/" from "@/*".
  prefix: string;
  // Suffix to match (no leading *). E.g. "" from "@/*".
  suffix: string;
  // Absolute target prefixes — what to substitute. E.g. ["/abs/repo/"].
  targets: string[];
}>;

function stripJsonComments(s: string): string {
  // Naive but enough for tsconfig.json. Handles // and /* */ comments
  // and trailing commas in objects/arrays. Tolerant — doesn't try to
  // be a real parser.
  return s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,(\s*[}\]])/g, "$1");
}

function loadPathAliases(repoRoot: string): PathAliases {
  const aliases: PathAliases = [];
  for (const fname of ["tsconfig.json", "jsconfig.json", "tsconfig.base.json"]) {
    const p = join(repoRoot, fname);
    if (!existsSync(p)) continue;
    let raw: string;
    try { raw = readFileSync(p, "utf8"); } catch { continue; }
    let parsed: any;
    try { parsed = JSON.parse(stripJsonComments(raw)); } catch { continue; }
    const co = parsed?.compilerOptions ?? {};
    const baseUrlRel = typeof co.baseUrl === "string" ? co.baseUrl : ".";
    const baseUrlAbs = resolve(repoRoot, baseUrlRel);
    const paths = co.paths ?? {};
    if (!paths || typeof paths !== "object") continue;
    for (const [key, valRaw] of Object.entries(paths)) {
      const targetsList = Array.isArray(valRaw) ? valRaw.filter((v): v is string => typeof v === "string") : [];
      if (targetsList.length === 0) continue;
      // Key shape: "@/*" or "@/components/*" or "exact-name".
      const starIdx = key.indexOf("*");
      let prefix: string, suffix: string;
      if (starIdx >= 0) {
        prefix = key.slice(0, starIdx);
        suffix = key.slice(starIdx + 1);
      } else {
        prefix = key;
        suffix = "";
      }
      const targets = targetsList.map((t) => {
        const ti = t.indexOf("*");
        const targetPrefix = ti >= 0 ? t.slice(0, ti) : t;
        return resolve(baseUrlAbs, targetPrefix);
      });
      aliases.push({ prefix, suffix, targets });
    }
  }
  return aliases;
}

// Resolve an import specifier to an actual file path in the repo.
// Handles relative imports AND tsconfig path aliases.
function resolveImport(
  fromAbsFile: string,
  spec: string,
  repoRoot: string,
  aliases: PathAliases
): string | null {
  // Try alias resolution first — applies to non-relative specs.
  for (const a of aliases) {
    if (!spec.startsWith(a.prefix)) continue;
    if (a.suffix && !spec.endsWith(a.suffix)) continue;
    const middle = spec.slice(a.prefix.length, spec.length - a.suffix.length);
    for (const targetPrefix of a.targets) {
      const candidate = join(targetPrefix, middle);
      const resolved = tryExtensions(candidate);
      if (resolved) return resolved;
    }
  }

  // Then fall through to relative / absolute / tilde paths.
  if (!spec.startsWith(".") && !spec.startsWith("/") && !spec.startsWith("~")) {
    return null; // bare package import — not in repo
  }
  const baseDir = dirname(fromAbsFile);
  let candidate: string;
  if (spec.startsWith("/")) candidate = join(repoRoot, spec);
  else if (spec.startsWith("~")) candidate = join(repoRoot, spec.slice(1));
  else candidate = resolve(baseDir, spec);

  return tryExtensions(candidate);
}

function tryExtensions(candidate: string): string | null {
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
  // 0.4.3 P0: resolve tsconfig path aliases so @/components/Hero etc.
  // become real graph edges. Without this, every @-aliased import was
  // dropped → editing a component never bubbled up to the page.
  const aliases = loadPathAliases(repoRoot);
  const importers = new Map<string, Set<string>>();
  for (const file of files) {
    let content: string;
    try { content = readFileSync(file, "utf8"); } catch { continue; }
    IMPORT_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMPORT_REGEX.exec(content)) !== null) {
      const target = resolveImport(file, m[1], repoRoot, aliases);
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

// 0.4.2 (Cipherwake-reported P0): given a route, find the files
// Next.js / Vite-React-Router / SvelteKit / Astro would serve it from.
//
// Walk the route segments and, at each level, accept EITHER an exact-
// name directory OR a dynamic segment directory (`[param]`, `[...slug]`,
// `[[...slug]]`, route groups `(group)`). Then at the leaf, look for
// page.tsx / route.ts / index.tsx / +page.svelte / etc.
//
// Returns paths relative to repoRoot, filtered to ones that EXIST.
// The literal-route case is what makes blast-radius work for smoke
// pins whose entrypoint is `/preview/benchmob` against the dynamic
// page at `app/preview/[slug]/page.tsx`.
export function deriveLikelyPageFilesForRoute(route: string, repoRoot: string): string[] {
  const norm = route.replace(/\?.*$/, "").replace(/#.*$/, "");
  const segments = norm.split("/").filter((s) => s.length > 0);

  // The matchers per framework — each starts from one or more roots
  // and walks segments. We collect candidate file paths and then
  // filter to existing ones.
  const candidates = new Set<string>();

  // Next.js App Router (`app/`) and Pages Router (`pages/`).
  const FILE_LEAVES = {
    appPage: ["page.tsx", "page.ts", "page.jsx", "page.js"],
    appRoute: ["route.ts", "route.js"],
    pagesPage: ["index.tsx", "index.ts", "index.jsx", "index.js"],
    sveltekit: ["+page.svelte", "+server.ts", "+server.js"],
    astro: ["index.astro"],
  };

  // Recursively walk: given a base dir, a list of remaining segments,
  // and a set of leaf filenames, emit existing candidate paths.
  function walkDir(baseAbs: string, baseRel: string, remaining: string[], leaves: string[]): void {
    if (remaining.length === 0) {
      for (const leaf of leaves) {
        const file = join(baseRel, leaf);
        if (existsSync(join(repoRoot, file))) candidates.add(file);
      }
      // Also accept a file at this level named `<segment>.<ext>` for
      // Pages router style (handled below via the `Pages router file`
      // shape).
      return;
    }
    const [seg, ...rest] = remaining;
    // Try exact match.
    const exact = join(baseAbs, seg);
    if (existsSync(exact)) walkDir(exact, join(baseRel, seg), rest, leaves);
    // Try dynamic segment directories: [param], [...slug], [[...slug]].
    let entries: any[] = [];
    try {
      entries = readdirSync(baseAbs, { withFileTypes: true, encoding: "utf8" });
    } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const name = e.name;
      // Match: [slug], [...slug], [[...slug]]
      if (/^\[\[?\.{0,3}[^\]]+\]?\]$/.test(name)) {
        walkDir(join(baseAbs, name), join(baseRel, name), rest, leaves);
      }
      // Next App Router route groups: (group) — transparent, doesn't
      // consume a segment. Walk INTO the group, keep `remaining`.
      if (/^\([^)]+\)$/.test(name)) {
        walkDir(join(baseAbs, name), join(baseRel, name), remaining, leaves);
      }
    }
  }

  // Next.js App Router — primary
  const appRoot = join(repoRoot, "app");
  if (existsSync(appRoot)) {
    walkDir(appRoot, "app", segments, FILE_LEAVES.appPage);
    walkDir(appRoot, "app", segments, FILE_LEAVES.appRoute);
  }
  // Some apps put `app/` under `src/`.
  const srcAppRoot = join(repoRoot, "src", "app");
  if (existsSync(srcAppRoot)) {
    walkDir(srcAppRoot, "src/app", segments, FILE_LEAVES.appPage);
    walkDir(srcAppRoot, "src/app", segments, FILE_LEAVES.appRoute);
  }
  // Next.js Pages Router — also try `pages/<segment>.tsx`
  const pagesRoot = join(repoRoot, "pages");
  if (existsSync(pagesRoot)) {
    walkDir(pagesRoot, "pages", segments, FILE_LEAVES.pagesPage);
    // Plus the file-named variant: pages/preview/[slug].tsx
    if (segments.length > 0) {
      const parent = segments.slice(0, -1);
      const last = segments[segments.length - 1];
      const tryParentDir = (dirAbs: string, dirRel: string) => {
        for (const ext of [".tsx", ".ts", ".jsx", ".js"]) {
          // Exact filename
          const f = join(dirRel, last + ext);
          if (existsSync(join(repoRoot, f))) candidates.add(f);
          // Dynamic filename
          let entries: any[] = [];
          try { entries = readdirSync(dirAbs, { withFileTypes: true, encoding: "utf8" }); } catch { continue; }
          for (const e of entries) {
            if (!e.isFile()) continue;
            if (/^\[\[?\.{0,3}[^\]]+\]?\]\.(?:tsx?|jsx?)$/.test(e.name)) {
              candidates.add(join(dirRel, e.name));
            }
          }
        }
      };
      // Walk into parent of `last`, with dynamic acceptance at each
      // segment of `parent`.
      function walkToParent(baseAbs: string, baseRel: string, remaining: string[]): void {
        if (remaining.length === 0) {
          tryParentDir(baseAbs, baseRel);
          return;
        }
        const [seg, ...rest] = remaining;
        const exact = join(baseAbs, seg);
        if (existsSync(exact)) walkToParent(exact, join(baseRel, seg), rest);
        let entries: any[] = [];
        try { entries = readdirSync(baseAbs, { withFileTypes: true, encoding: "utf8" }); } catch { return; }
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          if (/^\[\[?\.{0,3}[^\]]+\]?\]$/.test(e.name)) {
            walkToParent(join(baseAbs, e.name), join(baseRel, e.name), rest);
          }
        }
      }
      walkToParent(pagesRoot, "pages", parent);
    }
  }
  // SvelteKit (`src/routes/`)
  const skRoot = join(repoRoot, "src", "routes");
  if (existsSync(skRoot)) {
    walkDir(skRoot, "src/routes", segments, FILE_LEAVES.sveltekit);
  }
  // Astro (`src/pages/`)
  const astroRoot = join(repoRoot, "src", "pages");
  if (existsSync(astroRoot)) {
    walkDir(astroRoot, "src/pages", segments, FILE_LEAVES.astro);
  }

  return Array.from(candidates);
}

// Given a smoke claim, extract the file paths it conceptually touches.
// fn: the modulePath. job: the submit module if fn-submit.
// http-route + render-collection + visibility-invariant: derive likely
// page files from the route via deriveLikelyPageFilesForRoute().
export function filesForSmokeClaim(
  claim: { template: string; route?: string; entrypoint?: any; pathTemplate?: string; publicRoute?: string },
  repoRoot: string = process.cwd()
): string[] {
  // Direct-file pin shapes
  if (claim.template === "smoke-functional") {
    const ep = claim.entrypoint;
    if (!ep) return [];
    if (ep.kind === "fn") return [ep.modulePath];
    if (ep.kind === "job" && ep.submit?.kind === "fn" && typeof ep.submit.ref === "string") {
      const [modulePath] = String(ep.submit.ref).split("#");
      const fnFiles = modulePath ? [modulePath] : [];
      // For http-submit jobs, derive page files too.
      if (ep.submit.kind === "http") {
        const routeStr = typeof ep.submit.ref === "string" ? ep.submit.ref : claim.route;
        if (routeStr) return [...fnFiles, ...deriveLikelyPageFilesForRoute(routeStr, repoRoot)];
      }
      return fnFiles;
    }
    if (ep.kind === "http-route" && claim.route) {
      return deriveLikelyPageFilesForRoute(claim.route, repoRoot);
    }
    if (ep.kind === "job" && ep.submit?.kind === "http" && claim.route) {
      return deriveLikelyPageFilesForRoute(claim.route, repoRoot);
    }
    return [];
  }
  // 0.4.0 render-collection: pathTemplate is "/preview/[slug]" — that
  // SAME string is what Next/SvelteKit's filesystem-router uses, so
  // the resolver finds the dynamic page directly.
  if (claim.template === "render-collection" && claim.pathTemplate) {
    return deriveLikelyPageFilesForRoute(claim.pathTemplate, repoRoot);
  }
  // 0.4.0 visibility-invariant: same shape, route is `publicRoute`.
  if (claim.template === "visibility-invariant" && claim.publicRoute) {
    return deriveLikelyPageFilesForRoute(claim.publicRoute, repoRoot);
  }
  return [];
}

export function buildSmokePinIndex(
  claims: Array<{ claimId: string; claim: any }>,
  repoRoot: string = process.cwd()
): SmokePinIndex {
  const idx = emptyIndex();
  for (const { claimId, claim } of claims) {
    const files = filesForSmokeClaim(claim, repoRoot);
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
