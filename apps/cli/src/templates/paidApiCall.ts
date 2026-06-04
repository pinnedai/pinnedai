// Template: paid-api-call (0.2.19+)
//
// Headline template — Pinned guards every paid API call in your
// backend, not just the ones in Next.js Server Actions. Pin reads
// the source file at test time + asserts (a) the call expression
// still appears, (b) the model string literal still appears (when
// captured), (c) a max_tokens / max_completion_tokens field is
// still present (when captured at pin time).
//
// The bug classes it stops:
//   1. AI silently swaps the model (`claude-opus` → `claude-haiku`,
//      quality regression nobody notices until users complain).
//   2. AI removes `max_tokens` / `max_completion_tokens` (unbounded
//      spend regression — single bad payload = $50 in API costs).
//   3. AI silently removes the call entirely.
//
// Entry-point-agnostic by design. The detector walks ALL .ts/.js
// files; this template just asserts what was found.

import type { PaidApiCallClaim } from "../claimParser.js";
import { claimSlug } from "../claimParser.js";
import type { GenerateOpts, GeneratedTest } from "./rateLimit.js";

export function generatePaidApiCallTest(
  claim: PaidApiCallClaim,
  opts: GenerateOpts
): GeneratedTest {
  const slug = claimSlug(claim);
  const claimId = `${opts.prId}-${slug}`;
  const filename = `${claimId}.test.ts`;

  const callExprLiteral = JSON.stringify(claim.callExpr);
  const modelLiteral = claim.modelString ? JSON.stringify(claim.modelString) : "null";
  const hasMaxTokensLiteral = claim.hasMaxTokens === true ? "true" : "false";

  const content = `// ═══════════════════════════════════════════════════════════════
// ◆ Pinned by pinnedai — https://pinnedai.dev
// generated-by: pinnedai@${opts.pinnedVersion}
// ═══════════════════════════════════════════════════════════════
// Paid API call: ${claim.callExpr}
// File:          ${claim.filePath}
// Provider:      ${claim.provider}
//
// Original claim:  ${JSON.stringify(claim.raw)}
// Source PR:       ${opts.prId}
// Template:        paid-api-call
//
// What this checks: reads \`${claim.filePath}\` from disk and asserts
//   1. \`${claim.callExpr}(...)\` still appears
${claim.modelString ? `//   2. model: \`${claim.modelString}\` still appears in the options\n` : ""}${claim.hasMaxTokens ? `//   3. \`max_tokens\` or \`max_completion_tokens\` still present (unbounded spend defense)\n` : ""}//
// Catches: AI silently swaps the model (\`claude-opus\` → \`claude-haiku\`),
// removes \`max_tokens\` (unbounded cost), or deletes the call entirely.
//
// To retire:
//   pinned retire ${claimId} --reason="..."
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const SOURCE_FILE = ${JSON.stringify(claim.filePath)};
const CALL_EXPR = ${callExprLiteral};
const MODEL_STRING: string | null = ${modelLiteral};
const REQUIRE_MAX_TOKENS = ${hasMaxTokensLiteral};

describe(\`Paid API call \${CALL_EXPR} in \${SOURCE_FILE} still present\`, () => {
  const fullPath = join(process.cwd(), SOURCE_FILE);
  const fileExists = existsSync(fullPath);

  it.skipIf(!fileExists)("file is present", () => {
    expect(fileExists, \`Source file \${SOURCE_FILE} no longer exists. If the file moved, re-record the pin against the new path. If the paid-API call was removed entirely, retire the pin.\`).toBe(true);
  });

  it.skipIf(!fileExists)(\`call expression "\${CALL_EXPR}" still appears\`, () => {
    const content = readFileSync(fullPath, "utf8");
    // Strip comments so a commented-out call doesn't satisfy the check.
    const stripped = content.replace(/\\/\\/.*$/gm, "").replace(/\\/\\*[\\s\\S]*?\\*\\//g, "");
    // Build a flexible regex that tolerates whitespace differences
    // ("anthropic.messages.create" matches "anthropic .messages .create" too).
    const escaped = CALL_EXPR.split(".").map((p) => p.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&")).join("\\\\s*\\\\.\\\\s*");
    const callRe = new RegExp("\\\\b" + escaped + "\\\\s*\\\\(");
    const found = callRe.test(stripped);
    const failMsg =
      "Paid API call \\"" + CALL_EXPR + "(...)\\" no longer appears in " + SOURCE_FILE + ". " +
      "Possible causes: the call was deleted, renamed (\\"messages.create\\" -> \\"messages.parse\\" is API-level), " +
      "or wrapped in a helper that breaks the expression match. " +
      "If intentional, retire the pin: pinned retire ${claimId} --reason=\\"...\\"";
    expect(found, failMsg).toBe(true);
  });

  // Model-string assertion: only emitted when the detector captured
  // a literal at pin time. Silent model swaps are the #1 paid-API
  // regression class.
  it.skipIf(!fileExists || !MODEL_STRING)("model literal still appears in the call options", () => {
    if (!MODEL_STRING) return;
    const content = readFileSync(fullPath, "utf8");
    const stripped = content.replace(/\\/\\/.*$/gm, "").replace(/\\/\\*[\\s\\S]*?\\*\\//g, "");
    const escaped = MODEL_STRING.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&");
    // Match \`model: "X"\` or \`model: 'X'\`.
    const modelRe = new RegExp("\\\\bmodel\\\\s*:\\\\s*['\\"\\\`]" + escaped + "['\\"\\\`]");
    const found = modelRe.test(stripped);
    const failMsg =
      "Model literal \\"" + MODEL_STRING + "\\" no longer appears as model: \\"" + MODEL_STRING + "\\" in " + SOURCE_FILE + ". " +
      "AI may have silently swapped the model (claude-opus -> claude-haiku, gpt-4o -> gpt-4o-mini). " +
      "Quality regression nobody notices until users complain. " +
      "If intentional, retire the pin: pinned retire ${claimId} --reason=\\"...\\"";
    expect(found, failMsg).toBe(true);
  });

  // max_tokens assertion: only emitted when present at pin time, so
  // adding a Pinned guard to an existing call doesn't suddenly flag
  // it as missing a cap (would be noisy).
  it.skipIf(!fileExists || !REQUIRE_MAX_TOKENS)("max_tokens (or max_completion_tokens) cap still present", () => {
    if (!REQUIRE_MAX_TOKENS) return;
    const content = readFileSync(fullPath, "utf8");
    const stripped = content.replace(/\\/\\/.*$/gm, "").replace(/\\/\\*[\\s\\S]*?\\*\\//g, "");
    const hasCap = /\\bmax_tokens\\s*:/.test(stripped) || /\\bmax_completion_tokens\\s*:/.test(stripped);
    const failMsg =
      "No max_tokens (or max_completion_tokens) field found in " + SOURCE_FILE + ". " +
      "AI may have removed the spend cap. Without it, a single runaway payload can run up tens-hundreds of dollars in API charges. " +
      "If intentional (e.g. moved to a default-options constant), retire the pin: pinned retire ${claimId} --reason=\\"...\\"";
    expect(hasCap, failMsg).toBe(true);
  });
});
`;

  return { filename, content, claimId };
}
