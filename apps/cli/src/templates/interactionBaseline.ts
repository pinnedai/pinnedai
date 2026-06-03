// Template: interaction-baseline (0.2.16+ BETA)
//
// Per locked [[full-stack-roadmap-2026-06-03]]: cover frontend
// interaction regressions (the carousel "arrows do nothing" class)
// by WRAPPING Playwright — never building a browser engine. Pinned
// stays the generation+guard+catch layer; Playwright is a runtime
// adapter alongside vitest.
//
// Mode: RECORD-BASELINE. Capture the effect once ("Next scrolled
// the track −348px"), alert if it changes/disappears. Don't try
// to infer the expected effect from source — that's the LLM/paid
// mode planned for later.
//
// Beta guardrails (non-negotiable, baked into the emitted test):
//   • WARN, never block — assertions log warnings instead of failing
//     so frontend flake doesn't kill CI.
//   • Quarantine — sets PINNED_CATCH_CONFIDENCE=review for the test
//     env so beta catches don't inflate the GA "regressions caught"
//     metric. Already-shipped 0.2.15 metric quarantine handles the
//     downstream filtering.
//   • Attach to running dev server, never auto-boot — same scoped
//     probe the backend pins use.
//   • Label everything beta — the emitted test prefixes output with
//     "🛟 (BETA)" so users know what tier they're seeing.
//
// Recording flow:
//   pinned record-interaction --page=/ --selector="[aria-label=Next]" \
//     --action=click --observe=scroll-position
//   → opens a browser, runs the action once, prints the observed
//     baseline, prompts to pin it.

import type { InteractionBaselineClaim } from "../claimParser.js";
import { claimSlug } from "../claimParser.js";
import type { GenerateOpts, GeneratedTest } from "./rateLimit.js";

export function generateInteractionBaselineTest(
  claim: InteractionBaselineClaim,
  opts: GenerateOpts
): GeneratedTest {
  const slug = claimSlug(claim);
  const claimId = `${opts.prId}-${slug}`;
  const filename = `${claimId}.test.ts`;

  const observeJson = JSON.stringify(claim.observe);
  const baselineJson = JSON.stringify(claim.baseline ?? null);

  const content = `// ═══════════════════════════════════════════════════════════════
// ◆ Pinned by pinnedai — https://pinnedai.dev
// ═══════════════════════════════════════════════════════════════
// 🛟 BETA — interaction baseline pin
//
// Original claim:  ${JSON.stringify(claim.raw)}
// Source PR:       ${opts.prId}
// Template:        interaction-baseline (BETA, opt-in)
//
// What this checks: renders \`${claim.page}\`, performs ${claim.action} on
// \`${claim.selector}\`, observes the configured dimension, compares
// against the recorded baseline. WARN-only on mismatch (frontend
// flake is real — beta does not gate merges).
//
// Catches are tagged confidence:"review" via PINNED_CATCH_CONFIDENCE,
// so beta failures DON'T inflate the GA "regressions caught" metric.
//
// To re-record the baseline after an intentional change:
//   pinned record-interaction --page=${claim.page} --selector="${claim.selector}" --action=${claim.action} --observe=${claim.observe.kind}
//
// To retire:
//   pinned retire ${claimId} --reason="..."
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll } from "vitest";

const PREVIEW_URL = process.env.PREVIEW_URL;
const ROUTE = ${JSON.stringify(claim.page)};
const SELECTOR = ${JSON.stringify(claim.selector)};
const ACTION = ${JSON.stringify(claim.action)};
const ACTION_ARGS = ${JSON.stringify(claim.actionArgs ?? null)};
const OBSERVE = ${observeJson};
const BASELINE = ${baselineJson};
const TEST_FILENAME = ${JSON.stringify(filename)};

// Beta guardrail: tag catches as confidence:"review" so they don't
// inflate the GA metric. Set BEFORE pinned test sees the test fail.
// (See [[full-stack-roadmap-2026-06-03]] for the quarantine rationale.)
process.env.PINNED_CATCH_CONFIDENCE = "review";

describe("🛟 BETA — interaction-baseline " + ACTION + " on " + SELECTOR + " @ " + ROUTE, () => {
  let chromium: typeof import("@playwright/test").chromium | null = null;
  let installError: string | null = null;

  beforeAll(async () => {
    try {
      // Dynamic import so the test file PARSES even when Playwright
      // isn't installed yet. The test will skip with a clear message.
      const playwright = await import("@playwright/test");
      chromium = playwright.chromium;
    } catch (e) {
      installError = "Playwright not installed. Run \`pinned add-browser\` to opt in.";
    }
  });

  const previewMissing = !PREVIEW_URL;
  it.skipIf(previewMissing)("interaction matches baseline (warn-only on drift)", async () => {
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

      // Perform the action.
      const el = page.locator(SELECTOR);
      try {
        await el.waitFor({ state: "visible", timeout: 5000 });
      } catch {
        console.warn("🛟 (BETA) selector " + SELECTOR + " not visible — element may have moved/renamed");
        return;
      }

      if (ACTION === "click") {
        await el.click();
      } else if (ACTION === "scroll") {
        const px = ACTION_ARGS ? parseInt(ACTION_ARGS, 10) : 100;
        await el.evaluate((node, dx) => { (node as HTMLElement).scrollBy(0, dx); }, px);
      } else if (ACTION === "type") {
        await el.fill(ACTION_ARGS ?? "");
      } else if (ACTION === "press-key") {
        await page.keyboard.press(ACTION_ARGS ?? "Enter");
      }

      // Settle: small wait to let CSS transitions / state updates land.
      await page.waitForTimeout(250);

      // Observe.
      let observed: string = "";
      if (OBSERVE.kind === "scroll-position") {
        const target = OBSERVE.element
          ? page.locator(OBSERVE.element)
          : null;
        if (target) {
          const pos = await target.evaluate((node) => ({
            top: (node as HTMLElement).scrollTop,
            left: (node as HTMLElement).scrollLeft,
          }));
          observed = "top=" + pos.top + ",left=" + pos.left;
        } else {
          const pos = await page.evaluate(() => ({ top: window.scrollY, left: window.scrollX }));
          observed = "top=" + pos.top + ",left=" + pos.left;
        }
      } else if (OBSERVE.kind === "dom-text") {
        const el = page.locator(OBSERVE.element);
        try { observed = (await el.first().textContent({ timeout: 2000 })) ?? ""; } catch { observed = "(missing)"; }
      } else if (OBSERVE.kind === "url") {
        observed = page.url();
      } else if (OBSERVE.kind === "element-count") {
        observed = String(await page.locator(OBSERVE.element).count());
      }

      // Compare.
      if (BASELINE === null) {
        console.warn("🛟 (BETA) no baseline recorded yet for this pin. Observed: " + observed);
        console.warn("           Run: pinned record-interaction --page=" + ROUTE + " --selector=" + JSON.stringify(SELECTOR) + " --action=" + ACTION);
        return;
      }
      if (observed !== BASELINE) {
        console.warn(
          [
            "",
            "🛟 (BETA) interaction baseline DRIFTED",
            "  Pin:       " + TEST_FILENAME,
            "  Route:     " + ROUTE,
            "  Selector:  " + SELECTOR,
            "  Action:    " + ACTION,
            "  Baseline:  " + BASELINE,
            "  Observed:  " + observed,
            "",
            "  This is a warn-only beta signal. If the change is intentional, re-record:",
            "    pinned record-interaction --page=" + ROUTE + " --selector=" + JSON.stringify(SELECTOR) + " --action=" + ACTION,
            "",
          ].join("\\n")
        );
        // Intentionally NOT throwing — beta interactions don't fail CI.
        return;
      }
      // Match → silent green.
    } finally {
      await browser.close();
    }
  });
});
`;

  return { filename, content, claimId };
}
