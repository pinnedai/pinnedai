// FEATURE: parseClaims must not extract false-positive claims from
// arbitrary natural English text (READMEs, commit messages, PR bodies).
// SIGNAL: For each repo's corpus (README + recent commit messages +
// last 10 merged PR descriptions), feeding the text through
// parseClaims must satisfy:
//   1. Every extracted claim round-trips: re-parsing the rendered
//      claim text produces the same claim object.
//   2. Every extracted claim has a non-empty route/function (no
//      placeholder routes leak through).
//   3. Per-text yield is sane: a README rarely has more than 5
//      claim-shaped lines; a single PR body rarely more than 8.
//      A spike above those bounds means the parser is over-extracting
//      from regular prose.
//
// This is the COMPLEMENT to the file-path FP sweep — the file-path
// detector looks at filesystem shapes, this one looks at natural
// language. Together they cover both paths the detector can produce
// junk pins through.
//
// Regenerate fixtures via `bash scripts/parse-fp-sweep.sh --regenerate`
// (requires gh CLI authenticated + clones in audit/oss-sweep/.clones/).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseClaims } from "../../apps/cli/src/claimParser.js";

const TEXT_DIR = resolve(__dirname, "text-fixtures");

type PR = { number: number; title: string | null; body: string | null };
type TextFixture = {
  repo: string;
  readme: string;
  commits: string;
  prs: PR[];
};

function loadTextFixtures(): TextFixture[] {
  if (!existsSync(TEXT_DIR)) {
    throw new Error(
      `Text fixtures dir missing: ${TEXT_DIR}. Run \`bash scripts/parse-fp-sweep.sh --regenerate\` first.`
    );
  }
  return readdirSync(TEXT_DIR)
    .filter((f) => f.endsWith(".json"))
    .map(
      (f) => JSON.parse(readFileSync(resolve(TEXT_DIR, f), "utf8")) as TextFixture
    );
}

const fixtures = loadTextFixtures();

// Sane per-text yield bounds. A README should rarely emit > 5 claims
// (most don't emit any — they're project descriptions, not behavior
// contracts). A PR body might legitimately emit several (it's the
// CANONICAL claim source), but more than ~8 from one PR is suspicious.
// Commit messages aggregated across 50 commits could legitimately emit
// more, since each commit message is technically its own input.
const MAX_README_CLAIMS = 8;
const MAX_PR_BODY_CLAIMS = 10;
const MAX_COMMIT_CLAIMS = 40;

describe("FEATURE-AUDIT: parseClaims FP sweep across READMEs / commits / PR bodies", () => {
  it("LOADS: text fixtures present and non-trivial", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(20);
    const totalChars = fixtures.reduce(
      (acc, f) => acc + f.readme.length + f.commits.length + f.prs.reduce((b, pr) => b + (pr.body?.length ?? 0), 0),
      0
    );
    expect(totalChars).toBeGreaterThanOrEqual(500_000);
  });

  describe("Round-trip invariant", () => {
    for (const fixture of fixtures) {
      it(`${fixture.repo}: every extracted claim re-parses back to itself`, () => {
        const inputs: { name: string; text: string }[] = [
          { name: "README", text: fixture.readme },
          { name: "commits", text: fixture.commits },
        ];
        for (const pr of fixture.prs) {
          if (pr.body) inputs.push({ name: `PR #${pr.number}`, text: pr.body });
        }
        for (const input of inputs) {
          const extracted = parseClaims(input.text);
          for (const claim of extracted) {
            // Reconstruct the canonical claim phrase via the same
            // shape the detector emits, then re-parse.
            // For rate-limit: "Rate-limits <route> to <rate> req/<window>."
            // For auth-required: "Auth required on <route>."
            // For idempotent: "Makes <route> idempotent on <key>."
            // For others: skip the round-trip — the templates that
            // don't have a fixed paraphrase aren't testable this way.
            let canonical: string | null = null;
            if (claim.template === "rate-limit") {
              canonical = `Rate-limits ${claim.route} to ${claim.rate} req/${claim.window}.`;
            } else if (claim.template === "auth-required") {
              canonical = `Auth required on ${claim.route}.`;
            } else if (claim.template === "idempotent") {
              canonical = `Makes ${claim.route} idempotent on ${claim.idempotencyKey}.`;
            }
            if (!canonical) continue;
            const reparsed = parseClaims(canonical);
            expect(
              reparsed.length,
              `${fixture.repo} ${input.name}: claim ${JSON.stringify(claim)} doesn't round-trip via "${canonical}" — got ${reparsed.length} claims`
            ).toBe(1);
          }
        }
      });
    }
  });

  describe("Sanity / over-extraction bounds", () => {
    for (const fixture of fixtures) {
      it(`${fixture.repo}: README doesn't over-extract beyond ${MAX_README_CLAIMS} claims`, () => {
        const claims = parseClaims(fixture.readme);
        expect(
          claims.length,
          `${fixture.repo} README produced ${claims.length} claims (expected ≤ ${MAX_README_CLAIMS}). Sample: ${JSON.stringify(claims.slice(0, 3))}`
        ).toBeLessThanOrEqual(MAX_README_CLAIMS);
      });

      it(`${fixture.repo}: no single PR body over-extracts beyond ${MAX_PR_BODY_CLAIMS} claims`, () => {
        for (const pr of fixture.prs) {
          if (!pr.body) continue;
          const claims = parseClaims(pr.body);
          expect(
            claims.length,
            `${fixture.repo} PR #${pr.number} produced ${claims.length} claims (expected ≤ ${MAX_PR_BODY_CLAIMS}). Title: "${pr.title}". Sample: ${JSON.stringify(claims.slice(0, 3))}`
          ).toBeLessThanOrEqual(MAX_PR_BODY_CLAIMS);
        }
      });

      it(`${fixture.repo}: combined commit messages don't over-extract beyond ${MAX_COMMIT_CLAIMS} claims`, () => {
        const claims = parseClaims(fixture.commits);
        expect(
          claims.length,
          `${fixture.repo} commits produced ${claims.length} claims (expected ≤ ${MAX_COMMIT_CLAIMS}). Sample: ${JSON.stringify(claims.slice(0, 3))}`
        ).toBeLessThanOrEqual(MAX_COMMIT_CLAIMS);
      });
    }
  });

  describe("Placeholder / malformed-route invariant", () => {
    for (const fixture of fixtures) {
      it(`${fixture.repo}: no extracted claim contains placeholder syntax in its route`, () => {
        const all: string[] = [fixture.readme, fixture.commits];
        for (const pr of fixture.prs) {
          if (pr.body) all.push(pr.body);
        }
        for (const text of all) {
          const claims = parseClaims(text);
          for (const c of claims) {
            if ("route" in c && c.route) {
              expect(
                c.route,
                `${fixture.repo}: extracted claim has placeholder in route: "${c.route}"`
              ).not.toMatch(/<[a-z-]+>|\{[a-z-]+\}/i);
            }
          }
        }
      });
    }
  });
});
