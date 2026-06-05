// scanDiff — the "No proof found" detector.
//
// Pure function: takes a list of changed files + the claims already
// in the PR body + the claims already pinned in the repo, and returns
// suggestions for pins the user *probably* should add.
//
// Why: this is the daily-loop habit trigger — feature ranked #3 in
// our stickiness analysis. The psychological hook is loss aversion:
// "this PR touches auth-sensitive code but has no pin." Most devs,
// shown that, will add a pin to clear the warning. Once the habit
// forms, every AI-coded PR ships with at least one durable artifact.
//
// Architecturally: pure detection, no fs/git operations. The CLI
// wrapper does the git plumbing; this module is testable in isolation.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, basename } from "node:path";
import type { Claim } from "./claimParser.js";
import { claimRoute } from "./claimParser.js";
// claimKey is intentionally not imported — see isAlreadyCovered notes
// for why we use template+route equality instead of full keys here.
import type { RegistryEntry, PinCoverage } from "./registry.js";
import { escapeMarkdownCell, coverageFromClaim } from "./registry.js";

// Escape a string for safe use inside a Markdown code span (`...`).
// Replaces backticks (which could escape the code span) and strips
// control characters. This is more defensive than escapeMarkdownCell
// because it targets inline code rather than table cells.
function escapeInlineCode(s: string): string {
  return s.replace(/`/g, "ʹ").replace(/[\r\n\x00-\x1f]+/g, " ");
}

export type ChangedFile = {
  path: string;
  status: "added" | "modified" | "deleted";
  // For "modified" files, the body of the unified diff's "+" lines
  // (newly added content only, with leading + stripped). When present,
  // pattern-matching classifiers should scan this rather than the
  // full file content — so we don't re-detect every existing pattern
  // on every commit. May be undefined when the caller didn't compute
  // diff content (e.g. legacy callers, scan-without-diff tools).
  addedLines?: string;
};

export type Suggestion = {
  reason: string;
  files: string[];
  template:
    | "auth-required"
    | "rate-limit"
    | "idempotent"
    | "env-required"
    | "cli-exits-zero"
    | "library-returns"
    | "returns-status"
    | "page-renders"
    | "validation-rejects-bad"
    | "happy-path-with-side-effect";
  route?: string;
  suggestedPin: string;
};

export type Coverage = {
  file: string;
  pins: RegistryEntry[];
};

// Inverse of Coverage — keyed by pin instead of by file. Drives the
// "◆ pinned · REVIEW · N protected behavior touched" statusline state
// and the touched-pins block in scan-diff output. A pin is "touched"
// when the current diff edits a file whose path either:
//   (a) maps to a route this pin's claim guards (Next.js / Express /
//       webhook paths → derived URL), OR
//   (b) appears in this pin's covers.files (library-returns pins
//       reference their own modulePath; future generator annotations
//       will populate this for CLI templates).
// Pins with empty coverage (CLI-output / exits-zero / flag-supported)
// never surface as "touched" — they're not skipped, just silent in
// this signal. Pre-v0.1 pins without a `covers` field get coverage
// derived on the fly via coverageFromClaim() for backward compat.
export type TouchedPin = {
  pin: RegistryEntry;
  // How this pin matched: route-based, file-based, or both. The kind
  // lets the renderer pick the right phrasing ("route /api/X edited"
  // vs "src/config.ts edited").
  matchedRoutes: { route: string; files: string[] }[];
  matchedFiles: string[];
};

export type ScanInput = {
  changedFiles: ChangedFile[];
  prBodyClaims: Claim[];
  existingPins: RegistryEntry[];
};

export type ScanResult = {
  suggestions: Suggestion[];
  coverage: Coverage[];
  touchedPins: TouchedPin[];
};

type RiskRule = {
  id: string;
  match: (f: ChangedFile) => boolean;
  build: (f: ChangedFile) => Omit<Suggestion, "files"> | null;
};

// Single source of truth for "is this a test file". Every detection
// rule consults this so a path-substring match (e.g. /webhook/i) can't
// accidentally pull in a test fixture. Without this exclusion, a file
// like tests/integration/stripe-webhook.spec.ts gets classified as a
// real webhook handler and emits a junk pin asserting an endpoint
// that doesn't exist (caught during quantasyte dogfood).
//
// Routes that exist to AUTHENTICATE users (login, signup, OAuth
// callbacks, NextAuth catch-all). Asserting `auth-required` on these
// is wrong — they're the auth endpoint ITSELF, which is necessarily
// public. Surfaced via the shadcn-ui/taxonomy OSS sweep.
//
// Routes that are conventionally PUBLIC by design — auth-required
// pins on these are FALSE POSITIVES because the endpoint MUST be
// reachable without session auth to function. Surfaced via the 50-OSS
// sweep: OG image endpoints, health checks, on-demand-revalidate,
// share links, telemetry, robots/sitemap, cron endpoints, webhook
// receivers (those get the `idempotent` template instead).
//
// Exported for the audit.
export function isLikelyPublicEndpoint(path: string): boolean {
  const lower = path.toLowerCase();
  // OG image endpoints — used by social-media scrapers, must be public
  if (/\/api\/og(?:\/|\.|$)/i.test(lower)) return true;
  if (/(?:^|\/)og\/route\.(?:ts|tsx|js|jsx)$/i.test(lower)) return true;
  // Health checks
  if (/\/api\/(?:health|healthz|heartbeat|ping|status|liveness|readiness)(?:\/|\.|$)/i.test(lower)) return true;
  // Next.js on-demand revalidation — token-based, not session
  if (/\/api\/revalidate(?:\/|\.|$)/i.test(lower)) return true;
  // Telemetry / analytics ingestion endpoints — public by design.
  // Use broad match (anywhere after /api/) so nested paths like
  // /api/scripts/telemetry and /api/websites/[id]/metrics are caught.
  if (/\/api\/(?:.*\/)?(?:telemetry|collect|track|ingest|metrics)(?:\/|\.|$)/i.test(lower)) return true;
  // Robots / sitemap
  if (/\/api\/(?:.*\/)?(?:robots|sitemap)(?:\/|\.|$)/i.test(lower)) return true;
  // Cron / scheduled — uses a secret query param or header, not session
  if (/\/api\/(?:.*\/)?(?:cron|__cron|scheduled)(?:\/|\.|$)/i.test(lower)) return true;
  if (/\/api\/jobs?\/run(?:\/|\.|$)/i.test(lower)) return true;
  // Public-share endpoints — the share-link IS the auth. Broad match
  // so nested paths like /api/boards/[id]/shares/route.ts are caught.
  if (/\/api\/(?:.*\/)?(?:share|shared|shares|public)(?:\/|\.|$)/i.test(lower)) return true;
  // Webhook endpoints — these belong to the idempotent template, not
  // auth-required. The webhook-handler rule fires separately for them.
  if (/\/api\/webhooks?(?:\/|\.|$)/i.test(lower)) return true;
  // Token-bearing public endpoints — the URL token IS the auth, not
  // a session header. Examples: email-confirm, magic-link, password-
  // reset, invite-accept, unsubscribe. These would false-fire as
  // "auth required" but actually accept anonymous requests with a
  // signed token in path/body. Discovered on socialideagen 2026-06-02
  // (/api/confirm was auto-pinned as auth-required incorrectly).
  if (/\/api\/(?:.*\/)?(?:confirm|verify|unsubscribe|opt-out|opt-in|invite-accept|magic-link|reset-password|forgot-password)(?:\/|\.|$)/i.test(lower)) return true;
  return false;
}

// Exported for the audit.
export function isAuthEndpoint(path: string): boolean {
  const lower = path.toLowerCase();
  // NextAuth catch-all: app/api/auth/[...nextauth]/route.ts OR
  // pages/api/auth/[...nextauth].ts
  if (/\/api\/auth\/\[\.\.\.nextauth\]/i.test(lower)) return true;
  // Generic /api/auth/* family (NextAuth, Auth.js, Lucia, custom)
  if (/\/api\/auth\//i.test(lower)) return true;
  // Common auth-endpoint conventions in synthesized routes
  if (/\/api\/(?:login|logout|signin|signout|signup|register|callback|oauth|forgot[-_]?password|reset[-_]?password|verify[-_]?email|magic[-_]?link)(?:\/|\.|$)/i.test(lower)) {
    return true;
  }
  // Express-style routes/<name>.ts where <name> is an auth verb. The
  // route synthesizer at line ~190 turns `src/routes/signup.ts` into
  // /api/signup; checking the file path directly catches it BEFORE
  // synthesis.
  if (/(?:^|\/)routes\/(?:login|logout|signin|signout|signup|register|callback|oauth|forgot[-_]?password|reset[-_]?password|verify[-_]?email|magic[-_]?link)\.(?:ts|tsx|js|jsx)$/i.test(lower)) {
    return true;
  }
  // App router auth-endpoint convention: app/<verb>/route.ts
  if (/(?:^|\/)(?:app|pages)\/(?:login|logout|signin|signout|signup|register|forgot[-_]?password|reset[-_]?password)\/route\.(?:ts|tsx|js|jsx)$/i.test(lower)) {
    return true;
  }
  return false;
}

// Exported so the audit corpus can verify the exclusion list directly.
export function isTestPath(path: string): boolean {
  const lower = path.toLowerCase();
  // Test directory anywhere in the path
  if (/(?:^|\/)(?:tests?|__tests?__|spec|specs|e2e|cypress|playwright)\//i.test(lower)) {
    return true;
  }
  // Test/spec file extension
  if (/\.(?:spec|test|e2e)\.(?:ts|tsx|js|jsx|mjs|cjs)$/i.test(lower)) {
    return true;
  }
  // Storybook / MDX stories
  if (/\.stories\.(?:ts|tsx|js|jsx|mdx)$/i.test(lower)) {
    return true;
  }
  return false;
}

// Reject paths that are vendored / generated / lockfile-included.
// Discovered via the myhpifinal smoke run on 2026-05-25 where the new
// detectors produced 53 "catches" on `node_modules/.pnpm/.../CHANGELOG.md`,
// `.d.ts` files, etc. — all coming from a dep bump. Pure FP class.
//
// Use this helper at the top of every diff-mode detector to keep
// vendored content out of the pin set entirely.
export function isVendoredPath(path: string): boolean {
  return /(?:^|\/)(?:node_modules|dist|build|out|coverage|\.next|\.turbo|\.vercel|\.netlify|\.cache|\.parcel-cache|\.svelte-kit|\.nuxt|public\/build|public\/dist|generated|__generated__)\//i.test(path);
}

// Detect CLI / library pins from package.json. These pins run AGAINST
// THE FILESYSTEM AT THE CURRENT COMMIT — they don't need PREVIEW_URL,
// don't need a deploy, don't need network. Highest day-zero leverage
// for users without preview infrastructure.
//
// Heuristic, conservative:
//   - Every `bin` entry → cli-exits-zero pin asserting the binary
//     exits 0 on `--help`. Safe assumption: any CLI with a --help
//     flag (which almost every Commander-based CLI does) returns 0.
//   - Every exported NAMED function from the `main` entry → no
//     auto-pin (we can't safely infer the expected return). Surface
//     as a candidate the user can pin manually via `pinned protect`.
//
// Reads package.json directly (not via the path-based RULES table)
// because the signal is content, not changed-file shape. Callers in
// monorepo roots can pass workspaceRoot for the entry point and we'll
// recurse into apps/* / packages/* to find their package.json files
// too. Capped at WORKSPACE_FANOUT_LIMIT to keep startup fast.
// Detect lockfile-integrity pins from the working tree. Returns one
// pin per lockfile present at repoRoot — typically zero or one (a
// repo rarely has more than one PM's lockfile). The pin captures the
// SHA-256 of the lockfile at this moment; future runs that find a
// different hash fail. Surfaced at baseline-on-init time.
export type LockfilePin = {
  template: "lockfile-integrity";
  lockfilePath: string;
  expectedSha256: string;
  // SHA-256 of package.json at pin time, used by the template's
  // gating logic to suppress noise from intentional dep updates
  // (where package.json also changed). Undefined when the repo
  // has no package.json — falls back to strict hash equality.
  packageJsonSha256?: string;
  suggestedPin: string; // not used directly — lockfile pins don't go
                        // through the claim parser, but kept for shape
                        // parity with CliLibraryPin
};

export function detectLockfilePins(repoPath: string): LockfilePin[] {
  const candidates = [
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lockb",
  ];
  const pkgJsonPath = join(repoPath, "package.json");
  const packageJsonSha256 = existsSync(pkgJsonPath)
    ? createHash("sha256").update(readFileSync(pkgJsonPath)).digest("hex")
    : undefined;
  const found: LockfilePin[] = [];
  for (const name of candidates) {
    const full = join(repoPath, name);
    if (!existsSync(full)) continue;
    const data = readFileSync(full);
    const sha256 = createHash("sha256").update(data).digest("hex");
    found.push({
      template: "lockfile-integrity",
      lockfilePath: name,
      expectedSha256: sha256,
      packageJsonSha256,
      suggestedPin: `lockfile ${name} sha256 ${sha256.slice(0, 12)}`,
    });
  }
  return found;
}

// Auto-detect returns-status pins. Scans route handler files for
// validation-library calls (Zod, Yup, Joi, custom). Each detected
// validation surface emits a "POST <route> returns 400 on bad body"
// pin candidate. Catches AI agents that "simplify" validation —
// GPT-flagged as one of the highest-value non-HTTP-fixture catches.
//
// Conservative match patterns (real false-positive risk if too greedy):
//   - `z.object(...).parse(...)`        Zod sync parse
//   - `z.object(...).parseAsync(...)`   Zod async parse
//   - `await schema.parse(`             Zod-style on a named schema
//   - `.safeParse(`                     Zod safeParse (with manual 400 path)
//   - `yup.object(`                     Yup schema definition
//
// The pin will only run if PREVIEW_URL is set (or local-dev-mode
// kicks in). At install time, day-zero verify reports "not verified"
// when no URL is configured.
export type ReturnsStatusPin = {
  template: "returns-status";
  route: string;
  method: "POST" | "PUT" | "PATCH";
  status: number;
  suggestedPin: string;
};

const VALIDATION_PATTERNS = [
  /\bz\.object\s*\(/,                          // Zod object schema
  /\.parseAsync\s*\(/,                          // Zod async parse
  /\.safeParse(?:Async)?\s*\(/,                 // Zod safeParse
  /\byup\.object\s*\(/,                         // Yup
  /\b(?:from\s+|import\s+).*['"]joi['"]/,       // Joi import
  /\bvalidate\s*\([^)]*req\.body/,              // generic validate(req.body, ...)
  /\bschema\.parse\s*\(/,                        // named schema.parse()
];

// Plain-TS validation pattern: explicit 400 response paired with a
// req.body access in the same file. Catches Fastify/Hono/native apps
// that validate inline without a schema library (the most common
// shape in real codebases — Quantasyte uses it across every
// controller). Conjunction guards against FPs:
//   - `reply.code(400)` alone could be state-related ("can't do X in
//      state Y"); pairing with `req.body` proves it's input-driven.
//   - matching one without the other would generate pins whose test
//     ("POST /route returns 400 on missing body") would falsely fail
//     in production.
function hasPlainTsBodyValidation(content: string): boolean {
  const hasFourHundred = /\b(?:reply|res)\.(?:code|status)\s*\(\s*400\b/.test(content);
  if (!hasFourHundred) return false;
  const hasBodyRead = /\breq(?:uest)?\.body\b/.test(content);
  return hasBodyRead;
}

export function detectReturnsStatusPins(repoPath: string): ReturnsStatusPin[] {
  const out: ReturnsStatusPin[] = [];
  // Walk route-shaped files. We use the SAME route detection regex
  // as next-app-route-added / express-routes-added etc., but only
  // examine the FILE CONTENT — we're looking for validation calls
  // INSIDE the handler.
  const candidates = walkRepoFiles(repoPath, {
    extensions: [".ts", ".tsx", ".js"],
    maxFiles: 500,
  });
  const seen = new Set<string>();
  for (const relPath of candidates) {
    // Only files that look like route handlers
    if (
      !/(?:^|\/)(?:src\/)?app\/api\/.+\/route\.(?:ts|tsx|js|jsx)$/.test(relPath) &&
      !/(?:^|\/)(?:src\/)?pages\/api\/.+\.(?:ts|tsx|js|jsx)$/.test(relPath) &&
      !/(?:^|\/)(?:src\/)?routes\/.+\.(?:ts|tsx|js|jsx)$/.test(relPath)
    ) {
      continue;
    }
    if (isTestPath(relPath)) continue;
    // NB: do NOT skip isAuthEndpoint / isLikelyPublicEndpoint here.
    // The auth-required template excludes those because asserting
    // "401 without auth" on /api/signup is wrong. But for
    // returns-status, input validation is EXACTLY what we want to
    // protect on signup/login/forgot-password — those are the routes
    // that validate user-provided email / password / reset tokens.
    let content: string;
    try {
      content = readFileSync(join(repoPath, relPath), "utf8");
    } catch {
      continue;
    }
    // Skip GET-only routes — validation is for write methods.
    const hasWriteMethod =
      /\b(POST|PUT|PATCH)\b/.test(content) ||
      /\bexport\s+(?:async\s+)?function\s+(?:POST|PUT|PATCH)\b/.test(content) ||
      /router\.(?:post|put|patch)\(/i.test(content);
    if (!hasWriteMethod) continue;

    // Pass A — inline validation (the original logic). Catches Next.js
    // route.ts files and any handler that does validation directly.
    if ((VALIDATION_PATTERNS.some((re) => re.test(content)) || hasPlainTsBodyValidation(content))) {
      const route = deriveRouteFromPath(relPath);
      if (route) {
        const method = pickMethodFromContent(content);
        const key = `${method}:${route}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({
            template: "returns-status",
            route,
            method,
            status: 400,
            suggestedPin: `${method} ${route} returns 400 on missing body.`,
          });
        }
      }
    }

    // Pass B — router→controller resolution. Catches Express MVC,
    // NestJS, and quantasyte's shape: the route file does
    // `router.post('/users', userCtrl.create)` and the validation
    // lives in a separate `controllers/users.ts`. Without this, those
    // shapes silently emit zero pins even though the validation is
    // clearly there (one file away). See ROADMAP "Pre-launch product
    // pivot" — promoted from v0.2 because it gates several of the 15
    // positive-control fixtures.
    const routerCalls = parseRouterCalls(content);
    if (routerCalls.length === 0) continue;
    const imports = parseImportMap(content);
    const routePrefix = deriveRoutePrefixFromPath(relPath);
    for (const call of routerCalls) {
      const handlerFile = resolveHandlerToFile(repoPath, relPath, imports, call.handlerExpr);
      if (!handlerFile) continue;
      let handlerContent: string;
      try {
        handlerContent = readFileSync(join(repoPath, handlerFile), "utf8");
      } catch {
        continue;
      }
      if (!(VALIDATION_PATTERNS.some((re) => re.test(handlerContent)) || hasPlainTsBodyValidation(handlerContent))) continue;

      const route = joinRoute(routePrefix, call.routePath);
      const key = `${call.method}:${route}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        template: "returns-status",
        route,
        method: call.method,
        status: 400,
        suggestedPin: `${call.method} ${route} returns 400 on missing body.`,
      });
    }
  }
  return out;
}

// Pick the strongest write method present in a handler file. Mirrors
// the original logic; extracted so both passes (inline and router→
// controller) use the same rule.
function pickMethodFromContent(content: string): "POST" | "PUT" | "PATCH" {
  if (/\bPOST\b|router\.post/i.test(content)) return "POST";
  if (/\bPATCH\b|router\.patch/i.test(content)) return "PATCH";
  return "PUT";
}

// Parse `router.METHOD('/path', ...handlers)` calls out of a router-
// shaped file. Handles Express + Hono + Fastify shorthand:
//   router.post('/users', userCtrl.create)
//   app.post('/users', requireAuth, userCtrl.create)
//   route.post('/', wrap(create))
// We capture the LAST argument as the handler — middleware chains
// put the actual handler last by convention.
type RouterCall = {
  method: "POST" | "PUT" | "PATCH";
  routePath: string;
  handlerExpr: string;
};

function parseRouterCalls(content: string): RouterCall[] {
  const out: RouterCall[] = [];
  // (router|app|route).post('/path', ...args)
  // Captures the path string and the full args tail; the handler is
  // parsed out as the last non-empty top-level argument.
  const re = /\b(?:router|app|route)\.(post|put|patch)\s*\(\s*['"`]([^'"`]+)['"`]\s*(?:,\s*([\s\S]*?))?\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const method = m[1].toUpperCase() as "POST" | "PUT" | "PATCH";
    const routePath = m[2];
    const argsTail = (m[3] ?? "").trim();
    const handlerExpr = lastTopLevelArg(argsTail);
    if (!handlerExpr) continue;
    out.push({ method, routePath, handlerExpr });
  }
  return out;
}

// Extract the last top-level argument from a comma-separated args
// list, ignoring commas inside nested calls / arrays / objects /
// generics. Handles e.g. `requireAuth, ratelimit({limit: 60}), create`.
function lastTopLevelArg(s: string): string | null {
  let depth = 0;
  let lastCut = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(" || c === "[" || c === "{" || c === "<") depth += 1;
    else if (c === ")" || c === "]" || c === "}" || c === ">") depth -= 1;
    else if (c === "," && depth === 0) lastCut = i + 1;
  }
  const last = s.slice(lastCut).trim();
  if (!last) return null;
  // Unwrap one layer of wrap()/asyncHandler()/catchErrors() etc — a
  // common Express convention. We do exactly one unwrap; deeper
  // nesting is rare and not worth the FP risk.
  const wrap = /^[a-zA-Z_$][\w$]*\s*\(\s*([\s\S]+?)\s*\)\s*$/.exec(last);
  if (wrap) return wrap[1].trim();
  return last;
}

// Parse import statements into a map of localName → relative path.
// Supports:
//   import { create, update } from './controllers/users'
//   import * as userCtrl from './controllers/users'
//   import userCtrl from './controllers/users'
//   const userCtrl = require('./controllers/users')
type ImportMap = Map<string, string>;

function parseImportMap(content: string): ImportMap {
  const map: ImportMap = new Map();
  // ES named: import { a, b as c } from "..."
  for (const m of content.matchAll(/import\s*\{\s*([^}]+)\s*\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const names = m[1].split(",").map((s) => s.trim()).filter(Boolean);
    for (const raw of names) {
      const asM = /^([a-zA-Z_$][\w$]*)\s+as\s+([a-zA-Z_$][\w$]*)$/.exec(raw);
      if (asM) map.set(asM[2], m[2]);
      else if (/^[a-zA-Z_$][\w$]*$/.test(raw)) map.set(raw, m[2]);
    }
  }
  // ES default: import name from "..."
  for (const m of content.matchAll(/import\s+([a-zA-Z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/g)) {
    map.set(m[1], m[2]);
  }
  // ES namespace: import * as name from "..."
  for (const m of content.matchAll(/import\s+\*\s+as\s+([a-zA-Z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/g)) {
    map.set(m[1], m[2]);
  }
  // CJS: const name = require("...")
  for (const m of content.matchAll(/(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    map.set(m[1], m[2]);
  }
  // CJS named destructure: const { a, b } = require("...")
  for (const m of content.matchAll(/(?:const|let|var)\s*\{\s*([^}]+)\s*\}\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    for (const raw of m[1].split(",").map((s) => s.trim()).filter(Boolean)) {
      const asM = /^([a-zA-Z_$][\w$]*)\s*:\s*([a-zA-Z_$][\w$]*)$/.exec(raw);
      if (asM) map.set(asM[2], m[2]);
      else if (/^[a-zA-Z_$][\w$]*$/.test(raw)) map.set(raw, m[2]);
    }
  }
  return map;
}

// Resolve a handler expression (`create` or `userCtrl.create`) to a
// repo-relative file path. Walks the import map, then resolves the
// relative import against the router file's directory. Adds the
// common TS/JS extensions and `/index.ts` form. Returns null if we
// can't find a file on disk — FP defense.
function resolveHandlerToFile(
  repoPath: string,
  routerRelPath: string,
  imports: ImportMap,
  handlerExpr: string
): string | null {
  // `ns.method` form — resolve via the namespace's import
  const dotM = /^([a-zA-Z_$][\w$]*)\./.exec(handlerExpr);
  const localName = dotM ? dotM[1] : handlerExpr.split(/[^a-zA-Z0-9_$]/)[0];
  if (!localName) return null;
  const importPath = imports.get(localName);
  if (!importPath) return null;
  // Only resolve relative imports — bare specifiers like 'express'
  // are framework imports, not controller code.
  if (!importPath.startsWith(".") && !importPath.startsWith("/")) return null;

  const routerDir = routerRelPath.includes("/")
    ? routerRelPath.slice(0, routerRelPath.lastIndexOf("/"))
    : "";
  // Strip a TS-to-ESM trailing extension before resolving. The
  // common modern pattern is `import { x } from "./foo.js"` whose
  // source is actually `./foo.ts` — without this strip the resolver
  // tries `foo.js.ts` and fails on every Fastify/NestJS/ESM-TS
  // monorepo. Real bug hit while wiring quantasyte.
  const stripped = importPath.replace(/\.(?:js|mjs|cjs)$/, "");
  const baseRel = joinRelPath(routerDir, stripped);
  for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]) {
    if (existsSync(join(repoPath, baseRel + ext))) return baseRel + ext;
  }
  for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
    const idx = `${baseRel}/index${ext}`;
    if (existsSync(join(repoPath, idx))) return idx;
  }
  return null;
}

// Simple POSIX-style relpath join that resolves "../" segments.
// Avoids node:path's `resolve` because that needs an absolute base;
// we want repo-relative output.
function joinRelPath(dir: string, importPath: string): string {
  const segs = (dir ? dir.split("/") : []).concat(importPath.split("/"));
  const out: string[] = [];
  for (const s of segs) {
    if (s === "" || s === ".") continue;
    if (s === "..") { out.pop(); continue; }
    out.push(s);
  }
  return out.join("/");
}

// Best-effort route prefix from a router file's path. Examples:
//   apps/api/src/routes/users.ts        → /users
//   src/routes/admin/billing.ts         → /admin/billing
//   apps/api/src/app/api/users/route.ts → /api/users
// Returns "" when we can't infer one; callers concat the per-call
// path arg as-is. The true prefix often depends on the main app file
// (`app.use('/api/v1', router)`) which we don't follow — a small
// loss of route precision the static template tolerates because it
// runs against captured file paths, not live HTTP.
function deriveRoutePrefixFromPath(relPath: string): string {
  const next = /(?:^|\/)(?:src\/)?app\/api\/(.+)\/route\.(?:ts|tsx|js|jsx)$/.exec(relPath);
  if (next) return "/api/" + next[1];
  const pages = /(?:^|\/)(?:src\/)?pages\/api\/(.+)\.(?:ts|tsx|js|jsx)$/.exec(relPath);
  if (pages) return "/api/" + pages[1];
  const generic = /(?:^|\/)(?:src\/)?routes\/(.+)\.(?:ts|tsx|js|jsx)$/.exec(relPath);
  if (generic) {
    const trimmed = generic[1].replace(/\/index$/, "").replace(/\.(?:ts|tsx|js|jsx)$/, "");
    return "/" + trimmed;
  }
  return "";
}

// Join a prefix and an inner path, normalizing slashes. Empty prefix
// is allowed (returns the inner path as-is).
function joinRoute(prefix: string, inner: string): string {
  const p = prefix.replace(/\/+$/, "");
  const i = inner.startsWith("/") ? inner : "/" + inner;
  if (!p) return i;
  // If router file path encodes the resource and the per-call path
  // is just "/", drop the redundant slash (common Express pattern:
  // `routes/users.ts` + `router.post('/')` should mean /users, not
  // /users/).
  if (i === "/") return p;
  // If the inner path already starts with the prefix, don't duplicate
  // it. Fastify convention: `routes/projects.ts` typically registers
  // via `app.register(projectRoutes)` (no mount prefix) and writes
  // the FULL path inside (`app.post("/projects", ...)`). Without this
  // check we generate routes like `/projects/projects`. Heuristic
  // safety net — we can't read the main app file without much more
  // work, so we trust the inner path when it already self-prefixes.
  if (i === p || i.startsWith(p + "/")) return i;
  return p + i;
}

// ────────────────────────────────────────────────────────────
// Diff-aware auth-required detection
// ────────────────────────────────────────────────────────────
//
// Looks at lines ADDED in a commit and detects whether the change
// introduced an auth check to a route handler. When it does, we
// generate an `auth-required` pin for that route — capturing the
// added signature so the pin can run in static mode (no server
// needed) for replay benchmarks AND continue to run in live mode
// (PREVIEW_URL) for production protection.
//
// Why this matters: the standard auto-detectors only look at the
// current state of the repo. They emit the same generic pin
// regardless of what the fix actually fixed. Diff-aware detection
// produces pins that ENCODE the fix — and therefore catch the
// regression they prevent when replayed against the parent commit.
//
// The pattern set is intentionally exported so a future lateral-
// propagation detector ("find OTHER routes without this signature")
// can reuse it. Same source of truth, no drift.
export const AUTH_CHECK_PATTERNS: RegExp[] = [
  // Framework helpers that authenticate the caller. The match must
  // be at a word boundary to avoid false positives on identifiers
  // like `requireAuthor()` or `getSessionId`.
  /\b(?:requireAuth|requireSession|requireUser|requireAdmin|requireLogin|requireRole|requireToken)\s*\(/,
  /\b(?:getServerSession|getServerAuthSession|getServerUser|getToken|getSession|getAuth|getUser)\s*\(/,
  /\b(?:withAuth|withSession|withUser|withAuthRequired)\s*[\(<]/,
  /\b(?:auth\(\)\.protect|auth\(\)\.userId)\b/, // Clerk's auth().protect() / auth().userId
  /\bclerkMiddleware\s*\(/,
  /\bcurrentUser\s*\(/, // Clerk currentUser()
  // Custom app-specific auth helpers — these are the names devs
  // actually use in real codebases (and that the canonical patterns
  // above miss). Pattern is intentionally bounded by a recognized
  // English-suffix alternation so identifiers like `authConfig` or
  // `authError` don't false-fire. The suffix set covers the most
  // common shapes:
  //   Headers/Header/Token  — credential helpers (authHeaders, authToken)
  //   Required/Check/Guard  — gating helpers (authRequired, authGuard)
  //   enticated             — past-tense of authenticate
  //   ed                    — past-participle (ensureAuthed, markAuthed)
  //   orize/orized          — authorize/authorized
  //   User                  — getAuthUser, authUser
  // Discovered via Quantasyte (`authHeaders()`) and the custom-helper
  // positive-control fixture (`ensureAuthed()`) — both would have
  // silently missed without this widened set.
  /\b\w*[Aa]uth(?:Headers?|Token|Required|Check|Guard|enticated|ed|oriz(?:e|ed)|User)\s*\(/,
  // Header inspection — explicit reads of the Authorization header
  /\b(?:req|request)\??\.headers\s*[\.\[]\s*['"]?authorization/i,
  /\bheaders\s*\(\s*\)\s*\.get\s*\(\s*['"]authorization/i,
  /\bheaders\.get\s*\(\s*['"]authorization/i,
  // Bearer literal — strong signal of token-based auth handling
  /['"]Bearer\s+/,
  // Supabase
  /\bsupabase\s*\.\s*auth\s*\.\s*getUser\s*\(/,
  /\bsupabase\s*\.\s*auth\s*\.\s*getSession\s*\(/,
  // Passport / NextAuth / Auth.js
  /\bpassport\.authenticate\s*\(/,
  // Middleware-style path gating — matching admin/account/internal
  // subtrees with startsWith or equality. Covers Next.js, Vercel
  // Edge Runtime, Vite-on-Vercel (Quantasyte's shape: eadffa6 +
  // 1c4c2df both did this kind of fix). The path identifier can be
  // url.pathname, nextUrl.pathname, a destructured `path` local, or
  // a plain pathname variable.
  //
  // 0.2.11+: tagged WEAK in detectAuthChecksInDiff via WEAK_AUTH_PATTERNS
  // below. A `pathname.startsWith("/admin")` alone doesn't prove the
  // middleware GATES on it — it might just be allow-listing the path
  // through (socialideagen's middleware.ts shape: routing, not auth).
  // The detector now requires a co-occurring CONFIRMER (401/403/redirect-
  // to-login/session-read) in the same file before treating these as
  // auth signals.
  /\b(?:path|pathname|url\.pathname|nextUrl\.pathname|request\.nextUrl\.pathname)\.startsWith\s*\(\s*['"]\/(?:admin|account|api\/admin|api\/account|dashboard|internal)/i,
  /\b(?:path|pathname|url\.pathname|nextUrl\.pathname)\s*===?\s*['"]\/(?:admin|account|api\/admin|api\/account|dashboard|internal)/i,
  // Common explicit pattern: throwing on missing token / session
  /\bif\s*\(\s*!\s*(?:token|session|user|auth|userId|sessionId)\s*\)\s*[\{\(].*?(?:throw|return|res\.status\s*\(\s*40[13])/,
];

// Subset of AUTH_CHECK_PATTERNS that, when matched ALONE, doesn't
// prove the file does auth gating — only routing. Used by
// detectAuthChecksInDiff to require a CONFIRMER pattern in the same
// file before emitting an auth-required hit. Hard-learned via
// socialideagen 2026-06-02: middleware.ts did `pathname.startsWith
// ("/admin")` to allow-list /admin through (return NextResponse.next),
// NOT to gate it. Pre-0.2.11 we emitted an auth-required pin for it;
// the pin then false-failed on every legitimate middleware refactor.
const WEAK_AUTH_PATTERNS: RegExp[] = [
  /\b(?:path|pathname|url\.pathname|nextUrl\.pathname|request\.nextUrl\.pathname)\.startsWith\s*\(\s*['"]\/(?:admin|account|api\/admin|api\/account|dashboard|internal)/i,
  /\b(?:path|pathname|url\.pathname|nextUrl\.pathname)\s*===?\s*['"]\/(?:admin|account|api\/admin|api\/account|dashboard|internal)/i,
];

// Confirmer signals — when a WEAK match also has one of these in the
// same file, the path-startsWith is gating (real auth), not routing.
// Order: real status returns / redirects / session reads / not-found
// throws / explicit 4xx response shapes.
const AUTH_CONFIRMER_PATTERNS: RegExp[] = [
  // status 401 / 403 returns (covers NextResponse, plain Response,
  // express res.status, fastify reply.code, hono c.status).
  /\b(?:status|code)\s*\(\s*40[13]\b/,
  /\bnew\s+Response\s*\([^)]*?,\s*\{[^}]*?status\s*:\s*40[13]\b/,
  /\bNextResponse\.json\s*\([^)]+?,\s*\{[^}]*?status\s*:\s*40[13]\b/,
  /\bResponse\.json\s*\([^)]+?,\s*\{[^}]*?status\s*:\s*40[13]\b/,
  // Throwing unauth/forbidden errors (express middleware idiom).
  /\bthrow\s+new\s+\w*?(?:Unauthorized|Forbidden|UnauthenticatedError)\b/i,
  // Redirect to login / signin / auth path — common gate pattern.
  /\b(?:redirect|NextResponse\.redirect)\s*\(\s*[`'"][^`'"]*?\/(?:login|signin|sign-in|auth\b)/i,
  // Session / cookie / token reads inside the same file — strong
  // evidence the path check is paired with credential validation.
  /\b(?:cookies|getServerSession|getSession|getUser|getToken|currentUser)\s*\(/,
  /\bheaders\s*\(\s*\)\s*\.\s*get\s*\(\s*['"](?:authorization|cookie)\b/i,
  /\b(?:req|request)\s*\.\s*headers\s*[\[\.]?\s*['"]?(?:authorization|cookie)\b/i,
  // Explicit "if (!token/session/user) → return/throw" — the strong
  // pattern in AUTH_CHECK_PATTERNS (already included there but kept
  // here for completeness as a confirmer).
  /\bif\s*\(\s*!\s*(?:token|session|user|auth|userId|sessionId)\b/,
];

export type DiffByFile = Map<string, string[]>;

// Pure detector. Caller computes "lines added per file in this
// commit" (via git show / git diff with --unified=0 and a parser)
// and passes it in. We avoid touching child_process here so this
// module stays test-pure and browser-safe.
export type DiffAuthCheckHit = {
  template: "auth-required";
  route: string;
  filePath: string;
  // The exact matched substring from the added lines — used as the
  // signature for static-mode verification at replay time. We don't
  // store the whole line because comments and whitespace drift; the
  // matched substring is the load-bearing part.
  signature: string;
  suggestedPin: string;
};

// ────────────────────────────────────────────────────────────
// Client-side fetch-correctness detection
// ────────────────────────────────────────────────────────────
//
// Mirror of detectAuthChecksInDiff for client-side files. The wedge:
// AI agents regularly forget to attach Authorization headers /
// credentials / CSRF tokens / HTTPS protocols when refactoring a
// client-side fetch wrapper. The fix adds the missing piece; we
// capture that addition as a permanent static-signature guard so
// future edits that strip it back out fail the pin.
//
// Symmetric to the server-side detector: same shape, same template
// (auth-required), same static-mode replay. Differs only in:
//   - File-shape filter: include client-side dirs (apps/app, src/lib,
//     src/api, src/client) and files matching `*[Cc]lient.{ts,tsx,js}`
//   - Patterns target fetch-call-site correctness signatures, not
//     route-handler middleware
//
// Out of scope (per memory [[pinned-client-side-scope-expansion]]):
// generic crawler / visual / a11y / E2E. This detector only fires
// when a CORRECTNESS PATTERN was added in the diff — same loop as
// every other diff-aware detector.
export const CLIENT_FETCH_AUTH_PATTERNS: RegExp[] = [
  // Authorization header attachment (explicit)
  /\bheaders\s*:\s*\{[^}]*[Aa]uthorization\b/,
  /['"]Authorization['"]\s*:\s*(?:`|'|")\s*Bearer/,
  // Custom helper that returns auth-shaped headers — `authHeaders()`,
  // `await getAuthHeaders()`, `withAuth(...)`, etc. Same suffix-bounded
  // pattern set as the server-side AUTH_CHECK_PATTERNS so we stay
  // symmetric across both surfaces. Discovered specifically via
  // Quantasyte's 75a9491 fix (`headers: await authHeaders()`).
  /\b\w*[Aa]uth(?:Headers?|Token|Required|Check|Guard|enticated|ed|oriz(?:e|ed)|User)\s*\(/,
  // credentials: 'include' / 'same-origin' — required for cookie-auth
  /\bcredentials\s*:\s*['"](?:include|same-origin)['"]/,
  // CSRF token attachment
  /['"](?:X-CSRF-Token|X-XSRF-Token|csrf-token)['"]\s*:/i,
  /\bgetCsrfToken\s*\(/i,
  // OAuth / session token from a getter
  /\bget(?:Access|Session|Bearer|Id)Token\s*\(/,
  // Force HTTPS — a "use https not http" fix
  /\b(?:https:\/\/|new URL\(`?https:|forceHttps|requireHttps)\b/,
];

export type DiffClientFetchHit = {
  template: "auth-required";
  // Synthetic "route" name for display — derived from file path
  // since client files don't expose an HTTP route directly. Format:
  // `client:<rel-path-without-ext>`. Recognizable in pin output.
  route: string;
  filePath: string;
  signature: string;
  suggestedPin: string;
};

// True when the file looks like a client-side API/fetch wrapper —
// path under apps/app/, src/lib/, src/api/, src/client/, OR matches
// the `*[Cc]lient.{ts,tsx,js}` naming convention. We DON'T include
// React component files (`components/**`) because those are the
// "polished UI" territory we deliberately stay out of per
// [[pinned-client-side-scope-expansion]].
function isClientFetchFile(path: string): boolean {
  // Reject route-handler shapes outright — those go through
  // detectAuthChecksInDiff, not this detector.
  if (
    /(?:^|\/)(?:src\/)?(?:app\/api\/.+\/route|pages\/api\/.+|routes\/.+)\.(?:ts|tsx|js|jsx)$/.test(path) ||
    /(?:^|\/)(?:src\/)?middleware\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(path)
  ) {
    return false;
  }
  if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(path)) return false;
  if (isTestPath(path)) return false;
  // Common client-API directories
  if (/(?:^|\/)apps\/app\//.test(path)) return true;
  if (/(?:^|\/)apps\/web\/src\//.test(path)) return true;
  if (/(?:^|\/)src\/(?:lib|api|client|services|net|http)\//.test(path)) return true;
  // Client-named files
  if (/[Cc]lient\.(?:ts|tsx|js|jsx)$/.test(path)) return true;
  if (/[Ff]etcher\.(?:ts|tsx|js|jsx)$/.test(path)) return true;
  if (/[Aa]pi\.(?:ts|tsx|js|jsx)$/.test(path)) return true;
  return false;
}

// True when the file content actually contains a fetch call. Without
// this guard, EVERY client-named file with a stripped-down regex
// match would generate a pin — high FP risk. Requiring a real fetch
// invocation keeps the pin grounded.
function fileHasFetchCall(content: string): boolean {
  return /\bfetch\s*\(/.test(content) ||
    /\baxios\s*\./.test(content) ||
    /\b(?:ky|got|request|http)\s*\./.test(content) ||
    /\bnew\s+Request\s*\(/.test(content);
}

export function detectClientFetchAuthInDiff(
  diffByFile: DiffByFile,
  repoPath: string
): DiffClientFetchHit[] {
  const out: DiffClientFetchHit[] = [];
  const seenFiles = new Set<string>();
  for (const [filePath, addedLines] of diffByFile.entries()) {
    if (!isClientFetchFile(filePath)) continue;
    // File must actually contain a fetch call (read the post-fix
    // version). Without this, we'd pin files that mention auth but
    // don't make HTTP calls.
    let content: string;
    try {
      content = readFileSync(join(repoPath, filePath), "utf8");
    } catch {
      continue;
    }
    if (!fileHasFetchCall(content)) continue;

    const added = addedLines
      .map((l) => l.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, ""))
      .filter((l) => l.trim().length > 0)
      .join("\n");
    if (added.length === 0) continue;

    let firstHit: { signature: string } | null = null;
    for (const re of CLIENT_FETCH_AUTH_PATTERNS) {
      const m = re.exec(added);
      if (m) {
        firstHit = { signature: extractFullLineFromMatch(added, m.index, m[0]) };
        break;
      }
    }
    if (!firstHit) continue;

    if (seenFiles.has(filePath)) continue;
    seenFiles.add(filePath);

    // Derive a recognizable "route" name from the file path:
    // `apps/app/src/api/client.ts` → `client:apps/app/src/api/client`
    const routeName = "client:" + filePath.replace(/\.(?:ts|tsx|js|jsx|mjs|cjs)$/, "");
    out.push({
      template: "auth-required",
      route: routeName,
      filePath,
      signature: firstHit.signature,
      suggestedPin: `client fetch in ${filePath} preserves correctness signature (added in this fix)`,
    });
  }
  return out;
}

// ────────────────────────────────────────────────────────────
// Client-side error-handling preservation
// ────────────────────────────────────────────────────────────
//
// Second high-yield client-side detector. Catches the "AI removed
// the error handling around my fetch call and now failures silently
// pass through as undefined" failure mode — one of the most common
// AI-coder regression shapes per the GPT review.
//
// Pattern: fix added a fetch-error gate (status check, try/catch,
// .catch handler). Pin captures the signature; future commits that
// strip the gate fail the static-mode replay.
//
// Reuses the same isClientFetchFile filter and the same template
// (auth-required as the closest fit — the static-signature replay
// is identical even though the semantic differs slightly). Naming
// the pin `client-error-handling` in the route synthesizer keeps
// the human output recognizable.
export const CLIENT_ERROR_HANDLING_PATTERNS: RegExp[] = [
  // `if (!res.ok) throw` / return / handle
  /\bif\s*\(\s*!\s*(?:res|response|r|result)\s*\.\s*ok\s*\)/,
  // Status-check + non-success branch
  /\bif\s*\(\s*(?:res|response|r|result)\s*\.\s*status\s*(?:!==?|>=?|<=?|===?)\s*\d{3}\b/,
  // try/catch wrapping a fetch — the catch block is the signal
  /\bcatch\s*\(\s*(?:e|err|error|ex)[\w]*\s*\)\s*\{[^}]*(?:throw|return|console|toast|setError|reject)/,
  // Promise .catch handler attached to fetch / axios / ky / etc.
  /\.\s*catch\s*\(\s*(?:\([^)]*\)|[^,)]+)\s*=>/,
  // Explicit "throw on non-200" using onResolve helpers
  /\bthrowIfNotOk\s*\(/,
  /\bensureOk\s*\(/,
  // axios interceptor / global error handler addition
  /\baxios\s*\.\s*interceptors\s*\.\s*response\s*\.\s*use/,
];

export type DiffClientErrorHandlingHit = {
  template: "auth-required"; // reusing the same static-mode template
  route: string;
  filePath: string;
  signature: string;
  suggestedPin: string;
};

// Webhook signature detector — P0 #4 per [[strategic-pivot-guard-integrity]].
// Detects webhook handler files that VERIFY incoming request signatures
// (Stripe / GitHub / Resend / Twilio / Slack). Pins the verification
// signature so a future edit that removes it fails the static check.
export type WebhookSignaturePin = {
  template: "auth-required";
  route: string;
  filePath: string;
  signature: string;
  provider: string;
  suggestedPin: string;
};

// Patterns that indicate this file VERIFIES a webhook signature.
// Each entry: vendor name + regex matching the verification call.
const WEBHOOK_VERIFY_PATTERNS: Array<{ provider: string; pattern: RegExp }> = [
  { provider: "stripe", pattern: /\bstripe\.webhooks\.constructEvent\s*\(/i },
  { provider: "stripe", pattern: /\bconstructEventAsync\s*\(/i },
  { provider: "github", pattern: /\bverify\s*\(\s*(?:secret|signature|payload|req\.headers)/i },
  { provider: "github", pattern: /['"]x-hub-signature(?:-256)?['"]/i },
  { provider: "resend", pattern: /\bsvix\.verify\s*\(/i },
  { provider: "twilio", pattern: /\btwilio\.validateRequest\s*\(/i },
  { provider: "slack", pattern: /\bx-slack-signature\b/i },
  { provider: "generic-hmac", pattern: /\b(?:crypto\.)?createHmac\s*\(\s*['"](?:sha256|sha1|sha512)['"]/ },
];

function isWebhookHandlerFile(path: string): boolean {
  if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(path)) return false;
  if (isTestPath(path)) return false;
  // Path heuristics — webhook routes typically have "webhook" in path
  return /(?:^|\/)webhook|webhook(?:s)?\.(?:ts|tsx|js|jsx|mjs|cjs)$/i.test(path);
}

export function detectWebhookSignaturePins(repoPath: string): WebhookSignaturePin[] {
  const out: WebhookSignaturePin[] = [];
  const candidates = walkRepoFiles(repoPath, {
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    maxFiles: 1500,
  });
  for (const relPath of candidates) {
    if (!isWebhookHandlerFile(relPath)) continue;
    let content: string;
    try {
      content = readFileSync(join(repoPath, relPath), "utf8");
    } catch {
      continue;
    }
    const stripped = content
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    for (const { provider, pattern } of WEBHOOK_VERIFY_PATTERNS) {
      const m = pattern.exec(stripped);
      if (!m) continue;
      const signature = extractFullLineFromMatch(stripped, m.index, m[0]);
      const route = `webhook:${relPath.replace(/\.(?:ts|tsx|js|jsx|mjs|cjs)$/, "")}`;
      out.push({
        template: "auth-required",
        route,
        filePath: relPath,
        signature,
        provider,
        suggestedPin: `webhook signature verification on ${route} (${provider})`,
      });
      break; // one pin per file
    }
  }
  return out;
}

// Route/export integrity — P0 #5 per [[strategic-pivot-guard-integrity]].
// Detects internal link targets (Next.js, Remix-style) that reference
// routes which DO currently resolve to a real file. The pin asserts
// the target file continues to exist — catches the "AI hallucinates
// a /pricing link but never wrote /pricing/page.tsx" class plus the
// inverse "AI removed /pricing/page.tsx but didn't update the link."
export type InternalLinkPin = {
  template: "config-invariant";
  configPath: string;
  expected: string;
  label: string;
  suggestedPin: string;
  sourceFile: string;
  targetRoute: string;
};

function deriveRouteTargets(repoPath: string, route: string): string[] {
  // Returns candidate file paths the route could be served from.
  // Supports Next.js App Router, Pages Router, and Remix.
  const seg = route.replace(/^\/+|\/+$/g, "");
  if (!seg) return ["app/page.tsx", "app/page.ts", "pages/index.tsx", "pages/index.ts"];
  return [
    // Next.js App Router
    `app/${seg}/page.tsx`,
    `app/${seg}/page.ts`,
    `app/${seg}/page.jsx`,
    // Next.js Pages Router
    `pages/${seg}.tsx`,
    `pages/${seg}.ts`,
    `pages/${seg}.jsx`,
    `pages/${seg}/index.tsx`,
    `pages/${seg}/index.ts`,
    // Remix
    `app/routes/${seg}.tsx`,
    `app/routes/${seg.replace(/\//g, ".")}.tsx`,
    // SvelteKit
    `src/routes/${seg}/+page.svelte`,
  ];
}

function routeResolves(repoPath: string, route: string): string | null {
  const candidates = deriveRouteTargets(repoPath, route);
  for (const c of candidates) {
    if (existsSync(join(repoPath, c))) return c;
  }
  return null;
}

const LINK_PATTERNS: RegExp[] = [
  // <Link href="/path"
  /<Link[\s\S]*?\bhref\s*=\s*["']([^"']+)["']/g,
  // <a href="/path"
  /<a[\s\S]*?\bhref\s*=\s*["'](\/[^"']+)["']/g,
  // navigate("/path") / router.push("/path") / redirect("/path")
  /\b(?:navigate|router\.push|redirect)\s*\(\s*["'](\/[^"']+)["']/g,
];

export function detectInternalLinkPins(repoPath: string): InternalLinkPin[] {
  const out: InternalLinkPin[] = [];
  const seen = new Set<string>();
  const candidates = walkRepoFiles(repoPath, {
    extensions: [".tsx", ".jsx"],
    maxFiles: 1500,
  });
  for (const relPath of candidates) {
    if (isTestPath(relPath)) continue;
    let content: string;
    try {
      content = readFileSync(join(repoPath, relPath), "utf8");
    } catch {
      continue;
    }
    for (const re of LINK_PATTERNS) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        const target = m[1];
        if (!target.startsWith("/")) continue;
        if (target.startsWith("//") || target.startsWith("/http")) continue; // external
        // Strip anchors, query strings
        const route = target.replace(/[?#].*$/, "");
        // Skip API routes (they're not pages)
        if (route.startsWith("/api/") || route === "/api") continue;
        // Dedupe per (sourceFile, route)
        const key = `${relPath}|${route}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const resolvedFile = routeResolves(repoPath, route);
        if (!resolvedFile) continue; // can't pin a route that doesn't resolve today
        out.push({
          template: "config-invariant",
          configPath: resolvedFile,
          // Capture the file's first non-empty line so the
          // config-invariant pin has SOMETHING to verify. Crude but
          // works — if the target file is deleted entirely or
          // rewritten, the pin fails.
          expected: deriveFirstSubstantiveLine(repoPath, resolvedFile),
          label: `internal link ${route} resolves`,
          suggestedPin: `config-invariant internal link ${route} → ${resolvedFile}`,
          sourceFile: relPath,
          targetRoute: route,
        });
      }
    }
  }
  return out;
}

function deriveFirstSubstantiveLine(repoPath: string, relPath: string): string {
  try {
    const content = readFileSync(join(repoPath, relPath), "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      if (trimmed.startsWith("//")) continue;
      if (trimmed.startsWith("/*") || trimmed === "*/") continue;
      if (trimmed.length > 12) return trimmed.slice(0, 80);
    }
  } catch { /* */ }
  return "";
}

// Public exposure detector — P0 #6 per [[strategic-pivot-guard-integrity]].
// Detects files / build outputs that should NOT be deployed publicly:
//   - source maps in shipped dist (*.map files in committed dist/)
//   - .env or .env.local committed (should be in .gitignore)
//   - obvious debug routes (app/__debug/, /api/__test, /debug.html)
// All checks are pure filesystem; no fixtures, no PREVIEW_URL.
// Emits a finding shape similar to config-invariant — caller decides
// whether to BLOCK or WARN.
export type PublicExposureFinding = {
  severity: "block" | "warn";
  kind: "source-map-committed" | "env-committed" | "debug-route-present";
  path: string;
  evidence: string;
};

const COMMITTED_ENV_NAMES = [".env", ".env.local", ".env.production", ".env.production.local"];
const DEBUG_ROUTE_PATTERNS: RegExp[] = [
  /(?:^|\/)__debug(?:\/|$)/,
  /(?:^|\/)__test(?:\/|$)/,
  /(?:^|\/)debug\.html$/,
  /(?:^|\/)(?:app|pages)\/api\/__/,
  /(?:^|\/)admin\/console(?:\.html|\/)$/i,
];

export function detectPublicExposure(repoPath: string): PublicExposureFinding[] {
  const out: PublicExposureFinding[] = [];

  // 1. .env files committed to git — checks the tracked filesystem
  //    (existsSync against the env path). Customers should have these
  //    in .gitignore; if Pinned sees them committed, surface as warn.
  for (const envName of COMMITTED_ENV_NAMES) {
    const abs = join(repoPath, envName);
    if (existsSync(abs)) {
      // Check .gitignore — if it's there, this is a false positive
      let gitignore = "";
      try {
        gitignore = readFileSync(join(repoPath, ".gitignore"), "utf8");
      } catch { /* */ }
      const ignored = gitignore.split("\n").some((line) => {
        const trimmed = line.trim();
        return trimmed === envName || trimmed === `/${envName}` || trimmed === ".env*";
      });
      if (!ignored) {
        out.push({
          severity: "warn",
          kind: "env-committed",
          path: envName,
          evidence: `${envName} exists in repo root and is not in .gitignore. If this is intentional (template/.example only), rename to ${envName}.example. If real secrets, remove from git and add to .gitignore immediately.`,
        });
      }
    }
  }

  // 2. Source-map files in committed dist directories. Walk a SHALLOW
  //    scan of common dist locations — full repo walk would explode on
  //    monorepos. Limit hits to 5 to avoid spamming output.
  const distRoots = [
    "dist",
    "build",
    "out",
    ".next/static",
    "public/_next/static",
  ];
  for (const distRoot of distRoots) {
    const distAbs = join(repoPath, distRoot);
    if (!existsSync(distAbs)) continue;
    let mapFiles: string[] = [];
    try {
      mapFiles = walkRepoFiles(distAbs, { extensions: [".map"], maxFiles: 50 });
    } catch { continue; }
    for (const m of mapFiles.slice(0, 5)) {
      const rel = `${distRoot}/${m}`;
      out.push({
        severity: "warn",
        kind: "source-map-committed",
        path: rel,
        evidence: `Source map ${rel} exists in committed build output. Source maps expose original source to anyone who fetches them. Either delete pre-deploy or move out of the public-served directory.`,
      });
    }
  }

  // 3. Debug routes — walk source for files matching debug-route shapes.
  //    Catches "I left a /api/__debug endpoint in" — common AI mistake.
  const sourceFiles = walkRepoFiles(repoPath, {
    extensions: [".ts", ".tsx", ".js", ".jsx", ".html"],
    maxFiles: 2000,
  });
  for (const f of sourceFiles) {
    if (isTestPath(f)) continue;
    for (const pat of DEBUG_ROUTE_PATTERNS) {
      if (pat.test(f)) {
        out.push({
          severity: "warn",
          kind: "debug-route-present",
          path: f,
          evidence: `${f} looks like a debug/admin/test route shipped to production. If intentional, gate with explicit auth + env-flag; otherwise remove before deploy.`,
        });
        break;
      }
    }
  }

  return out;
}

// Static-state detector — finds CURRENT client-fetch auth + error
// handling signatures in the repo (no diff needed). Used by the
// init baseline scan to seed pins from existing patterns, not just
// from diffs. Output goes through generateTest just like diff-derived
// pins. Per [[strategic-pivot-guard-integrity]] this is the P0 #2
// category (client fetch / auth-headers / error-handling).
export type ClientFetchStaticPin = {
  template: "auth-required";
  route: string;            // `client:<rel-path>` synthetic
  filePath: string;
  signature: string;        // full-line snippet captured from current file content
  suggestedPin: string;
  source: "auth-headers" | "error-handling";
};

export function detectClientFetchPins(repoPath: string): ClientFetchStaticPin[] {
  const out: ClientFetchStaticPin[] = [];
  const seenRouteKeys = new Set<string>();
  const candidates = walkRepoFiles(repoPath, {
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    maxFiles: 1500,
  });
  for (const relPath of candidates) {
    if (!isClientFetchFile(relPath)) continue;
    let content: string;
    try {
      content = readFileSync(join(repoPath, relPath), "utf8");
    } catch {
      continue;
    }
    if (!fileHasFetchCall(content)) continue;
    // Strip comments — same hygiene as the diff-aware detectors.
    const stripped = content
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const route = `client:${relPath.replace(/\.(?:ts|tsx|js|jsx|mjs|cjs)$/, "")}`;

    // Auth headers — capture the first matching signature
    let authKey = `${route}|auth-headers`;
    if (!seenRouteKeys.has(authKey)) {
      for (const re of CLIENT_FETCH_AUTH_PATTERNS) {
        const m = re.exec(stripped);
        if (m) {
          const signature = extractFullLineFromMatch(stripped, m.index, m[0]);
          out.push({
            template: "auth-required",
            route,
            filePath: relPath,
            signature,
            suggestedPin: `auth required on ${route} (client-side fetch auth)`,
            source: "auth-headers",
          });
          seenRouteKeys.add(authKey);
          break;
        }
      }
    }

    // Error handling — same shape but different pattern set
    let errKey = `${route}|error-handling`;
    if (!seenRouteKeys.has(errKey)) {
      for (const re of CLIENT_ERROR_HANDLING_PATTERNS) {
        const m = re.exec(stripped);
        if (m) {
          const signature = extractFullLineFromMatch(stripped, m.index, m[0]);
          out.push({
            template: "auth-required",
            route: `${route}:error-handling`,
            filePath: relPath,
            signature,
            suggestedPin: `client error handling on ${route}`,
            source: "error-handling",
          });
          seenRouteKeys.add(errKey);
          break;
        }
      }
    }
  }
  return out;
}

export function detectClientErrorHandlingAddedInDiff(
  diffByFile: DiffByFile,
  repoPath: string
): DiffClientErrorHandlingHit[] {
  const out: DiffClientErrorHandlingHit[] = [];
  const seenFiles = new Set<string>();
  for (const [filePath, addedLines] of diffByFile.entries()) {
    if (!isClientFetchFile(filePath)) continue;
    let content: string;
    try {
      content = readFileSync(join(repoPath, filePath), "utf8");
    } catch {
      continue;
    }
    if (!fileHasFetchCall(content)) continue;

    const added = addedLines
      .map((l) => l.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, ""))
      .filter((l) => l.trim().length > 0)
      .join("\n");
    if (added.length === 0) continue;

    let firstHit: { signature: string } | null = null;
    for (const re of CLIENT_ERROR_HANDLING_PATTERNS) {
      const m = re.exec(added);
      if (m) {
        firstHit = { signature: extractFullLineFromMatch(added, m.index, m[0]) };
        break;
      }
    }
    if (!firstHit) continue;

    // SIGNATURE STRENGTH GATE (FP fix 2026-05-25): the bare `if (!res.ok) {`
    // pattern is too generic. Almost every client file with fetch has
    // SOME if-not-ok check; pinning the literal `if (!res.ok) {` line
    // means the pin fails on ANY refactor that touches that file's
    // error-handling shape, even when the equivalent check is still
    // there in a different syntactic form. Require the captured signature
    // to either be ≥ 30 chars (long enough to be specific) OR include
    // a recognizable response-handling identifier beyond the generic check.
    const sig = firstHit.signature.trim();
    const isGeneric = /^if\s*\(\s*!\s*res\.ok\s*\)\s*\{?\s*$/.test(sig) ||
      /^if\s*\(\s*!\s*response\.ok\s*\)\s*\{?\s*$/.test(sig) ||
      sig.length < 25;
    if (isGeneric) {
      // Try to find a stronger signature elsewhere in the added lines —
      // something like `throw new Error(\`HTTP ${res.status}\`)` or
      // `console.error(...)` or `return { error: ... }`. If we can
      // find a longer/more-specific shape, use that instead.
      const strongerPatterns: RegExp[] = [
        /throw\s+new\s+[A-Z][a-zA-Z]+\s*\(\s*[`'"][^`'"]{8,}/, // throw new Error("...")
        /\.\s*(?:json|text|status|statusText)\s*\(\s*\)\s*[\s,;]+[\s\S]{1,80}?(?:throw|return)/,
        /catch\s*\(\s*\w*\s*\)\s*\{[\s\S]{15,80}?\b(?:throw|return|console)/,
      ];
      let stronger: { signature: string } | null = null;
      for (const re of strongerPatterns) {
        const m = re.exec(added);
        if (m) {
          stronger = { signature: extractFullLineFromMatch(added, m.index, m[0]) };
          if (stronger.signature.length >= 25) break;
        }
      }
      if (!stronger || stronger.signature.length < 25) {
        // No stronger signature available — skip this catch. Better to
        // miss a weak pin than emit one that fails on every refactor.
        continue;
      }
      firstHit = stronger;
    }

    if (seenFiles.has(filePath)) continue;
    seenFiles.add(filePath);

    const routeName = "client-err:" + filePath.replace(/\.(?:ts|tsx|js|jsx|mjs|cjs)$/, "");
    out.push({
      template: "auth-required",
      route: routeName,
      filePath,
      signature: firstHit.signature,
      suggestedPin: `client error-handling in ${filePath} preserves failure-path signature (added in this fix)`,
    });
  }
  return out;
}

// ────────────────────────────────────────────────────────────
// Sibling-bug discovery (deterministic v1)
// ────────────────────────────────────────────────────────────
//
// After a real-catch on a high-value category, scan the repo for
// OTHER files that look like they protect the same family of routes
// but contain NONE of the patterns from the trigger set. Surface as
// suggested sibling guards (auto-pinning lives in the live `pinned`
// flow, not in the read-only benchmark).
//
// Confidence rules:
//   high   — file path is sibling-shaped (matching admin/account
//            prefix, or both files are middleware) AND zero trigger
//            patterns present
//   medium — file is route-shaped (matches /api/, /routes/, etc.)
//            AND zero trigger patterns
//   low    — any other source file (only via --verbose)
//
// Cap: at most 5 high + 10 medium per catch. Avoids 50-pin
// explosions on large repos with many admin routes.
export type SiblingSuggestion = {
  filePath: string;
  route: string | null;
  confidence: "high" | "medium" | "low";
  reason: string;
};

const HIGH_CONFIDENCE_SIBLING_HINTS = [
  "/admin/",
  "/account/",
  "/api/admin/",
  "/api/account/",
  "/dashboard/",
  "/internal/",
];

const SIBLING_CAP_HIGH = 5;
const SIBLING_CAP_MEDIUM = 10;

export function findUnprotectedSiblings(opts: {
  repoPath: string;
  patterns: RegExp[];
  triggerFilePath: string;    // the file we just caught (exclude from suggestions)
  triggerRoute: string;       // the route from the catch (drives sibling-shape matching)
  category: "auth" | "validation";
}): SiblingSuggestion[] {
  const { repoPath, patterns, triggerFilePath, triggerRoute, category } = opts;

  const high: SiblingSuggestion[] = [];
  const medium: SiblingSuggestion[] = [];

  // Decide which sibling-prefix hints apply based on the trigger route.
  // For middleware catches (route = "* (middleware)"), the sibling shape
  // is "other middleware files OR routes under admin/account/internal".
  const triggerHints: string[] = [];
  if (triggerRoute === "* (middleware)") {
    // Middleware protects multiple shapes; sibling candidates are any
    // unprotected admin/account/internal routes in the repo.
    triggerHints.push(...HIGH_CONFIDENCE_SIBLING_HINTS);
  } else {
    // For specific-route catches, look at OTHER routes sharing the
    // same first-two segments as a high-confidence proxy.
    const segs = triggerRoute.split("/").filter(Boolean);
    if (segs.length >= 1) {
      const prefix = "/" + segs.slice(0, Math.min(2, segs.length)).join("/") + "/";
      triggerHints.push(prefix);
    }
    // Also include the canonical high-risk prefixes as a backstop
    triggerHints.push(...HIGH_CONFIDENCE_SIBLING_HINTS);
  }

  const candidateFiles = walkRepoFiles(repoPath, {
    extensions: [".ts", ".tsx", ".js", ".jsx"],
    maxFiles: 1500,
  });

  for (const relPath of candidateFiles) {
    if (relPath === triggerFilePath) continue;
    if (isTestPath(relPath)) continue;
    // Only inspect route-shaped or middleware files
    const isRouteShape =
      /(?:^|\/)(?:src\/)?(?:app\/api\/.+\/route|pages\/api\/.+|routes\/.+)\.(?:ts|tsx|js|jsx)$/.test(relPath) ||
      /(?:^|\/)(?:src\/)?middleware\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(relPath);
    if (!isRouteShape) continue;
    // For AUTH-category siblings only: don't suggest auth on routes
    // that legitimately MUST be unauthenticated — login/signup/forgot,
    // OG images, health checks, webhooks. Surface as a candidate would
    // be noise. (Validation-category siblings DON'T get this filter:
    // signup/login routes still need body validation.)
    if (category === "auth") {
      const derivedRoute = deriveRouteFromPath(relPath);
      if (derivedRoute && (isAuthEndpoint(derivedRoute) || isLikelyPublicEndpoint(derivedRoute))) {
        continue;
      }
    }

    let content: string;
    try {
      content = readFileSync(join(repoPath, relPath), "utf8");
    } catch {
      continue;
    }
    // Strip comments before pattern-matching so commented-out auth
    // refs don't falsely "protect" the file from being suggested.
    const stripped = content
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const hasAnyTriggerPattern = patterns.some((re) => re.test(stripped));
    if (hasAnyTriggerPattern) continue;

    const derivedRoute = deriveRouteFromPath(relPath);
    const isHighConfidence = triggerHints.some((h) =>
      relPath.toLowerCase().includes(h.replace(/^\//, "")) ||
      (derivedRoute && derivedRoute.toLowerCase().startsWith(h))
    );

    const suggestion: SiblingSuggestion = {
      filePath: relPath,
      route: derivedRoute,
      confidence: isHighConfidence ? "high" : "medium",
      reason: isHighConfidence
        ? `path matches high-risk family (${category}-protected); no ${category} signature found`
        : `route-shaped file with no ${category} signature; verify before pinning`,
    };

    if (isHighConfidence && high.length < SIBLING_CAP_HIGH) {
      high.push(suggestion);
    } else if (!isHighConfidence && medium.length < SIBLING_CAP_MEDIUM) {
      medium.push(suggestion);
    }
    if (high.length >= SIBLING_CAP_HIGH && medium.length >= SIBLING_CAP_MEDIUM) break;
  }

  return [...high, ...medium];
}

// Same shape, different template. Detects "this fix added body
// validation that returns 400 on bad input" — produces a
// returns-status pin with a static-mode fingerprint so it runs in
// backtest without a live server. Pattern set is the union of
// schema-library calls + the plain-TS conjunction (req.body + 400).
export type DiffValidationHit = {
  template: "returns-status";
  route: string;
  filePath: string;
  method: "POST" | "PUT" | "PATCH";
  signature: string;
  suggestedPin: string;
};

// Validation-add patterns. Same regex set as the auto-detector
// (VALIDATION_PATTERNS) but with one extra: the plain-TS conjunction
// of `reply.code(400)` near `req.body`, which doesn't fit a single
// regex. Caller is expected to pre-filter to files matching the
// route-shape; we don't re-check that here.
const DIFF_VALIDATION_PATTERNS: RegExp[] = [
  /\bz\.object\s*\(/,
  /\.parseAsync\s*\(/,
  /\.safeParse(?:Async)?\s*\(/,
  /\byup\.object\s*\(/,
  /\bvalidate\s*\([^)]*req\.body/,
  /\bschema\.parse\s*\(/,
  /\b(?:reply|res)\.(?:code|status)\s*\(\s*400\b/,
];

// Diff-aware validation detector. Same wedge as auth-required but
// for "this fix added body validation." Emits a returns-status pin
// with a staticVerify fingerprint so the bug-fix benchmark can
// replay against the parent commit (where the validation didn't
// exist yet) without needing a live server.
export function detectValidationAddedInDiff(diffByFile: DiffByFile): DiffValidationHit[] {
  const out: DiffValidationHit[] = [];
  const seenRoutes = new Set<string>();
  for (const [filePath, addedLines] of diffByFile.entries()) {
    if (isTestPath(filePath)) continue;
    const route = deriveRouteFromPath(filePath);
    if (!route || route === "* (middleware)") continue; // middleware doesn't have a single route for this template
    // We pin returns-status on write methods only — GET routes
    // don't have body validation in the same sense. Method is
    // inferred from the FILE's content, not the diff (which may
    // have only added the validation, not the method declaration).
    const added = addedLines
      .map((l) => l.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, ""))
      .filter((l) => l.trim().length > 0)
      .join("\n");
    if (added.length === 0) continue;

    let firstHit: { signature: string } | null = null;
    for (const re of DIFF_VALIDATION_PATTERNS) {
      const m = re.exec(added);
      if (m) {
        firstHit = { signature: extractFullLineFromMatch(added, m.index, m[0]) };
        break;
      }
    }
    if (!firstHit) continue;
    // Method is best-effort: prefer POST when the added content
    // mentions it; else PUT; else PATCH. Real codebases usually
    // make this obvious in the same diff.
    const method: "POST" | "PUT" | "PATCH" =
      /\bPOST\b|\.post\(/i.test(added) ? "POST" :
      /\bPATCH\b|\.patch\(/i.test(added) ? "PATCH" : "PUT";

    if (seenRoutes.has(route)) continue;
    seenRoutes.add(route);
    out.push({
      template: "returns-status",
      route,
      filePath,
      method,
      signature: firstHit.signature,
      suggestedPin: `validation required on ${method} ${route} (added in this fix)`,
    });
  }
  return out;
}

export function detectAuthChecksInDiff(diffByFile: DiffByFile): DiffAuthCheckHit[] {
  const out: DiffAuthCheckHit[] = [];
  const seenRoutes = new Set<string>();
  for (const [filePath, addedLines] of diffByFile.entries()) {
    if (isTestPath(filePath)) continue;
    // Only consider files that look like route handlers — anywhere
    // else, the auth check is probably a utility and not pinnable.
    // We deliberately do NOT require the file to be under specific
    // dirs; the route deriver returns null for non-route paths and
    // we filter that out.
    const route = deriveRouteFromPath(filePath);
    if (!route) continue;
    // Skip routes that look like signup/login/etc — those legitimately
    // don't require auth on the unauthenticated direction. Same gate
    // the live auth-required detector uses.
    if (isAuthEndpoint(route) || isLikelyPublicEndpoint(route)) continue;

    // Concat all added lines and run patterns. Why not per-line?
    // Some patterns (the if-throw shape) span semicolons / closing
    // braces inline; the regex uses `.` so we let it match across.
    // Comments are filtered out — they're hint not behavior.
    const added = addedLines
      .map((l) => l.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, ""))
      .filter((l) => l.trim().length > 0)
      .join("\n");
    if (added.length === 0) continue;

    let firstHit: { signature: string; isWeak: boolean } | null = null;
    for (const re of AUTH_CHECK_PATTERNS) {
      const m = re.exec(added);
      if (m) {
        const isWeak = WEAK_AUTH_PATTERNS.some((wre) => wre.source === re.source && wre.flags === re.flags);
        // Capture the FULL added line containing the match instead of
        // just the matched substring. Full-line signatures are
        // dramatically less collision-prone than bare matches like
        // "if (!auth)" — which we saw fail on Quantasyte's eadffa6:
        // the new pattern matched generic identifiers that ALSO
        // appeared in the parent file (false-pass at parent, no
        // catch). Trim before storing so whitespace drift on the
        // file side doesn't break the includes() check downstream.
        firstHit = { signature: extractFullLineFromMatch(added, m.index, m[0]), isWeak };
        break;
      }
    }
    if (!firstHit) continue;
    // 0.2.11+ FP guard: a WEAK pattern alone (e.g. `pathname.startsWith
    // ("/admin")`) doesn't prove the file gates on the path — it might
    // just be allow-listing it through. Require a CONFIRMER pattern in
    // the same file (401/403 return, redirect to login, session/cookie
    // read, etc.) before treating the weak match as an auth signal.
    // Without this, socialideagen's routing middleware got an auth pin
    // that then false-failed on every legitimate refactor.
    if (firstHit.isWeak) {
      const hasConfirmer = AUTH_CONFIRMER_PATTERNS.some((re) => re.test(added));
      if (!hasConfirmer) continue;
    }

    const key = route;
    if (seenRoutes.has(key)) continue;
    seenRoutes.add(key);

    out.push({
      template: "auth-required",
      route,
      filePath,
      signature: firstHit.signature,
      suggestedPin: `auth required on ${route} (added in this fix)`,
    });
  }
  return out;
}

// ────────────────────────────────────────────────────────────
// New-POST-endpoint detector (auto-protect mode)
// ────────────────────────────────────────────────────────────
//
// Fires when the diff adds a new mutating route handler (POST / PUT /
// PATCH / DELETE). Used by auto-protect to emit a
// happy-path-with-side-effect candidate pin — without this, business-
// critical endpoints like POST /api/signup ship without coverage and
// the first regression hits prod (real incident on socialideagen
// 2026-06-02).
//
// Recognized shapes (Next.js app router first — highest-leverage):
//   - app/api/<path>/route.ts exporting `async function POST(...)`
//   - same for PUT / PATCH / DELETE
//   - pages/api/<path>.ts default export with method dispatch on POST
//
// The target table/model is GUESSED from the route's last segment
// (e.g. "/api/signup" → "signups", "/api/orders" → "orders") — the
// customer is expected to correct it via the AGENT SETUP REQUIRED
// prompt when they wire the X-Pinned-Side-Effect wrapper.
//
// 0.2.8+: `writeShape` carries the actual write-shape detected in the
// handler body (supabase / prisma / drizzle / kysely / mongoose / raw
// SQL / email send). When present, `targetGuess` is the captured table
// or model name from that shape — much more accurate than the route-
// segment heuristic. When absent, the detector fell back to the
// route-segment guess (or fired without a write shape entirely;
// retroactive scan requires writeShape, diff scan does not).
export type WriteShape = {
  // High-level category. Drives which template responds:
  //   db-insert / db-update / db-upsert / db-delete → happy-path-with-side-effect (sideEffectKind: "db-write")
  //   queue                                          → v0.3 (sideEffectKind: "queue-enqueue")
  //   email                                          → v0.3 (sideEffectKind: "email-send")
  //   file-upload                                    → 0.2.18 (Supabase Storage / S3 / R2 / Vercel Blob)
  //   http-post                                      → 0.2.18 (outbound paid-API calls — Anthropic / OpenAI)
  kind: "db-insert" | "db-update" | "db-upsert" | "db-delete" | "queue" | "email" | "file-upload" | "http-post";
  // Table/model name extracted from the match. For raw-SQL or
  // mongoose calls where the target is the LHS identifier, this is
  // that identifier verbatim.
  target: string;
  // The line that matched (for evidence in the suggestion).
  matchedExpr: string;
  // Library label so customers + agents know which ORM/SDK was
  // detected. Surfaces in the PINS.md suggestion + the AGENT SETUP
  // REQUIRED prompt.
  library: string;
};

export type DiffNewPostEndpointHit = {
  template: "happy-path-with-side-effect";
  route: string;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  filePath: string;
  // Best-guess side-effect target. Customer overrides via AGENT SETUP
  // REQUIRED prompt when they add the X-Pinned-Side-Effect wrapper.
  targetGuess: string;
  // Detected write shape, when the handler body contains a recognized
  // DB-write / email / queue pattern. Absent when only the method
  // signature was detected (legacy diff path).
  writeShape?: WriteShape;
  // Human-readable claim text for PINS.md.
  suggestedPin: string;
};

// Recognized write-shape patterns. Each: regex, target capture group
// index (1 = first group, 0 = use the whole match), kind, library.
//
// DOCUMENTED CONTRACT (referenced by AGENT.md + CHANGELOG): when a
// handler matches one of these, Pinned will offer a happy-path pin.
// When none match, no happy-path is emitted (the route is read-only,
// or uses a write library not yet recognized).
//
// Patterns are scoped CONSERVATIVELY — match only when the call is
// unambiguous (e.g. `supabase.from(X).insert(`, not bare `.insert(`).
// Each pattern was FP-checked against 1200+ files in dyad-apps before
// landing — see [[fp-check-everything-with-real-tests]].
const WRITE_SHAPE_PATTERNS: Array<{
  re: RegExp;
  kind: WriteShape["kind"];
  targetGroup: number;
  library: string;
}> = [
  // ── supabase-js ──
  // The supabase client identifier varies in real codebases:
  //   supabase / supabaseAdmin / admin / db / sb / supa / client / userClient / serviceClient
  // — all conventional. Widen the LHS to accept any of these. The
  // RHS chain (`.from(<table>).<write-method>`) is still tight enough
  // that this doesn't FP on unrelated `client.from(...)` shapes (no
  // common library uses the same chain). Confirmed catching missed
  // writes on MediniDyad (47 Edge Functions write via `admin.from(...)`).
  { re: /\b(?:supabase|supabaseAdmin|admin|adminClient|db|sb|supa|client|userClient|serviceClient|sbAdmin|supabaseClient)\s*\.\s*from\s*\(\s*['"]([\w_-]+)['"]\s*\)\s*\.\s*insert\b/, kind: "db-insert", targetGroup: 1, library: "supabase-js" },
  { re: /\b(?:supabase|supabaseAdmin|admin|adminClient|db|sb|supa|client|userClient|serviceClient|sbAdmin|supabaseClient)\s*\.\s*from\s*\(\s*['"]([\w_-]+)['"]\s*\)\s*\.\s*update\b/, kind: "db-update", targetGroup: 1, library: "supabase-js" },
  { re: /\b(?:supabase|supabaseAdmin|admin|adminClient|db|sb|supa|client|userClient|serviceClient|sbAdmin|supabaseClient)\s*\.\s*from\s*\(\s*['"]([\w_-]+)['"]\s*\)\s*\.\s*upsert\b/, kind: "db-upsert", targetGroup: 1, library: "supabase-js" },
  { re: /\b(?:supabase|supabaseAdmin|admin|adminClient|db|sb|supa|client|userClient|serviceClient|sbAdmin|supabaseClient)\s*\.\s*from\s*\(\s*['"]([\w_-]+)['"]\s*\)\s*\.\s*delete\b/, kind: "db-delete", targetGroup: 1, library: "supabase-js" },
  // ── prisma ──
  { re: /\bprisma\s*\.\s*([a-zA-Z_]\w*)\s*\.\s*create(?:Many)?\b/, kind: "db-insert", targetGroup: 1, library: "prisma" },
  { re: /\bprisma\s*\.\s*([a-zA-Z_]\w*)\s*\.\s*update(?:Many)?\b/, kind: "db-update", targetGroup: 1, library: "prisma" },
  { re: /\bprisma\s*\.\s*([a-zA-Z_]\w*)\s*\.\s*upsert\b/, kind: "db-upsert", targetGroup: 1, library: "prisma" },
  { re: /\bprisma\s*\.\s*([a-zA-Z_]\w*)\s*\.\s*delete(?:Many)?\b/, kind: "db-delete", targetGroup: 1, library: "prisma" },
  // ── drizzle-orm ──
  { re: /\b(?:db|drizzle|tx)\s*\.\s*insert\s*\(\s*([a-zA-Z_]\w*)\s*\)/, kind: "db-insert", targetGroup: 1, library: "drizzle-orm" },
  { re: /\b(?:db|drizzle|tx)\s*\.\s*update\s*\(\s*([a-zA-Z_]\w*)\s*\)/, kind: "db-update", targetGroup: 1, library: "drizzle-orm" },
  { re: /\b(?:db|drizzle|tx)\s*\.\s*delete\s*\(\s*([a-zA-Z_]\w*)\s*\)/, kind: "db-delete", targetGroup: 1, library: "drizzle-orm" },
  // ── kysely ──
  { re: /\b(?:db|kysely)\s*\.\s*insertInto\s*\(\s*['"]?([\w_-]+)['"]?\s*\)/, kind: "db-insert", targetGroup: 1, library: "kysely" },
  { re: /\b(?:db|kysely)\s*\.\s*updateTable\s*\(\s*['"]?([\w_-]+)['"]?\s*\)/, kind: "db-update", targetGroup: 1, library: "kysely" },
  { re: /\b(?:db|kysely)\s*\.\s*deleteFrom\s*\(\s*['"]?([\w_-]+)['"]?\s*\)/, kind: "db-delete", targetGroup: 1, library: "kysely" },
  // ── mongoose ── (capitalized Model name on LHS, .create() / .save() / .updateOne())
  { re: /\b(?:await\s+)?([A-Z][\w]*)\s*\.\s*create\s*\(/, kind: "db-insert", targetGroup: 1, library: "mongoose" },
  { re: /\b(?:await\s+)?new\s+([A-Z][\w]*)\s*\([^)]*\)\s*\.\s*save\s*\(/, kind: "db-insert", targetGroup: 1, library: "mongoose" },
  { re: /\b(?:await\s+)?([A-Z][\w]*)\s*\.\s*updateOne\s*\(/, kind: "db-update", targetGroup: 1, library: "mongoose" },
  // ── raw SQL via execute() / query() ──
  // Matches `db.execute("INSERT INTO X ...")` / `sql\`INSERT INTO X ...\`` etc.
  { re: /(?:INSERT\s+INTO|UPSERT\s+INTO)\s+["`']?([\w_-]+)["`']?/i, kind: "db-insert", targetGroup: 1, library: "raw SQL" },
  { re: /\bUPDATE\s+["`']?([\w_-]+)["`']?\s+SET\b/i, kind: "db-update", targetGroup: 1, library: "raw SQL" },
  { re: /\bDELETE\s+FROM\s+["`']?([\w_-]+)["`']?/i, kind: "db-delete", targetGroup: 1, library: "raw SQL" },
  // ── email providers ──
  { re: /\bresend\s*\.\s*emails\s*\.\s*send\s*\(/, kind: "email", targetGroup: 0, library: "resend" },
  { re: /\bsendgrid\s*\.\s*send\s*\(/i, kind: "email", targetGroup: 0, library: "sendgrid" },
  { re: /\bnodemailer[^;\n]{0,80}\.sendMail\s*\(/, kind: "email", targetGroup: 0, library: "nodemailer" },
  { re: /\b(?:ses|sesClient)\s*\.\s*send\s*\(\s*new\s+SendEmailCommand\b/, kind: "email", targetGroup: 0, library: "aws-ses" },
  { re: /\bpostmark[^;\n]{0,30}\.sendEmail\b/i, kind: "email", targetGroup: 0, library: "postmark" },
  // ── queue / job providers ──
  { re: /\b(?:queue|jobs?)\s*\.\s*(?:add|enqueue|push|publish)\s*\(/i, kind: "queue", targetGroup: 0, library: "queue" },
  { re: /\b(?:bull|bullmq|bullQueue)\s*\.\s*add\s*\(/i, kind: "queue", targetGroup: 0, library: "bullmq" },
  { re: /\binngest\s*\.\s*send\s*\(/i, kind: "queue", targetGroup: 0, library: "inngest" },
  // ── file-upload / object storage ──
  // High-stakes: dropping the auth gate on these = anyone uploads files
  // to a public bucket on the customer's domain (the socialideagen
  // uploadMockup case). Target = bucket name. Matches the upload call,
  // not download/getPublicUrl/list (read-only).
  { re: /\bsupabase\s*\.\s*storage\s*\.\s*from\s*\(\s*['"]([\w_-]+)['"]\s*\)\s*\.\s*upload\b/, kind: "file-upload", targetGroup: 1, library: "supabase-storage" },
  // AWS S3 v3 — `s3Client.send(new PutObjectCommand({Bucket: "X", ...}))`.
  // Captures the bucket from the command object when present.
  { re: /\bnew\s+PutObjectCommand\s*\(\s*\{\s*[^}]*?Bucket\s*:\s*['"]([\w._-]+)['"]/, kind: "file-upload", targetGroup: 1, library: "aws-s3" },
  // AWS S3 v2 — `s3.putObject({Bucket: "X", ...}).promise()`.
  { re: /\b(?:s3|s3Client)\s*\.\s*putObject\s*\(\s*\{\s*[^}]*?Bucket\s*:\s*['"]([\w._-]+)['"]/, kind: "file-upload", targetGroup: 1, library: "aws-s3" },
  // Cloudflare R2 / Workers KV / generic env bucket: `env.BUCKET.put("key", body)` or `bucket.put("key", body)`.
  // Tight pattern — requires the literal "put" call signature (key, body)
  // so DOM mutations like `el.put(...)` don't match.
  { re: /\b(?:env\s*\.\s*([A-Z][A-Z0-9_]*)|([a-z]\w*Bucket))\s*\.\s*put\s*\(\s*['"`]/, kind: "file-upload", targetGroup: 1, library: "cloudflare-r2" },
  // Vercel Blob — `import { put } from "@vercel/blob"; await put(name, body, {...});`.
  // The import side is detected via the literal `@vercel/blob` token
  // appearing in the same content slice, which suppresses ambiguous
  // bare `put(...)` matches elsewhere.
  { re: /['"]@vercel\/blob['"][\s\S]{0,500}?\bput\s*\(\s*['"`]([\w._/\-]+)['"`]/, kind: "file-upload", targetGroup: 1, library: "vercel-blob" },
  // ── outbound paid-API calls (Anthropic / OpenAI / Gemini / Stripe) ──
  // High-cost: dropping the auth gate = anyone runs up the customer's
  // bill. The socialideagen aiFillIdea case. Target = the API name +
  // method so the suggestion makes sense ("messages.create" / "chat.completions.create").
  // Anthropic SDK: messages.create / messages.parse (typed-output helper)
  // / messages.stream (streaming variant) / counts (token counting).
  { re: /\b(?:anthropic|client|ai)\s*\.\s*messages\s*\.\s*(?:create|parse|stream)\s*\(/, kind: "http-post", targetGroup: 0, library: "anthropic" },
  { re: /\b(?:openai|client)\s*\.\s*chat\s*\.\s*completions\s*\.\s*create\s*\(/, kind: "http-post", targetGroup: 0, library: "openai" },
  { re: /\b(?:openai|client)\s*\.\s*responses\s*\.\s*create\s*\(/, kind: "http-post", targetGroup: 0, library: "openai" },
  { re: /\b(?:openai|client)\s*\.\s*images\s*\.\s*generate\s*\(/, kind: "http-post", targetGroup: 0, library: "openai" },
  { re: /\b(?:openai|client)\s*\.\s*embeddings\s*\.\s*create\s*\(/, kind: "http-post", targetGroup: 0, library: "openai" },
  // Google Gemini SDK
  { re: /\bgemini\s*\.\s*generateContent\s*\(/, kind: "http-post", targetGroup: 0, library: "google-gemini" },
  // Stripe payment intent / charge create — cost AND data-integrity surface.
  { re: /\bstripe\s*\.\s*(?:paymentIntents|charges|subscriptions|customers)\s*\.\s*create\s*\(/, kind: "http-post", targetGroup: 0, library: "stripe" },
  // Stripe checkout.sessions.create — the SaaS-billing money path. Most
  // apps don't use raw paymentIntents; checkout.sessions is the
  // hosted-checkout endpoint that 80% of SaaS apps use to take money.
  // Pattern confirmed across quantasyte + quantapact production code.
  { re: /\bstripe\s*\.\s*checkout\s*\.\s*sessions\s*\.\s*create\s*\(/, kind: "http-post", targetGroup: 0, library: "stripe-checkout" },
  // Stripe billingPortal.sessions.create — the customer subscription-
  // management surface. Same risk class as checkout (silent removal /
  // wrong return_url / cancelled subscription path breaks paying
  // customers). Pattern confirmed across quantasyte + quantapact.
  { re: /\bstripe\s*\.\s*billingPortal\s*\.\s*sessions\s*\.\s*create\s*\(/, kind: "http-post", targetGroup: 0, library: "stripe-portal" },
];

// Detect a write shape in a handler body. Returns the FIRST shape
// that matches (handlers typically have one primary write per route).
// Returns null when no recognized shape is found — the route is
// likely read-only or uses a library Pinned doesn't yet recognize.
export function detectWriteShape(content: string): WriteShape | null {
  // Strip line/block comments so a write inside a `// removed` comment
  // doesn't trigger. Same defensive normalization the validation
  // detector does — preserved here for consistency.
  const stripped = content.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const { re, kind, targetGroup, library } of WRITE_SHAPE_PATTERNS) {
    const m = re.exec(stripped);
    if (!m) continue;
    const target = targetGroup > 0 ? m[targetGroup] :
      kind === "email" ? "outgoing-email" :
      kind === "queue" ? "queue-message" :
      kind === "http-post" ? "external-api" :
      kind === "file-upload" ? "uploaded-file" :
      "row";
    return {
      kind,
      target,
      matchedExpr: m[0].trim(),
      library,
    };
  }
  return null;
}

// Split a string on commas that are at the top level (not inside
// parens / brackets / braces). Used by schema detectors to split
// `email: z.string(), name: z.string().min(3)` into two entries.
function splitTopLevelCommas(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    else if (c === "," && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}

// Pluralize the route's last segment for the target guess. Conservative
// — only handles the common English plural cases. Customer overrides
// during wrapper setup if their table name differs.
function pluralizeRouteSegment(seg: string): string {
  if (!seg) return "items";
  if (seg.endsWith("s")) return seg; // already plural
  if (seg.endsWith("y") && !/[aeiou]y$/.test(seg)) return seg.slice(0, -1) + "ies";
  if (/(?:s|x|z|ch|sh)$/.test(seg)) return seg + "es";
  return seg + "s";
}

export function detectNewPostEndpointsInDiff(diffByFile: DiffByFile): DiffNewPostEndpointHit[] {
  const out: DiffNewPostEndpointHit[] = [];
  const seenRoutes = new Set<string>();
  for (const [filePath, addedLines] of diffByFile.entries()) {
    if (isTestPath(filePath)) continue;
    const route = deriveRouteFromPath(filePath);
    if (!route) continue;

    // Strip comments + concat. We're looking for an exported handler
    // declaration. Method dispatch via `if (req.method === "POST")`
    // also counts (pages-router pattern).
    const added = addedLines
      .map((l) => l.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, ""))
      .filter((l) => l.trim().length > 0)
      .join("\n");
    if (added.length === 0) continue;

    // Next.js app router: `export async function POST(`
    let method: "POST" | "PUT" | "PATCH" | "DELETE" | null = null;
    const appRouterMatch = /export\s+(?:const\s+|async\s+function\s+|function\s+)(POST|PUT|PATCH|DELETE)\b/.exec(added);
    if (appRouterMatch) {
      method = appRouterMatch[1] as "POST" | "PUT" | "PATCH" | "DELETE";
    }
    // Pages router / Express / Fastify / Hono: req.method === "POST"
    if (!method) {
      const pagesMatch = /req\.method\s*===?\s*['"](POST|PUT|PATCH|DELETE)['"]/.exec(added);
      if (pagesMatch) method = pagesMatch[1] as "POST" | "PUT" | "PATCH" | "DELETE";
    }
    // Express / Fastify: app.post / router.post / fastify.post
    if (!method) {
      const expressMatch = /\b(?:app|router|fastify|server)\.(?:post|put|patch|delete)\s*\(/i.exec(added);
      if (expressMatch) {
        const verb = expressMatch[0].match(/\.(\w+)\s*\(/)?.[1]?.toUpperCase();
        if (verb === "POST" || verb === "PUT" || verb === "PATCH" || verb === "DELETE") {
          method = verb;
        }
      }
    }
    if (!method) continue;

    // Skip auth endpoints — signup/login/logout/etc. They CAN have
    // happy-path pins, but the wrapper conversation is different (the
    // side-effect target for signup is usually "users", for login is
    // "sessions"). We still emit the pin but the customer must confirm
    // the target. For now, allow them through — they're the case the
    // socialideagen incident proved we need to cover.

    // Skip if the route already triggered another high-confidence
    // template (avoid double-pinning the same route). Auto-protect
    // dedupes by claim-key but this is a cheaper early filter.
    const key = `${method} ${route}`;
    if (seenRoutes.has(key)) continue;
    seenRoutes.add(key);

    // Detect a write shape in the added lines. When present, the
    // captured target name is more accurate than the route-segment
    // pluralization (e.g. supabase.from("user_profiles") gives us
    // "user_profiles", not "signups" from a /api/signup route). When
    // absent, fall back to the route-segment heuristic — keeps recall
    // on routes whose write library Pinned doesn't yet recognize.
    const writeShape = detectWriteShape(added);
    const lastSeg = route.split("/").filter(Boolean).pop() || "items";
    const targetGuess = writeShape?.target ?? pluralizeRouteSegment(lastSeg);

    out.push({
      template: "happy-path-with-side-effect",
      route,
      method,
      filePath,
      targetGuess,
      ...(writeShape ? { writeShape } : {}),
      suggestedPin: writeShape
        ? `${method} ${route} ${writeShape.kind === "email" ? "sends an email" : writeShape.kind === "queue" ? "enqueues a job" : `${writeShape.kind === "db-insert" ? "creates" : writeShape.kind === "db-update" ? "updates" : writeShape.kind === "db-upsert" ? "upserts" : "deletes"} a ${targetGuess} record`} (${writeShape.library})`
        : `${method} ${route} creates a ${targetGuess} record`,
    });
  }
  return out;
}

// ────────────────────────────────────────────────────────────
// Retroactive journey detector (0.2.8+)
// ────────────────────────────────────────────────────────────
//
// Pairs EXISTING route handlers with EXISTING pages by shared state
// signals. Runs against the full repo (not a diff) during
// `pinned init`'s baseline pass. Closes the "/thanks shows 'No signup
// found' after signup" class of bugs that single-step pins can't reach.
//
// Two pairing signals (each pair is reported separately with the
// signal that triggered it):
//
//   (1) shared session module — POST handler imports `writeXId` /
//       `setXSession` / `setXCookie` from a module, AND a page imports
//       the read counterpart (`readXId` / `getXSession` / etc) from
//       the SAME module. Catches: signup→thanks (writes signupId,
//       page reads it).
//
//   (2) redirect target — route handler emits a redirect to a
//       page route that exists. Catches: confirm→thanks (confirm
//       redirects to /thanks?confirm=ok). Extracts setsCookie when
//       the handler also calls `res.cookies.set(NAME, ...)` so the
//       journey pin can assert the cookie was actually set.
//
// FP-bound: only fires when one of the signals matches. A POST that
// neither shares a session function nor redirects to a known page
// emits no journey candidate.
export type RetroactiveJourneyHit = {
  template: "journey";
  label: string;
  steps: Array<{
    method: "POST" | "GET" | "PUT" | "PATCH" | "DELETE";
    route: string;
    setsCookie?: string;
    redirectIncludes?: string;
    // 0.2.16+: empty-state markers extracted from the target page's
    // source ("No signup found" etc). When present, the journey
    // template emits these as `expect.bodyForbids` on this step so
    // the journey catches the "happened structurally but the page
    // shows the empty-state copy" failure mode (socialideagen #3).
    bodyForbids?: string[];
  }>;
  filePaths: string[];
  pairReason: "shared-session-module" | "redirect-target";
  sharedToken: string;
  suggestedPin: string;
};

// Lightweight per-file extract used by the detector. Keep it small —
// we run it on every file in the baseline pass.
// 0.2.16+: extract empty-state UI markers from a page's source so the
// journey detector can populate `bodyForbids` automatically. Catches
// socialideagen #3 (/thanks shows "No signup found" when the cookie
// isn't set). Patterns we look for inside JSX h1/h2/h3 tags:
//   - "No X found" / "X not found"
//   - "Sign in to" / "Please sign"
//   - "expired" / "expired session"
//   - "404" (rarely a real route, but a real signal when present)
//
// We deliberately scope to CONDITIONAL branches — text that ALWAYS
// renders (page title, marketing copy) shouldn't be in bodyForbids
// or we'll false-fire on legitimate renders. Conservative pattern:
// only extract a heading if the surrounding source has an `if (!X)`
// / ternary / `&&` guard within 8 lines above. Misses some real
// empty-states but precision >> recall here since false-bodyForbids
// = pin false-fires on the happy path.
export function extractEmptyStateMarkers(content: string): string[] {
  const out = new Set<string>();
  // Strip comments first.
  const stripped = content
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  // Find h1/h2/h3 text content. JSX-style: <h1 ...>text</h1>.
  // Allow class attrs and inline expressions; capture the text part.
  const HEADING_RE = /<h[1-3][^>]*>([^<{]+?)<\/h[1-3]>/g;
  for (const m of stripped.matchAll(HEADING_RE)) {
    const text = m[1].trim();
    if (text.length < 3 || text.length > 80) continue;
    // Only keep texts that look like empty-state markers.
    const isEmptyMarker = /^No\s+\w/.test(text)
      || /\bnot\s+found\b/i.test(text)
      || /^Sign\s+in\b/i.test(text)
      || /^Please\s+sign/i.test(text)
      || /\bexpired\b/i.test(text)
      || /^404\b/.test(text);
    if (!isEmptyMarker) continue;

    // Precision gate: the heading text should appear ABOVE a conditional
    // guard pattern in the same file. Find the heading's source-index,
    // walk back ~8 lines, check for `if (!X)` / `: <` / `&& <` patterns.
    const idx = stripped.indexOf(m[0]);
    if (idx < 0) continue;
    const before = stripped.slice(Math.max(0, idx - 500), idx);
    const hasConditional =
      /\bif\s*\(\s*!\s*\w/.test(before) ||
      /\?\s*<\s*\w/.test(before) ||
      /\&\&\s*<\s*\w/.test(before) ||
      /\breturn\s+<\s*(?:[A-Z]\w*|h[1-3])/.test(before);
    if (!hasConditional) continue;

    out.add(text);
  }

  // Component-name signal: `<NoSignup ...>` / `<NoUser />` /
  // `<NotFound />` — these abstract-named components almost always
  // render empty-state copy. When found, infer the empty-state text
  // from the component name itself: "No signup" → bodyForbids "No
  // signup". Lower-confidence than direct heading text.
  const COMPONENT_RE = /<(No[A-Z]\w+|NotFound)\b/g;
  for (const m of stripped.matchAll(COMPONENT_RE)) {
    const name = m[1];
    // Find the component definition in this file. Accept all common
    // forms: `function X`, `async function X`, `export function X`,
    // `const X = `, arrow functions. The previous regex required
    // export/const which missed plain `function X(...)` definitions
    // (the most common Next.js pattern).
    const defPattern = new RegExp(`(?:(?:export\\s+(?:default\\s+)?)?(?:async\\s+)?function|(?:export\\s+)?const|let|var)\\s+${name}\\s*[(=]`);
    if (defPattern.test(stripped)) {
      const defStart = stripped.search(defPattern);
      if (defStart >= 0) {
        const defBlock = stripped.slice(defStart, defStart + 2000);
        const innerHeading = /<h[1-3][^>]*>([^<{]+?)<\/h[1-3]>/.exec(defBlock);
        if (innerHeading) {
          const text = innerHeading[1].trim();
          if (text.length >= 3 && text.length <= 80) out.add(text);
        }
      }
    }
  }

  return Array.from(out);
}

type FileAnalysis = {
  filePath: string;
  route: string | null;
  isPage: boolean;
  method: "POST" | "GET" | "PUT" | "PATCH" | "DELETE" | null;
  // Functions imported (name → module). Imports of session-marker
  // functions become the pairing key.
  imports: Map<string, string>;
  // Redirect targets found in the body, e.g. "/thanks?confirm=ok".
  // Path-only (query string stripped) for matching against page routes.
  redirectTargets: string[];
  // setCookie calls: cookies.set("name", ...) or res.cookies.set(NAME, ...).
  // Captures the cookie name when literal (string) or imported constant.
  setsCookies: string[];
  // 0.2.16+ for pages only: empty-state markers extracted from the
  // page's source (e.g. "No signup found" inside a conditional branch).
  // Used by detectRetroactiveJourneys to populate bodyForbids on the
  // page step so the journey catches "signup happened but cookie wasn't
  // set → page shows empty state."
  emptyStateMarkers: string[];
};

const SESSION_WRITE_FN = /^(?:write|set)([A-Z]\w*?)(?:Id|Session|Cookie|Token)$/;
const SESSION_READ_FN = /^(?:read|get)([A-Z]\w*?)(?:Id|Session|Cookie|Token|User)$/;

function derivePageRoute(filePath: string): string | null {
  // Next.js app router: `app/<segments>/page.tsx`
  const appPageMatch = /^(?:.*\/)?app\/((?:[^/]+\/)*)page\.(?:tsx|jsx|ts|js)$/.exec(filePath);
  if (appPageMatch) {
    const segments = appPageMatch[1].replace(/\/$/, "");
    return segments ? `/${segments}` : "/";
  }
  // Pages router: `pages/<route>.tsx` / `pages/<segments>/<name>.tsx`
  const pagesMatch = /^(?:.*\/)?pages\/((?:[^/]+\/)*)?([^/]+)\.(?:tsx|jsx|ts|js)$/.exec(filePath);
  if (pagesMatch) {
    const dirSegments = (pagesMatch[1] || "").replace(/\/$/, "");
    const filename = pagesMatch[2];
    // Skip _app, _document, _error, api/* — not user-facing pages.
    if (filename.startsWith("_") || filename === "404" || filename === "500" || dirSegments.startsWith("api/") || dirSegments === "api") {
      return null;
    }
    const filePart = filename === "index" ? "" : `/${filename}`;
    return dirSegments ? `/${dirSegments}${filePart}` : `${filePart}` || "/";
  }
  return null;
}

function analyzeFile(filePath: string, content: string): FileAnalysis | null {
  if (isTestPath(filePath)) return null;
  // Try page-route derivation first; fall back to API-route. Pages
  // and API routes use different path conventions in Next.js, and
  // deriveRouteFromPath only handles API patterns.
  const pageRoute = derivePageRoute(filePath);
  const apiRoute = pageRoute ? null : deriveRouteFromPath(filePath);
  const route = pageRoute ?? apiRoute;
  if (!route) return null;
  const isPage = !!pageRoute;

  const stripped = content.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

  // Method detection — same patterns as the new-POST detector.
  let method: "POST" | "GET" | "PUT" | "PATCH" | "DELETE" | null = null;
  if (!isPage) {
    const appRouterMatch = /export\s+(?:const\s+|async\s+function\s+|function\s+)(POST|GET|PUT|PATCH|DELETE)\b/.exec(stripped);
    if (appRouterMatch) method = appRouterMatch[1] as "POST" | "GET" | "PUT" | "PATCH" | "DELETE";
    if (!method) {
      const pages = /req\.method\s*===?\s*['"](POST|GET|PUT|PATCH|DELETE)['"]/.exec(stripped);
      if (pages) method = pages[1] as "POST" | "GET" | "PUT" | "PATCH" | "DELETE";
    }
  }
  if (!isPage && !method) return null;

  // Imports — `import { writeSignupId, readSignupId } from "@/lib/cookies"`.
  // Captures the binding name → module string. Handles default + named + aliased.
  const imports = new Map<string, string>();
  const IMPORT_RE = /import\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']/g;
  for (const m of stripped.matchAll(IMPORT_RE)) {
    const namesRaw = m[1];
    const moduleSpec = m[2];
    for (const part of namesRaw.split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name && /^[a-zA-Z_$][\w$]*$/.test(name)) {
        imports.set(name, moduleSpec);
      }
    }
  }

  // Redirect targets — NextResponse.redirect(...), res.redirect(...),
  // redirect(...) from next/navigation. Capture the path portion.
  const redirectTargets: string[] = [];
  const REDIRECT_RE = /(?:NextResponse\.redirect|\bredirect)\s*\(\s*(?:`[^`]*?(\/[^?\s`$]+)|['"](\/[^?\s'"]+))/g;
  for (const m of stripped.matchAll(REDIRECT_RE)) {
    const path = m[1] ?? m[2];
    if (path) redirectTargets.push(path);
  }
  // Also: `${getOrigin(req)}/thanks?confirm=ok` style — capture the path
  // after the template-literal close brace.
  const TEMPLATE_REDIRECT_RE = /redirect\s*\(\s*`[^`]*?\}(\/[^?\s`$]+)/g;
  for (const m of stripped.matchAll(TEMPLATE_REDIRECT_RE)) {
    redirectTargets.push(m[1]);
  }

  // setCookie calls — cookies().set("name", ...) / res.cookies.set("name", ...) /
  // res.cookies.set(NAME, ...) (where NAME is an imported constant).
  const setsCookies: string[] = [];
  const COOKIE_SET_LITERAL = /\.\s*cookies\s*\.\s*set\s*\(\s*['"]([\w_-]+)['"]/g;
  const COOKIE_SET_CONST = /\.\s*cookies\s*\.\s*set\s*\(\s*([A-Z][A-Z0-9_]+)\s*,/g;
  for (const m of stripped.matchAll(COOKIE_SET_LITERAL)) setsCookies.push(m[1]);
  for (const m of stripped.matchAll(COOKIE_SET_CONST)) setsCookies.push(m[1]);

  // 0.2.16+ empty-state markers (pages only — handlers don't render UI).
  const emptyStateMarkers = isPage ? extractEmptyStateMarkers(content) : [];

  return {
    filePath,
    route,
    isPage,
    method,
    imports,
    redirectTargets,
    setsCookies,
    emptyStateMarkers,
  };
}

export function detectRetroactiveJourneys(
  filesByPath: Map<string, string>
): RetroactiveJourneyHit[] {
  const analyses: FileAnalysis[] = [];
  for (const [p, c] of filesByPath.entries()) {
    const a = analyzeFile(p, c);
    if (a) analyses.push(a);
  }

  const out: RetroactiveJourneyHit[] = [];
  const seenPairs = new Set<string>();

  const writeEndpoints = analyses.filter((a) => !a.isPage && a.method && (a.method === "POST" || a.method === "PUT" || a.method === "PATCH" || a.method === "GET"));
  const pages = analyses.filter((a) => a.isPage);

  for (const handler of writeEndpoints) {
    // Signal 1: shared session module. Find any imported binding that
    // matches the SESSION_WRITE_FN shape; for each, look for a page
    // that imports the matching read counterpart from the SAME module.
    for (const [name, mod] of handler.imports.entries()) {
      const writeMatch = SESSION_WRITE_FN.exec(name);
      if (!writeMatch) continue;
      const subject = writeMatch[1]; // e.g. "Signup" from "writeSignupId"
      for (const page of pages) {
        // Look for a read counterpart in the page's imports from the SAME module.
        let readFn: string | null = null;
        for (const [pname, pmod] of page.imports.entries()) {
          if (pmod !== mod) continue;
          const readMatch = SESSION_READ_FN.exec(pname);
          if (readMatch && readMatch[1] === subject) {
            readFn = pname;
            break;
          }
        }
        if (!readFn) continue;
        const key = `${handler.filePath}|${page.filePath}|session:${subject}`;
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        const label = `${handler.method} ${handler.route} → GET ${page.route}`;
        out.push({
          template: "journey",
          label,
          steps: [
            { method: handler.method!, route: handler.route! },
            {
              method: "GET",
              route: page.route!,
              // 0.2.16+: empty-state markers from the page → bodyForbids.
              // Catches socialideagen #3 ("/thanks shows 'No signup found'"
              // when the cookie wasn't set during signup).
              ...(page.emptyStateMarkers.length > 0 ? { bodyForbids: page.emptyStateMarkers } : {}),
            },
          ],
          filePaths: [handler.filePath, page.filePath],
          pairReason: "shared-session-module",
          sharedToken: `${name}() in handler + ${readFn}() in page, both from ${mod}${page.emptyStateMarkers.length > 0 ? ` (page guards: ${page.emptyStateMarkers.map((m) => JSON.stringify(m)).join(", ")})` : ""}`,
          suggestedPin: `journey: ${label} (${handler.method} writes ${subject.toLowerCase()} session; page reads it via ${readFn})`,
        });
      }
    }

    // Signal 2: redirect target. Find any redirect target that maps to
    // an existing page's route (substring match — captures e.g. confirm's
    // redirect to "/thanks" pairing with a "/thanks" page).
    for (const target of handler.redirectTargets) {
      // Normalize the captured target: strip trailing query / hash, keep path.
      const targetPath = target.split(/[?#]/)[0];
      if (!targetPath || targetPath.length < 2) continue;
      for (const page of pages) {
        if (page.route !== targetPath) continue;
        const key = `${handler.filePath}|${page.filePath}|redirect:${targetPath}`;
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        // Step 2 expectations: redirectIncludes from the target query
        // (e.g. "/thanks?confirm=ok" — we want the "confirm=ok" piece);
        // setsCookie from the handler's own setCookie calls.
        const queryHint = target.includes("?") ? target.slice(target.indexOf("?") + 1).split("&")[0] : null;
        const setsCookie = handler.setsCookies[0];
        const label = `${handler.method ?? "GET"} ${handler.route} → GET ${page.route}`;
        out.push({
          template: "journey",
          label,
          steps: [
            {
              method: handler.method ?? "GET",
              route: handler.route!,
              ...(queryHint ? { redirectIncludes: queryHint } : {}),
              ...(setsCookie ? { setsCookie } : {}),
            },
            {
              method: "GET",
              route: page.route!,
              ...(page.emptyStateMarkers.length > 0 ? { bodyForbids: page.emptyStateMarkers } : {}),
            },
          ],
          filePaths: [handler.filePath, page.filePath],
          pairReason: "redirect-target",
          sharedToken: `${handler.method ?? "GET"} ${handler.route} redirects to ${target}${setsCookie ? ` + sets cookie "${setsCookie}"` : ""}${page.emptyStateMarkers.length > 0 ? ` (page guards: ${page.emptyStateMarkers.map((m) => JSON.stringify(m)).join(", ")})` : ""}`,
          suggestedPin: `journey: ${label} (handler redirects to the page; ${setsCookie ? `also sets cookie "${setsCookie}" — pin asserts the redirect target + cookie` : "pin asserts the redirect target"})`,
        });
      }
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────
// Journey-pair detector (0.2.8+)
// ────────────────────────────────────────────────────────────
//
// Pairs a new POST/PUT/PATCH endpoint with a new GET endpoint (or
// new page) in the SAME diff when they share a referenceable token
// (write target, route segment, or page-segment overlap). When found,
// emits a journey candidate so auto-protect can suggest the multi-
// step pin without the customer having to author one manually.
//
// Conservative: requires BOTH a writeShape on the POST side AND a
// shared token. Without these guards, every diff that adds a POST
// and any unrelated GET in the same PR would pair into a noisy
// journey suggestion.
//
// Pattern this catches: PR adds POST /api/signup (writes "signups")
// + adds GET /thanks page (reads "signups"). Without journey
// detection these get a happy-path pin + a page-renders pin, but the
// "signup then /thanks shows the user" contract goes unpinned — that's
// where socialideagen bug #3 lived.
export type DiffJourneyHit = {
  template: "journey";
  label: string;
  steps: Array<{
    method: "POST" | "GET" | "PUT" | "PATCH" | "DELETE";
    route: string;
  }>;
  filePaths: string[];
  suggestedPin: string;
  sharedToken: string;
  evidence: string;
};

export function detectJourneyPairsInDiff(diffByFile: DiffByFile): DiffJourneyHit[] {
  const out: DiffJourneyHit[] = [];

  // First: collect all write-endpoint candidates from the diff.
  // We need the full added-line content (not just method signatures)
  // so we can run detectWriteShape against it.
  const writeEndpoints: Array<{
    route: string;
    method: "POST" | "PUT" | "PATCH" | "DELETE";
    filePath: string;
    writeShape: WriteShape;
  }> = [];
  for (const hit of detectNewPostEndpointsInDiff(diffByFile)) {
    if (!hit.writeShape) continue; // skip writeless POSTs — too noisy to pair
    writeEndpoints.push({
      route: hit.route,
      method: hit.method,
      filePath: hit.filePath,
      writeShape: hit.writeShape,
    });
  }
  if (writeEndpoints.length === 0) return out;

  // Then: collect all new pages from the diff. These become candidate
  // step-2 targets (typically a GET page that reads the just-written
  // record back: "signup → /thanks" / "checkout → /orders/[id]").
  const pages = detectNewPagesInDiff(diffByFile);

  // Pair each write endpoint with each new page when they share a
  // token. Sharing rules (any one is sufficient):
  //   (a) write target appears in the page route (e.g. POST writes
  //       "orders" + page is /orders/[id])
  //   (b) write target appears in the page handler's content
  //   (c) write route's last segment appears in the page route
  //       (e.g. POST /api/signup → /thanks-for-signing-up)
  for (const w of writeEndpoints) {
    const writeTarget = w.writeShape.target.toLowerCase();
    const writeSegment = (w.route.split("/").filter(Boolean).pop() || "").toLowerCase();
    for (const p of pages) {
      const pageRouteLc = p.route.toLowerCase();
      const pageContent = (diffByFile.get(p.filePath) ?? []).join("\n").toLowerCase();

      let sharedToken: string | null = null;
      if (writeTarget.length > 2 && pageRouteLc.includes(writeTarget)) {
        sharedToken = `write target "${writeTarget}" appears in page route`;
      } else if (writeTarget.length > 2 && pageContent.includes(writeTarget)) {
        sharedToken = `write target "${writeTarget}" referenced in page handler`;
      } else if (writeSegment.length > 2 && pageRouteLc.includes(writeSegment)) {
        sharedToken = `write route segment "${writeSegment}" appears in page route`;
      }
      if (!sharedToken) continue;

      const label = `${w.method} ${w.route} → GET ${p.route}`;
      out.push({
        template: "journey",
        label,
        steps: [
          { method: w.method, route: w.route },
          { method: "GET", route: p.route },
        ],
        filePaths: [w.filePath, p.filePath],
        sharedToken,
        suggestedPin: `journey: ${label} (${sharedToken})`,
        evidence: `New POST endpoint (${w.method} ${w.route}, ${w.writeShape.library}.${w.writeShape.kind}) and new page (${p.route}) added in the same diff share state. The multi-step contract — that the write is reflected in what the page renders — isn't covered by single-step pins.`,
      });
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────
// Retroactive write-endpoint scanner (0.2.8+)
// ────────────────────────────────────────────────────────────
//
// `detectNewPostEndpointsInDiff` only fires on routes ADDED in the
// current diff. Customers installing Pinned on an existing repo had
// all their real write endpoints already present — the detector
// silently skipped every one of them. Confirmed cost: socialideagen
// signup/invite routes existed pre-Pinned, never got happy-path pins
// → 0/4 catches on the four real production bugs.
//
// This scanner walks the FULL repo (not just the diff), finds every
// existing route handler with a recognized write shape, and emits
// happy-path-with-side-effect candidates for them. Called by
// `pinned init`'s baseline pass so first-touch coverage matches what
// future diffs would produce.
//
// Conservative: only fires when a write shape is actually present.
// A route handler that POSTs but only reads or proxies (no INSERT /
// no email send / no queue add) gets no pin — better than over-pinning.
export type RetroactiveWriteEndpointHit = {
  template: "happy-path-with-side-effect";
  route: string;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  filePath: string;
  targetGuess: string;
  writeShape: WriteShape;
  suggestedPin: string;
};

// Treat each repo-relative file as a "diff" of ALL its lines, then
// reuse the existing detector logic. Caller supplies the file list +
// content via the same DiffByFile shape so we don't duplicate the
// AST/regex pipeline.
export function detectRetroactiveWriteEndpoints(
  filesByPath: Map<string, string>
): RetroactiveWriteEndpointHit[] {
  const out: RetroactiveWriteEndpointHit[] = [];
  const seenRoutes = new Set<string>();
  for (const [filePath, content] of filesByPath.entries()) {
    if (isTestPath(filePath)) continue;
    const route = deriveRouteFromPath(filePath);
    if (!route) continue;

    // Strip comments so a write in a // removed comment doesn't fire.
    const stripped = content.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

    // Detect handler method — same patterns as the diff detector.
    let method: "POST" | "PUT" | "PATCH" | "DELETE" | null = null;
    const appRouterMatch = /export\s+(?:const\s+|async\s+function\s+|function\s+)(POST|PUT|PATCH|DELETE)\b/.exec(stripped);
    if (appRouterMatch) {
      method = appRouterMatch[1] as "POST" | "PUT" | "PATCH" | "DELETE";
    }
    if (!method) {
      const pagesMatch = /req\.method\s*===?\s*['"](POST|PUT|PATCH|DELETE)['"]/.exec(stripped);
      if (pagesMatch) method = pagesMatch[1] as "POST" | "PUT" | "PATCH" | "DELETE";
    }
    if (!method) {
      const expressMatch = /\b(?:app|router|fastify|server)\.(?:post|put|patch|delete)\s*\(/i.exec(stripped);
      if (expressMatch) {
        const verb = expressMatch[0].match(/\.(\w+)\s*\(/)?.[1]?.toUpperCase();
        if (verb === "POST" || verb === "PUT" || verb === "PATCH" || verb === "DELETE") {
          method = verb;
        }
      }
    }
    if (!method) continue;

    const writeShape = detectWriteShape(content);
    if (!writeShape) continue; // retroactive scan REQUIRES a write shape (no fallbacks)

    const key = `${method} ${route}`;
    if (seenRoutes.has(key)) continue;
    seenRoutes.add(key);

    out.push({
      template: "happy-path-with-side-effect",
      route,
      method,
      filePath,
      targetGuess: writeShape.target,
      writeShape,
      suggestedPin: `${method} ${route} ${
        writeShape.kind === "email" ? "sends an email" :
        writeShape.kind === "queue" ? "enqueues a job" :
        `${writeShape.kind === "db-insert" ? "creates" : writeShape.kind === "db-update" ? "updates" : writeShape.kind === "db-upsert" ? "upserts" : "deletes"} a ${writeShape.target} record`
      } (${writeShape.library})`,
    });
  }
  return out;
}

// ────────────────────────────────────────────────────────────
// Server-Action write detector (0.2.18+)
// ────────────────────────────────────────────────────────────
//
// Closes the App-Router mutation blind spot reported via socialideagen
// dogfood: `pinned sweep` was completely blind to `saveIdea` in
// `lib/ideaActions.ts` because its write detector keys on HTTP route
// handlers (/api/...), and Server Actions are the recommended modern
// Next.js mutation pattern.
//
// Detection (precision-gated — every hit must have a real write):
//   1. File contains a module-level `"use server"` directive (line 1
//      after comments / imports, before any export), OR a function-
//      body inline `"use server"`.
//   2. Find exported async functions / async arrow exports:
//        export async function NAME(...) { ... }
//        export const NAME = async (...) => { ... }
//        export const NAME = async function (...) { ... }
//   3. Run `detectWriteShape()` against each function's body. The
//      output type already encodes the write library / target / kind
//      we need for the verifier.
//   4. Optional: capture the input-schema variable name (zod) and the
//      auth gate function call — the verifier needs both to build a
//      realistic test.
//
// The verifier (separate task) generates a test that imports the
// action + calls it with a valid payload from the schema OR a form-
// action journey via Playwright. This detector ONLY surfaces the
// write surface; it does not generate the test.
export type ServerActionWriteHit = {
  template: "server-action-write";
  filePath: string;
  exportName: string;          // saveIdea
  schemaName?: string;         // IdeaInput  (when found)
  authGate?: string;           // isAdminAuthed  (when found)
  authPosture: AuthPosture;    // confirmed / ambiguous / none
  // 0.2.21+: import location of the auth helper. Captured so the
  // generated test can vi.mock() that module to flip auth-gate behavior
  // and actually go GREEN on the success path (vs. precondition-WARN
  // on the unauthorized branch). When present, the template emits both
  //   - "returns success with valid payload + session" (auth → true)
  //   - "rejects when unauthenticated" (auth → false)
  // The second case is what catches AI silently removing the auth gate
  // entirely — with only auth → true, gate-removal would still pass.
  authHelperImport?: { specifier: string; named: string };
  writeShape: WriteShape;
  isModuleLevelDirective: boolean;  // top-of-file vs inline
  suggestedPin: string;
};

// Regex/parse for "use server" directive at the top of a file (before
// any export). Trims leading comments + whitespace + imports.
function hasModuleLevelUseServer(content: string): boolean {
  // Strip block comments, line comments, and the standard ESM
  // `import ...` lines — none of those count as code preceding the
  // directive. We require the directive to appear BEFORE any
  // non-comment, non-import statement, otherwise Next ignores it.
  let i = 0;
  while (i < content.length) {
    // Skip whitespace.
    if (/\s/.test(content[i])) { i += 1; continue; }
    // Skip line comment.
    if (content.startsWith("//", i)) {
      const eol = content.indexOf("\n", i);
      i = eol === -1 ? content.length : eol + 1;
      continue;
    }
    // Skip block comment.
    if (content.startsWith("/*", i)) {
      const end = content.indexOf("*/", i + 2);
      i = end === -1 ? content.length : end + 2;
      continue;
    }
    // "use server" or 'use server' directive.
    const rest = content.slice(i, i + 20);
    if (/^['"]use server['"]\s*;?/.test(rest)) return true;
    // Skip import lines — they're allowed BEFORE the directive in
    // practice (some lints reorder), so we look past them too.
    if (content.startsWith("import", i)) {
      const eol = content.indexOf("\n", i);
      i = eol === -1 ? content.length : eol + 1;
      continue;
    }
    // First substantive non-comment-non-import token: bail.
    return false;
  }
  return false;
}

// Locate exported async function/arrow exports and return [name, body]
// pairs. body = the {...} block content (string slice).
function findExportedAsyncFunctions(content: string): Array<{ name: string; body: string }> {
  const results: Array<{ name: string; body: string }> = [];
  // Pattern A: export async function NAME(...) { ... }     (function decl)
  // Pattern B: export const NAME = async (...) => { ... }  (arrow)
  // Pattern C: export const NAME = async function (...) { ... }  (named-fn-expr)
  // Between `)` (close of param list) and `{` (or `=>` for arrows),
  // TypeScript permits a return-type annotation: `: Promise<T>`.
  // The earlier impl missed those — caught on socialideagen
  // `lib/ideaActions.ts`'s `saveIdea(input: unknown): Promise<SaveResult>`.
  const headerRe = /export\s+(?:async\s+function\s+(\w+)|const\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*async\b)/g;
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(content)) !== null) {
    const name = m[1] ?? m[2];
    if (!name) continue;
    const isArrow = !!m[2];
    let i = headerRe.lastIndex;
    // Skip whitespace.
    while (i < content.length && /\s/.test(content[i])) i += 1;
    // Param-list lookahead: many exports begin with `(` here. Walk past
    // the paren-balanced param list (handles `(input: unknown): X`).
    if (content[i] !== "(") {
      // For arrows, the pattern `async name => { ... }` (single param,
      // no parens) is allowed. Skip just whitespace and find `=>`.
      if (isArrow) {
        const arrowIdx = content.indexOf("=>", i);
        if (arrowIdx === -1 || arrowIdx > i + 200) continue;
        i = arrowIdx;
      } else {
        continue; // function decl MUST have ( — bail
      }
    } else {
      let depth = 1;
      let j = i + 1;
      while (j < content.length && depth > 0) {
        const ch = content[j];
        if (ch === "(" ) depth += 1;
        else if (ch === ")") depth -= 1;
        // Skip strings (in case a default param string contains `(`).
        else if (ch === '"' || ch === "'" || ch === "`") {
          const quote = ch;
          j += 1;
          while (j < content.length && content[j] !== quote) {
            if (content[j] === "\\") j += 1;
            j += 1;
          }
        }
        j += 1;
      }
      if (depth !== 0) continue;
      i = j; // just past the closing `)`
    }
    // Now we may have whitespace, then optionally `: ReturnType`, then
    // either `=>` (arrows) or `{` (function decls / async function).
    while (i < content.length && /\s/.test(content[i])) i += 1;
    if (content[i] === ":") {
      // Skip the return-type annotation. It ends at `=>` (arrow) or
      // `{` (decl). Scan forward respecting bracket depth so `Promise<{a:1}>`
      // doesn't terminate early.
      i += 1;
      let depth = 0;
      while (i < content.length) {
        const ch = content[i];
        if (depth === 0) {
          if (ch === "{") break;
          if (isArrow && ch === "=" && content[i + 1] === ">") break;
        }
        if (ch === "<" || ch === "(" || ch === "{" || ch === "[") depth += 1;
        else if (ch === ">" || ch === ")" || ch === "}" || ch === "]") {
          if (depth > 0) depth -= 1;
        }
        i += 1;
      }
    }
    if (isArrow) {
      // Skip `=>` and any whitespace.
      if (content.slice(i, i + 2) !== "=>") continue;
      i += 2;
      while (i < content.length && /\s/.test(content[i])) i += 1;
    } else {
      while (i < content.length && /\s/.test(content[i])) i += 1;
    }
    if (content[i] !== "{") continue;
    // Find matching `}` accounting for nesting. Skip strings + comments
    // so a `// }` inside the body doesn't unbalance us.
    let depth = 1;
    let j = i + 1;
    while (j < content.length && depth > 0) {
      const ch = content[j];
      if (ch === '"' || ch === "'" || ch === "`") {
        const quote = ch;
        j += 1;
        while (j < content.length) {
          if (content[j] === "\\") { j += 2; continue; }
          if (content[j] === quote) { j += 1; break; }
          // Template literal: handle ${...} as a nested expression.
          if (quote === "`" && content[j] === "$" && content[j + 1] === "{") {
            let tdepth = 1;
            j += 2;
            while (j < content.length && tdepth > 0) {
              if (content[j] === "{") tdepth += 1;
              else if (content[j] === "}") tdepth -= 1;
              j += 1;
            }
            continue;
          }
          j += 1;
        }
        continue;
      }
      if (ch === "/" && content[j + 1] === "/") {
        const eol = content.indexOf("\n", j);
        j = eol === -1 ? content.length : eol + 1;
        continue;
      }
      if (ch === "/" && content[j + 1] === "*") {
        const end = content.indexOf("*/", j + 2);
        j = end === -1 ? content.length : end + 2;
        continue;
      }
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      j += 1;
    }
    if (depth !== 0) continue;
    const body = content.slice(i + 1, j - 1);
    results.push({ name, body });
    headerRe.lastIndex = j;
  }
  return results;
}

// Captures the zod input-schema variable name from the function body.
// Looks for: `XxxInput.safeParse(...)`, `XxxInput.parse(...)`,
// `XxxSchema.safeParse(...)`, `Schema.parse(...)`, returning the
// identifier before `.safeParse`/`.parse` when it ends with -Input,
// -Schema, -Body, -Payload, -Args (PascalCase convention).
function extractSchemaName(body: string): string | undefined {
  const m = /\b([A-Z][A-Za-z0-9_]*?(?:Input|Schema|Body|Payload|Args))\.(?:safeParse|parse)\s*\(/.exec(body);
  return m ? m[1] : undefined;
}

// 0.2.21+: locate the import statement for an auth-helper function.
// Used by the Server Action verifier to emit `vi.mock(specifier)`
// in the generated test, so the action can be exercised on its
// success path (auth → true) AND its rejection path (auth → false)
// without a real session.
//
// Returns the import specifier (module path) and named export when
// the auth-helper was imported via a standard ESM named import:
//   import { isAdminAuthed } from "./adminAuth"
//   import { foo, isAdminAuthed, bar } from "./adminAuth"
//   import { isAdminAuthed as checkAdmin } from "./adminAuth"  (uses `as` alias)
//
// Does NOT match default imports (`import isAdminAuthed from ...`) or
// namespace imports (`import * as auth from ...`) since the mock shape
// differs. Those are valid edge cases for a follow-up.
function extractAuthHelperImport(
  content: string,
  authGate: string
): { specifier: string; named: string } | undefined {
  if (!authGate) return undefined;
  // The auth-helper might be the captured function name OR an aliased
  // name. Try both shapes.
  //
  // Pattern: `import { ..., <name>, ... } from "<specifier>"` where
  // <name> matches the captured authGate. We escape the auth-gate
  // name for regex use, but it should be a simple identifier so this
  // is conservative.
  if (!/^[A-Za-z_$][\w$.]*$/.test(authGate)) return undefined;
  // The dotted-call form (`auth.getUser`) means the imported name is
  // the prefix segment (`auth`). Otherwise it's the full name.
  const importedName = authGate.split(".")[0];
  const escaped = importedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Match named imports — allow whitespace, multi-line braces, alias.
  const re = new RegExp(
    "import\\s*(?:type\\s+)?\\{[^}]*?\\b" + escaped + "(?:\\s+as\\s+\\w+)?\\b[^}]*?\\}\\s*from\\s*['\"]([^'\"]+)['\"]",
    "s"
  );
  const m = re.exec(content);
  if (!m) return undefined;
  return { specifier: m[1], named: importedName };
}

// Captures an auth-gate call in the function body. Looks for the
// first call to a function whose name matches the auth-vocabulary
// pattern (case-insensitive). Returns the call expression source
// (e.g. "isAdminAuthed()" / "requireAuth(req)") so the verifier
// knows which gate to satisfy.
//
// 0.2.19+: expanded coverage. The original regex only matched
// "named auth-helper function calls". It missed real auth idioms
// dyad-app dogfood proved are common:
//   - Webhook signature verify (`crypto.timingSafeEqual`,
//     `crypto.subtle.verify`, `verifyWebhookSignature`, Stripe's
//     `webhooks.constructEvent`, Svix's `wh.verify`)
//   - Bearer/Authorization header checks (`req.headers.get("authorization")`
//     + comparison against env)
//   - Password / shared-secret env comparison (`password === ENV_VAR`,
//     `secret === process.env.X`)
//   - OAuth state-param validation (`state === ...`)
//   - Service-role-key check (`process.env.SUPABASE_SERVICE_ROLE_KEY`
//     + comparison)
//
// Returns a short label describing the auth idiom (used in sweep
// output). When undefined, the caller can downgrade the "NO_AUTH"
// alarm to a soft "auth pattern not auto-detected — verify" warning.
function extractAuthGate(body: string): string | undefined {
  // 1. Named helper-function calls. Widened per dyad-app audit:
  //    `requireRetellAgentScope`, `requireRetellApiKey`,
  //    `requireRetellToolScope` are all legitimate auth helpers that
  //    the original tight vocab missed (only Auth/Admin/Session/User/
  //    Role suffixes). Added Scope/ApiKey/Key/Token/Permission/Access.
  //    Anchored on the require/is prefix + camelCase boundary so
  //    `requireNonEmptyString` (string validator, real example from
  //    MediniDyad/_shared) does NOT match.
  const namedHelper = /\b(is(?:Admin|Authenticated|SignedIn|LoggedIn|Authed|Authorized|Authorised)\w*|require\w*(?:Auth|Admin|Session|User|Role|Scope|ApiKey|Key|Token|Permission|Access|Authorized|Authorised)\w*|getServerSession|currentUser|getUser|auth\.getUser)\s*\(/.exec(body);
  if (namedHelper) {
    // Defensive exclusion: avoid matching require-keyword variants
    // that share the auth suffixes but aren't auth (e.g.
    // requireApiKeyFormat would still match Key — fine. But the
    // pre-fix camelCase-boundary regex prevents requireNonEmptyString
    // matching since 'String' isn't in the suffix list).
    return namedHelper[1];
  }

  // 2. Webhook signature verification — well-known SDK calls.
  if (/\bstripe\s*\.\s*webhooks\s*\.\s*constructEvent\s*\(/.test(body)) return "stripe.webhooks.constructEvent";
  if (/\b(?:wh|svix)\s*\.\s*verify\s*\(/.test(body)) return "svix.verify";
  if (/\btwilio\s*\.\s*validateRequest\s*\(/.test(body)) return "twilio.validateRequest";

  // 3. Generic verify/validate calls — but only when the function name
  //    has an auth-noun suffix. Bare `validate(zodSchema)` and
  //    `checkPastTime(date)` (real example from MediniDyad's
  //    scheduleUtils) must NOT match. Confirmed FP risk via external
  //    audit. Whitelist of auth-shaped roots only.
  const verifyCall = /\b(verify(?:Webhook|Signature|Token|Request|Sender|Hmac|Jwt|Bearer|Sig|Auth|Session|Oidc|Pkce)\w*|validate(?:Webhook|Signature|Request|Token|Hmac|Jwt|Bearer|Sig|Auth|Session|Oidc)\w*|check(?:Webhook|Signature|Token|Hmac|Jwt|Bearer|Sig|Auth|Session|Oidc|Password|Secret)\w*|constructEvent|webhooks?\.verify)\s*\(/i.exec(body);
  if (verifyCall) return verifyCall[1];

  // 4. HMAC verification — `crypto.timingSafeEqual` (Node) or
  //    `crypto.subtle.verify` (Deno / Web Crypto) — almost always
  //    means "we're verifying an inbound signature." Either appearing
  //    in handler body = real auth.
  if (/\bcrypto\s*\.\s*timingSafeEqual\s*\(/.test(body)) return "crypto.timingSafeEqual";
  if (/\bcrypto\s*\.\s*subtle\s*\.\s*verify\s*\(/.test(body)) return "crypto.subtle.verify";

  // 5. Password / shared-secret env comparison — but the non-env side
  //    must be an INBOUND value (read from request body/headers/url).
  //    Without this tightening, `if (apiKey === process.env.OPENAI_API_KEY)`
  //    (a sanity check before an outbound call) gets labeled as a caller
  //    auth gate. Confirmed FP risk via external audit. Patterns we
  //    accept now require `body.X / headers.X / searchParams.get(X) /
  //    params.X / url.X` somewhere within ~120 chars of the comparison.
  const envCompareRe = new RegExp(
    // Inbound-shaped LHS  ==/!== env-shaped RHS
    "\\b(?:(?:req|request)?\\s*\\.?\\s*(?:body|headers|query|params)\\s*(?:\\.|\\[)\\s*['\"]?[\\w-]+['\"]?\\]?(?:\\s*(?:\\?\\.|\\.)\\s*\\w+)?|searchParams\\s*\\.\\s*get\\s*\\(\\s*['\"][\\w-]+['\"]\\s*\\)|(?:url|new\\s+URL[^)]*)\\.\\s*searchParams[^,)]*)" +
    "\\s*[!=]==?\\s*" +
    "(?:process\\s*\\.\\s*env\\s*\\.\\s*\\w*(?:PASSWORD|SECRET|TOKEN|API_KEY)\\w*|getEnv\\s*\\(\\s*['\"]?\\w*(?:PASSWORD|SECRET|TOKEN|API_KEY)\\w*['\"]?\\s*\\)|Deno\\s*\\.\\s*env\\s*\\.\\s*get\\s*\\(\\s*['\"]?\\w*(?:PASSWORD|SECRET|TOKEN|API_KEY)\\w*['\"]?\\s*\\))",
    "i"
  );
  // Try LHS=request RHS=env first, then reversed
  if (envCompareRe.test(body)) return "env-secret-compare";
  const envCompareReReversed = new RegExp(
    "(?:process\\s*\\.\\s*env\\s*\\.\\s*\\w*(?:PASSWORD|SECRET|TOKEN|API_KEY)\\w*|getEnv\\s*\\(\\s*['\"]?\\w*(?:PASSWORD|SECRET|TOKEN|API_KEY)\\w*['\"]?\\s*\\)|Deno\\s*\\.\\s*env\\s*\\.\\s*get\\s*\\(\\s*['\"]?\\w*(?:PASSWORD|SECRET|TOKEN|API_KEY)\\w*['\"]?\\s*\\))" +
    "\\s*[!=]==?\\s*" +
    "(?:(?:req|request)?\\s*\\.?\\s*(?:body|headers|query|params)\\s*(?:\\.|\\[)|searchParams\\s*\\.\\s*get\\s*\\()",
    "i"
  );
  if (envCompareReReversed.test(body)) return "env-secret-compare";

  // 6. Authorization header read followed by a comparison/parse.
  //    `req.headers.get("authorization")` / `req.headers["authorization"]`
  //    paired with a substring check, comparison, or parse call. Tight
  //    enough to skip CORS-only files (which mention "authorization"
  //    in Access-Control-Allow-Headers but don't read it).
  const hasAuthHeaderRead =
    /\breq\s*\.\s*headers\s*\.\s*get\s*\(\s*['"]authorization['"]/i.test(body) ||
    /\breq\s*\.\s*headers\s*\[\s*['"]authorization['"]\s*\]/i.test(body) ||
    /\bheaders\s*\.\s*authorization\b/i.test(body);
  const hasComparison = /\b(?:Bearer|bearer|startsWith|startswith|substring|split|trim|===|!==)\b/.test(body);
  if (hasAuthHeaderRead && hasComparison) return "Authorization header check";

  // 7. OAuth state-param validation. `state === ...` or
  //    `state !== ...` where `state` was read from a query / param
  //    earlier in the body. Tight: must have both `state` read and
  //    a comparison on it.
  const hasStateRead = /\b(?:searchParams\s*\.\s*get\s*\(\s*['"]state['"]|url\s*\.\s*searchParams|query\s*\.\s*state|params\s*\.\s*state|body\s*\.\s*state)\b/.test(body);
  const hasStateCheck = /\bstate\s*[!=]==?\s*/.test(body);
  if (hasStateRead && hasStateCheck) return "OAuth state validation";

  // (Removed) service-role-key check: a `if (!SUPABASE_SERVICE_ROLE_KEY)
  // throw` line is a config assertion, NOT a caller auth gate. Anyone
  // can still call the endpoint; the key just constructs the admin
  // client. Labeling these "confirmed" was hiding real auth gaps.
  // Confirmed via external audit on Ai-Book/generate-page-music +
  // MediniDyad/retell-web-call — both were labeled gated but actually
  // had no caller auth.

  return undefined;
}

export function detectServerActionWrites(
  filesByPath: Map<string, string>
): ServerActionWriteHit[] {
  const out: ServerActionWriteHit[] = [];
  const seenExports = new Set<string>();
  for (const [filePath, content] of filesByPath.entries()) {
    if (isTestPath(filePath)) continue;
    // Server Actions only live in TS/JS files (not .css, .json etc).
    if (!/\.(?:tsx?|jsx?|mjs|cjs)$/.test(filePath)) continue;

    const moduleDirective = hasModuleLevelUseServer(content);
    const exportedAsync = findExportedAsyncFunctions(content);
    if (exportedAsync.length === 0) continue;

    for (const { name, body } of exportedAsync) {
      const inlineDirective = /^\s*['"]use server['"]\s*;?/.test(body.trimStart());
      const isServerAction = moduleDirective || inlineDirective;
      if (!isServerAction) continue;

      const writeShape = detectWriteShape(body);
      if (!writeShape) continue; // require a real write — no fallbacks

      const key = `${filePath}:${name}`;
      if (seenExports.has(key)) continue;
      seenExports.add(key);

      const schemaName = extractSchemaName(body);
      const authGate = extractAuthGate(body);
      // Locate the auth helper's import statement so the generated
      // test can `vi.mock(specifier)` to flip auth-gate behavior and
      // actually go GREEN on the success path (vs. precondition-WARN
      // on the unauthorized branch). Search the FULL file content,
      // not just the function body — imports live at module top.
      const authHelperImport = authGate ? extractAuthHelperImport(content, authGate) : undefined;
      // Three-tier auth posture so sweep output can distinguish
      // truly-bare functions from ones with idioms we don't structure.
      let authPosture: AuthPosture;
      if (authGate) {
        authPosture = "confirmed";
      } else {
        // Tightened ambiguous-tier signals per external audit. See
        // detectEdgeFunctionWrites for full rationale.
        const hasAuthSignals =
          /\bcrypto\s*\.\s*(?:subtle|timingSafeEqual|createHmac)/.test(body) ||
          /\b(?:verify|validate|check)(?:Webhook|Signature|Token|Hmac|Auth|Session|Sig|Jwt|Bearer|Oidc|Pkce|Password|Secret|Request|Sender)\w*\s*\(/i.test(body) ||
          (
            (/\breq\s*\.\s*headers\s*\.\s*get\s*\(\s*['"]authorization['"]/i.test(body) ||
             /\breq\s*\.\s*headers\s*\[\s*['"]authorization['"]\s*\]/i.test(body) ||
             /\bheaders\s*\.\s*authorization\b/i.test(body)) &&
            /\b(?:Bearer|bearer|substring|startsWith|split|trim)\b/.test(body)
          ) ||
          /\bsearchParams\s*\.\s*get\s*\(\s*['"](?:state|code|token|verifier)['"]/i.test(body);
        authPosture = hasAuthSignals ? "ambiguous" : "none";
      }
      const verb =
        writeShape.kind === "email" ? "sends an email" :
        writeShape.kind === "queue" ? "enqueues a job" :
        `${writeShape.kind === "db-insert" ? "creates" : writeShape.kind === "db-update" ? "updates" : writeShape.kind === "db-upsert" ? "upserts" : "deletes"} a ${writeShape.target} record`;
      const authNote = authGate ? ` (gated by ${authGate})` : "";
      const schemaNote = schemaName ? ` with ${schemaName}-validated input` : "";

      out.push({
        template: "server-action-write",
        filePath,
        exportName: name,
        schemaName,
        authGate,
        authPosture,
        authHelperImport,
        writeShape,
        isModuleLevelDirective: moduleDirective,
        suggestedPin: `Server Action ${name}() in ${filePath} ${verb}${schemaNote}${authNote} (${writeShape.library})`,
      });
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────
// Paid-API call detector (0.2.19+, HEADLINE)
// ────────────────────────────────────────────────────────────
//
// Entry-point-agnostic. Fires on ANY .ts/.js file (skipping tests
// + scripts + node_modules + dist) that contains a paid-API call:
// Anthropic messages.create/parse/stream, OpenAI chat.completions
// or responses.create, Google Gemini generateContent, Stripe
// checkout/billingPortal/paymentIntents/charges.create.
//
// Adjacent to the Server Action detector — server-action-write
// catches the auth-gated WRITE inside a "use server" module; this
// catches paid-API calls EVERYWHERE: plain Express services
// (sAles repI/server/src/services/extraction.ts), API routes that
// aren't Server Actions, library helpers, anywhere.
//
// The bug class it stops:
//   1. AI silently swaps the model string ("claude-opus-4-7" →
//      "claude-haiku-3") — quality drop nobody notices until users
//      complain. The pin captures the model literal and asserts it
//      survives.
//   2. AI removes max_tokens / max_completion_tokens — unbounded
//      spend regression. The pin captures the cap presence.
//   3. AI silently removes the call entirely.
//
// Confirmed pattern across dyad-apps (sAles repI extraction.ts +
// socialideagen aiFill.ts already caught via Server Action route).
// Precision gate: requires SDK import in same file OR the SDK-
// named identifier (`anthropic.X` / `openai.X` / `stripe.X`).
//
// The headline marketing line: "Pinned guards every paid API call
// in your backend — not just the ones in Next.js Server Actions."

export type PaidApiCallHit = {
  template: "paid-api-call";
  filePath: string;
  provider: "anthropic" | "openai" | "google-gemini" | "stripe" | "stripe-checkout" | "stripe-portal";
  callExpr: string;            // e.g. "anthropic.messages.create"
  // Captured options literals — when present, the pin asserts they
  // still appear in the call's options object.
  modelString?: string;        // e.g. "claude-sonnet-4-6"
  hasMaxTokens?: boolean;      // true if `max_tokens` or `max_completion_tokens` was present
  suggestedPin: string;
};

// Patterns specifically for the paid-API detector. Subset of
// WRITE_SHAPE_PATTERNS that are confirmed paid endpoints (not
// list/retrieve/get which are cheaper read-only paths).
const PAID_API_CALL_PATTERNS: Array<{
  re: RegExp;
  provider: PaidApiCallHit["provider"];
  callExprFromMatch: (m: RegExpExecArray) => string;
}> = [
  // Anthropic — messages.create/parse/stream
  {
    re: /\b((?:anthropic|client|ai)\s*\.\s*messages\s*\.\s*(?:create|parse|stream))\s*\(/g,
    provider: "anthropic",
    callExprFromMatch: (m) => m[1].replace(/\s+/g, ""),
  },
  // OpenAI — chat.completions.create / responses.create / images.generate / embeddings.create
  {
    re: /\b((?:openai|client)\s*\.\s*chat\s*\.\s*completions\s*\.\s*create)\s*\(/g,
    provider: "openai",
    callExprFromMatch: (m) => m[1].replace(/\s+/g, ""),
  },
  {
    re: /\b((?:openai|client)\s*\.\s*responses\s*\.\s*create)\s*\(/g,
    provider: "openai",
    callExprFromMatch: (m) => m[1].replace(/\s+/g, ""),
  },
  {
    re: /\b((?:openai|client)\s*\.\s*images\s*\.\s*generate)\s*\(/g,
    provider: "openai",
    callExprFromMatch: (m) => m[1].replace(/\s+/g, ""),
  },
  {
    re: /\b((?:openai|client)\s*\.\s*embeddings\s*\.\s*create)\s*\(/g,
    provider: "openai",
    callExprFromMatch: (m) => m[1].replace(/\s+/g, ""),
  },
  // Google Gemini
  {
    re: /\b(gemini\s*\.\s*generateContent)\s*\(/g,
    provider: "google-gemini",
    callExprFromMatch: (m) => m[1].replace(/\s+/g, ""),
  },
  // Stripe — checkout / portal / paymentIntents / charges / subscriptions / customers
  {
    re: /\b(stripe\s*\.\s*checkout\s*\.\s*sessions\s*\.\s*create)\s*\(/g,
    provider: "stripe-checkout",
    callExprFromMatch: (m) => m[1].replace(/\s+/g, ""),
  },
  {
    re: /\b(stripe\s*\.\s*billingPortal\s*\.\s*sessions\s*\.\s*create)\s*\(/g,
    provider: "stripe-portal",
    callExprFromMatch: (m) => m[1].replace(/\s+/g, ""),
  },
  {
    re: /\b(stripe\s*\.\s*(?:paymentIntents|charges|subscriptions)\s*\.\s*create)\s*\(/g,
    provider: "stripe",
    callExprFromMatch: (m) => m[1].replace(/\s+/g, ""),
  },
];

// Which SDK imports gate which providers? File must import the SDK
// (directly OR via a local wrapper module — the wrapper name is what
// production code uses) for an identifier-based call to fire. Filters
// out `client.X` calls that aren't actually paid APIs (supabase client,
// redis client, etc.).
const PROVIDER_IMPORT_PATTERNS: Record<PaidApiCallHit["provider"], RegExp[]> = {
  anthropic: [
    /from\s+['"]@anthropic-ai\/sdk['"]/,
    /import\s+Anthropic\s+from/,
    /from\s+['"][^'"]*\/anthropic['"]/,
    /from\s+['"][^'"]*\/llm['"]/,
  ],
  openai: [
    /from\s+['"]openai['"]/,
    /from\s+['"][^'"]*\/openai['"]/,
  ],
  "google-gemini": [
    /from\s+['"]@google\/generative-ai['"]/,
    /from\s+['"][^'"]*\/gemini['"]/,
  ],
  // Stripe local wrappers are extremely common (`lib/stripe.ts`).
  // Accept any import path ending in `/stripe`, OR the SDK type
  // reference (`Stripe.Event` / `Stripe.Checkout.Session`), OR
  // `new Stripe(`.
  stripe: [
    /from\s+['"]stripe['"]/,
    /from\s+['"][^'"]*\/stripe(?:\.js)?['"]/,
    /\bStripe\s*\.\s*(?:Event|Checkout|Subscription|Customer|Invoice|PaymentIntent|Charge|BillingPortal)\b/,
    /\bnew\s+Stripe\s*\(/,
  ],
  "stripe-checkout": [
    /from\s+['"]stripe['"]/,
    /from\s+['"][^'"]*\/stripe(?:\.js)?['"]/,
    /\bStripe\s*\.\s*(?:Checkout|BillingPortal)\b/,
    /\bnew\s+Stripe\s*\(/,
  ],
  "stripe-portal": [
    /from\s+['"]stripe['"]/,
    /from\s+['"][^'"]*\/stripe(?:\.js)?['"]/,
    /\bStripe\s*\.\s*BillingPortal\b/,
    /\bnew\s+Stripe\s*\(/,
  ],
};

// Extract the model string from a call's options-object literal.
// Slices forward from the opening `(` to the matching `)`, then
// scans for `model: "..."` or `model: '...'`. Returns the captured
// string when found.
function extractCallOptionsField(
  content: string,
  openParenIdx: number,
  field: string
): string | null {
  // Find matching close-paren, paren-balanced + string-aware.
  let depth = 1;
  let j = openParenIdx + 1;
  while (j < content.length && depth > 0) {
    const ch = content[j];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      j += 1;
      while (j < content.length) {
        if (content[j] === "\\") { j += 2; continue; }
        if (content[j] === quote) { j += 1; break; }
        j += 1;
      }
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    j += 1;
  }
  if (depth !== 0) return null;
  const args = content.slice(openParenIdx + 1, j - 1);
  // Match `<field>: "<value>"` with optional whitespace.
  const fieldRe = new RegExp(`\\b${field}\\s*:\\s*['"]([^'"\\n]+)['"]`);
  const m = fieldRe.exec(args);
  return m ? m[1] : null;
}

function hasField(content: string, openParenIdx: number, field: string): boolean {
  // Same slicing as above. Cheap presence check.
  let depth = 1;
  let j = openParenIdx + 1;
  while (j < content.length && depth > 0) {
    const ch = content[j];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      j += 1;
      while (j < content.length) {
        if (content[j] === "\\") { j += 2; continue; }
        if (content[j] === quote) { j += 1; break; }
        j += 1;
      }
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    j += 1;
  }
  if (depth !== 0) return false;
  const args = content.slice(openParenIdx + 1, j - 1);
  return new RegExp(`\\b${field}\\s*:`).test(args);
}

export function detectPaidApiCalls(
  filesByPath: Map<string, string>
): PaidApiCallHit[] {
  const out: PaidApiCallHit[] = [];
  const seen = new Set<string>();
  for (const [filePath, content] of filesByPath.entries()) {
    if (isTestPath(filePath)) continue;
    if (!/\.(?:tsx?|jsx?|mjs|cjs)$/.test(filePath)) continue;
    // Skip scripts / migrations / seed files — those are operator-run
    // one-shots, not production code paths. FP-prone.
    if (/(?:^|\/)(?:scripts|migrations|seeds|seed)\//.test(filePath)) continue;

    for (const pat of PAID_API_CALL_PATTERNS) {
      // Reset stateful regex.
      pat.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pat.re.exec(content)) !== null) {
        // Gate: file must import the SDK. Otherwise `client.X` calls
        // on a supabase / redis / etc. client would false-positive.
        const importPatterns = PROVIDER_IMPORT_PATTERNS[pat.provider];
        const sdkImported = importPatterns.some((rp) => rp.test(content));
        if (!sdkImported) continue;

        const callExpr = pat.callExprFromMatch(m);
        const openParen = m.index + m[0].length - 1;
        // Heuristic: only extract model for SDKs where it matters
        // (Anthropic/OpenAI/Gemini). Stripe doesn't take a model
        // parameter, but it does have other invariants.
        const modelString =
          pat.provider === "anthropic" || pat.provider === "openai" || pat.provider === "google-gemini"
            ? extractCallOptionsField(content, openParen, "model") ?? undefined
            : undefined;
        const hasMaxTokens =
          pat.provider === "anthropic"
            ? hasField(content, openParen, "max_tokens")
            : pat.provider === "openai"
              ? hasField(content, openParen, "max_completion_tokens") || hasField(content, openParen, "max_tokens")
              : undefined;

        const key = `${filePath}::${callExpr}::${modelString ?? "*"}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const modelNote = modelString ? ` · model=${modelString}` : "";
        const capNote = hasMaxTokens === true ? " · max_tokens set" : hasMaxTokens === false ? " · ⚠ no max_tokens (unbounded spend risk)" : "";
        out.push({
          template: "paid-api-call",
          filePath,
          provider: pat.provider,
          callExpr,
          modelString,
          hasMaxTokens,
          suggestedPin: `Paid API call ${callExpr}() in ${filePath} (${pat.provider})${modelNote}${capNote} — silent removal, model swap, or token-cap removal goes uncaught without a pin.`,
        });
      }
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────
// Supabase Edge Function detector (0.2.19+)
// ────────────────────────────────────────────────────────────
//
// Closes another App-Router-adjacent blind spot. Edge Functions
// at `supabase/functions/<name>/index.ts` carry the same shape as
// Server Actions — auth gate + DB write — but use `Deno.serve(...)`
// as entry point instead of "use server". MediniDyad has 127
// functions, ~47 of them write-bearing. Currently invisible to all
// existing detectors (no HTTP route convention match, no "use server"
// directive).
//
// Detection signature (precision-gated):
//   1. Path matches supabase/functions/<name>/index.ts
//   2. Content contains `Deno.serve(` (the entry-point convention)
//   3. Content contains a recognized write shape (DB write / file
//      upload / outbound paid-API call)
//
// All three required. Reuses the Server Action template machinery
// (auth-gate + schema-name extraction); the verifier emits a static
// "function file exists + write call still present" pin — direct
// invoke isn't feasible in vitest since these run in Deno runtime.
// Three-tier auth posture so the sweep output can distinguish:
//   - "confirmed": recognized auth idiom (named helper / signature
//     verify / env-secret compare / etc.). Display "gated by X".
//   - "ambiguous": file has auth-shaped signals (crypto, header
//     reads, env-SECRET references, verify/validate calls) but the
//     structured extractor didn't recognize them. Soft warning.
//   - "none": no auth signal at all. Strong warning — likely real gap.
export type AuthPosture = "confirmed" | "ambiguous" | "none";

export type EdgeFunctionWriteHit = {
  template: "edge-function-write";
  filePath: string;
  functionName: string;  // <name> from the path
  writeShape: WriteShape;
  authGate?: string;
  authPosture: AuthPosture;
  suggestedPin: string;
};

export function detectEdgeFunctionWrites(
  filesByPath: Map<string, string>
): EdgeFunctionWriteHit[] {
  const out: EdgeFunctionWriteHit[] = [];
  for (const [filePath, content] of filesByPath.entries()) {
    if (isTestPath(filePath)) continue;
    const pathMatch = /(?:^|\/)supabase\/functions\/([^/]+)\/index\.(?:ts|tsx|js|jsx|mjs)$/.exec(filePath);
    if (!pathMatch) continue;
    const functionName = pathMatch[1];
    // Two entry-point conventions in Supabase Edge Functions:
    //   (a) `Deno.serve(...)`  — newer template
    //   (b) `import { serve } from "https://deno.land/std/.../server.ts"`
    //       + `serve(async (req) => ...)`  — older template
    // Path constraint already locks us to supabase/functions/<X>/index.ts
    // so a bare `serve(` doesn't false-positive elsewhere.
    const hasDenoServe = /\bDeno\s*\.\s*serve\s*\(/.test(content);
    const hasImportedServe = /\bimport\s*\{\s*serve\s*\}\s+from\s+['"]https:\/\/deno\.land\/std[^'"]+['"]/.test(content) && /\bserve\s*\(/.test(content);
    if (!hasDenoServe && !hasImportedServe) continue;
    const writeShape = detectWriteShape(content);
    if (!writeShape) continue;
    // Use the same widened auth-gate extractor as Server Actions —
    // covers named helpers, webhook-signature verify, HMAC verify,
    // password/secret env compare, Authorization-header check, OAuth
    // state validation, service-role key check.
    const authGate = extractAuthGate(content);
    // Three-tier posture: confirmed (extractor matched), ambiguous
    // (auth-shaped signals present but unrecognized), none (no signal
    // at all — almost certainly a real auth gap).
    let authPosture: AuthPosture;
    if (authGate) {
      authPosture = "confirmed";
    } else {
      // Ambiguous signals — auth-shaped patterns that suggest the
      // detector might be missing a structured idiom. Tightened per
      // external audit so this tier doesn't engulf the "none" bucket
      // (then "verify" becomes meaningless noise).
      //
      // Rules:
      //   1. crypto.subtle / timingSafeEqual / createHmac — strong
      //      inbound-verify signal (almost never appears in pure
      //      outbound code).
      //   2. verify/validate/check call with an AUTH-NOUN suffix —
      //      tight vocab so checkPastTime / validateEnv / validate(zod)
      //      don't FP.
      //   3. INBOUND Authorization-header READ (not just CORS string
      //      mention or outbound Bearer-template). `req.headers.get`
      //      / `req.headers["..."]` / `headers.authorization`.
      //   4. OAuth-shaped param reads (state / code / verifier).
      //   5. (Removed) bare env-secret references — too universal;
      //      every outbound-API file has them. Without paired comparison
      //      they signal nothing about caller auth.
      const hasAuthSignals =
        /\bcrypto\s*\.\s*(?:subtle|timingSafeEqual|createHmac)/.test(content) ||
        /\b(?:verify|validate|check)(?:Webhook|Signature|Token|Hmac|Auth|Session|Sig|Jwt|Bearer|Oidc|Pkce|Password|Secret|Request|Sender)\w*\s*\(/i.test(content) ||
        (
          (/\breq\s*\.\s*headers\s*\.\s*get\s*\(\s*['"]authorization['"]/i.test(content) ||
           /\breq\s*\.\s*headers\s*\[\s*['"]authorization['"]\s*\]/i.test(content) ||
           /\bheaders\s*\.\s*authorization\b/i.test(content)) &&
          /\b(?:Bearer|bearer|substring|startsWith|split|trim)\b/.test(content)
        ) ||
        /\bsearchParams\s*\.\s*get\s*\(\s*['"](?:state|code|token|verifier)['"]/i.test(content);
      authPosture = hasAuthSignals ? "ambiguous" : "none";
    }
    const verb =
      writeShape.kind === "email" ? "sends email" :
      writeShape.kind === "queue" ? "enqueues job" :
      writeShape.kind === "file-upload" ? `uploads to ${writeShape.target}` :
      writeShape.kind === "http-post" ? `calls ${writeShape.library}` :
      `${writeShape.kind === "db-insert" ? "inserts" : writeShape.kind === "db-update" ? "updates" : writeShape.kind === "db-upsert" ? "upserts" : "deletes"} ${writeShape.target}`;
    const authNote = authGate ? ` (gated by ${authGate})` : "";
    out.push({
      template: "edge-function-write",
      filePath,
      functionName,
      writeShape,
      authGate,
      authPosture,
      suggestedPin: `Supabase Edge Function "${functionName}" ${verb}${authNote} — invisible to HTTP-route detection (runs in Deno).`,
    });
  }
  return out;
}

// ────────────────────────────────────────────────────────────
// Cron handler detector (Vercel + GH Actions) (0.2.19+)
// ────────────────────────────────────────────────────────────
//
// Cron handlers fire WITHOUT a user in the loop. If auth is dropped,
// or the handler URL is renamed, or the schedule silently drifts,
// nothing in normal e2e testing catches it — the cron just stops.
// quantapact has 11 Vercel crons (rollup, scan, email-deliver, etc.);
// quantasyte + pinnedai have GH Actions cron schedules.
//
// Detection signature:
//   (a) Vercel: parse `vercel.json` → `crons[]` array. For each
//       `{path, schedule}` entry, resolve `api/<path-suffix>.ts` or
//       `app/api/<path-suffix>/route.ts` and pin handler-exists +
//       schedule-string-preserved.
//   (b) GH Actions: parse `.github/workflows/*.yml` → `on.schedule[]`.
//       Pin the workflow file + schedule string preserved.
//
// Light parsing (regex, not full YAML) — robust to surface drift,
// and the only fields we read are flat strings.

export type CronHandlerHit = {
  template: "cron-handler";
  source: "vercel" | "github-actions";
  schedule: string;             // "0 4 * * *"
  // For vercel: the cron path (e.g. "/api/cron/scan-peers")
  // For github-actions: the workflow file path
  identifier: string;
  // The file that declares the cron (vercel.json or workflow yaml)
  declarationFile: string;
  // For vercel only: the resolved handler file path
  handlerFile?: string;
  suggestedPin: string;
};

export function detectCronHandlers(
  filesByPath: Map<string, string>
): CronHandlerHit[] {
  const out: CronHandlerHit[] = [];
  // Vercel: vercel.json at repo root or workspace root
  for (const [filePath, content] of filesByPath.entries()) {
    if (!/(?:^|\/)vercel\.json$/.test(filePath)) continue;
    let parsed: { crons?: Array<{ path?: unknown; schedule?: unknown }> } | null = null;
    try {
      parsed = JSON.parse(content);
    } catch { continue; }
    if (!parsed?.crons || !Array.isArray(parsed.crons)) continue;
    for (const cron of parsed.crons) {
      if (typeof cron?.path !== "string" || typeof cron?.schedule !== "string") continue;
      // Resolve handler file. Vercel paths like `/api/cron/scan-peers`
      // map to `api/cron/scan-peers.ts` (pages-style) or
      // `app/api/cron/scan-peers/route.ts` (app-router). Try both.
      const pathSuffix = cron.path.replace(/^\//, "");
      const candidates = [
        `${pathSuffix}.ts`,
        `${pathSuffix}.tsx`,
        `${pathSuffix}.js`,
        `${pathSuffix}.mjs`,
        `app/${pathSuffix}/route.ts`,
        `app/${pathSuffix}/route.tsx`,
        `app/${pathSuffix}/route.js`,
      ];
      let handlerFile: string | undefined;
      for (const c of candidates) {
        if (filesByPath.has(c)) { handlerFile = c; break; }
      }
      out.push({
        template: "cron-handler",
        source: "vercel",
        schedule: cron.schedule,
        identifier: cron.path,
        declarationFile: filePath,
        handlerFile,
        suggestedPin: `Vercel cron "${cron.path}" runs on "${cron.schedule}"${handlerFile ? ` → ${handlerFile}` : " (handler file unresolved)"}. Schedule drift or handler rename = silent SLA break (cron stops, no user notices).`,
      });
    }
  }
  // GitHub Actions: .github/workflows/*.yml with on.schedule[].cron
  for (const [filePath, content] of filesByPath.entries()) {
    if (!/(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(filePath)) continue;
    // Lightweight YAML-shape scan. We only need the cron strings.
    // Look for `schedule:` indented under `on:`, then `- cron: "..."`
    // entries. Tolerant of `on: {schedule: [{cron: ...}]}` JSON-flow too.
    const cronMatches = Array.from(content.matchAll(/\bcron\s*:\s*["']([^"'\n]+)["']/g));
    if (cronMatches.length === 0) continue;
    // Also confirm we're under an `on.schedule` block (not random
    // `cron:` keys in env). Loose check: presence of `schedule:` and
    // the cron must be after `on:`.
    const onIdx = content.indexOf("on:");
    const scheduleIdx = content.indexOf("schedule:");
    if (onIdx === -1 || scheduleIdx === -1 || scheduleIdx < onIdx) continue;
    for (const m of cronMatches) {
      const schedule = m[1];
      // Cron string sanity: 5 fields (basic) or 6 (with seconds).
      if (!/^[*\d,\-/?LWa-zA-Z\s]+$/.test(schedule)) continue;
      const parts = schedule.trim().split(/\s+/);
      if (parts.length < 5 || parts.length > 6) continue;
      out.push({
        template: "cron-handler",
        source: "github-actions",
        schedule,
        identifier: filePath,
        declarationFile: filePath,
        suggestedPin: `GitHub Actions workflow ${filePath} runs on "${schedule}". Schedule drift = silent SLA break.`,
      });
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────
// Enum-drift detector (0.2.22+) — FIRST-TIME bug catching
// ────────────────────────────────────────────────────────────
//
// Pinned's whole model is regression-detection — assumes a green
// baseline to regress from. The user dogfood that triggered this
// detector: socialideagen client polled `status === "done"` but
// the producer (separate-repo daemon) wrote `status === "completed"`.
// First-time integration bug. No prior baseline to regress from.
// All other Pinned detectors ran clean. The bug shipped.
//
// This detector catches the IN-REPO variant of that class: when a
// consumer reads `x === "literal"` (or `switch (x) { case "literal" }`)
// for a discriminant value that the producer NEVER emits anywhere
// in the same codebase. Precision-gated — won't fire on external-
// producer reads (no in-repo producer writes → no signal).
//
// Cross-repo variant (the specific socialideagen bug) needs a
// declared contract artifact both sides reference; deferred to a
// follow-on release.
//
// Precision gates (load-bearing — keep tight):
//   1. Only flag values where AT LEAST ONE in-repo producer write
//      exists for the same column. No producer in repo = external
//      producer = no signal (don't FP on every API client).
//   2. Column-name matching is by literal field name only. If
//      consumer reads `job.status` and producer writes
//      `update({ status: "X" })`, group as same column. We don't
//      do type-flow analysis.
//   3. Bare-variable consumer reads (`status === "X"` without an
//      object prefix) are accepted ONLY when the same file has
//      a destructuring assignment matching the column name
//      (`const { status } = job`) — otherwise we can't safely
//      infer the column.
//   4. Skip test files + scripts + migrations.

export type EnumDriftHit = {
  template: "enum-drift";
  // The consumer file that reads a value the producer doesn't emit.
  consumerFile: string;
  // The column / discriminant being compared.
  column: string;
  // The set of values the consumer compares against.
  expectedValues: string[];
  // The full set of values the producer emits anywhere in repo.
  observedValues: string[];
  // The values the consumer reads but the producer never emits — the
  // drift. These are the bug candidates.
  missingFromProducer: string[];
  // Sample of producer write sites (file:line excerpts) so the user
  // can verify the detector found the right producer. First 3.
  producerSamples: Array<{ filePath: string; column: string; value: string }>;
  // Confidence tier:
  //   * "confirmed" — consumer + producer share ≥1 vocabulary value
  //                   (same domain, real drift on a specific value).
  //                   Low FP risk.
  //   * "review"    — zero overlap. Column name shared but values
  //                   completely disjoint — usually a cross-table
  //                   column-name collision, OCCASIONALLY the user's
  //                   exact cross-repo bug shape (in-repo producer
  //                   doesn't write to the column at all but consumer
  //                   compares values from an external producer). The
  //                   socialideagen `status === "done"` shape lives
  //                   here. Pinned doesn't auto-pin "review" hits —
  //                   user confirms before they ship.
  confidence: "confirmed" | "review";
  suggestedPin: string;
};

// Patterns:
//   * Producer write — object-literal field with a STRING value:
//     `update({ status: "X" })`, `insert({ status: "X" })`,
//     `upsert({ status: "X" })`, `data: { status: "X" }`,
//     `return { ..., status: "X", ... }` (any object literal).
//   * Consumer read — comparison or switch-case:
//     `x.col === "Y"`, `x.col !== "Y"`,
//     `switch (x.col) { case "Y": }`,
//     destructured + bare: `const { col } = x; ... col === "Y"`,
//     `[col, ...].includes("Y")` (one variant).
//
// We collect both sides per column name, then for each consumer-read
// (column, value), check if (column, value) is in the producer write
// set. If not, AND there's at least one producer write to (column, *),
// emit a drift hit.

// Extract producer writes from content. Returns array of
// (column, value) tuples + the line excerpt for sample collection.
function extractProducerWrites(content: string): Array<{ column: string; value: string; sample: string }> {
  const out: Array<{ column: string; value: string; sample: string }> = [];
  // Strip comments first so a // commented update() doesn't fire.
  const stripped = content.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  // Find object literals: `{ ..., <col>: "<value>", ... }`. Match a
  // field-name + string-literal pair where the value is a simple
  // ASCII identifier-shaped or kebab-shaped string (lowercase a-z,
  // 0-9, _, -). This filters out user-facing messages / long strings.
  const fieldRe = /(?:^|[\s,{(])([a-zA-Z_$][\w$]*)\s*:\s*['"]([a-zA-Z][\w-]*)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = fieldRe.exec(stripped)) !== null) {
    const column = m[1];
    const value = m[2];
    // Skip generic identifier names that are nearly always non-enum
    // (id / key / name / etc would FP).
    if (GENERIC_FIELD_NAMES.has(column.toLowerCase())) continue;
    // Skip generic values that are almost certainly not enums.
    if (GENERIC_VALUE_TOKENS.has(value.toLowerCase())) continue;
    // Extract the line excerpt for the sample.
    const lineStart = stripped.lastIndexOf("\n", m.index) + 1;
    const lineEnd = stripped.indexOf("\n", m.index);
    const sample = stripped.slice(lineStart, lineEnd === -1 ? stripped.length : lineEnd).trim().slice(0, 120);
    out.push({ column, value, sample });
  }
  return out;
}

// Consumer reads — values being compared.
function extractConsumerReads(
  content: string
): Array<{ column: string; value: string; line: number }> {
  const out: Array<{ column: string; value: string; line: number }> = [];
  const stripped = content.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  // 1. Property-access comparison: `x.col === "Y"` or `x.col !== "Y"`.
  const propEqRe = /\b\w+(?:\??\.\w+)*\.([a-zA-Z_$][\w$]*)\s*[!=]==?\s*['"]([a-zA-Z][\w-]*)['"]/g;
  // 2. Reverse: `"Y" === x.col`.
  const propEqReversedRe = /['"]([a-zA-Z][\w-]*)['"]\s*[!=]==?\s*\b\w+(?:\??\.\w+)*\.([a-zA-Z_$][\w$]*)\b/g;
  // 3. switch (x.col) { case "Y": ... }
  const switchPropRe = /\bswitch\s*\(\s*\w+(?:\??\.\w+)*\.([a-zA-Z_$][\w$]*)\s*\)\s*\{([\s\S]*?)\n\s*\}/g;
  // 4. .includes("Y") on a member-access chain.
  const includesRe = /\b\w+(?:\??\.\w+)*\.([a-zA-Z_$][\w$]*)\s*\.\s*(?:includes|startsWith|endsWith)\s*\(\s*['"]([a-zA-Z][\w-]*)['"]/g;
  // 5. Bare-variable comparison: `status === "Y"`. Only accepted when
  //    the file has a destructure-from-object earlier: `const { status } = x;`
  //    Captures column name from destructure.
  const destructured = new Set<string>();
  const destructureRe = /\bconst\s*\{\s*([^}]+)\s*\}\s*=\s*(?!require)\w/g;
  let dm: RegExpExecArray | null;
  while ((dm = destructureRe.exec(stripped)) !== null) {
    for (const name of dm[1].split(",").map((s) => s.trim().split(":")[0].trim())) {
      if (/^[a-zA-Z_$][\w$]*$/.test(name) && !GENERIC_FIELD_NAMES.has(name.toLowerCase())) {
        destructured.add(name);
      }
    }
  }
  // Now scan bare-variable comparisons but only for destructured names.
  const bareEqRe = /\b([a-zA-Z_$][\w$]*)\s*[!=]==?\s*['"]([a-zA-Z][\w-]*)['"]/g;
  const seen = new Set<string>();
  function addRead(column: string, value: string, idx: number) {
    if (GENERIC_FIELD_NAMES.has(column.toLowerCase())) return;
    if (GENERIC_VALUE_TOKENS.has(value.toLowerCase())) return;
    const key = `${column}::${value}::${idx}`;
    if (seen.has(key)) return;
    seen.add(key);
    const line = (stripped.slice(0, idx).match(/\n/g) || []).length + 1;
    out.push({ column, value, line });
  }

  let m: RegExpExecArray | null;
  while ((m = propEqRe.exec(stripped)) !== null) addRead(m[1], m[2], m.index);
  while ((m = propEqReversedRe.exec(stripped)) !== null) addRead(m[2], m[1], m.index);
  while ((m = includesRe.exec(stripped)) !== null) addRead(m[1], m[2], m.index);
  while ((m = switchPropRe.exec(stripped)) !== null) {
    const column = m[1];
    const body = m[2];
    const caseRe = /\bcase\s+['"]([a-zA-Z][\w-]*)['"]/g;
    let cm: RegExpExecArray | null;
    while ((cm = caseRe.exec(body)) !== null) addRead(column, cm[1], m.index + body.indexOf(cm[0]));
  }
  while ((m = bareEqRe.exec(stripped)) !== null) {
    if (destructured.has(m[1])) addRead(m[1], m[2], m.index);
  }
  return out;
}

// Field names that are NEVER worth treating as enum columns. These
// almost always carry IDs / display strings / opaque user content.
const GENERIC_FIELD_NAMES = new Set([
  "id", "uuid", "key", "name", "title", "description", "email",
  "url", "href", "src", "path", "to", "from", "by", "for", "of",
  "as", "at", "on", "in", "is", "or", "if", "do", "no",
  "value", "data", "result", "response", "request", "input", "output",
  "message", "content", "text", "body", "html", "subject", "label",
  "username", "password", "phone", "address", "city", "country", "zip",
  "image", "avatar", "icon", "logo", "thumbnail", "color", "size",
  "user", "userId", "user_id", "customer", "customerId", "account",
  "amount", "price", "total", "count", "quantity", "rate", "limit",
  "version", "build", "hash", "sha", "ref", "commit", "branch",
  // Lowercase TypeScript / JS keywords + common destructured names
  // that aren't enum-y.
  "type", // too generic — we have a Stripe-event detector for `event.type`
  "kind", // overloaded
  "code", // HTTP code / lang code / error code — different domains
  "role", // already covered by permission-required
]);

// String tokens that are too generic to be enum drift candidates.
const GENERIC_VALUE_TOKENS = new Set([
  "true", "false", "null", "undefined", "0", "1", "yes", "no",
  "string", "number", "object", "boolean", "function",
  "get", "post", "put", "patch", "delete", "options", "head",
  // Module / loader keywords
  "module", "default", "exports", "require",
]);

export function detectEnumDrift(filesByPath: Map<string, string>): EnumDriftHit[] {
  // Pass 1: producer writes — per (column, value), record which files write it.
  const producerWrites = new Map<string, Map<string, Array<{ filePath: string; sample: string }>>>();
  // producerColumns: just the set of columns that have ANY in-repo writer
  // (precision gate — no in-repo writer = external producer, skip).
  const producerColumns = new Set<string>();

  for (const [filePath, content] of filesByPath.entries()) {
    if (isTestPath(filePath)) continue;
    if (!/\.(?:tsx?|jsx?|mjs|cjs)$/.test(filePath)) continue;
    if (/(?:^|\/)(?:scripts|migrations|seeds|seed|fixtures)\//.test(filePath)) continue;
    const writes = extractProducerWrites(content);
    for (const { column, value, sample } of writes) {
      producerColumns.add(column);
      if (!producerWrites.has(column)) producerWrites.set(column, new Map());
      const valMap = producerWrites.get(column)!;
      if (!valMap.has(value)) valMap.set(value, []);
      valMap.get(value)!.push({ filePath, sample });
    }
  }

  // Pass 2: consumer reads. For each (consumer-file, column), collect
  // all values + check against producer-emit set.
  const consumerReadsByFileColumn = new Map<string, { column: string; values: Map<string, number[]> }>();
  for (const [filePath, content] of filesByPath.entries()) {
    if (isTestPath(filePath)) continue;
    if (!/\.(?:tsx?|jsx?|mjs|cjs)$/.test(filePath)) continue;
    const reads = extractConsumerReads(content);
    for (const { column, value, line } of reads) {
      // Precision gate: only consider columns the producer also writes.
      if (!producerColumns.has(column)) continue;
      const key = `${filePath}::${column}`;
      if (!consumerReadsByFileColumn.has(key)) {
        consumerReadsByFileColumn.set(key, { column, values: new Map() });
      }
      const entry = consumerReadsByFileColumn.get(key)!;
      if (!entry.values.has(value)) entry.values.set(value, []);
      entry.values.get(value)!.push(line);
    }
  }

  // Pass 3: emit drift hits.
  const out: EnumDriftHit[] = [];
  for (const [key, { column, values }] of consumerReadsByFileColumn) {
    const [consumerFile] = key.split("::");
    const producerValuesMap = producerWrites.get(column) ?? new Map();
    const observedValues = Array.from(producerValuesMap.keys()).sort();
    const expectedValues = Array.from(values.keys()).sort();
    const missingFromProducer = expectedValues.filter((v) => !producerValuesMap.has(v));
    if (missingFromProducer.length === 0) continue;
    const overlap = expectedValues.filter((v) => producerValuesMap.has(v));
    // Precision gates:
    //   (a) Drop when producer's value set is too large to be enum-like
    //       (likely an id-like column that slipped past the generic
    //       filter — e.g., a column with 30+ distinct string literals).
    //   (b) Drop when 100% missing AND producer set is tiny (≤2) —
    //       the signal is too weak to call. Could be the user's bug
    //       OR a column collision. Without ≥3 producer writes the
    //       evidence is too thin either way.
    if (observedValues.length > 12) continue;
    if (missingFromProducer.length === expectedValues.length && observedValues.length < 3) continue;
    // Confidence tier: shared vocabulary → confirmed; zero overlap →
    // review. Most cross-table column-name collisions land in review.
    const confidence: EnumDriftHit["confidence"] = overlap.length > 0 ? "confirmed" : "review";

    // Collect producer samples (3 max).
    const samples: Array<{ filePath: string; column: string; value: string }> = [];
    for (const v of observedValues.slice(0, 3)) {
      const writes = producerValuesMap.get(v) ?? [];
      if (writes.length > 0) samples.push({ filePath: writes[0].filePath, column, value: v });
    }

    const confidenceNote = confidence === "review"
      ? " (REVIEW — zero overlap with in-repo producer; may be a cross-table column collision OR a cross-repo external-producer drift)"
      : "";
    out.push({
      template: "enum-drift",
      consumerFile,
      column,
      expectedValues,
      observedValues,
      missingFromProducer,
      producerSamples: samples,
      confidence,
      suggestedPin: `Enum drift in ${consumerFile} on column "${column}": consumer reads ${missingFromProducer.map((v) => `"${v}"`).join(", ")} but in-repo producer only emits ${observedValues.map((v) => `"${v}"`).join(", ")}.${confidenceNote} First-time bug class — won't be caught by regression pins.`,
    });
  }
  return out;
}

// ────────────────────────────────────────────────────────────
// Stripe webhook event-type dispatch detector (0.2.19+)
// ────────────────────────────────────────────────────────────
//
// Adjacent to detectWebhookSignaturePins (which catches "signature
// verify is still wired"). This one catches the dispatch layer:
// the `switch (event.type) { case "checkout.session.completed": ... }`
// block routing each verified event to its handler.
//
// The bug it stops: AI silently typos `case "checkout.session.complete":`
// (one-letter rename), or merges two arms into a fallthrough that drops
// one of them, or wholesale deletes a case while "cleaning up." The
// signature still verifies — and paying customers never get provisioned.
// Confirmed pattern across 3 dyad-apps (quantapact tier-webhook +
// badge-webhook + quantasyte billing.ts), each gating real money flows.
//
// Precision-gated:
//   1. File must contain `stripe.webhooks.constructEvent` (the verify
//      call) — narrows to actual Stripe webhook handlers.
//   2. File must contain a `switch` block whose discriminant is
//      `event.type` or `<destructured-from-event>.type` or
//      `<single-identifier>` that was assigned from `event.type`.
//   3. The switch block must contain at least one `case "<event-name>":`
//      arm where the event name matches Stripe's well-known event-name
//      shape (`<resource>.<action>` like `customer.subscription.updated`).
//
// All three required → emit hit. Skipping any one prevents false
// positives on generic event-bus files / Node.js EventEmitter
// dispatchers that happen to be in the same repo.
export type StripeEventDispatchHit = {
  template: "stripe-event-handled";
  filePath: string;
  events: string[];           // ["checkout.session.completed", ...]
  suggestedPin: string;
};

// Stripe event-name shape: `<segment>.<segment>(.<segment>)?` with
// lowercase + underscores. Examples: "customer.subscription.updated",
// "invoice.payment_failed", "checkout.session.completed",
// "payment_intent.succeeded". Tight enough to reject "default" /
// "string" / arbitrary identifiers that some non-Stripe dispatchers
// use.
const STRIPE_EVENT_NAME_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,3}$/;

export function detectStripeEventDispatches(
  filesByPath: Map<string, string>
): StripeEventDispatchHit[] {
  const out: StripeEventDispatchHit[] = [];
  for (const [filePath, content] of filesByPath.entries()) {
    if (isTestPath(filePath)) continue;
    if (!/\.(?:tsx?|jsx?|mjs|cjs)$/.test(filePath)) continue;
    // Gate 1: file must use the Stripe SDK. Accept any of:
    //   (a) literal `stripe.webhooks.constructEvent(` — direct SDK call
    //   (b) `Stripe.Event` type reference — quantasyte-shape wrapper
    //       (`constructWebhookEvent` helper in a separate file, but
    //       the caller still types `event: Stripe.Event`)
    //   (c) an import of `from "stripe"` AND a wrapper-named call
    //       (`*WebhookEvent` / `*WebhookSignature` / `verifyStripe*`)
    // All three are real-world shapes observed in dyad-apps.
    const hasDirectVerify = /\bstripe\s*\.\s*webhooks\s*\.\s*constructEvent\s*\(/.test(content);
    const hasStripeEventType = /\bStripe\s*\.\s*Event\b/.test(content);
    const hasStripeImport = /\bfrom\s+['"]stripe['"]/.test(content);
    const hasWrapperCall = /\b(?:construct|verify|build)\w*Webhook\w*\s*\(/i.test(content);
    if (!hasDirectVerify && !hasStripeEventType && !(hasStripeImport && hasWrapperCall)) continue;

    // Gate 2: a `switch (event.type)` block must exist. Also accept
    // destructured forms: `switch (type)` where type came from
    // `const { type } = event` or `event.type`. We're conservative —
    // require the literal `event.type` OR a `switch (type)` preceded
    // somewhere by `const { type } = event` / `const type = event.type`.
    const stripped = content.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    let switchBody: string | null = null;
    {
      // Direct `switch (event.type) {`.
      const direct = /switch\s*\(\s*event\s*\.\s*type\s*\)\s*\{/.exec(stripped);
      if (direct) {
        const start = direct.index + direct[0].length;
        switchBody = sliceBalancedBraces(stripped, start - 1);
      } else {
        const indirect = /switch\s*\(\s*(\w+)\s*\)\s*\{/.exec(stripped);
        if (indirect) {
          const discriminant = indirect[1];
          const destructured = new RegExp(`const\\s*\\{\\s*[^}]*\\btype\\s*:\\s*${discriminant}\\b[^}]*\\}\\s*=\\s*event\\b|const\\s*\\{\\s*[^}]*\\b${discriminant}\\b[^}]*\\}\\s*=\\s*event\\b`);
          const assigned = new RegExp(`(?:const|let|var)\\s+${discriminant}\\s*(?::[^=]+)?=\\s*event\\s*\\.\\s*type\\b`);
          if (destructured.test(stripped) || assigned.test(stripped)) {
            const start = indirect.index + indirect[0].length;
            switchBody = sliceBalancedBraces(stripped, start - 1);
          }
        }
      }
    }
    if (!switchBody) continue;

    // Gate 3: extract `case "<event-name>":` arms.
    const events = new Set<string>();
    for (const m of switchBody.matchAll(/case\s*['"]([^'"]+)['"]\s*:/g)) {
      const name = m[1];
      if (STRIPE_EVENT_NAME_RE.test(name)) events.add(name);
    }
    if (events.size === 0) continue;

    const eventList = Array.from(events).sort();
    out.push({
      template: "stripe-event-handled",
      filePath,
      events: eventList,
      suggestedPin: `Stripe webhook in ${filePath} routes ${eventList.length} event type${eventList.length === 1 ? "" : "s"} (${eventList.join(", ")}) — silently dropping one breaks SaaS provisioning while the signature still verifies.`,
    });
  }
  return out;
}

// Slice content from `start` (which points at the `{`) to the matching
// `}`. Skips strings + comments so braces inside string literals or
// comments don't unbalance. Returns null if unbalanced.
function sliceBalancedBraces(content: string, start: number): string | null {
  if (content[start] !== "{") return null;
  let depth = 1;
  let j = start + 1;
  while (j < content.length && depth > 0) {
    const ch = content[j];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      j += 1;
      while (j < content.length) {
        if (content[j] === "\\") { j += 2; continue; }
        if (content[j] === quote) { j += 1; break; }
        if (quote === "`" && content[j] === "$" && content[j + 1] === "{") {
          let tdepth = 1;
          j += 2;
          while (j < content.length && tdepth > 0) {
            if (content[j] === "{") tdepth += 1;
            else if (content[j] === "}") tdepth -= 1;
            j += 1;
          }
          continue;
        }
        j += 1;
      }
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    j += 1;
  }
  if (depth !== 0) return null;
  return content.slice(start + 1, j - 1);
}

// ────────────────────────────────────────────────────────────
// New-page detector (auto-protect mode)
// ────────────────────────────────────────────────────────────
//
// Fires when the diff adds a new server-rendered page file (Next.js
// app/page.tsx, app/[segment]/page.tsx, pages/index.tsx, etc.). Used
// by auto-protect to emit a `page-renders` candidate pin so the
// first React/Next/Vite render error catches the page on commit
// instead of slipping into prod.
export type DiffNewPageHit = {
  template: "page-renders";
  route: string;
  filePath: string;
  suggestedPin: string;
};

// Retroactive page detector — same shape as detectNewPagesInDiff but
// walks the full tree (each file is treated as if every line is "added")
// so sweep can emit page-renders / page-accessibility proposals on
// existing pages, not just diff-introduced ones.
export function detectRetroactivePages(filesByPath: Map<string, string>): DiffNewPageHit[] {
  const diff: DiffByFile = new Map();
  for (const [filePath, content] of filesByPath.entries()) {
    diff.set(filePath, content.split("\n"));
  }
  return detectNewPagesInDiff(diff);
}

export function detectNewPagesInDiff(diffByFile: DiffByFile): DiffNewPageHit[] {
  const out: DiffNewPageHit[] = [];
  const seenRoutes = new Set<string>();
  for (const [filePath, addedLines] of diffByFile.entries()) {
    if (isTestPath(filePath)) continue;
    // Detect Next.js app router page files (app/<route>/page.tsx).
    let route: string | null = null;
    const appPageMatch = /^(?:.*\/)?app\/((?:[^/]+\/)*)page\.(?:tsx|jsx|ts|js)$/.exec(filePath);
    if (appPageMatch) {
      const segments = appPageMatch[1].replace(/\/$/, "");
      route = segments ? `/${segments}` : "/";
    }
    // Detect pages-router files (pages/<route>.tsx, pages/<route>/index.tsx).
    if (!route) {
      const pagesMatch = /^(?:.*\/)?pages\/((?:[^/]+\/)*)?([^/]+)\.(?:tsx|jsx|ts|js)$/.exec(filePath);
      if (pagesMatch) {
        const dirSegments = (pagesMatch[1] || "").replace(/\/$/, "");
        const filename = pagesMatch[2];
        // Skip _app, _document, _error, api/* — not user-facing pages.
        if (
          filename.startsWith("_") ||
          filename === "404" ||
          filename === "500" ||
          dirSegments.startsWith("api/") ||
          dirSegments === "api"
        ) continue;
        const filePart = filename === "index" ? "" : `/${filename}`;
        route = dirSegments ? `/${dirSegments}${filePart}` : `${filePart}` || "/";
      }
    }
    if (!route) continue;

    // Must include actual content (added lines) — don't fire on
    // file-delete diffs that happen to share the path shape.
    const added = addedLines
      .map((l) => l.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, ""))
      .filter((l) => l.trim().length > 0)
      .join("\n");
    if (added.length === 0) continue;

    // Require some signal that the file actually exports a default
    // component or function — defensive against false matches on
    // misnamed files.
    const exportsDefault = /export\s+(?:default\s+|const\s+\w+\s*=|async\s+function\s+|function\s+)/i.test(added);
    if (!exportsDefault) continue;

    if (seenRoutes.has(route)) continue;
    seenRoutes.add(route);

    out.push({
      template: "page-renders",
      route,
      filePath,
      suggestedPin: `GET ${route} renders without crashing`,
    });
  }
  return out;
}

// ────────────────────────────────────────────────────────────
// New-validation-schema detector (auto-protect mode)
// ────────────────────────────────────────────────────────────
//
// Fires when the diff adds a zod / yup / joi / valibot schema with
// required fields on a route handler. Used by auto-protect to emit a
// `validation-rejects-bad` candidate pin. Each required field becomes
// a sub-test (POST with that field omitted → expect 4xx).
//
// `bodyShape` (0.2.7+): per-field kind/format extracted from the
// schema (string vs number vs email vs uuid …). Threaded into the
// complementary `happy-path-with-side-effect` candidate so the
// generated test ships a body that actually satisfies the schema —
// without this, the placeholder buildValidBody() returns 4xx and the
// pin false-fails on its first run.
export type FieldShape =
  | { kind: "string"; min?: number; format?: "email" | "url" | "uuid" | "date" | "datetime" | "cuid" }
  | { kind: "number"; int?: boolean; min?: number }
  | { kind: "boolean" }
  | { kind: "literal"; value: string | number | boolean }
  | { kind: "enum"; values: string[] }
  | { kind: "array"; items?: FieldShape }
  | { kind: "unknown" };

export type DiffNewValidationHit = {
  template: "validation-rejects-bad";
  route: string;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  filePath: string;
  requiredFields: string[];
  bodyShape?: Record<string, FieldShape>;
  suggestedPin: string;
};

// Best-effort: read a single zod chain like `z.string().email().min(5)`
// and turn it into a FieldShape. Returns `{kind: "unknown"}` for chains
// we don't recognize — caller falls back to a generic placeholder.
// Conservative on purpose: we'd rather emit a string fallback than
// guess a wrong shape and produce confusing 4xx pin failures.
export function zodChainToShape(chain: string): FieldShape {
  // `z.literal(<val>)` — peg the body to the exact literal.
  const lit = /^\s*z\.literal\s*\(\s*("([^"\\]|\\.)*"|'([^'\\]|\\.)*'|true|false|-?\d+(?:\.\d+)?)\s*\)/.exec(chain);
  if (lit) {
    const raw = lit[1];
    if (raw === "true") return { kind: "literal", value: true };
    if (raw === "false") return { kind: "literal", value: false };
    if (/^-?\d/.test(raw)) return { kind: "literal", value: Number(raw) };
    return { kind: "literal", value: raw.slice(1, -1) };
  }
  // `z.enum(["a", "b"])` — first value satisfies it.
  const en = /^\s*z\.enum\s*\(\s*\[([^\]]*)\]\s*\)/.exec(chain);
  if (en) {
    const items = en[1]
      .split(",")
      .map((s) => s.trim().replace(/^["']/, "").replace(/["']$/, ""))
      .filter((s) => s.length > 0);
    if (items.length > 0) return { kind: "enum", values: items };
  }
  // `z.array(<inner>)` — empty array satisfies it (none of the
  // entries are required individually).
  if (/^\s*z\.array\s*\(/.test(chain)) {
    return { kind: "array" };
  }
  // `z.boolean()`
  if (/^\s*z\.boolean\s*\(/.test(chain)) {
    return { kind: "boolean" };
  }
  // `z.number()` / `.int()` / `.min(N)` / `.positive()`
  if (/^\s*z\.number\s*\(/.test(chain)) {
    const int = /\.int\s*\(/.test(chain) || /\.positive\s*\(/.test(chain);
    const minMatch = /\.min\s*\(\s*(-?\d+)/.exec(chain);
    return {
      kind: "number",
      ...(int ? { int: true } : {}),
      ...(minMatch ? { min: Number(minMatch[1]) } : {}),
    };
  }
  // `z.string()` — possibly with .email() / .url() / .uuid() / .cuid() /
  // .datetime() / .date() / .min(N).
  if (/^\s*z\.string\s*\(/.test(chain)) {
    let format: "email" | "url" | "uuid" | "date" | "datetime" | "cuid" | undefined;
    if (/\.email\s*\(/.test(chain)) format = "email";
    else if (/\.url\s*\(/.test(chain)) format = "url";
    else if (/\.uuid\s*\(/.test(chain)) format = "uuid";
    else if (/\.cuid\s*\(/.test(chain)) format = "cuid";
    else if (/\.datetime\s*\(/.test(chain)) format = "datetime";
    else if (/\.date\s*\(/.test(chain)) format = "date";
    const minMatch = /\.min\s*\(\s*(\d+)/.exec(chain);
    return {
      kind: "string",
      ...(format ? { format } : {}),
      ...(minMatch ? { min: Number(minMatch[1]) } : {}),
    };
  }
  return { kind: "unknown" };
}

// Same shape as zodChainToShape but for yup. Yup chains look like
// `yup.string().email().min(5).required()` — similar method names,
// different namespace prefix.
export function yupChainToShape(chain: string): FieldShape {
  if (/^\s*yup\.boolean\s*\(/.test(chain)) return { kind: "boolean" };
  if (/^\s*yup\.array\s*\(/.test(chain)) return { kind: "array" };
  if (/^\s*yup\.number\s*\(/.test(chain)) {
    const int = /\.integer\s*\(/.test(chain) || /\.positive\s*\(/.test(chain);
    const minMatch = /\.min\s*\(\s*(-?\d+)/.exec(chain);
    return {
      kind: "number",
      ...(int ? { int: true } : {}),
      ...(minMatch ? { min: Number(minMatch[1]) } : {}),
    };
  }
  // yup .oneOf(["a","b"]) is the enum equivalent.
  const oneOf = /\.oneOf\s*\(\s*\[([^\]]*)\]/.exec(chain);
  if (oneOf) {
    const items = oneOf[1]
      .split(",")
      .map((s) => s.trim().replace(/^["']/, "").replace(/["']$/, ""))
      .filter((s) => s.length > 0);
    if (items.length > 0) return { kind: "enum", values: items };
  }
  if (/^\s*yup\.string\s*\(/.test(chain)) {
    let format: "email" | "url" | "uuid" | "date" | "datetime" | "cuid" | undefined;
    if (/\.email\s*\(/.test(chain)) format = "email";
    else if (/\.url\s*\(/.test(chain)) format = "url";
    else if (/\.uuid\s*\(/.test(chain)) format = "uuid";
    else if (/\.datetime\s*\(/.test(chain)) format = "datetime";
    else if (/\.date\s*\(/.test(chain)) format = "date";
    const minMatch = /\.min\s*\(\s*(\d+)/.exec(chain);
    return {
      kind: "string",
      ...(format ? { format } : {}),
      ...(minMatch ? { min: Number(minMatch[1]) } : {}),
    };
  }
  return { kind: "unknown" };
}

// Joi: `Joi.string().email().min(5).required()`. Most method names
// match yup; key differences: .uri() for URLs, .guid()/.uuid() for
// UUIDs, .valid(...) instead of .oneOf().
export function joiChainToShape(chain: string): FieldShape {
  if (/^\s*Joi\.boolean\s*\(/.test(chain)) return { kind: "boolean" };
  if (/^\s*Joi\.array\s*\(/.test(chain)) return { kind: "array" };
  if (/^\s*Joi\.number\s*\(/.test(chain)) {
    const int = /\.integer\s*\(/.test(chain) || /\.positive\s*\(/.test(chain);
    const minMatch = /\.min\s*\(\s*(-?\d+)/.exec(chain);
    return {
      kind: "number",
      ...(int ? { int: true } : {}),
      ...(minMatch ? { min: Number(minMatch[1]) } : {}),
    };
  }
  const validValues = /\.valid\s*\(([^)]+)\)/.exec(chain);
  if (validValues) {
    const items = validValues[1]
      .split(",")
      .map((s) => s.trim().replace(/^["']/, "").replace(/["']$/, ""))
      .filter((s) => s.length > 0);
    if (items.length > 0) return { kind: "enum", values: items };
  }
  if (/^\s*Joi\.string\s*\(/.test(chain)) {
    let format: "email" | "url" | "uuid" | "date" | "datetime" | "cuid" | undefined;
    if (/\.email\s*\(/.test(chain)) format = "email";
    else if (/\.uri\s*\(/.test(chain)) format = "url";
    else if (/\.guid\s*\(/.test(chain) || /\.uuid\s*\(/.test(chain)) format = "uuid";
    else if (/\.isoDate\s*\(/.test(chain)) format = "datetime";
    const minMatch = /\.min\s*\(\s*(\d+)/.exec(chain);
    return {
      kind: "string",
      ...(format ? { format } : {}),
      ...(minMatch ? { min: Number(minMatch[1]) } : {}),
    };
  }
  return { kind: "unknown" };
}

// Valibot: `v.string([v.email(), v.minLength(5)])`. Different shape —
// validators are passed as an array argument rather than chained.
export function valibotChainToShape(chain: string): FieldShape {
  if (/^\s*v\.boolean\s*\(/.test(chain)) return { kind: "boolean" };
  if (/^\s*v\.array\s*\(/.test(chain)) return { kind: "array" };
  if (/^\s*v\.number\s*\(/.test(chain)) {
    const int = /\bv\.integer\s*\(/.test(chain);
    const minMatch = /\bv\.minValue\s*\(\s*(-?\d+)/.exec(chain);
    return {
      kind: "number",
      ...(int ? { int: true } : {}),
      ...(minMatch ? { min: Number(minMatch[1]) } : {}),
    };
  }
  const picklist = /^\s*v\.picklist\s*\(\s*\[([^\]]*)\]/.exec(chain);
  if (picklist) {
    const items = picklist[1]
      .split(",")
      .map((s) => s.trim().replace(/^["']/, "").replace(/["']$/, ""))
      .filter((s) => s.length > 0);
    if (items.length > 0) return { kind: "enum", values: items };
  }
  if (/^\s*v\.string\s*\(/.test(chain)) {
    let format: "email" | "url" | "uuid" | "date" | "datetime" | "cuid" | undefined;
    if (/\bv\.email\s*\(/.test(chain)) format = "email";
    else if (/\bv\.url\s*\(/.test(chain)) format = "url";
    else if (/\bv\.uuid\s*\(/.test(chain)) format = "uuid";
    else if (/\bv\.isoDateTime\s*\(/.test(chain)) format = "datetime";
    else if (/\bv\.isoDate\s*\(/.test(chain)) format = "date";
    const minMatch = /\bv\.minLength\s*\(\s*(\d+)/.exec(chain);
    return {
      kind: "string",
      ...(format ? { format } : {}),
      ...(minMatch ? { min: Number(minMatch[1]) } : {}),
    };
  }
  return { kind: "unknown" };
}

// Given a FieldShape, produce a value that should satisfy it. Used by
// happy-path-with-side-effect's buildValidBody(). Kept deterministic
// so the same schema always emits the same body — predictable for
// debugging, reproducible across regen.
export function valueForFieldShape(s: FieldShape): unknown {
  switch (s.kind) {
    case "string": {
      if (s.format === "email") return "pinned-test@example.com";
      if (s.format === "url") return "https://example.com/pinned";
      if (s.format === "uuid") return "00000000-0000-4000-8000-000000000000";
      if (s.format === "cuid") return "c000000000000000000000000";
      if (s.format === "date") return "2026-01-01";
      if (s.format === "datetime") return "2026-01-01T00:00:00.000Z";
      const base = "pinned-test-value";
      if (s.min && s.min > base.length) return base.padEnd(s.min, "x");
      return base;
    }
    case "number":
      return s.min !== undefined ? s.min : 1;
    case "boolean":
      return false;
    case "literal":
      return s.value;
    case "enum":
      return s.values[0];
    case "array":
      return [];
    case "unknown":
      return "pinned-test-value";
  }
}

export function detectNewValidationSchemasInDiff(diffByFile: DiffByFile): DiffNewValidationHit[] {
  const out: DiffNewValidationHit[] = [];
  const seenKeys = new Set<string>();
  for (const [filePath, addedLines] of diffByFile.entries()) {
    if (isTestPath(filePath)) continue;
    const route = deriveRouteFromPath(filePath);
    if (!route) continue;

    const added = addedLines
      .map((l) => l.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, ""))
      .filter((l) => l.trim().length > 0)
      .join("\n");
    if (added.length === 0) continue;

    // Method detection — same as new-POST detector.
    let method: "POST" | "PUT" | "PATCH" | "DELETE" | null = null;
    const appRouterMatch = /export\s+(?:const\s+|async\s+function\s+|function\s+)(POST|PUT|PATCH|DELETE)\b/.exec(added);
    if (appRouterMatch) method = appRouterMatch[1] as "POST" | "PUT" | "PATCH" | "DELETE";
    if (!method) {
      const pagesMatch = /req\.method\s*===?\s*['"](POST|PUT|PATCH|DELETE)['"]/.exec(added);
      if (pagesMatch) method = pagesMatch[1] as "POST" | "PUT" | "PATCH" | "DELETE";
    }
    if (!method) continue;

    // Extract required field names from supported schema shapes.
    // Conservative — only fire when we can confidently identify
    // schema with explicit required-field declarations.
    const fields = new Set<string>();
    const bodyShape: Record<string, FieldShape> = {};
    // zod: `z.object({ name: z.string(), email: z.string().email() })`
    // Strategy: extract the object body, split on top-level commas
    // (respecting parens), then for each entry of shape `field: z.<...>`,
    // check whether the entry contains .optional()/.nullable()/.nullish().
    // Simpler + more correct than trying to encode every method-chain
    // shape in a single capturing regex.
    const zodObjectMatch = /z\.object\s*\(\s*\{([^}]{0,2000})\}\s*\)/g;
    let zm: RegExpExecArray | null;
    while ((zm = zodObjectMatch.exec(added)) !== null) {
      const body = zm[1];
      // Split on commas that are NOT inside parens (so `z.string().min(3)` stays one entry).
      const entries = splitTopLevelCommas(body);
      for (const entry of entries) {
        const m = /^\s*([a-zA-Z_][\w]{0,40})\s*:\s*(z\..+)$/s.exec(entry);
        if (!m) continue;
        if (/\.(?:optional|nullable|nullish)\s*\(\s*\)/.test(entry)) continue;
        const fieldName = m[1];
        const chain = m[2];
        fields.add(fieldName);
        // Capture the schema shape (kind/format/min) so a sibling
        // happy-path-with-side-effect pin can ship a body that satisfies
        // the schema instead of the placeholder `{ pinnedTest: true }`
        // which 4xx's on first run.
        bodyShape[fieldName] = zodChainToShape(chain);
      }
    }
    // yup: `yup.object({ name: yup.string().required() })`
    // 0.2.10+: also populate bodyShape via yupChainToShape so the
    // complementary happy-path-with-side-effect pin ships a body that
    // satisfies the schema instead of the placeholder.
    const yupMatch = /yup\.object\s*\(\s*\{([^}]{0,2000})\}\s*\)/g;
    let ym: RegExpExecArray | null;
    while ((ym = yupMatch.exec(added)) !== null) {
      const body = ym[1];
      const entries = splitTopLevelCommas(body);
      for (const entry of entries) {
        const m = /^\s*([a-zA-Z_][\w]{0,40})\s*:\s*(yup\..+)$/s.exec(entry);
        if (!m) continue;
        // Yup defaults to nullable/optional unless .required() is
        // present, so REQUIRE the .required() call to match the
        // existing required-field semantics.
        if (!/\.required\s*\(/.test(entry)) continue;
        const fieldName = m[1];
        const chain = m[2];
        fields.add(fieldName);
        bodyShape[fieldName] = yupChainToShape(chain);
      }
    }
    // joi: `Joi.object({ name: Joi.string().required() })`
    const joiMatch = /Joi\.object\s*\(\s*\{([^}]{0,2000})\}\s*\)/g;
    let jm: RegExpExecArray | null;
    while ((jm = joiMatch.exec(added)) !== null) {
      const body = jm[1];
      const entries = splitTopLevelCommas(body);
      for (const entry of entries) {
        const m = /^\s*([a-zA-Z_][\w]{0,40})\s*:\s*(Joi\..+)$/s.exec(entry);
        if (!m) continue;
        if (!/\.required\s*\(/.test(entry)) continue;
        const fieldName = m[1];
        const chain = m[2];
        fields.add(fieldName);
        bodyShape[fieldName] = joiChainToShape(chain);
      }
    }
    // valibot: `v.object({ name: v.string([v.email()]) })`. Valibot
    // doesn't have a `.optional()/.nullable()` chained variant — it
    // wraps the schema: `v.optional(v.string(...))`. We detect required
    // fields as the inverse: any field whose value is NOT wrapped in
    // v.optional(...) / v.nullable(...) / v.nullish(...).
    const valibotMatch = /\bv\.object\s*\(\s*\{([^}]{0,2000})\}\s*\)/g;
    let vbm: RegExpExecArray | null;
    while ((vbm = valibotMatch.exec(added)) !== null) {
      const body = vbm[1];
      const entries = splitTopLevelCommas(body);
      for (const entry of entries) {
        const m = /^\s*([a-zA-Z_][\w]{0,40})\s*:\s*(v\..+)$/s.exec(entry);
        if (!m) continue;
        // Skip optional-wrapped values.
        if (/^\s*[a-zA-Z_][\w]{0,40}\s*:\s*v\.(?:optional|nullable|nullish)\s*\(/.test(entry)) continue;
        const fieldName = m[1];
        const chain = m[2];
        fields.add(fieldName);
        bodyShape[fieldName] = valibotChainToShape(chain);
      }
    }

    if (fields.size === 0) continue;

    const key = `${method} ${route}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    const requiredFields = Array.from(fields);
    // Only include bodyShape if we extracted at least one zod shape —
    // yup/joi paths didn't populate it (room for a future enhancement).
    const hasShape = Object.keys(bodyShape).length > 0;
    out.push({
      template: "validation-rejects-bad",
      route,
      method,
      filePath,
      requiredFields,
      ...(hasShape ? { bodyShape } : {}),
      suggestedPin: `${method} ${route} requires fields ${requiredFields.join(", ")}`,
    });
  }
  return out;
}

// ────────────────────────────────────────────────────────────
// Idempotency-added detector (bug-fix mode)
// ────────────────────────────────────────────────────────────
//
// Mirrors detectAuthChecksInDiff / detectValidationAddedInDiff. Fires
// when a fix adds an idempotency check to a route handler — typically
// looking up a payload field (event_id, msg_id, idempotency-key) against
// prior records and short-circuiting on a duplicate.
//
// False-positive guard rails (per [[lint-format-false-positives]]
// memory — auth/validation detectors have been burned by lint-only
// reformatting churn before):
//   1. Require TWO signals: (a) a payload-field reference matching a
//      known idempotency key AND (b) a uniqueness-lookup verb.
//   2. Skip GET-only routes — idempotency only matters on mutations.
//   3. Skip auth/login routes — those are auth-required, not idempotent.
//   4. Reject when the matched signature looks like a bare identifier
//      (handled by extractFullLineFromMatch's min-length guard).
//   5. The single-pattern matches that lint can manufacture (e.g.,
//      destructuring `const { event_id } = req.body` getting reformatted)
//      cannot fire alone — they only count when paired with a lookup verb.
export type DiffIdempotencyHit = {
  template: "idempotent";
  route: string;
  filePath: string;
  idField: string;
  signature: string;
  suggestedPin: string;
};

// Known idempotency-key field names. Bounded list to keep FP low.
const IDEMPOTENCY_FIELD_NAMES = [
  "event_id",
  "eventId",
  "msg_id",
  "msgId",
  "message_id",
  "messageId",
  "idempotency_key",
  "idempotencyKey",
  "idempotency-key",
  "delivery_id",
  "deliveryId",
] as const;

// Verbs/shapes that look like a uniqueness lookup. At least one of
// these MUST appear alongside an idempotency field for the detector
// to fire. Each pattern represents an unambiguous lookup-and-skip
// shape — bare identifier matches alone are insufficient.
const IDEMPOTENCY_LOOKUP_PATTERNS: RegExp[] = [
  // ORM-style lookups (Prisma / TypeORM / Drizzle / Mongo)
  /\b(?:findUnique|findFirst|findOne|findById|find\s*\(\s*\{)\s*\(?/,
  // Direct header read of idempotency-key — strong signal regardless
  // of where the lookup happens
  /headers(?:\.get)?\s*[\(\[]\s*['"]idempotency[-_]?key['"]/i,
  /headers\s*\[\s*['"]idempotency[-_]?key['"]/i,
  // Redis-style SET NX (used as a dedupe lock)
  /\bredis(?:Client)?\.(?:set|setnx)\s*\([^)]*\b(?:NX|EX)\b/i,
  /\bSETNX\b/i,
  // Explicit cache lookups for prior responses
  /\b(?:cache|kv|store)\.(?:get|has)\s*\(\s*[`'"]?(?:idem|event|msg|webhook|dedupe)/i,
];

// Idempotency-key field reference patterns. Single-line shapes are OK
// here BECAUSE the detector requires a coupled IDEMPOTENCY_LOOKUP_PATTERNS
// hit in the same diff — neither alone is enough.
function idempotencyFieldHit(added: string): { field: string; signature: string } | null {
  for (const field of IDEMPOTENCY_FIELD_NAMES) {
    // Word-boundary search across the joined added lines. Use string
    // search not regex to avoid escaping concerns with `-` in
    // `idempotency-key`.
    const idx = added.indexOf(field);
    if (idx === -1) continue;
    // Reject when the field name appears only as a comment or import.
    const sig = extractFullLineFromMatch(added, idx, field);
    if (/^(?:\/\/|import\b|from\s+['"])/.test(sig)) continue;
    return { field, signature: sig };
  }
  return null;
}

export function detectIdempotencyAddedInDiff(
  diffByFile: DiffByFile
): DiffIdempotencyHit[] {
  const out: DiffIdempotencyHit[] = [];
  const seenRoutes = new Set<string>();
  for (const [filePath, addedLines] of diffByFile.entries()) {
    if (isTestPath(filePath)) continue;
    const route = deriveRouteFromPath(filePath);
    if (!route || route === "* (middleware)") continue;
    // Idempotency only matters on mutations. Auth/login routes don't
    // qualify (they're handled by auth-required).
    if (isAuthEndpoint(route)) continue;

    const added = addedLines
      .map((l) => l.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, ""))
      .filter((l) => l.trim().length > 0)
      .join("\n");
    if (added.length === 0) continue;

    // Must look like a write surface — either the route path itself
    // signals it (webhook/event endpoints) OR the diff added a
    // write-method handler.
    const looksLikeWebhook = /\/(?:webhooks?|events?|hooks?)\//i.test(route);
    const hasWriteMethod = /\b(?:POST|PUT|PATCH)\b|\.(?:post|put|patch)\s*\(/.test(added);
    if (!looksLikeWebhook && !hasWriteMethod) continue;

    // First signal: a known idempotency-key field is referenced.
    const fieldHit = idempotencyFieldHit(added);
    if (!fieldHit) continue;

    // Second signal: a uniqueness lookup / dedupe shape exists in the
    // same diff. Without this, a bare field reference can be lint
    // reformatting noise.
    let lookupHit: { signature: string } | null = null;
    for (const re of IDEMPOTENCY_LOOKUP_PATTERNS) {
      const m = re.exec(added);
      if (m) {
        lookupHit = { signature: extractFullLineFromMatch(added, m.index, m[0]) };
        break;
      }
    }
    if (!lookupHit) continue;

    // Prefer the LOOKUP line as the load-bearing signature — that's
    // the line that actually enforces idempotency. The field reference
    // is corroborating evidence.
    if (seenRoutes.has(route)) continue;
    seenRoutes.add(route);
    out.push({
      template: "idempotent",
      route,
      filePath,
      idField: fieldHit.field,
      signature: lookupHit.signature,
      suggestedPin: `${route} idempotent on ${fieldHit.field} (added in this fix)`,
    });
  }
  return out;
}

// ────────────────────────────────────────────────────────────
// Rate-limit-added detector (bug-fix mode)
// ────────────────────────────────────────────────────────────
//
// Fires when a fix wires a rate limiter onto a route. False-positive
// guard rails:
//   1. Require a recognizable limiter LIBRARY shape (express-rate-limit,
//      upstash/ratelimit, rate-limiter-flexible, hono/rate-limiter) OR
//      an explicit 429 response paired with a counter increment.
//   2. The matched signature must be multi-char and library-named —
//      bare `429` literals or `limit:` keys alone don't fire.
//   3. Skip auth/login routes — those are auth-required.
//   4. Extract a numeric rate when present (`max: N`, `points: N`,
//      `requests: N`). Default to 60/minute when not pinnable from
//      the diff alone (mirrors the LLM proposer fallback).
export type DiffRateLimitHit = {
  template: "rate-limit";
  route: string;
  filePath: string;
  rate: number;
  window: "second" | "minute" | "hour";
  signature: string;
  suggestedPin: string;
};

// Each entry is [pattern, optional rate-extraction-capture-group].
// When the rate-capture group is present and matches a positive
// integer, we use it; otherwise we default to 60 (per-minute) which
// is what the LLM proposer and the rate-limit template fallback both
// use.
const RATE_LIMIT_PATTERNS: Array<{ re: RegExp; rateGroup?: number }> = [
  // express-rate-limit / hono rate-limiter — `rateLimit({ max: N })`
  { re: /\brateLimit(?:er)?\s*\(\s*\{[^}]*\bmax\s*:\s*(\d+)/, rateGroup: 1 },
  // rate-limiter-flexible
  { re: /\bRateLimiter(?:Redis|Memory|Mongo|Postgres|Cluster)\s*\(\s*\{[^}]*\bpoints\s*:\s*(\d+)/, rateGroup: 1 },
  // Upstash ratelimit — `Ratelimit.slidingWindow(N, "1 m")` /
  // `.fixedWindow(N, ...)`
  { re: /\bRatelimit\s*\.\s*(?:slidingWindow|fixedWindow|tokenBucket)\s*\(\s*(\d+)\s*,/, rateGroup: 1 },
  // Generic library-named import — strong shape signal even without
  // a slot to extract a rate. Default rate applies.
  { re: /\bfrom\s+['"](?:express-rate-limit|rate-limiter-flexible|@upstash\/ratelimit|hono-rate-limiter|@hono\/rate-limiter)['"]/ },
  // ratelimit.limit(key) — Upstash call site
  { re: /\bratelimit\s*\.\s*limit\s*\(/ },
  // limiter.consume(...) — rate-limiter-flexible call site
  { re: /\b(?:limiter|rateLimiter)\s*\.\s*consume\s*\(/ },
  // Explicit 429 response — accepted ONLY when reasonably long-line
  // matched (extractFullLineFromMatch keeps the full line so lint
  // reformat doesn't trivialize it).
  { re: /\.\s*(?:status|code)\s*\(\s*429\s*\)\s*\.\s*(?:json|send|set)/ },
];

export function detectRateLimitAddedInDiff(
  diffByFile: DiffByFile
): DiffRateLimitHit[] {
  const out: DiffRateLimitHit[] = [];
  const seenRoutes = new Set<string>();
  for (const [filePath, addedLines] of diffByFile.entries()) {
    if (isTestPath(filePath)) continue;
    const route = deriveRouteFromPath(filePath);
    if (!route || route === "* (middleware)") continue;
    if (isAuthEndpoint(route)) continue;

    const added = addedLines
      .map((l) => l.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, ""))
      .filter((l) => l.trim().length > 0)
      .join("\n");
    if (added.length === 0) continue;

    let firstHit: { signature: string; rate: number } | null = null;
    for (const { re, rateGroup } of RATE_LIMIT_PATTERNS) {
      const m = re.exec(added);
      if (!m) continue;
      const sig = extractFullLineFromMatch(added, m.index, m[0]);
      // Reject signatures that are too short / too generic. The
      // library-named patterns are already specific, but the 429
      // pattern can land on a bare line — full-line guard catches it.
      if (sig.length < 12) continue;
      let rate = 60;
      if (rateGroup !== undefined) {
        const n = Number(m[rateGroup]);
        if (Number.isInteger(n) && n > 0 && n < 100000) rate = n;
      }
      firstHit = { signature: sig, rate };
      break;
    }
    if (!firstHit) continue;

    if (seenRoutes.has(route)) continue;
    seenRoutes.add(route);
    out.push({
      template: "rate-limit",
      route,
      filePath,
      rate: firstHit.rate,
      window: "minute",
      signature: firstHit.signature,
      suggestedPin: `${route} rate-limited to ${firstHit.rate}/minute (added in this fix)`,
    });
  }
  return out;
}

// ────────────────────────────────────────────────────────────
// Permission/ownership-added detector (bug-fix mode)
// ────────────────────────────────────────────────────────────
//
// Fires when a fix adds an authorization decision (does THIS user
// have the right to do this on THIS resource), separate from
// authentication (is there A user at all — handled by the auth-required
// detector).
//
// False-positive guard rails:
//   1. Require a recognizable permission-decision shape — either a
//      `require*` / `assert*` helper named for permission/role/owner,
//      OR a comparison against a role string with a 403/forbidden
//      branch, OR a resource-ownership comparison (`x.userId !== ...`)
//      with a 403/forbidden branch.
//   2. Bare `.status(403)` is NOT enough alone — must co-occur with a
//      decision predicate in the same diff. This kills the lint-format
//      FP shape where a `status(403)` line gets reformatted.
//   3. Skip when the diff is ALSO matched by detectAuthChecksInDiff —
//      auth dominates and the same diff hit twice produces a confusing
//      duplicate pin.
//   4. Skip auth/login routes — those don't have per-resource
//      authorization in the relevant sense.
export type DiffPermissionHit = {
  template: "permission-required";
  route: string;
  filePath: string;
  signature: string;
  suggestedPin: string;
};

// Strong signals — naming-based; bounded suffixes to avoid generic FP.
const PERMISSION_DECISION_PATTERNS: RegExp[] = [
  // require*(...) / assert*(...) — bounded suffix set so identifiers
  // like requireConfig / assertEqual don't false-fire.
  /\b(?:require|assert|ensure|check|verify)(?:Permission|Role|Owner(?:ship)?|Tenant|Access|Allowed|Authoriz(?:e|ed)|CanAccess|CanEdit|CanDelete|CanRead|CanWrite)\s*\(/,
  // CASL / Permify shape — `ability.can('action', 'subject')` / `cannot`
  /\bability\s*\.\s*(?:can|cannot|throwUnlessCan)\s*\(/,
  /\bdefineAbility\s*\(/,
  // Casbin: enforcer.enforce(...)
  /\benforcer\s*\.\s*enforce\s*\(/,
  // Coupled comparison-and-403 shapes. The `.` between predicate and
  // 403 spans across `;` and newlines so multi-line if/return blocks
  // count. Length-bounded (240 chars between predicate and 403) so
  // pathological matches don't slide across an entire file.
  /\buser\s*\.\s*role\s*[!=]==\s*['"][^'"]{1,40}['"][\s\S]{0,240}?\b(?:throw|return|reply|res|status|code)\b[\s\S]{0,40}?403/,
  /\b\.\s*(?:userId|ownerId|tenantId|orgId|organizationId)\s*[!=]==[\s\S]{0,80}?\b(?:throw|return|reply|res|status|code)\b[\s\S]{0,40}?403/,
  // ForbiddenError / NotAuthorized throw — distinct from
  // UnauthorizedError (which is auth-required)
  /\bthrow\s+new\s+(?:ForbiddenError|NotAuthorizedError|PermissionDenied(?:Error)?|InsufficientPermissionsError)\s*\(/,
];

// "Auth dominates" reuse: if the same added lines already match one of
// our auth patterns, we skip emitting a permission-required pin to
// avoid double-pinning the same surface. Keeps our pin-count clean and
// our PR-comment surface honest.
function diffAlsoMatchesAuth(added: string): boolean {
  for (const re of AUTH_CHECK_PATTERNS) {
    if (re.test(added)) return true;
  }
  return false;
}

export function detectPermissionAddedInDiff(
  diffByFile: DiffByFile
): DiffPermissionHit[] {
  const out: DiffPermissionHit[] = [];
  const seenRoutes = new Set<string>();
  for (const [filePath, addedLines] of diffByFile.entries()) {
    if (isTestPath(filePath)) continue;
    const route = deriveRouteFromPath(filePath);
    if (!route || route === "* (middleware)") continue;
    if (isAuthEndpoint(route) || isLikelyPublicEndpoint(route)) continue;

    const added = addedLines
      .map((l) => l.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, ""))
      .filter((l) => l.trim().length > 0)
      .join("\n");
    if (added.length === 0) continue;

    // Auth dominates — if this diff also added an auth check on the
    // same route, the auth-required pin already covers the surface.
    if (diffAlsoMatchesAuth(added)) continue;

    let firstHit: { signature: string } | null = null;
    for (const re of PERMISSION_DECISION_PATTERNS) {
      const m = re.exec(added);
      if (m) {
        const sig = extractFullLineFromMatch(added, m.index, m[0]);
        // Length-bound guards: too short = collision-prone, too long
        // = probably a sprawling multi-line match we can't reliably
        // verify at replay time.
        if (sig.length < 10 || sig.length > 400) continue;
        firstHit = { signature: sig };
        break;
      }
    }
    if (!firstHit) continue;

    if (seenRoutes.has(route)) continue;
    seenRoutes.add(route);
    out.push({
      template: "permission-required",
      route,
      filePath,
      signature: firstHit.signature,
      suggestedPin: `permission check required on ${route} (added in this fix)`,
    });
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Phase 1+2 detectors (2026-05-25) — six new diff-mode detectors built
// from the dyad-apps fix-commit audit (see scripts/audit-fixes-for-templates.sh).
// Each mirrors the FP-safe contract of the existing detectors:
//   1. Static signature extracted verbatim from the added lines.
//   2. File-shape filter to keep us on relevant surfaces.
//   3. Multi-signal requirement when a single regex would be too loose.
//   4. Whitespace + comment normalization handled by extractFullLineFromMatch.
// ──────────────────────────────────────────────────────────────────────

export type DiffUrlLiteralHit = {
  template: "url-literal-preserved";
  filePath: string;
  urlLiteral: string;
  label: string;
  signature: string;
  suggestedPin: string;
};

// URL-literal detector. Catches the largest dyad-apps fix class:
// endpoint typos, API-version drift, prod-vs-dev URL swaps. FP guard:
//   - URL must be inside a quoted string (single, double, or backtick)
//   - Skip URLs in import paths (those belong to import-path-resolves)
//   - Skip very generic short URLs ("/" "/api" alone)
//   - Skip development URLs unless they look like real endpoints
//   - One pin per (file, url) pair to avoid pin explosion on big fixes
const URL_LITERAL_PATTERNS: RegExp[] = [
  // Quoted URL paths starting with /api, /v1, /v2, /webhooks, /auth, /admin, etc.
  // Captures URLs of length ≥ 6 chars after the leading `/` so `/`, `/api` alone are skipped.
  /["'`](\/(?:api|v\d+|webhooks?|auth|admin|account|dashboard|hook|edge|functions|rpc)\/[a-zA-Z0-9_\-./]{2,80})["'`]/,
  // Absolute URLs to specific hosts (production endpoints typically)
  /["'`](https?:\/\/[a-zA-Z0-9.\-]+\.(?:com|io|app|dev|co|net|org)\/[a-zA-Z0-9_\-./]{1,80})["'`]/,
];
export function detectUrlLiteralAddedInDiff(diffByFile: DiffByFile): DiffUrlLiteralHit[] {
  const out: DiffUrlLiteralHit[] = [];
  const seen = new Set<string>();
  for (const [filePath, addedLines] of diffByFile.entries()) {
    if (isTestPath(filePath) || isVendoredPath(filePath)) continue;
    // Don't pin URLs found in our OWN installed content (CLAUDE.md
    // pinned-block, tests/pinned/AGENT.md). Those URLs are ours and
    // pinning them is recursive nonsense (would protect Pinned's
    // own block from change).
    if (/^(?:CLAUDE\.md|AGENTS\.md|AGENT\.md|\.cursorrules|\.clinerules)$/i.test(filePath)) continue;
    if (/^tests\/pinned\//.test(filePath)) continue;
    if (/^\.pinned\//.test(filePath)) continue;
    // Only look at source/config files where a URL literal would matter.
    if (!/\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|yaml|yml)$/.test(filePath)) continue;
    const added = addedLines
      .map((l) => l.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, ""))
      .filter((l) => l.trim().length > 0)
      .join("\n");
    if (added.length === 0) continue;
    // Skip lines that are `import ... from "..."` — those belong to import-path-resolves.
    const nonImportAdded = added
      .split("\n")
      .filter((l) => !/\b(?:import\s|from\s+["'`]|require\s*\()/.test(l))
      .join("\n");
    if (nonImportAdded.length === 0) continue;
    for (const re of URL_LITERAL_PATTERNS) {
      // Use exec in a loop to capture all URLs on this file
      const localRe = new RegExp(re.source, re.flags + (re.flags.includes("g") ? "" : "g"));
      let m: RegExpExecArray | null;
      while ((m = localRe.exec(nonImportAdded)) !== null) {
        const urlLiteral = m[1];
        if (!urlLiteral || urlLiteral.length < 5) continue;
        // Skip localhost / 127.0.0.1 / .local URLs — dev only, not pinnable.
        if (/\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\.local)\b/.test(urlLiteral)) continue;
        const key = `${filePath}\t${urlLiteral}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const sig = extractFullLineFromMatch(nonImportAdded, m.index, m[0]);
        if (sig.length < 8) continue;
        // Friendly label: last path segment as a short hint.
        const label = (urlLiteral.split("/").filter(Boolean).pop() || urlLiteral).slice(0, 40);
        out.push({
          template: "url-literal-preserved",
          filePath,
          urlLiteral,
          label,
          signature: sig,
          suggestedPin: `URL literal ${urlLiteral} preserved in ${filePath} (added in this fix)`,
        });
      }
    }
  }
  return out;
}

export type DiffTscCleanHit = {
  template: "tsc-clean";
  tsconfigPath: string;
  signature: string;
  suggestedPin: string;
};

// tsc-clean detector. Fires when the fix touches TS/build infrastructure
// in a way that suggests "the build was broken and got fixed":
//   - Modifies tsconfig.json (could be tightening or relaxing — we
//     conservatively pin the post-fix state)
//   - The commit's added lines remove TS errors (e.g., `// @ts-ignore`
//     stripped, `as any` removed, missing types added)
// One pin per repo (keyed by tsconfig path). FP guard: requires a
// tsconfig.json to actually exist in the repo OR a TS source file
// to have been touched. Otherwise we'd false-fire on JS-only repos.
//
// CAUTION: this template asks vitest to run `tsc --noEmit` against
// the customer's WHOLE repo. If their repo has type errors UNRELATED
// to the fix, the pin will be broken-at-fix from day one. That's bad
// FP shape. We currently leave the pin generation in (the user CAN
// opt to retire), but conservative usage is to disable in repos that
// don't already typecheck — caller controls.
export function detectTscCleanAddedInDiff(
  diffByFile: DiffByFile,
  repoPath: string
): DiffTscCleanHit[] {
  // Look for any TS source change OR tsconfig.json change.
  let touchedTs = false;
  let touchedTsconfig = false;
  for (const filePath of diffByFile.keys()) {
    if (isTestPath(filePath) || isVendoredPath(filePath)) continue;
    if (filePath === "tsconfig.json" || /\/tsconfig(\.[^/]+)?\.json$/.test(filePath)) {
      touchedTsconfig = true;
    }
    if (/\.(?:ts|tsx)$/.test(filePath)) {
      touchedTs = true;
    }
  }
  // Stricter gate: REQUIRE the commit to have actually touched
  // tsconfig.json (not just any .ts file). Many commits touch .ts
  // and happen to add a type annotation without being TS-fix
  // commits — pinning tsc-clean on all of them generates broken-at-fix
  // FPs when the repo has unrelated type errors. The conservative
  // signal that distinguishes a real TS-fix is a tsconfig change.
  if (!touchedTsconfig) return [];
  // Confirm tsconfig.json actually exists in the repo root.
  const tsconfigPath = "tsconfig.json";
  if (!existsSync(join(repoPath, tsconfigPath))) return [];
  void touchedTs; // intentionally unused — gate above is the only fire condition
  // Only emit when added lines show actual TS-fix signals — not on
  // every fix that touches a .ts file (that would FP heavily).
  const tsFixSignals: RegExp[] = [
    // @ts-ignore / @ts-expect-error removed (we see the line REMOVED,
    // not added — but the absence of these in added text near a TS
    // change is the signal). Conservative: only fire if the diff
    // explicitly adds type annotations or proper handling.
    /\bas\s+(?:[A-Z][a-zA-Z]+|\w+\s*<)/,           // `as User` / `as Map<...>`
    /:\s*[A-Z][a-zA-Z0-9]+(?:<[^>]+>)?(?:\s*\[\])?\s*[=,)]/,  // type annotation in added line
    /\binterface\s+[A-Z]/,
    /\btype\s+[A-Z][a-zA-Z0-9]*\s*=/,
  ];
  let hasSignal = false;
  let sigSignature = "";
  for (const [filePath, addedLines] of diffByFile.entries()) {
    if (!/\.(?:ts|tsx)$/.test(filePath)) continue;
    if (isTestPath(filePath)) continue;
    const added = addedLines.join("\n");
    for (const re of tsFixSignals) {
      const m = re.exec(added);
      if (m) {
        hasSignal = true;
        sigSignature = extractFullLineFromMatch(added, m.index, m[0]);
        break;
      }
    }
    if (hasSignal) break;
  }
  if (!hasSignal) return [];
  return [{
    template: "tsc-clean",
    tsconfigPath,
    signature: sigSignature,
    suggestedPin: `tsc --noEmit stays clean (TS-fix signal observed in this commit)`,
  }];
}

export type DiffModuleExportHit = {
  template: "module-export-stable";
  modulePath: string;
  exportName: string;
  signature: string;
  suggestedPin: string;
};

// Module-export detector. Catches "missing X export in Y" fixes.
// FP guard:
//   - Only fires on `.ts/.tsx/.js/.jsx/.mjs` source files (no JSON / md)
//   - Skip test files / declaration files
//   - Skip default exports of anonymous functions (no name to pin)
//   - Reject very common single-letter / generic names (e, t, x, etc.)
const MODULE_EXPORT_PATTERNS: RegExp[] = [
  /\bexport\s+(?:async\s+)?function\s+([A-Z_][A-Za-z0-9_]{2,})/,
  /\bexport\s+class\s+([A-Z_][A-Za-z0-9_]{2,})/,
  /\bexport\s+(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]{2,})\s*[=:]/,
  /\bexport\s+(?:type|interface|enum)\s+([A-Z_][A-Za-z0-9_]{2,})/,
  // Bracketed named export with no `as` rename:
  // export { foo, bar }
  /\bexport\s*\{\s*([A-Za-z_][A-Za-z0-9_]{2,})\s*[,}]/,
];
const GENERIC_NAMES = new Set([
  "default", "options", "props", "config", "Config", "Props", "Options",
  "data", "value", "name", "title", "type", "Type",
]);
export function detectModuleExportAddedInDiff(diffByFile: DiffByFile): DiffModuleExportHit[] {
  const out: DiffModuleExportHit[] = [];
  const seen = new Set<string>();
  for (const [filePath, addedLines] of diffByFile.entries()) {
    if (isTestPath(filePath) || isVendoredPath(filePath)) continue;
    if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(filePath)) continue;
    if (filePath.endsWith(".d.ts")) continue;
    const added = addedLines
      .map((l) => l.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, ""))
      .filter((l) => l.trim().length > 0)
      .join("\n");
    if (added.length === 0) continue;
    for (const re of MODULE_EXPORT_PATTERNS) {
      const localRe = new RegExp(re.source, re.flags + (re.flags.includes("g") ? "" : "g"));
      let m: RegExpExecArray | null;
      while ((m = localRe.exec(added)) !== null) {
        const exportName = m[1];
        if (!exportName || GENERIC_NAMES.has(exportName)) continue;
        const key = `${filePath}\t${exportName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const sig = extractFullLineFromMatch(added, m.index, m[0]);
        if (sig.length < 10) continue;
        out.push({
          template: "module-export-stable",
          modulePath: filePath,
          exportName,
          signature: sig,
          suggestedPin: `${filePath} exports ${exportName} (added in this fix)`,
        });
      }
    }
  }
  return out;
}

export type DiffReactRouteHit = {
  template: "react-route-registered";
  routerFilePath: string;
  routePath: string;
  signature: string;
  suggestedPin: string;
};

// React-route detector. FP guard:
//   - File must look like a router config (App.tsx / routes.* / *.routes.ts)
//   - The path captured must start with `/` and be ≥ 2 chars
//   - Skip routes that are just `/` (too generic — every SPA has it)
//   - Skip wildcard routes (`*`, `:id` alone)
const ROUTE_REGISTER_PATTERN =
  /\bpath\s*[:=]\s*["'`](\/[^"'`\s]{1,80})["'`]/;
const ROUTER_FILE_RE = /(?:App\.[tj]sx?$|router(?:\.tsx?|\.[tj]s)?$|routes\.[tj]sx?$|\.routes\.[tj]sx?$|RouterProvider|createBrowserRouter)/i;
export function detectReactRouteAddedInDiff(diffByFile: DiffByFile): DiffReactRouteHit[] {
  const out: DiffReactRouteHit[] = [];
  const seen = new Set<string>();
  for (const [filePath, addedLines] of diffByFile.entries()) {
    if (isTestPath(filePath) || isVendoredPath(filePath)) continue;
    if (!/\.(?:tsx|jsx|ts|js)$/.test(filePath)) continue;
    // File-shape filter: must look like a router config OR contain
    // an explicit createBrowserRouter / RouterProvider in the added text.
    const looksLikeRouterFile = ROUTER_FILE_RE.test(filePath);
    const added = addedLines.join("\n");
    const looksLikeRouterContent =
      /\b(?:createBrowserRouter|RouterProvider|useRoutes|createRoute|<Routes|<Route\s)/.test(added);
    if (!looksLikeRouterFile && !looksLikeRouterContent) continue;

    const cleaned = added
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .filter((l) => l.trim().length > 0)
      .join("\n");
    const localRe = new RegExp(ROUTE_REGISTER_PATTERN.source, "g");
    let m: RegExpExecArray | null;
    while ((m = localRe.exec(cleaned)) !== null) {
      const routePath = m[1];
      if (!routePath || routePath === "/" || routePath.length < 2) continue;
      if (/^\/?[*:]/.test(routePath.slice(1))) continue; // wildcard / param-only
      const key = `${filePath}\t${routePath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const sig = extractFullLineFromMatch(cleaned, m.index, m[0]);
      if (sig.length < 10) continue;
      out.push({
        template: "react-route-registered",
        routerFilePath: filePath,
        routePath,
        signature: sig,
        suggestedPin: `<Route ${routePath}> registered in ${filePath} (added in this fix)`,
      });
    }
  }
  return out;
}

export type DiffWebhookHandlerHit = {
  template: "webhook-handler-exists";
  filePath: string;
  handlerSignature: string;
  provider: string;
  suggestedPin: string;
};

// Webhook-handler detector. FP guard:
//   - File path must contain "webhook" OR a known provider name
//   - Handler must be a real export signature, not a comment
const WEBHOOK_PROVIDERS = ["stripe", "retell", "sendgrid", "twilio", "clerk", "supabase", "slack", "github", "shopify", "linear", "calendly"];
const WEBHOOK_HANDLER_PATTERN = /\bexport\s+(?:async\s+)?function\s+(?:POST|PUT|PATCH|handler|webhook)\s*\(/;
export function detectWebhookHandlerAddedInDiff(diffByFile: DiffByFile): DiffWebhookHandlerHit[] {
  const out: DiffWebhookHandlerHit[] = [];
  const seen = new Set<string>();
  for (const [filePath, addedLines] of diffByFile.entries()) {
    if (isTestPath(filePath) || isVendoredPath(filePath)) continue;
    if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(filePath)) continue;
    const lowerPath = filePath.toLowerCase();
    let provider = "";
    if (/\bwebhook/i.test(lowerPath)) {
      const m = /\b(?:stripe|retell|sendgrid|twilio|clerk|supabase|slack|github|shopify|linear|calendly)\b/i.exec(lowerPath);
      provider = m ? m[0].toLowerCase() : "generic";
    } else {
      const provMatch = WEBHOOK_PROVIDERS.find((p) => lowerPath.includes(p));
      if (!provMatch) continue;
      // Provider name alone in path isn't enough — need handler shape too.
      provider = provMatch;
    }
    const added = addedLines
      .map((l) => l.replace(/\/\/.*$/, ""))
      .filter((l) => l.trim().length > 0)
      .join("\n");
    const m = WEBHOOK_HANDLER_PATTERN.exec(added);
    if (!m) continue;
    const sig = extractFullLineFromMatch(added, m.index, m[0]);
    if (sig.length < 10) continue;
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    out.push({
      template: "webhook-handler-exists",
      filePath,
      handlerSignature: sig,
      provider,
      suggestedPin: `${provider} webhook handler at ${filePath} (added/restored in this fix)`,
    });
  }
  return out;
}

export type DiffImportPathHit = {
  template: "import-path-resolves";
  sourceFilePath: string;
  importPath: string;
  signature: string;
  suggestedPin: string;
};

export type DiffChangedLiteralHit = {
  template: "changed-literal-preserved";
  filePath: string;
  oldValue: string;
  newValue: string;
  shape: "url" | "host-url" | "status-code" | "env-key" | "route-path";
  suggestedPin: string;
};

export type DiffFormSubmitErrorHit = {
  template: "form-submit-error-handling";
  filePath: string;
  signature: string;
  suggestedPin: string;
};

// Form-submit error-handling detector. Phase 2 UI/flow pack.
// Fires when a fix adds a `<form>` element AND its submit handler
// has a recognizable error-handling shape (try/catch or .catch).
// FP guards:
//   - File must be .tsx/.jsx/.ts/.js (no markdown / config)
//   - Reject test files / vendored paths
//   - Require BOTH a `<form` element AND an error-handling shape
//     in the same added lines — neither alone is enough
//   - Skip files that already had the same form at the parent
//     commit (only fire on NEW form additions OR newly-added
//     error-handling on an existing form)
const FORM_OPENING_PATTERN = /<form\b[^>]*>/;
const FORM_ERROR_HANDLING_PATTERNS: RegExp[] = [
  // .catch on a returned promise — handles `await fn().catch(...)` AND
  // `fn().then(...).catch(...)` AND multiline chains
  /\.catch\s*\(/,
  // try { … } catch block — match within added lines (cross-line)
  /\btry\s*\{[\s\S]{0,400}?\}\s*catch\b/,
  // toast({ variant: "destructive" }) inside a clear error handler
  // shape — common in shadcn/react-hook-form patterns
  /onError\s*[:=]\s*\(/,
];
export function detectFormSubmitErrorHandlingInDiff(
  diffByFile: DiffByFile
): DiffFormSubmitErrorHit[] {
  const out: DiffFormSubmitErrorHit[] = [];
  const seen = new Set<string>();
  for (const [filePath, addedLines] of diffByFile.entries()) {
    if (isTestPath(filePath) || isVendoredPath(filePath)) continue;
    if (!/\.(?:tsx|jsx|ts|js|mjs|cjs)$/.test(filePath)) continue;
    const added = addedLines
      .map((l) => l.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, ""))
      .filter((l) => l.trim().length > 0)
      .join("\n");
    if (added.length === 0) continue;
    // Must contain a <form ...> opening (or a react-hook-form pattern
    // like `<FormProvider` / `useForm`).
    const hasFormElement = FORM_OPENING_PATTERN.test(added) ||
      /\b(?:useForm|FormProvider|handleSubmit\s*\()/.test(added);
    if (!hasFormElement) continue;
    // Must contain an error-handling shape.
    let errorHit: { signature: string } | null = null;
    for (const re of FORM_ERROR_HANDLING_PATTERNS) {
      const m = re.exec(added);
      if (m) {
        errorHit = { signature: extractFullLineFromMatch(added, m.index, m[0]) };
        break;
      }
    }
    if (!errorHit) continue;
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    if (errorHit.signature.length < 10) continue;
    out.push({
      template: "form-submit-error-handling",
      filePath,
      signature: errorHit.signature,
      suggestedPin: `form in ${filePath} keeps error handling on submit (catches AI removing the try/catch)`,
    });
  }
  return out;
}

// Per-hunk shape, mirrors backtest's DiffHunk so detectors can be
// browser-safe (no node:child_process import here).
export type DiffHunkInput = { added: string[]; removed: string[] };
export type DiffByFileWithHunks = Map<string, { added: string[]; removed: string[]; hunks: DiffHunkInput[] }>;

// Changed-literal detector. Pairs removed+added literals within the
// same hunk by SHAPE (URL→URL, status→status, etc.). FP-safety:
//   - both values must match the same shape regex
//   - both values must be ≥ 4 chars
//   - dev-only URLs (localhost, 127.0.0.1) skipped — they intentionally drift
//   - only one pin per (file, shape, newValue) — no duplicates
const LITERAL_SHAPES: Array<{ shape: DiffChangedLiteralHit["shape"]; pattern: RegExp; minLen: number }> = [
  // URL paths starting with /api, /v1, /webhooks, /auth, /admin, etc.
  { shape: "url", pattern: /["'`](\/(?:api|v\d+|webhooks?|auth|admin|account|dashboard|hook|edge|functions|rpc)\/[a-zA-Z0-9_\-./]{2,80})["'`]/g, minLen: 5 },
  // Absolute host URLs
  { shape: "host-url", pattern: /["'`](https?:\/\/[a-zA-Z0-9.\-]+\.(?:com|io|app|dev|co|net|org)\/[a-zA-Z0-9_\-./]{0,80})["'`]/g, minLen: 12 },
  // HTTP status codes used in response chain calls
  { shape: "status-code", pattern: /\b(?:status|code|statusCode)\s*[(:=]\s*(4\d{2}|5\d{2})\b/g, minLen: 3 },
  // Env keys — VITE_FOO / NEXT_PUBLIC_FOO / REACT_APP_FOO
  { shape: "env-key", pattern: /\b((?:VITE|NEXT_PUBLIC|REACT_APP|EXPO_PUBLIC|NUXT_PUBLIC|GATSBY|PUBLIC|SUPABASE|STRIPE|OPENAI|ANTHROPIC|RETELL)_[A-Z0-9_]{2,40})\b/g, minLen: 6 },
  // SPA route paths
  { shape: "route-path", pattern: /\bpath\s*[:=]\s*["'`](\/[a-zA-Z0-9_\-/:.]{1,60})["'`]/g, minLen: 4 },
];

export function detectChangedLiteralInDiff(
  diffByFile: DiffByFileWithHunks
): DiffChangedLiteralHit[] {
  const out: DiffChangedLiteralHit[] = [];
  const seen = new Set<string>();
  for (const [filePath, dfile] of diffByFile.entries()) {
    if (isTestPath(filePath) || isVendoredPath(filePath)) continue;
    if (!/\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|yaml|yml|sql)$/.test(filePath)) continue;
    for (const hunk of dfile.hunks) {
      if (hunk.added.length === 0 || hunk.removed.length === 0) continue;
      const addedText = hunk.added.join("\n");
      const removedText = hunk.removed.join("\n");
      for (const { shape, pattern, minLen } of LITERAL_SHAPES) {
        // Reset lastIndex on each pass.
        const addedRe = new RegExp(pattern.source, pattern.flags);
        const removedRe = new RegExp(pattern.source, pattern.flags);
        const addedLiterals = new Set<string>();
        let m: RegExpExecArray | null;
        while ((m = addedRe.exec(addedText)) !== null) {
          const v = m[1];
          if (v && v.length >= minLen) addedLiterals.add(v);
        }
        const removedLiterals = new Set<string>();
        while ((m = removedRe.exec(removedText)) !== null) {
          const v = m[1];
          if (v && v.length >= minLen) removedLiterals.add(v);
        }
        // Pair: literals present in added but NOT in removed of same hunk =
        // newValue. Need at least one removed literal to be confident the
        // fix CHANGED a value (rather than just added a new one).
        if (removedLiterals.size === 0 || addedLiterals.size === 0) continue;
        // Skip if it's exactly the same set (no change)
        const newOnly = [...addedLiterals].filter((v) => !removedLiterals.has(v));
        const removedOnly = [...removedLiterals].filter((v) => !addedLiterals.has(v));
        if (newOnly.length === 0 || removedOnly.length === 0) continue;
        // Pick one pair: shortest oldValue + shortest newValue to keep
        // signatures stable across lint reformats. Cap to one pin per
        // (file, shape, newValue) to avoid pin explosion.
        const oldValue = removedOnly.sort((a, b) => a.length - b.length)[0];
        for (const newValue of newOnly) {
          // Skip dev-only / localhost URLs.
          if (shape === "url" || shape === "host-url") {
            if (/\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\.local)\b/.test(newValue)) continue;
            if (/\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\.local)\b/.test(oldValue)) continue;
          }
          // Skip when both are exactly the same after lower-casing —
          // protects against case-only re-shuffles.
          if (newValue.toLowerCase() === oldValue.toLowerCase()) continue;
          const key = `${filePath}\t${shape}\t${newValue}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            template: "changed-literal-preserved",
            filePath,
            oldValue,
            newValue,
            shape,
            suggestedPin: `${shape} value changed in ${filePath}: ${oldValue} → ${newValue} (pin protects the new value)`,
          });
        }
      }
    }
  }
  return out;
}

// Import-path detector. FP guard:
//   - Only NEW imports — must appear in added lines
//   - Skip imports of common dev packages (vitest, eslint, prettier — they're allowed to drift)
//   - Skip type-only imports (`import type`) since those don't affect runtime
//   - Skip relative imports inside test dirs
const IMPORT_PATTERN =
  /^\s*import\s+(?:[^"'`]*?\s+from\s+)?["'`]([^"'`]+)["'`]/m;
const DEV_PACKAGES = /^(?:vitest|@vitest\/|eslint|prettier|@types\/|tsx|tsup|esbuild|@biomejs\/)/;
export function detectImportPathAddedInDiff(diffByFile: DiffByFile): DiffImportPathHit[] {
  const out: DiffImportPathHit[] = [];
  const seen = new Set<string>();
  for (const [filePath, addedLines] of diffByFile.entries()) {
    // Vendored skip — we found the import-path detector firing on
    // `node_modules/.pnpm/.../**/*.d.ts` files during a dep bump. Pure FP.
    if (isTestPath(filePath) || isVendoredPath(filePath)) continue;
    if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(filePath)) continue;
    if (filePath.endsWith(".d.ts")) continue;
    for (const line of addedLines) {
      const trimmed = line.trim();
      // Skip type-only imports — they don't affect runtime.
      if (/^import\s+type\b/.test(trimmed)) continue;
      const m = IMPORT_PATTERN.exec(line);
      if (!m) continue;
      const importPath = m[1];
      if (!importPath || importPath.length < 2) continue;
      // Skip dev packages
      if (DEV_PACKAGES.test(importPath)) continue;
      // Skip URL imports (Deno / esm.sh / unpkg) — these don't
      // resolve via node_modules; the import-path-resolves template's
      // verifier would always fail. They're legitimate but not
      // pinnable with our current mechanism.
      if (/^https?:\/\//.test(importPath)) continue;
      // Skip absolute filesystem paths (rare; can't resolve generically)
      if (importPath.startsWith("/")) continue;
      // Only pin RELATIVE imports (./foo, ../foo). Bare-spec npm
      // imports (react, @tanstack/react-query, etc.) generate
      // broken-at-fix FPs when the backtest worktree doesn't have
      // node_modules — and they're already protected by lockfile-integrity
      // + tsc-clean. The "@/foo" / "~/foo" tsconfig.paths aliases are
      // also rejected by this filter (they don't start with `./`).
      // Discovered in the 2026-05-25 sweep where 27/75 import-path
      // pins on back-in-play were broken-at-fix on bare-spec imports.
      if (!importPath.startsWith("./") && !importPath.startsWith("../")) continue;
      const key = `${filePath}\t${importPath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const sig = trimmed;
      if (sig.length < 10) continue;
      out.push({
        template: "import-path-resolves",
        sourceFilePath: filePath,
        importPath,
        signature: sig,
        suggestedPin: `import ${importPath} from ${filePath} (added in this fix)`,
      });
    }
  }
  return out;
}

// Given a `text` blob (joined added lines), a regex match's index,
// and the matched substring, return the most unique-yet-stable
// signature to capture. Logic:
//   - If the matched substring is multi-line OR > 30 chars, use it
//     as-is (already unique enough; e.g., a multi-line `if (\n
//     res.status === 402`)
//   - Otherwise, extend to the end of the match's enclosing line
//     for added uniqueness — bare matches like `if (` or `headers: {`
//     are too collision-prone on their own
//
// Discovered via Quantasyte: bare m[0] catches like `if (` matched
// at the parent commit too (no signal); falling back to full-line
// for short matches but keeping multi-line matches intact restores
// both catches.
function extractFullLineFromMatch(text: string, matchIdx: number, matchText?: string): string {
  if (matchText && (matchText.includes("\n") || matchText.length > 30)) {
    return matchText.trim();
  }
  const beforeMatch = text.slice(0, matchIdx);
  const newlineBefore = beforeMatch.lastIndexOf("\n");
  const newlineAfter = text.indexOf("\n", matchIdx);
  const lineStart = newlineBefore + 1;
  const lineEnd = newlineAfter === -1 ? text.length : newlineAfter;
  const fullLine = text.slice(lineStart, lineEnd).trim();
  // Final guard: if the full-line is still trivially short (< 8 chars),
  // include the next line too. Catches matches near the start of a
  // braces-only line.
  if (fullLine.length < 8 && newlineAfter !== -1) {
    const nextNewline = text.indexOf("\n", newlineAfter + 1);
    const nextLineEnd = nextNewline === -1 ? text.length : nextNewline;
    return (fullLine + " " + text.slice(newlineAfter + 1, nextLineEnd).trim()).trim();
  }
  return fullLine;
}

// Recursively walk repoPath up to maxFiles, returning relative paths
// matching the file extensions. Skips node_modules / dist / build /
// .git. Used by detectors that need to inspect file content.
function walkRepoFiles(
  repoPath: string,
  opts: { extensions: string[]; maxFiles: number }
): string[] {
  const out: string[] = [];
  const skip = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", ".turbo"]);
  function walk(rel: string): void {
    if (out.length >= opts.maxFiles) return;
    const abs = join(repoPath, rel);
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= opts.maxFiles) return;
      if (skip.has(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(childRel);
      } else if (e.isFile()) {
        if (opts.extensions.some((ext) => e.name.endsWith(ext))) {
          out.push(childRel);
        }
      }
    }
  }
  walk("");
  return out;
}

// Auto-detect package-exports-exist pins from package.json's `main` /
// `exports` entry. Conservative: only emits when we can identify both
// a real entry file AND at least one named export via regex scan.
// Doesn't try to handle TS re-exports / namespaced exports / default
// exports — those are the user's responsibility to pin manually with
// a PR claim.
export type PackageExportsPin = {
  template: "package-exports-exist";
  modulePath: string;
  exports: string[];
  suggestedPin: string;
};

export function detectPackageExportsPins(repoPath: string): PackageExportsPin[] {
  const out: PackageExportsPin[] = [];
  const visited = new Set<string>();
  // Walk root AND every workspace package — without this, libraries
  // published from apps/cli/ or packages/sdk/ in a pnpm monorepo go
  // completely undetected.
  for (const pkgDir of listWorkspacePackageDirs(repoPath).slice(0, WORKSPACE_FANOUT_LIMIT)) {
    const pkgPath = join(pkgDir, "package.json");
    if (!existsSync(pkgPath)) continue;
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch {
      continue;
    }
    // Private packages are apps/services, not libraries — no exports
    // contract to protect. Skip.
    if (pkg.private === true) continue;
    const entryPath = resolveEntryPath(pkg);
    if (!entryPath) continue;
    const sourceCandidates = guessSourcePathsFor(entryPath);
    let modulePath: string | null = null;
    for (const candidate of sourceCandidates) {
      if (existsSync(join(pkgDir, candidate))) {
        modulePath = candidate;
        break;
      }
    }
    if (!modulePath) continue;
    // modulePath is relative to the package dir; the pin needs it
    // relative to the REPO root so the generated test resolves it
    // correctly when run from repo root. Build the rebased form here.
    const repoRelPkgDir = pkgDir === repoPath ? "" : pkgDir.slice(repoPath.length + 1);
    const repoRelModulePath = repoRelPkgDir ? `${repoRelPkgDir}/${modulePath}` : modulePath;
    if (visited.has(repoRelModulePath)) continue;
    visited.add(repoRelModulePath);

    const source = readFileSync(join(pkgDir, modulePath), "utf8");
    const names = new Set<string>();
    const directRegex =
      /^\s*export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([a-zA-Z_$][\w$]*)/gm;
    let m: RegExpExecArray | null;
    while ((m = directRegex.exec(source)) !== null) {
      names.add(m[1]);
    }
    const reexportRegex = /^\s*export\s*\{([^}]+)\}/gm;
    while ((m = reexportRegex.exec(source)) !== null) {
      const inside = m[1];
      const parts = inside.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      for (const part of parts) {
        const asMatch = /^([a-zA-Z_$][\w$]*)\s+as\s+([a-zA-Z_$][\w$]*)$/.exec(part);
        if (asMatch) {
          names.add(asMatch[2]);
          continue;
        }
        const plainMatch = /^([a-zA-Z_$][\w$]*)$/.exec(part);
        if (plainMatch) names.add(plainMatch[1]);
      }
    }

    if (names.size === 0) continue;
    const sortedExports = [...names].sort();
    out.push({
      template: "package-exports-exist",
      modulePath: repoRelModulePath,
      exports: sortedExports,
      suggestedPin: `package exports stay intact from ${repoRelModulePath}: ${sortedExports.slice(0, 3).join(", ")}${sortedExports.length > 3 ? "..." : ""}`,
    });
  }
  return out;
}

function resolveEntryPath(pkg: Record<string, unknown>): string | null {
  const exportsField = pkg.exports;
  if (exportsField && typeof exportsField === "object" && !Array.isArray(exportsField)) {
    const rootExport = (exportsField as Record<string, unknown>)["."];
    if (typeof rootExport === "string") return rootExport;
    if (rootExport && typeof rootExport === "object" && !Array.isArray(rootExport)) {
      const r = rootExport as Record<string, unknown>;
      if (typeof r.import === "string") return r.import;
      if (typeof r.default === "string") return r.default;
      if (typeof r.require === "string") return r.require;
    }
  }
  if (typeof pkg.main === "string") return pkg.main;
  if (typeof pkg.module === "string") return pkg.module;
  return null;
}

// Given a built-artifact entry like "./dist/index.js", guess where
// the source file is. Returns paths relative to the repo root. Most
// packages map dist → src in a 1:1 directory layout.
function guessSourcePathsFor(entryPath: string): string[] {
  const stripped = entryPath.replace(/^\.\//, "");
  const candidates = new Set<string>();
  candidates.add(stripped);
  // Common: dist/foo.js → src/foo.ts / src/foo.tsx / src/foo.mjs
  for (const ext of [".ts", ".tsx", ".mjs", ".js"]) {
    candidates.add(
      stripped
        .replace(/^dist\//, "src/")
        .replace(/^build\//, "src/")
        .replace(/^lib\//, "src/")
        .replace(/\.(?:js|mjs|cjs|d\.ts)$/, ext)
    );
  }
  // No-dist case: keep as-is
  for (const ext of [".ts", ".tsx", ".mjs"]) {
    candidates.add(stripped.replace(/\.js$/, ext));
  }
  return [...candidates];
}

// Auto-detect secret-not-public pin. Emits ONE pin when the repo
// uses a framework with a public env prefix (NEXT_PUBLIC_, VITE_,
// PUBLIC_, REACT_APP_, EXPO_PUBLIC_). Conservative: skips repos
// without a recognized public-prefix framework.
export type SecretNotPublicPin = {
  template: "secret-not-public";
  publicPrefix: string;
  secretMarkers: string[];
  suggestedPin: string;
};

const FRAMEWORK_TO_PUBLIC_PREFIX: { dep: string; prefix: string }[] = [
  { dep: "next", prefix: "NEXT_PUBLIC_" },
  { dep: "vite", prefix: "VITE_" },
  { dep: "@vitejs/plugin-react", prefix: "VITE_" },
  { dep: "react-scripts", prefix: "REACT_APP_" },
  { dep: "@sveltejs/kit", prefix: "PUBLIC_" },
  { dep: "expo", prefix: "EXPO_PUBLIC_" },
  { dep: "expo-router", prefix: "EXPO_PUBLIC_" },
];
const DEFAULT_SECRET_MARKERS = ["SECRET", "TOKEN", "PRIVATE_KEY", "API_KEY"];

export function detectSecretNotPublicPins(repoPath: string): SecretNotPublicPin[] {
  // Union deps across the root and every workspace package — without
  // this, a monorepo where Next.js / Vite / Expo lives in apps/web/
  // (not the root) goes undetected. We emit at most one pin per
  // public-env prefix even if multiple sub-packages use the same
  // framework, since the secret scan it generates is repo-wide.
  const seenPrefixes = new Set<string>();
  const out: SecretNotPublicPin[] = [];
  for (const pkgDir of listWorkspacePackageDirs(repoPath).slice(0, WORKSPACE_FANOUT_LIMIT)) {
    const pkgPath = join(pkgDir, "package.json");
    if (!existsSync(pkgPath)) continue;
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch {
      continue;
    }
    const allDeps = {
      ...(pkg.dependencies as Record<string, unknown> | undefined),
      ...(pkg.devDependencies as Record<string, unknown> | undefined),
      ...(pkg.peerDependencies as Record<string, unknown> | undefined),
    };
    for (const { dep, prefix } of FRAMEWORK_TO_PUBLIC_PREFIX) {
      if (allDeps[dep] && !seenPrefixes.has(prefix)) {
        seenPrefixes.add(prefix);
        out.push({
          template: "secret-not-public",
          publicPrefix: prefix,
          secretMarkers: DEFAULT_SECRET_MARKERS,
          suggestedPin: `no ${prefix}* env var ever contains a secret (${DEFAULT_SECRET_MARKERS.join("/")})`,
        });
      }
    }
  }
  return out;
}

// Well-known config invariants the detector emits as auto-pins at
// baseline-on-init. Conservative whitelist: each entry has a real,
// load-bearing reason to exist. Adding to this list = a pin every
// AI-coder repo will get on install (with no FP risk because we only
// auto-emit for files that actually exist + contain the expected text
// already). If the text is MISSING at detect time, we don't pin —
// that's the user's choice to add via `pinned protect`.
export type ConfigInvariantPin = {
  template: "config-invariant";
  configPath: string;
  expected: string;
  label: string;
  suggestedPin: string;
};

export function detectConfigInvariantPins(repoPath: string): ConfigInvariantPin[] {
  const out: ConfigInvariantPin[] = [];

  // 1. Pinned's own GitHub Actions workflow integrity. If the customer
  //    installed pinned init's workflow, asserting that `id-token: write`
  //    is declared catches AI-driven cleanup that removes the permission
  //    (without which LLM extraction silently fails).
  const wf = join(repoPath, ".github", "workflows", "pinned.yml");
  if (existsSync(wf)) {
    const content = readFileSync(wf, "utf8");
    if (content.includes("id-token: write")) {
      out.push({
        template: "config-invariant",
        configPath: ".github/workflows/pinned.yml",
        expected: "id-token: write",
        label: "OIDC permission",
        suggestedPin: `Pinned workflow keeps the \`id-token: write\` OIDC permission.`,
      });
    }
    if (content.includes("contents: write")) {
      out.push({
        template: "config-invariant",
        configPath: ".github/workflows/pinned.yml",
        expected: "contents: write",
        label: "auto-commit permission",
        suggestedPin: `Pinned workflow keeps the \`contents: write\` permission for auto-commit.`,
      });
    }
  }

  // 2. Pinned guardrail block in CLAUDE.md. If init installed it,
  //    asserting the markers are still present catches AI agents that
  //    "tidy up" CLAUDE.md and delete sections they don't recognize.
  const claudeMd = join(repoPath, "CLAUDE.md");
  if (existsSync(claudeMd)) {
    const content = readFileSync(claudeMd, "utf8");
    if (content.includes("<!-- pinnedai:start -->") && content.includes("<!-- pinnedai:end -->")) {
      out.push({
        template: "config-invariant",
        configPath: "CLAUDE.md",
        expected: "<!-- pinnedai:start -->",
        label: "Pinned guardrail block",
        suggestedPin: `CLAUDE.md keeps the Pinned guardrail block.`,
      });
    }
  }

  return out;
}

export type CliLibraryPin = {
  template: "cli-exits-zero" | "library-returns-candidate";
  // For cli-exits-zero: the binary name as customers invoke it.
  // For library-returns-candidate: the exported function name.
  identifier: string;
  // Resolved local path to the executable / module file.
  // Relative to repoPath. Used as a sanity check that the entry
  // actually exists on disk.
  resolvedPath: string;
  // Path to the package.json declaring this entry. Useful for telling
  // the user WHICH workspace package the pin guards.
  sourcePackageJson: string;
  // Generated pin claim text — passes through parseClaims for
  // round-trip validation in tests.
  suggestedPin: string;
};

const WORKSPACE_FANOUT_LIMIT = 50;

export function detectCliLibraryPins(repoPath: string): CliLibraryPin[] {
  const found: CliLibraryPin[] = [];
  // listWorkspacePackageDirs reads BOTH package.json#workspaces (npm/yarn)
  // AND pnpm-workspace.yaml. Without the pnpm branch the detector was
  // blind to every workspace package in pinnedai / quantasyte / most
  // modern TS monorepos. Bounded by WORKSPACE_FANOUT_LIMIT.
  const dirs = listWorkspacePackageDirs(repoPath).slice(0, WORKSPACE_FANOUT_LIMIT);

  for (const dir of dirs) {
    const pkgPath = join(dir, "package.json");
    if (!existsSync(pkgPath)) continue;
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch {
      continue;
    }
    const bin = pkg.bin;
    if (typeof bin === "string") {
      collectBin(dir, pkgPath, basename(dir), bin, found);
    } else if (bin && typeof bin === "object") {
      for (const [name, relPath] of Object.entries(bin as Record<string, unknown>)) {
        if (typeof relPath === "string") {
          collectBin(dir, pkgPath, name, relPath, found);
        }
      }
    }
  }

  return found;
}

function collectBin(
  pkgDir: string,
  pkgPath: string,
  binName: string,
  relPath: string,
  out: CliLibraryPin[]
): void {
  // Guardrails on bin name — must be safe identifier (no shell injection,
  // no path traversal). Most real CLIs have alphanumeric+dash names.
  if (!/^[a-zA-Z][\w.-]{0,63}$/.test(binName)) return;
  // Guardrails on resolved path — must be a real file inside the package
  // dir, not outside (defense against malicious bin: "/etc/passwd").
  const resolved = join(pkgDir, relPath);
  if (!resolved.startsWith(pkgDir + "/") && resolved !== pkgDir) return;
  if (!existsSync(resolved)) return;
  out.push({
    template: "cli-exits-zero",
    identifier: binName,
    resolvedPath: relPath,
    sourcePackageJson: pkgPath,
    // Generate as a pin the parser can re-extract. Uses the canonical
    // form: `<cmd> --help` exits 0 / cleanly. --help is the safest
    // universal invocation — even a CLI in a broken state will usually
    // print help and exit 0.
    suggestedPin: `\`${binName} --help\` exits 0.`,
  });
}

function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// Parse `pnpm-workspace.yaml`'s `packages:` list into glob strings.
// Hand-rolled to avoid pulling in a YAML dep for a single shape we
// need. Supports the realistic forms:
//
//   packages:
//     - "apps/*"
//     - 'packages/*'
//     - tools
//
// Anything else (catalogs, overrides, package-extensions) is ignored
// — we only care about the workspace globs. Returns [] if the file
// doesn't exist or doesn't parse.
function parsePnpmWorkspaceGlobs(repoPath: string): string[] {
  const path = join(repoPath, "pnpm-workspace.yaml");
  if (!existsSync(path)) return [];
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const lines = content.split("\n");
  const globs: string[] = [];
  let inPackages = false;
  for (const raw of lines) {
    // Top-level key change ends the packages block.
    if (/^[A-Za-z_][\w-]*:/.test(raw)) {
      inPackages = raw.startsWith("packages:");
      continue;
    }
    if (!inPackages) continue;
    const m = /^\s*-\s*["']?([^"'\n#]+?)["']?\s*(?:#.*)?$/.exec(raw);
    if (m) globs.push(m[1].trim());
  }
  return globs;
}

// Expand a list of workspace globs (from either pnpm-workspace.yaml or
// package.json#workspaces) into concrete absolute directory paths that
// contain a package.json. Supports the realistic shapes:
//
//   "apps/*"            → every immediate child of apps/ with package.json
//   "packages/*"        → same
//   "tools"             → the literal dir if it has package.json
//
// Anything more exotic (nested globs, ** patterns) is ignored — keeps
// the implementation small and the fanout bounded. The repoRoot itself
// is always included as the first entry so root-only checks (lockfile,
// root-package-json deps) still fire.
function listWorkspacePackageDirs(repoPath: string): string[] {
  const out: string[] = [repoPath];
  const visited = new Set([repoPath]);

  // Collect globs from BOTH sources. pnpm and npm/yarn can coexist
  // (rare but possible during migrations) — unioning is safe.
  const globs: string[] = [];
  const rootPkgPath = join(repoPath, "package.json");
  if (existsSync(rootPkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(rootPkgPath, "utf8")) as Record<string, unknown>;
      const ws = pkg.workspaces;
      if (Array.isArray(ws)) {
        for (const g of ws) if (typeof g === "string") globs.push(g);
      } else if (ws && typeof ws === "object" && Array.isArray((ws as { packages?: unknown }).packages)) {
        for (const g of (ws as { packages: string[] }).packages) globs.push(g);
      }
    } catch {
      /* ignore */
    }
  }
  for (const g of parsePnpmWorkspaceGlobs(repoPath)) globs.push(g);
  // lerna.json: { "packages": ["packages/*"] }. Declining tool but
  // still in the wild, especially on long-lived JS monorepos. Cheap
  // to support and same glob shape as the others.
  const lernaPath = join(repoPath, "lerna.json");
  if (existsSync(lernaPath)) {
    try {
      const lerna = JSON.parse(readFileSync(lernaPath, "utf8")) as Record<string, unknown>;
      if (Array.isArray(lerna.packages)) {
        for (const g of lerna.packages) if (typeof g === "string") globs.push(g);
      }
    } catch {
      /* ignore */
    }
  }

  for (const glob of globs) {
    const trimmed = glob.replace(/\/+$/, "");
    const m = /^([^/*]+)\/\*$/.exec(trimmed);
    if (m) {
      const parent = join(repoPath, m[1]);
      if (!existsSync(parent)) continue;
      for (const child of readdirSyncSafe(parent)) {
        const childDir = join(parent, child);
        if (visited.has(childDir)) continue;
        if (existsSync(join(childDir, "package.json"))) {
          out.push(childDir);
          visited.add(childDir);
        }
      }
    } else if (!trimmed.includes("*")) {
      const dir = join(repoPath, trimmed);
      if (visited.has(dir)) continue;
      if (existsSync(join(dir, "package.json"))) {
        out.push(dir);
        visited.add(dir);
      }
    }
    // Patterns with embedded ** or multi-segment globs aren't supported.
  }
  return out;
}

// Order matters — more specific rules first.
const RULES: RiskRule[] = [
  // Next.js App Router: new route file
  {
    id: "next-app-route-added",
    match: (f) =>
      f.status === "added" &&
      /(?:^|\/)(?:src\/)?app\/api\/.+\/route\.(?:ts|tsx|js|jsx)$/.test(f.path) &&
      !isTestPath(f.path) &&
      !isAuthEndpoint(f.path) &&
      !isLikelyPublicEndpoint(f.path),
    build: (f) => {
      const route = "/api/" + f.path
        .replace(/^.*?(?:^|\/)(?:src\/)?app\/api\//, "")
        .replace(/\/route\.(?:ts|tsx|js|jsx)$/, "");
      return {
        template: "auth-required",
        route,
        reason: "new public API route — needs an auth or rate-limit claim",
        suggestedPin: `Auth required on ${route}.`,
      };
    },
  },
  // Next.js Pages Router: new route file
  {
    id: "next-pages-route-added",
    match: (f) =>
      f.status === "added" &&
      /(?:^|\/)(?:src\/)?pages\/api\/.+\.(?:ts|tsx|js|jsx)$/.test(f.path) &&
      !isTestPath(f.path) &&
      !isAuthEndpoint(f.path) &&
      !isLikelyPublicEndpoint(f.path),
    build: (f) => {
      const route = "/api/" + f.path
        .replace(/^.*?(?:^|\/)(?:src\/)?pages\/api\//, "")
        .replace(/\.(?:ts|tsx|js|jsx)$/, "");
      return {
        template: "auth-required",
        route,
        reason: "new public API route — needs an auth or rate-limit claim",
        suggestedPin: `Auth required on ${route}.`,
      };
    },
  },
  // Express / Fastify / Hono — explicit routes dir
  {
    id: "express-routes-added",
    match: (f) =>
      f.status === "added" &&
      /(?:^|\/)(?:src\/)?routes\/.+\.(?:ts|tsx|js|jsx)$/.test(f.path) &&
      !isTestPath(f.path) &&
      !isAuthEndpoint(f.path) &&
      !isLikelyPublicEndpoint(f.path),
    build: (f) => {
      const name = f.path
        .replace(/^.*?(?:^|\/)(?:src\/)?routes\//, "")
        .replace(/\.(?:ts|tsx|js|jsx)$/, "")
        .replace(/\/index$/, "")
        .replace(/[._-]/g, "/");
      return {
        template: "auth-required",
        route: `/api/${name}`,
        reason: "new route handler — pin auth-required and/or rate-limit",
        suggestedPin: `Auth required on /api/${name}.`,
      };
    },
  },
  // Hono / Fastify / Express handlers dir
  {
    id: "handlers-route-added",
    match: (f) =>
      f.status === "added" &&
      // Match handlers/, controllers/, or top-level api/ (Vercel-style)
      // but NOT app/api/* or pages/api/* — those are handled by the
      // next-app-route-added / next-pages-route-added rules and would
      // produce duplicate pins.
      (/(?:^|\/)(?:src\/)?(?:handlers|controllers)\/.+\.(?:ts|js)$/.test(f.path) ||
        /^(?:src\/)?api\/.+\.(?:ts|js)$/.test(f.path)) &&
      !/webhook/i.test(f.path) &&
      !/(?:^|\/)(?:app|pages)\/api\//.test(f.path) &&
      !isTestPath(f.path) &&
      !isAuthEndpoint(f.path) &&
      !isLikelyPublicEndpoint(f.path),
    build: (f) => {
      const name = f.path
        .replace(/^.*?(?:^|\/)(?:src\/)?(?:handlers|controllers|api)\//, "")
        .replace(/\.(?:ts|js)$/, "");
      return {
        template: "auth-required",
        route: `/api/${name}`,
        reason: "new handler/controller — pin auth-required for public surfaces",
        suggestedPin: `Auth required on /api/${name}.`,
      };
    },
  },
  // Webhook handler — should be idempotent.
  //
  // The route guesser used to grab whatever token sat next to "webhook"
  // in the path. That produced junk like `/webhooks/lib` (from
  // `lib/webhookDelivery.ts`), `/webhooks/controllers`, `/webhooks/
  // services`, and `/webhooks/index` (from `supabase/functions/retell-
  // webhook/index.ts`). Found via dyad-apps sweep — see the bait audit.
  //
  // New behavior: try to extract a CLEAR provider name (`stripe`,
  // `retell`, `twilio`, `github`, etc.). If the only candidate is a
  // generic directory name like `lib` / `routes` / `controllers` /
  // `services` / `handlers` / `index` / `src` / `utils`, emit a risk
  // hint with empty suggestedPin (filtered out by the scanDiffFull
  // tail filter) so we don't auto-create a junk pin.
  {
    id: "webhook-handler",
    match: (f) => {
      if (!/webhook/i.test(f.path)) return false;
      // Real webhook HANDLERS live in server code (.ts / .js / .py / .rb /
      // .go). .tsx / .jsx files matching `webhook` are nearly always
      // React UI components (e.g. webhook-create-dialog.tsx) — never
      // inbound handlers.
      if (!/\.(?:ts|js|py|rb|go)$/.test(f.path)) return false;
      if (isTestPath(f.path)) return false;
      const lower = f.path.toLowerCase();
      // Path-shape denylist: if the file lives in a UI / types / hooks
      // directory, it's not a server-side webhook handler.
      for (const seg of WEBHOOK_PATH_DENY) {
        if (lower.includes(seg)) return false;
      }
      return true;
    },
    build: (f) => {
      const guess = guessWebhookProvider(f.path);
      if (!guess) {
        // No clear provider name — emit risk hint only, no pin.
        return {
          template: "idempotent",
          reason:
            "webhook code touched but provider name unclear — review and pin explicitly if this handles inbound provider events",
          suggestedPin: "",
        };
      }
      const route = `/webhooks/${guess}`;
      return {
        template: "idempotent",
        route,
        reason: "webhook handler touched — should be idempotent on the provider's event id",
        suggestedPin: `Makes ${route} idempotent on event_id.`,
      };
    },
  },
  // Middleware change — auth surface. NOTE: we deliberately don't
  // emit a concrete pin here because middleware.ts typically protects
  // a SET of routes (via its `export const config = { matcher: [...] }`),
  // not a single one. Previously we emitted a placeholder pin
  // `Auth required on /api/<your-route>.` — that string isn't a real
  // route and fails round-trip parseability. Until v0.2 adds
  // matcher-config resolution, surface this only as a RISK HINT
  // (no suggestedPin populated) so the caller can show "you have auth
  // middleware — make sure the routes it protects have explicit
  // auth-required pins" without auto-generating junk.
  {
    id: "middleware-changed",
    match: (f) =>
      /(?:^|\/)middleware\.(?:ts|tsx|js|jsx)$/.test(f.path) &&
      !isTestPath(f.path),
    build: () => ({
      template: "auth-required",
      reason: "auth middleware touched — review the routes it protects and pin each one explicitly",
      suggestedPin: "",
    }),
  },
  // Env file changed — possible new required env var
  {
    id: "env-file-changed",
    match: (f) =>
      /(?:^|\/)\.env(?:\.[\w.-]+)?$/.test(f.path) &&
      !isTestPath(f.path),
    build: () => ({
      template: "env-required",
      reason: "env file changed — pin env-required so missing-config deploys fail loudly",
      suggestedPin: "(env-required template ships in v0.2 — flagging now)",
    }),
  },
];

// Derive a likely API route from a changed file path. Used to check
// which existing pins guard the touched code (pin coverage).
export function deriveRouteFromPath(path: string): string | null {
  // Use (?:^|/) instead of ^ so monorepo paths like
  // `apps/api/src/routes/contact.ts` are also recognized. The
  // separate detectReturnsStatusPins filter already used this form;
  // the deriver was inconsistent and silently returned null for
  // every workspace-nested route. Surfaced via the v0.1 bug-fix
  // benchmark (zero `auth-required` pins generated despite quantasyte
  // having dozens of route files under apps/api/).
  let m = /(?:^|\/)(?:src\/)?app\/api\/(.+)\/route\.(?:ts|tsx|js|jsx)$/.exec(path);
  if (m) return "/api/" + m[1];
  m = /(?:^|\/)(?:src\/)?pages\/api\/(.+)\.(?:ts|tsx|js|jsx)$/.exec(path);
  if (m) return "/api/" + m[1];
  m = /(?:^|\/)(?:src\/)?routes\/(.+)\.(?:ts|tsx|js|jsx)$/.exec(path);
  if (m) return "/api/" + m[1].replace(/\/index$/, "");
  // Vercel pages-style serverless functions in a top-level `api/` dir
  // (NOT inside `app/` or `pages/`). Production-grade pattern — used
  // by quantapact's tier-checkout.ts / badge-portal.ts / tier-webhook.ts.
  // Without this branch, top-level `api/X.ts` returns null and the
  // route-aware detectors (write endpoints, auth checks) skip the
  // file silently. Tight constraint: path must START with `api/` at
  // repo root OR `apps/<workspace>/api/` in a monorepo. Rejects
  // `lib/api/X.ts`, `src/api/X.ts`, etc. (which aren't routes).
  m = /^api\/(.+)\.(?:ts|tsx|js|jsx)$/.exec(path);
  if (m) return "/api/" + m[1].replace(/\/index$/, "");
  m = /^apps\/[^/]+\/api\/(.+)\.(?:ts|tsx|js|jsx)$/.exec(path);
  if (m) return "/api/" + m[1].replace(/\/index$/, "");
  // Middleware files protect a *family* of routes (typically /admin/*,
  // /account/*, or "everything except public"). The exact protected
  // path isn't derivable from filename alone — middleware decides per
  // request via matchers. We return a sentinel route so the pin still
  // gets generated and pinned-to-the-file via static-mode. Discovered
  // via Quantasyte: commits eadffa6 + 1c4c2df both fixed middleware.ts
  // (Next.js-style matcher → working in-function filter); the bug-fix
  // benchmark missed them because deriveRouteFromPath returned null.
  if (/(?:^|\/)(?:src\/)?middleware\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(path)) {
    return "* (middleware)";
  }
  if (/webhook/i.test(path)) {
    const provider = guessWebhookProvider(path);
    if (provider) return "/webhooks/" + provider;
  }
  return null;
}

// Path components that are generic file/directory names — NOT real
// provider names. If our regex captures one of these as the
// "provider", we should reject the guess instead of emitting a
// nonsense route like `/webhooks/lib` or `/webhooks/index`.
//
// Surfaced via the dyad-apps sweep — these are the exact tokens the
// old guesser was producing as "providers" for files like:
//   lib/webhookDelivery.ts            → /webhooks/lib
//   apps/api/src/routes/webhook.ts    → /webhooks/routes
//   supabase/functions/x-webhook/index.ts → /webhooks/index
const GENERIC_PATH_TOKENS = new Set([
  "lib",
  "src",
  "routes",
  "controllers",
  "services",
  "handlers",
  "index",
  "utils",
  "helpers",
  "common",
  "functions",
  "api",
  "app",
  "apps",
  "pages",
  "delivery",
  "service",
  "controller",
  "handler",
  "route",
  "core",
  "internal",
  "shared",
  "main",
  "default",
  // Surfaced via the documenso OSS sweep — these were producing
  // routes like /webhooks/dialogs (from a webhook-create-dialog.tsx
  // UI component) and /webhooks/universal (from a utility module).
  "dialogs",
  "dialog",
  "components",
  "component",
  "general",
  "types",
  "type",
  "universal",
  "only",
  "execute",
  "send",
  "sender",
  "dispatch",
  "dispatcher",
  "outbound",
  "trigger",
  "triggers",
  "fire",
  "emit",
  "emitter",
  "broadcast",
  "publish",
  "publisher",
  "queue",
  "worker",
  "job",
  "jobs",
  "scheduler",
  "schedule",
  "create",
  "delete",
  "edit",
  "update",
  "find",
  "list",
  "get",
  "fetch",
  "assert",
  "verify",
  "validate",
  "format",
  "transform",
  "parse",
  "build",
  "load",
  "render",
  "save",
  "store",
  "process",
  "logs",
  "log",
  "calls",
  "call",
  "events",
  "event",
  "payload",
  "trpc",
  "rpc",
  "router",
  "server",
  "client",
  "remix",
  "next",
  "vite",
  "node",
  "edge",
  "worker",
  "workers",
  "platform",
  "module",
  "modules",
  "package",
  "packages",
  "scripts",
  "test",
  "tests",
  "specs",
  "fixtures",
  // Surfaced via cal.com OSS sweep (NestJS-style architecture):
  "decorators",
  "decorator",
  "guards",
  "guard",
  "inputs",
  "input",
  "outputs",
  "output",
  "pipes",
  "pipe",
  "interceptors",
  "interceptor",
  "filters",
  "filter",
  "dto",
  "dtos",
  // Surfaced via formbricks OSS sweep:
  "management",
  "url",
  "urls",
  "integrations",
  "integration",
  "zod",
  "schema",
  "schemas",
  "validation",
  "actions",
  "action",
]);

// Path-shape denylist for the webhook rule. If any of these segments
// appears anywhere in the path, the file is much more likely a UI
// component, types module, or internal utility than a real inbound
// webhook handler. Surfaced via the documenso OSS sweep — examples:
//   apps/remix/app/components/dialogs/webhook-create-dialog.tsx
//   packages/lib/types/webhook-payload.ts
//   packages/trpc/server/webhook-router/find-webhook-calls.ts
const WEBHOOK_PATH_DENY = [
  "/components/",
  "/types/",
  "/dialogs/",
  "/hooks/",
  "/stores/",
  "/state/",
  "/styles/",
  "/locales/",
  "/i18n/",
  "/migrations/",
];

// Try to extract a clear provider name from a webhook-adjacent path.
// Returns null when no clear provider can be identified (in which case
// the caller should emit a risk hint, not a junk pin).
//
// Strategy: prefer the provider-BEFORE-webhook pattern
// (`stripe-webhook/...` → "stripe"). Fall back to the
// AFTER-webhook pattern (`webhook/stripe-handler` → "stripe").
// Reject any captured token that's a generic path component.
//
// Exported so the audit can verify the helper directly without
// running the full scan pipeline.
// Known webhook providers — companies and services that publish
// webhooks. The denylist-only approach is whack-a-mole: every codebase
// invents new internal "webhook-foo" patterns (controllers, guards,
// services, builders, mappers, serializers, ...) that get
// misclassified as providers. The allowlist inverts the problem: we
// only emit a webhook pin when the extracted token matches a known
// provider. Unknown tokens return null and surface as a risk hint
// instead — the user can pin them manually if they really are
// providers we don't know about yet.
//
// Add a new provider when you find it in the wild. Should be the
// shortest unambiguous form (e.g. "stripe", not "stripepayment").
//
// Exported so the audit can verify against the canonical list.
export const KNOWN_WEBHOOK_PROVIDERS = new Set([
  // Payments / billing
  "stripe", "paypal", "square", "braintree", "adyen", "mollie", "razorpay",
  "paddle", "checkout", "mercury", "brex", "wise",
  // Commerce
  "shopify", "woocommerce", "bigcommerce", "magento",
  // Communication / messaging
  "twilio", "sendgrid", "mailgun", "postmark", "resend", "mailchimp",
  "mailerlite", "convertkit",
  "slack", "discord", "msteams", "telegram", "whatsapp", "signal",
  // Dev tools / hosting
  "github", "gitlab", "bitbucket", "linear", "jira", "asana", "monday",
  "clickup", "notion", "airtable", "typeform",
  "vercel", "netlify", "render", "fly", "railway", "cloudflare",
  "buildkite", "circleci", "travisci",
  // Auth / identity
  "clerk", "auth0", "okta", "workos", "stytch", "magic",
  // Calendaring / meetings
  "calendly", "zoom", "calcom", "google", "outlook",
  // CRM / customer
  "hubspot", "salesforce", "intercom", "zendesk", "drift", "crisp",
  "freshdesk",
  // Analytics
  "segment", "mixpanel", "amplitude", "posthog", "rudderstack",
  // Realtime / push
  "pusher", "ably", "pubnub", "knock", "courier",
  // Voice / AI
  "retell", "vapi", "deepgram", "elevenlabs", "openai", "anthropic",
  "replicate", "fireflies", "gong",
  // Observability
  "datadog", "sentry", "bugsnag", "newrelic", "loggly",
  // Misc SaaS
  "zapier", "make", "n8n", "ifttt", "pipedream", "nango",
  "airbyte", "fivetran",
  "ngrok",
  "linkedin", "facebook", "instagram", "tiktok", "twitter", "youtube",
  "coinbase", "alby", "btcpayserver",
  "veriff", "persona", "sumsub",
  "appsflyer", "branch", "adjust",
  "launchdarkly",
  "formspree",
  "dub",
  "qstash",
  "supabase", "neon", "planetscale",
  "prismic", "sanity", "contentful",
  "mux", "imgix", "uploadcare", "cloudinary",
  "plaid", "teller",
  "algolia", "typesense", "meilisearch",
  "openpipe", "langfuse", "langsmith",
]);

export function guessWebhookProvider(path: string): string | null {
  const lower = path.toLowerCase();
  // Real-world provider names are at least 3 chars. A 1-2 char
  // "provider" is essentially noise.
  const isValidProvider = (s: string | undefined): s is string =>
    typeof s === "string" && s.length >= 3 && !GENERIC_PATH_TOKENS.has(s);
  // Strategy 1: `<provider>-webhook` / `<provider>/webhook` /
  // `<provider>_webhook`. Captures the segment immediately before
  // "webhook".
  const before = lower.match(/([a-z0-9]+)[/\-_]webhooks?(?:[/\-_.]|$)/);
  // Strategy 2: `webhook/<provider>` or `webhook-<provider>`. The
  // segment AFTER "webhook" — usually present in directory layouts
  // like `webhooks/stripe/handler.ts`.
  const after = lower.match(/webhooks?[/\-_]([a-z0-9]+)/);
  // PREFER known providers from the allowlist. Both strategies are
  // tried; if EITHER captures a known provider, return it. Unknown
  // tokens are not promoted — the caller emits a risk hint instead.
  for (const candidate of [before?.[1], after?.[1]]) {
    if (isValidProvider(candidate) && KNOWN_WEBHOOK_PROVIDERS.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function scanDiff(input: ScanInput): Suggestion[] {
  return scanDiffFull(input).suggestions;
}

export function scanDiffFull(input: ScanInput): ScanResult {
  const fileSuggestions = new Map<string, Suggestion>();
  const seenSuggestionKeys = new Set<string>();

  for (const f of input.changedFiles) {
    for (const rule of RULES) {
      if (!rule.match(f)) continue;
      const built = rule.build(f);
      if (!built) continue;

      if (built.route && isAlreadyCovered(built, input)) {
        continue;
      }

      const key = `${built.template}:${built.route ?? rule.id}`;
      if (seenSuggestionKeys.has(key)) {
        const existing = fileSuggestions.get(key)!;
        existing.files.push(f.path);
        continue;
      }
      seenSuggestionKeys.add(key);
      fileSuggestions.set(key, { ...built, files: [f.path] });
    }
  }

  // Pin coverage: for each changed file, list active pins guarding it
  const coverage: Coverage[] = [];
  for (const f of input.changedFiles) {
    const route = deriveRouteFromPath(f.path);
    if (!route) continue;
    const pins = input.existingPins.filter(
      (p) => p.status === "active" && claimRoute(p.claim) === route
    );
    if (pins.length > 0) coverage.push({ file: f.path, pins });
  }

  // Second-pass filter: apply isLikelyPublicEndpoint + isAuthEndpoint
  // against the SYNTHESIZED route too, not just the file path. The
  // file-path check catches `app/api/auth/[...nextauth]/route.ts` —
  // but route synthesis can produce a public-endpoint route from a
  // path that doesn't itself look public (e.g. `apps/api/src/routes/
  // webhook.ts` → `/api/webhook`, which is a webhook receiver and
  // shouldn't get an auth-required pin).
  for (const [key, sug] of [...fileSuggestions]) {
    if (sug.route) {
      if (isAuthEndpoint(sug.route) || isLikelyPublicEndpoint(sug.route)) {
        fileSuggestions.delete(key);
      }
    }
  }

  // Drop suggestions whose suggestedPin is empty — those are RISK HINTS
  // (e.g. middleware.ts changed: "pin auth-required on the routes it
  // protects") that the detector can flag but can't auto-pin without
  // more context. Emitting an empty-claim suggestion would create a
  // junk pin if the caller piped scan output into `protect --all`.
  // Round-trip-parseability invariant: every emitted suggestedPin
  // must re-parse to a single Claim with the same route. Empty
  // strings fail that invariant; placeholder strings (`<your-route>`)
  // also fail because parseClaims rejects angle brackets in routes.
  const suggestions = Array.from(fileSuggestions.values()).filter(
    (s) => s.suggestedPin && s.suggestedPin.length > 0
  );

  return {
    suggestions,
    coverage,
    touchedPins: findTouchedPins(input),
  };
}

// Find pins whose protected behavior the current diff intersects.
// This is the "diff → which existing pins are at risk" detector that
// powers the statusline's "N protected behavior touched" state and
// the touched-pins block in scan-diff output. Inverse direction from
// the existing Coverage[] (which is file → pins): here we group by
// pin so callers can say "pin X was touched by N files."
//
// Two intersection paths:
//   1. Route match — pin's claim has a route + a changed file maps
//      to that route via deriveRouteFromPath().
//   2. File match  — pin's coverage.files contains a changed file
//      path (direct equality). Backfills via coverageFromClaim() if
//      the registry entry was written by a pre-v0.1 CLI that didn't
//      persist covers.
//
// Pure function — no fs/git. The CLI wrapper supplies changedFiles.
export function findTouchedPins(input: ScanInput): TouchedPin[] {
  const byPinKey = new Map<string, TouchedPin>();

  for (const pin of input.existingPins) {
    if (pin.status !== "active") continue;

    const cov: PinCoverage = pin.covers ?? coverageFromClaim(pin.claim);
    const pinRoute = claimRoute(pin.claim);
    const coverFiles = new Set(cov.files ?? []);

    const matchedRoutes: { route: string; files: string[] }[] = [];
    const matchedFiles: string[] = [];

    // Route-match path: the pin asserts about a URL route, and a
    // changed file is the implementation for that route.
    if (pinRoute) {
      const filesForRoute: string[] = [];
      for (const f of input.changedFiles) {
        if (f.status === "deleted") continue; // deleted route file is a separate signal
        const derived = deriveRouteFromPath(f.path);
        if (derived === pinRoute) filesForRoute.push(f.path);
      }
      if (filesForRoute.length > 0) {
        matchedRoutes.push({ route: pinRoute, files: filesForRoute });
      }
    }

    // File-match path: the pin's coverage lists explicit source files.
    if (coverFiles.size > 0) {
      for (const f of input.changedFiles) {
        if (f.status === "deleted") continue;
        if (coverFiles.has(f.path)) matchedFiles.push(f.path);
      }
    }

    if (matchedRoutes.length === 0 && matchedFiles.length === 0) continue;

    byPinKey.set(pin.claimId, {
      pin,
      matchedRoutes,
      matchedFiles,
    });
  }

  return Array.from(byPinKey.values());
}

function isAlreadyCovered(
  s: Omit<Suggestion, "files">,
  input: ScanInput
): boolean {
  if (!s.route) return false;
  // For auth-required, the route alone is the full identity — a
  // route either requires auth or doesn't, no rate/window/idField.
  // For rate-limit and idempotent, suggestions don't currently carry
  // the specific rate/window/idField (they're heuristic warnings),
  // so we treat any same-template/same-route claim as coverage.
  // When templates evolve to allow distinct variants on the same
  // route, this function will need full claimKey() exact-match.
  const matches = (c: Claim): boolean => {
    return c.template === s.template && claimRoute(c) === s.route;
  };

  for (const c of input.prBodyClaims) {
    if (matches(c)) return true;
  }
  for (const e of input.existingPins) {
    if (e.status === "active" && matches(e.claim)) return true;
  }
  return false;
}

// ---------- renderers ----------

// Render the touched-pins block — the "REVIEW · N protected behavior
// touched" surface. Empty string when nothing's touched (so the CLI
// can skip the section without an `if`). Human-readable; mirrors
// renderTouchedPinsMarkdown for PR-comment use.
export function renderTouchedPinsHuman(touched: TouchedPin[]): string {
  if (touched.length === 0) return "";
  const lines: string[] = [
    `◆ pinned · REVIEW · ${touched.length} protected behavior${touched.length === 1 ? "" : "s"} touched`,
    "",
    "This diff edits code already guarded by Pinned. Run `pinned test` before merge to confirm the contract still holds:",
    "",
  ];
  for (const t of touched) {
    const summary = describeTouched(t);
    lines.push(`  ◇ ${summary}`);
    for (const route of t.matchedRoutes) {
      for (const f of route.files) lines.push(`      ${f}  →  ${route.route}`);
    }
    for (const f of t.matchedFiles) lines.push(`      ${f}`);
  }
  return lines.join("\n");
}

export function renderTouchedPinsMarkdown(touched: TouchedPin[]): string {
  if (touched.length === 0) return "";
  const lines: string[] = [
    `### ◆ Pinned · REVIEW · ${touched.length} protected behavior${touched.length === 1 ? "" : "s"} touched`,
    "",
    "This PR edits code already guarded by Pinned. CI will block the merge if any guard fails.",
    "",
  ];
  for (const t of touched) {
    const label = describeTouched(t);
    lines.push(`- **${escapeInlineCode(label)}**`);
    for (const route of t.matchedRoutes) {
      for (const f of route.files) {
        lines.push(`  - \`${escapeInlineCode(f)}\` → \`${escapeInlineCode(route.route)}\``);
      }
    }
    for (const f of t.matchedFiles) {
      lines.push(`  - \`${escapeInlineCode(f)}\``);
    }
  }
  return lines.join("\n");
}

function describeTouched(t: TouchedPin): string {
  const tpl = t.pin.claim.template;
  const route = claimRoute(t.pin.claim);
  if (route) return `${tpl} on ${route}`;
  if (t.pin.claim.template === "library-returns") {
    return `${tpl} — ${t.pin.claim.functionName} in ${t.pin.claim.modulePath}`;
  }
  return tpl;
}

export function renderSuggestionsHuman(suggestions: Suggestion[], coverage: Coverage[] = []): string {
  const lines: string[] = [];

  if (coverage.length > 0) {
    lines.push(`✓ ${coverage.length} file(s) guarded by existing pins:`);
    for (const c of coverage) {
      const pinList = c.pins
        .map((p) => `${p.claim.template} on ${claimRoute(p.claim) ?? "(no route)"}`)
        .join(", ");
      lines.push(`  • ${c.file} — ${pinList}`);
    }
    lines.push("");
  }

  if (suggestions.length === 0) {
    lines.push("✓ Every code path Pinned can detect is already protected.");
    return lines.join("\n");
  }

  lines.push(
    `⚠ ${suggestions.length} code path${suggestions.length === 1 ? "" : "s"} without protection:`,
    ""
  );
  for (const s of suggestions) {
    lines.push(`  • ${s.reason}`);
    for (const f of s.files) lines.push(`      ${f}`);
    lines.push(`    Suggested pin: "${s.suggestedPin}"`);
    lines.push("");
  }
  lines.push(
    'Add one of the suggested lines to your PR description, or comment `@pinned add: <claim>` to pin it directly from this PR.'
  );
  return lines.join("\n");
}

export function renderSuggestionsMarkdown(suggestions: Suggestion[], coverage: Coverage[] = []): string {
  const lines: string[] = [];

  // Pin coverage section — what's ALREADY protected
  if (coverage.length > 0) {
    lines.push(
      `### ✅ Pinned coverage on this PR`,
      "",
      `${coverage.length} changed file(s) are guarded by existing pins:`,
      ""
    );
    for (const c of coverage) {
      lines.push(`- \`${escapeInlineCode(c.file)}\``);
      for (const p of c.pins) {
        const route = escapeInlineCode(claimRoute(p.claim) ?? "(no route)");
        const prId = escapeMarkdownCell(p.prId);
        const actor = p.pinnedBy && /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(p.pinnedBy)
          ? `@${p.pinnedBy}`
          : "—";
        lines.push(
          `  - \`${p.claim.template}\` on \`${route}\` (pinned in [${prId}](#) by ${actor})`
        );
      }
    }
    lines.push("");
  }

  // Unpinned risk surfaces
  if (suggestions.length > 0) {
    lines.push(
      `### ⚠ ${suggestions.length} code path${suggestions.length === 1 ? "" : "s"} without protection`,
      "",
      "This PR touches code that's commonly the source of AI-coded regressions. Pin one of these so a permanent test guards against future breakage:",
      ""
    );
    for (const s of suggestions) {
      lines.push(`- **${escapeInlineCode(s.reason)}**`);
      for (const f of s.files) lines.push(`  - \`${escapeInlineCode(f)}\``);
      lines.push(`  - Add to PR description: \`${escapeInlineCode(s.suggestedPin)}\``);
      lines.push("");
    }
  } else if (coverage.length > 0) {
    lines.push("✅ Every code path Pinned can detect is already protected.");
    lines.push("");
  } else {
    return "✅ Every code path Pinned can detect is already protected.";
  }

  // PR Checklist — sticky next-actions
  lines.push("---");
  lines.push("**Suggested next actions:**");
  lines.push("- Comment `@pinned add: <claim sentence>` to pin a claim directly");
  if (suggestions.length > 0) {
    lines.push(`- Or paste one of the suggested claims above into your PR description`);
  }
  lines.push("- Or merge as-is and accept the un-pinned regression risk");
  lines.push("");
  lines.push("*[How does this work?](https://pinnedai.dev)*");

  return lines.join("\n");
}

// ────────────────────────────────────────────────────────────
// Host-conditional detector (0.2.7+)
// ────────────────────────────────────────────────────────────
//
// Flags route handlers that read the request `Host` / `X-Forwarded-Host`
// / `Referer` header and gate behavior on its value. This is the classic
// "works in prod, broken in preview" failure pattern:
//
//   const host = req.headers.get("host");
//   if (host === "myapp.com") { /* real path */ }
//   else { /* fallback/no-op path */ }
//
// Pinned-relevant because:
//   1. Pinned probes against PREVIEW_URL — host is NOT prod, so the
//      handler takes the no-op branch and any pin asserting the
//      side-effect fires falsely.
//   2. Pinned can't tell from a single test whether the handler is
//      degraded (host gate) or actually broken — same observable.
//   3. AI agents frequently introduce host gates "for safety" without
//      announcing them in the PR description — silent prod-vs-preview
//      divergence.
//
// What this detector does:
//   - Pattern-matches host-reading expressions in added lines
//   - Within the same diff, looks for the gating branch shape
//     (if/switch/ternary on the captured value)
//   - Returns a hit per (filePath, route) so the customer is warned
//     to either (a) test against a real host, or (b) add a Pinned
//     override header that bypasses the host gate
//
// v0.2.7 scope: SCAN-DIFF SUGGESTION ONLY. No auto-protect pin emission
// yet (the pin shape is "expects prod-like behavior on preview" — needs
// the AI to add the wrapper that bypasses the gate, same pattern as
// the X-Pinned-Side-Effect wrapper). Pin emission lands in v0.3.

export type DiffHostConditionalHit = {
  template: "host-conditional";
  filePath: string;
  route: string | null;
  hostExpression: string;
  evidence: string;
  // 0.2.12+: name of the exported function in the same file that
  // CONTAINS the host-read. Used by the family-sweep to scope
  // "consumers of this export" → propose family guards for routes
  // that import this specific function (not unrelated exports from
  // the same module). Null when the file isn't a module or the
  // detector couldn't pair the read with an export.
  affectedExport?: string;
};

// Match expressions that read a host-like REQUEST header. Each pattern
// is intentionally tight — only fires on patterns that read a request
// object's host header, NOT on:
//   - URL parsing (`new URL(x).hostname`, `u.hostname`, `parsed.hostname`)
//   - Client-side env detection (`window.location.hostname`)
//   - String interpolation / logging
//
// FP-checked across 1200+ files in 10 dyad-apps repos before tightening
// (initial version produced 5 false positives — all client-side env or
// SSRF URL parsing, not request-host gating).
//
// Each pattern captures the LHS variable name (group 1) so the gating
// check downstream knows which identifier to look for in conditionals.
const HOST_READ_PATTERNS: Array<{ re: RegExp; label: string }> = [
  // Next.js app router: `const x = headers().get("host")` (the
  // `headers()` call returns a ReadonlyHeaders bound to the active
  // request — only meaningful inside route handlers, never URL parsing).
  {
    re: /(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*headers\s*\(\s*\)\s*\.\s*get\s*\(\s*['"](?:host|x-forwarded-host|referer)['"]/i,
    label: "headers().get('host') (Next.js app router)",
  },
  // Web Request API: `const x = req.headers.get("host")`. Allow common
  // request-variable names (req, request, ctx.req, c.req); reject any
  // other LHS (e.g. `parsed.headers.get` from a parsed URL response —
  // which doesn't expose `.get("host")` but we stay defensive).
  {
    re: /(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:req|request|ctx\.req|c\.req)\s*\.\s*headers\s*\.\s*get\s*\(\s*['"](?:host|x-forwarded-host|referer)['"]/i,
    label: "<req>.headers.get('host') (Web Request)",
  },
  // Node-style: `const x = req.headers.host` / `req.headers["x-forwarded-host"]`
  // Again restricted to request-shaped variables only.
  {
    re: /(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:req|request|ctx\.req|c\.req)\s*\.\s*headers\s*(?:\.\s*host\b|\[\s*['"](?:host|x-forwarded-host|referer)['"])/i,
    label: "req.headers.host / req.headers['x-forwarded-host']",
  },
  // Hono: `const x = c.req.header("host")`
  {
    re: /(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*c\s*\.\s*req\s*\.\s*header\s*\(\s*['"](?:host|x-forwarded-host|referer)['"]/i,
    label: ".header('host') (Hono)",
  },
  // Express: `const x = req.hostname` (only `req.` prefix, not arbitrary
  // `u.hostname` / `parsed.hostname` / `window.location.hostname`).
  {
    re: /(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:req|request)\s*\.\s*hostname\b/,
    label: "req.hostname (Express)",
  },
];

// Lines we explicitly REJECT even if they match a host-read pattern:
// client-side context (window.location), URL-parsing (new URL(...).hostname).
const REJECT_LINE_PATTERNS: RegExp[] = [
  /\bwindow\s*\.\s*location\b/,
  /\bnew\s+URL\s*\(/,
  /\.\s*hostname\s*$/, // bare `something.hostname` (URL parsing) — kept only when LHS is `req`/`request`
];

// Lines we explicitly REJECT for the "gating" fallback: an `if` that
// references `hostname` of a URL-parsed value (NOT a request) is not a
// request-host gate. e.g. `if (url.hostname !== "trusted.com")` is
// SSRF / vendor-allowlist code, not divergence-relevant.
const URL_PARSING_GATE_HINTS = /\b(?:URL|url|u|parsed|parsedUrl|resolved|target|origin)\s*\.\s*hostname\b/;

export function detectHostConditionalInDiff(diffByFile: DiffByFile): DiffHostConditionalHit[] {
  const out: DiffHostConditionalHit[] = [];
  const seenKeys = new Set<string>();
  for (const [filePath, addedLines] of diffByFile.entries()) {
    if (isTestPath(filePath)) continue;
    const added = addedLines
      .map((l) => l.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, ""))
      .join("\n");
    if (added.length === 0) continue;

    // Skip client-only files entirely (page components, hooks, UI).
    // Heuristic: extension `.tsx` + no `route.ts` / `route.tsx` /
    // `api/` / `routes/` / `server/` / `controllers/` in the path
    // means client-side — out of scope for request-host detection.
    const isClientFile = filePath.endsWith(".tsx")
      && !/\/route\.tsx?$/.test(filePath)
      && !/\/(?:api|routes|server|controllers|handlers)\//.test(filePath);
    if (isClientFile) continue;

    // Pass 1: find host-read pattern + capture LHS variable name.
    type Match = { line: string; lhsVar: string; label: string };
    let matched: Match | null = null;
    for (const { re, label } of HOST_READ_PATTERNS) {
      for (const line of addedLines) {
        if (REJECT_LINE_PATTERNS.some((rx) => rx.test(line))) continue;
        const m = re.exec(line);
        if (m) {
          matched = { line: line.trim(), lhsVar: m[1], label };
          break;
        }
      }
      if (matched) break;
    }
    if (!matched) continue;

    // Pass 2: gating check. Must find `if (<lhsVar> ...)` / `switch (<lhsVar>)` /
    // ternary referencing the captured LHS variable. We do NOT fall back
    // to any "host" mention in conditionals — that's where the URL-parsing
    // false-positives came from.
    const varName = matched.lhsVar.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const ifVar = new RegExp(`\\b(?:if|switch)\\s*\\([^)]{0,300}\\b${varName}\\b`);
    const ternaryVar = new RegExp(`\\b${varName}\\b[^;]{0,80}\\?\\s*[^:]{0,150}:`);
    const hasGating = ifVar.test(added) || ternaryVar.test(added);
    if (!hasGating) continue;

    // Reject if the gating is on a URL-parsing variable instead of the
    // request-host LHS. Conservative: skip the file when both shapes are
    // present and we can't be sure which one the gate references.
    if (URL_PARSING_GATE_HINTS.test(added) && !ifVar.test(added)) continue;

    const route = deriveRouteFromPath(filePath);
    const key = `${filePath}|${route ?? ""}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    // 0.2.12+: identify which exported function in this file actually
    // contains the host-read. Scan backwards from the matched line to
    // the nearest `export function NAME` or `export const NAME = `
    // declaration. The family-sweep uses this so it only proposes
    // guards for routes that import THIS function (not unrelated
    // exports from the same module like getOrigin which doesn't gate).
    let affectedExport: string | undefined;
    const matchedLineIdx = addedLines.findIndex((l) => l.includes(matched.line.slice(0, 60)));
    if (matchedLineIdx >= 0) {
      for (let i = matchedLineIdx; i >= 0; i--) {
        const line = addedLines[i];
        const fn = /^\s*export\s+(?:async\s+)?(?:function|const|let|var)\s+([a-zA-Z_$][\w$]*)/.exec(line);
        if (fn) {
          affectedExport = fn[1];
          break;
        }
      }
    }

    out.push({
      template: "host-conditional",
      filePath,
      route,
      hostExpression: matched.line.slice(0, 200),
      ...(affectedExport ? { affectedExport } : {}),
      evidence: `Handler reads host/referer (${matched.label}) + gates behavior on \`${matched.lhsVar}\`. Pinned probes against PREVIEW_URL (not prod), so the gate likely fires and the handler takes its fallback branch — any pin asserting the side-effect will false-fail.`,
    });
  }
  return out;
}

// ────────────────────────────────────────────────────────────
// Import/usage graph for pattern-driven family sweep (0.2.12+)
// ────────────────────────────────────────────────────────────
//
// Per [[pattern-driven-family-sweep]]: when a detector fires on a
// "root" file (e.g. lib/host.ts contains a host-conditional read), the
// REAL blast radius is every route handler that IMPORTS the affected
// function from that root. The family-resolver needs an import graph
// to enumerate consumers.
//
// We build a single graph keyed on a NORMALIZED module specifier so
// path aliases (`@/lib/host`), relative paths (`../../lib/host`), and
// bare paths (`lib/host`) all match the same root file. The
// normalization rule: strip leading prefixes (`@/`, `./`, `../`), strip
// any extension, return the last two path segments. So `@/lib/host`,
// `../../src/lib/host.ts`, `lib/host.ts` all normalize to `lib/host`.
//
// File path normalization (for the detector's filePath) uses the same
// rule on the relative path → so a hit on `lib/host.ts` produces key
// `lib/host`, matching every importer's normalized spec.

export type ImportSite = {
  // Repo-relative path of the file doing the import.
  importer: string;
  // Name as it's bound locally (after `as` rename if any).
  localName: string;
  // Original exported name from the source module.
  exportedName: string;
  // The raw import specifier as it appeared in the source.
  rawSpec: string;
};

// Map<normalized-module-key, ImportSite[]>. Multiple files importing
// the same module aggregate into one array.
export type ImportGraph = Map<string, ImportSite[]>;

function normalizeModuleSpec(spec: string): string {
  // Strip leading prefixes.
  let s = spec.trim().replace(/^@\//, "").replace(/^\.\.?\//, "");
  // Walk up any remaining ../
  while (s.startsWith("../")) s = s.slice(3);
  while (s.startsWith("./")) s = s.slice(2);
  // Strip extension.
  s = s.replace(/\.(?:ts|tsx|js|jsx|mjs|cjs)$/, "");
  // Strip leading "src/" since alias usage often elides it.
  s = s.replace(/^src\//, "");
  return s;
}

function normalizeFilePathToModuleKey(filePath: string): string {
  return normalizeModuleSpec(filePath);
}

export function buildImportGraph(filesByPath: Map<string, string>): ImportGraph {
  const graph: ImportGraph = new Map();
  // Two import patterns we care about:
  //   1. Named: `import { a, b as c } from "<spec>"`
  //   2. Default: `import X from "<spec>"`
  // We skip type-only imports (they don't reflect runtime usage) +
  // namespace imports (`import * as X`) — both can extend later.
  const NAMED_IMPORT_RE = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+["']([^"']+)["']/g;
  const DEFAULT_IMPORT_RE = /import\s+([a-zA-Z_$][\w$]*)\s+from\s+["']([^"']+)["']/g;

  for (const [filePath, content] of filesByPath.entries()) {
    if (isTestPath(filePath)) continue;
    // Strip comments to avoid `// import { foo } from "bar"` false matches.
    const stripped = content
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");

    // Named imports.
    for (const m of stripped.matchAll(NAMED_IMPORT_RE)) {
      // Skip type-only — the keyword is captured by the `(?:type\s+)?`
      // group but we re-check the original substring since some
      // toolchains write `import {type Foo}` inline. Conservative.
      if (/\btype\s+/.test(m[0])) {
        // If the WHOLE import is type-only, skip; but `import { type A, B }`
        // (mixed) keeps the non-type ones. For now we drop the whole match —
        // the worst case is missing some legitimate value imports, which is
        // acceptable for FP precision.
        continue;
      }
      const rawSpec = m[2];
      const key = normalizeModuleSpec(rawSpec);
      const list = graph.get(key) ?? [];
      for (const rawName of m[1].split(",")) {
        const piece = rawName.trim();
        if (!piece) continue;
        // `foo as bar` syntax.
        const asMatch = /^([a-zA-Z_$][\w$]*)\s+as\s+([a-zA-Z_$][\w$]*)$/.exec(piece);
        const exportedName = asMatch ? asMatch[1] : piece;
        const localName = asMatch ? asMatch[2] : piece;
        // Skip "type X" prefixes inside the braces.
        if (/^type\s+/.test(exportedName)) continue;
        list.push({ importer: filePath, localName, exportedName, rawSpec });
      }
      graph.set(key, list);
    }

    // Default imports (less common for utility modules, but handle them).
    for (const m of stripped.matchAll(DEFAULT_IMPORT_RE)) {
      if (/\btype\s+/.test(m[0])) continue;
      const localName = m[1];
      const rawSpec = m[2];
      const key = normalizeModuleSpec(rawSpec);
      const list = graph.get(key) ?? [];
      list.push({ importer: filePath, localName, exportedName: "default", rawSpec });
      graph.set(key, list);
    }
  }

  return graph;
}

// Given a root file (where a pattern detector fired) and an export
// name from that file (the function/identifier responsible for the
// flagged behavior), return all importing files. Caller can then
// cross-reference with deriveRouteFromPath to find route handlers.
export function findFamilyMembers(
  rootFile: string,
  exportedName: string,
  graph: ImportGraph
): ImportSite[] {
  const key = normalizeFilePathToModuleKey(rootFile);
  const importers = graph.get(key) ?? [];
  return importers.filter((s) => s.exportedName === exportedName);
}

// Convenience: find all importers of ANY export from a root file.
// Used when a detector fires on the file as a whole (host-conditional)
// rather than on a specific exported function — we then enumerate
// every route that touches that file at all.
export function findAllImportersOfFile(
  rootFile: string,
  graph: ImportGraph
): ImportSite[] {
  const key = normalizeFilePathToModuleKey(rootFile);
  return graph.get(key) ?? [];
}

// Extract names exported from a TypeScript/JavaScript file. Used to
// pair detector matches against specific exports (e.g. host-conditional
// fires on a file → which exported function actually does the
// host-reading? → use the function's name as the family key).
//
// Conservative: matches the most common export shapes
// (named function/const/let/var exports, export-from re-exports).
// Misses: `module.exports = { ... }` CommonJS, dynamic exports,
// computed names. Both are rare in modern TS/Next.js code.
export function extractExportedNames(content: string): string[] {
  const stripped = content
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const out = new Set<string>();
  // `export function name(...)` / `export async function name(...)` /
  // `export const name = ...` / `export let name = ...` / `export class name`
  const named = /export\s+(?:async\s+)?(?:function|const|let|var|class|type|interface)\s+([a-zA-Z_$][\w$]*)/g;
  for (const m of stripped.matchAll(named)) out.add(m[1]);
  // `export { a, b as c }` re-exports + direct named re-exports.
  const reexport = /export\s+\{([^}]+)\}/g;
  for (const m of stripped.matchAll(reexport)) {
    for (const piece of m[1].split(",")) {
      const trimmed = piece.trim();
      if (!trimmed) continue;
      const asMatch = /\s+as\s+([a-zA-Z_$][\w$]*)$/.exec(trimmed);
      const name = asMatch ? asMatch[1] : trimmed.replace(/^type\s+/, "");
      if (/^[a-zA-Z_$][\w$]*$/.test(name)) out.add(name);
    }
  }
  // `export default function name` / `export default <expr>` — these are
  // hard to name without parsing; skip for now.
  return Array.from(out);
}

// ────────────────────────────────────────────────────────────
// Interaction-baseline detector (0.2.17+ BETA)
// ────────────────────────────────────────────────────────────
//
// Per locked [[full-stack-roadmap-2026-06-03]] BETA section: scan
// pages for interactive elements with handlers → propose interaction
// pins. Conservative — only flag buttons with stable selectors
// (aria-label, data-testid). Plain `<button onClick={...}>` without
// an identity attribute is too brittle to pin (the selector would
// rely on positional CSS that breaks under any refactor).
//
// Catches the socialideagen carousel arrow handler regression: the
// Carousel.tsx renders `<button aria-label={dir < 0 ? "Previous" :
// "Next"} onClick={...}>` — detector emits two candidates (Previous
// + Next), each proposing click + scroll-position observation.

export type InteractionCandidate = {
  template: "interaction-baseline";
  page: string;                                // route the element lives on
  selector: string;                            // CSS selector (aria-label / data-testid)
  ariaLabel: string;                           // the captured label (used for shape heuristics)
  action: "click";                             // 0.2.17 ships click only; scroll/type follow
  suggestedObserve: "scroll-position" | "dom-text" | "url" | "element-count";
  filePath: string;
  reason: string;
};

// Heuristic: map aria-label to a sensible default observation.
// "Next" / "Previous" / "Forward" / "Back" → scroll-position
//   (carousel-shaped behavior — the click scrolls a track).
// "Open" / "Toggle" / "Show" / "Expand" → element-count
//   (menu/modal opens — a new dialog/menu enters the DOM).
// "Submit" / "Save" / "Continue" / "Sign in" → url
//   (form submission usually changes the URL).
// Everything else → dom-text (default; user can tweak in the pin file).
function inferObserveFromAriaLabel(label: string): "scroll-position" | "dom-text" | "url" | "element-count" {
  const l = label.toLowerCase();
  if (/\b(next|previous|prev|forward|back|left|right|scroll)\b/.test(l)) return "scroll-position";
  if (/\b(open|toggle|show|expand|menu|modal|dialog)\b/.test(l)) return "element-count";
  if (/\b(submit|save|continue|sign\s*in|sign\s*up|log\s*in|register|send)\b/.test(l)) return "url";
  return "dom-text";
}

export function detectInteractionCandidates(filesByPath: Map<string, string>): InteractionCandidate[] {
  const out: InteractionCandidate[] = [];
  const seen = new Set<string>();

  // Match `<button ... aria-label="X" ... onClick={...}>` (any order
  // of attrs). Also match data-testid variant. We use a two-step
  // match: locate `<button` tag bodies (up to closing `>`), then
  // pull aria-label / data-testid + confirm onClick presence.
  //
  // Conservative — only matches button elements. role=button divs
  // are common in design systems but harder to bind to a stable
  // selector + frequently aren't real handlers (CSS-only hover
  // affordances). We can extend later.
  const BUTTON_TAG = /<button\b[^>]{0,500}?>/g;
  const ARIA_LABEL = /aria-label\s*=\s*(?:["']([^"']{2,60})["']|\{(?:["'`]([^"'`]{2,60})["'`])\})/;
  const TEST_ID = /data-testid\s*=\s*["']([^"']{2,60})["']/;
  const ONCLICK = /onClick\s*=/;

  for (const [filePath, content] of filesByPath.entries()) {
    if (isTestPath(filePath)) continue;
    // Only consider rendered page sources. Skip API routes, libs, etc.
    const pageRoute = derivePageRoute(filePath);
    // ALSO accept components/ since carousels live there (they get
    // rendered by some page). We attribute them to a fallback "/"
    // route in that case — users can edit if they know better.
    // Match both `components/X.tsx` (relative-ish path) and
    // `<anything>/components/X.tsx`.
    const isComponent = !pageRoute && /(?:^|\/)components\//.test(filePath) && /\.(tsx|jsx)$/.test(filePath);
    if (!pageRoute && !isComponent) continue;
    const route = pageRoute ?? "/";

    // Strip comments so a commented `aria-label="Old"` doesn't fire.
    const stripped = content
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

    for (const m of stripped.matchAll(BUTTON_TAG)) {
      const tag = m[0];
      if (!ONCLICK.test(tag)) continue; // no handler — not interactive
      const aria = ARIA_LABEL.exec(tag);
      const testid = TEST_ID.exec(tag);
      const label = aria ? (aria[1] ?? aria[2]) : null;
      const tid = testid ? testid[1] : null;

      // Need at least one stable selector attribute.
      if (!label && !tid) continue;

      // Build the selector. Prefer data-testid (most stable). Fall
      // back to aria-label.
      const selector = tid
        ? `[data-testid="${tid}"]`
        : `[aria-label="${label}"]`;

      // Skip when aria-label is a JSX expression we can't statically
      // resolve. Carousel.tsx uses `aria-label={dir < 0 ? "Previous"
      // : "Next"}` — we pulled BOTH literals via the alternation in
      // ARIA_LABEL, so the selector ends up as one of them. That's
      // fine — we'll emit one candidate per matched literal.
      // (TODO 0.2.18: ALSO emit the second literal from a ternary.)

      const ariaLabel = label ?? tid ?? "";
      const dedupKey = `${filePath}|${selector}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      const suggestedObserve = inferObserveFromAriaLabel(ariaLabel);
      out.push({
        template: "interaction-baseline",
        page: route,
        selector,
        ariaLabel,
        action: "click",
        suggestedObserve,
        filePath,
        reason: tid
          ? `<button data-testid="${tid}" onClick=...> — stable test-id selector`
          : `<button aria-label="${label}" onClick=...> — heuristic observe: ${suggestedObserve}`,
      });
    }

    // Also: emit a second candidate for ternary aria-labels — carousel
    // pattern `aria-label={dir < 0 ? "Previous" : "Next"}`. Match the
    // shape independently from the BUTTON_TAG iter so we get both.
    const TERNARY_LABEL = /aria-label\s*=\s*\{\s*[^?}]+\?\s*["']([^"']{2,60})["']\s*:\s*["']([^"']{2,60})["']\s*\}/g;
    for (const m of stripped.matchAll(TERNARY_LABEL)) {
      const labelA = m[1];
      const labelB = m[2];
      // The matched text is INSIDE a button tag if BUTTON_TAG above
      // would have caught it. We just need to verify the surrounding
      // 200 chars actually contain `<button` + `onClick`.
      const matchIdx = stripped.indexOf(m[0]);
      const surround = stripped.slice(Math.max(0, matchIdx - 200), matchIdx + 400);
      if (!/<button\b/.test(surround)) continue;
      if (!ONCLICK.test(surround)) continue;
      for (const lbl of [labelA, labelB]) {
        const selector = `[aria-label="${lbl}"]`;
        const dedupKey = `${filePath}|${selector}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);
        const observe = inferObserveFromAriaLabel(lbl);
        out.push({
          template: "interaction-baseline",
          page: route,
          selector,
          ariaLabel: lbl,
          action: "click",
          suggestedObserve: observe,
          filePath,
          reason: `<button aria-label={... ? "${labelA}" : "${labelB}"} onClick=...> ternary — emitting ${lbl}`,
        });
      }
    }
  }

  return out;
}
