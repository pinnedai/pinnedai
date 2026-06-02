// Claim parser — turns free-form PR description text into structured
// `Claim` records that downstream template generators can consume.
//
// Pillar 1 of the architecture: the LLM never writes test logic. It
// only fills slots in deterministic templates. So this parser's job is
// to extract those slots (route, rate, window, …) — nothing more.
//
// Strategy: regex first (cheap, deterministic, no API cost). If the
// regex pass returns zero claims for a body that looks claim-shaped
// the caller can opt into an LLM fallback that's constrained to emit
// the same `Claim` shape. The fallback is wired to the hosted OIDC
// endpoint (see `[[oidc-hosted-endpoint-mvp]]` memory).

export type RateLimitClaim = {
  template: "rate-limit";
  route: string;
  rate: number;
  window: "second" | "minute" | "hour";
  raw: string;
  // Same shape as auth-required's. When present, the generated test
  // does a static-mode check that the rate-limit signature observed
  // in the diff is still present in source. Lets the bug-fix
  // benchmark replay catch "AI removed the rate limiter" without a
  // live server.
  staticVerify?: {
    filePath: string;
    signature: string;
  };
};

export type AuthRequiredClaim = {
  template: "auth-required";
  route: string;
  raw: string;
  // Optional static-mode fingerprint. When present, the generated
  // test can verify the pin WITHOUT a live server: it reads the
  // source file at `filePath` and asserts the auth signature is
  // still present. Catches the "AI deleted the auth check" class —
  // the failure mode that bug-fix benchmarks need to detect when
  // no PREVIEW_URL is available.
  //
  // Lateral-propagation friendly: the same signature set used to
  // detect the addition is the one we re-check for at run time, so
  // a future "find similar routes without this signature" detector
  // can reuse it.
  staticVerify?: {
    filePath: string;
    // A short regex (as a string, anchored to a single line) that
    // must match somewhere in the file. Generated at pin time from
    // the actual auth-check pattern observed in the diff — so the
    // pin protects whatever auth shape the fix introduced (Clerk,
    // Supabase, Bearer header, custom middleware, etc.).
    signature: string;
  };
};

export type IdempotentClaim = {
  template: "idempotent";
  route: string;
  idField: string;
  raw: string;
  // Static-mode fingerprint — same shape as auth-required's. When
  // present, the generated test reads the source file and asserts
  // the captured idempotency-check signature is still there.
  staticVerify?: {
    filePath: string;
    signature: string;
  };
};

// CLI claim: "`pinned doctor` outputs `tests/pinned/ directory`."
// Generated test spawns the CLI binary, captures stdout, asserts the
// expected substring is present. Lets pinnedai pin claims about its
// own (and other) command-line tools — `route` is overloaded to mean
// "the command being claimed about" so the existing registry / PINS.md
// renderer can keep using one shape across templates.
export type CliOutputContainsClaim = {
  template: "cli-output-contains";
  // The CLI invocation. By convention rendered as `route` for
  // registry uniformity; semantically it's a full argv string.
  route: string;
  // Substring that must appear in stdout.
  text: string;
  raw: string;
};

// CLI claim: "`pinned init` exits 0 on a healthy repo."
// Generated test spawns the command, asserts exit code 0.
export type CliExitsZeroClaim = {
  template: "cli-exits-zero";
  route: string; // CLI invocation
  raw: string;
};

// CLI claim: "`pinned init` creates `tests/pinned/.registry.json`."
// Generated test runs the command in a tempdir, asserts the file exists.
export type CliCreatesFileClaim = {
  template: "cli-creates-file";
  route: string; // CLI invocation
  filePath: string; // expected file path relative to cwd after running
  raw: string;
};

// CLI claim: "`pinned status --json` returns JSON with `activePins`, `verifiedStreak`."
// Generated test spawns the command, parses stdout as JSON, asserts the
// listed keys exist on the parsed object. Stronger contract than
// cli-output-contains: catches JSON validity AND schema drift in one
// shot. Highest-leverage CLI pin for any binary that ships a --json
// flag for machine-consumed output (Pinned itself, gh CLI, etc.).
//
// Why "shape" and not "exact match": the value of any one key may
// legitimately change between runs (counts, timestamps, IDs), but the
// SHAPE — which keys are present — is part of the public contract.
export type CliJsonShapeClaim = {
  template: "cli-json-shape";
  route: string; // CLI invocation (must include --json or equivalent)
  keys: string[]; // required top-level keys on the parsed JSON object
  raw: string;
};

// CLI claim: "`pinned check` supports `--json` flag."
// Generated test runs `<cmd> --help` and asserts the flag appears in
// stdout. Cheap contract verification — the flag is documented and
// therefore part of the CLI's public surface.
export type CliFlagSupportedClaim = {
  template: "cli-flag-supported";
  route: string; // CLI invocation (the help text we'll grep)
  flag: string; // the flag that must be documented
  raw: string;
};

// Secret-not-public claim. Asserts that NO environment variable
// matching "NEXT_PUBLIC_*<SECRET-WORD>*" exists in the codebase.
// Catches the highest-impact AI mistake category: naming a public-by-
// design env var with a secret-sounding suffix like
// NEXT_PUBLIC_STRIPE_SECRET_KEY (which Next.js inlines into the
// client bundle, leaking the key).
//
// Single-purpose, no parameters. Single pin per repo. The test scans
// .env*, source files, and package configs for any string matching
// /NEXT_PUBLIC_.*?(SECRET|TOKEN|PRIVATE_KEY|PRIVATE|API_KEY)/.
// Auto-emitted at baseline-on-init when ANY .env* file exists OR
// when the repo has Next.js as a dependency (since the leak only
// happens in NEXT_PUBLIC_-style frameworks).
export type SecretNotPublicClaim = {
  template: "secret-not-public";
  // Framework prefix the rule guards. Currently "NEXT_PUBLIC_" but
  // future variants (VITE_*, REACT_APP_*, PUBLIC_*) can use the same
  // template with a different prefix.
  publicPrefix: string;
  // Substrings that mark an env var as secret-shaped. Default:
  // SECRET, TOKEN, PRIVATE_KEY, PRIVATE, API_KEY. Customizable.
  secretMarkers: string[];
  raw: string;
};

// Package-exports-exist claim. Asserts that the package's main /
// exports entry continues to export named symbols. Catches AI agents
// that rename, delete, or relocate exported library functions —
// breaking change for downstream consumers, hard to spot in a diff.
//
// Implementation: the generated test `await import()`s the package
// (or the modulePath if specified) and asserts that each named export
// is present and is a function / object / value (i.e., `typeof export
// !== "undefined"`). It does NOT call the function or assert return
// values — that's what library-returns is for.
//
// Auto-pinnable at baseline-on-init: walks package.json's `main` /
// `exports` / `module` entries, imports them, captures the named
// exports at install time, emits one pin per group.
export type PackageExportsClaim = {
  template: "package-exports-exist";
  // Repo-relative path to the module file (e.g. "src/index.ts").
  // Test will dynamic-import this path; must resolve from cwd.
  modulePath: string;
  // Named exports that must be present. Each one becomes an
  // assertion: typeof mod[name] !== "undefined".
  exports: string[];
  raw: string;
};

// Config-invariant claim. Asserts that a target file CONTAINS a
// specific substring or matches a literal text rule. Single-purpose
// template for catching AI-driven config drift — "AI cleaned up
// CLAUDE.md and removed the Pinned guardrail block", "AI tidied
// .github/workflows/pinned.yml and dropped id-token: write", "AI
// rewrote .env.example and forgot to include STRIPE_SECRET_KEY".
//
// File contents must contain `expected` (substring match, anchor-free).
// Both AUTO-detected by baseline (well-known invariants) and
// user-pinnable via natural English (PR claim parser).
export type ConfigInvariantClaim = {
  template: "config-invariant";
  // Repo-relative path to the file under contract.
  configPath: string;
  // Required substring that must appear in the file's text.
  expected: string;
  // Human-readable label for what's being protected. E.g.,
  // "GitHub Actions OIDC permission", "Pinned guardrail block".
  // Used in PINS.md + failure messages so the reader knows WHY.
  label: string;
  raw: string;
};

// Pin strength classification — used by `pinned list` + PINS.md to
// group pins by what they actually catch. Avoids the misleading "all
// pins are equal" framing GPT flagged.
//
//   "behavioral":  the pin runs against live behavior — actual HTTP
//                  requests, command-line execution, library calls.
//                  Catches real regressions when the protected
//                  behavior changes.
//   "guardrail":   the pin checks file/config invariants. Catches
//                  AI agents that "tidy up" load-bearing config or
//                  silently change dependencies. Useful but less
//                  dramatic than a behavioral pin.
//   "unverified":  the pin is saved but can't run yet — typically an
//                  HTTP pin without PREVIEW_URL / local dev mode set.
//                  Surfaced so users don't mistake skipped pins for
//                  verified protection.
//
// Static — computed from claim template + runtime context (whether
// PREVIEW_URL is set / local-dev mode is configured). Defined here
// instead of in registry.ts so the landing demo can use it too.
export type PinStrength = "behavioral" | "guardrail" | "unverified";

export function classifyPinStrength(
  claim: Claim,
  ctx: { hasPreviewUrl: boolean; httpMode?: "local" | "preview" | "off" }
): PinStrength {
  const httpVerifiable =
    ctx.hasPreviewUrl ||
    ctx.httpMode === "local" ||
    ctx.httpMode === "preview";
  switch (claim.template) {
    case "rate-limit":
    case "auth-required":
    case "permission-required":
    case "tier-cap":
    case "idempotent":
    case "returns-status":
      // HTTP templates — strong if a URL is configured, unverified otherwise.
      return httpVerifiable ? "behavioral" : "unverified";
    case "cli-output-contains":
    case "cli-exits-zero":
    case "cli-creates-file":
    case "cli-json-shape":
    case "cli-flag-supported":
    case "library-returns":
      // These run against the customer's filesystem at the current
      // commit. No preview URL needed; always behavioral.
      return "behavioral";
    case "lockfile-integrity":
    case "config-invariant":
    case "package-exports-exist":
    case "secret-not-public":
    case "url-literal-preserved":
    case "module-export-stable":
    case "react-route-registered":
    case "webhook-handler-exists":
    case "import-path-resolves":
    case "changed-literal-preserved":
    case "form-submit-error-handling":
      // Static guardrails — file/config checks. Real-value but not
      // behavioral verification.
      return "guardrail";
    case "tsc-clean":
      // tsc --noEmit is deterministic build verification — strong
      // enough to count as behavioral (catches actual build breaks).
      return "behavioral";
    case "page-renders":
    case "validation-rejects-bad":
    case "happy-path-with-side-effect":
      // v0.2 workhorse templates — all live HTTP. Strong if PREVIEW_URL
      // is configured, unverified otherwise (same model as auth-required).
      return httpVerifiable ? "behavioral" : "unverified";
    case "journey":
      // Multi-step HTTP. Same gating as the single-step HTTP templates.
      return httpVerifiable ? "behavioral" : "unverified";
  }
}

// Lockfile-integrity claim. Detects the *suspicious* class of lockfile
// changes — NOT every lockfile edit. Gating logic at runtime:
//   - lockfile missing                          → FAIL ("removed / pm switched")
//   - lockfile sha unchanged                    → PASS
//   - lockfile sha changed, package.json sha
//     also changed                              → PASS (legitimate dep update)
//   - lockfile sha changed, package.json sha
//     unchanged                                 → FAIL (silent regen — the bug)
//
// The "silent regen" case is the only one users care about: an AI agent
// ran `npm install` for no declared reason, transitive deps shifted,
// build is now mystery-fragile. Generic dep updates (where the user
// also bumped package.json) are noise and we suppress them.
//
// packageJsonSha256 is optional for backward compat with pins created
// before this gating was added (those behave as the old "hash equality"
// pin — strict but noisy). New baselines always populate it.
//
// Single-purpose template: no PR-claim parsing path. Auto-emitted at
// baseline-on-init when a lockfile is detected on disk.
export type LockfileIntegrityClaim = {
  template: "lockfile-integrity";
  // The lockfile relative path from repo root.
  lockfilePath: string;
  // The pinned sha256 hex digest of the lockfile.
  expectedSha256: string;
  // SHA-256 of package.json at pin time. When present, gating logic
  // suppresses dep-update noise. Optional for pre-v0.1.x compat.
  packageJsonSha256?: string;
  raw: string;
};

// Library/SDK claim: "Adds `parseConfig()` that returns `{version: 1}`."
// Generated test imports the named export from a file, calls it with no
// args (or the specified args), and deep-equals the return.
export type LibraryReturnsClaim = {
  template: "library-returns";
  // Function name (the named export).
  functionName: string;
  // Repo-relative path to the module file (e.g. "src/config.ts").
  modulePath: string;
  // Expected return value, as a JSON-parseable literal.
  expected: unknown;
  raw: string;
};

// Tier-cap claim: "POST /api/projects is capped at 3 for free tier."
// Generated test verifies billing-tier enforcement with up to THREE
// independently-gated directions:
//   - under-cap free user → 2xx                (catches the endpoint being broken)
//   - at-cap free user    → 4xx                (catches the cap being removed — REVENUE LEAK)
//   - paid user           → 2xx (regardless)   (catches over-application of the cap)
// Per-direction skipIf gates each on its own fixture credential env var
// so missing fixtures cause silent skips, never false fails. The
// billing-bypass class is the #1 revenue-leak bug in AI-coded SaaS:
// when AI refactors quota/billing logic, the cap-enforcement step
// silently disappears. Tier-cap pins specifically guard against that.
//
// Customer env vars consumed (each independently optional):
//   PREVIEW_TEST_TOKEN_TIER_<TIER>_UNDER_CAP   — under-cap fixture
//   PREVIEW_TEST_TOKEN_TIER_<TIER>_AT_CAP      — at-cap fixture
//   PREVIEW_TEST_TOKEN_PAID                    — paid bypass fixture
//
// Where <TIER> is the uppercased + snake-cased tier name from the claim.
export type TierCapClaim = {
  template: "tier-cap";
  // The gated action endpoint (e.g., "/api/projects").
  route: string;
  // Tier identifier — normalized to lowercase, slug-friendly
  // (free / hobby / trial / starter / etc.). Used to compose env var
  // names: PREVIEW_TEST_TOKEN_TIER_FREE_AT_CAP.
  tier: string;
  // Numeric limit the tier enforces.
  cap: number;
  // What the cap counts (human display only — does NOT change test
  // mechanism). Examples: "projects", "seats", "domains", "requests".
  resource: string;
  raw: string;
};

// Permission claim: "Only admin can access /api/admin/users."
// Generated test verifies role-based access control with up to THREE
// independently-gated directions:
//   - unauthenticated → 401 or 403 (always runs given PREVIEW_URL)
//   - wrong-role token → 403 (runs if PREVIEW_TEST_TOKEN_NON_ADMIN env present)
//   - right-role token → 2xx (runs if PREVIEW_TEST_TOKEN_<ROLE> env present)
// Per-direction skipIf gates each assertion independently so a missing
// fixture credential doesn't false-fail the others. The #2 AI-regression
// class after plain auth — role checks get stripped or dropped during
// "cleanup" refactors, exposing paid/admin/staff-only routes.
export type PermissionRequiredClaim = {
  template: "permission-required";
  route: string;
  // Normalized to lowercase, slug-friendly identifier (admin / staff /
  // manager / member / etc.). Used to compose the credential env var
  // name (PREVIEW_TEST_TOKEN_ADMIN, PREVIEW_TEST_TOKEN_STAFF).
  role: string;
  raw: string;
  // Static-mode fingerprint — same shape as auth-required's. When
  // present, the generated test reads the source file and asserts
  // the captured authorization-check signature is still there.
  staticVerify?: {
    filePath: string;
    signature: string;
  };
};

// Validation claim: "POST /api/signup returns 400 on missing email."
// Generated test posts an empty (or single-invalid-field) body to the
// route and asserts the response status code. The "condition" text
// (the field name, "empty body", etc.) is preserved in the claim for
// human context but does NOT change the test mechanism — every test
// sends a minimally valid request that's missing/invalid in some way
// and asserts the documented status code.
export type ReturnsStatusClaim = {
  template: "returns-status";
  route: string;
  method: "POST" | "GET" | "PUT" | "PATCH" | "DELETE";
  status: number;
  // The "missing X" / "invalid Y" / "empty body" qualifier. Human-only.
  condition?: string;
  // Optional field name from "missing F" / "invalid F" — drives the
  // body shape: omit-only-F vs send-invalid-F. When absent, body is `{}`.
  field?: string;
  // "missing" | "invalid" | "empty" | undefined
  conditionKind?: "missing" | "invalid" | "empty";
  raw: string;
  // Static-mode fingerprint — same shape as auth-required's. When
  // present, the generated test reads the source file and asserts
  // the captured validation signature is still there. Used by the
  // bug-fix benchmark to verify that a fix's added validation is
  // still in source (not deleted by AI in a later commit). Without
  // this carve-out, returns-status only runs with PREVIEW_URL set.
  staticVerify?: {
    filePath: string;
    signature: string;
  };
};

// ──────────────────────────────────────────────────────────────────────
// Phase 1+2 new templates (2026-05-25) — all static-mode signature
// checks that mirror config-invariant in spirit but carry stronger
// semantic metadata for PINS.md / failure messages / sibling discovery.
// Chosen for cross-repo coverage from the dyad-apps audit; each is
// LOW FP because the signature is verified verbatim against the
// captured-at-fix file content.

// "URL literal `/api/foo` must appear in file X" — catches endpoint
// typos / version drift / accidental URL changes. Phase 1.
export type UrlLiteralPreservedClaim = {
  template: "url-literal-preserved";
  filePath: string;        // repo-relative file where the URL appears
  urlLiteral: string;      // the exact URL string (e.g., "/api/v2/calls")
  label: string;           // short human label, e.g., "Retell agent API"
  raw: string;
};

// "tsc --noEmit returns 0" — catches TS build errors, syntax breaks,
// missing imports. Phase 1.
export type TscCleanClaim = {
  template: "tsc-clean";
  tsconfigPath: string;    // typically "tsconfig.json"
  raw: string;
};

// "module X still exports name Y" — catches "missing export" bugs
// that lint can't see. Phase 1.
export type ModuleExportStableClaim = {
  template: "module-export-stable";
  modulePath: string;      // repo-relative path to the module file
  exportName: string;      // the named export, e.g., "showWarning"
  raw: string;
};

// "<Route path='/foo'>` still wired in router config" — catches
// accidentally-dropped route registrations in SPA router setups
// (react-router, tanstack-router). Phase 2.
export type ReactRouteRegisteredClaim = {
  template: "react-route-registered";
  routerFilePath: string;  // e.g., "src/App.tsx"
  routePath: string;       // e.g., "/dashboard"
  raw: string;
};

// "Webhook handler at file X still defines POST/handler signature" —
// stronger than auth-required for the case where the FILE is the
// load-bearing artifact (e.g., supabase edge functions). Phase 2.
export type WebhookHandlerExistsClaim = {
  template: "webhook-handler-exists";
  filePath: string;
  // Captured handler-shape signature (e.g., "export async function POST(")
  handlerSignature: string;
  // Short label of which provider/event this protects (e.g., "stripe", "retell")
  provider: string;
  raw: string;
};

// "Import path X resolves from file Y" — catches the "fixed a missing
// dep" / "renamed a module" regressions. Phase 2.
export type ImportPathResolvesClaim = {
  template: "import-path-resolves";
  sourceFilePath: string;  // file that contains the import
  importPath: string;      // exact import specifier (e.g., "@/lib/auth")
  raw: string;
};

// "After a fix changed a literal value (URL / status code / env key /
// route path) from oldValue to newValue, the post-fix file keeps the
// newValue." — catches the LARGEST class of dyad-apps fixes per the
// GPT review: URL typos, API version drift, status code corrections,
// env key renames. Distinct from url-literal-preserved because the
// DETECTOR pairs removed+added lines in the same hunk; both old and
// new values are captured. Replay asserts newValue present. Optional
// oldValue-absent check is observe-mode only (FP risk: refactors may
// keep both legitimately).
//
// Shape categories supported by the detector:
//   - url          (e.g., "/api/v2/foo")
//   - host-url     (e.g., "https://api.foo.com/...")
//   - status-code  (e.g., 400, 401, 403, 404, 429, 500)
//   - env-key      (e.g., "NEXT_PUBLIC_FOO" → "VITE_FOO")
//   - route-path   (e.g., "<Route path='/old'>" → "<Route path='/new'>")
export type ChangedLiteralPreservedClaim = {
  template: "changed-literal-preserved";
  filePath: string;
  oldValue: string;
  newValue: string;
  shape: "url" | "host-url" | "status-code" | "env-key" | "route-path";
  raw: string;
};

// "Form onSubmit handler keeps wrapping itself in error handling
// (try/catch or .catch)" — catches AI removing the try/catch /
// .catch() from a form submission handler, which would surface
// unhandled promise rejections in production. Phase 2 UI/flow pack.
export type FormSubmitErrorHandlingClaim = {
  template: "form-submit-error-handling";
  filePath: string;            // file containing the form
  // Captured signature line: the onSubmit handler reference
  // (e.g., "onSubmit={handleSubmit}" or the full inline arrow).
  // Verifier asserts the file still contains this signature.
  signature: string;
  raw: string;
};

// ──────────────────────────────────────────────────────────────────────
// v0.2 workhorse templates (2026-06-02) — three template additions
// chosen to match the Claude-session feedback's explicit asks:
//   * page-renders                  — "GET /path renders without crashing"
//   * validation-rejects-bad        — "POST /api/X with bad input returns 400"
//   * happy-path-with-side-effect   — "POST /api/X returns 200 + writes row Y"
// See docs/v02-workhorse-templates-spec.md for the design + open-question
// decisions (locked 2026-06-02 — Option C / X-Pinned-Side-Effect header).

export type PageRendersClaim = {
  template: "page-renders";
  route: string;
  // Default 500 bytes. Configurable per-pin for legitimate small pages.
  minBodyBytes?: number;
  raw: string;
};

export type ValidationRejectsBadClaim = {
  template: "validation-rejects-bad";
  route: string;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  // Required fields detected from schema (zod/yup/joi) or parser cues.
  // Each gets a "missing required field" sub-test. If empty, falls back
  // to "POST with no body → expect 4xx" + "POST with malformed-JSON".
  requiredFields: string[];
  raw: string;
};

// Body-shape descriptor populated by the validation-schema detector
// when it can read the route's zod schema. Used by happy-path's
// buildValidBody() to ship a body that satisfies the schema instead
// of a placeholder that 4xx's on first run.
// Mirrors `FieldShape` in scanDiff.ts — duplicated here to keep
// claimParser browser-safe (no scanDiff import which pulls node:fs
// via the diff-reader paths).
export type ClaimFieldShape =
  | { kind: "string"; min?: number; format?: "email" | "url" | "uuid" | "date" | "datetime" | "cuid" }
  | { kind: "number"; int?: boolean; min?: number }
  | { kind: "boolean" }
  | { kind: "literal"; value: string | number | boolean }
  | { kind: "enum"; values: string[] }
  | { kind: "array"; items?: ClaimFieldShape }
  | { kind: "unknown" };

export type HappyPathWithSideEffectClaim = {
  template: "happy-path-with-side-effect";
  route: string;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  // v0.2 ships db-write only. Other kinds (queue-enqueue, email-send,
  // storage-write) extend trivially in v0.3+ via the same header
  // convention (X-Pinned-Side-Effect: <kind>).
  sideEffectKind: "db-write";
  // Table/model name the endpoint writes to.
  sideEffectTarget: string;
  // Per-field schema shape from the route's zod/yup/joi validator,
  // captured at pin-generation time. Optional — falls back to
  // placeholder `{ pinnedTest: true }` body when absent.
  bodyShape?: Record<string, ClaimFieldShape>;
  raw: string;
};

// Multi-step user journey. Captures bugs that single-route templates
// can't reach: e.g. signup then /me returns the new email; login then
// dashboard renders without an "expired session" message; checkout
// then order detail page shows the right line items. Cookies from
// each step's response are jar-collected and sent on later steps,
// so session-bearing journeys work without explicit token plumbing.
//
// Per-step assertions: status (range or exact), bodyIncludes,
// bodyForbids, setsCookie, redirectIncludes. Tier-2 misleading-green
// markers (`error` / `skipped:true` / `degraded:true`) are checked
// implicitly via the runtime — no per-step opt-in needed.
//
// Auto-detection from PR descriptions is shallow in v0.2.7 (regex
// for the two most common shapes: "X then /Y returns Z" / "after X,
// /Y renders"). LLM extraction via the SYSTEM_PROMPT covers the long
// tail. Generic auto-protect detection lives in v0.3.
export type JourneyStep = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  route: string;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  followRedirects?: boolean;
  expect: {
    status?: { min: number; max: number } | number;
    bodyIncludes?: string[];
    bodyForbids?: string[];
    setsCookie?: string;
    redirectIncludes?: string;
  };
};

export type JourneyClaim = {
  template: "journey";
  // Human-readable label used in the describe() block.
  label: string;
  steps: JourneyStep[];
  raw: string;
};

export type Claim =
  | RateLimitClaim
  | AuthRequiredClaim
  | PermissionRequiredClaim
  | TierCapClaim
  | IdempotentClaim
  | ReturnsStatusClaim
  | CliOutputContainsClaim
  | CliExitsZeroClaim
  | CliCreatesFileClaim
  | CliJsonShapeClaim
  | CliFlagSupportedClaim
  | LibraryReturnsClaim
  | ConfigInvariantClaim
  | LockfileIntegrityClaim
  | PackageExportsClaim
  | SecretNotPublicClaim
  | UrlLiteralPreservedClaim
  | TscCleanClaim
  | ModuleExportStableClaim
  | ReactRouteRegisteredClaim
  | WebhookHandlerExistsClaim
  | ImportPathResolvesClaim
  | ChangedLiteralPreservedClaim
  | FormSubmitErrorHandlingClaim
  | PageRendersClaim
  | ValidationRejectsBadClaim
  | HappyPathWithSideEffectClaim
  | JourneyClaim;

// A route token: must start with ASCII `/`, must not contain whitespace,
// trailing punctuation, OR dangerous Unicode characters (RTL-override,
// zero-width joiners, bidi controls). Without the Unicode rejection,
// a malicious PR description could embed U+202E (RTL-override) inside
// a route so the visible string differs from the captured value —
// reviewer-fooling. Bidi/format-control ranges excluded:
//   U+0000-U+001F  C0 controls
//   U+007F-U+009F  C1 controls (DEL + C1)
//   U+200B-U+200F  zero-width chars + bidi marks
//   U+202A-U+202E  bidi embedding/override controls (RTL-override is U+202E)
//   U+2066-U+2069  bidi isolates
//   U+FEFF         BOM / ZWNBSP
const ROUTE = String.raw`\/[^\s,.;:!?)\]{}<>'"\x60 --​-‏‪-‮⁦-⁩﻿]+`;

// ---------- rate-limit ----------
// "Rate-limits /api/users to 60 req/min."
// "Rate limit /api/users to 60 requests per minute"
// "Rate-limited /api/x to 100 calls/hour."
const RATE_LIMIT_WORDS = new RegExp(
  String.raw`rate[-\s]?limit(?:s|ed|ing)?\s+(?:on\s+|the\s+)?(?<route>${ROUTE})[,;.]?\s+(?:to\s+)?(?<rate>\d+)\s*(?:req(?:uests?)?|calls?|hits?)\s*(?:\/|per)\s*(?<window>sec(?:ond)?s?|min(?:ute)?s?|hours?|hr)`,
  "gi"
);

// "Rate-limits /api/users to 60 rpm" (rps / rph)
const RATE_LIMIT_UNIT = new RegExp(
  String.raw`rate[-\s]?limit(?:s|ed|ing)?\s+(?:on\s+|the\s+)?(?<route>${ROUTE})[,;.]?\s+(?:to\s+)?(?<rate>\d+)\s*(?<unit>rpm|rps|rph)\b`,
  "gi"
);

function normalizeWordWindow(w: string): "second" | "minute" | "hour" {
  const s = w.toLowerCase();
  if (s.startsWith("sec")) return "second";
  if (s.startsWith("min")) return "minute";
  return "hour";
}

function unitToWindow(u: string): "second" | "minute" | "hour" {
  switch (u.toLowerCase()) {
    case "rps":
      return "second";
    case "rph":
      return "hour";
    default:
      return "minute";
  }
}

// ---------- auth-required ----------
// "Auth required on /api/admin/export."
// "Authentication required for /api/x"
const AUTH_REQUIRED_KW = new RegExp(
  String.raw`auth(?:entication)?\s+(?:is\s+)?required\s+(?:on|for)\s+(?<route>${ROUTE})`,
  "gi"
);

// "/api/users requires auth"
// "/api/y requires authentication"
const AUTH_REQUIRES = new RegExp(
  String.raw`(?<route>${ROUTE})\s+requires?\s+auth(?:entication)?`,
  "gi"
);

// ---------- permission-required ----------
// Role-based access control. Each pin generates a 3-direction test:
//   unauthenticated → 401/403, wrong-role token → 403, right-role
//   token → 2xx. Per-direction skipIf gates each independently so a
//   missing fixture credential doesn't false-fail the others.
//
// Matches (role captured in named group `role`, normalized to
// lowercase at parse time):
//   "/api/admin/export requires admin role"
//   "/api/admin/users requires `admin` role"
//   "/api/admin/users is admin-only"
//   "Only admin can access /api/admin/users"
//   "admin-only on /api/admin/export"
//   "Restricts /api/admin/audit to admin role"
const PERMISSION_REQUIRES_ROLE = new RegExp(
  String.raw`(?<route>${ROUTE})\s+requires?\s+\x60?(?<role>[a-zA-Z][a-zA-Z0-9_-]*)\x60?\s+role`,
  "gi"
);
const PERMISSION_ROLE_ONLY_SUFFIX = new RegExp(
  String.raw`(?<route>${ROUTE})\s+is\s+(?<role>[a-zA-Z][a-zA-Z0-9_-]*)-only`,
  "gi"
);
const PERMISSION_ONLY_ROLE_CAN = new RegExp(
  String.raw`only\s+\x60?(?<role>[a-zA-Z][a-zA-Z0-9_-]*)\x60?\s+(?:can|may|is\s+allowed\s+to)\s+(?:access|hit|use|call|invoke|reach|see)\s+(?<route>${ROUTE})`,
  "gi"
);
// ReDoS-bounded role length (32 chars max). Role names are short by
// nature ("admin", "staff", "billing-admin"). Without the cap, this
// regex catastrophic-backtracks on inputs with long unbroken word
// runs (e.g., 200KB filler in the stdin-cap audit). Verified safe.
const PERMISSION_ROLE_ONLY_PREFIX = new RegExp(
  String.raw`\x60?(?<role>[a-zA-Z][a-zA-Z0-9_-]{0,31})\x60?-only\s+on\s+(?<route>${ROUTE})`,
  "gi"
);
const PERMISSION_RESTRICTS_TO = new RegExp(
  String.raw`restricts?\s+(?<route>${ROUTE})\s+to\s+\x60?(?<role>[a-zA-Z][a-zA-Z0-9_-]*)\x60?(?:\s+role)?`,
  "gi"
);

// ---------- tier-cap ----------
// Four phrasings, all requiring an explicit route token (so the pin
// has something concrete to test against — implicit-route phrasings
// like "Free users limited to 3 projects" are intentionally NOT
// matched because we can't generate a test without knowing the
// endpoint).
//
//   "POST /api/projects is capped at 3 for free tier"
//   "POST /api/projects rejects free users above 3 projects"
//   "Free tier capped at 3 projects on POST /api/projects"
//   "/api/seats limits free tier to 1 seat"
//
// Hoisted HTTP_METHOD_PREFIX (same as the one used by returns-status
// further down) — kept in two places to avoid forward-reference
// issues with const expressions used in regex literals. KEEP IN SYNC.
//
// REGEX SAFETY: each pattern is structured to avoid catastrophic
// backtracking on large unmatched inputs. The optional resource word
// is wrapped in `(?:(\w+)\s+)?` rather than `(\w+)?\s*` so the engine
// can't backtrack between "resource" and the following literal. An
// earlier draft used `(?<resource>[a-zA-Z][a-zA-Z0-9_-]*)?\s*for`
// which exhibited O(N²) ReDoS on 200KB inputs.
const TIER_CAP_METHOD_PREFIX = String.raw`(?<method>POST|GET|PUT|PATCH|DELETE)\s+`;
const TIER_CAP_ROUTE_FIRST = new RegExp(
  String.raw`(?:${TIER_CAP_METHOD_PREFIX})?(?<route>${ROUTE})\s+(?:is\s+)?capped\s+at\s+(?<cap>\d+)\s+(?:(?<resource>[a-zA-Z][a-zA-Z0-9_-]*)\s+)?for\s+(?<tier>[a-zA-Z][a-zA-Z0-9_-]*)\s+tier`,
  "gi"
);
const TIER_CAP_ROUTE_REJECTS = new RegExp(
  String.raw`(?:${TIER_CAP_METHOD_PREFIX})?(?<route>${ROUTE})\s+rejects\s+(?<tier>[a-zA-Z][a-zA-Z0-9_-]*)\s+users?\s+above\s+(?<cap>\d+)\s+(?<resource>[a-zA-Z][a-zA-Z0-9_-]*)`,
  "gi"
);
// ReDoS-bounded: tier name is capped at 32 chars (real tier names
// are "free", "hobby", "starter", etc. — never 100K characters).
// Without the cap, the leading `\w+\s+tier` group catastrophic-
// backtracks on inputs with long unbroken word runs (e.g., the 200KB
// stdin-cap test feeds 190K `x` characters before the actual claim).
// 32 char cap → O(32 × N) instead of O(N²). Verified safe via the
// 03c-check-env-and-stdin audit on 200KB filler input.
const TIER_CAP_TIER_FIRST = new RegExp(
  String.raw`(?<tier>[a-zA-Z][a-zA-Z0-9_-]{0,31})\s+tier\s+capped\s+at\s+(?<cap>\d+)\s+(?<resource>[a-zA-Z][a-zA-Z0-9_-]*)\s+on\s+(?:${TIER_CAP_METHOD_PREFIX})?(?<route>${ROUTE})`,
  "gi"
);
const TIER_CAP_ROUTE_LIMITS = new RegExp(
  String.raw`(?:${TIER_CAP_METHOD_PREFIX})?(?<route>${ROUTE})\s+limits\s+(?<tier>[a-zA-Z][a-zA-Z0-9_-]{0,31})\s+tier\s+to\s+(?<cap>\d+)\s+(?<resource>[a-zA-Z][a-zA-Z0-9_-]*)`,
  "gi"
);
// Additional phrasings revealed by Quantasyte dogfood — AI agents
// write tier-cap claims in varied prose. Each requires an explicit
// route token (per v0.1 design); each is ReDoS-bounded on tier/resource.
//
//   "POST /api/x is limited to 3 projects for free tier"
//   "POST /api/x enforces a 3-projects cap for free tier"
//   "Free tier: max 3 projects on POST /api/x"
//   "Free users get at most 3 projects on POST /api/x"
const TIER_CAP_ROUTE_IS_LIMITED = new RegExp(
  String.raw`(?:${TIER_CAP_METHOD_PREFIX})?(?<route>${ROUTE})\s+is\s+limited\s+to\s+(?<cap>\d+)\s+(?<resource>[a-zA-Z][a-zA-Z0-9_-]{0,31})\s+for\s+(?<tier>[a-zA-Z][a-zA-Z0-9_-]{0,31})\s+tier`,
  "gi"
);
const TIER_CAP_ROUTE_ENFORCES = new RegExp(
  String.raw`(?:${TIER_CAP_METHOD_PREFIX})?(?<route>${ROUTE})\s+enforces\s+a?\s*(?<cap>\d+)[-\s]+(?<resource>[a-zA-Z][a-zA-Z0-9_-]{0,31})\s+cap\s+for\s+(?<tier>[a-zA-Z][a-zA-Z0-9_-]{0,31})\s+tier`,
  "gi"
);
const TIER_CAP_TIER_MAX_ON = new RegExp(
  String.raw`(?<tier>[a-zA-Z][a-zA-Z0-9_-]{0,31})\s+tier:?\s*max\s+(?<cap>\d+)\s+(?<resource>[a-zA-Z][a-zA-Z0-9_-]{0,31})\s+on\s+(?:${TIER_CAP_METHOD_PREFIX})?(?<route>${ROUTE})`,
  "gi"
);
const TIER_CAP_TIER_USERS_AT_MOST = new RegExp(
  String.raw`(?<tier>[a-zA-Z][a-zA-Z0-9_-]{0,31})\s+users\s+(?:get|can\s+have)\s+at\s+most\s+(?<cap>\d+)\s+(?<resource>[a-zA-Z][a-zA-Z0-9_-]{0,31})\s+on\s+(?:${TIER_CAP_METHOD_PREFIX})?(?<route>${ROUTE})`,
  "gi"
);

// ---------- returns-status ----------
// "POST /api/signup returns 400 on missing email."
// "/api/users returns 400 on empty body"
// "/api/x returns 422 on invalid email"
// "DELETE /api/y returns 204"
//
// Test mechanism: HTTP request with empty body (or single-invalid-field
// body when `invalid X` is specified), assert the response status code.
// The condition text ("missing email", "empty body", etc.) is preserved
// in the claim for human context (PINS.md) but does not change what
// gets sent — every test sends a minimally-invalid request.
//
// METHOD defaults to POST when the claim doesn't name it explicitly,
// since validation-failure semantics most often apply to mutating
// endpoints. GET/PUT/PATCH/DELETE are extracted when present at the
// start of the route. METHOD prefix is shared with tier-cap above
// (TIER_CAP_METHOD_PREFIX) — both use the same regex shape.
const RETURNS_STATUS_WITH_CONDITION = new RegExp(
  String.raw`(?:${TIER_CAP_METHOD_PREFIX})?(?<route>${ROUTE})\s+returns?\s+(?<status>[1-5]\d{2})\s+on\s+(?<conditionKind>missing|invalid|empty)\s+(?<field>(?:body|[a-zA-Z][\w]*))`,
  "gi"
);
const RETURNS_STATUS_BARE = new RegExp(
  String.raw`(?:${TIER_CAP_METHOD_PREFIX})?(?<route>${ROUTE})\s+returns?\s+(?<status>[1-5]\d{2})\b(?!\s+on\b)`,
  "gi"
);
// High-leverage natural-language phrasings AI agents write when
// describing validation. Both ReDoS-bounded ({0,31} on field group).
//
//   "POST /api/signup validates email; returns 400 if missing"
//   "POST /api/signup requires email; returns 400 otherwise"
const RETURNS_STATUS_VALIDATES = new RegExp(
  String.raw`(?:${TIER_CAP_METHOD_PREFIX})?(?<route>${ROUTE})\s+validates?\s+(?<field>[a-zA-Z][a-zA-Z0-9_-]{0,31})\s*[;:,]?\s*returns?\s+(?<status>[1-5]\d{2})\s+(?:if|when)\s+missing`,
  "gi"
);
const RETURNS_STATUS_REQUIRES = new RegExp(
  String.raw`(?:${TIER_CAP_METHOD_PREFIX})?(?<route>${ROUTE})\s+requires?\s+(?<field>[a-zA-Z][a-zA-Z0-9_-]{0,31})\s*[;:,]?\s*returns?\s+(?<status>[1-5]\d{2})\s+otherwise`,
  "gi"
);

// ---------- idempotent ----------
// "Makes /webhooks/stripe idempotent on event_id"
// "/webhooks/x is idempotent by message_id"
const IDEMPOTENT_ROUTE_FIRST = new RegExp(
  String.raw`(?:makes?\s+)?(?<route>${ROUTE})\s+(?:is\s+)?idempotent\s+(?:on|by|using|via|keyed\s+on)\s+(?:the\s+)?(?<idField>[a-zA-Z][\w-]*)`,
  "gi"
);

// "Idempotent /webhooks/y using event-id"
const IDEMPOTENT_KW_FIRST = new RegExp(
  String.raw`idempotent\s+(?<route>${ROUTE})\s+(?:on|by|using|via|keyed\s+on)\s+(?:the\s+)?(?<idField>[a-zA-Z][\w-]*)`,
  "gi"
);

// High-leverage natural-language phrasings AI agents write when
// describing webhook deduplication. Same template, different wording.
// Both ReDoS-bounded ({0,31} on the id-field group).
//
//   "/webhooks/stripe dedupes by event_id"
//   "POST /webhooks/x is safe to retry on event_id"
const IDEMPOTENT_DEDUPES_BY = new RegExp(
  String.raw`(?<route>${ROUTE})\s+(?:dedupes?|deduplicates?)\s+(?:on|by|using|via)\s+(?:the\s+)?(?<idField>[a-zA-Z][a-zA-Z0-9_-]{0,31})`,
  "gi"
);
const IDEMPOTENT_SAFE_TO_RETRY = new RegExp(
  String.raw`(?<route>${ROUTE})\s+is\s+safe\s+to\s+retry\s+(?:on|by|using|via)\s+(?:the\s+)?(?<idField>[a-zA-Z][a-zA-Z0-9_-]{0,31})`,
  "gi"
);

// ---------- cli-output-contains ----------
// "`pinned doctor` outputs `tests/pinned/ directory`"
// "`pinned list` prints `No pinned tests found`"
// "`pinned --version` reports `0.0.1`"
// "Adds `pinned init` that emits `+ tests/pinned/.gitkeep`"
//
// Verbs intentionally exclude "contains" — too ambiguous ("file X
// contains Y" reads as static text, not CLI output). The five chosen
// verbs all unambiguously describe output emission.
const CLI_OUTPUT_VERBS = "outputs|prints|reports|emits|shows";
// Optional connector words ("that", "which", "should") let claims be
// embedded in surrounding prose: "Adds `cmd` that outputs `text`."
const CLI_OUTPUT_CONNECTORS = "(?:that\\s+|which\\s+|should\\s+)?";
const CLI_OUTPUT_CONTAINS = new RegExp(
  String.raw`\x60(?<command>[^\x60\r\n]{1,200})\x60\s+${CLI_OUTPUT_CONNECTORS}(?:${CLI_OUTPUT_VERBS})\s+\x60(?<text>[^\x60\r\n]{1,200})\x60`,
  "gi"
);

// ---------- cli-exits-zero ----------
// "`pinned init` exits 0 on a healthy repo."
// "`pinned doctor` exits with status 0."
// "`pinned --version` exits cleanly."
// Optional trailing "on a healthy repo" / "with status N" prose is
// ignored — the binary verb "exits" + a "0" / "cleanly" / "successfully"
// is the load-bearing signal.
const CLI_EXITS_ZERO = new RegExp(
  String.raw`\x60(?<command>[^\x60\r\n]{1,200})\x60\s+(?:that\s+|which\s+|should\s+)?exits?\s+(?:with\s+(?:status\s+|code\s+)?)?(?:0\b|zero\b|cleanly\b|successfully\b)`,
  "gi"
);

// ---------- cli-creates-file ----------
// "`pinned init` creates `tests/pinned/.registry.json`."
// "`pinned init` writes `tests/pinned/PINS.md`."
// "Running `pinned init` produces `tests/pinned/.gitkeep`."
const CLI_CREATES_FILE = new RegExp(
  String.raw`\x60(?<command>[^\x60\r\n]{1,200})\x60\s+(?:that\s+|which\s+|should\s+)?(?:creates?|writes?|produces?|generates?)\s+\x60(?<filePath>[^\x60\r\n]{1,200})\x60`,
  "gi"
);

// ---------- cli-json-shape ----------
// "`pinned status --json` returns JSON with `activePins`, `verifiedStreak`."
// "`pinned doctor --json` outputs JSON containing `verdict`, `errors`."
// "`gh pr list --json` returns valid JSON with `number`, `title`, `body`."
//
// Two captures: <command> (backtick-bounded CLI invocation),
// <keys> (backtick-bounded comma-separated identifier list).
// Bounded {1,400} on the keys list to prevent ReDoS on adversarial input.
const CLI_JSON_SHAPE = new RegExp(
  String.raw`\x60(?<command>[^\x60\r\n]{1,200})\x60\s+(?:returns?|outputs?|prints?|emits?)\s+(?:(?:valid\s+)?JSON\s+)?(?:with|containing)\s+(?<keys>\x60[^\x60\r\n]{1,400}\x60(?:\s*,\s*\x60[^\x60\r\n]{1,400}\x60)*)`,
  "gi"
);

// ---------- cli-flag-supported ----------
// "`pinned check` supports `--json` flag."
// "`pinned check` accepts `--json`."
// "Adds `--include-retired` flag to `pinned list`."
//   ^ "to" form — flag first, command second
const CLI_FLAG_FORWARD = new RegExp(
  String.raw`\x60(?<command>[^\x60\r\n]{1,200})\x60\s+(?:that\s+|which\s+|should\s+)?(?:supports?|accepts?|handles?)\s+\x60(?<flag>-{1,2}[a-zA-Z][a-zA-Z0-9-]*)\x60`,
  "gi"
);
const CLI_FLAG_REVERSE = new RegExp(
  String.raw`(?:adds?|introduces?)\s+\x60(?<flag>-{1,2}[a-zA-Z][a-zA-Z0-9-]*)\x60\s+(?:flag\s+|option\s+)?(?:to|on|for)\s+\x60(?<command>[^\x60\r\n]{1,200})\x60`,
  "gi"
);

// ---------- library-returns ----------
// "`parseConfig()` in `src/config.ts` returns `{ version: 1 }`."
// "`add(2, 3)` in `src/math.ts` returns `5`."
// The expected slot is JSON.parse-able text inside backticks.
const LIBRARY_RETURNS = new RegExp(
  String.raw`\x60(?<functionName>[A-Za-z_][\w]*\([^\x60\r\n)]*\))\x60\s+(?:in|from)\s+\x60(?<modulePath>[^\x60\r\n\s]{1,200})\x60\s+returns?\s+\x60(?<expected>[^\x60\r\n]{1,400})\x60`,
  "gi"
);

// ---------- v0.2 workhorse templates ----------

// Page-route token — same as ROUTE but ALSO allows a bare `/` (root
// path). The base ROUTE pattern requires at least one non-special char
// after the slash, which excludes the root. Pages legitimately live at
// the root (homepage), so page-renders gets its own widened pattern.
const PAGE_ROUTE = String.raw`\/(?:[^\s,.;:!?)\]{}<>'"\x60 --​-‏‪-‮⁦-⁩﻿]*)`;

// page-renders — verbs: renders, loads, mounts, displays; optionally
// "should" / "must" prefix; optionally "without crashing" / "cleanly"
// / "properly" suffix. Covers Claude's "GET / renders without crashing"
// + natural variants like "/dashboard should render" + "GET /about loads".
const PAGE_RENDERS_GET = new RegExp(
  String.raw`(?:^|\s)GET\s+(?<route>${PAGE_ROUTE})\s+(?:should\s+|must\s+)?(?:renders?|loads?|mounts?|displays?)(?:\s+(?:without\s+crashing|cleanly|properly|correctly))?`,
  "gi"
);
// "Page /about renders" / "Page /dashboard should render"
const PAGE_RENDERS_PAGE_FIRST = new RegExp(
  String.raw`(?:^|\s)Page\s+(?<route>${PAGE_ROUTE})\s+(?:should\s+|must\s+)?(?:renders?|loads?|displays?)`,
  "gi"
);
// "/about renders" / "/dashboard should render" — bare-route + verb,
// requires the trailing "without crashing" / "cleanly" / "properly"
// qualifier OR an explicit "should" / "must" prefix so we don't match
// every `/route renders` substring in prose.
const PAGE_RENDERS_BARE = new RegExp(
  String.raw`(?<route>${PAGE_ROUTE})\s+(?:(?:should|must)\s+(?:renders?|loads?|mounts?|displays?)|(?:renders?|loads?)\s+(?:without\s+crashing|cleanly|properly|correctly))`,
  "gi"
);
// "/about returns a working page" / "/about returns a rendered page"
const PAGE_RENDERS_RETURNS_PAGE = new RegExp(
  String.raw`(?<route>${PAGE_ROUTE})\s+returns?\s+a\s+(?:working|rendered|valid)\s+page`,
  "gi"
);

// validation-rejects-bad — covers many natural phrasings:
//   "POST /api/X requires fields A, B, C"
//   "POST /api/X needs fields A, B"
//   "POST /api/X validates body" / "validates request body"
//   "POST /api/X validates against UserSchema"
//   "POST /api/X must reject invalid email"
//   "POST /api/X with bad input returns 400" (Claude's verbatim feedback)
const VALIDATION_REQUIRES_FIELDS = new RegExp(
  String.raw`(?:${TIER_CAP_METHOD_PREFIX})?(?<route>${ROUTE})\s+(?:requires?|needs?)\s+(?:the\s+)?(?:fields?|params?|properties|keys)\s+(?<fields>[A-Za-z][\w\s,'\x60"-]{0,200})`,
  "gi"
);
const VALIDATION_VALIDATES_SCHEMA = new RegExp(
  String.raw`(?:${TIER_CAP_METHOD_PREFIX})?(?<route>${ROUTE})\s+validates?\s+(?:body|request|input|against)\b`,
  "gi"
);
// "POST /api/X with bad input returns 400" — Claude's verbatim
// example phrasing. Also: "with invalid input", "with missing fields",
// "with empty body", "without X" — all map to validation-rejects-bad.
const VALIDATION_BAD_INPUT_RETURNS_4XX = new RegExp(
  String.raw`(?:${TIER_CAP_METHOD_PREFIX})?(?<route>${ROUTE})\s+with\s+(?:bad|invalid|missing|malformed|empty|no)\s+(?:input|body|payload|data|fields?|email|password)\s+returns?\s+(?<status>4\d{2})`,
  "gi"
);
// "POST /api/X must reject invalid X" / "POST /api/X rejects invalid X"
const VALIDATION_MUST_REJECT = new RegExp(
  String.raw`(?:${TIER_CAP_METHOD_PREFIX})?(?<route>${ROUTE})\s+(?:must\s+|should\s+)?rejects?\s+(?:invalid|bad|malformed|empty|missing)\s+(?<field>[a-zA-Z][\w-]{0,31})`,
  "gi"
);

// happy-path-with-side-effect — "POST /api/signup creates a users record"
// Target is captured EXPLICITLY (table/model name). Phrasings without
// a named target (e.g. "writes a row" alone) are intentionally not
// matched — without a target the pin is unverifiable.
const HAPPY_PATH_CREATES_RECORD = new RegExp(
  String.raw`(?:${TIER_CAP_METHOD_PREFIX})?(?<route>${ROUTE})\s+creates?\s+(?:an?\s+(?:new\s+)?|the\s+)?(?<target>[A-Za-z][\w]{0,40})\s+(?:record|row|entry|document)s?\b`,
  "gi"
);
// "POST /api/signup writes a row to users" — REQUIRES "to <target>" so
// we don't false-capture filler words ("a", "the", "new").
const HAPPY_PATH_WRITES_TO_TARGET = new RegExp(
  String.raw`(?:${TIER_CAP_METHOD_PREFIX})?(?<route>${ROUTE})\s+writes?\s+(?:an?\s+(?:row|record|entry|document)\s+)?(?:to|into|in)\s+(?:the\s+)?(?<target>[A-Za-z][\w]{0,40})(?:\s+(?:table|collection|database))?\b`,
  "gi"
);
// "POST /api/x inserts into users" / "POST /api/x adds a user record"
const HAPPY_PATH_INSERTS_INTO = new RegExp(
  String.raw`(?:${TIER_CAP_METHOD_PREFIX})?(?<route>${ROUTE})\s+(?:inserts?|adds?)\s+(?:an?\s+(?:new\s+)?)?(?:into\s+(?:the\s+)?)?(?<target>[A-Za-z][\w]{0,40})\b`,
  "gi"
);
// "POST /api/signup with valid body returns 200 + writes a row to users"
// REQUIRES an explicit "to <target>" or "<target> row/record" so we
// don't false-capture "a" / "the" / fillers.
const HAPPY_PATH_VALID_BODY_RETURNS_200 = new RegExp(
  String.raw`(?:${TIER_CAP_METHOD_PREFIX})?(?<route>${ROUTE})\s+with\s+(?:a\s+|valid\s+)+[a-z]{2,40}\s+returns?\s+(?:200|201|202)\s+(?:\+|and|,)\s+(?:writes?|creates?|inserts?|adds?)\s+(?:a\s+(?:row|record)\s+to\s+(?:the\s+)?|to\s+(?:the\s+)?)(?<target>[A-Za-z][\w]{0,40})\b`,
  "gi"
);

// ---------- public API ----------

export function parseClaims(rawBody: string): Claim[] {
  // Redact secrets BEFORE running any regex. This serves two goals:
  //   1. claim.raw (which gets persisted to .registry.json and rendered
  //      in PINS.md) never carries the original secret — so accidentally-
  //      leaked API keys / tokens / JWTs don't become committed artifacts.
  //   2. If a future LLM-fallback caller passes claim.raw onwards (PR
  //      comment, chat-hook, etc.), the redaction propagates.
  // We redact the WHOLE body, not just claim.raw values, so any regex
  // that happens to capture a secret in its match also gets the
  // redacted form. Conservative redaction (per SECRET_PATTERNS) — see
  // [[oidc-hosted-endpoint-mvp]] memory for the privacy posture.
  const body = redactSecrets(rawBody);

  const claims: Claim[] = [];
  const seen = new Set<string>();

  const push = (c: Claim, key: string) => {
    if (!seen.has(key)) {
      seen.add(key);
      claims.push(c);
    }
  };

  for (const m of body.matchAll(RATE_LIMIT_WORDS)) {
    const g = m.groups!;
    const c: RateLimitClaim = {
      template: "rate-limit",
      route: g.route,
      rate: Number(g.rate),
      window: normalizeWordWindow(g.window),
      raw: m[0],
    };
    push(c, `${c.template}:${c.route}:${c.rate}:${c.window}`);
  }

  for (const m of body.matchAll(RATE_LIMIT_UNIT)) {
    const g = m.groups!;
    const c: RateLimitClaim = {
      template: "rate-limit",
      route: g.route,
      rate: Number(g.rate),
      window: unitToWindow(g.unit),
      raw: m[0],
    };
    push(c, `${c.template}:${c.route}:${c.rate}:${c.window}`);
  }

  for (const m of body.matchAll(AUTH_REQUIRED_KW)) {
    const g = m.groups!;
    const c: AuthRequiredClaim = {
      template: "auth-required",
      route: g.route,
      raw: m[0],
    };
    push(c, `${c.template}:${c.route}`);
  }

  for (const m of body.matchAll(AUTH_REQUIRES)) {
    const g = m.groups!;
    const c: AuthRequiredClaim = {
      template: "auth-required",
      route: g.route,
      raw: m[0],
    };
    push(c, `${c.template}:${c.route}`);
  }

  // Role-based phrasings → permission-required (full 3-direction
  // role check: no-auth → 401, wrong-role → 403, right-role → 2xx).
  // Each direction is skipIf-gated on its own credential env var so
  // missing fixtures don't false-fail the others.
  for (const m of body.matchAll(PERMISSION_REQUIRES_ROLE)) {
    const g = m.groups!;
    const c: PermissionRequiredClaim = {
      template: "permission-required",
      route: g.route,
      role: g.role.toLowerCase(),
      raw: m[0],
    };
    push(c, `${c.template}:${c.route}:${c.role}`);
  }
  for (const m of body.matchAll(PERMISSION_ROLE_ONLY_SUFFIX)) {
    const g = m.groups!;
    const c: PermissionRequiredClaim = {
      template: "permission-required",
      route: g.route,
      role: g.role.toLowerCase(),
      raw: m[0],
    };
    push(c, `${c.template}:${c.route}:${c.role}`);
  }
  for (const m of body.matchAll(PERMISSION_ONLY_ROLE_CAN)) {
    const g = m.groups!;
    const c: PermissionRequiredClaim = {
      template: "permission-required",
      route: g.route,
      role: g.role.toLowerCase(),
      raw: m[0],
    };
    push(c, `${c.template}:${c.route}:${c.role}`);
  }
  for (const m of body.matchAll(PERMISSION_ROLE_ONLY_PREFIX)) {
    const g = m.groups!;
    const c: PermissionRequiredClaim = {
      template: "permission-required",
      route: g.route,
      role: g.role.toLowerCase(),
      raw: m[0],
    };
    push(c, `${c.template}:${c.route}:${c.role}`);
  }
  for (const m of body.matchAll(PERMISSION_RESTRICTS_TO)) {
    const g = m.groups!;
    const c: PermissionRequiredClaim = {
      template: "permission-required",
      route: g.route,
      role: g.role.toLowerCase(),
      raw: m[0],
    };
    push(c, `${c.template}:${c.route}:${c.role}`);
  }

  // tier-cap — 4 phrasings, each requiring an explicit route.
  // We tolerate missing `resource` by defaulting to "items" for the
  // capped-at form (resource is human-display only; doesn't change
  // the test mechanism).
  const tierCapHelpers: { regex: RegExp; defaultResource: string }[] = [
    { regex: TIER_CAP_ROUTE_FIRST, defaultResource: "items" },
    { regex: TIER_CAP_ROUTE_REJECTS, defaultResource: "items" },
    { regex: TIER_CAP_TIER_FIRST, defaultResource: "items" },
    { regex: TIER_CAP_ROUTE_LIMITS, defaultResource: "items" },
    { regex: TIER_CAP_ROUTE_IS_LIMITED, defaultResource: "items" },
    { regex: TIER_CAP_ROUTE_ENFORCES, defaultResource: "items" },
    { regex: TIER_CAP_TIER_MAX_ON, defaultResource: "items" },
    { regex: TIER_CAP_TIER_USERS_AT_MOST, defaultResource: "items" },
  ];
  for (const { regex, defaultResource } of tierCapHelpers) {
    for (const m of body.matchAll(regex)) {
      const g = m.groups!;
      const capNum = parseInt(g.cap, 10);
      if (!Number.isFinite(capNum) || capNum < 0) continue;
      const c: TierCapClaim = {
        template: "tier-cap",
        route: g.route,
        tier: g.tier.toLowerCase(),
        cap: capNum,
        resource: (g.resource ?? defaultResource).toLowerCase(),
        raw: m[0],
      };
      push(c, `${c.template}:${c.route}:${c.tier}:${c.cap}:${c.resource}`);
    }
  }

  // returns-status — with condition (missing/invalid/empty X)
  for (const m of body.matchAll(RETURNS_STATUS_WITH_CONDITION)) {
    const g = m.groups!;
    const method = (g.method?.toUpperCase() ?? "POST") as
      | "POST"
      | "GET"
      | "PUT"
      | "PATCH"
      | "DELETE";
    const status = Number(g.status);
    const conditionKind = g.conditionKind.toLowerCase() as
      | "missing"
      | "invalid"
      | "empty";
    const field = g.field;
    const condition =
      conditionKind === "empty" ? "empty body" : `${conditionKind} ${field}`;
    const c: ReturnsStatusClaim = {
      template: "returns-status",
      route: g.route,
      method,
      status,
      condition,
      conditionKind,
      field: conditionKind === "empty" ? undefined : field,
      raw: m[0],
    };
    push(c, `${c.template}:${c.route}:${c.method}:${c.status}:${condition}`);
  }
  // returns-status — bare (no condition)
  for (const m of body.matchAll(RETURNS_STATUS_BARE)) {
    const g = m.groups!;
    const method = (g.method?.toUpperCase() ?? "POST") as
      | "POST"
      | "GET"
      | "PUT"
      | "PATCH"
      | "DELETE";
    const status = Number(g.status);
    const c: ReturnsStatusClaim = {
      template: "returns-status",
      route: g.route,
      method,
      status,
      raw: m[0],
    };
    push(c, `${c.template}:${c.route}:${c.method}:${c.status}`);
  }
  // returns-status — natural-language "validates X / requires X" forms
  for (const m of body.matchAll(RETURNS_STATUS_VALIDATES)) {
    const g = m.groups!;
    const method = (g.method?.toUpperCase() ?? "POST") as
      | "POST"
      | "GET"
      | "PUT"
      | "PATCH"
      | "DELETE";
    const c: ReturnsStatusClaim = {
      template: "returns-status",
      route: g.route,
      method,
      status: Number(g.status),
      condition: `missing ${g.field}`,
      field: g.field,
      conditionKind: "missing",
      raw: m[0],
    };
    push(
      c,
      `${c.template}:${c.route}:${c.method}:${c.status}:missing:${c.field}`
    );
  }
  for (const m of body.matchAll(RETURNS_STATUS_REQUIRES)) {
    const g = m.groups!;
    const method = (g.method?.toUpperCase() ?? "POST") as
      | "POST"
      | "GET"
      | "PUT"
      | "PATCH"
      | "DELETE";
    const c: ReturnsStatusClaim = {
      template: "returns-status",
      route: g.route,
      method,
      status: Number(g.status),
      condition: `missing ${g.field}`,
      field: g.field,
      conditionKind: "missing",
      raw: m[0],
    };
    push(
      c,
      `${c.template}:${c.route}:${c.method}:${c.status}:missing:${c.field}`
    );
  }

  for (const m of body.matchAll(IDEMPOTENT_ROUTE_FIRST)) {
    const g = m.groups!;
    const c: IdempotentClaim = {
      template: "idempotent",
      route: g.route,
      idField: g.idField,
      raw: m[0],
    };
    push(c, `${c.template}:${c.route}:${c.idField}`);
  }

  for (const m of body.matchAll(IDEMPOTENT_DEDUPES_BY)) {
    const g = m.groups!;
    push(
      {
        template: "idempotent",
        route: g.route,
        idField: g.idField,
        raw: m[0],
      },
      `idempotent:${g.route}:${g.idField}`
    );
  }
  for (const m of body.matchAll(IDEMPOTENT_SAFE_TO_RETRY)) {
    const g = m.groups!;
    push(
      {
        template: "idempotent",
        route: g.route,
        idField: g.idField,
        raw: m[0],
      },
      `idempotent:${g.route}:${g.idField}`
    );
  }
  for (const m of body.matchAll(IDEMPOTENT_KW_FIRST)) {
    const g = m.groups!;
    const c: IdempotentClaim = {
      template: "idempotent",
      route: g.route,
      idField: g.idField,
      raw: m[0],
    };
    push(c, `${c.template}:${c.route}:${c.idField}`);
  }

  for (const m of body.matchAll(CLI_OUTPUT_CONTAINS)) {
    const g = m.groups!;
    const command = g.command.trim();
    const text = g.text;
    if (!isCliShape(command)) continue;
    if (text.length === 0) continue;
    const c: CliOutputContainsClaim = {
      template: "cli-output-contains",
      route: command,
      text,
      raw: m[0],
    };
    push(c, `${c.template}:${c.route}:${c.text}`);
  }

  for (const m of body.matchAll(CLI_EXITS_ZERO)) {
    const g = m.groups!;
    const command = g.command.trim();
    if (!isCliShape(command)) continue;
    const c: CliExitsZeroClaim = {
      template: "cli-exits-zero",
      route: command,
      raw: m[0],
    };
    push(c, `${c.template}:${c.route}`);
  }

  for (const m of body.matchAll(CLI_CREATES_FILE)) {
    const g = m.groups!;
    const command = g.command.trim();
    const filePath = g.filePath.trim();
    if (!isCliShape(command)) continue;
    // Block path-traversal and absolute paths in the expected file
    // slot — generated tests run in a tempdir and shouldn't be able
    // to assert against arbitrary filesystem locations.
    if (filePath.length === 0 || filePath.startsWith("/") || filePath.includes("..")) continue;
    if (!isFilePathShape(filePath)) continue;
    const c: CliCreatesFileClaim = {
      template: "cli-creates-file",
      route: command,
      filePath,
      raw: m[0],
    };
    push(c, `${c.template}:${c.route}:${c.filePath}`);
  }

  for (const m of body.matchAll(CLI_JSON_SHAPE)) {
    const g = m.groups!;
    const command = g.command.trim();
    if (!isCliShape(command)) continue;
    // Command must invoke --json (or equivalent). This filter rejects
    // false positives like "`pinned status` outputs JSON with foo" where
    // the command doesn't actually have a JSON output mode.
    if (!/--json\b|--output[\s=]+json\b|-j\b/.test(command)) continue;
    // Extract individual backtick-bounded keys from the keys group.
    const keys: string[] = [];
    const KEY_TOKEN = /\x60([^\x60\r\n]{1,400})\x60/g;
    for (const km of g.keys.matchAll(KEY_TOKEN)) {
      const key = km[1].trim();
      // Each key must be a JS-identifier-shaped string. Rejects nested
      // JSON paths like `data.foo` (too brittle to assert on) and
      // anything with spaces (looks like a substring, not a key).
      if (!/^[A-Za-z_][\w]{0,63}$/.test(key)) continue;
      keys.push(key);
    }
    if (keys.length === 0) continue;
    const c: CliJsonShapeClaim = {
      template: "cli-json-shape",
      route: command,
      keys,
      raw: m[0],
    };
    push(c, `${c.template}:${c.route}:${keys.sort().join(",")}`);
  }

  for (const m of body.matchAll(CLI_FLAG_FORWARD)) {
    const g = m.groups!;
    const command = g.command.trim();
    const flag = g.flag.trim();
    if (!isCliShape(command)) continue;
    const c: CliFlagSupportedClaim = {
      template: "cli-flag-supported",
      route: command,
      flag,
      raw: m[0],
    };
    push(c, `${c.template}:${c.route}:${c.flag}`);
  }
  for (const m of body.matchAll(CLI_FLAG_REVERSE)) {
    const g = m.groups!;
    const command = g.command.trim();
    const flag = g.flag.trim();
    if (!isCliShape(command)) continue;
    const c: CliFlagSupportedClaim = {
      template: "cli-flag-supported",
      route: command,
      flag,
      raw: m[0],
    };
    push(c, `${c.template}:${c.route}:${c.flag}`);
  }

  for (const m of body.matchAll(LIBRARY_RETURNS)) {
    const g = m.groups!;
    const functionName = g.functionName.trim();
    const modulePath = g.modulePath.trim();
    const rawExpected = g.expected.trim();
    // Block path-traversal / absolute paths in the module slot — the
    // generated test will dynamic-import the path, so allow only
    // repo-relative paths.
    if (modulePath.startsWith("/") || modulePath.includes("..")) continue;
    // Parse the expected value as JSON. If it's not parseable, skip.
    let expected: unknown;
    try {
      expected = JSON.parse(rawExpected);
    } catch {
      // Allow bare-number / bare-string fall-through? No — require
      // JSON. Authors writing claims like `returns 5` will need to
      // wrap as `returns \`5\``, which IS valid JSON.
      continue;
    }
    const c: LibraryReturnsClaim = {
      template: "library-returns",
      functionName,
      modulePath,
      expected,
      raw: m[0],
    };
    push(c, `${c.template}:${c.modulePath}:${c.functionName}:${rawExpected}`);
  }

  // ---------- page-renders (v0.2) ----------
  const pageRendersPatterns = [
    PAGE_RENDERS_GET,
    PAGE_RENDERS_PAGE_FIRST,
    PAGE_RENDERS_BARE,
    PAGE_RENDERS_RETURNS_PAGE,
  ];
  for (const regex of pageRendersPatterns) {
    for (const m of body.matchAll(regex)) {
      const g = m.groups!;
      // Normalize route — root path comes out as empty after stripping
      // the leading slash; preserve "/" for the root case.
      const route = g.route === "" ? "/" : g.route;
      const c: PageRendersClaim = {
        template: "page-renders",
        route,
        raw: m[0],
      };
      push(c, `${c.template}:${c.route}`);
    }
  }

  // ---------- validation-rejects-bad (v0.2) ----------
  for (const m of body.matchAll(VALIDATION_REQUIRES_FIELDS)) {
    const g = m.groups!;
    const method = (g.method as "POST" | "PUT" | "PATCH" | "DELETE") || "POST";
    const fields = g.fields
      .split(/\s*,\s*|\s+and\s+/)
      .map((f: string) => f.trim().replace(/^[`"']|[`"']$/g, ""))
      .filter((f: string) => /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(f));
    if (fields.length === 0) continue;
    const c: ValidationRejectsBadClaim = {
      template: "validation-rejects-bad",
      route: g.route,
      method,
      requiredFields: fields,
      raw: m[0],
    };
    push(c, `${c.template}:${c.route}:${fields.join(",")}`);
  }
  for (const m of body.matchAll(VALIDATION_VALIDATES_SCHEMA)) {
    const g = m.groups!;
    const method = (g.method as "POST" | "PUT" | "PATCH" | "DELETE") || "POST";
    const c: ValidationRejectsBadClaim = {
      template: "validation-rejects-bad",
      route: g.route,
      method,
      requiredFields: [],
      raw: m[0],
    };
    push(c, `${c.template}:${c.route}:schema`);
  }
  // Claude's verbatim "POST /api/X with bad input returns 400" form
  for (const m of body.matchAll(VALIDATION_BAD_INPUT_RETURNS_4XX)) {
    const g = m.groups!;
    const method = (g.method as "POST" | "PUT" | "PATCH" | "DELETE") || "POST";
    const c: ValidationRejectsBadClaim = {
      template: "validation-rejects-bad",
      route: g.route,
      method,
      requiredFields: [],
      raw: m[0],
    };
    push(c, `${c.template}:${c.route}:bad-input`);
  }
  // "POST /api/X must reject invalid email" form
  for (const m of body.matchAll(VALIDATION_MUST_REJECT)) {
    const g = m.groups!;
    const method = (g.method as "POST" | "PUT" | "PATCH" | "DELETE") || "POST";
    const c: ValidationRejectsBadClaim = {
      template: "validation-rejects-bad",
      route: g.route,
      method,
      requiredFields: [g.field],
      raw: m[0],
    };
    push(c, `${c.template}:${c.route}:reject:${g.field}`);
  }

  // ---------- happy-path-with-side-effect (v0.2) ----------
  const happyPathPatterns = [
    HAPPY_PATH_CREATES_RECORD,
    HAPPY_PATH_WRITES_TO_TARGET,
    HAPPY_PATH_INSERTS_INTO,
    HAPPY_PATH_VALID_BODY_RETURNS_200,
  ];
  for (const regex of happyPathPatterns) {
    for (const m of body.matchAll(regex)) {
      const g = m.groups!;
      const method = (g.method as "POST" | "PUT" | "PATCH" | "DELETE") || "POST";
      const target = g.target.toLowerCase();
      // Reject targets that are filler words. These shouldn't match
      // the regex if it's strict, but guard anyway in case future
      // regex changes loosen the capture.
      if (["a", "an", "the", "new", "row", "record", "entry"].includes(target)) {
        continue;
      }
      const c: HappyPathWithSideEffectClaim = {
        template: "happy-path-with-side-effect",
        route: g.route,
        method,
        sideEffectKind: "db-write",
        sideEffectTarget: target,
        raw: m[0],
      };
      push(c, `${c.template}:${c.route}:${c.sideEffectTarget}`);
    }
  }

  return claims;
}

// ---------------------------------------------------------------------------
// Diagnostic parser — same matching as parseClaims, but ALSO reports lines
// that looked claim-shaped but didn't match any template's regex. Surfaced
// in `pinned check` and the PR-comment workflow so users aren't silently
// misled into thinking "Found 1 claim(s)" means 1/1 when it actually means
// 1/N (N-1 lines were dropped because no template matched their phrasing).
// ---------------------------------------------------------------------------

export type ParseDiagnostics = {
  /** Claims that matched a recognized template. */
  recognized: Claim[];
  /**
   * Lines that LOOK like intended claims (mention a route + a status code
   * or a domain verb like "requires"/"returns"/"rejects") but weren't
   * matched by any template's regex. Each entry is the original line as it
   * appeared in the input (post-redaction), trimmed.
   */
  dropped: string[];
};

// A line is "claim-shaped" if it mentions BOTH a target (route or HTTP
// method) AND an outcome (status code, or a domain verb describing what
// the endpoint does). Used to filter `dropped[]` so we don't spam users
// with every uncovered prose sentence — only ones that read like
// behavioral promises but failed to parse.
const CLAIM_SHAPE_TARGET =
  /(?:\/[A-Za-z0-9_/:.{}\-]+|\b(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b)/i;
const CLAIM_SHAPE_OUTCOME =
  /\b(?:[1-5]\d{2})\b|\b(?:returns?|rejects?|requires?|must|valid|invalid|blocks?|auth(?:enticate[ds]?|orize[ds]?|s)?)\b/i;

export function parseClaimsWithDiagnostics(rawBody: string): ParseDiagnostics {
  const recognized = parseClaims(rawBody);
  const body = redactSecrets(rawBody);

  // Normalized text covered by recognized matches — used to suppress
  // claim-shaped lines that ARE actually covered (the regex match might
  // be a substring of a longer sentence, so we test both directions).
  const coveredText = recognized
    .map((c) => normalizeForCompare(c.raw))
    .filter((s) => s.length > 0);

  const candidates = splitIntoClaimCandidates(body);
  const dropped: string[] = [];
  const seenDropped = new Set<string>();

  for (const candidate of candidates) {
    const line = candidate.trim();
    if (line.length < 8) continue;
    if (!CLAIM_SHAPE_TARGET.test(line)) continue;
    if (!CLAIM_SHAPE_OUTCOME.test(line)) continue;

    const norm = normalizeForCompare(line);
    if (seenDropped.has(norm)) continue;

    // Already covered by a recognized claim? Substring either direction.
    const covered = coveredText.some(
      (r) => r === norm || norm.includes(r) || r.includes(norm)
    );
    if (covered) continue;

    seenDropped.add(norm);
    dropped.push(line);
  }

  return { recognized, dropped };
}

function splitIntoClaimCandidates(body: string): string[] {
  // Split on hard line breaks first, then strip a leading list marker
  // (bullet or "1. " style) from each line, then split each line on
  // sentence boundaries. CRITICAL: don't split on `\d+\. ` mid-line —
  // that pattern matches HTTP status codes followed by a period (e.g.
  // "...returns 400. POST /next/...") and was truncating claim text.
  // List markers only count when they're at the START of a line.
  return body
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:[-*•]\s+|\d+\.\s+)/, ""))
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z/])/))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function normalizeForCompare(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.,;!?]+$/, "")
    .trim();
}

// Shared filter for CLI command shapes — must start with a word char
// and look like an ACTUAL invocation, not a bare binary name. A bare
// alphabetic token (e.g. `hermesc`, `localToUtc`) is almost always a
// function reference or transitive-dep mention in prose, not a CLI
// the customer maintains. Real CLI invocations in claim text are
// either:
//   - multi-word: `pinned init`, `npm test`, `node ./cli.js --check`
//   - flag-bearing: `pinned --version`
//   - explicit path: `./bin/foo`, `node ./apps/cli/dist/cli.js`
//
// Surfaced via the supabase-js corpus sweep: `hermesc` exits 0 was
// being parsed from a build-log mention of the React Native Hermes
// compiler, which supabase-js doesn't maintain.
function isCliShape(command: string): boolean {
  if (!/^[a-zA-Z][\w./-]*(\s|$)/.test(command)) return false;
  // Reject bare-binary single-word commands (no space, no flag, no path).
  const looksLikeInvocation =
    /\s/.test(command) ||             // multi-word ("npm test")
    /-{1,2}[a-zA-Z]/.test(command) || // flag ("--version", "-h")
    /^\.\.?\//.test(command) ||       // explicit path ("./bin/foo")
    /\//.test(command);                // contains path separator
  return looksLikeInvocation;
}

// Filter for the `filePath` slot in cli-creates-file. Real file paths
// look like:
//   - "tests/pinned/PINS.md"          (has /)
//   - "package.json"                  (has .json extension)
//   - "PINS.md"                       (has .md extension)
// Junk that slips through without this filter:
//   - `NaN`        (umami corpus: "produces `NaN`" misread as creating file NaN)
//   - `5`, `true`, `null`, etc.
// Real filenames either contain a path separator OR end with a known
// extension. Bare alphanumeric tokens never qualify.
function isFilePathShape(p: string): boolean {
  if (p.length === 0) return false;
  if (/\//.test(p)) return true;
  // Has a file extension: dot followed by 1-6 alphanumeric chars at end
  if (/\.[a-zA-Z0-9]{1,6}$/.test(p)) return true;
  return false;
}

// Returns the claim's route/command identifier, or null for templates
// (like library-returns) that have no route concept. Callers that
// match claims to routes (scanDiff coverage) should treat null as
// "this claim type can't cover any route."
// Plain-English description of what a claim protects. One sentence,
// suitable for `pinned list --verbose`, `pinned show`, and PINS.md.
// The technical claim text is preserved separately as `claim.raw` —
// this function answers "why does this pin exist?" rather than "what
// exact text matched?".
//
// Convention: lead with "Protects:" followed by a single sentence
// stating the contract from the user's perspective.
// User-facing description of a pin in three layers, from most
// product-meaningful to most mechanical:
//
//   title   — short noun phrase naming the protected behavior
//   promise — sentence stating what the user can rely on
//   check   — sentence describing what the test mechanically does
//
// Surfaces that should use these:
//   pinned list (default)   → title only (scan view)
//   pinned list --verbose   → title + promise + check + metadata
//   pinned show <id>        → all three + metadata
//   PR comments             → title (bold lead) + promise
export type ClaimDisplay = {
  title: string;
  promise: string;
  check: string;
};

// For CLI claims, `claim.route` stores the literal invocation the user
// wrote (e.g. `node ./apps/cli/dist/cli.js try`). That's needed
// verbatim for the generated test to run, but it's noisy in titles.
// Compact it for display:
//   - "node <path/to/cli.js> ARGS"  → "<binName> ARGS"
//   - "npx <pkg> ARGS"              → "<binName> ARGS"
//   - everything else                → returned unchanged
// The default binName is "pinned" — the published CLI binary name. The
// goal is to keep titles short + recognizable while leaving the
// generated test mechanically correct.
export function shortCommandLabel(route: string, binName = "pinned"): string {
  // node ./path/cli.js ARGS  →  pinned ARGS
  const nodeMatch = /^node\s+\S+\.(?:m?js|cjs)\s*(.*)$/.exec(route.trim());
  if (nodeMatch) {
    const args = nodeMatch[1].trim();
    return args ? `${binName} ${args}` : binName;
  }
  // npx <pkg> ARGS  →  pinned ARGS
  const npxMatch = /^npx\s+\S+\s*(.*)$/.exec(route.trim());
  if (npxMatch) {
    const args = npxMatch[1].trim();
    return args ? `${binName} ${args}` : binName;
  }
  return route;
}

// Title-safe truncation for backtick-wrapped command/argument strings.
// Used when a claim's command contains a long --description argument
// (or similar) that would bloat the title. Caller is expected to wrap
// the returned value in backticks. Default cap fits the scan-view
// width without wrapping in most terminals.
export function truncateForTitle(s: string, maxLen = 60): string {
  if (s.length <= maxLen) return s;
  // Truncate to maxLen-1 chars and append a U+2026 horizontal ellipsis.
  return s.slice(0, maxLen - 1).trimEnd() + "…";
}

export function describeClaimForUser(c: Claim): ClaimDisplay {
  switch (c.template) {
    case "rate-limit":
      return {
        title: `${c.route} rejects request bursts above ${c.rate}/${c.window}`,
        promise: `Bursts above ${c.rate} requests per ${c.window} to ${c.route} are rejected with 429.`,
        check: `Fires ${c.rate + 1} parallel requests at ${c.route}; expects at least one to return 429.`,
      };
    case "auth-required":
      return {
        title: `${c.route} is not publicly accessible`,
        promise: `Unauthenticated requests to ${c.route} are rejected.`,
        check: `Sends a request to ${c.route} with no Authorization header; expects 401 or 403.`,
      };
    case "permission-required":
      return {
        title: `${c.route} is restricted to ${c.role}`,
        promise: `${c.route} rejects unauthenticated and wrong-role requests; accepts ${c.role}-role requests.`,
        check: `3 directions: no-auth → 401/403 · wrong-role token → 403 · ${c.role}-role token → 2xx (each skip-conditioned on its fixture env var).`,
      };
    case "tier-cap":
      return {
        title: `${c.route} enforces a ${c.cap}-${c.resource} cap for ${c.tier} tier`,
        promise: `${c.tier}-tier users at the ${c.cap}-${c.resource} cap cannot perform the gated action; paid-tier users can.`,
        check: `3 directions: ${c.tier}+under-cap → 2xx · ${c.tier}+at-cap → 4xx · paid+over-cap → 2xx (each skip-conditioned on its fixture token env var).`,
      };
    case "idempotent":
      return {
        title: `${c.route} handles duplicate retries safely`,
        promise: `Replaying the same \`${c.idField}\` to ${c.route} must not create a second side effect.`,
        check: `POSTs the same payload twice to ${c.route}; expects byte-identical responses both times.`,
      };
    case "returns-status": {
      const condition = c.condition ?? "a minimally-invalid body";
      const what =
        c.conditionKind === "invalid" && c.field
          ? `an invalid \`${c.field}\` field`
          : c.conditionKind === "missing" && c.field
            ? `an empty body (so \`${c.field}\` is missing)`
            : c.conditionKind === "empty"
              ? "an empty body"
              : "a minimally-invalid body";
      return {
        title: `${c.method} ${c.route} rejects ${condition} with ${c.status}`,
        promise: `${c.method} ${c.route} returns ${c.status} when called with ${condition}.`,
        check: `Sends ${c.method} ${c.route} with ${what}; expects HTTP ${c.status}.`,
      };
    }
    case "cli-output-contains": {
      // Truncate the command label for the title but keep the FULL
      // route in the check sentence so devs can reproduce the test.
      const label = truncateForTitle(shortCommandLabel(c.route));
      const labelFull = shortCommandLabel(c.route);
      return {
        title: `\`${label}\` outputs \`${c.text}\``,
        promise: `Running \`${labelFull}\` continues to print \`${c.text}\` somewhere in its output.`,
        check: `Runs \`${c.route}\` and asserts the output contains "${c.text}".`,
      };
    }
    case "cli-exits-zero": {
      const label = truncateForTitle(shortCommandLabel(c.route));
      const labelFull = shortCommandLabel(c.route);
      return {
        title: `\`${label}\` runs cleanly`,
        promise: `Running \`${labelFull}\` continues to succeed (exit code 0).`,
        check: `Runs \`${c.route}\` and asserts the exit code is 0.`,
      };
    }
    case "cli-creates-file": {
      const label = truncateForTitle(shortCommandLabel(c.route));
      const labelFull = shortCommandLabel(c.route);
      return {
        title: `\`${label}\` creates \`${c.filePath}\``,
        promise: `Running \`${labelFull}\` continues to create the file \`${c.filePath}\`.`,
        check: `Runs \`${c.route}\` in a temporary directory; asserts \`${c.filePath}\` exists afterward.`,
      };
    }
    case "cli-json-shape": {
      const label = truncateForTitle(shortCommandLabel(c.route));
      const labelFull = shortCommandLabel(c.route);
      const keys = c.keys.join(", ");
      return {
        title: `\`${label}\` returns JSON with ${c.keys.length} key${c.keys.length === 1 ? "" : "s"}`,
        promise: `\`${labelFull}\` outputs valid JSON containing keys: ${keys}.`,
        check: `Runs \`${c.route}\`, parses stdout as JSON, asserts these keys exist on the top-level object: ${keys}.`,
      };
    }
    case "cli-flag-supported": {
      const label = truncateForTitle(shortCommandLabel(c.route));
      const labelFull = shortCommandLabel(c.route);
      return {
        title: `\`${label}\` accepts the \`${c.flag}\` flag`,
        promise: `The \`${c.flag}\` flag on \`${labelFull}\` remains documented and accepted.`,
        check: `Runs \`${c.route} --help\` and asserts \`${c.flag}\` appears in the output.`,
      };
    }
    case "library-returns":
      return {
        title: `\`${c.functionName}\` in \`${c.modulePath}\` still returns ${JSON.stringify(c.expected)}`,
        promise: `Calling \`${c.functionName}\` from \`${c.modulePath}\` continues to return ${JSON.stringify(c.expected)}.`,
        check: `Imports \`${c.functionName}\` from \`${c.modulePath}\`, calls it, and deep-equals the return against ${JSON.stringify(c.expected)}.`,
      };
    case "lockfile-integrity":
      return {
        title: `\`${c.lockfilePath}\` content is unchanged`,
        promise: `\`${c.lockfilePath}\` retains its SHA-256 (${c.expectedSha256.slice(0, 12)}…) — catches AI-driven \`npm install\` / \`pnpm install\` that silently changes transitive dependency resolutions.`,
        check: `Reads \`${c.lockfilePath}\`, computes SHA-256, asserts it matches the value captured at pin time.`,
      };
    case "config-invariant":
      return {
        title: `${c.label} present in \`${c.configPath}\``,
        promise: `\`${c.configPath}\` continues to contain the expected ${c.label} block — catches AI agents that "tidy" config and remove load-bearing lines.`,
        check: `Reads \`${c.configPath}\`, asserts the required text is present (substring match).`,
      };
    case "package-exports-exist":
      return {
        title: `\`${c.modulePath}\` keeps exporting ${c.exports.length} symbol${c.exports.length === 1 ? "" : "s"}`,
        promise: `\`${c.modulePath}\` continues to export: ${c.exports.join(", ")} — catches accidental renames / deletions in the public API.`,
        check: `Dynamic-imports \`${c.modulePath}\`, asserts every name in [${c.exports.join(", ")}] is defined (\`typeof export !== "undefined"\`).`,
      };
    case "secret-not-public":
      return {
        title: `No \`${c.publicPrefix}\` env var contains [${c.secretMarkers.join(", ")}]`,
        promise: `No environment variable matching \`${c.publicPrefix}*\` ever has a secret-shaped name — catches the AI mistake of inlining a server-only secret into the client bundle.`,
        check: `Scans \`.env*\` files and source for any \`${c.publicPrefix}*<SECRET-MARKER>*\` reference; fails if any match.`,
      };
    case "url-literal-preserved":
      return {
        title: `URL \`${c.urlLiteral}\` stays in \`${c.filePath}\``,
        promise: `The exact URL literal \`${c.urlLiteral}\` keeps appearing in \`${c.filePath}\` — catches endpoint typos, version drift, and accidental redirects.`,
        check: `Reads \`${c.filePath}\` and asserts the literal \`${c.urlLiteral}\` is present in the file content.`,
      };
    case "tsc-clean":
      return {
        title: `\`tsc --noEmit\` keeps exiting 0`,
        promise: `TypeScript compilation succeeds without errors — catches the "TS build broken" class of fixes from being silently re-introduced.`,
        check: `Spawns \`npx tsc --noEmit -p ${c.tsconfigPath}\`; fails on non-zero exit.`,
      };
    case "module-export-stable":
      return {
        title: `\`${c.modulePath}\` keeps exporting \`${c.exportName}\``,
        promise: `The named export \`${c.exportName}\` stays exported from \`${c.modulePath}\` — catches the "missing export" class of bug.`,
        check: `Reads \`${c.modulePath}\` and asserts a top-level \`export\` of \`${c.exportName}\` is present.`,
      };
    case "react-route-registered":
      return {
        title: `\`<Route path="${c.routePath}">\` stays in \`${c.routerFilePath}\``,
        promise: `The route entry for \`${c.routePath}\` keeps being declared in the SPA router — catches the "page unreachable after refactor" regression.`,
        check: `Reads \`${c.routerFilePath}\` and asserts a path literal matching \`${c.routePath}\` is present.`,
      };
    case "webhook-handler-exists":
      return {
        title: `${c.provider} webhook handler stays at \`${c.filePath}\``,
        promise: `The ${c.provider} webhook handler file keeps existing and keeps its handler signature — catches deletion / renaming regressions.`,
        check: `Reads \`${c.filePath}\` and asserts the handler signature is still present.`,
      };
    case "import-path-resolves":
      return {
        title: `\`${c.sourceFilePath}\` keeps importing \`${c.importPath}\``,
        promise: `The import of \`${c.importPath}\` from \`${c.sourceFilePath}\` keeps resolving — catches missing-dep / module-rename regressions.`,
        check: `Reads \`${c.sourceFilePath}\`, finds the import line, and asserts the imported module still exists on disk or in node_modules.`,
      };
    case "changed-literal-preserved":
      return {
        title: `\`${c.filePath}\` keeps the fix's ${c.shape} value \`${c.newValue}\``,
        promise: `The fix replaced \`${c.oldValue}\` with \`${c.newValue}\` in \`${c.filePath}\`. The new value keeps being present — catches the regression where the typo/wrong value silently comes back.`,
        check: `Reads \`${c.filePath}\` and asserts the literal \`${c.newValue}\` is present in the file content.`,
      };
    case "form-submit-error-handling":
      return {
        title: `form submit handler in \`${c.filePath}\` keeps catching errors`,
        promise: `The form's onSubmit handler keeps wrapping itself in try/catch or .catch — catches AI accidentally removing the error handling and producing unhandled promise rejections in production.`,
        check: `Reads \`${c.filePath}\` and asserts the captured onSubmit + error-handling shape is still present.`,
      };
    case "page-renders":
      return {
        title: `\`${c.route}\` renders without crashing`,
        promise: `The page at \`${c.route}\` keeps rendering as HTML — no React/Next/Vite error overlays, no 500 page, no empty/skeleton-only body.`,
        check: `GETs \`${c.route}\` from PREVIEW_URL with \`Accept: text/html\`, asserts 200/304 + non-trivial HTML body + no known render-error markers (\`Application error\`, \`__NEXT_ERROR_CODE\`, \`Cannot read prop\`, etc.).`,
      };
    case "validation-rejects-bad":
      return {
        title: `\`${c.method} ${c.route}\` rejects bad input`,
        promise: `The endpoint keeps refusing malformed JSON + bodies missing required fields (${c.requiredFields.length} field(s) tracked: ${c.requiredFields.join(", ") || "none extracted at pin-time"}) — catches removed/weakened validation.`,
        check: `Sends N intentionally-bad ${c.method} requests to \`${c.route}\` (one per required field missing + one with malformed JSON), asserts each returns 4xx.`,
      };
    case "happy-path-with-side-effect":
      return {
        title: `\`${c.method} ${c.route}\` actually does the ${c.sideEffectKind} (not just returns 200)`,
        promise: `The endpoint keeps performing its real side-effect (a ${c.sideEffectKind} to \`${c.sideEffectTarget}\`) — catches the misleading-green case where a refactor stubs out the work but keeps returning 200.`,
        check: `Sends a valid ${c.method} to \`${c.route}\` with \`X-Pinned-Test: 1\`. Asserts response is 2xx AND emits \`X-Pinned-Side-Effect\` headers proving the side-effect ran. Requires a small response wrapper on the handler — see https://pinnedai.dev/docs/x-pinned-side-effect`,
      };
    case "journey": {
      const stepSummary = c.steps
        .map((s) => `${s.method} ${s.route}`)
        .join(" → ");
      return {
        title: `journey: ${c.label}`,
        promise: `The user journey \`${c.label}\` (${stepSummary}) still works end-to-end — cookies carry, statuses match, and no degraded body markers appear.`,
        check: `Walks ${c.steps.length} step(s) with a shared cookie jar. Per step: asserts status, body inclusions, body forbids, and any expected Set-Cookie / redirect. Catches regressions single-step templates structurally miss (e.g. signup succeeds but /me returns stale email).`,
      };
    }
  }
}

// Back-compat alias — preserved so any external callers (landing demo,
// older audits) that imported the previous single-string renderer keep
// working. New code should use describeClaimForUser instead.
export function describeClaimHuman(c: Claim): string {
  return describeClaimForUser(c).title;
}

// Secret redaction — runs on claim.raw before storage so PR bodies
// containing accidentally-pasted API keys / tokens / JWTs / credentialed
// URLs don't leak into the customer's committed registry / PINS.md /
// PR comments. This is one of the highest-severity launch risks per
// GPT review: a single PR with a leaked Stripe key gets PERMANENTLY
// committed via .registry.json's claim.raw field.
//
// Patterns conservative — better to miss a real secret (manual review
// catches that) than to falsely redact legit text (would corrupt
// claim.raw). Each pattern is anchored on a distinctive prefix or
// structure that doesn't false-match.
// ORDER MATTERS: more-specific patterns first. `sk-ant-` matches
// `sk-` shape, so Anthropic must come before OpenAI. Otherwise the
// Anthropic key gets redacted as OPENAI_KEY (the audit caught this).
const SECRET_PATTERNS: { name: string; regex: RegExp }[] = [
  // Anthropic — must come BEFORE OpenAI's sk- prefix matcher
  { name: "ANTHROPIC_KEY", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  // OpenAI keys (legacy `sk-XXX` and new `sk-proj-XXX`)
  { name: "OPENAI_KEY", regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  // GitHub PATs (classic + fine-grained)
  { name: "GITHUB_PAT", regex: /\bghp_[A-Za-z0-9]{36,}\b/g },
  { name: "GITHUB_FINE_GRAINED", regex: /\bgithub_pat_[A-Za-z0-9_]{82,}\b/g },
  // AWS access keys
  { name: "AWS_ACCESS_KEY", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  // Slack
  { name: "SLACK", regex: /\bxox[abprs]-[A-Za-z0-9-]{20,}\b/g },
  // Stripe live/test keys (sk_live_, pk_live_, sk_test_, etc.)
  { name: "STRIPE", regex: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
  // Stripe webhook signing secrets — `whsec_` prefix, no live/test mode
  { name: "STRIPE", regex: /\bwhsec_[A-Za-z0-9]{20,}\b/g },
  // Google API keys
  { name: "GOOGLE", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // JWTs (three base64 segments — bounded length to avoid ReDoS)
  {
    name: "JWT",
    regex: /\beyJ[A-Za-z0-9_-]{6,200}\.eyJ[A-Za-z0-9_-]{6,500}\.[A-Za-z0-9_-]{6,300}\b/g,
  },
  // Credentialed URLs (https://user:password@host)
  { name: "URL_CREDS", regex: /\bhttps?:\/\/[^\s:@]+:[^\s@]+@[^\s/]+/g },
];

export function redactSecrets(raw: string): string {
  let out = raw;
  for (const { name, regex } of SECRET_PATTERNS) {
    out = out.replace(regex, `[REDACTED_${name}]`);
  }
  return out;
}

// Plain-English description of the specific scenario this pin guards
// against. Templated from claim shape. Used by failure messages,
// CATCHES.md entries, and AI catch-celebration chat-hooks so users
// see a human-readable "what was caught" string, not a test-name
// jargon line. Pure function — browser-safe (templates + the landing
// demo can both import it).
export function badCaseForClaim(claim: Claim): string {
  switch (claim.template) {
    case "auth-required":
      return `an unauthenticated request to ${claim.route} returned 2xx instead of 401/403`;
    case "permission-required":
      return `a request without ${claim.role} role accessed ${claim.route} (role check removed: no-auth got 2xx, OR a wrong-role token got 2xx)`;
    case "tier-cap":
      return `a ${claim.tier}-tier user at the ${claim.cap}-${claim.resource} cap was able to perform the gated action on ${claim.route} (billing/quota enforcement removed — REVENUE LEAK)`;
    case "rate-limit":
      return `${claim.rate + 1} requests to ${claim.route} in 1 ${claim.window} produced zero rate-limited responses (limit removed or weakened)`;
    case "idempotent":
      return `replaying the same ${claim.idField} to ${claim.route} produced a different response on the second call (idempotency broken)`;
    case "returns-status": {
      const condition = claim.condition
        ? ` (${claim.condition})`
        : claim.field
          ? ` (missing ${claim.field})`
          : "";
      return `${claim.method} ${claim.route}${condition} returned a status other than ${claim.status} (validation removed or weakened)`;
    }
    case "cli-output-contains":
      return `running \`${claim.route}\` did not produce expected substring \`${claim.text}\` in stdout`;
    case "cli-exits-zero":
      return `running \`${claim.route}\` exited with non-zero status (command broken)`;
    case "cli-creates-file":
      return `running \`${claim.route}\` did not create ${claim.filePath} (side-effect lost)`;
    case "cli-json-shape":
      return `\`${claim.route}\` did not return valid JSON containing all required keys (\`${claim.keys.join("`, `")}\` — shape contract broken)`;
    case "cli-flag-supported":
      return `\`${claim.route} --help\` did not list \`${claim.flag}\` flag (option removed)`;
    case "library-returns":
      return `calling \`${claim.functionName}\` in \`${claim.modulePath}\` did not return the expected value (function shape changed)`;
    case "lockfile-integrity":
      return `\`${claim.lockfilePath}\` SHA-256 changed (lockfile was regenerated or hand-edited; transitive deps may have shifted)`;
    case "config-invariant":
      return `${claim.label} block was removed from \`${claim.configPath}\` (likely AI "cleanup" that dropped a load-bearing config)`;
    case "package-exports-exist":
      return `\`${claim.modulePath}\` no longer exports one of [${claim.exports.join(", ")}] — a public-API symbol was renamed, deleted, or relocated`;
    case "secret-not-public":
      return `a \`${claim.publicPrefix}\` env var with a secret-shaped suffix (${claim.secretMarkers.join(", ")}) was introduced — would leak a server secret into the client bundle`;
    case "url-literal-preserved":
      return `the URL literal \`${claim.urlLiteral}\` was removed or changed in \`${claim.filePath}\` (endpoint drift / typo regression)`;
    case "tsc-clean":
      return `\`tsc --noEmit\` exited non-zero (TypeScript build or type error introduced)`;
    case "module-export-stable":
      return `\`${claim.modulePath}\` no longer exports \`${claim.exportName}\` — consumers will fail at runtime / build`;
    case "react-route-registered":
      return `the route registration for \`${claim.routePath}\` was removed from \`${claim.routerFilePath}\` — page unreachable`;
    case "webhook-handler-exists":
      return `the ${claim.provider} webhook handler at \`${claim.filePath}\` no longer matches its captured signature — handler removed or shape changed`;
    case "import-path-resolves":
      return `\`${claim.sourceFilePath}\` imports \`${claim.importPath}\` but the module no longer resolves (renamed, deleted, or dep removed)`;
    case "changed-literal-preserved":
      return `\`${claim.filePath}\` no longer contains the fix's new value \`${claim.newValue}\` (${claim.shape}: the typo / drift / regression came back)`;
    case "form-submit-error-handling":
      return `the form in \`${claim.filePath}\` no longer wraps its submit handler in try/catch or .catch — async errors will surface as unhandled rejections`;
    case "page-renders":
      return `\`${claim.route}\` no longer renders (server returned a 500-class status, the body is missing/empty, or a React/Next/Vite error overlay leaked into the response)`;
    case "validation-rejects-bad":
      return `\`${claim.method} ${claim.route}\` accepted a request it should have rejected (malformed JSON or body missing a required field) — validation was removed or weakened`;
    case "happy-path-with-side-effect":
      return `\`${claim.method} ${claim.route}\` returned 2xx but didn't emit the X-Pinned-Side-Effect header — the endpoint may be a stub returning a happy status without actually performing the ${claim.sideEffectKind} to \`${claim.sideEffectTarget}\``;
    case "journey": {
      const summary = claim.steps.map((s) => `${s.method} ${s.route}`).join(" → ");
      return `journey \`${claim.label}\` regressed at some step in (${summary}) — multi-step session/state contract broken (e.g. signup OK but /me returns stale data; login OK but dashboard shows expired-session warning; checkout OK but order page missing items)`;
    }
  }
}

// Bug-fix phrase detection. Returns the FIRST matched phrase from the
// PR body if any are present (or null). Used by `pinned generate` to
// stamp bugFixOrigin=true on every new pin extracted from a PR that
// contains bug-fix vocabulary — those pins are disproportionately
// likely to catch real regressions later, so we order them first in
// PINS.md and give them louder celebrations on catch.
//
// Word-boundary regex avoids false positives like "fixture" / "prefix"
// / "racecondition" — the dictionary stays tight even at the cost of
// missing creative phrasings (we'd rather under-tag than over-tag).
const BUG_FIX_PHRASES: { phrase: string; regex: RegExp }[] = [
  { phrase: "fix", regex: /\b(?:fix(?:es|ed|ing)?)\b/i },
  { phrase: "regression", regex: /\bregressions?\b/i },
  { phrase: "no longer", regex: /\bno longer\b/i },
  { phrase: "bypass", regex: /\bbypass(?:es|ed|ing)?\b/i },
  { phrase: "prevent", regex: /\bprevent(?:s|ed|ing)?\b/i },
  { phrase: "race condition", regex: /\brace conditions?\b/i },
  { phrase: "edge case", regex: /\bedge cases?\b/i },
  { phrase: "should not", regex: /\bshould not\b/i },
  { phrase: "must not", regex: /\bmust not\b/i },
  // Round 2 — additional vocab from real-world AI-coded bug-fix PRs.
  // "resolves", "reverts", "restores" — strong fix-context signals
  // when used to describe the PR's intent.
  { phrase: "resolves", regex: /\bresolves?\b/i },
  { phrase: "reverts", regex: /\breverts?\b/i },
  { phrase: "restores", regex: /\brestores?\b/i },
  // "was broken" — describes a previously-broken state being fixed.
  { phrase: "was broken", regex: /\bwas broken\b/i },
  // "closes #N" — common in PRs that close a bug-tracker issue.
  { phrase: "closes #", regex: /\bcloses?\s+#\d+\b/i },
];

export function detectBugFixPhrase(prBody: string): string | null {
  for (const { phrase, regex } of BUG_FIX_PHRASES) {
    if (regex.test(prBody)) return phrase;
  }
  return null;
}

export function claimRoute(c: Claim): string | null {
  switch (c.template) {
    case "rate-limit":
    case "auth-required":
    case "permission-required":
    case "tier-cap":
    case "idempotent":
    case "returns-status":
    case "cli-output-contains":
    case "cli-exits-zero":
    case "cli-creates-file":
    case "cli-json-shape":
    case "cli-flag-supported":
      return c.route;
    case "library-returns":
    case "lockfile-integrity":
    case "config-invariant":
    case "package-exports-exist":
    case "secret-not-public":
    case "tsc-clean":
    case "module-export-stable":
    case "import-path-resolves":
      return null;
    case "url-literal-preserved":
      return c.urlLiteral;
    case "react-route-registered":
      return c.routePath;
    case "webhook-handler-exists":
      return c.filePath; // file is the load-bearing artifact, not a URL path
    case "changed-literal-preserved":
      return c.newValue;
    case "form-submit-error-handling":
      return c.filePath;
    case "page-renders":
      return c.route;
    case "validation-rejects-bad":
      return c.route;
    case "happy-path-with-side-effect":
      return c.route;
    case "journey":
      // Journeys span multiple routes; surface the first step's route
      // as the "primary" location (matches the human reading of the
      // journey: signup → dashboard ⇒ /signup is the entry point).
      return c.steps[0]?.route ?? null;
  }
}

// Stable filename slug for a claim — used by the generators and the
// retire flow so the two stay in sync. Includes a short hash of the
// FULL claim key so two rate-limit claims on the same route with
// different rates (or two idempotent claims with different id-fields)
// don't collide into a single filename.
export function claimSlug(claim: Claim): string {
  // For CLI claims `route` is the command (e.g. "pinned doctor"), not
  // a URL path — same slug logic still produces something readable
  // ("pinned-doctor") and the hash suffix disambiguates same-command
  // claims with different expected-output substrings. For library-returns
  // we slug from modulePath + functionName since there's no `route`.
  const routeSource =
    claim.template === "library-returns"
      ? `${claim.modulePath}-${claim.functionName.replace(/\(.*\)/, "")}`
      : claim.template === "lockfile-integrity"
        ? `lockfile-${claim.lockfilePath}-${claim.expectedSha256.slice(0, 12)}`
        : claim.template === "config-invariant"
          ? `config-${claim.configPath}-${claim.label}`
          : claim.template === "package-exports-exist"
            ? `exports-${claim.modulePath}`
            : claim.template === "secret-not-public"
              ? `secret-not-public-${claim.publicPrefix}`
              : claim.template === "url-literal-preserved"
                ? `url-${claim.filePath}-${claim.urlLiteral}`
                : claim.template === "tsc-clean"
                  ? `tsc-clean-${claim.tsconfigPath}`
                  : claim.template === "module-export-stable"
                    ? `export-${claim.modulePath}-${claim.exportName}`
                    : claim.template === "react-route-registered"
                      ? `route-${claim.routerFilePath}-${claim.routePath}`
                      : claim.template === "webhook-handler-exists"
                        ? `webhook-${claim.filePath}-${claim.provider}`
                        : claim.template === "import-path-resolves"
                          ? `import-${claim.sourceFilePath}-${claim.importPath}`
                          : claim.template === "changed-literal-preserved"
                            ? `changed-${claim.shape}-${claim.filePath}-${claim.newValue}`
                            : claim.template === "form-submit-error-handling"
                              ? `form-error-${claim.filePath}`
                              : claim.template === "journey"
                                ? `journey-${claim.label}-${claim.steps.map((s) => `${s.method}-${s.route}`).join("-")}`
                                : claim.route;
  const route = routeSource
    .replace(/^\//, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  // Suffix differentiates same-route claims that differ on
  // rate/window/idField. For auth-required (key has nothing beyond
  // route), the suffix is constant — that's fine, only one
  // auth-required pin per route is meaningful anyway.
  const key = claimKey(claim);
  const suffix = djb2Hash(key).toString(36).slice(0, 6);
  return `${claim.template}-${route}-${suffix}`;
}

// Lightweight non-crypto hash for filename disambiguation. We're not
// resisting attackers here — just collision-avoiding among the small
// set of claims a single repo will accumulate.
function djb2Hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (h * 33) ^ s.charCodeAt(i);
  }
  return h >>> 0; // unsigned
}

// Stable dedup key — used to merge regex + LLM extraction results
// without double-pinning the same claim. Order-independent.
export function claimKey(c: Claim): string {
  switch (c.template) {
    case "rate-limit":
      return `rate-limit:${c.route}:${c.rate}:${c.window}`;
    case "auth-required":
      return `auth-required:${c.route}`;
    case "permission-required":
      return `permission-required:${c.route}:${c.role}`;
    case "tier-cap":
      // Include resource — without it, "1 seat" and "1 project" on the
      // same route+tier+cap collapse to the same key, dropping one of
      // the two pins via dedupe. Resource IS a distinguishing dimension
      // semantically (Free tier might cap seats at 1 AND projects at 3,
      // both on the same /api/billing/checkout endpoint).
      return `tier-cap:${c.route}:${c.tier}:${c.cap}:${c.resource}`;
    case "idempotent":
      return `idempotent:${c.route}:${c.idField}`;
    case "returns-status":
      return `returns-status:${c.route}:${c.method}:${c.status}:${c.conditionKind ?? "none"}:${c.field ?? "none"}`;
    case "cli-output-contains":
      return `cli-output-contains:${c.route}:${c.text}`;
    case "cli-exits-zero":
      return `cli-exits-zero:${c.route}`;
    case "cli-creates-file":
      return `cli-creates-file:${c.route}:${c.filePath}`;
    case "cli-json-shape":
      return `cli-json-shape:${c.route}:${[...c.keys].sort().join(",")}`;
    case "cli-flag-supported":
      return `cli-flag-supported:${c.route}:${c.flag}`;
    case "library-returns":
      return `library-returns:${c.modulePath}:${c.functionName}:${JSON.stringify(c.expected)}`;
    case "lockfile-integrity":
      return `lockfile-integrity:${c.lockfilePath}:${c.expectedSha256.slice(0, 16)}`;
    case "config-invariant":
      // Hash the expected substring so two pins on the same config
      // file with different required content don't collapse.
      return `config-invariant:${c.configPath}:${c.label}`;
    case "package-exports-exist":
      // Same module + different export sets stay distinct (lets a
      // user pin core exports separately from utility exports).
      return `package-exports-exist:${c.modulePath}:${[...c.exports].sort().join(",")}`;
    case "secret-not-public":
      return `secret-not-public:${c.publicPrefix}:${[...c.secretMarkers].sort().join(",")}`;
    case "url-literal-preserved":
      return `url-literal-preserved:${c.filePath}:${c.urlLiteral}`;
    case "tsc-clean":
      return `tsc-clean:${c.tsconfigPath}`;
    case "module-export-stable":
      return `module-export-stable:${c.modulePath}:${c.exportName}`;
    case "react-route-registered":
      return `react-route-registered:${c.routerFilePath}:${c.routePath}`;
    case "webhook-handler-exists":
      return `webhook-handler-exists:${c.filePath}:${c.provider}`;
    case "import-path-resolves":
      return `import-path-resolves:${c.sourceFilePath}:${c.importPath}`;
    case "changed-literal-preserved":
      return `changed-literal-preserved:${c.shape}:${c.filePath}:${c.newValue}`;
    case "form-submit-error-handling":
      return `form-submit-error-handling:${c.filePath}`;
    case "page-renders":
      return `page-renders:${c.route}`;
    case "validation-rejects-bad":
      return `validation-rejects-bad:${c.route}:${[...c.requiredFields].sort().join(",")}`;
    case "happy-path-with-side-effect":
      return `happy-path-with-side-effect:${c.route}:${c.sideEffectTarget}`;
    case "journey": {
      // Dedup key: label + ordered step sequence. Two journey claims
      // with the same label but different steps are NOT duplicates;
      // two with the same steps but different labels collide here (by
      // design — the steps are the load-bearing identity).
      const stepKey = c.steps
        .map((s) => `${s.method}:${s.route}`)
        .join("|");
      return `journey:${c.label}:${stepKey}`;
    }
  }
}

// Merge multiple Claim[] sources (regex + LLM) into a single deduped
// list. Earlier-listed claims win when keys collide (regex first ⇒
// regex output is preferred over LLM output for the same key).
export function unionClaims(...sources: Claim[][]): Claim[] {
  const seen = new Set<string>();
  const out: Claim[] = [];
  for (const src of sources) {
    for (const c of src) {
      const key = claimKey(c);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}
