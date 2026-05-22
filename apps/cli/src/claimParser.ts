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
};

export type AuthRequiredClaim = {
  template: "auth-required";
  route: string;
  raw: string;
};

export type IdempotentClaim = {
  template: "idempotent";
  route: string;
  idField: string;
  raw: string;
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
  | CliFlagSupportedClaim
  | LibraryReturnsClaim;

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

  return claims;
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
    case "cli-flag-supported":
      return `\`${claim.route} --help\` did not list \`${claim.flag}\` flag (option removed)`;
    case "library-returns":
      return `calling \`${claim.functionName}\` in \`${claim.modulePath}\` did not return the expected value (function shape changed)`;
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
    case "cli-flag-supported":
      return c.route;
    case "library-returns":
      return null;
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
    case "cli-flag-supported":
      return `cli-flag-supported:${c.route}:${c.flag}`;
    case "library-returns":
      return `library-returns:${c.modulePath}:${c.functionName}:${JSON.stringify(c.expected)}`;
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
