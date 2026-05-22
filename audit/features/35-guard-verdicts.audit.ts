// FEATURE: `pinned guard` returns the correct verdict + exit code for
// the three pre-merge outcomes: PASS / REVIEW / BLOCK.
// SIGNAL: Each verdict pairs deterministically with an exit code:
//   PASS   → exit 0  (no unprotected surfaces, no skipped pins, no test failures)
//   REVIEW → exit 1  (unprotected surface in diff OR skipped pin in last run)
//   BLOCK  → exit 2  (a pinned test actually failed → don't merge)
// FALSIFIABILITY:
//   - POS-PASS: clean repo, no diff, no failing pins → verdict PASS, exit 0.
//   - POS-REVIEW: add a new admin route without a pin → verdict REVIEW, exit 1.
//   - POS-BLOCK: ship a pinned test that always fails → verdict BLOCK, exit 2.
//   - NEG: same BLOCK fixture but with `--no-test` → must NOT escalate
//     to BLOCK (we never ran the test, so we cannot claim it failed).
//   - SCHEMA: `--json` output emits schema "pinnedai.guard.v1" with the
//     verdict + exitCode fields matching the human-mode output.

import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runCli, makeTempRepo } from "./runCli.js";

function commit(cwd: string, msg: string): void {
  execFileSync("git", ["add", "-A"], { cwd });
  execFileSync(
    "git",
    ["-c", "commit.gpgsign=false", "commit", "-q", "-m", msg],
    { cwd }
  );
}

// Pre-populate a tests/pinned/ skeleton + registry so guard's Phase 2
// (run `pinned test`) has something to chew on. We hand-author one
// rate-limit pin + matching registry entry — bypasses `pinned generate`
// (which needs PR body context) and gives us full control over whether
// the pin passes or fails.
function seedPinned(cwd: string, opts: { failingTest: boolean }): void {
  const pinDir = join(cwd, "tests", "pinned");
  mkdirSync(pinDir, { recursive: true });

  const claimId = "pr-test-rate-limit-api-users";
  const filename = `${claimId}.test.ts`;
  const claimText = "Rate-limits /api/users to 60 req/min.";

  // Minimal pin test. If failingTest=true, force-fail synchronously
  // (no PREVIEW_URL dependency, no skipIf gates — must register as a
  // real failure, not "skipped").
  const testBody = opts.failingTest
    ? `import { describe, it, expect } from "vitest";
describe("pinned: ${claimText}", () => {
  it("intentionally failing for guard BLOCK audit", () => {
    expect(true).toBe(false);
  });
});
`
    : `import { describe, it, expect } from "vitest";
describe("pinned: ${claimText}", () => {
  it("intentionally passing", () => {
    expect(1 + 1).toBe(2);
  });
});
`;
  writeFileSync(join(pinDir, filename), testBody);

  // Registry stub mirrors the RegistryEntry shape `pinned generate` writes.
  writeFileSync(
    join(pinDir, ".registry.json"),
    JSON.stringify(
      {
        version: 1,
        claims: [
          {
            claimId,
            prId: "audit",
            claim: {
              template: "rate-limit",
              route: "/api/users",
              rate: 60,
              window: "min",
              raw: claimText,
            },
            filename,
            pinnedAt: "2026-01-01T00:00:00.000Z",
            status: "active",
            covers: { routes: ["/api/users"], files: [] },
          },
        ],
      },
      null,
      2
    )
  );
  // PINS.md stub so `pinned status` etc. don't trip on a missing file.
  writeFileSync(join(pinDir, "PINS.md"), `# Pinned\n\n- ${claimText}\n`);

  // Add a root package.json + install vitest locally so `pinned test`
  // can actually invoke the runner. We use the workspace's own vitest
  // binary via symlink to avoid a real `npm install`.
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify(
      {
        name: "guard-audit-fixture",
        private: true,
        devDependencies: { vitest: "^2.0.0" },
      },
      null,
      2
    )
  );
  // Symlink the monorepo's vitest into the fixture so the spawned
  // `pinned test` resolves it.
  const monorepoVitest = join(
    process.cwd(),
    "apps",
    "cli",
    "node_modules",
    ".bin",
    "vitest"
  );
  const fixtureBin = join(cwd, "node_modules", ".bin");
  mkdirSync(fixtureBin, { recursive: true });
  // Copy the binary symlink target so `node_modules/.bin/vitest` resolves.
  // Simpler: just symlink the whole apps/cli/node_modules/vitest dir.
  const monorepoVitestPkg = join(
    process.cwd(),
    "apps",
    "cli",
    "node_modules",
    "vitest"
  );
  const fixtureVitestPkg = join(cwd, "node_modules", "vitest");
  try {
    execFileSync("ln", ["-s", monorepoVitestPkg, fixtureVitestPkg]);
    execFileSync("ln", ["-s", monorepoVitest, join(fixtureBin, "vitest")]);
  } catch {
    /* best effort — if symlink fails, the test that needs it will surface the gap */
  }
}

describe("FEATURE-AUDIT: `pinned guard` verdict + exit code mapping", () => {
  it("POSITIVE-PASS: clean diff, no pins, no risks → verdict PASS, exit 0", async () => {
    const cwd = makeTempRepo();
    // Create initial commit so HEAD exists.
    writeFileSync(join(cwd, "README.md"), "# audit\n");
    commit(cwd, "init");

    const r = await runCli(
      ["guard", "--quiet", "--no-test", "--base", "HEAD"],
      { cwd }
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("pinned guard · PASS");
  });

  it("POSITIVE-REVIEW: new admin route without a pin → verdict REVIEW, exit 1", async () => {
    const cwd = makeTempRepo();
    writeFileSync(join(cwd, "README.md"), "# audit\n");
    commit(cwd, "init");

    // Add an unprotected admin route — exactly the surface scan-diff
    // is supposed to catch.
    mkdirSync(join(cwd, "app", "api", "admin", "export"), { recursive: true });
    writeFileSync(
      join(cwd, "app", "api", "admin", "export", "route.ts"),
      "export const GET = () => new Response('ok');\n"
    );
    commit(cwd, "add admin route");

    const r = await runCli(
      ["guard", "--quiet", "--no-test", "--base", "HEAD~1"],
      { cwd }
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("pinned guard · REVIEW");
    expect(r.stdout).toMatch(/unprotected risk/i);
  });

  it("POSITIVE-BLOCK: a failing pinned test → verdict BLOCK, exit 2", async () => {
    const cwd = makeTempRepo();
    writeFileSync(join(cwd, "README.md"), "# audit\n");
    seedPinned(cwd, { failingTest: true });
    commit(cwd, "init with failing pin");

    const r = await runCli(
      ["guard", "--quiet", "--base", "HEAD"],
      { cwd }
    );
    expect(r.exitCode).toBe(2);
    expect(r.stdout + r.stderr).toContain("BLOCK");
  });

  it("NEGATIVE (forward-back): same failing-pin fixture but with `--no-test` must NOT escalate to BLOCK", async () => {
    const cwd = makeTempRepo();
    writeFileSync(join(cwd, "README.md"), "# audit\n");
    seedPinned(cwd, { failingTest: true });
    commit(cwd, "init with failing pin");

    // --no-test means we never invoked the test runner; we cannot
    // therefore claim a real test failure. Verdict must be PASS
    // (or REVIEW if anything else trips), but NEVER BLOCK.
    const r = await runCli(
      ["guard", "--quiet", "--no-test", "--base", "HEAD"],
      { cwd }
    );
    expect(r.exitCode).not.toBe(2);
    expect(r.stdout).not.toContain("pinned guard · BLOCK");
  });

  it("SCHEMA: `--json` emits schema pinnedai.guard.v1 with verdict + exitCode", async () => {
    const cwd = makeTempRepo();
    writeFileSync(join(cwd, "README.md"), "# audit\n");
    commit(cwd, "init");

    const r = await runCli(
      ["guard", "--quiet", "--no-test", "--base", "HEAD", "--json"],
      { cwd }
    );
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.schema).toBe("pinnedai.guard.v1");
    expect(parsed.verdict).toBe("PASS");
    expect(parsed.exitCode).toBe(0);
    expect(parsed.testFailed).toBe(false);
    expect(Array.isArray(parsed.unprotectedSurfaces)).toBe(true);
  });

  it("SCHEMA-REVIEW: `--json` REVIEW case includes the unprotected surface details", async () => {
    const cwd = makeTempRepo();
    writeFileSync(join(cwd, "README.md"), "# audit\n");
    commit(cwd, "init");
    mkdirSync(join(cwd, "app", "api", "admin", "export"), { recursive: true });
    writeFileSync(
      join(cwd, "app", "api", "admin", "export", "route.ts"),
      "export const GET = () => new Response('ok');\n"
    );
    commit(cwd, "add admin route");

    const r = await runCli(
      ["guard", "--quiet", "--no-test", "--base", "HEAD~1", "--json"],
      { cwd }
    );
    expect(r.exitCode).toBe(1);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.verdict).toBe("REVIEW");
    expect(parsed.exitCode).toBe(1);
    expect(parsed.unprotectedSurfaces.length).toBeGreaterThan(0);
    expect(parsed.unprotectedSurfaces[0].route).toContain("/api/admin/export");
  });
});
