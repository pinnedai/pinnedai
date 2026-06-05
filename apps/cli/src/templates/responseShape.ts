// Template: response-shape (0.2.23+)
import type { ResponseShapeClaim } from "../claimParser.js";
import { claimSlug } from "../claimParser.js";
import type { GenerateOpts, GeneratedTest } from "./rateLimit.js";

export function generateResponseShapeTest(
  claim: ResponseShapeClaim,
  opts: GenerateOpts
): GeneratedTest {
  const slug = claimSlug(claim);
  const claimId = `${opts.prId}-${slug}`;
  const filename = `${claimId}.test.ts`;
  const readsLiteral = JSON.stringify(claim.consumerReads);

  const content = `// ═══════════════════════════════════════════════════════════════
// ◆ Pinned by pinnedai — https://pinnedai.dev
// generated-by: pinnedai@${opts.pinnedVersion}
// ═══════════════════════════════════════════════════════════════
// Response-shape pin
// Route:     ${claim.route}
// Producer:  ${claim.producerFile}
// Consumer:  ${claim.consumerFile}
//
// Asserts each consumer-read key still appears as an emitted key in
// the producer's NextResponse.json({...}). Catches the FIRST-TIME bug
// shape (the socialideagen \`status === "done"\` class): consumer +
// producer never agreed in the first place, OR AI silently renamed
// a producer-side key while consumer code keeps reading the old name.
//
// To retire:  pinned retire ${claimId} --reason="..."
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const PRODUCER_FILE = ${JSON.stringify(claim.producerFile)};
const CONSUMER_READS: string[] = ${readsLiteral};

function producerEmitsKey(content: string, key: string): boolean {
  const stripped = content.replace(/\\/\\/.*$/gm, "").replace(/\\/\\*[\\s\\S]*?\\*\\//g, "");
  const escaped = key.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&");
  // Match either object-literal field shape \`key: ...\` or shorthand \`key,\`/\`key }\`.
  // Constrained to appear inside a Response.json(...) call.
  const inJsonCall = /(?:NextResponse|Response|res)\\s*\\.\\s*json\\s*\\(([\\s\\S]*?)\\)/g;
  let m: RegExpExecArray | null;
  while ((m = inJsonCall.exec(stripped)) !== null) {
    const body = m[1];
    const re = new RegExp("(?:^|[\\\\s,{])" + escaped + "\\\\s*(?:[:,}])");
    if (re.test(body)) return true;
  }
  return false;
}

describe("response-shape: producer " + PRODUCER_FILE + " emits all keys consumer reads", () => {
  const fullPath = join(process.cwd(), PRODUCER_FILE);
  const fileExists = existsSync(fullPath);

  it.skipIf(!fileExists)("producer file is present", () => {
    expect(fileExists, "Producer route " + PRODUCER_FILE + " no longer exists. If route was moved, re-record the pin against the new path.").toBe(true);
  });

  for (const key of CONSUMER_READS) {
    it.skipIf(!fileExists)("producer emits \\"" + key + "\\"", () => {
      const content = readFileSync(fullPath, "utf8");
      const present = producerEmitsKey(content, key);
      const failMsg =
        "Producer " + PRODUCER_FILE + " no longer emits key \\"" + key + "\\" in any Response.json(...) literal. " +
        "Consumer code is reading this key from the response — it will be undefined. " +
        "If the producer-side key was intentionally renamed, also update consumer reads, then retire: pinned retire ${claimId} --reason=\\"...\\"";
      expect(present, failMsg).toBe(true);
    });
  }
});
`;
  return { filename, content, claimId };
}
