import { describe, it, expect } from "vitest";
import * as ts from "typescript";
import { generateRateLimitTest } from "./templates/rateLimit.js";
import { generateAuthRequiredTest } from "./templates/authRequired.js";
import { generateIdempotentTest } from "./templates/idempotent.js";
import {
  generateCliOutputContainsTest,
  parseSimpleArgv,
} from "./templates/cliOutputContains.js";
import { generateCliExitsZeroTest } from "./templates/cliExitsZero.js";
import { generateCliCreatesFileTest } from "./templates/cliCreatesFile.js";
import { generateCliFlagSupportedTest } from "./templates/cliFlagSupported.js";
import { generateLibraryReturnsTest } from "./templates/libraryReturns.js";
import type {
  RateLimitClaim,
  AuthRequiredClaim,
  IdempotentClaim,
  CliOutputContainsClaim,
  CliExitsZeroClaim,
  CliCreatesFileClaim,
  CliFlagSupportedClaim,
  LibraryReturnsClaim,
} from "./claimParser.js";

const rl: RateLimitClaim = {
  template: "rate-limit",
  route: "/api/users",
  rate: 60,
  window: "minute",
  raw: "Rate-limits /api/users to 60 req/min",
};
const auth: AuthRequiredClaim = {
  template: "auth-required",
  route: "/api/admin/export",
  raw: "Auth required on /api/admin/export",
};
const idem: IdempotentClaim = {
  template: "idempotent",
  route: "/webhooks/stripe",
  idField: "event_id",
  raw: "Makes /webhooks/stripe idempotent on event_id",
};

describe("template generators — structure", () => {
  it("rate-limit: produces a filename + content + claimId", () => {
    const gen = generateRateLimitTest(rl, { prId: "pr-42" });
    expect(gen.filename).toMatch(/^pr-42-rate-limit-api-users-[a-z0-9]+\.test\.ts$/);
    expect(gen.claimId).toMatch(/^pr-42-rate-limit-api-users-[a-z0-9]+$/);
    expect(gen.content).toContain("import { describe");
  });

  it("auth-required: route ends up as /api/admin/export", () => {
    const gen = generateAuthRequiredTest(auth, { prId: "pr-7" });
    expect(gen.filename).toMatch(/^pr-7-auth-required-api-admin-export-[a-z0-9]+\.test\.ts$/);
    expect(gen.content).toContain('"/api/admin/export"');
  });

  it("idempotent: includes the id-field key", () => {
    const gen = generateIdempotentTest(idem, { prId: "pr-3" });
    expect(gen.filename).toMatch(/^pr-3-idempotent-webhooks-stripe-[a-z0-9]+\.test\.ts$/);
    expect(gen.content).toContain('"event_id"');
  });

  it("all templates: embed the original PR claim verbatim as a string literal", () => {
    expect(generateRateLimitTest(rl, { prId: "pr-1" }).content).toContain(
      JSON.stringify(rl.raw)
    );
    expect(generateAuthRequiredTest(auth, { prId: "pr-1" }).content).toContain(
      JSON.stringify(auth.raw)
    );
    expect(generateIdempotentTest(idem, { prId: "pr-1" }).content).toContain(
      JSON.stringify(idem.raw)
    );
  });

  it("all templates: include the repair-prompt sentinel block", () => {
    expect(generateRateLimitTest(rl, { prId: "p1" }).content).toContain(
      "═══ PINNED FAILURE"
    );
    expect(generateAuthRequiredTest(auth, { prId: "p1" }).content).toContain(
      "═══ PINNED FAILURE"
    );
    expect(generateIdempotentTest(idem, { prId: "p1" }).content).toContain(
      "═══ PINNED FAILURE"
    );
  });

  it("all templates: include the retire command back-reference", () => {
    expect(generateRateLimitTest(rl, { prId: "pr-99" }).content).toContain(
      "pinned retire pr-99-rate-limit-api-users"
    );
  });
});

describe("template generators — generated content parses as valid TypeScript", () => {
  for (const [name, gen] of [
    ["rate-limit", generateRateLimitTest(rl, { prId: "pr-1" })],
    ["auth-required", generateAuthRequiredTest(auth, { prId: "pr-1" })],
    ["idempotent", generateIdempotentTest(idem, { prId: "pr-1" })],
  ] as const) {
    it(`${name}: no syntax errors`, () => {
      const sf = ts.createSourceFile(
        gen.filename,
        gen.content,
        ts.ScriptTarget.ES2022,
        true,
        ts.ScriptKind.TS
      );
      const diagnostics = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] })
        .parseDiagnostics;
      if (diagnostics && diagnostics.length > 0) {
        const msgs = diagnostics
          .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))
          .join("\n");
        throw new Error(`Syntax errors in generated file:\n${msgs}`);
      }
      expect(diagnostics?.length ?? 0).toBe(0);
    });

    it(`${name}: contains the vitest import + describe/it`, () => {
      expect(gen.content).toMatch(/import\s*\{[^}]*describe[^}]*\}\s*from\s*["']vitest["']/);
      expect(gen.content).toMatch(/describe\s*\(/);
      // Templates emit either `it(...)` or `it.skipIf(...)(...)`
      // — the latter gates execution on PREVIEW_URL availability so
      // CI doesn't fail when the test env lacks a deployed preview.
      expect(gen.content).toMatch(/\bit(?:\.skipIf)?\s*[(.]/);
    });

    it(`${name}: gates the test on PREVIEW_URL`, () => {
      expect(gen.content).toContain("PREVIEW_URL");
      expect(gen.content).toContain("beforeAll");
    });
  }
});

describe("template generator — cli-output-contains", () => {
  const cli: CliOutputContainsClaim = {
    template: "cli-output-contains",
    route: "pinned doctor",
    text: "tests/pinned/ directory",
    raw: "`pinned doctor` outputs `tests/pinned/ directory`",
  };

  it("POSITIVE CONTROL: generates a runnable Vitest file with the expected fields", () => {
    const gen = generateCliOutputContainsTest(cli, { prId: "pr-42" });
    expect(gen.filename).toMatch(
      /^pr-42-cli-output-contains-pinned-doctor-[a-z0-9]+\.test\.ts$/
    );
    expect(gen.content).toContain('import { execFileSync } from "node:child_process"');
    expect(gen.content).toContain('"pinned doctor"');
    expect(gen.content).toContain('"tests/pinned/ directory"');
    // Generated file must NOT use shell:true — only execFileSync with a tokenized argv.
    expect(gen.content).not.toContain('shell: true');
    expect(gen.content).not.toContain('shell:true');
  });

  it("argv is pre-tokenized at generation time (no shell at runtime)", () => {
    const gen = generateCliOutputContainsTest(cli, { prId: "pr-42" });
    expect(gen.content).toContain('const ARGV = ["pinned","doctor"]');
  });

  it("output content is valid TypeScript (parses without diagnostics)", () => {
    const gen = generateCliOutputContainsTest(cli, { prId: "pr-42" });
    const sf = ts.createSourceFile(
      gen.filename,
      gen.content,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS
    );
    // No syntactic diagnostics surfaces via the parsed source.
    // (Semantic checks aren't run here — that'd require a full program.)
    const diags = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics;
    expect(diags ?? []).toEqual([]);
  });

  it("escape-safety: backtick + quote in expected text doesn't break out", () => {
    const adversarial: CliOutputContainsClaim = {
      template: "cli-output-contains",
      route: "pinned doctor",
      text: '"`); throw new Error("rce"); //',
      raw: "",
    };
    const gen = generateCliOutputContainsTest(adversarial, { prId: "pr-1" });
    // JSON.stringify must have escaped every problematic char.
    // The exact JSON-encoded form of the adversarial text must appear
    // verbatim — that proves the embedded value is a string literal,
    // not source code.
    expect(gen.content).toContain(JSON.stringify(adversarial.text));
    expect(gen.content).not.toContain('throw new Error("rce")');
  });

  it("escape-safety: backtick in command is preserved as a JSON string", () => {
    const c: CliOutputContainsClaim = {
      template: "cli-output-contains",
      route: 'pinned doctor"\\`',
      text: "OK",
      raw: "",
    };
    const gen = generateCliOutputContainsTest(c, { prId: "pr-1" });
    expect(gen.content).toContain(JSON.stringify(c.route));
  });

  it("includes repair prompt with the original claim text", () => {
    const gen = generateCliOutputContainsTest(cli, { prId: "pr-42" });
    expect(gen.content).toContain(JSON.stringify(cli.raw));
    expect(gen.content).toContain("PINNED FAILURE");
    expect(gen.content).toContain("npx vitest run tests/pinned/" + gen.filename);
  });

  it("retire hint references the actual claimId", () => {
    const gen = generateCliOutputContainsTest(cli, { prId: "pr-42" });
    expect(gen.content).toContain(`pinned retire ${gen.claimId} --reason="..."`);
  });
});

describe("template generator — cli-exits-zero", () => {
  const claim: CliExitsZeroClaim = {
    template: "cli-exits-zero",
    route: "pinned doctor",
    raw: "`pinned doctor` exits 0",
  };

  it("POSITIVE CONTROL: generates a runnable Vitest with spawnSync + status check", () => {
    const gen = generateCliExitsZeroTest(claim, { prId: "pr-1" });
    expect(gen.filename).toMatch(
      /^pr-1-cli-exits-zero-pinned-doctor-[a-z0-9]+\.test\.ts$/
    );
    expect(gen.content).toContain('import { spawnSync } from "node:child_process"');
    expect(gen.content).toContain('"pinned doctor"');
    expect(gen.content).toContain("result.status !== 0");
  });

  it("argv is tokenized at generation time", () => {
    const gen = generateCliExitsZeroTest(claim, { prId: "pr-1" });
    expect(gen.content).toContain('const ARGV = ["pinned","doctor"]');
  });

  it("escape-safety: adversarial raw text is JSON-encoded (no bare interpolation)", () => {
    const adversarial: CliExitsZeroClaim = {
      template: "cli-exits-zero",
      route: 'pinned "; throw new Error("rce"); //',
      raw: '`pinned "; throw new Error("rce"); //` exits 0',
    };
    const gen = generateCliExitsZeroTest(adversarial, { prId: "pr-1" });
    // The full adversarial string MUST appear JSON-encoded — proves it's
    // a string literal in the generated code, not source code.
    expect(gen.content).toContain(JSON.stringify(adversarial.raw));
    // Bare un-quoted error-throw must NEVER appear — that would indicate
    // the adversarial payload escaped the JSON encoding and is now live code.
    expect(gen.content).not.toContain('throw new Error("rce")');
  });
});

describe("template generator — cli-creates-file", () => {
  const claim: CliCreatesFileClaim = {
    template: "cli-creates-file",
    route: "pinned init",
    filePath: "tests/pinned/.registry.json",
    raw: "`pinned init` creates `tests/pinned/.registry.json`",
  };

  it("POSITIVE CONTROL: generates a Vitest using tempdir + existsSync", () => {
    const gen = generateCliCreatesFileTest(claim, { prId: "pr-1" });
    expect(gen.content).toContain('mkdtempSync(join(tmpdir(), "pinned-creates-file-")');
    expect(gen.content).toContain("existsSync(expected)");
    expect(gen.content).toContain('"tests/pinned/.registry.json"');
  });

  it("generated test refuses absolute / path-traversal expected paths at runtime", () => {
    const gen = generateCliCreatesFileTest(claim, { prId: "pr-1" });
    expect(gen.content).toContain('EXPECTED_FILE.startsWith("/")');
    expect(gen.content).toContain('EXPECTED_FILE.includes("..")');
  });

  it("runs in PINNED_CLI_CWD when set (no tempdir)", () => {
    const gen = generateCliCreatesFileTest(claim, { prId: "pr-1" });
    expect(gen.content).toContain("process.env.PINNED_CLI_CWD");
  });
});

describe("template generator — cli-flag-supported", () => {
  const claim: CliFlagSupportedClaim = {
    template: "cli-flag-supported",
    route: "pinned check",
    flag: "--json",
    raw: "`pinned check` supports `--json`",
  };

  it("POSITIVE CONTROL: generates a Vitest that runs `<cmd> --help` and grep for flag", () => {
    const gen = generateCliFlagSupportedTest(claim, { prId: "pr-1" });
    expect(gen.content).toContain('[...args, "--help"]');
    expect(gen.content).toContain('"--json"');
    expect(gen.content).toContain("combined.includes(FLAG)");
  });

  it("concatenates stdout + stderr so help-to-stderr CLIs still work", () => {
    const gen = generateCliFlagSupportedTest(claim, { prId: "pr-1" });
    expect(gen.content).toContain("(result.stdout ?? \"\") + (result.stderr ?? \"\")");
  });
});

describe("template generator — library-returns", () => {
  const claim: LibraryReturnsClaim = {
    template: "library-returns",
    functionName: "parseConfig()",
    modulePath: "src/config.ts",
    expected: { version: 1 },
    raw: '`parseConfig()` in `src/config.ts` returns `{"version": 1}`',
  };

  it("POSITIVE CONTROL: generates an import + call + JSON deep-equal", () => {
    const gen = generateLibraryReturnsTest(claim, { prId: "pr-1" });
    expect(gen.content).toContain('import { parseConfig } from "../../src/config.ts"');
    expect(gen.content).toContain("const actual = parseConfig();");
    expect(gen.content).toContain('const EXPECTED = {"version":1}');
  });

  it("inlines call args when present (e.g. add(2, 3))", () => {
    const c: LibraryReturnsClaim = {
      template: "library-returns",
      functionName: "add(2, 3)",
      modulePath: "src/math.ts",
      expected: 5,
      raw: "",
    };
    const gen = generateLibraryReturnsTest(c, { prId: "pr-1" });
    expect(gen.content).toContain("const actual = add(2, 3);");
    expect(gen.content).toContain("const EXPECTED = 5");
  });

  it("throws on malformed functionName at generation time", () => {
    const bad: LibraryReturnsClaim = {
      template: "library-returns",
      // missing parens — would fail the regex during parsing, but
      // we double-check at generation time.
      functionName: "parseConfig",
      modulePath: "src/x.ts",
      expected: 1,
      raw: "",
    };
    expect(() => generateLibraryReturnsTest(bad, { prId: "pr-1" })).toThrow(
      /malformed functionName/
    );
  });

  it("normalizes './' prefix in modulePath", () => {
    const c: LibraryReturnsClaim = {
      template: "library-returns",
      functionName: "foo()",
      modulePath: "./src/foo.ts",
      expected: null,
      raw: "",
    };
    const gen = generateLibraryReturnsTest(c, { prId: "pr-1" });
    expect(gen.content).toContain('"../../src/foo.ts"');
    expect(gen.content).not.toContain('"../.././src/foo.ts"');
  });
});

describe("parseSimpleArgv", () => {
  it("tokenizes simple whitespace-separated commands", () => {
    expect(parseSimpleArgv("pinned doctor")).toEqual(["pinned", "doctor"]);
    expect(parseSimpleArgv("npm test")).toEqual(["npm", "test"]);
    expect(parseSimpleArgv("node ./apps/cli/dist/cli.js --version")).toEqual([
      "node",
      "./apps/cli/dist/cli.js",
      "--version",
    ]);
  });

  it("respects double-quoted segments", () => {
    expect(parseSimpleArgv('pinned check --description "Foo bar"')).toEqual([
      "pinned",
      "check",
      "--description",
      "Foo bar",
    ]);
  });

  it("respects single-quoted segments", () => {
    expect(parseSimpleArgv("pinned generate --pr-id 'pr 7'")).toEqual([
      "pinned",
      "generate",
      "--pr-id",
      "pr 7",
    ]);
  });

  it("collapses extra whitespace", () => {
    expect(parseSimpleArgv("   pinned    doctor   ")).toEqual([
      "pinned",
      "doctor",
    ]);
  });

  it("returns empty array for empty input", () => {
    expect(parseSimpleArgv("")).toEqual([]);
    expect(parseSimpleArgv("   ")).toEqual([]);
  });
});

describe("template generators — slugify edge cases", () => {
  it("normalizes nested route paths", () => {
    const gen = generateAuthRequiredTest(
      { template: "auth-required", route: "/api/v2/admin.export", raw: "" },
      { prId: "pr-1" }
    );
    expect(gen.filename).toMatch(
      /^pr-1-auth-required-api-v2-admin-export-[a-z0-9]+\.test\.ts$/
    );
  });

  it("normalizes routes with hyphens", () => {
    const gen = generateRateLimitTest(
      { template: "rate-limit", route: "/api/user-search", rate: 100, window: "second", raw: "" },
      { prId: "pr-1" }
    );
    expect(gen.filename).toMatch(
      /^pr-1-rate-limit-api-user-search-[a-z0-9]+\.test\.ts$/
    );
  });
});
