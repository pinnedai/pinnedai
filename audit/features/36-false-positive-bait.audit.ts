// FEATURE: detector must NOT emit pin suggestions for paths that look
// "risky" by substring but are actually test fixtures, docs, utility
// helpers, or placeholder shapes. Real false-positive bugs caught
// during the Quantasyte dogfood — every fixture below is a path we
// previously emitted junk pins for.
// SIGNAL:
//   (a) running scanDiffFull against the bait corpus returns ZERO
//       suggestions for every bait path.
//   (b) every emitted suggestion (across BOTH bait + happy-path
//       fixtures) round-trips back through parseClaims() — proves
//       the detector cannot emit a claim string that the parser
//       refuses, which would have caught the `<your-route>` bug.
// FALSIFIABILITY:
//   - POS-CONTROL: a known-real path (`app/api/admin/scans/route.ts`
//     adds + middleware.ts) — middleware.ts is a risk hint with empty
//     suggestedPin (filtered out), so only the real Next.js route
//     produces a suggestion. Asserts at least one suggestion exists
//     for the real path so we know the detector isn't broken-silent.
//   - NEG-BAIT (the meat of the audit): every fixture below must
//     produce ZERO suggestions.
//   - ROUND-TRIP: every emitted suggestion re-parses to the same
//     claim. If a future detector change emits a placeholder route,
//     the parser rejects it and this audit fails immediately.

import { describe, it, expect } from "vitest";
import {
  scanDiffFull,
  isTestPath,
  isAuthEndpoint,
  guessWebhookProvider,
} from "../../apps/cli/src/scanDiff.js";
import { parseClaims } from "../../apps/cli/src/claimParser.js";
import type { ChangedFile } from "../../apps/cli/src/scanDiff.js";

// Paths the test-path classifier alone is responsible for excluding.
// Listed separately from non-test bait below because the .md doc file
// is excluded by the file-extension check, not by isTestPath().
const testFileBait: { path: string; reason: string }[] = [
  {
    path: "tests/integration/stripe-webhook.spec.ts",
    reason: "spec file mentioning webhook is not a webhook handler",
  },
  {
    path: "tests/watch/webhook-replay.spec.ts",
    reason: "spec file mentioning webhook is not a webhook handler",
  },
  {
    path: "src/app/api/admin/scans/route.test.ts",
    reason: "vitest file in route dir is not a new route",
  },
  {
    path: "src/__tests__/webhook-handler.test.ts",
    reason: "test file in __tests__ dir is not a real handler",
  },
  {
    path: "cypress/integration/webhook-flow.cy.ts",
    reason: "cypress test is not a webhook handler",
  },
  {
    path: "e2e/auth-middleware.spec.ts",
    reason: "playwright e2e is not real middleware",
  },
  {
    path: "src/components/WebhookList.stories.tsx",
    reason: "storybook file is not a webhook handler",
  },
];

// Non-test bait: excluded by file-extension / route-shape rules but
// still must produce zero pin suggestions when fed through scanDiffFull.
// New entries added after sweeping dyad-apps — the webhook route
// guesser was producing nonsense routes like `/webhooks/lib`,
// `/webhooks/controllers`, `/webhooks/services`, `/webhooks/index`.
const nonTestBait: { path: string; reason: string }[] = [
  {
    path: "docs/webhook-design.md",
    reason: "documentation about webhooks is not a webhook handler",
  },
  {
    path: "lib/webhookDelivery.ts",
    reason: "utility module with 'webhook' in the filename is not an inbound handler",
  },
  {
    path: "apps/api/src/services/webhookService.ts",
    reason: "service-layer module — provider name unclear, can't form a real /webhooks/<provider> route",
  },
  {
    path: "apps/api/src/services/chatWebhookService.ts",
    reason: "service-layer module — generic path tokens can't be promoted to a provider name",
  },
  {
    path: "apps/api/src/controllers/webhook.ts",
    reason: "generic controller named webhook.ts — captured segment 'controllers' is a generic dir token",
  },
  {
    path: "apps/api/src/routes/webhook.ts",
    reason: "generic route file named webhook.ts — captured 'routes' is a generic dir token",
  },
  // Surfaced via the documenso OSS sweep:
  {
    path: "apps/remix/app/components/dialogs/webhook-create-dialog.tsx",
    reason: "React UI component (.tsx in /components/) is not a server webhook handler",
  },
  {
    path: "apps/remix/app/components/general/webhook-logs-sheet.tsx",
    reason: "React UI component (.tsx in /components/) is not a server webhook handler",
  },
  {
    path: "packages/lib/types/webhook-payload.ts",
    reason: "type definitions in /types/ are not handlers",
  },
  {
    path: "packages/lib/jobs/definitions/internal/execute-webhook.handler.ts",
    reason: "outbound dispatcher (execute-webhook) is not an inbound handler",
  },
  {
    path: "packages/lib/server-only/webhooks/assert-webhook-url.ts",
    reason: "utility module — captured 'only' is a generic denylisted token",
  },
  {
    path: "packages/lib/universal/webhook/to-friendly-webhook-event-name.ts",
    reason: "utility module — captured 'universal' is a generic denylisted token",
  },
  {
    path: "packages/trpc/server/webhook-router/find-webhook-calls.ts",
    reason: "tRPC procedure for fetching webhook logs, not handling inbound — 'find' is denylisted",
  },
  {
    path: "packages/lib/server-only/webhooks/trigger/handler.ts",
    reason: "outbound webhook dispatcher (trigger system), not inbound provider",
  },
  {
    path: "packages/lib/server-only/webhooks/trigger/schema.ts",
    reason: "schema for outbound trigger system",
  },
  // Surfaced via cal.com OSS sweep (NestJS architecture):
  {
    path: "apps/api/v2/src/modules/webhooks/decorators/get-webhook-decorator.ts",
    reason: "NestJS decorator is not a handler — 'decorators' denylisted",
  },
  {
    path: "apps/api/v2/src/modules/webhooks/guards/is-user-webhook-guard.ts",
    reason: "NestJS guard is not a handler — 'guards' denylisted",
  },
  {
    path: "apps/api/v2/src/modules/webhooks/inputs/webhook.input.ts",
    reason: "DTO input is not a handler — 'inputs' denylisted",
  },
  {
    path: "apps/api/v2/src/modules/webhooks/outputs/team-webhook.output.ts",
    reason: "DTO output is not a handler — 'outputs' denylisted",
  },
  {
    path: "apps/api/v2/src/modules/webhooks/pipes/WebhookInputPipe.ts",
    reason: "NestJS pipe is not a handler — 'pipes' denylisted",
  },
  // Surfaced via formbricks OSS sweep:
  {
    path: "apps/web/lib/utils/validate-webhook-url.ts",
    reason: "utility for validating webhook URLs, not a handler — 'url' denylisted",
  },
  {
    path: "apps/web/modules/integrations/webhooks/lib/webhook.ts",
    reason: "integration utility — 'integrations' denylisted",
  },
  {
    path: "packages/database/zod/webhooks.ts",
    reason: "zod schema is not a handler — 'zod' denylisted",
  },
];

// Routes that exist to AUTHENTICATE users — auth-required pins on
// these are wrong (the endpoint IS the auth surface).
const authEndpointPaths = [
  "app/api/auth/[...nextauth]/route.ts",
  "pages/api/auth/[...nextauth].ts",
  "app/api/auth/signin/route.ts",
  "pages/api/auth/callback/google.ts",
  "app/api/login/route.ts",
  "src/routes/signup.ts",
  "app/api/forgot-password/route.ts",
  "app/api/reset-password/route.ts",
];

const fpBaitPaths = [...testFileBait, ...nonTestBait];

const happyPathChanges: ChangedFile[] = [
  // A real public API route. This SHOULD produce a suggestion.
  { path: "app/api/admin/scans/route.ts", status: "added" },
];

describe("FEATURE-AUDIT: detector false-positive prevention", () => {
  it("HELPER: isTestPath correctly classifies test-file bait", () => {
    for (const bait of testFileBait) {
      expect(
        isTestPath(bait.path),
        `isTestPath should return true for ${bait.path} (${bait.reason})`
      ).toBe(true);
    }
  });

  it("HELPER: guessWebhookProvider returns null for paths with only generic tokens", () => {
    const noClearProvider = [
      "lib/webhookDelivery.ts",
      "apps/api/src/services/webhookService.ts",
      "apps/api/src/controllers/webhook.ts",
      "apps/api/src/routes/webhook.ts",
      "supabase/functions/x/webhook/index.ts", // captured token would be 'index'
      "src/webhook.ts",
    ];
    for (const p of noClearProvider) {
      expect(
        guessWebhookProvider(p),
        `guessWebhookProvider should return null for ${p}`
      ).toBe(null);
    }
  });

  it("HELPER: isAuthEndpoint classifies known auth endpoints correctly", () => {
    for (const p of authEndpointPaths) {
      expect(
        isAuthEndpoint(p),
        `isAuthEndpoint should return true for ${p}`
      ).toBe(true);
    }
  });

  it("HELPER: isAuthEndpoint does NOT misclassify protected routes as auth endpoints", () => {
    const protectedRoutes = [
      "app/api/admin/scans/route.ts",
      "app/api/users/route.ts",
      "src/routes/admin.ts",
      "pages/api/account/profile.ts",
    ];
    for (const p of protectedRoutes) {
      expect(
        isAuthEndpoint(p),
        `isAuthEndpoint should return false for ${p}`
      ).toBe(false);
    }
  });

  it("NEG-BAIT-AUTH: scanDiffFull emits ZERO suggestions for auth-endpoint paths", () => {
    for (const p of authEndpointPaths) {
      const result = scanDiffFull({
        changedFiles: [{ path: p, status: "added" }],
        prBodyClaims: [],
        existingPins: [],
      });
      expect(
        result.suggestions,
        `Auth endpoint "${p}" produced suggestions but shouldn't have: ${JSON.stringify(result.suggestions)}`
      ).toEqual([]);
    }
  });

  it("HELPER: guessWebhookProvider extracts real provider names", () => {
    const cases: { path: string; provider: string }[] = [
      { path: "src/webhooks/stripe.ts", provider: "stripe" },
      { path: "supabase/functions/retell-webhook/index.ts", provider: "retell" },
      { path: "api/twilio-webhook.ts", provider: "twilio" },
      { path: "src/webhooks/github/handler.ts", provider: "github" },
      { path: "apps/api/src/routes/shopify-webhook.ts", provider: "shopify" },
    ];
    for (const c of cases) {
      expect(
        guessWebhookProvider(c.path),
        `guessWebhookProvider should return "${c.provider}" for ${c.path}`
      ).toBe(c.provider);
    }
  });

  it("HELPER: isTestPath does NOT misclassify real source paths as tests", () => {
    const realSourcePaths = [
      "app/api/admin/scans/route.ts",
      "src/routes/users.ts",
      "src/handlers/webhook.ts",
      "src/controllers/auth.ts",
      "middleware.ts",
      "apps/api/src/services/webhookService.ts",
    ];
    for (const p of realSourcePaths) {
      expect(isTestPath(p), `isTestPath should return false for ${p}`).toBe(false);
    }
  });

  it("NEG-BAIT: scanDiffFull emits ZERO suggestions for every false-positive bait path", () => {
    for (const bait of fpBaitPaths) {
      const result = scanDiffFull({
        changedFiles: [{ path: bait.path, status: "added" }],
        prBodyClaims: [],
        existingPins: [],
      });
      expect(
        result.suggestions,
        `BAIT path "${bait.path}" produced suggestions but shouldn't have: ${JSON.stringify(result.suggestions)} (reason: ${bait.reason})`
      ).toEqual([]);
    }
  });

  it("POS-CONTROL: real public API route DOES produce a suggestion (proves detector isn't broken-silent)", () => {
    const result = scanDiffFull({
      changedFiles: happyPathChanges,
      prBodyClaims: [],
      existingPins: [],
    });
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(
      result.suggestions.some((s) =>
        s.suggestedPin.includes("/api/admin/scans")
      )
    ).toBe(true);
  });

  it("ROUND-TRIP: every emitted suggestion re-parses back to a claim with the same route", () => {
    // Run the detector on a mix of bait + real paths. Whatever it
    // EMITS must be parseable by parseClaims — this is the invariant
    // that would have caught the `<your-route>` placeholder bug.
    const mixedChanges: ChangedFile[] = [
      ...happyPathChanges,
      { path: "middleware.ts", status: "modified" },
      { path: "app/api/admin/audit-export/route.ts", status: "added" },
      ...fpBaitPaths.map((b) => ({
        path: b.path,
        status: "added" as const,
      })),
    ];
    const result = scanDiffFull({
      changedFiles: mixedChanges,
      prBodyClaims: [],
      existingPins: [],
    });

    expect(result.suggestions.length).toBeGreaterThan(0);

    for (const s of result.suggestions) {
      // 1. suggestedPin must not be empty (caught by scanDiffFull filter,
      //    but verify the contract from the consumer side).
      expect(
        s.suggestedPin,
        `suggestion has empty suggestedPin: ${JSON.stringify(s)}`
      ).not.toBe("");

      // 2. suggestedPin must not contain placeholder syntax. If a future
      //    detector tries to emit `<route>` / `<your-route>` / `{name}`,
      //    this catches it before the round-trip would.
      expect(
        s.suggestedPin,
        `suggestion contains placeholder: ${s.suggestedPin}`
      ).not.toMatch(/<[a-z-]+>|\{[a-z-]+\}/i);

      // 3. parseClaims() must re-parse the suggestion to a single claim.
      const reparsed = parseClaims(s.suggestedPin);
      expect(
        reparsed.length,
        `suggestion did not round-trip through parseClaims: "${s.suggestedPin}" → ${reparsed.length} claims`
      ).toBe(1);

      // 4. If the suggestion declared a route, the re-parsed claim's
      //    route must match. Catches subtle off-by-one errors where
      //    the detector emits a route the parser then normalizes
      //    differently (e.g. trailing slash, casing).
      if (s.route && "route" in reparsed[0]) {
        expect(
          (reparsed[0] as { route: string }).route,
          `route mismatch on round-trip: detector emitted "${s.route}" but parser returned "${(reparsed[0] as { route: string }).route}"`
        ).toBe(s.route);
      }
    }
  });
});
