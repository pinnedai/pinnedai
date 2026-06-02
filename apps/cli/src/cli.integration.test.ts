// End-to-end CLI integration tests.
//
// Spawns the built CLI binary as a child process against a fresh
// tempdir for each test, validates file outputs, exit codes, and
// stdout content. Closer to a real customer's experience than the
// pure unit tests in claimParser.test.ts / scanDiff.test.ts.
//
// Requires the CLI to be built first (apps/cli/dist/cli.js exists).
// We invoke `pnpm --filter pinnedai build` from the workspace root
// before running tests via the `pretest` hook; if you run vitest
// directly without building, the tests will skip with a clear error.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const CLI_BIN = resolve(__dirname, "..", "dist", "cli.js");

function runCli(
  cwd: string,
  args: string[],
  opts: { env?: Record<string, string>; allowFailure?: boolean } = {}
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("node", [CLI_BIN, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...opts.env },
  });
  if (!opts.allowFailure && result.status !== 0) {
    throw new Error(
      `CLI exited ${result.status}\nargs: ${args.join(" ")}\nstderr: ${result.stderr}\nstdout: ${result.stdout}`
    );
  }
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? 0,
  };
}

let testDir: string;

beforeAll(() => {
  if (!existsSync(CLI_BIN)) {
    throw new Error(
      `CLI binary not found at ${CLI_BIN}. Run \`pnpm --filter pinnedai build\` first.`
    );
  }
});

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "pinned-cli-test-"));
  // git init the tempdir so `pinned init` doesn't fail its preflight
  // (non-git-repo check added in task 153). Audits mirror real customer
  // flow: user has a git repo, then runs pinned init.
  spawnSync("git", ["init", "-b", "main"], { cwd: testDir, stdio: "ignore" });
  spawnSync("git", ["config", "user.email", "test@example.com"], {
    cwd: testDir,
    stdio: "ignore",
  });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: testDir, stdio: "ignore" });
  spawnSync("git", ["config", "commit.gpgsign", "false"], {
    cwd: testDir,
    stdio: "ignore",
  });
  // Pre-seed a package.json declaring vitest so `pinned init --auto`
  // doesn't refuse to complete (it now exits 2 if vitest can't be
  // detected — see the "INIT INCOMPLETE" branch in cli.ts). Integration
  // tests exercise the happy-path init, not the vitest-missing path
  // (which has its own dedicated audit).
  writeFileSync(
    join(testDir, "package.json"),
    JSON.stringify(
      {
        name: "cli-integration-fixture",
        private: true,
        devDependencies: { vitest: "^2.0.0" },
      },
      null,
      2
    )
  );
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("CLI: bare invocation = try demo", () => {
  it("runs without arguments and prints the demo", () => {
    const { stdout } = runCli(testDir, []);
    expect(stdout).toContain("pinnedai try");
    expect(stdout).toContain("Generated test file");
    expect(stdout).toContain("rate-limit");
  });

  it("--version prints the package version", () => {
    const { stdout } = runCli(testDir, ["--version"]);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("CLI: init", () => {
  it("creates workflow + tests/pinned + registry on a fresh repo", () => {
    const { stdout } = runCli(testDir, ["init"]);
    expect(existsSync(join(testDir, ".github/workflows/pinned.yml"))).toBe(true);
    expect(existsSync(join(testDir, "tests/pinned/PINS.md"))).toBe(true);
    expect(existsSync(join(testDir, "tests/pinned/.registry.json"))).toBe(true);
    expect(stdout).toContain("+ .github/workflows/pinned.yml");
  });

  it("workflow YAML contains both pull_request and issue_comment triggers", () => {
    runCli(testDir, ["init"]);
    const yml = readFileSync(
      join(testDir, ".github/workflows/pinned.yml"),
      "utf8"
    );
    expect(yml).toContain("pull_request:");
    expect(yml).toContain("issue_comment:");
    expect(yml).toContain("@pinned add:");
    expect(yml).toContain("id-token: write");
    expect(yml).toContain("contents: write");
  });

  it("--force overwrites existing files", () => {
    runCli(testDir, ["init"]);
    // Tamper with the workflow file
    writeFileSync(
      join(testDir, ".github/workflows/pinned.yml"),
      "# manually edited"
    );
    runCli(testDir, ["init", "--force"]);
    const yml = readFileSync(
      join(testDir, ".github/workflows/pinned.yml"),
      "utf8"
    );
    expect(yml).not.toBe("# manually edited");
    expect(yml).toContain("pull_request:");
  });

  it("skips existing files without --force", () => {
    runCli(testDir, ["init"]);
    writeFileSync(
      join(testDir, ".github/workflows/pinned.yml"),
      "# manually edited"
    );
    const { stdout } = runCli(testDir, ["init"]);
    expect(stdout).toContain("exists, skipping");
    expect(
      readFileSync(join(testDir, ".github/workflows/pinned.yml"), "utf8")
    ).toBe("# manually edited");
  });
});

describe("CLI: check", () => {
  it("parses a rate-limit claim and prints it", () => {
    const { stdout } = runCli(testDir, [
      "check",
      "--description",
      "Rate-limits /api/users to 60 req/min.",
    ]);
    expect(stdout).toContain("Recognized claim(s)");
    expect(stdout).toContain("/api/users");
    expect(stdout).toContain("60/minute");
  });

  it("reports dropped claims when phrasings don't match any template", () => {
    const { stdout } = runCli(testDir, [
      "check",
      "--description",
      "Auth required on /admin. POST /api/signup rejects request bodies without an email field with 400. POST /api/track/invite without a sig_signup cookie returns 401.",
    ]);
    // 1 of 3 recognized
    expect(stdout).toContain("Recognized 1 of 3 claim(s)");
    // Both dropped lines should be surfaced
    expect(stdout).toContain("POST /api/signup");
    expect(stdout).toContain("POST /api/track/invite");
    // Should still print the recognized claim
    expect(stdout).toContain("/admin");
  });

  it("--json emits a JSON array", () => {
    const { stdout } = runCli(testDir, [
      "check",
      "--description",
      "Auth required on /api/x.",
      "--json",
    ]);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].template).toBe("auth-required");
  });

  it("emits friendly examples on empty body", () => {
    const { stdout } = runCli(testDir, [
      "check",
      "--description",
      "Just a refactor.",
    ]);
    expect(stdout).toContain("No claims found");
    expect(stdout).toContain("Rate-limits");
  });

  it("exits 1 with no body and no stdin", () => {
    const { status, stderr } = runCli(testDir, ["check"], { allowFailure: true });
    expect(status).toBe(1);
    expect(stderr).toContain("No PR description provided");
  });
});

describe("CLI: generate + retire + list lifecycle", () => {
  it("generates files for each claim and updates PINS.md", () => {
    runCli(testDir, ["init"]);
    const { stdout } = runCli(testDir, [
      "generate",
      "--pr-id",
      "pr-42",
      "--description",
      "Rate-limits /api/users to 60 req/min. Auth required on /api/admin.",
    ]);
    expect(stdout).toContain("Pinned 2 claim(s)");
    // Filenames now include a hash suffix. Discover them rather than hard-coding.
    const dir = join(testDir, "tests/pinned");
    const files = readdirSync(dir).filter((f) => f.endsWith(".test.ts"));
    expect(files.some((f: string) => /rate-limit-api-users-[a-z0-9]+\.test\.ts/.test(f))).toBe(true);
    expect(files.some((f: string) => /auth-required-api-admin-[a-z0-9]+\.test\.ts/.test(f))).toBe(true);
    const pins = readFileSync(join(testDir, "tests/pinned/PINS.md"), "utf8");
    expect(pins).toContain("rate-limit /api/users");
    expect(pins).toContain("auth-required /api/admin");
  });

  it("list shows pinned claims", () => {
    runCli(testDir, ["init"]);
    runCli(testDir, [
      "generate",
      "--pr-id",
      "pr-1",
      "--description",
      "Rate-limits /api/x to 60 req/min.",
    ]);
    const { stdout } = runCli(testDir, ["list"]);
    expect(stdout).toContain("Protected behaviors (1)");
    // `list` (non-verbose) prints the claim title, not the filename.
    // The filename pattern lives under `list --verbose`. We verify
    // the route is named so a missing-pin regression is still caught.
    expect(stdout).toContain("/api/x");
  });

  it("retire moves the file and updates PINS.md", () => {
    runCli(testDir, ["init"]);
    runCli(testDir, [
      "generate",
      "--pr-id",
      "pr-1",
      "--description",
      "Rate-limits /api/x to 60 req/min.",
    ]);
    // Discover the generated filename (it has a hash suffix now)
    const f = readdirSync(join(testDir, "tests/pinned"))
      .find((n: string) => /pr-1-rate-limit-api-x-[a-z0-9]+\.test\.ts/.test(n));
    expect(f).toBeTruthy();
    const claimId = f!.replace(/\.test\.ts$/, "");

    const { stdout } = runCli(testDir, [
      "retire",
      claimId,
      "--reason=endpoint removed",
    ]);
    expect(stdout).toContain(`retired/${f}`);
    expect(existsSync(join(testDir, "tests/pinned", f!))).toBe(false);
    expect(existsSync(join(testDir, "tests/pinned/retired", f!))).toBe(true);
    expect(
      existsSync(join(testDir, "tests/pinned/retired", `${claimId}.audit.json`))
    ).toBe(true);
  });

  it("list --include-retired shows retired claims separately", () => {
    runCli(testDir, ["init"]);
    runCli(testDir, [
      "generate",
      "--pr-id",
      "pr-1",
      "--description",
      "Rate-limits /api/x to 60 req/min.",
    ]);
    const f = readdirSync(join(testDir, "tests/pinned"))
      .find((n: string) => /pr-1-rate-limit-api-x-[a-z0-9]+\.test\.ts/.test(n));
    const claimId = f!.replace(/\.test\.ts$/, "");
    runCli(testDir, ["retire", claimId, "--reason=removed"]);
    const { stdout } = runCli(testDir, ["list", "--include-retired"]);
    expect(stdout).toContain("Retired (1)");
  });

  it("retire of non-existent claim exits 1", () => {
    runCli(testDir, ["init"]);
    const { status } = runCli(
      testDir,
      ["retire", "pr-99-nope", "--reason=test"],
      { allowFailure: true }
    );
    expect(status).toBe(1);
  });
});

describe("CLI: unlimited pins on every tier", () => {
  // Pin counts are uncapped at every tier — the moat IS pin
  // accumulation. Cost is bounded server-side by the Worker's
  // monthly LLM-call cap, not by a client-side pin cap.
  it("generates the 26th pin without a Free-tier cap (no longer enforced)", () => {
    runCli(testDir, ["init"]);
    for (let i = 0; i < 25; i++) {
      runCli(testDir, [
        "generate",
        "--pr-id",
        `pr-${i}`,
        "--description",
        `Auth required on /api/route-${i}.`,
      ]);
    }
    const { status, stderr } = runCli(testDir, [
      "generate",
      "--pr-id",
      "pr-26",
      "--description",
      "Auth required on /api/extra.",
    ]);
    expect(status).toBe(0);
    expect(stderr).not.toContain("Free tier limit");
  });

  // Stale PINNEDAI_LICENSE_KEY env var must continue to be inert — no
  // codepath should re-introduce local license parsing.
  it("PINNEDAI_LICENSE_KEY env var has no effect (license keys removed in v0.1.1)", () => {
    runCli(testDir, ["init"]);
    const { status } = runCli(
      testDir,
      [
        "generate",
        "--pr-id",
        "pr-1",
        "--description",
        "Auth required on /api/x.",
      ],
      { env: { PINNEDAI_LICENSE_KEY: "pnd_" + "a".repeat(32) } }
    );
    expect(status).toBe(0);
  });
});

describe("CLI: doctor", () => {
  it("reports failures in an unconfigured repo", () => {
    const { stdout, status } = runCli(testDir, ["doctor"], {
      allowFailure: true,
    });
    expect(stdout).toContain("✗ tests/pinned/ directory");
    expect(status).toBe(1);
  });

  it("passes all checks after init", () => {
    runCli(testDir, ["init"]);
    const { stdout, status } = runCli(testDir, ["doctor"]);
    expect(status).toBe(0);
    expect(stdout).toContain("id-token: write declared");
    expect(stdout).toContain("contents: write declared");
  });

  it("doctor reports active pin count without any free-tier cap warning", () => {
    runCli(testDir, ["init"]);
    for (let i = 0; i < 5; i++) {
      runCli(testDir, [
        "generate",
        "--pr-id",
        `pr-${i}`,
        "--description",
        `Auth required on /api/route-${i}.`,
      ]);
    }
    const { stdout } = runCli(testDir, ["doctor"]);
    expect(stdout).toContain("PINS.md registry");
    expect(stdout).toContain("5 active pin(s)");
    expect(stdout).not.toContain("Free-tier pin cap");
  });
});

describe("CLI: baseline", () => {
  it("finds candidate pins from existing files", () => {
    runCli(testDir, ["init"]);
    mkdirSync(join(testDir, "app/api/admin/export"), { recursive: true });
    writeFileSync(
      join(testDir, "app/api/admin/export/route.ts"),
      "export const GET = () => {};"
    );
    const { stdout } = runCli(testDir, ["baseline"]);
    expect(stdout).toContain("/api/admin/export");
    expect(stdout).toContain("Auth required");
  });

  it("returns nothing for a benign tree", () => {
    runCli(testDir, ["init"]);
    mkdirSync(join(testDir, "lib"));
    writeFileSync(join(testDir, "lib/format.ts"), "export const x = 1;");
    const { stdout } = runCli(testDir, ["baseline"]);
    expect(stdout).toContain("No candidate pins");
  });
});

describe("CLI: scan-diff (without a git diff)", () => {
  it("emits clean output when run outside a git repo", () => {
    runCli(testDir, ["init"]);
    const { stdout } = runCli(testDir, [
      "scan-diff",
      "--description",
      "Just a refactor.",
    ]);
    // No git history → no changed files → no suggestions. The CLI
    // emits the "already protected" calm message rather than a
    // dedicated "no risk surfaces" string (the two states collapsed
    // when the touched-pins block was added — both render via
    // renderSuggestionsHuman's empty-state branch).
    expect(stdout).toContain("Every code path Pinned can detect is already protected");
  });
});

// Adversarial-input coverage — these tests verify defenses for the
// hostile inputs called out in the bundle spec (multibyte/emoji,
// path traversal, markdown-breaking chars, whitespace).
// Per [[feature-audit-signals-must-be-falsifiable]] — the positive
// control here is that the CLI safely processes (or refuses) each
// known-adversarial input rather than crashing or escaping its sandbox.
describe("CLI: adversarial inputs", () => {
  it("emoji + multibyte chars in PR body parse without crashing", () => {
    const body = "🚨 Rate-limits /api/users to 60 req/min. — 日本語";
    const { stdout, status } = runCli(testDir, [
      "check",
      "--description",
      body,
    ]);
    expect(status).toBe(0);
    expect(stdout).toContain("/api/users");
  });

  it("path traversal in --pr-id is rejected", () => {
    runCli(testDir, ["init"]);
    const { status, stderr } = runCli(
      testDir,
      [
        "generate",
        "--pr-id",
        "../../etc/passwd",
        "--description",
        "Rate-limits /api/x to 60 req/min.",
      ],
      { allowFailure: true }
    );
    expect(status).toBe(1);
    expect(stderr).toContain("Invalid --pr-id");
  });

  it("path traversal in retire --claim-id is rejected", () => {
    runCli(testDir, ["init"]);
    const { status, stderr } = runCli(
      testDir,
      ["retire", "../../etc/passwd", "--reason=evil"],
      { allowFailure: true }
    );
    expect(status).toBe(1);
    expect(stderr).toContain("Invalid claim id");
  });

  it("path traversal in --dir is rejected", () => {
    const { status, stderr } = runCli(
      testDir,
      ["list", "--dir", "../../../../etc"],
      { allowFailure: true }
    );
    expect(status).toBe(1);
    expect(stderr).toContain("Path escape");
  });

  it("whitespace-only --description is treated as no description", () => {
    const { status, stderr } = runCli(
      testDir,
      ["check", "--description", "   \n\t   "],
      { allowFailure: true }
    );
    expect(status).toBe(1);
    expect(stderr).toContain("No PR description provided");
  });

  // POSITIVE CONTROL: a route containing a literal `|` is accepted by
  // the parser (pipes aren't in the route-token exclusion class), but
  // the pipe MUST appear escape-encoded as `\|` in PINS.md — otherwise
  // it would break the markdown table column count and silently corrupt
  // the registry view.
  it("POSITIVE CONTROL: pipe in route is escape-encoded in PINS.md (no table break)", () => {
    runCli(testDir, ["init"]);
    runCli(testDir, [
      "generate",
      "--pr-id",
      "pr-99",
      "--description",
      "Rate-limits /api/foo|bar to 60 req/min.",
    ]);
    const pins = readFileSync(join(testDir, "tests/pinned/PINS.md"), "utf8");

    // The escape happened — `|` is now `\|` in the rendered cell.
    expect(pins).toContain("/api/foo\\|bar");

    // Defensive: the active-section table row count matches the column
    // count we declared in the header (5 cells → 6 `|` boundaries per row).
    const activeSectionRows = pins
      .split("\n")
      .filter((l) => l.includes("/api/foo"))
      .filter((l) => !l.includes("---")); // skip separator
    expect(activeSectionRows.length).toBeGreaterThan(0);
    for (const row of activeSectionRows) {
      // After escaping, every `|` we see in the row is a column
      // boundary (not a route char). Active section has 5 columns →
      // 6 boundaries.
      // Replace escaped pipes so they don't get counted as boundaries.
      const boundaries = row.replace(/\\\|/g, "").match(/\|/g);
      expect(boundaries?.length).toBe(6);
    }
  });

  it("backtick in route is REJECTED at parse time (defense in depth — never reaches renderer)", () => {
    // The ROUTE constant now excludes backtick, brace, angle-bracket,
    // and quote characters — surfaced via the OSS PR-body sweep where
    // backtick-bounded API docs produced malformed routes like
    // `/v1/tenants/{tenant_id}/data\``. Now the parser refuses to
    // accept such routes; downstream rendering never sees them.
    runCli(testDir, ["init"]);
    runCli(testDir, [
      "generate",
      "--pr-id",
      "pr-100",
      "--description",
      "Rate-limits /api/`evil to 60 req/min.",
    ]);
    // The claim didn't parse, so no row landed in PINS.md or registry.
    // The Active section in PINS.md should NOT contain any /api/\`evil row.
    const pinsPath = join(testDir, "tests/pinned/PINS.md");
    const pins = readFileSync(pinsPath, "utf8");
    expect(pins).not.toContain("evil");
  });

  it("newline-in-route attempt doesn't corrupt PINS.md or generated test file", () => {
    // Markdown tables are line-delimited; a newline inside a route would
    // close the table row early and break rendering. Pinned must either
    // reject such routes (the parser drops them) or safely escape them.
    // Either outcome is acceptable — but PINS.md must remain well-formed
    // markdown and no test file should leak a literal newline into its
    // describe() title.
    runCli(testDir, ["init"]);
    runCli(testDir, [
      "generate",
      "--pr-id",
      "pr-101",
      "--description",
      // The literal "\n" inside the route — if the parser accepts it,
      // both the registry row and the generated test header must escape it.
      "Rate-limits /api/foo\nbar to 60 req/min.",
    ]);
    const pins = readFileSync(join(testDir, "tests/pinned/PINS.md"), "utf8");
    const pinnedDir = join(testDir, "tests/pinned");
    const generated = readdirSync(pinnedDir).filter((f) =>
      f.endsWith(".test.ts")
    );

    // Two safe outcomes — both must be accepted, but neither may corrupt
    // PINS.md or the generated test files:
    //
    //   (A) Parser REJECTS the newline-bearing route — no claim, no test
    //       file, PINS.md stays in its empty state. (Current behavior.)
    //   (B) Parser ACCEPTS the route — both PINS.md row AND the generated
    //       test file must escape the newline so the table stays valid
    //       markdown and the describe() string stays on one line.
    if (generated.length === 0) {
      // (A) — parser rejected. Confirm PINS.md never grew a corrupt row.
      // Specifically: no row containing a literal \n inside cell content
      // (which would be impossible — split("\n") would split it — but we
      // double-check that the file is still well-formed empty state).
      expect(pins).not.toMatch(/\|[^|\n]*\\n[^|\n]*\|/);
    } else {
      // (B) — parser accepted. Every generated test file must have a
      // single-line describe() title.
      for (const f of generated) {
        const src = readFileSync(join(pinnedDir, f), "utf8");
        const describeMatch = /describe\(([^)]+)\)/.exec(src);
        if (describeMatch) {
          expect(describeMatch[1]).not.toContain("\n");
        }
      }
      // And PINS.md's table must still have intact header + separator
      // rows (no row got truncated by a leaked newline).
      const lines = pins.split("\n");
      const headerIdx = lines.findIndex((l) => /\|\s*Claim\s*\|/.test(l));
      if (headerIdx >= 0) {
        expect(lines[headerIdx + 1]).toMatch(/^\|[\s\-:|]+\|$/);
      }
    }
  });
});
