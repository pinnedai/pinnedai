// Template: cron-handler (0.2.19+)
//
// Pins a Vercel or GitHub Actions cron declaration. Cron handlers
// fire WITHOUT a user in the loop — if auth is dropped, the schedule
// silently drifts, or the handler file is renamed, NOTHING in normal
// e2e testing catches it. The cron just stops running, sometimes
// indefinitely.
//
// Two sources:
//   - Vercel: `vercel.json` with `crons[].path` + `crons[].schedule`
//   - GH Actions: `.github/workflows/*.yml` with `on.schedule[].cron`
//
// Pin asserts:
//   1. The declaration file exists (vercel.json / workflow yaml)
//   2. The cron entry with the captured schedule string is still
//      present
//   3. For Vercel only: the resolved handler file (api/cron/X.ts)
//      still exists

import type { CronHandlerClaim } from "../claimParser.js";
import { claimSlug } from "../claimParser.js";
import type { GenerateOpts, GeneratedTest } from "./rateLimit.js";

export function generateCronHandlerTest(
  claim: CronHandlerClaim,
  opts: GenerateOpts
): GeneratedTest {
  const slug = claimSlug(claim);
  const claimId = `${opts.prId}-${slug}`;
  const filename = `${claimId}.test.ts`;

  const content = `// ═══════════════════════════════════════════════════════════════
// ◆ Pinned by pinnedai — https://pinnedai.dev
// generated-by: pinnedai@${opts.pinnedVersion}
// ═══════════════════════════════════════════════════════════════
// Cron handler: ${claim.identifier}
// Source:       ${claim.source}
// Schedule:     ${claim.schedule}
${claim.handlerFile ? `// Handler:      ${claim.handlerFile}\n` : ""}//
// Original claim:  ${JSON.stringify(claim.raw)}
// Source PR:       ${opts.prId}
// Template:        cron-handler
//
// What this checks:
//   1. \`${claim.declarationFile}\` still exists
//   2. The schedule string \`${claim.schedule}\` still appears in it
//   3. ${claim.handlerFile ? `\`${claim.handlerFile}\` still exists` : "(no handler-file check — GH Actions workflows are self-contained)"}
//
// Catches: AI silently changes the cron schedule (\`0 4 * * *\` →
// \`0 4 * * 0\` — runs once a week instead of daily), or renames /
// deletes the handler file (Vercel cron silently stops firing).
// No user-in-loop = silent SLA break.
//
// To retire:
//   pinned retire ${claimId} --reason="..."
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DECLARATION_FILE = ${JSON.stringify(claim.declarationFile)};
const SCHEDULE = ${JSON.stringify(claim.schedule)};
const IDENTIFIER = ${JSON.stringify(claim.identifier)};
const HANDLER_FILE: string | null = ${claim.handlerFile ? JSON.stringify(claim.handlerFile) : "null"};
const SOURCE: "vercel" | "github-actions" = ${JSON.stringify(claim.source)};

describe(\`Cron \${IDENTIFIER} still runs on \${SCHEDULE}\`, () => {
  const declPath = join(process.cwd(), DECLARATION_FILE);
  const declExists = existsSync(declPath);

  it.skipIf(!declExists)("declaration file is present", () => {
    expect(declExists, \`Cron declaration \${DECLARATION_FILE} no longer exists. If the cron was moved or deleted intentionally, retire the pin.\`).toBe(true);
  });

  it.skipIf(!declExists)(\`schedule "\${SCHEDULE}" is preserved\`, () => {
    const content = readFileSync(declPath, "utf8");
    // For Vercel: schedule appears in JSON. For GH Actions: schedule
    // appears in YAML as \`cron: "<schedule>"\`. Both match the same
    // string-literal scan.
    const escaped = SCHEDULE.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&");
    const scheduleRe = new RegExp("['\\"\\\`]" + escaped + "['\\"\\\`]");
    const found = scheduleRe.test(content);
    const failMsg =
      "Cron schedule \\"" + SCHEDULE + "\\" no longer appears in " + DECLARATION_FILE + ". " +
      "AI may have silently changed the schedule (e.g. \\"0 4 * * *\\" -> \\"0 4 * * 0\\" runs once a week instead of daily — same shape, very different behavior). " +
      "If intentional, retire the pin: pinned retire ${claimId} --reason=\\"...\\"";
    expect(found, failMsg).toBe(true);
  });

  if (SOURCE === "vercel") {
    // Vercel-only: confirm the cron path is still declared (not just
    // any matching schedule string elsewhere in the file).
    it.skipIf(!declExists)("cron path is still declared", () => {
      const content = readFileSync(declPath, "utf8");
      try {
        const parsed = JSON.parse(content);
        const crons: Array<{ path?: unknown; schedule?: unknown }> = Array.isArray(parsed?.crons) ? parsed.crons : [];
        const found = crons.some((c) => c.path === IDENTIFIER && c.schedule === SCHEDULE);
        const failMsg =
          "Vercel cron path \\"" + IDENTIFIER + "\\" with schedule \\"" + SCHEDULE + "\\" no longer present in " + DECLARATION_FILE + ". " +
          "AI may have renamed the path or removed the entry.";
        expect(found, failMsg).toBe(true);
      } catch (e) {
        throw new Error("Failed to parse " + DECLARATION_FILE + " as JSON: " + (e as Error).message);
      }
    });
  }

  it.skipIf(!declExists || !HANDLER_FILE)("handler file still exists", () => {
    if (!HANDLER_FILE) return;
    const handlerPath = join(process.cwd(), HANDLER_FILE);
    const failMsg =
      "Vercel cron handler file " + HANDLER_FILE + " no longer exists. " +
      "The cron schedule may still appear in vercel.json, but the handler file was renamed or deleted — Vercel will silently stop firing the cron. " +
      "If intentional, retire the pin and re-pin against the new path: pinned retire ${claimId} --reason=\\"...\\"";
    expect(existsSync(handlerPath), failMsg).toBe(true);
  });
});
`;

  return { filename, content, claimId };
}
