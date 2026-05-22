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
  template: "auth-required" | "rate-limit" | "idempotent" | "env-required";
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

// Order matters — more specific rules first.
const RULES: RiskRule[] = [
  // Next.js App Router: new route file
  {
    id: "next-app-route-added",
    match: (f) =>
      f.status === "added" &&
      /^(?:src\/)?app\/api\/.+\/route\.(?:ts|tsx|js|jsx)$/.test(f.path) &&
      !isTestPath(f.path) &&
      !isAuthEndpoint(f.path) &&
      !isLikelyPublicEndpoint(f.path),
    build: (f) => {
      const route = "/api/" + f.path
        .replace(/^(?:src\/)?app\/api\//, "")
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
      /^(?:src\/)?pages\/api\/.+\.(?:ts|tsx|js|jsx)$/.test(f.path) &&
      !isTestPath(f.path) &&
      !isAuthEndpoint(f.path) &&
      !isLikelyPublicEndpoint(f.path),
    build: (f) => {
      const route = "/api/" + f.path
        .replace(/^(?:src\/)?pages\/api\//, "")
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
      /^(?:src\/)?routes\/.+\.(?:ts|tsx|js|jsx)$/.test(f.path) &&
      !isTestPath(f.path) &&
      !isAuthEndpoint(f.path) &&
      !isLikelyPublicEndpoint(f.path),
    build: (f) => {
      const name = f.path
        .replace(/^(?:src\/)?routes\//, "")
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
      /^(?:src\/)?(?:handlers|controllers|api)\/.+\.(?:ts|js)$/.test(f.path) &&
      !/webhook/i.test(f.path) &&
      !isTestPath(f.path) &&
      !isAuthEndpoint(f.path) &&
      !isLikelyPublicEndpoint(f.path),
    build: (f) => {
      const name = f.path
        .replace(/^(?:src\/)?(?:handlers|controllers|api)\//, "")
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
function deriveRouteFromPath(path: string): string | null {
  let m = /^(?:src\/)?app\/api\/(.+)\/route\.(?:ts|tsx|js|jsx)$/.exec(path);
  if (m) return "/api/" + m[1];
  m = /^(?:src\/)?pages\/api\/(.+)\.(?:ts|tsx|js|jsx)$/.exec(path);
  if (m) return "/api/" + m[1];
  m = /^(?:src\/)?routes\/(.+)\.(?:ts|tsx|js|jsx)$/.exec(path);
  if (m) return "/api/" + m[1].replace(/\/index$/, "");
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
