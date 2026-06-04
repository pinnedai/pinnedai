// Template: page-accessibility (0.2.21+ BETA)
//
// Closes the visual/usability blind spot socialideagen dogfood
// exposed: page-renders pins go GREEN on white-on-white text
// because the page DOES render (no crash, body has content), it's
// just unreadable. This template rides the same browser-beta path
// as interaction-baseline (opt-in Playwright install) and runs
// axe-core's color-contrast rules against the rendered page.
//
// Beta posture (non-negotiable, baked into the emitted test):
//   • WARN, never block — frontend a11y violations don't fail CI.
//   • Quarantine — sets PINNED_CATCH_CONFIDENCE=review so catches
//     don't inflate the GA "regressions caught" metric.
//   • Attach to running dev server (PREVIEW_URL), never auto-boot.
//   • Label everything beta — emitted output prefixes 🛟 BETA.
//
// Axe-core injection: loaded via CDN <script> tag at test time
// rather than as an npm dep. Keeps Pinned dep-free, keeps the
// customer's package.json clean. Uses jsdelivr.net (CDN of npm) —
// same origin pattern Playwright traces / test-doubles use.

import type { PageAccessibilityClaim } from "../claimParser.js";
import { claimSlug } from "../claimParser.js";
import type { GenerateOpts, GeneratedTest } from "./rateLimit.js";

const AXE_CDN_URL = "https://cdn.jsdelivr.net/npm/axe-core@4.10.0/axe.min.js";

export function generatePageAccessibilityTest(
  claim: PageAccessibilityClaim,
  opts: GenerateOpts
): GeneratedTest {
  const slug = claimSlug(claim);
  const claimId = `${opts.prId}-${slug}`;
  const filename = `${claimId}.test.ts`;

  const rulesJson = JSON.stringify(claim.rules.length > 0 ? claim.rules : ["color-contrast"]);

  const content = `// ═══════════════════════════════════════════════════════════════
// ◆ Pinned by pinnedai — https://pinnedai.dev
// generated-by: pinnedai@${opts.pinnedVersion}
// ═══════════════════════════════════════════════════════════════
// 🛟 BETA — page-accessibility pin
//
// Original claim:  ${JSON.stringify(claim.raw)}
// Source PR:       ${opts.prId}
// Template:        page-accessibility (BETA, opt-in)
//
// What this checks: renders \`${claim.page}\` via Playwright,
// injects axe-core, runs the configured a11y rules (default:
// color-contrast). WARN-only on violations — frontend a11y
// regressions don't fail CI, but they DO surface in the catches
// log with confidence:"review" so you see them.
//
// The specific bug class this stops: white-on-white text /
// effectively-invisible labels / contrast-below-WCAG-AA. page-
// renders pins stay GREEN on these (the page DID render), so this
// is the only template that catches the "looks broken but doesn't
// crash" class.
//
// Beta catches tagged confidence:"review" via PINNED_CATCH_CONFIDENCE,
// so they DON'T inflate the GA "regressions caught" metric.
//
// To retire:
//   pinned retire ${claimId} --reason="..."
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll } from "vitest";

const PREVIEW_URL = process.env.PREVIEW_URL;
const ROUTE = ${JSON.stringify(claim.page)};
const RULES: string[] = ${rulesJson};
const TEST_FILENAME = ${JSON.stringify(filename)};

// Beta guardrail: catches are confidence:"review" so they don't
// inflate the GA metric.
process.env.PINNED_CATCH_CONFIDENCE = "review";

describe("🛟 BETA — page-accessibility " + ROUTE, () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let chromium: any = null;
  let installError: string | null = null;

  beforeAll(async () => {
    try {
      // Dynamic import so the test file PARSES even when Playwright
      // isn't installed yet. The test will skip with a clear message.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const playwright = (await import("@playwright/test")) as any;
      chromium = playwright.chromium;
    } catch {
      installError = "Playwright not installed. Run \\\`pinned add-browser\\\` to opt in.";
    }
  });

  const previewMissing = !PREVIEW_URL;
  // 30s timeout — browser launch + page.goto + axe injection + axe.run
  // routinely takes 5-15s on a cold start. Vitest's 5s default would
  // false-fail this every time on a real CI machine.
  it.skipIf(previewMissing)("page passes axe-core a11y rules (warn-only on violations)", async () => {
    if (installError) {
      console.warn("🛟 (BETA) " + installError);
      return;
    }
    if (!chromium) return;

    const browser = await chromium.launch();
    try {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const targetUrl = PREVIEW_URL!.replace(/\\/$/, "") + ROUTE;
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 15000 });

      // Inject axe-core. The CDN URL is pinned to a specific version
      // so a future axe-core release that changes rule behavior doesn't
      // silently shift the pin from GREEN to RED. Update via
      // \`pinned regenerate <pin>\` when intentionally bumping.
      await page.addScriptTag({ url: ${JSON.stringify(AXE_CDN_URL)} });

      // Run the configured rules. We pass {runOnly} to constrain to
      // just the rules we care about (avoids the noisy region/landmark
      // findings that aren't actionable from a Pinned pin).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const results: any = await page.evaluate((rules: string[]) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (window as any).axe.run(document, {
          runOnly: { type: "rule", values: rules },
        });
      }, RULES);

      const violations: Array<{ id: string; help: string; nodes: Array<{ target?: string[]; html?: string }> }> = results?.violations ?? [];
      if (violations.length === 0) return; // green, silent

      // WARN-only — beta. Emit a structured warning so the catches log
      // surfaces the issue without failing the suite. Per locked
      // roadmap: beta catches tagged confidence:"review" don't
      // inflate the GA metric.
      const lines: string[] = [
        "",
        "🛟 (BETA) page-accessibility VIOLATIONS on " + ROUTE,
        "  Pin:       " + TEST_FILENAME,
        "  Route:     " + ROUTE,
        "  Rules:     " + RULES.join(", "),
        "",
      ];
      for (const v of violations.slice(0, 5)) {
        lines.push("  · " + v.id + " — " + v.help + " (" + v.nodes.length + " node" + (v.nodes.length === 1 ? "" : "s") + ")");
        for (const n of v.nodes.slice(0, 3)) {
          const selector = (n.target ?? []).join(" > ");
          const snippet = (n.html ?? "").replace(/\\s+/g, " ").slice(0, 100);
          lines.push("      " + selector + (snippet ? "  →  " + snippet : ""));
        }
        if (v.nodes.length > 3) lines.push("      …and " + (v.nodes.length - 3) + " more nodes");
      }
      if (violations.length > 5) lines.push("  …and " + (violations.length - 5) + " more rule violations");
      lines.push("");
      lines.push("  This is a warn-only beta signal. If intentional (e.g. design-system decision),");
      lines.push("  retire the pin: pinned retire ${claimId} --reason=\\"...\\"");
      lines.push("");
      console.warn(lines.join("\\n"));
      // Intentionally NOT throwing — beta a11y violations don't fail CI.
    } finally {
      await browser.close();
    }
  }, 30_000);
});
`;

  return { filename, content, claimId };
}
