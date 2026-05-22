import { describe, it, expect } from "vitest";
import { parseClaims, claimSlug, claimRoute } from "./claimParser.js";

describe("parseClaims — rate-limit", () => {
  it("parses 'Rate-limits /api/users to 60 req/min'", () => {
    const claims = parseClaims("Rate-limits /api/users to 60 req/min.");
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      template: "rate-limit",
      route: "/api/users",
      rate: 60,
      window: "minute",
    });
  });

  it("parses 'Rate limit /api/x to 100 requests per minute'", () => {
    const claims = parseClaims("Rate limit /api/x to 100 requests per minute");
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      template: "rate-limit",
      route: "/api/x",
      rate: 100,
      window: "minute",
    });
  });

  it("parses 'Rate-limited /api/y to 5 calls/sec'", () => {
    const claims = parseClaims("Rate-limited /api/y to 5 calls/sec");
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      template: "rate-limit",
      route: "/api/y",
      rate: 5,
      window: "second",
    });
  });

  it("parses 'Rate-limits /webhook/stripe to 1000 rpm'", () => {
    const claims = parseClaims("Rate-limits /webhook/stripe to 1000 rpm");
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      template: "rate-limit",
      route: "/webhook/stripe",
      rate: 1000,
      window: "minute",
    });
  });

  it("parses rps as second window", () => {
    const claims = parseClaims("rate-limit /foo to 50 rps");
    expect(claims[0]).toMatchObject({ rate: 50, window: "second" });
  });

  it("parses rph as hour window", () => {
    const claims = parseClaims("rate-limit /foo to 3600 rph");
    expect(claims[0]).toMatchObject({ rate: 3600, window: "hour" });
  });

  it("strips trailing punctuation from routes", () => {
    const claims = parseClaims("Rate-limits /api/users, to 60 req/min.");
    expect(claims).toHaveLength(1);
    expect(claimRoute(claims[0])).toBe("/api/users");
  });

  it("is case-insensitive", () => {
    const claims = parseClaims("RATE-LIMITS /api/CAPS to 60 REQ/MIN");
    expect(claims).toHaveLength(1);
    expect(claimRoute(claims[0])).toBe("/api/CAPS");
  });
});

describe("parseClaims — auth-required", () => {
  it("parses 'Auth required on /api/admin/export'", () => {
    const claims = parseClaims("Auth required on /api/admin/export.");
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      template: "auth-required",
      route: "/api/admin/export",
    });
  });

  it("parses 'Authentication required for /api/x'", () => {
    const claims = parseClaims("Authentication required for /api/x");
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      template: "auth-required",
      route: "/api/x",
    });
  });

  it("parses '/api/users requires auth'", () => {
    const claims = parseClaims("/api/users requires auth.");
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      template: "auth-required",
      route: "/api/users",
    });
  });

  it("parses '/api/y requires authentication'", () => {
    const claims = parseClaims("/api/y requires authentication");
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      template: "auth-required",
      route: "/api/y",
    });
  });

  it("dedupes same route phrased two ways", () => {
    const claims = parseClaims(
      "Auth required on /api/admin. Also, /api/admin requires authentication."
    );
    expect(claims).toHaveLength(1);
    expect(claimRoute(claims[0])).toBe("/api/admin");
  });
});

describe("parseClaims — idempotent", () => {
  it("parses 'Makes /webhooks/stripe idempotent on event_id'", () => {
    const claims = parseClaims(
      "Makes /webhooks/stripe idempotent on event_id"
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      template: "idempotent",
      route: "/webhooks/stripe",
      idField: "event_id",
    });
  });

  it("parses '/webhooks/x is idempotent by message_id'", () => {
    const claims = parseClaims("/webhooks/x is idempotent by message_id");
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      template: "idempotent",
      route: "/webhooks/x",
      idField: "message_id",
    });
  });

  it("parses 'Idempotent /webhooks/y using event-id'", () => {
    const claims = parseClaims("Idempotent /webhooks/y using event-id");
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      template: "idempotent",
      route: "/webhooks/y",
      idField: "event-id",
    });
  });

  it("parses 'idempotent /x keyed on requestId'", () => {
    const claims = parseClaims("Made /x idempotent keyed on requestId");
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      template: "idempotent",
      route: "/x",
      idField: "requestId",
    });
  });

  it("strips 'the' prefix from idField", () => {
    const claims = parseClaims(
      "/webhooks/foo is idempotent on the event_id"
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ idField: "event_id" });
  });
});

describe("parseClaims — multi-claim and edge cases", () => {
  it("parses multiple claims from one body", () => {
    const body = `## What this PR does

- Rate-limits /api/users to 60 req/min.
- Auth required on /api/admin/export.
- Makes /webhooks/stripe idempotent on event_id.`;
    const claims = parseClaims(body);
    expect(claims).toHaveLength(3);
    expect(claims.map((c) => c.template).sort()).toEqual([
      "auth-required",
      "idempotent",
      "rate-limit",
    ]);
  });

  it("returns empty array for body with no claims", () => {
    expect(parseClaims("This PR just refactors caching.")).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(parseClaims("")).toEqual([]);
  });

  it("does not falsely match unrelated 'auth' or 'limit' uses", () => {
    expect(parseClaims("This is the auth module.")).toEqual([]);
    expect(parseClaims("There is no rate limit yet.")).toEqual([]);
  });

  it("dedupes identical claims phrased twice", () => {
    const claims = parseClaims(
      "Rate-limits /api/x to 60 req/min. Also rate-limits /api/x to 60 req/min."
    );
    expect(claims).toHaveLength(1);
  });
});

describe("claimSlug", () => {
  it("produces stable kebab-case slugs with a hash suffix to disambiguate same-route claims", () => {
    const slug = claimSlug({
      template: "rate-limit",
      route: "/api/users",
      rate: 60,
      window: "minute",
      raw: "",
    });
    expect(slug).toMatch(/^rate-limit-api-users-[a-z0-9]{1,6}$/);
  });

  it("flattens slashes and dots in nested routes (with hash suffix)", () => {
    const slug = claimSlug({
      template: "auth-required",
      route: "/api/v2/admin.export",
      raw: "",
    });
    expect(slug).toMatch(/^auth-required-api-v2-admin-export-[a-z0-9]{1,6}$/);
  });

  it("disambiguates same-route rate-limits with different rates", () => {
    const a = claimSlug({
      template: "rate-limit",
      route: "/api/users",
      rate: 60,
      window: "minute",
      raw: "",
    });
    const b = claimSlug({
      template: "rate-limit",
      route: "/api/users",
      rate: 100,
      window: "second",
      raw: "",
    });
    expect(a).not.toBe(b);
  });

  it("is deterministic — same claim always produces same slug", () => {
    const c = {
      template: "rate-limit" as const,
      route: "/api/users",
      rate: 60,
      window: "minute" as const,
      raw: "",
    };
    expect(claimSlug(c)).toBe(claimSlug(c));
  });
});

// ---------- cli-output-contains ----------
//
// POSITIVE CONTROL: the canonical phrasing "`cmd` outputs `text`" must
// extract command=cmd, text=text. If this assertion ever fails, the
// regex anchor or backtick handling broke.

describe("parseClaims — cli-output-contains", () => {
  it("POSITIVE CONTROL: parses '`pinned doctor` outputs `tests/pinned/ directory`'", () => {
    const claims = parseClaims(
      "`pinned doctor` outputs `tests/pinned/ directory`."
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      template: "cli-output-contains",
      route: "pinned doctor",
      text: "tests/pinned/ directory",
    });
  });

  it("parses 'prints' as a synonym verb", () => {
    const claims = parseClaims("`pinned list` prints `No pinned tests found`.");
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      template: "cli-output-contains",
      route: "pinned list",
      text: "No pinned tests found",
    });
  });

  it("parses 'reports' as a synonym verb", () => {
    const claims = parseClaims("`pinned --version` reports `0.0.1`.");
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      template: "cli-output-contains",
      route: "pinned --version",
      text: "0.0.1",
    });
  });

  it("parses 'emits' and 'shows' synonyms", () => {
    const a = parseClaims("`pinned init` emits `+ tests/pinned/.gitkeep`.");
    const b = parseClaims("`pinned check` shows `Found 1 claim(s)`.");
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ template: "cli-output-contains", route: "pinned init" });
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ template: "cli-output-contains", route: "pinned check" });
  });

  it("supports surrounding prose: 'Adds `cmd` that outputs `text`'", () => {
    const claims = parseClaims(
      "Adds `pinned doctor` that outputs `All checks passed.`"
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      template: "cli-output-contains",
      route: "pinned doctor",
      text: "All checks passed.",
    });
  });

  it("extracts multiple CLI claims from one description", () => {
    const claims = parseClaims(
      "`pinned doctor` outputs `id-token: write declared`. " +
        "`pinned list` outputs `Pinned claims`. " +
        "`pinned --version` outputs `0.0.1`."
    );
    expect(claims).toHaveLength(3);
    expect(claims.map((c) => claimRoute(c))).toEqual([
      "pinned doctor",
      "pinned list",
      "pinned --version",
    ]);
  });

  it("dedupes identical CLI claims", () => {
    const claims = parseClaims(
      "`pinned doctor` outputs `OK`. `pinned doctor` prints `OK`."
    );
    expect(claims).toHaveLength(1);
  });

  it("treats different expected-text as different claims (same command)", () => {
    const claims = parseClaims(
      "`pinned doctor` outputs `directory`. `pinned doctor` outputs `workflow`."
    );
    expect(claims).toHaveLength(2);
  });

  it("ignores backticked code references without an output verb", () => {
    // "`foo()` is a function" → no verb, no match
    // "`package.json` contains `apiKey`" → "contains" is intentionally excluded
    const a = parseClaims("`parseClaims()` is a function in claimParser.ts.");
    const b = parseClaims("`package.json` contains `apiKey`.");
    expect(a).toHaveLength(0);
    expect(b).toHaveLength(0);
  });

  it("rejects commands that don't look CLI-shaped", () => {
    // Pure punctuation, leading slash, leading digit — none qualify.
    const samples = [
      "`(foo)` outputs `bar`.",
      "`/abs/path/no/space` outputs `bar`.",
      "`123abc` outputs `bar`.",
    ];
    for (const s of samples) {
      const claims = parseClaims(s);
      expect(claims).toHaveLength(0);
    }
  });

  it("accepts non-pinned binaries (npm, node, etc.)", () => {
    const claims = parseClaims(
      "`npm test` outputs `PASS`. `node --version` outputs `v20`."
    );
    expect(claims).toHaveLength(2);
    expect(claims[0]).toMatchObject({ route: "npm test", text: "PASS" });
    expect(claims[1]).toMatchObject({ route: "node --version", text: "v20" });
  });

  it("bounds command + text length at 200 chars (rejects runaway)", () => {
    const longCmd = "pinned " + "a".repeat(300);
    const longTxt = "x".repeat(300);
    const a = parseClaims("`" + longCmd + "` outputs `short`.");
    const b = parseClaims("`pinned doctor` outputs `" + longTxt + "`.");
    // The regex caps each side at 200 chars — a 300-char run won't match.
    expect(a).toHaveLength(0);
    expect(b).toHaveLength(0);
  });

  it("doesn't cross newlines inside backticks", () => {
    // A literal backtick + newline + backtick must NOT be treated as a
    // single span — that would let multiline PR description blocks
    // accidentally merge into one giant route or text slot.
    const body = "`pinned doctor\n` outputs `OK`.";
    const claims = parseClaims(body);
    expect(claims).toHaveLength(0);
  });

  it("slug carries the command without slashes; hash disambiguates same-cmd / different-text", () => {
    const slug1 = claimSlug({
      template: "cli-output-contains",
      route: "pinned doctor",
      text: "tests/pinned/ directory",
      raw: "",
    });
    const slug2 = claimSlug({
      template: "cli-output-contains",
      route: "pinned doctor",
      text: "id-token: write declared",
      raw: "",
    });
    expect(slug1).toMatch(/^cli-output-contains-pinned-doctor-[a-z0-9]{1,6}$/);
    expect(slug1).not.toBe(slug2);
  });
});

describe("parseClaims — cli-exits-zero", () => {
  it("POSITIVE CONTROL: parses '`pinned doctor` exits 0'", () => {
    const claims = parseClaims("`pinned doctor` exits 0 on a healthy repo.");
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      template: "cli-exits-zero",
      route: "pinned doctor",
    });
  });

  it("parses 'exits with status 0' phrasing", () => {
    const claims = parseClaims("`pinned --version` exits with status 0.");
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ template: "cli-exits-zero", route: "pinned --version" });
  });

  it("parses 'exits cleanly' and 'exits successfully'", () => {
    const a = parseClaims("`pinned init` exits cleanly.");
    const b = parseClaims("`pinned check` exits successfully.");
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it("does NOT match 'exits 1' or other non-zero codes", () => {
    const claims = parseClaims("`pinned doctor` exits 1 on a broken repo.");
    expect(claims).toHaveLength(0);
  });

  it("ignores backticked refs without 'exits' verb", () => {
    const claims = parseClaims("`pinned doctor` is a subcommand.");
    expect(claims).toHaveLength(0);
  });
});

describe("parseClaims — cli-creates-file", () => {
  it("POSITIVE CONTROL: parses '`pinned init` creates `tests/pinned/.registry.json`'", () => {
    const claims = parseClaims(
      "`pinned init` creates `tests/pinned/.registry.json`."
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      template: "cli-creates-file",
      route: "pinned init",
      filePath: "tests/pinned/.registry.json",
    });
  });

  it("parses 'writes', 'produces', 'generates' synonyms", () => {
    const a = parseClaims("`pinned init` writes `tests/pinned/PINS.md`.");
    const b = parseClaims("Running `pinned init` produces `tests/pinned/.gitkeep`.");
    const c = parseClaims("`pinned generate` generates `tests/pinned/pr-1.test.ts`.");
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(c).toHaveLength(1);
  });

  it("rejects absolute paths in the expected file slot", () => {
    const claims = parseClaims("`pinned init` creates `/etc/passwd`.");
    expect(claims).toHaveLength(0);
  });

  it("rejects path-traversal in the expected file slot", () => {
    const claims = parseClaims(
      "`pinned init` creates `../../escape.txt`."
    );
    expect(claims).toHaveLength(0);
  });
});

describe("parseClaims — cli-flag-supported", () => {
  it("POSITIVE CONTROL: parses '`pinned check` supports `--json`'", () => {
    const claims = parseClaims("`pinned check` supports `--json` flag.");
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      template: "cli-flag-supported",
      route: "pinned check",
      flag: "--json",
    });
  });

  it("parses 'accepts' synonym", () => {
    const claims = parseClaims("`pinned list` accepts `--include-retired`.");
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ flag: "--include-retired" });
  });

  it("parses 'Adds `--flag` to `cmd`' reverse form", () => {
    const claims = parseClaims(
      "Adds `--dry-run` flag to `pinned generate`."
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      template: "cli-flag-supported",
      route: "pinned generate",
      flag: "--dry-run",
    });
  });

  it("dedupes forward + reverse forms of the same claim", () => {
    const claims = parseClaims(
      "Adds `--json` flag to `pinned check`. `pinned check` supports `--json`."
    );
    expect(claims).toHaveLength(1);
  });

  it("requires a leading dash on the flag (not a random backticked word)", () => {
    const claims = parseClaims("`pinned check` supports `json` flag.");
    expect(claims).toHaveLength(0);
  });
});

describe("parseClaims — library-returns", () => {
  it("POSITIVE CONTROL: parses '`parseConfig()` in `src/config.ts` returns `{\"version\": 1}`'", () => {
    const claims = parseClaims(
      '`parseConfig()` in `src/config.ts` returns `{"version": 1}`.'
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      template: "library-returns",
      functionName: "parseConfig()",
      modulePath: "src/config.ts",
      expected: { version: 1 },
    });
  });

  it("parses 'from' as a module-path connector", () => {
    const claims = parseClaims(
      '`add(2, 3)` from `src/math.ts` returns `5`.'
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      functionName: "add(2, 3)",
      modulePath: "src/math.ts",
      expected: 5,
    });
  });

  it("rejects non-JSON expected values", () => {
    const claims = parseClaims(
      "`compute()` in `src/x.ts` returns `the answer`."
    );
    expect(claims).toHaveLength(0);
  });

  it("rejects absolute / path-traversal module paths", () => {
    const a = parseClaims('`foo()` in `/etc/passwd` returns `1`.');
    const b = parseClaims('`foo()` in `../../escape.ts` returns `1`.');
    expect(a).toHaveLength(0);
    expect(b).toHaveLength(0);
  });

  it("handles nested object expectations", () => {
    const claims = parseClaims(
      '`getUser(1)` in `src/users.ts` returns `{"id": 1, "name": "Alice"}`.'
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      expected: { id: 1, name: "Alice" },
    });
  });
});
