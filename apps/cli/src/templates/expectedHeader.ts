// Template: expected-header (0.2.23+)
import type { ExpectedHeaderClaim } from "../claimParser.js";
import { claimSlug } from "../claimParser.js";
import type { GenerateOpts, GeneratedTest } from "./rateLimit.js";

export function generateExpectedHeaderTest(
  claim: ExpectedHeaderClaim,
  opts: GenerateOpts
): GeneratedTest {
  const slug = claimSlug(claim);
  const claimId = `${opts.prId}-${slug}`;
  const filename = `${claimId}.test.ts`;

  const content = `// ═══════════════════════════════════════════════════════════════
// ◆ Pinned by pinnedai — https://pinnedai.dev
// generated-by: pinnedai@${opts.pinnedVersion}
// ═══════════════════════════════════════════════════════════════
// Webhook expected-header pin
// File:      ${claim.filePath}
// Provider:  ${claim.provider}
// Expected:  ${claim.expectedHeader}
//
// Asserts the webhook handler reads the canonical header name the
// ${claim.provider} SDK signs with. A typo (e.g. "x-stripe-signature"
// when canonical is "stripe-signature") makes signature verification
// silently fail on every request.
//
// To retire:  pinned retire ${claimId} --reason="..."
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const HANDLER_FILE = ${JSON.stringify(claim.filePath)};
const EXPECTED_HEADER = ${JSON.stringify(claim.expectedHeader)};

describe("expected-header: " + HANDLER_FILE + " reads canonical " + EXPECTED_HEADER, () => {
  const fullPath = join(process.cwd(), HANDLER_FILE);
  const fileExists = existsSync(fullPath);

  it.skipIf(!fileExists)("canonical header literal still present in handler source", () => {
    const content = readFileSync(fullPath, "utf8");
    const stripped = content.replace(/\\/\\/.*$/gm, "").replace(/\\/\\*[\\s\\S]*?\\*\\//g, "");
    const re = new RegExp("['\\"\\\`]" + EXPECTED_HEADER.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&") + "['\\"\\\`]", "i");
    const failMsg =
      "Handler " + HANDLER_FILE + " no longer references the canonical webhook header \\"" + EXPECTED_HEADER + "\\". " +
      "AI may have re-typo'd it. Signature verification will silently fail on every request. " +
      "If intentional (e.g. provider changed), retire the pin: pinned retire ${claimId} --reason=\\"...\\"";
    expect(re.test(stripped), failMsg).toBe(true);
  });
});
`;
  return { filename, content, claimId };
}
