// Template: stripe-event-handled (0.2.19+)
//
// Pins the dispatch layer of a Stripe webhook handler. The existing
// `webhook-handler-exists` pin catches "is signature-verify wired";
// this one catches the layer above — `switch (event.type) { case
// "X": ... }` routing each verified event to its handler. The bug it
// stops: AI silently typos `case "checkout.session.complete":`
// (one-letter rename), merges fallthrough arms that drop one, or
// wholesale deletes a case. Signature still verifies — paying
// customers go un-provisioned.
//
// Mode: STATIC FILE SCAN. The emitted test reads the captured
// handler file from disk at test-run time + asserts each protected
// event-name literal still appears in a `case "..."` arm. No HTTP,
// no fixtures, no preconditions. Reads `process.cwd()` so monorepo
// and root-level layouts both work.
//
// Confirmed signature across 3 dyad-apps (quantapact tier-webhook +
// badge-webhook + quantasyte billing.ts), each gating real money
// flows — the high-stakes, zero-FP class.

import type { StripeEventHandledClaim } from "../claimParser.js";
import { claimSlug } from "../claimParser.js";
import type { GenerateOpts, GeneratedTest } from "./rateLimit.js";

export function generateStripeEventHandledTest(
  claim: StripeEventHandledClaim,
  opts: GenerateOpts
): GeneratedTest {
  const slug = claimSlug(claim);
  const claimId = `${opts.prId}-${slug}`;
  const filename = `${claimId}.test.ts`;

  const eventsJson = JSON.stringify(claim.events);

  const content = `// ═══════════════════════════════════════════════════════════════
// ◆ Pinned by pinnedai — https://pinnedai.dev
// generated-by: pinnedai@${opts.pinnedVersion}
// ═══════════════════════════════════════════════════════════════
// Stripe webhook event dispatch: ${claim.filePath}
//
// Original claim:  ${JSON.stringify(claim.raw)}
// Source PR:       ${opts.prId}
// Template:        stripe-event-handled
//
// What this checks: reads \`${claim.filePath}\` from disk and asserts
// each of ${claim.events.length} protected Stripe event-name literal${claim.events.length === 1 ? "" : "s"}
// still appears in a \`case "..."\` arm of the file's switch block.
//
// Catches: AI silently typos one of these event names
// (\`checkout.session.complete\` vs \`checkout.session.completed\`),
// merges fallthrough arms that drop one, or wholesale deletes a case.
// The signature still verifies — Stripe webhook still 200s — paying
// customers never get provisioned.
//
// To retire:
//   pinned retire ${claimId} --reason="..."
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const HANDLER_FILE = ${JSON.stringify(claim.filePath)};
const PROTECTED_EVENTS: string[] = ${eventsJson};

describe(\`Stripe webhook in \${HANDLER_FILE} still dispatches all protected event types\`, () => {
  const fullPath = join(process.cwd(), HANDLER_FILE);
  const fileExists = existsSync(fullPath);

  it.skipIf(!fileExists)("file is present (otherwise this pin is moot)", () => {
    expect(fileExists, \`Webhook handler \${HANDLER_FILE} no longer exists. Either the file was moved (re-record the pin against the new path) or the webhook was removed entirely (retire the pin).\`).toBe(true);
  });

  for (const eventName of PROTECTED_EVENTS) {
    it.skipIf(!fileExists)("handles " + eventName, () => {
      const content = readFileSync(fullPath, "utf8");
      // Strip comments so a commented-out \`case "X":\` doesn't satisfy
      // the check. Same defensive normalization the detector uses.
      const stripped = content.replace(/\\/\\/.*$/gm, "").replace(/\\/\\*[\\s\\S]*?\\*\\//g, "");
      // Match \`case "<name>":\` with optional whitespace. The detector
      // captured this literal; the test asserts it survives.
      const escaped = eventName.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&");
      const caseRe = new RegExp("case\\\\s*['\\"\\\`]" + escaped + "['\\"\\\`]\\\\s*:");
      const found = caseRe.test(stripped);
      const failMsg =
        "Stripe event \\"" + eventName + "\\" is no longer dispatched in " + HANDLER_FILE + ". " +
        "Possible causes: a one-letter typo in the case literal (e.g. \\"checkout.session.complete\\" vs \\"checkout.session.completed\\"), " +
        "fallthrough arms merged dropping one, or the case was deleted. " +
        "The webhook signature still verifies — paying customers go un-provisioned. " +
        "If the change was intentional, retire the pin: pinned retire ${claimId} --reason=\\"...\\"";
      expect(found, failMsg).toBe(true);
    });
  }
});
`;

  return { filename, content, claimId };
}
