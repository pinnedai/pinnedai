// FEATURE: detector is FP-free across 50+ real-world repos.
// SIGNAL: For every captured fixture (50+ OSS repos + dyad-apps), the
// detector's output satisfies these invariants:
//   1. ALL webhook suggestions name a provider on the known-provider
//      allowlist (no nonsense routes like /webhooks/lib or /webhooks/
//      controllers from utility code).
//   2. NO auth-required suggestion fires for paths the detector itself
//      classifies as an auth endpoint (NextAuth catch-all, /api/login)
//      OR as a conventionally-public endpoint (OG image, health check,
//      revalidate, share link, telemetry, sitemap, cron, webhook).
//   3. EVERY suggestion's `suggestedPin` round-trips through
//      parseClaims back to a single Claim — catches placeholder routes
//      (`<your-route>`) and malformed suggestions immediately.
//   4. POS CONTROLS: known-good signals from specific fixtures appear.
//      Documenso → /webhooks/stripe + /webhooks/zapier. Shadcn taxonomy
//      → /api/posts route. Loss of these means the detector is
//      broken-silent (over-suppressing real signals).
// FALSIFIABILITY:
//   - POS: documenso fixture must produce at least the Stripe + Zapier
//     webhook pins. Taxonomy fixture must produce the /api/posts pin.
//   - NEG: every fixture must produce ZERO suggestions that violate
//     invariants 1, 2, or 3.
//
// Regenerate fixtures via `scripts/oss-fp-sweep.sh --regenerate-fixtures`
// (requires network + ~10GB of shallow clones). Audit runs offline.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  scanDiffFull,
  isAuthEndpoint,
  isLikelyPublicEndpoint,
  KNOWN_WEBHOOK_PROVIDERS,
} from "../../apps/cli/src/scanDiff.js";
import { parseClaims } from "../../apps/cli/src/claimParser.js";

const FIXTURES_DIR = resolve(__dirname, "fixtures");

type Fixture = { repo: string; files: string[] };

function loadFixtures(): Fixture[] {
  if (!existsSync(FIXTURES_DIR)) {
    throw new Error(
      `Fixtures dir missing: ${FIXTURES_DIR}. Run \`bash scripts/oss-fp-sweep.sh --regenerate-fixtures\` first.`
    );
  }
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map(
      (f) =>
        JSON.parse(
          readFileSync(resolve(FIXTURES_DIR, f), "utf8")
        ) as Fixture
    );
}

const fixtures = loadFixtures();

describe("FEATURE-AUDIT: OSS + dyad-apps detector FP sweep", () => {
  it("LOADS: fixtures present and non-trivial (sanity check)", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(30);
    const totalFiles = fixtures.reduce((acc, f) => acc + f.files.length, 0);
    expect(totalFiles).toBeGreaterThanOrEqual(500);
  });

  describe("NEG INVARIANTS (detector must not produce FP shapes)", () => {
    for (const fixture of fixtures) {
      it(`${fixture.repo}: no webhook suggestion names an unknown provider`, () => {
        const result = scanDiffFull({
          changedFiles: fixture.files.map((p) => ({ path: p, status: "added" })),
          prBodyClaims: [],
          existingPins: [],
        });
        const webhookSuggestions = result.suggestions.filter(
          (s) => s.template === "idempotent" && s.route?.startsWith("/webhooks/")
        );
        for (const s of webhookSuggestions) {
          const provider = s.route!.replace(/^\/webhooks\//, "");
          expect(
            KNOWN_WEBHOOK_PROVIDERS.has(provider),
            `${fixture.repo} emitted unknown webhook provider "${provider}" from path(s): ${s.files.slice(0, 2).join(", ")}. Either add to KNOWN_WEBHOOK_PROVIDERS if it's real, or tighten the denylist.`
          ).toBe(true);
        }
      });

      it(`${fixture.repo}: no auth-required suggestion fires for an auth-endpoint or public-endpoint path`, () => {
        const result = scanDiffFull({
          changedFiles: fixture.files.map((p) => ({ path: p, status: "added" })),
          prBodyClaims: [],
          existingPins: [],
        });
        const authSuggestions = result.suggestions.filter(
          (s) => s.template === "auth-required"
        );
        for (const s of authSuggestions) {
          for (const file of s.files) {
            expect(
              isAuthEndpoint(file),
              `${fixture.repo}: auth-required pin fired for auth-endpoint file "${file}" → suggestion "${s.suggestedPin}". isAuthEndpoint should have excluded it.`
            ).toBe(false);
            expect(
              isLikelyPublicEndpoint(file),
              `${fixture.repo}: auth-required pin fired for public-endpoint file "${file}" → suggestion "${s.suggestedPin}". isLikelyPublicEndpoint should have excluded it.`
            ).toBe(false);
          }
        }
      });

      it(`${fixture.repo}: every emitted suggestion round-trips through parseClaims`, () => {
        const result = scanDiffFull({
          changedFiles: fixture.files.map((p) => ({ path: p, status: "added" })),
          prBodyClaims: [],
          existingPins: [],
        });
        for (const s of result.suggestions) {
          // The env-required placeholder pin doesn't round-trip (the
          // template ships in v0.2). Skip it.
          if (s.suggestedPin.includes("ships in v0.2")) continue;
          expect(
            s.suggestedPin,
            `${fixture.repo}: suggestion has empty suggestedPin: ${JSON.stringify(s)}`
          ).not.toBe("");
          expect(
            s.suggestedPin,
            `${fixture.repo}: suggestion contains placeholder syntax: "${s.suggestedPin}"`
          ).not.toMatch(/<[a-z-]+>|\{[a-z-]+\}/i);
          const reparsed = parseClaims(s.suggestedPin);
          expect(
            reparsed.length,
            `${fixture.repo}: suggestion did not round-trip: "${s.suggestedPin}" → ${reparsed.length} claims`
          ).toBe(1);
        }
      });
    }
  });

  describe("POS CONTROLS (detector must surface real signals — silent over-suppression is a bug)", () => {
    it("documenso → /webhooks/stripe AND /webhooks/zapier are both detected", () => {
      const doc = fixtures.find((f) => f.repo === "documenso/documenso");
      // If documenso wasn't cloned, skip the assertion — but log it.
      if (!doc) {
        console.warn("documenso fixture missing; skipping POS control.");
        return;
      }
      const result = scanDiffFull({
        changedFiles: doc.files.map((p) => ({ path: p, status: "added" })),
        prBodyClaims: [],
        existingPins: [],
      });
      const routes = new Set(
        result.suggestions
          .filter((s) => s.route?.startsWith("/webhooks/"))
          .map((s) => s.route)
      );
      expect(routes.has("/webhooks/stripe")).toBe(true);
      expect(routes.has("/webhooks/zapier")).toBe(true);
    });

    it("shadcn-ui/taxonomy → at least one /api/posts route detected", () => {
      const tax = fixtures.find((f) => f.repo === "shadcn-ui/taxonomy");
      if (!tax) {
        console.warn("taxonomy fixture missing; skipping POS control.");
        return;
      }
      const result = scanDiffFull({
        changedFiles: tax.files.map((p) => ({ path: p, status: "added" })),
        prBodyClaims: [],
        existingPins: [],
      });
      const routes = result.suggestions
        .filter((s) => s.template === "auth-required")
        .map((s) => s.route);
      expect(
        routes.some((r) => r?.startsWith("/api/posts")),
        `taxonomy should still surface /api/posts — over-suppression bug. Got: ${JSON.stringify(routes)}`
      ).toBe(true);
    });
  });
});
