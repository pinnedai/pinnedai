// PR-comment templates.
//
// Four shapes, picked at runtime based on what pinned found in this PR:
//
//   QUIET   — no new claims, no risky surfaces, no broken pins. One
//             calm line reinforcing total pin count.
//   ADDED   — new claims in description; tests generated.
//   RISKY   — scan-diff found unprotected risk surfaces.
//   BROKEN  — a previously-pinned claim FAILS on this PR (regression).
//
// Each is a markdown comment ≤ 8 lines with a <details> dropdown for
// extra info. Short by default, expandable on demand.

import type { Claim } from "./claimParser.js";
import { describeClaimForUser } from "./claimParser.js";
import type { Suggestion, Coverage } from "./scanDiff.js";

export type PrCommentInput = {
  totalActivePins: number;
  addedPins: Array<{ filename: string; claim: Claim }>;
  suggestions: Suggestion[];
  coverage: Coverage[];
  brokenPins: BrokenPin[];
  prNumber: number | null;
};

export type BrokenPin = {
  claimId: string;
  originalPrId: string;
  claimText: string;
  expected: string;
  actual: string;
  repairPrompt: string;
};

export function renderPrComment(input: PrCommentInput): string {
  if (input.brokenPins.length > 0) {
    return renderBroken(input);
  }
  if (input.addedPins.length > 0) {
    return renderAdded(input);
  }
  if (input.suggestions.length > 0) {
    return renderRisky(input);
  }
  return renderQuiet(input);
}

function renderQuiet(input: PrCommentInput): string {
  const n = input.totalActivePins;
  return `**◆ Pinned** · ${n} test${n === 1 ? "" : "s"} protect this repo · nothing new to add for this PR`;
}

function renderAdded(input: PrCommentInput): string {
  const added = input.addedPins.length;
  const total = input.totalActivePins;
  const lines: string[] = [];
  lines.push(
    `**◆ Pinned protected this PR** · ${added} added · ${total} total`
  );
  lines.push("");
  lines.push("<details><summary>What was pinned ▼</summary>");
  lines.push("");
  for (const a of input.addedPins) {
    const d = describeClaimForUser(a.claim);
    lines.push(`- **${d.title}**`);
    lines.push(`  ${d.promise}`);
    lines.push(`  <sub>Pin id: \`${a.filename.replace(/\.test\.ts$/, "")}\` · original claim: \`${a.claim.raw}\`</sub>`);
  }
  lines.push("");
  lines.push("Future AI edits that break these will fail CI with a back-reference to this PR.");
  lines.push("</details>");
  return lines.join("\n");
}

function renderRisky(input: PrCommentInput): string {
  const total = input.totalActivePins;
  const risky = input.suggestions.length;
  const lines: string[] = [];
  lines.push(
    `**◆ Pinned** · ${total} protected · ⚠ ${risky} risky change${risky === 1 ? "" : "s"} with no pin`
  );
  lines.push("");
  lines.push("<details><summary>Suggested pins ▼</summary>");
  lines.push("");
  for (const s of input.suggestions.slice(0, 5)) {
    lines.push(`- ${s.reason}`);
    lines.push(`  Add to your PR description: **${s.suggestedPin}**`);
    lines.push("");
  }
  if (input.suggestions.length > 5) {
    lines.push(`_…and ${input.suggestions.length - 5} more — run \`npx pinnedai scan\` locally for the full list._`);
  }
  lines.push("");
  lines.push("Or comment `@pinned add: <claim>` on this PR to pin a claim from here.");
  lines.push("</details>");
  return lines.join("\n");
}

function renderBroken(input: PrCommentInput): string {
  const lines: string[] = [];
  lines.push("## 🚨 Pinned caught a regression in this PR");
  lines.push("");

  if (input.brokenPins.length === 1) {
    const b = input.brokenPins[0];
    const prLink = b.originalPrId.match(/^pr-(\d+)$/)
      ? `**PR #${b.originalPrId.replace(/^pr-/, "")}**`
      : `\`${b.originalPrId}\``;
    lines.push(`This commit breaks the contract from ${prLink}:`);
    lines.push("");
    lines.push(`> ${b.claimText}`);
    lines.push("");
    lines.push(`- **Expected**: ${b.expected}`);
    lines.push(`- **Actual**: ${b.actual}`);
    lines.push("");
    lines.push("**Pinned just saved you from shipping a regression.** Fix the contract or retire the pin if it no longer applies.");
    lines.push("");
    lines.push("<details><summary>Paste-ready repair prompt for Claude Code / Cursor ▼</summary>");
    lines.push("");
    lines.push("```text");
    lines.push(b.repairPrompt);
    lines.push("```");
    lines.push("</details>");
  } else {
    lines.push(`This commit breaks **${input.brokenPins.length} contracts** from earlier PRs:`);
    lines.push("");
    for (const b of input.brokenPins) {
      const ref = b.originalPrId.match(/^pr-(\d+)$/)
        ? `#${b.originalPrId.replace(/^pr-/, "")}`
        : b.originalPrId;
      lines.push(`- **${ref}**: ${b.claimText}`);
    }
    lines.push("");
    lines.push("**Pinned just saved you from shipping these.** Run the failing tests locally to see each repair prompt.");
  }
  return lines.join("\n");
}
