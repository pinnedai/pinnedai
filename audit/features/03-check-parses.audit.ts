// FEATURE: `pinned check --description "..."`
// SIGNAL: stdout contains "Found N claim(s):" with N matching the
//   expected count for a multi-template description, and each claim
//   line has the canonical template prefix (rate-limit, auth-required,
//   idempotent, cli-output, cli-exits, cli-creates, cli-flag, library).
// FALSIFIABILITY: catches a regression where check stops parsing any
//   of the 8 templates, miscounts, or uses different prefix labels.

import { describe, it, expect } from "vitest";
import { runCli } from "./runCli.js";

const FULL_DESCRIPTION = `
- Rate-limits /api/users to 60 req/min.
- Auth required on /api/admin/export.
- Makes /webhooks/stripe idempotent on event_id.
- \`pinned doctor\` outputs \`All checks passed\`.
- \`pinned --version\` exits 0.
- \`pinned init\` creates \`tests/pinned/.registry.json\`.
- \`pinned check\` supports \`--json\` flag.
- \`parseConfig()\` in \`src/config.ts\` returns \`{"version": 1}\`.
`.trim();

describe("FEATURE-AUDIT: `pinned check` parses all 8 template shapes", () => {
  it("POSITIVE CONTROL: stdout reports 8 claims with canonical prefix labels", async () => {
    const result = await runCli(["check", "--description", FULL_DESCRIPTION]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Found 8 claim(s)");
    const expectedPrefixes = [
      "rate-limit",
      "auth-required",
      "idempotent",
      "cli-output",
      "cli-exits",
      "cli-creates",
      "cli-flag",
      "library",
    ];
    for (const p of expectedPrefixes) {
      expect(result.stdout).toContain(p);
    }
  });

  it("NEGATIVE CONTROL: a description with no claims reports 'No claims found'", async () => {
    const result = await runCli([
      "check",
      "--description",
      "This PR fixes a typo in the comment.",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No claims found");
    expect(result.stdout).not.toContain("Found");
  });
});
