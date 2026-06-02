#!/usr/bin/env node
// pinnedai — pin PR description claims as permanent CI tests.
//
// npm: `pinnedai` (binary name `pinned`)
// Bare `npx pinnedai` runs the `try` demo — zero install, zero config,
// useful results in under ten seconds. Every other command targets the
// regular dev loop: init the repo, check a description, generate
// tests, list what's pinned, retire claims that no longer apply.

import { Command } from "commander";
import process from "node:process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  renameSync,
  lstatSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";

import { execFileSync, spawnSync as childSpawnSync } from "node:child_process";
import {
  parseClaims,
  parseClaimsWithDiagnostics,
  unionClaims,
  describeClaimForUser,
  detectBugFixPhrase,
  claimSlug,
} from "./claimParser.js";
import type { Claim } from "./claimParser.js";
import { classifyPinStrength, type PinStrength } from "./claimParser.js";
import { generateTest } from "./index.js";
import {
  readRegistry,
  writeRegistry,
  addEntry,
  retireEntry,
  countActivePins,
  renderCatchesMarkdown,
  type RegistryEntry,
} from "./registry.js";
import { activeByokProvider } from "./llmDirect.js";
import {
  AGENT_MD,
  AGENT_INSTALL_MARKER_START,
  AGENT_INSTALL_MARKER_END,
  AGENT_RULE_FILE_CANDIDATES,
  agentRulesBlockFor,
} from "./agentRules.js";
import { renderPrComment } from "./prComment.js";
import { verifyDayZero, renderDayZeroSummary } from "./dayZeroVerify.js";
import {
  readConfig as readConfigImport,
  writeConfig,
  modeLabel,
  DEFAULT_CONFIG,
  effectiveMode as effectiveModeImport,
  type AutoProtectMode,
  type PinnedConfig,
} from "./config.js";

// Path-traversal defense — user-supplied ids that land in file paths
// must match this safe alphabet. No slashes, no dots-only, no nul.
const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

function assertSafeId(kind: string, value: string): void {
  if (!SAFE_ID_RE.test(value) || value === "." || value === "..") {
    process.stderr.write(
      `✗ Invalid ${kind} '${value}'. Must match [A-Za-z0-9_-]+ (no slashes, no dots-only).\n`
    );
    process.exit(1);
  }
}

// Confirm the joined path stays inside the parent directory. Defense
// in depth — catches any path traversal that slipped past assertSafeId.
function assertInsideDir(child: string, parent: string): void {
  // Resolve symlinks so we compare canonical paths. macOS process.cwd()
  // returns realpath (e.g. /private/var/...) but the child path passed
  // by the user may not yet exist or may not be realpath-resolved. We
  // compare with symlink resolution on whichever leg exists; fall back
  // to the literal resolve() if realpath fails (file doesn't exist yet).
  const tryReal = (p: string): string => {
    const abs = resolve(p);
    try {
      return require("node:fs").realpathSync(abs);
    } catch {
      // Path doesn't exist yet — still compare with parent's realpath
      // by resolving the parent leg + appending the unresolved tail.
      // Conservative: also try realpath on the closest existing ancestor.
      let probe = abs;
      const segments: string[] = [];
      while (probe && probe !== sep) {
        try {
          const real = require("node:fs").realpathSync(probe);
          return segments.length ? real + sep + segments.reverse().join(sep) : real;
        } catch {
          segments.push(probe.split(sep).pop()!);
          probe = probe.split(sep).slice(0, -1).join(sep) || sep;
        }
      }
      return abs;
    }
  };
  const cr = tryReal(child);
  const pr = tryReal(parent);
  if (cr !== pr && !cr.startsWith(pr + sep)) {
    process.stderr.write(
      `✗ Path escape detected: ${child} is outside ${parent}\n`
    );
    process.exit(1);
  }
}
import {
  scanDiffFull,
  renderSuggestionsHuman,
  renderSuggestionsMarkdown,
  renderTouchedPinsHuman,
  renderTouchedPinsMarkdown,
} from "./scanDiff.js";
import type { ChangedFile } from "./scanDiff.js";
import { llmExtract } from "./llmExtract.js";
import {
  readLastStatus,
  writeLastStatus,
  formatStatusline,
  captureGitState,
  CATCH_HISTORY_LIMIT,
} from "./statusline.js";
import { runSafetyPass, renderSafetyHuman } from "./safetyPass.js";
import { llmSafetySummarize } from "./llmSummarize.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(__dirname, "..", "package.json");
const { version } = JSON.parse(readFileSync(pkgPath, "utf8")) as {
  version: string;
};

const program = new Command();

program
  .name("pinned")
  .description(
    "Pin PR description claims as permanent CI tests. Future regressions break CI with a back-reference to the original PR."
  )
  .version(version);

// One-line banner printed at the start of every command that operates
// on the pin registry. Makes it visible (in local dev + CI logs) that
// pinned is active in the repo.
//
// Suppressed when:
//   - PINNEDAI_QUIET env var is "1" / "true" (case-insensitive)
//   - The current command was invoked with --json or --markdown
//     (would corrupt machine-readable output for pipes like
//      `pinned check --json | jq`)
//   - The current command has --quiet on its argv
function isQuietMode(): boolean {
  const env = (process.env.PINNEDAI_QUIET ?? "").toLowerCase();
  if (env === "1" || env === "true" || env === "yes") return true;
  const argv = process.argv.slice(2);
  if (argv.includes("--quiet") || argv.includes("--json") || argv.includes("--markdown")) {
    return true;
  }
  return false;
}

function readActivePinCount(): number | null {
  // Walk up to 3 levels from cwd looking for tests/pinned/.registry.json.
  // (Most invocations are at the repo root; some are from subdirs.)
  let dir = process.cwd();
  for (let i = 0; i < 3; i++) {
    const candidate = join(dir, "tests", "pinned", ".registry.json");
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf8")) as {
          claims?: Array<{ status: string }>;
        };
        const active = parsed.claims?.filter((c) => c.status === "active") ?? [];
        return active.length;
      } catch {
        return null;
      }
    }
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  return null;
}

function printBanner(): void {
  if (isQuietMode()) return;
  const count = readActivePinCount();
  const countStr =
    count === null
      ? "not initialized"
      : count === 0
        ? "0 pins (try `pinned baseline`)"
        : `${count} active pin${count === 1 ? "" : "s"}`;
  process.stderr.write(`◆ pinned v${version} · ${countStr}\n`);
}

// ---------- try (default) ----------
// The zero-install demo. Runs end-to-end on a synthetic PR body so a
// first-time user sees the wedge without configuring anything.
program
  .command("try", { isDefault: true })
  .description(
    "Run a local demo against a sample PR description — parses claims and prints a generated Vitest file. No config required."
  )
  .action(() => {
    const sample = [
      "## What this PR does",
      "",
      "- Rate-limits /api/users to 60 req/min to stop the scraping abuse from last week.",
      "- Refactors the cache layer (no behavior change).",
      "",
      "## Risk",
      "",
      "Low — limiter middleware is well-tested upstream.",
    ].join("\n");

    out("┌─ pinnedai try ─────────────────────────────────────────");
    out("│ Sample PR description:");
    out("│");
    for (const line of sample.split("\n")) out(`│   ${line}`);
    out("└────────────────────────────────────────────────────────");
    out("");

    const claims = parseClaims(sample);
    out(`Parsed ${claims.length} claim(s):`);
    for (const c of claims) {
      const d = describeClaimForUser(c);
      out(`  • ${d.title}`);
      out(`    Promise: ${d.promise}`);
    }
    out("");

    if (claims.length === 0) {
      out("(No claims matched. That's a parser bug — please report.)");
      return;
    }

    const first = claims[0];
    const gen = generateTest(first, { prId: "pr-demo", pinnedVersion: version });
    out(`Generated test file (would be written to tests/pinned/${gen.filename}):`);
    out("┌────────────────────────────────────────────────────────");
    for (const line of gen.content.split("\n")) out(`│ ${line}`);
    out("└────────────────────────────────────────────────────────");
    out("");

    // Discoverability nudge: if this repo doesn't have Pinned set up
    // yet, point the user at `pinned init` prominently. If it's
    // already set up, just show "what next" hints. This is the C
    // half of A+B+C (postinstall notice + bare-npx init prompt).
    const notInitialized =
      !existsSync(join(process.cwd(), ".pinnedai", "config.json"));
    if (notInitialized) {
      out("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      out("◆ This repo isn't set up for Pinned yet.");
      out("");
      out("  Run \`npx pinnedai init --auto\` to enable auto-protection");
      out("  (pre-commit hook, post-commit auto-verify, Claude statusline).");
      out("");
      out("  Or \`npx pinnedai init --manual\` to pick each piece individually.");
      out("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    } else {
      out("Next:");
      out("  pinned check --description '...'   # parse your real PR description");
      out("  pinned generate --pr-id ... ...    # write test files to disk");
      out("  pinned status                      # see verification streak + state");
    }
    out("");
    out("Docs: https://pinnedai.dev");
  });

// ---------- check ----------
// Parses a description and prints structured claims. Used by the
// GitHub Action wrapper (week 2) + as a fast local dry-run.
program
  .command("check")
  .description(
    "Parse a PR description for claims and report which template each maps to."
  )
  .option(
    "--description <text>",
    "PR description text. If omitted, reads stdin or the GITHUB_PR_BODY env var."
  )
  .option("--json", "Emit JSON for the parsed claims instead of human text.")
  .option("--quiet", "Suppress the pinned banner header.")
  .action(async (opts: { description?: string; json?: boolean }) => {
    printBanner();
    const body = await resolveBody(opts.description);
    if (body == null) {
      // CI-friendly behavior: when running inside a GitHub Actions
      // workflow (GITHUB_ACTIONS=true) and the PR body env var IS set
      // but empty (PR with no description), exit cleanly with zero
      // claims rather than failing the workflow step. Workflows
      // shouldn't fail just because a developer opened a PR with no
      // description.
      const inCi = process.env.GITHUB_ACTIONS === "true";
      const prBodyVarPresent = "GITHUB_PR_BODY" in process.env;
      if (inCi && prBodyVarPresent) {
        if (opts.json) out("[]");
        else out("No claims found (empty PR description).");
        process.exit(0);
      }
      err(
        "✗ No PR description provided. Pass --description, pipe stdin, set GITHUB_PR_BODY, or run `npx pinnedai try` for a demo.\n"
      );
      process.exit(1);
    }
    const regexDiag = parseClaimsWithDiagnostics(body);
    const regexClaims = regexDiag.recognized;
    const llm = await llmExtract(body);
    const llmClaims = llm.ok ? llm.claims : [];
    const claims = unionClaims(regexClaims, llmClaims);
    const llmContribution = claims.length - regexClaims.length;

    // A line was "dropped" by regex if no template matched it. Some of
    // those lines may now be covered by an LLM claim — recompute by
    // checking each dropped line against the unioned claim set.
    const finalCoveredText = claims.map((c) => c.raw.toLowerCase().trim());
    const dropped = regexDiag.dropped.filter((line) => {
      const norm = line.toLowerCase().trim();
      return !finalCoveredText.some(
        (r) => r === norm || norm.includes(r) || r.includes(norm)
      );
    });

    if (opts.json) {
      // Include diagnostics in JSON so consumers (the GitHub Action,
      // PR-comment workflow, etc.) can surface dropped lines too.
      const payload =
        dropped.length > 0 ? { claims, dropped } : claims;
      out(JSON.stringify(payload, null, 2));
      return;
    }
    if (llm.ok && !opts.json) {
      // Floor at 0 — llmContribution can be negative when the LLM
      // returns claims that all overlap with regex hits (dedupe).
      const llmOnly = Math.max(0, llmContribution);
      out(`(${describeLlmMode(llm)}; +${llmOnly} new from LLM)`);
    } else if (!llm.ok && llm.reason === "error") {
      err(`✗ LLM extraction failed: ${llm.error}\n`);
    }
    if (claims.length === 0 && dropped.length === 0) {
      out("No claims found. Examples of claim phrasings Pinned recognizes:");
      out('  "Rate-limits /api/users to 60 req/min."');
      out('  "Auth required on /api/admin/export."');
      out('  "Makes /webhooks/stripe idempotent on event_id."');
      return;
    }
    if (dropped.length > 0) {
      // Surface dropped lines BEFORE the recognized list so users notice
      // them. Otherwise "Found N claim(s)" reads like 100% recognition.
      const total = claims.length + dropped.length;
      out(
        `Recognized ${claims.length} of ${total} claim(s). ${dropped.length} dropped — no template matched their phrasing:`
      );
      for (const d of dropped) out(`  - ${d}`);
      out("");
      out(
        "Tip: rephrase using a supported pattern. Examples:"
      );
      out('         "Rate-limits /api/users to 60 req/min."');
      out('         "Auth required on /api/admin."');
      out('         "GET /dashboard renders without crashing."');
      out('         "POST /api/signup requires fields email, password."');
      out('         "POST /api/signup creates a users record."');
      out(
        "       Or open an issue at https://github.com/pinnedai/pinnedai/issues — we add templates from real claim phrasings."
      );
      out("");
    }
    if (claims.length > 0) {
      out(`Recognized claim(s):`);
      for (const c of claims) out(`  • ${describeClaim(c)}`);
    }
  });

// ---------- generate ----------
// The product action: writes test files to tests/pinned/<pr>-<slug>.test.ts.
program
  .command("generate")
  .description(
    "Generate Vitest file(s) under tests/pinned/ from claims in a PR description."
  )
  .requiredOption(
    "--pr-id <id>",
    "PR identifier — namespaces the generated files (e.g. pr-1247)."
  )
  .option(
    "--description <text>",
    "PR description text. If omitted, reads stdin or the GITHUB_PR_BODY env var."
  )
  .option(
    "--out-dir <path>",
    "Directory to write tests to (default: tests/pinned)",
    "tests/pinned"
  )
  .option(
    "--dry-run",
    "Print generated content to stdout instead of writing files."
  )
  .option(
    "--no-verify",
    "Skip day-zero verification (don't run the new pins against current code right after writing them)."
  )
  .option(
    "--json",
    "Emit structured JSON output for AI-agent consumption. Includes per-pin verification_status (verified | skipped | caught | error)."
  )
  .option("--quiet", "Suppress the pinned banner header.")
  .action(
    async (opts: {
      prId: string;
      description?: string;
      outDir: string;
      dryRun?: boolean;
      verify?: boolean;
      json?: boolean;
    }) => {
      printBanner();
      assertSafeId("--pr-id", opts.prId);
      const body = await resolveBody(opts.description);
      if (body == null) {
        err("✗ No PR description provided.\n");
        process.exit(1);
      }
      const regexDiag = parseClaimsWithDiagnostics(body);
      const regexClaims = regexDiag.recognized;
      const llm = await llmExtract(body);
      const llmClaims = llm.ok ? llm.claims : [];
      const claims = unionClaims(regexClaims, llmClaims);
      // Surface dropped lines from the regex pass that the LLM didn't
      // pick up either. Users explicitly asked for these to be visible
      // (silent failure → looks like 100% recognition).
      const finalCoveredText = claims.map((c) => c.raw.toLowerCase().trim());
      const droppedClaims = regexDiag.dropped.filter((line) => {
        const norm = line.toLowerCase().trim();
        return !finalCoveredText.some(
          (r) => r === norm || norm.includes(r) || r.includes(norm)
        );
      });
      if (llm.ok) {
        out(`(${describeLlmMode(llm)})`);
      }
      if (droppedClaims.length > 0 && !opts.json) {
        const total = claims.length + droppedClaims.length;
        out(
          `Recognized ${claims.length} of ${total} claim(s). ${droppedClaims.length} dropped — no template matched:`
        );
        for (const d of droppedClaims) out(`  - ${d}`);
        out("");
      }
      if (claims.length === 0) {
        // Distinguish "regex found nothing AND LLM also found nothing"
        // from "regex found nothing AND LLM was unavailable (so we
        // never tried the natural-language fallback)." The second case
        // is a Worker outage or no-OIDC-context — the customer's claim
        // may be valid but our parser couldn't reach the LLM. Surface
        // this clearly so they don't think their claim was rejected.
        if (!llm.ok) {
          out("No claims found via regex extraction.");
          if (llm.reason === "no-oidc-context") {
            out("(LLM proposer skipped: BYOK env not set. Set PINNEDAI_BYOK=claude-code");
            out(" or PINNEDAI_BYOK=anthropic|openai|github-models with the matching key");
            out(" for natural-language claim extraction.)");
          } else if (llm.reason === "error") {
            out(`(LLM fallback unavailable: ${llm.error.slice(0, 200)})`);
            out(" Check your BYOK provider's key + connectivity, then re-run.");
          }
        } else {
          out("No claims found — regex + LLM both found nothing.");
        }
        out("Run `pinned check` to see example phrasings Pinned recognizes.");
        return;
      }

      // Bug-fix detection: scan the PR body ONCE for vocabulary like
      // "fix", "regression", "no longer", "bypass" — if any matches,
      // every pin extracted from this PR is stamped bugFixOrigin=true.
      // Bug-fix-origin pins encode a specific failure mode that the PR
      // already fixed, so they're disproportionately likely to catch a
      // real regression later. We use this to order PINS.md and to
      // dial up the celebration when one of them fires a catch.
      //
      // Scan BOTH the body AND the PR title (GITHUB_PR_TITLE env var,
      // set by our GitHub Action). AI agents often put "Fix:" in the
      // title with a generic body — body-only scanning misses these.
      const title = process.env.GITHUB_PR_TITLE ?? "";
      const bugFixPhrase =
        detectBugFixPhrase(title) ?? detectBugFixPhrase(body);
      if (bugFixPhrase !== null) {
        out(`(bug-fix PR — detected "${bugFixPhrase}", pins will be tagged bugFixOrigin)`);
      }

      const outDir = opts.outDir;
      // --out-dir must stay inside the current working directory.
      assertInsideDir(outDir, process.cwd());
      if (!opts.dryRun) {
        mkdirSync(outDir, { recursive: true });
      }

      let registry = opts.dryRun ? null : readRegistry(outDir);

      // No client-side pin cap — every tier gets unlimited pins. The
      // Worker enforces a separate per-month LLM-call cap to bound
      // cost (Free: 100/mo private, 1,000/mo public, Pro: 5K/mo, etc.).

      // Track everything we wrote in this invocation so day-zero
      // verification only runs the NEW files (never re-verifies older
      // unrelated pins as if they were day-zero catches).
      const writtenPins: { filename: string; claim: Claim }[] = [];
      for (const claim of claims) {
        const gen = generateTest(claim, { prId: opts.prId, pinnedVersion: version });
        const target = join(outDir, gen.filename);
        if (opts.dryRun) {
          out(`# ${target}`);
          out(gen.content);
          out("");
          continue;
        }
        assertInsideDir(target, outDir);
        // Race-safe: write with `wx` flag (exclusive create). If
        // another concurrent job already wrote the same file, EEXIST
        // bubbles up and we skip gracefully.
        try {
          writeFileSync(target, gen.content, { flag: "wx" });
          out(`+ ${relative(process.cwd(), target)}`);
          registry = addEntry(registry!, {
            claimId: gen.claimId,
            prId: opts.prId,
            claim,
            filename: gen.filename,
            bugFixOrigin: bugFixPhrase !== null ? true : undefined,
          });
          writtenPins.push({ filename: gen.filename, claim });
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === "EEXIST") {
            out(
              `= ${relative(process.cwd(), target)} (already pinned, skipping)`
            );
            continue;
          }
          throw e;
        }
      }
      const written = writtenPins.length;
      if (!opts.dryRun && registry && written > 0) {
        writeRegistry(outDir, registry);
        out(`~ ${relative(process.cwd(), join(outDir, "PINS.md"))}`);
        stampPinAddedToCache(
          outDir,
          written,
          countActivePins(registry),
          writtenPins.map((p) => summarizeClaimForBanner(p.claim))
        );
      }
      if (!opts.dryRun) {
        out("");
        out(`Pinned ${written} claim(s). Commit them so they join your test suite permanently.`);
      }

      // Day-zero verification — run each newly-written pin against
      // the customer's current code/preview/binary RIGHT NOW. This is
      // the highest single lever for Pinned's catch rate: it surfaces
      // PRs where the description claim doesn't match reality, before
      // the pin file even joins the test suite. False-positive
      // protection (double-confirm + per-template preflight skip) is
      // handled inside verifyDayZero. Opt-out via --no-verify for CI
      // pipelines that want fast generate-only behavior.
      //
      // Commander's --no-FOO flag pattern: opts.verify is false when
      // --no-verify is passed, undefined (truthy by default) otherwise.
      const shouldVerify = opts.verify !== false;
      let verifyVerdicts:
        | Awaited<ReturnType<typeof verifyDayZero>>
        | null = null;
      if (!opts.dryRun && written > 0 && shouldVerify) {
        if (!opts.json) {
          out("");
          out("Verifying pins against your current code...");
        }
        verifyVerdicts = await verifyDayZero({
          cwd: process.cwd(),
          outDir,
          written: writtenPins,
        });
        if (!opts.json) {
          const summary = renderDayZeroSummary(verifyVerdicts);
          if (summary) out(summary);
        }
      }

      // Machine-readable output for AI agents — emit a single JSON
      // blob after writes + verification complete. AI agents reading
      // this can correctly report "verified", "skipped", or "caught"
      // back to the user instead of saying "done" when verification
      // actually skipped. Per GPT prompt-4 finding #6.
      if (opts.json) {
        const verifyByFilename = new Map(
          (verifyVerdicts ?? []).map((v) => [v.filename, v])
        );
        const pinsJson = writtenPins.map((p) => {
          const verdict = verifyByFilename.get(p.filename);
          let verification_status:
            | "verified"
            | "skipped"
            | "caught"
            | "not-run" = "not-run";
          let verification_reason: string | undefined;
          if (verdict) {
            if (verdict.kind === "verified") {
              verification_status = "verified";
            } else if (verdict.kind === "skipped") {
              verification_status = "skipped";
              verification_reason = verdict.reason;
            } else if (verdict.kind === "catch") {
              verification_status = "caught";
              verification_reason = verdict.output.slice(0, 1000);
            }
          } else if (!shouldVerify) {
            verification_status = "not-run";
            verification_reason = "--no-verify flag was passed";
          }
          return {
            template: p.claim.template,
            filename: p.filename,
            verification_status,
            verification_reason,
            claim_raw: p.claim.raw,
          };
        });
        const result = {
          schema: "pinnedai.generate.v1",
          pinned: written,
          pins: pinsJson,
          bugFixDetected: bugFixPhrase,
        };
        out(JSON.stringify(result, null, 2));
      }
    }
  );

// Shared helper — any command that writes new pins should call this so:
//   1. The statusline's "last ran" age resets to "just now"
//   2. The transient "+N pins · M total" celebration fires for ~2 min
//   3. Git state is captured so "changes pending" is suppressed correctly
// Called by `pinned generate` and `pinned protect`. The `auto-protect`
// command already does this inline (with slightly more context).
function stampPinAddedToCache(
  pinDir: string,
  added: number,
  totalAfter: number,
  summaries?: string[]
): void {
  const prev = readLastStatus(pinDir);
  const { sha, dirtyHash } = captureGitState(process.cwd());
  // Spread prev so every existing field (including lastAutoProtectAt,
  // lastAddNotifiedAt) is preserved by default. Only override what
  // this stamp call actually computes.
  writeLastStatus(pinDir, {
    ...(prev ?? {}),
    status: prev?.status ?? "green",
    failingCount: prev?.failingCount ?? 0,
    failingClaimIds: prev?.failingClaimIds ?? [],
    totalPins: totalAfter,
    recentlyAddedCount: added,
    recentlyAddedAt: new Date().toISOString(),
    // Cap stored summaries at 5 entries — the chat hook only renders
    // 5 anyway, and the cache file shouldn't bloat from a 50-pin batch.
    ...(summaries && summaries.length > 0
      ? { recentlyAddedSummaries: summaries.slice(0, 5) }
      : {}),
    lastCheckedSha: sha ?? undefined,
    lastCheckedDirtyHash: dirtyHash ?? undefined,
    updatedAt: new Date().toISOString(),
  });
}

// ---------- init ----------
// One-shot repo scaffold. Writes the GitHub Action workflow and the
// tests/pinned/ directory so a customer goes from `npm i` to working
// CI in a single command.
program
  .command("init")
  .description(
    "Scaffold pinnedai in this repo: GitHub Action workflow + tests/pinned/ directory."
  )
  .option(
    "--force",
    "Overwrite existing files (default: skip with a notice)."
  )
  .option(
    "--yes",
    "Non-interactive: auto-accept the AI-coder rules prompt (for CI / scripts)."
  )
  .option(
    "--no-claude-rules",
    "Non-interactive: skip the AI-coder rules prompt entirely."
  )
  .option(
    "--auto-protect <mode>",
    "Auto-protect mode: safe | ask | off (default: prompt on TTY, 'safe' otherwise)"
  )
  .option(
    "--http <mode>",
    "HTTP-pin verification mode: local | preview | off (default: prompt on TTY, auto-detect from scripts.dev in --auto, 'off' in non-TTY)"
  )
  .option(
    "--auto",
    "Non-interactive: enable everything (safe mode + hooks + statusline + AI rules)."
  )
  .option(
    "--manual",
    "Non-interactive: skip all opt-in installers; ask none."
  )
  .option(
    "--from-agent <consent>",
    "Audit-trail flag for AI agents running install on a user's behalf. Pass the user's literal consent phrase (e.g., --from-agent=\"please set up pinnedai\") — captured to ~/.config/pinnedai/install-prefs.json for compliance review."
  )
  .option(
    "--plan",
    "Dry-run: show every file pinned init would create/modify + every hook it would install, WITHOUT writing anything. Use this before --auto if you want to see what's about to change."
  )
  .option("--quiet", "Suppress the pinned banner header.")
  .action(async (opts: {
    force?: boolean;
    yes?: boolean;
    claudeRules?: boolean;
    autoProtect?: string;
    auto?: boolean;
    manual?: boolean;
    fromAgent?: string;
    plan?: boolean;
  }) => {
    printBanner();
    const cwd = process.cwd();
    const pinnedDir = join(cwd, "tests", "pinned");

    // ---- Preflight: non-git repo ----
    // Pinned's value props rely on git: hooks fire on commit, the
    // GitHub Action runs on PR push, scan-diff needs a base ref. In a
    // non-git directory, we'd write tests/pinned/ + workflow YAML
    // that NEVER fires. That's worse than refusing.
    //
    // Detect: look for .git/ directory (or file — git worktrees use a
    // .git file). If absent, refuse loudly and don't write anything.
    if (!existsSync(join(cwd, ".git"))) {
      err(
        "✗ Pinned needs a git repository.\n" +
          "  This directory has no .git/ — pinned hooks, the GitHub Action, and\n" +
          "  scan-diff all require git state to function. Run:\n" +
          "\n" +
          "    git init\n" +
          "    git add . && git commit -m 'initial commit'\n" +
          "\n" +
          "  Then re-run `pinned init --auto`.\n"
      );
      process.exit(1);
    }

    // ---- Agent audit trail (--from-agent) ----
    // When an AI agent runs `pinned init --auto --from-agent="<consent>"`
    // on the user's behalf, capture the user's literal consent text +
    // the agent identity (best-effort via env vars) into
    // ~/.config/pinnedai/install-prefs.json. This gives compliance-
    // conscious users a paper trail of WHY their hooks/rules were
    // installed by an AI. Best-effort: never fails the install if the
    // home dir is write-restricted or the env vars aren't present.
    if (opts.fromAgent) {
      try {
        const home = process.env.HOME ?? process.env.USERPROFILE;
        if (home) {
          const prefsDir = join(home, ".config", "pinnedai");
          const prefsPath = join(prefsDir, "install-prefs.json");
          mkdirSync(prefsDir, { recursive: true });
          // Append-style: load existing entries, push new, write back.
          let entries: unknown[] = [];
          if (existsSync(prefsPath)) {
            try {
              const raw = JSON.parse(readFileSync(prefsPath, "utf8"));
              if (Array.isArray(raw)) entries = raw;
            } catch {
              /* corrupt → start fresh, don't break install */
            }
          }
          entries.push({
            type: "agent-invoked-init",
            at: new Date().toISOString(),
            cwd,
            consent: opts.fromAgent.slice(0, 500),
            agent: {
              // Best-effort agent detection from env vars set by
              // various AI coding tools. None of these are guaranteed
              // — we just record what we can.
              claude_code: process.env.CLAUDECODE === "1" || process.env.CLAUDE_CODE_VERSION,
              cursor: process.env.CURSOR_INVOCATION === "1",
              copilot: process.env.GITHUB_COPILOT_CLI === "1",
              ci: process.env.CI === "true",
            },
          });
          writeFileSync(prefsPath, JSON.stringify(entries, null, 2) + "\n");
          out(`✓ Recorded agent-invoked install consent in ${prefsPath}`);
        }
      } catch (e) {
        // Audit-trail write is best-effort. Never block install.
        err(`(audit-trail write skipped: ${(e as Error).message})\n`);
      }
    }

    // ---- Top-level: auto or manual mode? ----
    // Auto enables everything; manual asks per piece. Non-TTY uses
    // explicit flags or defaults to manual (silent — never install
    // hooks behind a user's back in CI).
    let setupMode: "auto" | "manual";
    if (opts.auto) setupMode = "auto";
    else if (opts.manual) setupMode = "manual";
    else if (opts.autoProtect && !process.stdin.isTTY) setupMode = "manual";
    else if (!process.stdin.isTTY) setupMode = "manual"; // CI safety
    else setupMode = await promptSetupMode();

    // ---- Auto-protect mode resolution ----
    // Auto setup ⇒ safe. Manual setup ⇒ ask the 3-option prompt (unless
    // --auto-protect <mode> was passed explicitly).
    let mode: AutoProtectMode;
    if (opts.autoProtect) {
      const m = opts.autoProtect.toLowerCase();
      if (m !== "safe" && m !== "ask" && m !== "off") {
        err(`✗ Invalid --auto-protect mode '${opts.autoProtect}'. Use: safe | ask | off\n`);
        process.exit(1);
      }
      mode = m;
    } else if (setupMode === "auto") {
      mode = "safe";
    } else if (!process.stdin.isTTY) {
      mode = DEFAULT_CONFIG.auto_protect;
    } else {
      mode = await promptAutoProtectMode();
    }
    // ---- Vitest: load-bearing dependency for verification ----
    // Pinned generates Vitest tests. Without vitest installed in the
    // customer's repo, `pinned test` fails silently → pin growth
    // never gets verified → catches never fire → product feels broken.
    // This step is intentionally near the top of init because the
    // post-commit auto-test hook later depends on it.
    //
    // SKIP under --plan: dry-run doesn't run package-manager installs.
    // The plan section below reports vitest install state separately.
    const { detectVitest, installVitest, detectPackageManager } = await import(
      "./vitestSetup.js"
    );
    const hasVitest = detectVitest(cwd);
    // Track whether vitest is actually usable at the end of init. If
    // not, init prints a LOUD final banner and exits non-zero in auto
    // mode — so a wrapping AI agent / CI script sees the failure
    // signal instead of believing init succeeded. The Quantasyte
    // dogfood proved this matters: pnpm refused the install with
    // empty stderr, init "succeeded", and pins were silently inert.
    let vitestUsable = hasVitest;
    let vitestFailureDetail: string | null = null;
    if (!opts.plan) {
    const ttyAskForVitest = setupMode === "manual" && process.stdin.isTTY;
    if (hasVitest) {
      out(`✓ Detected vitest in your package.json — pinned will use it.`);
    } else {
      const pm = detectPackageManager(cwd);
      if (setupMode === "auto") {
        // Auto mode: explain loudly, then install. No prompt.
        out("");
        out(`Pinned needs Vitest to actually verify your pins.`);
        out(`Without it, pins are decoration — they never run, never catch regressions.`);
        out(`Installing now via ${pm} (one-time, ~30MB)...`);
        const r = installVitest(cwd);
        if (r.status === "installed") {
          out(`+ vitest@^2 installed via \`${r.command}\``);
          vitestUsable = true;
        } else if (r.status === "no-package-json") {
          out(`! No package.json in this repo — skipped vitest install.`);
          out(`  Run \`${pm} init -y\` then \`${pm} install -D vitest@^2\` manually.`);
          vitestFailureDetail = `no package.json — vitest install skipped`;
        } else if (r.status === "failed") {
          // Show the FULL combined output (stdout + stderr) — pnpm,
          // npm, and yarn all sometimes print user-actionable errors
          // to stdout, not stderr. Truncating to 15 lines so a
          // huge install transcript doesn't bury the banner below.
          out(`✗ vitest install failed (${r.command}, exit ${r.exitCode ?? "?"}):`);
          const combined = `${r.stderr}\n${r.stdout}`.trim();
          const lines = combined.length > 0
            ? combined.split("\n").slice(0, 15)
            : ["(no output captured — the package manager exited non-zero with no stdout/stderr)"];
          for (const line of lines) {
            out(`  | ${line}`);
          }
          out(`  Run manually: \`${installCommandStr(pm, cwd)}\``);
          vitestFailureDetail =
            (combined.split("\n")[0] || `${pm} exited non-zero`).slice(0, 180);
        }
      } else if (ttyAskForVitest) {
        const wantVitest = await promptInstall({
          title: "Install Vitest  ★ REQUIRED FOR VERIFICATION",
          whatItDoes: `Adds \`vitest@^2\` to your devDependencies via ${pm}. Vitest is the test runner Pinned uses for all generated pin tests.`,
          whyYouWant: `★ Without Vitest, \`pinned test\` cannot run — pins never get verified, regressions never get caught, and Pinned is just decoration. Most repos have a test runner already; if yours doesn't, install this one.`,
          touches: `package.json + lockfile + node_modules/vitest (~30MB one-time install).`,
          bypassHint: `If you use a different test runner today, skip this; we'll add support for Jest/Bun in v0.2.`,
          preview: () => `Will run: \`${installCommandStr(pm, cwd)}\``,
        });
        if (wantVitest) {
          const r = installVitest(cwd);
          if (r.status === "installed") {
            out(`+ vitest@^2 installed via \`${r.command}\``);
            vitestUsable = true;
          } else if (r.status === "failed") {
            out(`✗ vitest install failed (${r.command}, exit ${r.exitCode ?? "?"}):`);
            const combined = `${r.stderr}\n${r.stdout}`.trim();
            const lines = combined.length > 0
              ? combined.split("\n").slice(0, 15)
              : ["(no output captured)"];
            for (const line of lines) {
              out(`  | ${line}`);
            }
            out(`  Run manually: \`${installCommandStr(pm, cwd)}\``);
            vitestFailureDetail = (combined.split("\n")[0] || `${pm} exited non-zero`).slice(0, 180);
          }
        } else {
          out(`Skipped vitest install. \`pinned test\` won't run until you add it manually.`);
          vitestFailureDetail = "user declined vitest install";
        }
      } else {
        // Non-TTY without --auto: just warn, don't install behind the scenes.
        out(`! Vitest not detected in package.json — \`pinned test\` will not work until you install it:`);
        out(`  ${installCommandStr(pm, cwd)}`);
        vitestFailureDetail = "vitest not detected and not installed (non-interactive without --auto)";
      }
    }
    } // end if (!opts.plan)

    // Resolve HTTP-pin verification mode BEFORE writing the config.
    // For auto setupMode + no --http flag, picks "local" if scripts.dev
    // is detected, else "off". For manual, asks the 3-option prompt.
    // For non-TTY without --http, stays "off".
    const httpResolution = await resolveHttpConfig({
      setupMode,
      cwd,
      cliOverride: (opts as { http?: string }).http,
    });

    const existingConfig = existsSync(join(cwd, ".pinnedai", "config.json"));
    // --plan: bail BEFORE any writes happen. We've already detected
    // setupMode + auto-protect mode + isGitHubRepo above; that's
    // enough info to print the plan accurately. Skip the config write
    // (and everything below it) so the dry-run is truly read-only.
    if (opts.plan) {
      // Plan section below runs; we fall through to it.
    } else if (!existingConfig || opts.force) {
      const cfg: PinnedConfig = {
        ...DEFAULT_CONFIG,
        auto_protect: mode,
        http: httpResolution.http,
      };
      writeConfig(cwd, cfg);
      out(`+ .pinnedai/config.json (${modeLabel(mode)})`);
      // One line summarizing the HTTP-mode choice so the user knows
      // what was set without reading the config file.
      out(`  ${httpResolution.explainLine}`);
    } else {
      out(`= .pinnedai/config.json (exists, skipping — pass --force to overwrite)`);
    }
    // Detect whether the repo's git remote points at GitHub. The
    // GitHub Actions workflow we'd write is useless for GitLab /
    // Bitbucket / self-hosted Forgejo users — they'd get a YAML file
    // that never runs. Detect and skip the workflow write for those,
    // surfacing a docs/ci-setup.md pointer instead.
    let isGitHubRepo = true;
    let remoteState: "github" | "other" | "none" = "none";
    try {
      const remoteUrl = execFileSync("git", ["remote", "get-url", "origin"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      // Match common GitHub URL forms: https, ssh, git protocol.
      isGitHubRepo =
        remoteUrl.includes("github.com") ||
        remoteUrl.startsWith("git@github.com:");
      remoteState = isGitHubRepo ? "github" : "other";
    } catch {
      // No `origin` remote yet — that's fine for a brand-new repo;
      // write the workflow anyway so it's ready when they push to GH.
      isGitHubRepo = true;
      remoteState = "none";
    }
    if (!isGitHubRepo) {
      out("");
      out("ℹ Detected non-GitHub remote — skipping `.github/workflows/pinned.yml`.");
      out("  For GitLab / CircleCI / Jenkins / other CIs, see:");
      out("  https://pinnedai.dev/docs/ci-setup (copy the relevant snippet into your CI config).");
      out("");
    }

    // ---- --plan: dry-run preview, no writes ----
    // Show every file pinned init would create/modify + every hook
    // it would install. Lets users see exactly what's about to change
    // before running --auto. Exits without writing anything.
    if (opts.plan) {
      out("");
      out("◆ pinned init --plan — DRY RUN (no files will be modified)");
      out("");
      out(`Working directory: ${cwd}`);
      out(`Setup mode: ${setupMode}`);
      out(`Auto-protect mode: ${mode}`);
      out(
        `Git remote: ${
          remoteState === "github"
            ? "GitHub (workflow will be installed)"
            : remoteState === "other"
              ? "non-GitHub (workflow will be SKIPPED — see docs/ci-setup.md)"
              : "none yet (workflow will be installed — ready for when you push to GitHub)"
        }`
      );
      out("");
      out("Files that would be CREATED:");
      out(`  + ${relative(cwd, join(cwd, ".pinnedai", "config.json"))}`);
      if (isGitHubRepo) {
        out(`  + ${relative(cwd, join(cwd, ".github", "workflows", "pinned.yml"))}`);
      }
      out(`  + ${relative(cwd, join(pinnedDir, "README.md"))}`);
      out(`  + ${relative(cwd, join(pinnedDir, ".gitkeep"))}`);
      out(`  + ${relative(cwd, join(pinnedDir, "AGENT.md"))}`);
      out(`  + ${relative(cwd, join(pinnedDir, ".registry.json"))} (empty)`);
      out(`  + ${relative(cwd, join(pinnedDir, "PINS.md"))} (empty)`);
      out("");
      const ai_setup_will_run = setupMode === "auto" && opts.claudeRules !== false;
      if (ai_setup_will_run) {
        out("Files that would be APPENDED to (marker-bounded blocks; existing content preserved):");
        const candidates = [
          "CLAUDE.md",
          ".cursorrules",
          ".clinerules",
          "AGENTS.md",
          ".github/copilot-instructions.md",
        ];
        const existing = candidates.filter((f) => existsSync(join(cwd, f)));
        if (existing.length === 0) {
          // Match the offerAgentRulesInstall fallback: when no AI rule
          // file exists we seed BOTH so the 40-60% VS Code + Copilot
          // Free surface gets the rules.
          out(`  → CLAUDE.md (created — no AI rule file exists yet)`);
          out(`  → .github/copilot-instructions.md (created — so Copilot Chat reads the rules too)`);
        } else {
          for (const f of existing) out(`  → ${f} (appends Pinned rule block)`);
        }
        out("");
      }
      const hooks_will_install = setupMode === "auto";
      if (hooks_will_install) {
        out("Git hooks that would be INSTALLED (marker-bounded; pre-existing hook content preserved):");
        out(`  + .git/hooks/pre-commit  — auto-protect on every commit`);
        out(`  + .git/hooks/pre-push    — pre-push safety scan`);
        out(`  + .git/hooks/post-commit — background verify (throttled to once per 2 min)`);
        out("");
      }
      if (setupMode === "auto") {
        out("Claude Code statusline wiring:");
        out(`  → .claude/settings.json (statusline + UserPromptSubmit hook — deep-merge with existing keys)`);
        out("");
      }
      out("Vitest:");
      try {
        const { detectVitest } = await import("./vitestSetup.js");
        if (detectVitest(cwd)) {
          out(`  ✓ Already installed in this repo — no change`);
        } else {
          out(`  + Will install vitest as dev dependency (setupMode=${setupMode})`);
        }
      } catch {
        out(`  ? Could not detect vitest install state`);
      }
      out("");
      if (opts.fromAgent) {
        out(`Agent audit-trail:`);
        out(`  → ~/.config/pinnedai/install-prefs.json (append consent record)`);
        out("");
      }
      out("To execute this plan, run:  pinned init --auto" + (opts.fromAgent ? ` --from-agent="${opts.fromAgent}"` : ""));
      out("To execute interactively:    pinned init  (asks for confirmation per file)");
      out("");
      return;
    }

    const writes: { path: string; content: string }[] = [
      // Workflow YAML — only write for GitHub-hosted repos.
      ...(isGitHubRepo
        ? [
            {
              path: join(cwd, ".github", "workflows", "pinned.yml"),
              content: WORKFLOW_YAML,
            },
          ]
        : []),
      {
        path: join(pinnedDir, "README.md"),
        content: TESTS_README,
      },
      {
        path: join(pinnedDir, ".gitkeep"),
        content: "",
      },
      // AGENT.md is OURS — we own it, write it on every init, no
      // consent needed (it lives in tests/pinned/, our directory).
      {
        path: join(pinnedDir, "AGENT.md"),
        content: AGENT_MD,
      },
    ];

    for (const w of writes) {
      mkdirSync(dirname(w.path), { recursive: true });
      if (existsSync(w.path) && !opts.force) {
        out(`= ${relative(cwd, w.path)} (exists, skipping — pass --force to overwrite)`);
        continue;
      }
      writeFileSync(w.path, w.content);
      out(`+ ${relative(cwd, w.path)}`);
    }

    // Seed an empty registry + PINS.md so the repo-level visibility
    // surface exists from day 1, even before the first pin.
    const registryPath = join(pinnedDir, ".registry.json");
    const pinsPath = join(pinnedDir, "PINS.md");
    if (!existsSync(registryPath) || opts.force) {
      writeRegistry(pinnedDir, { version: 1, claims: [] });
      out(`+ ${relative(cwd, registryPath)}`);
      out(`+ ${relative(cwd, pinsPath)}`);
    } else {
      out(`= ${relative(cwd, registryPath)} (exists, skipping)`);
    }

    // Ensure .pinnedai/ is gitignored — that directory holds transient
    // state (regenerate-allow marker, BYOK creds, cache, last-status,
    // .last-auto-test). None of it should be committed; some of it
    // would be a security or correctness bug if it were (byok.json
    // contains API keys; the regenerate marker would let stale runs
    // bypass the guard hook in CI).
    const ignoreResult = ensureGitignored(".pinnedai/");
    if (ignoreResult === "added") {
      out(`+ .gitignore (added .pinnedai/ — transient state, must not be committed)`);
    }

    // ---- Per-piece installers ----
    // Auto setupMode answers Y to all. Manual asks per-piece (unless
    // a flag overrides).
    const skipAgentRules = opts.claudeRules === false;
    const installAll = setupMode === "auto" || opts.yes === true;
    const ttyAsk = setupMode === "manual" && process.stdin.isTTY;

    // 1. AI-coder rules in CLAUDE.md / .cursorrules
    if (!skipAgentRules) {
      if (installAll) {
        await offerAgentRulesInstall(cwd, { autoYes: true });
      } else if (ttyAsk) {
        const target = detectAgentRulesTarget(cwd) ?? "CLAUDE.md";
        const yes = await promptInstall({
          title: `AI-coder rules in ${target}`,
          whatItDoes:
            `Adds a marker-bounded block to ${target} telling Claude/Cursor to run pinned tests when they affect changed code, and never delete or weaken pinned tests to make CI pass.`,
          whyYouWant:
            `Without this, AI agents may silently rewrite pinned tests during refactors. With it, every Claude/Cursor session reads the rules at startup and respects your pins.`,
          touches: `${target} (marker-bounded; <!-- pinnedai:start --> ... <!-- pinnedai:end -->)`,
          bypassHint: `npx pinnedai ai-rules uninstall  # removes only the marker block`,
          preview: () => agentRulesBlockFor(target),
        });
        if (yes) await offerAgentRulesInstall(cwd, { autoYes: true });
        else out(`Skipped ${target} rules. Run \`npx pinnedai ai-rules install\` any time.`);
      }
    }

    // 2. Pre-commit hook
    const { installHook, isHookInstalled } = await import("./gitHooks.js");
    const wantPreCommit = installAll
      ? true
      : ttyAsk
        ? await promptInstall({
            title: "Pre-commit git hook",
            whatItDoes:
              `Every \`git commit\` runs \`pinned auto-protect\` against the staged changes. New protectable behaviors (admin routes, CLI subcommands) get auto-pinned and shipped in the same commit.`,
            whyYouWant:
              `Without this, your pin count only grows when you manually run \`pinned auto-protect\`. With it, protection accumulates automatically as you code — no ceremony.`,
            touches: `.git/hooks/pre-commit (idempotent; marker-bounded; preserves any pre-existing hook content)`,
            bypassHint: `PINNEDAI_SKIP_HOOK=1 git commit ...  (one-off)  ·  rm .git/hooks/pre-commit  (permanent)`,
            preview: () => previewHookScript("pre-commit"),
          })
        : false;
    if (wantPreCommit) {
      if (isHookInstalled(cwd, "pre-commit")) {
        out(`= .git/hooks/pre-commit (already installed)`);
      } else {
        const r = installHook(cwd, "pre-commit");
        if (r.status === "installed" || r.status === "appended") {
          out(`+ ${relative(cwd, r.path)} (pre-commit hook ${r.status})`);
        } else if (r.status === "no-git") {
          out(`= pre-commit hook skipped (no .git directory — not a git repo)`);
        }
      }
    } else if (ttyAsk) {
      out(`Skipped pre-commit hook. Run \`pinned hooks install --pre-commit\` any time.`);
    }

    // 3. Pre-push hook
    const wantPrePush = installAll
      ? true
      : ttyAsk
        ? await promptInstall({
            title: "Pre-push git hook",
            whatItDoes:
              `Every \`git push\` runs auto-protect against unpushed commits as a backstop. Catches anything the pre-commit hook missed (e.g. commits made with --no-verify, or commits from other tools).`,
            whyYouWant:
              `Belt-and-suspenders for the pre-commit hook. Cheap insurance: never blocks a push, only adds pins or suggestions before code leaves your machine.`,
            touches: `.git/hooks/pre-push (idempotent; marker-bounded)`,
            bypassHint: `PINNEDAI_SKIP_HOOK=1 git push ...  (one-off)  ·  rm .git/hooks/pre-push  (permanent)`,
            preview: () => previewHookScript("pre-push"),
          })
        : false;

    // 3b. Post-commit hook (auto-verify pins in the background).
    // This is the hook that makes pins actually catch things without
    // the user wiring CI manually — most solo coders won't.
    const wantPostCommit = installAll
      ? true
      : ttyAsk
        ? await promptInstall({
            title: "Post-commit auto-verify hook  ★ STRONGLY RECOMMENDED",
            whatItDoes:
              `Every \`git commit\` runs \`pinned test\` in the background (throttled to once every 2 minutes). Tests run async — commit completes immediately. If a regression breaks a pinned promise, the next chat-hook fire tells Claude.`,
            whyYouWant:
              `★ Without this, Pinned will RARELY catch real regressions — pins only get tested when you manually run \`pinned test\` or wire it into CI, and most solo coders won't do either. Skipping this means pins are mostly decoration. Enabling this is what makes the product actually work.`,
            touches: `.git/hooks/post-commit (idempotent; marker-bounded) + .pinnedai/.last-auto-test (throttle timestamp)`,
            bypassHint: `PINNEDAI_SKIP_HOOK=1 git commit ...  (one-off)  ·  rm .git/hooks/post-commit  (permanent)`,
            preview: () => previewHookScript("post-commit"),
          })
        : false;
    if (wantPrePush) {
      if (isHookInstalled(cwd, "pre-push")) {
        out(`= .git/hooks/pre-push (already installed)`);
      } else {
        const r = installHook(cwd, "pre-push");
        if (r.status === "installed" || r.status === "appended") {
          out(`+ ${relative(cwd, r.path)} (pre-push hook ${r.status})`);
        } else if (r.status === "no-git") {
          out(`= pre-push hook skipped (no .git directory — not a git repo)`);
        }
      }
    }

    if (wantPostCommit) {
      if (isHookInstalled(cwd, "post-commit")) {
        out(`= .git/hooks/post-commit (already installed)`);
      } else {
        const r = installHook(cwd, "post-commit");
        if (r.status === "installed" || r.status === "appended") {
          out(`+ ${relative(cwd, r.path)} (post-commit auto-verify hook ${r.status})`);
        } else if (r.status === "no-git") {
          out(`= post-commit hook skipped (no .git directory — not a git repo)`);
        }
      }
    } else if (ttyAsk) {
      out(`Skipped post-commit auto-verify. Pinned won't auto-run tests; you'll need to wire \`pinned test\` into your CI manually for pins to catch regressions.`);
    }

    // 4. Claude Code statusline (.claude/settings.json)
    const wantStatusline = installAll
      ? true
      : ttyAsk
        ? await promptInstall({
            title: "Claude Code statusline + chat hook",
            whatItDoes:
              `Wires \`pinned statusline\` into the Claude Code bottom bar (\`◆ pinned · 11 pins · ✓\`) and adds a UserPromptSubmit hook that injects one-shot messages when pins are added or broken — so Claude sees them in chat context.`,
            whyYouWant:
              `Without it, you have to run \`pinned status\` to see pin count + state. With it, the AI knows when it broke a pin AND when it just added one, and explains both organically in chat.`,
            touches: `.claude/settings.json (adds statusLine.command + hooks.UserPromptSubmit; preserves any other settings)`,
            bypassHint: `Edit .claude/settings.json by hand to remove the pinned entries.`,
            preview: () => previewClaudeSettings(),
          })
        : false;
    if (wantStatusline) {
      const { installClaudeStatusline, installClaudeFailureHook } = await import(
        "./claudeSettings.js"
      );
      const sl = installClaudeStatusline(cwd);
      if (sl.status === "installed") {
        out(`+ ${relative(cwd, sl.path)} (statusLine wired)`);
        // Also add the failure-only chat hook, same file.
        const fh = installClaudeFailureHook(cwd);
        if (fh.status === "installed") out(`  + UserPromptSubmit failure-hook wired`);
      } else if (sl.status === "already-installed") {
        out(`= ${relative(cwd, sl.path)} (already wired)`);
      } else if (sl.status === "conflict") {
        out(`! ${relative(cwd, sl.path)}: ${sl.reason}`);
      }
    }

    // 4.5. VS Code / Cursor / VSCodium statusline — install the
    // bundled .vsix into whichever editors are on PATH. Cipherwake
    // learned the hard way (May 2026) that Cursor users were missed
    // when their install hook only tried \`code --install-extension\`.
    // We try all known commands and report which editor(s) got it.
    // The .vsix file ships in the pinnedai npm tarball alongside
    // dist/cli.js — see apps/cli/package.json "files".
    try {
      const { fileURLToPath } = await import("node:url");
      const here = fileURLToPath(import.meta.url);
      // dist/cli.js → ../vscode-extension.vsix (one level up from dist/)
      const vsixCandidates = [
        join(dirname(here), "..", "vscode-extension.vsix"),  // installed npm pkg
        join(dirname(here), "..", "..", "vscode-extension.vsix"),  // monorepo: dist/ → apps/cli/
      ];
      let vsixPath = "";
      for (const cand of vsixCandidates) {
        if (existsSync(cand)) { vsixPath = cand; break; }
      }
      // Monorepo source fallback: glob for the newest pinnedai-vscode-*.vsix
      // so version bumps don't strand this lookup.
      if (!vsixPath) {
        try {
          const extDir = join(dirname(here), "..", "..", "..", "vscode-extension");
          if (existsSync(extDir)) {
            const fs = require("node:fs") as typeof import("node:fs");
            const candidates = fs
              .readdirSync(extDir)
              .filter((f) => /^pinnedai-vscode-.*\.vsix$/.test(f))
              .sort()
              .reverse();
            if (candidates[0]) vsixPath = join(extDir, candidates[0]);
          }
        } catch {
          /* fall through */
        }
      }
      if (vsixPath) {
        const editorCmds = ["code", "cursor", "code-insiders", "codium", "vscodium", "windsurf"];
        const installed: string[] = [];
        const failed: string[] = [];
        for (const cmd of editorCmds) {
          try {
            // Check the binary is on PATH.
            execFileSync("command", ["-v", cmd], { stdio: "ignore" });
          } catch {
            continue;
          }
          // Editor is on PATH — try to install (idempotent: --force overwrites
          // any older bundled version without prompting).
          try {
            execFileSync(cmd, ["--install-extension", vsixPath, "--force"], {
              stdio: "ignore",
              timeout: 60_000,
            });
            installed.push(cmd);
          } catch {
            failed.push(cmd);
          }
        }
        if (installed.length > 0) {
          out(`+ Pinned statusline extension installed in: ${installed.join(", ")}`);
        }
        if (installed.length === 0 && failed.length === 0) {
          // No editors found on PATH. Don't yell about it — many users
          // are Claude-Code-only and don't need this. Just note the path.
          out(`  (VS Code / Cursor not detected on PATH — skip extension install.`);
          out(`   To install later: code --install-extension ${vsixPath} --force)`);
        } else if (installed.length === 0 && failed.length > 0) {
          out(`! VS Code/Cursor extension install failed (tried: ${failed.join(", ")}).`);
        }
      }
    } catch (e) {
      // Never block init on the extension install. Silent best-effort.
      void e;
    }

    // 5. LLM-enhanced bug-fix proposer (optional, opt-in).
    //
    // Deterministic detectors catch the canonical shapes (auth, validation,
    // idempotent, rate-limit, permission). LLM mode adds candidate
    // discovery for custom-named helpers and cross-language fixes the
    // regex set misses. The LLM never writes test code — it only
    // proposes signatures that get verified against the actual diff
    // and rendered by the same deterministic templates.
    //
    // Four providers; auto-detect prefers free-to-user options:
    //   1. Claude Code passthrough — `claude` CLI on PATH (uses the
    //      user's Pro/Max subscription, $0 to us, $0 marginal to them)
    //   2. GitHub Models — Microsoft's free LLM tier (free, rate-limited
    //      per GitHub user) — works with GITHUB_TOKEN or a PAT
    //   3. Anthropic API key (BYOK) — `PINNEDAI_ANTHROPIC_KEY`
    //   4. OpenAI API key (BYOK) — `PINNEDAI_OPENAI_KEY`
    //
    // GitHub Copilot ($10/mo VS Code assistant), Cursor Pro, and
    // ChatGPT Plus do NOT expose programmatic LLM access — they're
    // IDE-only and intentionally cannot be used here.
    if (!opts.plan && (installAll || ttyAsk)) {
      const wantLlm = installAll
        ? false // auto mode keeps things conservative; only the deterministic detectors run unless the user opts in here
        : await promptInstall({
            title: "LLM-enhanced bug-fix proposer (optional)",
            whatItDoes:
              `Adds an LLM step to bug-fix mode that proposes pin candidates for behavioral patterns the regex detectors miss (custom helpers, cross-language fixes). The LLM never writes test code — only proposes signatures that pin-render through the same deterministic templates.`,
            whyYouWant:
              `Catches fixes whose auth/validation/idempotency/rate-limit/permission helpers use non-standard names (e.g., \`ensureAuthed()\`, \`assertOwns()\`). Skip if you don't want any network LLM call from pinned.`,
            touches: `No files modified. You'll set environment variables (PINNEDAI_BYOK + one provider-specific key) yourself.`,
            bypassHint: `Don't set PINNEDAI_BYOK — pinned silently runs deterministic-only.`,
            defaultYes: false,
          });
      if (wantLlm) {
        const claudeOnPath = (() => {
          try {
            const { execSync } = require("node:child_process") as typeof import("node:child_process");
            execSync("command -v claude", { stdio: "ignore" });
            return true;
          } catch {
            return false;
          }
        })();
        const ghTokenPresent = Boolean(process.env.PINNEDAI_GITHUB_TOKEN || process.env.GITHUB_TOKEN);
        out("");
        out("LLM provider options — pick one and export the matching env vars:");
        out("");
        out(`  [1] Claude Code passthrough     ${claudeOnPath ? "(detected on PATH — recommended, $0 to you)" : "(install Claude Code first: https://claude.ai/download)"}`);
        out(`        export PINNEDAI_BYOK=claude-code`);
        out("");
        out(`  [2] GitHub Models (Microsoft)   ${ghTokenPresent ? "(GITHUB_TOKEN detected — free tier)" : "(needs a GitHub PAT)"}`);
        out(`        export PINNEDAI_BYOK=github-models`);
        out(`        export PINNEDAI_GITHUB_TOKEN=<your gh PAT or 'gh auth token'>`);
        out("");
        out(`  [3] Anthropic API key (BYOK)`);
        out(`        export PINNEDAI_BYOK=anthropic`);
        out(`        export PINNEDAI_ANTHROPIC_KEY=sk-ant-…`);
        out("");
        out(`  [4] OpenAI API key (BYOK)`);
        out(`        export PINNEDAI_BYOK=openai`);
        out(`        export PINNEDAI_OPENAI_KEY=sk-…`);
        out("");
        out("  Hard kill switch (no LLM call ever):   export PINNEDAI_NO_LLM=1");
        out("");
        out("  GitHub Copilot, Cursor Pro, and ChatGPT Plus subscriptions");
        out("  do NOT expose programmatic LLM access and cannot be used here.");
        out("");
      }
    }

    // === BASELINE SCAN — auto-add high-confidence pins from current code ===
    // Runs ONLY in auto mode + only when not --plan + only when vitest
    // is available (otherwise the pins would be silently inert). The
    // user agreed to this when they picked auto mode (the prompt
    // discloses "Initial baseline scan of your CURRENT code → propose
    // 5-15 candidate pins. High-confidence ones get auto-added").
    //
    // Constraints for auto-add (the "safe" subset):
    //   - suggestedPin must be non-empty AND not a placeholder
    //   - route must be non-empty (no middleware risk-hint pins)
    //   - rule must be in the high-confidence list (Next.js routes,
    //     real webhook handlers with extracted provider names).
    //     Ambiguous handlers/controllers stay as suggestions.
    //   - Capped at MAX_BASELINE_AUTO_PINS so a huge repo doesn't get
    //     50 test files dumped on first install.
    // Anything filtered out is surfaced as a candidate the user can
    // review via `pinned protect`.
    let baselineAutoAdded = 0;
    let baselineSuggested = 0;
    // Track the human-readable description of each added pin so the
    // post-init success message can NAME what was added. "+4 pins" is
    // abstract; "+ Stripe webhook (idempotent), auth on /api/admin, …"
    // is concrete. The user's felt-value comes from knowing what's
    // being protected, not from the count.
    const baselineAddedSummaries: string[] = [];
    const MAX_BASELINE_AUTO_PINS = 10;
    if (setupMode === "auto" && !opts.plan && vitestUsable) {
      try {
        const repoFiles = walkRepo(cwd);
        const changed: ChangedFile[] = repoFiles.map((p) => ({
          path: p,
          status: "added",
        }));
        const baselineRegistry = readRegistry(pinnedDir);
        const baselineResult = scanDiffFull({
          changedFiles: changed,
          prBodyClaims: [],
          existingPins: baselineRegistry.claims,
        });

        // Retroactive coverage — also run the v0.2.5/0.2.6 diff detectors
        // (happy-path / page-renders / validation-rejects-bad) against
        // the CURRENT state of every file in the repo. Without this, an
        // existing-codebase adopter gets only the scanDiffFull suggestions
        // (auth surfaces, lockfile, etc.) — their business-critical
        // happy-path / validation / page contracts stay unpinned, which
        // was confirmed in real dogfooding as the #1 buyer blocker.
        try {
          const {
            detectNewPostEndpointsInDiff: dnp,
            detectNewPagesInDiff: dnpg,
            detectNewValidationSchemasInDiff: dnvs,
          } = await import("./scanDiff.js");
          const retroDiff: import("./scanDiff.js").DiffByFile = new Map();
          for (const p of repoFiles) {
            try {
              const full = join(cwd, p);
              const content = readFileSync(full, "utf8");
              retroDiff.set(p, content.split("\n"));
            } catch {
              /* unreadable file — skip */
            }
          }
          for (const h of dnp(retroDiff)) {
            baselineResult.suggestions.push({
              template: "happy-path-with-side-effect",
              route: h.route,
              reason: `existing ${h.method} endpoint ${h.route} — pin asserts it returns 2xx AND emits X-Pinned-Side-Effect (catches stub-returns-200-without-work bugs). AGENT SETUP REQUIRED for the response wrapper.`,
              suggestedPin: h.suggestedPin,
              files: [h.filePath],
              // Surfaced through the existing safe/ambiguous classifier.
              // happy-path can't auto-create until the customer adds the
              // wrapper, so it stays in "ask" via the round-trip parser.
            } as (typeof baselineResult.suggestions)[number]);
          }
          for (const h of dnpg(retroDiff)) {
            baselineResult.suggestions.push({
              template: "page-renders",
              route: h.route,
              reason: `existing page ${h.route} — pin asserts it renders without crashing (no React/Next/Vite render-error markers in the response).`,
              suggestedPin: h.suggestedPin,
              files: [h.filePath],
            } as (typeof baselineResult.suggestions)[number]);
          }
          for (const h of dnvs(retroDiff)) {
            baselineResult.suggestions.push({
              template: "validation-rejects-bad",
              route: h.route,
              reason: `existing validation schema for ${h.method} ${h.route} (${h.requiredFields.length} required field(s)) — pin asserts each missing-field case 4xx's.`,
              suggestedPin: h.suggestedPin,
              files: [h.filePath],
            } as (typeof baselineResult.suggestions)[number]);
          }
        } catch (e) {
          out(`  ! retroactive detector pass failed (non-fatal): ${(e as Error).message}`);
        }
        // Pin coverage: each suggestion may map back to a rule we know
        // is safe. Since the suggestion type doesn't carry the rule id
        // through (only template + route), we re-classify by template
        // shape: any suggestion whose route is well-formed AND whose
        // suggestedPin parses back is auto-addable. Counters track
        // separately for the summary line.
        const safe: typeof baselineResult.suggestions = [];
        const ambiguous: typeof baselineResult.suggestions = [];
        for (const s of baselineResult.suggestions) {
          // Must have a real route + suggestedPin
          if (!s.route || !s.suggestedPin) {
            ambiguous.push(s);
            continue;
          }
          // Skip the v0.2 env-required placeholder string
          if (s.suggestedPin.includes("ships in v0.2")) {
            ambiguous.push(s);
            continue;
          }
          // Round-trip parseability — if the parser doesn't accept the
          // suggestion, never auto-create from it
          const reparsed = parseClaims(s.suggestedPin);
          if (reparsed.length !== 1) {
            ambiguous.push(s);
            continue;
          }
          safe.push(s);
        }

        let registry = baselineRegistry;
        const prId = `baseline-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;

        // Layer in CLI / package-export / config / lockfile pins from
        // package.json + filesystem scanning. These are HIGH-confidence
        // and work WITHOUT preview-URL infrastructure — biggest
        // day-zero leverage. detectCliLibraryPins emits cli-exits-zero
        // pins from package.json bin entries. We prepend these to the
        // safe[] list so they win the per-template dedup against any
        // overlapping route-based suggestions.
        const { detectCliLibraryPins, detectLockfilePins, detectConfigInvariantPins, detectPackageExportsPins, detectReturnsStatusPins, detectSecretNotPublicPins, detectClientFetchPins, detectWebhookSignaturePins, detectInternalLinkPins, detectPublicExposure } = await import("./scanDiff.js");
        try {
          const cliLibPins = detectCliLibraryPins(cwd);
          for (const p of cliLibPins) {
            if (p.template !== "cli-exits-zero") continue;
            // Prepend so cli-exits-zero pins consume their share of the
            // MAX_BASELINE_AUTO_PINS budget before HTTP suggestions.
            safe.unshift({
              template: "cli-exits-zero",
              route: p.identifier,
              reason: `CLI binary "${p.identifier}" declared in ${relative(cwd, p.sourcePackageJson)} — pin --help still exits 0`,
              suggestedPin: p.suggestedPin,
              files: [p.resolvedPath],
            } as (typeof safe)[number]);
          }
        } catch (e) {
          // Best-effort; don't block init on a CLI-detection error.
          out(`  ! CLI pin detection failed: ${(e as Error).message}`);
        }

        // Config-invariant pins (workflow OIDC perm, CLAUDE.md
        // guardrail block, etc.) bypass parseClaims — they're emitted
        // directly with a deterministic shape from the on-disk content.
        try {
          const configPins = detectConfigInvariantPins(cwd);
          for (const cfg of configPins) {
            const claim = {
              template: "config-invariant" as const,
              configPath: cfg.configPath,
              expected: cfg.expected,
              label: cfg.label,
              raw: `config-invariant ${cfg.label} in ${cfg.configPath}`,
            };
            const gen = generateTest(claim, { prId, pinnedVersion: version });
            const target = join(pinnedDir, gen.filename);
            try {
              assertInsideDir(target, pinnedDir);
              writeFileSync(target, gen.content, { flag: "wx" });
              registry = addEntry(registry, {
                claimId: gen.claimId,
                prId,
                claim,
                filename: gen.filename,
              });
              baselineAutoAdded += 1;
              baselineAddedSummaries.push(summarizeClaimForBanner(claim));
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
                out(`  ! config-invariant pin failed for ${gen.filename}: ${(e as Error).message}`);
              }
            }
          }
        } catch (e) {
          out(`  ! config-invariant pin detection failed: ${(e as Error).message}`);
        }

        // Secret-not-public pin — emitted ONCE when the repo uses
        // a framework with a public env prefix (Next.js / Vite /
        // CRA / SvelteKit / Expo). The pin asserts that no env var
        // with the public prefix has a secret-shaped name.
        try {
          const secretPins = detectSecretNotPublicPins(cwd);
          for (const sp of secretPins) {
            const claim = {
              template: "secret-not-public" as const,
              publicPrefix: sp.publicPrefix,
              secretMarkers: sp.secretMarkers,
              raw: sp.suggestedPin,
            };
            const gen = generateTest(claim, { prId, pinnedVersion: version });
            const target = join(pinnedDir, gen.filename);
            try {
              assertInsideDir(target, pinnedDir);
              writeFileSync(target, gen.content, { flag: "wx" });
              registry = addEntry(registry, {
                claimId: gen.claimId,
                prId,
                claim,
                filename: gen.filename,
              });
              baselineAutoAdded += 1;
              baselineAddedSummaries.push(summarizeClaimForBanner(claim));
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
                out(`  ! secret-not-public pin failed for ${gen.filename}: ${(e as Error).message}`);
              }
            }
          }
        } catch (e) {
          out(`  ! secret-not-public detection failed: ${(e as Error).message}`);
        }

        // Returns-status pins — scan route files for validation
        // library calls (Zod / Yup / Joi / generic `validate(body)`).
        // Each detected validation surface becomes a "POST /route
        // returns 400 on missing body" pin candidate. These require
        // PREVIEW_URL to verify — they enter as suggestions surfaced
        // through the normal `safe[]` pipeline, NOT as auto-added
        // pins, because the HTTP-template skip-without-URL rule
        // applies. We push them into `safe` so they consume the
        // MAX_BASELINE_AUTO_PINS budget and end up as pins.
        try {
          const validationPins = detectReturnsStatusPins(cwd);
          for (const v of validationPins) {
            safe.push({
              template: "returns-status",
              route: v.route,
              reason: `${v.method} ${v.route} — pin will check input validation still rejects bad bodies with ${v.status}`,
              suggestedPin: v.suggestedPin,
              files: [],
            } as (typeof safe)[number]);
          }
        } catch (e) {
          out(`  ! returns-status detection failed: ${(e as Error).message}`);
        }

        // Webhook signature pins — P0 #4. Captures the current
        // signature-verification signature in webhook handler files
        // (Stripe / GitHub / Resend / Twilio / Slack / generic HMAC).
        try {
          const whPins = detectWebhookSignaturePins(cwd);
          for (const wh of whPins) {
            const claim = {
              template: "auth-required" as const,
              route: wh.route,
              raw: wh.suggestedPin,
              staticVerify: { filePath: wh.filePath, signature: wh.signature },
            };
            try {
              const gen = generateTest(claim, { prId, pinnedVersion: version });
              const target = join(pinnedDir, gen.filename);
              try {
                assertInsideDir(target, pinnedDir);
                writeFileSync(target, gen.content, { flag: "wx" });
                registry = addEntry(registry, {
                  claimId: gen.claimId,
                  prId,
                  claim,
                  filename: gen.filename,
                });
                baselineAddedSummaries.push(`${wh.provider} webhook signature still verified in \`${wh.filePath}\` (catches AI stripping the signature check and letting spoofed events through)`);
              } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
                  out(`  ! webhook pin write failed: ${(e as Error).message}`);
                }
              }
            } catch { /* */ }
          }
        } catch (e) {
          out(`  ! webhook signature detection failed: ${(e as Error).message}`);
        }

        // Internal link integrity pins — P0 #5. Captures Next.js /
        // Remix-style internal links + verifies their target route file
        // currently resolves. Future commits that remove the target
        // (or rewrite it past unrecognizability) fail the pin.
        try {
          const linkPins = detectInternalLinkPins(cwd);
          for (const lp of linkPins) {
            if (!lp.expected) continue; // skip when no anchor line could be derived
            const claim = {
              template: "config-invariant" as const,
              configPath: lp.configPath,
              expected: lp.expected,
              label: lp.label,
              raw: lp.suggestedPin,
            };
            try {
              const gen = generateTest(claim, { prId, pinnedVersion: version });
              const target = join(pinnedDir, gen.filename);
              try {
                assertInsideDir(target, pinnedDir);
                writeFileSync(target, gen.content, { flag: "wx" });
                registry = addEntry(registry, {
                  claimId: gen.claimId,
                  prId,
                  claim,
                  filename: gen.filename,
                });
                baselineAddedSummaries.push(`link ${lp.targetRoute} → ${lp.configPath}`);
              } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
                  out(`  ! link pin write failed: ${(e as Error).message}`);
                }
              }
            } catch { /* */ }
          }
        } catch (e) {
          out(`  ! internal-link detection failed: ${(e as Error).message}`);
        }

        // Public exposure checks — P0 #6. Surface as warnings, NOT pins
        // (these are state checks, not behavioral contracts).
        try {
          const exposures = detectPublicExposure(cwd);
          if (exposures.length > 0) {
            out("");
            out(`  ⚠ ${exposures.length} public-exposure finding${exposures.length === 1 ? "" : "s"}:`);
            for (const ex of exposures.slice(0, 5)) {
              out(`      [${ex.severity}] ${ex.kind}: ${ex.path}`);
            }
            if (exposures.length > 5) {
              out(`      ... and ${exposures.length - 5} more (run \`pinned scan-diff --json\` for full list)`);
            }
          }
        } catch (e) {
          out(`  ! public-exposure detection failed: ${(e as Error).message}`);
        }

        // Client-fetch static pins — captures CURRENT auth-headers /
        // error-handling signatures in client API wrappers (apps/app/,
        // src/lib/, src/api/, *Client.ts, *Fetcher.ts). Future edits
        // that strip the pattern fail the static check. Per P0 #2
        // of [[strategic-pivot-guard-integrity]]. Distinct from the
        // diff-aware detector which only fires when a fetch CORRECTNESS
        // PATTERN is being ADDED — this picks up existing ones too.
        try {
          const clientPins = detectClientFetchPins(cwd);
          for (const cf of clientPins) {
            const claim = {
              template: "auth-required" as const,
              route: cf.route,
              raw: cf.suggestedPin,
              staticVerify: { filePath: cf.filePath, signature: cf.signature },
            };
            try {
              const gen = generateTest(claim, { prId, pinnedVersion: version });
              const target = join(pinnedDir, gen.filename);
              try {
                assertInsideDir(target, pinnedDir);
                writeFileSync(target, gen.content, { flag: "wx" });
                registry = addEntry(registry, {
                  claimId: gen.claimId,
                  prId,
                  claim,
                  filename: gen.filename,
                });
                baselineAddedSummaries.push(
                  cf.source === "auth-headers"
                    ? `Client API in \`${cf.filePath}\` keeps its Authorization header (catches AI stripping the auth header from the fetch call)`
                    : cf.source === "error-handling"
                      ? `Client API in \`${cf.filePath}\` keeps error handling (catches AI dropping the \`if (!res.ok)\` check or try/catch wrapper)`
                      : `Client API in \`${cf.filePath}\` keeps its \`${cf.source}\` protection`
                );
              } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
                  out(`  ! client-fetch pin write failed: ${(e as Error).message}`);
                }
              }
            } catch (e) {
              out(`  ! client-fetch pin generate failed: ${(e as Error).message}`);
            }
          }
        } catch (e) {
          out(`  ! client-fetch detection failed: ${(e as Error).message}`);
        }

        // Package-exports-exist pins — emitted when package.json
        // resolves to a buildable entry file with detectable named
        // exports. Bypasses parseClaims (no natural-English form).
        try {
          const exportPins = detectPackageExportsPins(cwd);
          for (const exp of exportPins) {
            const claim = {
              template: "package-exports-exist" as const,
              modulePath: exp.modulePath,
              exports: exp.exports,
              raw: `package-exports-exist ${exp.modulePath} exports ${exp.exports.length}`,
            };
            const gen = generateTest(claim, { prId, pinnedVersion: version });
            const target = join(pinnedDir, gen.filename);
            try {
              assertInsideDir(target, pinnedDir);
              writeFileSync(target, gen.content, { flag: "wx" });
              registry = addEntry(registry, {
                claimId: gen.claimId,
                prId,
                claim,
                filename: gen.filename,
              });
              baselineAutoAdded += 1;
              baselineAddedSummaries.push(summarizeClaimForBanner(claim));
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
                out(`  ! package-exports pin failed for ${gen.filename}: ${(e as Error).message}`);
              }
            }
          }
        } catch (e) {
          out(`  ! package-exports detection failed: ${(e as Error).message}`);
        }

        // Lockfile-integrity pins bypass the suggestion→parseClaims
        // pipeline (the claim shape doesn't have a natural-English form).
        // Generate the pin file directly and stamp the registry.
        try {
          const lockfilePins = detectLockfilePins(cwd);
          for (const lock of lockfilePins) {
            const claim = {
              template: "lockfile-integrity" as const,
              lockfilePath: lock.lockfilePath,
              expectedSha256: lock.expectedSha256,
              packageJsonSha256: lock.packageJsonSha256,
              raw: `lockfile-integrity ${lock.lockfilePath} sha256 ${lock.expectedSha256.slice(0, 12)}`,
            };
            const gen = generateTest(claim, { prId, pinnedVersion: version });
            const target = join(pinnedDir, gen.filename);
            try {
              assertInsideDir(target, pinnedDir);
              writeFileSync(target, gen.content, { flag: "wx" });
              registry = addEntry(registry, {
                claimId: gen.claimId,
                prId,
                claim,
                filename: gen.filename,
              });
              baselineAutoAdded += 1;
              baselineAddedSummaries.push(summarizeClaimForBanner(claim));
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
                out(`  ! lockfile pin failed for ${gen.filename}: ${(e as Error).message}`);
              }
            }
          }
        } catch (e) {
          out(`  ! lockfile pin detection failed: ${(e as Error).message}`);
        }

        for (const s of safe.slice(0, MAX_BASELINE_AUTO_PINS)) {
          const parsed = parseClaims(s.suggestedPin);
          for (const claim of parsed) {
            const gen = generateTest(claim, { prId, pinnedVersion: version });
            const target = join(pinnedDir, gen.filename);
            try {
              assertInsideDir(target, pinnedDir);
              writeFileSync(target, gen.content, { flag: "wx" });
              registry = addEntry(registry, {
                claimId: gen.claimId,
                prId,
                claim,
                filename: gen.filename,
              });
              baselineAutoAdded += 1;
              // Format a short human label per pin: "<template> on <route>"
              // or "<template>: <identifier>". Keeps the summary readable
              // when 10 pins land at once.
              baselineAddedSummaries.push(summarizeClaimForBanner(claim));
            } catch (e) {
              // EEXIST: pin already exists. Don't crash; just skip.
              if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
                // Unknown error — surface but don't abort init.
                out(`  ! baseline auto-pin failed for ${gen.filename}: ${(e as Error).message}`);
              }
            }
          }
        }
        // ── HISTORICAL PASS: run diff-aware detectors against past
        // fix commits and add high-quality "fix-derived" pins. Each
        // pin is filtered: only kept if its signature is STILL present
        // at HEAD. Per the launch direction (2026-05-25), the Tier-3
        // risky templates (module-export at new files, import-path on
        // bare-spec imports, url-literal current-state scan) are gated
        // by their own diff-mode FP guards (file-existed-at-parent,
        // relative-imports-only). This pass is fast (3-10s) and
        // deterministic — LLM enrichment is a separate opt-in command.
        try {
          const { collectHistoricalPinsForInit } = await import("./backtest.js");
          const historicalClaims = await collectHistoricalPinsForInit({
            repoPath: cwd,
            maxFixCommits: 30,
          });
          const historicalRegistry = registry;
          let historicalAdded = 0;
          // Dedup against pins already in the registry (current-state pass
          // may have produced overlapping pins for the same surface).
          const existingKeys = new Set(historicalRegistry.claims.map((c) =>
            `${c.claim.template}:${claimSlug(c.claim)}`
          ));
          for (const claim of historicalClaims) {
            const k = `${claim.template}:${claimSlug(claim)}`;
            if (existingKeys.has(k)) continue;
            existingKeys.add(k);
            const gen = generateTest(claim, { prId, pinnedVersion: version });
            const target = join(pinnedDir, gen.filename);
            try {
              assertInsideDir(target, pinnedDir);
              writeFileSync(target, gen.content, { flag: "wx" });
              registry = addEntry(registry, {
                claimId: gen.claimId,
                prId,
                claim,
                filename: gen.filename,
              });
              baselineAutoAdded += 1;
              historicalAdded += 1;
              baselineAddedSummaries.push(summarizeClaimForBanner(claim));
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
                out(`  ! historical pin failed for ${gen.filename}: ${(e as Error).message}`);
              }
            }
          }
          if (historicalAdded > 0) {
            out(`  + ${historicalAdded} pin${historicalAdded === 1 ? "" : "s"} from past fix commits`);
          }
        } catch (e) {
          // Historical pass failure should never block init.
          out(`  ! historical pass failed: ${(e as Error).message}`);
        }

        if (baselineAutoAdded > 0) {
          writeRegistry(pinnedDir, registry);
          stampPinAddedToCache(
            pinnedDir,
            baselineAutoAdded,
            countActivePins(registry),
            baselineAddedSummaries
          );
          // Emit SAVED event so the statusline shows
          // "Pinned · SAVED · N guards created" for 90 sec.
          try {
            const { recordGuardsSaved } = await import("./statusline.js");
            recordGuardsSaved(pinnedDir, {
              count: baselineAutoAdded,
              summaries: baselineAddedSummaries,
            });
          } catch { /* best-effort */ }
        }
        baselineSuggested =
          ambiguous.length + Math.max(0, safe.length - MAX_BASELINE_AUTO_PINS);
      } catch (e) {
        // Baseline failure should NEVER block init. Surface as a warning.
        out(`  ! baseline scan failed: ${(e as Error).message} — skipping auto-pin`);
      }
    }

    // === FINAL SETUP STATUS ===
    // If vitest didn't end up usable, print a LOUD banner: pinned is
    // effectively inert without a test runner. This is the most
    // important signal in the entire init flow — AI agents wrapping
    // `pinned init` and humans scrolling the terminal both need to
    // see "your setup is broken" before scrolling past.
    out("");
    if (!vitestUsable) {
      out("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      out("✗ INIT INCOMPLETE — Pinned is installed but NOT functional.");
      out("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      out("");
      out("Reason: Vitest is not available in this repo.");
      if (vitestFailureDetail) {
        out(`  ${vitestFailureDetail}`);
      }
      out("");
      out("Without Vitest, `pinned test` cannot run, pins never verify,");
      out("and regressions will NOT be caught. Pinned is decoration");
      out("until you fix this.");
      out("");
      out("To fix:");
      out(`  ${installCommandStr(detectPackageManager(cwd), cwd)}`);
      out("  pinned doctor   # confirm the fix took");
      out("");
      // AI-agent signal: non-zero exit so wrapping CI / agents know.
      // Skip the "all good" footer below — it would mislead.
      process.exit(2);
    }
    out(setupMode === "auto" ? "✓ Pinned is fully set up." : "✓ Pinned setup complete.");
    if (setupMode === "auto" && (baselineAutoAdded > 0 || baselineSuggested > 0)) {
      out("");
      if (baselineAutoAdded > 0) {
        // Banner format per [[ux-banner-unification]] + GPT free-mode
        // launch criteria (2026-05-25): every value-moment event should
        // read as "◆ Pinned · EVENT" with a list of concrete artifacts
        // produced. Substance hasn't changed, just punchier framing so
        // the AHA moment is unambiguous.
        out("◆ Pinned · BASELINE CREATED");
        out("");
        // Split into "Protecting your code" (real user-facing guards)
        // vs "Pinned setup" (self-protection of our own workflow file +
        // CLAUDE.md block). Users care about the first list; the
        // second is just transparency about what we installed.
        // Heuristic: any summary mentioning "GitHub Action" /
        // "AI-coder rules in CLAUDE.md" is self-protection. Everything
        // else is real user-protection.
        const isPinnedSelfSetup = (s: string): boolean =>
          /GitHub Action permission|AI-coder rules in CLAUDE\.md/i.test(s);
        const userGuards = baselineAddedSummaries.filter((s) => !isPinnedSelfSetup(s));
        const pinnedSetup = baselineAddedSummaries.filter((s) => isPinnedSelfSetup(s));
        // Dedupe identical summary lines (e.g. a repo with both
        // package-lock.json AND pnpm-lock.yaml gets the same
        // "Lockfile changes can't sneak past..." label twice). Keep
        // the first occurrence's position.
        const dedupeKeepFirst = (arr: string[]): string[] => {
          const seen = new Set<string>();
          const out: string[] = [];
          for (const s of arr) {
            if (seen.has(s)) continue;
            seen.add(s);
            out.push(s);
          }
          return out;
        };
        const userGuardsUnique = dedupeKeepFirst(userGuards);
        if (userGuardsUnique.length > 0) {
          out(`Protecting your code (${userGuardsUnique.length} guard${userGuardsUnique.length === 1 ? "" : "s"}):`);
          for (const summary of userGuardsUnique) {
            out(`  ✓ ${summary}`);
          }
        } else {
          out("Protecting your code: no specific code-protection guards detected on this repo's first scan.");
          out("(Pinned will add more as you open PRs that pass through the GitHub Action.)");
        }
        if (pinnedSetup.length > 0) {
          out("");
          out(`Pinned setup (${pinnedSetup.length} self-protection guard${pinnedSetup.length === 1 ? "" : "s"} — prevents AI from disabling Pinned itself):`);
          for (const summary of pinnedSetup) {
            out(`  ✓ ${summary}`);
          }
        }
        // Write baseline AI lessons for each guard category we touched.
        // Each appendLesson() call dedupes by guardId, so re-running
        // init is idempotent. Lessons written: short, specific, tied
        // to the guard that created them — per GPT criterion #3.
        try {
          const { appendLesson } = await import("./aiLessons.js");
          const baselineLessons: import("./aiLessons.js").LessonInput[] = [];
          const templatesEmitted = new Set(baselineAddedSummaries.map((s) => s));
          if (templatesEmitted.size > 0) {
            // Group lessons by category — one lesson per category
            // (not per pin) so the file stays scannable. Mirrors
            // GPT's example output: "Created 3 AI lessons" with one
            // line each, not "Created 30 AI lessons" with redundant
            // duplicates.
            const haveSecret = baselineAddedSummaries.some((s) =>
              /secret|VITE_\*|NEXT_PUBLIC|REACT_APP/i.test(s)
            );
            const haveLockfile = baselineAddedSummaries.some((s) =>
              /lockfile|dependency lockfile|package-lock|pnpm-lock/i.test(s)
            );
            const haveExports = baselineAddedSummaries.some((s) =>
              /exports|export|package-exports/i.test(s)
            );
            const haveCli = baselineAddedSummaries.some((s) =>
              /CLI|`pinned |--help|exits 0|runs without crashing/i.test(s)
            );
            const haveConfig = baselineAddedSummaries.some((s) =>
              /github action|workflow|claude\.md|ai-coder rules|config-invariant/i.test(s)
            );
            if (haveSecret) {
              baselineLessons.push({
                guardId: "baseline-secret-not-public",
                title: "Public env-var prefixes never carry secrets",
                pastMistake: "AI tools sometimes rename a server-only env var to start with NEXT_PUBLIC_ / VITE_ / REACT_APP_ — that inlines the secret into the client bundle.",
                rule: "Never use a public-env-prefix (NEXT_PUBLIC_*, VITE_*, REACT_APP_*) for a variable that holds a secret (KEY, TOKEN, PASSWORD, SECRET, etc.).",
                plainEnglish: "Do not expose server secrets with public env prefixes.",
                kind: "baseline",
              });
            }
            if (haveLockfile) {
              baselineLessons.push({
                guardId: "baseline-lockfile-integrity",
                title: "Lockfile changes require package.json changes",
                pastMistake: "AI tools sometimes regenerate the lockfile without bumping package.json — transitive deps silently shift, build becomes mystery-fragile.",
                rule: "Do not regenerate the lockfile without a matching package.json change. If a dep update is intended, bump package.json first.",
                plainEnglish: "Do not regenerate the lockfile without a real dep change.",
                kind: "baseline",
              });
            }
            if (haveExports) {
              baselineLessons.push({
                guardId: "baseline-package-exports",
                title: "Public package exports stay exported",
                pastMistake: "AI tools sometimes remove or rename a named export in a public entry file; consumers fail at runtime.",
                rule: "Do not remove exported entry-point symbols without confirming no public consumer relies on them.",
                plainEnglish: "Do not remove exported entry-point symbols.",
                kind: "baseline",
              });
            }
            if (haveCli) {
              baselineLessons.push({
                guardId: "baseline-cli-exits-zero",
                title: "CLI binaries keep working",
                pastMistake: "AI tools sometimes delete a CLI command's `bin` entry or break the `--help` invocation.",
                rule: "Do not break the CLI binary's basic invocation (--help, --version) without checking the bin entry in package.json still resolves.",
                plainEnglish: "Do not break the CLI binary's --help command.",
                kind: "baseline",
              });
            }
            if (haveConfig) {
              baselineLessons.push({
                guardId: "baseline-guard-integrity",
                title: "Pinned tests and workflow are protected",
                pastMistake: "AI tools sometimes try to make CI green by deleting / skipping / weakening pinned tests, or by disabling the Pinned GitHub Action.",
                rule: "Do not delete tests/pinned/* files, do not add .skip() to pinned tests, do not weaken assertions in pinned tests, do not modify .github/workflows/pinned.yml. If a pinned test is genuinely outdated, retire it: `pinned retire <claim-id>`.",
                plainEnglish: "Do not weaken pinned tests to make CI pass.",
                kind: "baseline",
              });
            }
          }
          let lessonsAdded = 0;
          const lessonsAddedTitles: string[] = [];
          for (const lesson of baselineLessons) {
            const result = appendLesson(lesson, { repoRoot: cwd });
            if (result.added) {
              lessonsAdded += 1;
              lessonsAddedTitles.push(lesson.plainEnglish);
            }
          }
          if (lessonsAdded > 0) {
            out("");
            out(`Created ${lessonsAdded} AI lesson${lessonsAdded === 1 ? "" : "s"}:`);
            for (const t of lessonsAddedTitles) {
              out(`✓ ${t}`);
            }
          }
        } catch (e) {
          out(`  ! AI lessons emission failed: ${(e as Error).message}`);
        }

        out("");
        out(
          `   How this protects you:\n` +
          `   • Guards: if a future commit breaks any of them, your tests fail in CI and Pinned tells you.\n` +
          `   • AI lessons: read by Claude / Cursor / Devin before they edit your repo, so they avoid repeating these mistakes.`
        );
        out("");
        out("Next:");
        out("  npx pinned audit --learned   # check similar code paths for the same issues");
      }
      if (baselineSuggested > 0) {
        out("");
        out(
          `? ${baselineSuggested} more pattern${baselineSuggested === 1 ? "" : "s"} worth a look — Pinned found them but isn't sure they're worth pinning. Run \`pinned protect\` to review.`
        );
      }
    }
    out("");
    if (wantPreCommit && wantPostCommit) {
      out("✓ Auto-protection is wired — just commit normally. Pinned does the work.");
      out("");
      out("  · git commit  → Pinned scans your diff. New auth checks, routes,");
      out("                   webhooks, env edits get auto-pinned (pre-commit hook).");
      out("  · git commit  → existing pins re-verify in the background (post-commit).");
      out("  · git push    → backstop scan (pre-push hook).");
      out("");
      out("  You don't need to write claim text. Pinned learns from your diffs.");
      out("  Future AI edits that weaken / skip / delete a guard get blocked at commit.");
    } else if (wantPreCommit) {
      out("✓ Pre-commit hook installed — Pinned auto-pins new guards on every commit.");
      out("  You don't need to write claim text. Pinned learns from your diffs.");
    } else {
      out("◆ Pinned is scaffolded. To enable auto-pin-on-commit, re-run with --auto");
      out("  or install the pre-commit hook manually (see docs/integrations).");
    }
    out("");
    out("Other useful commands:");
    out("  pinned list                 # all pins (one line each)");
    out("  pinned show <pin-id>        # what a pin asserts + what would make it fail");
    out("  pinned status               # see pins + risks + safety + breaks caught");
    out("  pinned auto-protect         # one-shot scan of working tree (without committing)");
    out("  npx pinnedai try            # zero-config demo");
    out("");
    out("If you want to pin a behavior from a PR description manually:");
    out("  pinned check --description \"Auth required on /api/admin\"");
    out("  pinned generate --pr-id pr-123 --description \"...\"");
    out("");
    out("Add to Claude Code (optional):");
    out("  pinned install-claude       # /pinned-status, /pinned-list, /pinned-review, /pinned-done");
    out("  Note: the Pinned statusline ('◆ pinned · N guards') only appears when");
    out("  Claude Code is launched from inside this project directory. If you launched");
    out("  from a parent dir, restart Claude Code from here to see it.");
    if (wantPreCommit) {
      out("");
      out("Set PINNEDAI_SKIP_HOOK=1 on any git command to bypass auto-protect for one commit.");
    }
  });

// ---------- ai-rules install ----------
// Retroactive opt-in: for users who said N on init, or who skipped the
// prompt entirely (non-TTY install). Always shows a diff and asks for
// confirmation before writing.
program
  .command("ai-rules")
  .description("Manage the AI-coder rules reference in CLAUDE.md / .cursorrules.")
  .argument("<action>", "Action to take: install | show | uninstall")
  .option(
    "--target <file>",
    "Specific file to update (default: auto-detect CLAUDE.md / .cursorrules)"
  )
  .option("--yes", "Skip the confirm prompt (CI / scripts).")
  .option("--quiet", "Suppress the pinned banner header.")
  .action(async (action: string, opts: { target?: string; yes?: boolean }) => {
    printBanner();
    const cwd = process.cwd();
    if (action === "install") {
      await installAgentRules(cwd, { autoYes: opts.yes ?? false, target: opts.target });
    } else if (action === "show") {
      const target = opts.target ?? detectAgentRulesTarget(cwd) ?? "CLAUDE.md";
      out(`Would write to ${target}:`);
      out("");
      out(agentRulesBlockFor(target));
    } else if (action === "uninstall") {
      await uninstallAgentRules(cwd, { target: opts.target });
    } else {
      err(`✗ Unknown action '${action}'. Use: install | show | uninstall\n`);
      process.exit(1);
    }
  });

// ---------- AI-rules helpers ----------

function detectAgentRulesTarget(cwd: string): string | null {
  // Backward-compat single-target detector. Used by `pinned ai-rules
  // status / install --target=<file> / uninstall` which all operate
  // on one file at a time. The multi-target install path in
  // offerAgentRulesInstall calls detectAllAgentRulesTargets instead.
  for (const candidate of AGENT_RULE_FILE_CANDIDATES) {
    if (existsSync(join(cwd, candidate))) return candidate;
  }
  return null;
}

// Detect EVERY rule file present in the repo. A repo can have
// multiple (CLAUDE.md for Claude Code, .cursorrules for Cursor,
// copilot-instructions.md for Copilot, etc.) and a single dev
// switching between AI tools needs Pinned rules visible to all of
// them. Returns the list in AGENT_RULE_FILE_CANDIDATES order — empty
// when none exist (caller falls back to creating CLAUDE.md).
function detectAllAgentRulesTargets(cwd: string): string[] {
  const found: string[] = [];
  for (const candidate of AGENT_RULE_FILE_CANDIDATES) {
    if (existsSync(join(cwd, candidate))) found.push(candidate);
  }
  return found;
}

async function offerAgentRulesInstall(
  cwd: string,
  opts: { autoYes: boolean }
): Promise<void> {
  // Multi-tool support: write the rule block to EVERY AI-rule file
  // the repo already has. A dev using both Claude Code and Cursor
  // (very common) would otherwise only get rules in one of the two,
  // leaving the other AI context unaware. Marker-bounded blocks
  // mean removing the rule from any file is the same uninstall flow.
  const detected = detectAllAgentRulesTargets(cwd);
  // Fallback when no AI rule files exist yet: create BOTH `CLAUDE.md`
  // (the canonical convention our docs point to) and
  // `.github/copilot-instructions.md` (the 40–60% VS Code + Copilot Free
  // surface). Writing only CLAUDE.md leaves Copilot Chat unable to see
  // Pinned's rules — that's the dominant AI-coder surface on stock VS
  // Code so we always seed it. If the user has Copilot disabled, an
  // unread instructions file is harmless.
  const targets =
    detected.length > 0
      ? detected
      : ["CLAUDE.md", ".github/copilot-instructions.md"];

  for (const target of targets) {
    await installRulesToOneFile(cwd, target, {
      autoYes: opts.autoYes,
      verbose: targets.length === 1, // only narrate when single-target
    });
  }
  if (targets.length > 1) {
    out(`✓ Wrote Pinned AI-coder rules to ${targets.length} files (${targets.join(", ")}).`);
  }
}

async function installRulesToOneFile(
  cwd: string,
  target: string,
  opts: { autoYes: boolean; verbose: boolean }
): Promise<void> {
  const targetPath = join(cwd, target);

  // Already installed? Skip silently — idempotent.
  if (existsSync(targetPath)) {
    const existing = readFileSync(targetPath, "utf8");
    if (existing.includes(AGENT_INSTALL_MARKER_START)) {
      return;
    }
  }

  const verb = existsSync(targetPath) ? "Add a section to" : "Create";
  if (opts.verbose) {
    out("");
    out(`Pinned can add AI-coder instructions to ${target} so your AI remembers`);
    out("to run Pinned before finishing changes.");
    out("");
  }

  let choice: "Y" | "S" | "N";
  if (opts.autoYes) {
    choice = "Y";
    out(`${verb} ${target}? [auto-yes via --yes flag]`);
  } else if (!process.stdin.isTTY) {
    // Non-interactive (CI, piped install, etc.) — don't hang, just skip.
    out(`${verb} ${target}? [skipped — non-interactive shell]`);
    out("");
    out(`Run \`npx pinnedai ai-rules install\` any time to add it later.`);
    return;
  } else {
    choice = await promptYSN(`${verb} ${target}?`);
  }

  if (choice === "N") {
    out(`Skipped. You can run \`npx pinnedai ai-rules install\` later if you change your mind.`);
    return;
  }
  if (choice === "S") {
    out("");
    out(`-- preview of what would be added to ${target} --`);
    out(agentRulesBlockFor(target));
    out(`-- end preview --`);
    out("");
    const second = process.stdin.isTTY
      ? await promptYSN(`${verb} ${target}?`)
      : "N";
    if (second !== "Y") {
      out(`Skipped. Run \`npx pinnedai ai-rules install\` later if you change your mind.`);
      return;
    }
  }

  await writeAgentRulesBlock(targetPath, target);
  out(`+ ${relative(cwd, targetPath)} (pinnedai block added)`);
  out("");
  out(`-- added to ${target} --`);
  out(agentRulesBlockFor(target));
  out(`-- end --`);
  out("");
}

async function installAgentRules(
  cwd: string,
  opts: { autoYes: boolean; target?: string }
): Promise<void> {
  const target =
    opts.target ?? detectAgentRulesTarget(cwd) ?? "CLAUDE.md";
  const targetPath = join(cwd, target);

  if (existsSync(targetPath)) {
    const existing = readFileSync(targetPath, "utf8");
    if (existing.includes(AGENT_INSTALL_MARKER_START)) {
      out(`= ${relative(cwd, targetPath)} (pinnedai block already present, skipping)`);
      return;
    }
  }

  out(`Would write to ${target}:`);
  out("");
  out(agentRulesBlockFor(target));
  out("");

  if (!opts.autoYes) {
    if (!process.stdin.isTTY) {
      err("✗ ai-rules install requires --yes in non-interactive shells.\n");
      process.exit(1);
    }
    const choice = await promptYSN(`Confirm install to ${target}?`);
    if (choice !== "Y") {
      out("Skipped.");
      return;
    }
  }

  await writeAgentRulesBlock(targetPath, target);
  out(`+ ${relative(cwd, targetPath)} (pinnedai block added)`);
  out("");
  out(`-- added to ${target} --`);
  out(agentRulesBlockFor(target));
  out(`-- end --`);
  out("");
}

async function uninstallAgentRules(
  cwd: string,
  opts: { target?: string }
): Promise<void> {
  const target =
    opts.target ?? detectAgentRulesTarget(cwd) ?? "CLAUDE.md";
  const targetPath = join(cwd, target);
  if (!existsSync(targetPath)) {
    out(`= ${relative(cwd, targetPath)} (does not exist)`);
    return;
  }
  const existing = readFileSync(targetPath, "utf8");
  const startIdx = existing.indexOf(AGENT_INSTALL_MARKER_START);
  const endIdx = existing.indexOf(AGENT_INSTALL_MARKER_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    out(`= ${relative(cwd, targetPath)} (no pinnedai block found)`);
    return;
  }
  const before = existing.slice(0, startIdx).trimEnd();
  const after = existing.slice(endIdx + AGENT_INSTALL_MARKER_END.length);
  writeFileSync(targetPath, (before + "\n" + after.trimStart()).trimEnd() + "\n");
  out(`~ ${relative(cwd, targetPath)} (pinnedai block removed)`);
}

async function writeAgentRulesBlock(
  targetPath: string,
  targetFile: string
): Promise<void> {
  mkdirSync(dirname(targetPath), { recursive: true });
  const block = agentRulesBlockFor(targetFile);
  if (existsSync(targetPath)) {
    const existing = readFileSync(targetPath, "utf8");
    writeFileSync(targetPath, existing.replace(/\s*$/, "") + "\n\n" + block);
  } else {
    // File doesn't exist — create it with just the marked block.
    const heading = targetFile === "CLAUDE.md" || targetFile === "AGENTS.md"
      ? `# ${targetFile.replace(".md", "")} rules\n\n`
      : "";
    writeFileSync(targetPath, heading + block);
  }
}

// Top-level setup-mode prompt. Asks ONE question, recommends auto.
// "auto" means: safe auto-protect + pre-commit hook + pre-push hook +
// Claude statusline + AI-coder rules. "manual" falls through to the
// individual prompts for each piece.
// Resolve the HTTP-pin verification mode. Three sources, in priority:
//   1. --http <mode> CLI flag (CI / scripted installs)
//   2. Auto-mode smart default: if package.json declares scripts.dev,
//      use "local" mode with that script. Otherwise, "off" (HTTP pins
//      saved but skipped until the user wires preview-URL).
//   3. Manual mode: ask the user (local / preview / skip).
//
// Returns the resolved HttpConfig + a one-line explanation suitable
// for the post-init banner ("HTTP testing: local mode (uses `npm run
// dev`)") so the user knows what was picked.
type HttpResolution = {
  http: typeof DEFAULT_CONFIG.http;
  explainLine: string;
};

async function resolveHttpConfig(opts: {
  setupMode: "auto" | "manual";
  cwd: string;
  cliOverride?: string;
}): Promise<HttpResolution> {
  // 1. CLI flag override.
  if (opts.cliOverride) {
    const mode = opts.cliOverride.toLowerCase();
    if (mode !== "local" && mode !== "preview" && mode !== "off") {
      err(`✗ Invalid --http '${opts.cliOverride}'. Use: local | preview | off\n`);
      process.exit(1);
    }
    return resolveHttpDefaults(mode as "local" | "preview" | "off", opts.cwd);
  }

  // 2. Auto-mode smart default.
  if (opts.setupMode === "auto") {
    return resolveHttpDefaults("auto-detect", opts.cwd);
  }

  // 3. Non-TTY without an explicit flag → keep HTTP off (CI safety).
  if (!process.stdin.isTTY) {
    return resolveHttpDefaults("off", opts.cwd);
  }

  // 4. Manual mode interactive prompt.
  const detected = detectDevScript(opts.cwd);
  const choice = await promptHttpMode(detected);
  return resolveHttpDefaults(choice, opts.cwd);
}

function resolveHttpDefaults(
  mode: "local" | "preview" | "off" | "auto-detect",
  cwd: string
): HttpResolution {
  if (mode === "auto-detect") {
    const detected = detectDevScript(cwd);
    if (detected) {
      return {
        http: {
          mode: "local",
          start: detected.startCmd,
          url: detected.guessedUrl,
          ready_path: "/",
          timeout_seconds: 60,
        },
        explainLine: `HTTP testing: local mode (will spawn \`${detected.startCmd}\` when you run \`pinned test\`)`,
      };
    }
    return {
      http: { ...DEFAULT_CONFIG.http, mode: "off" },
      explainLine: `HTTP testing: off (no \`scripts.dev\` in package.json — HTTP pins will skip until you set PREVIEW_URL or enable local mode)`,
    };
  }
  if (mode === "local") {
    const detected = detectDevScript(cwd);
    const start = detected?.startCmd ?? "npm run dev";
    const url = detected?.guessedUrl ?? "http://localhost:3000";
    return {
      http: { mode: "local", start, url, ready_path: "/", timeout_seconds: 60 },
      explainLine: `HTTP testing: local mode (will spawn \`${start}\` when you run \`pinned test\`)`,
    };
  }
  if (mode === "preview") {
    return {
      http: { ...DEFAULT_CONFIG.http, mode: "preview" },
      explainLine: `HTTP testing: preview mode (set PREVIEW_URL in your CI to the deploy URL)`,
    };
  }
  return {
    http: { ...DEFAULT_CONFIG.http, mode: "off" },
    explainLine: `HTTP testing: off (HTTP pins will skip until you configure)`,
  };
}

// Sniff package.json for a `scripts.dev` (or `scripts.start`) entry +
// guess the default port for the detected framework. Returns null when
// no usable script is found.
function detectDevScript(
  cwd: string
): { startCmd: string; guessedUrl: string } | null {
  const pkgPath = join(cwd, "package.json");
  if (!existsSync(pkgPath)) return null;
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    return null;
  }
  const scripts = (pkg.scripts ?? {}) as Record<string, string | undefined>;
  const dev = scripts.dev ?? scripts.start;
  if (!dev) return null;
  // Pick a default port by framework heuristic:
  //   - Vite (5173), Astro (4321), Hono (3000), Next.js (3000),
  //     SvelteKit (5173), Remix (3000), Nuxt (3000)
  // Conservative default: 3000.
  const deps = {
    ...(pkg.dependencies as Record<string, unknown> | undefined),
    ...(pkg.devDependencies as Record<string, unknown> | undefined),
  } as Record<string, unknown>;
  let port = 3000;
  if (deps.vite || deps["@sveltejs/kit"]) port = 5173;
  if (deps.astro) port = 4321;
  return {
    startCmd: "npm run dev",
    guessedUrl: `http://localhost:${port}`,
  };
}

async function promptHttpMode(
  detected: { startCmd: string; guessedUrl: string } | null
): Promise<"local" | "preview" | "off"> {
  const detectedLine = detected
    ? `\n     Detected: \`${detected.startCmd}\` → ${detected.guessedUrl}`
    : "";
  process.stdout.write(
    [
      "",
      "How should Pinned test HTTP pins?",
      "",
      `  1. Use my local dev server (recommended for solo work)${detectedLine}`,
      "       Pinned will spawn `npm run dev` during `pinned test`, run pins",
      "       against it, then shut down the process it started.",
      "",
      "  2. Use a preview URL (recommended in CI)",
      "       Set PREVIEW_URL in your CI to the PR's preview deploy. Pinned",
      "       runs pins against that URL.",
      "",
      "  3. Skip for now",
      "       HTTP pins get created but stay 'not verified' until you set",
      "       PREVIEW_URL or enable local mode later.",
      "",
      "  > ",
    ].join("\n")
  );
  return new Promise((resolve) => {
    const onData = (chunk: Buffer | string) => {
      const raw = (typeof chunk === "string" ? chunk : chunk.toString("utf8")).trim().toLowerCase();
      process.stdin.removeListener("data", onData);
      process.stdin.pause();
      if (raw === "" || raw === "1" || raw.startsWith("l")) return resolve("local");
      if (raw === "2" || raw.startsWith("p")) return resolve("preview");
      if (raw === "3" || raw.startsWith("s") || raw === "n" || raw.startsWith("no")) return resolve("off");
      return resolve("local");
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

async function promptSetupMode(): Promise<"auto" | "manual"> {
  process.stdout.write(
    [
      "",
      "How would you like Pinned to be set up?",
      "",
      "  1. Auto mode (recommended)  Enable everything that makes Pinned feel alive:",
      "       · Safe auto-pinning as you code (mode: safe)",
      "       · Pre-commit hook → auto-add safe pins when you commit",
      "       · Post-commit hook → auto-verify pins in background (★ critical for catches)",
      "       · Pre-push hook   → backstop scan before code leaves your machine",
      "       · Claude statusline → see pin count + status in your terminal",
      "       · AI-coder rules in CLAUDE.md → Claude/Cursor respect your pins",
      "       · Vitest install if missing → required for pins to actually verify (~30MB one-time)",
      "       · Initial baseline scan of your CURRENT code → propose 5-15 candidate pins (admin routes,",
      "         webhooks, env files). High-confidence ones get auto-added; ambiguous ones are surfaced",
      "         for you to review via `pinned protect`. (Does NOT read PR history.)",
      "       · Smart HTTP mode: if your repo has `scripts.dev` in package.json, Pinned will spawn",
      "         it during `pinned test` to verify HTTP pins locally. No PR-preview infrastructure",
      "         needed. (Never runs from statusline / chat hook — only `pinned test`.)",
      "",
      "       Nothing is irreversible. Each piece can be removed later.",
      "",
      "  2. Manual mode              Ask me about each piece individually.",
      "",
      "  > ",
    ].join("\n")
  );
  return new Promise((resolve) => {
    const onData = (chunk: Buffer | string) => {
      const raw = (typeof chunk === "string" ? chunk : chunk.toString("utf8")).trim().toLowerCase();
      process.stdin.removeListener("data", onData);
      process.stdin.pause();
      if (raw === "" || raw === "1" || raw.startsWith("a") || raw.startsWith("y")) {
        return resolve("auto");
      }
      if (raw === "2" || raw.startsWith("m") || raw.startsWith("n")) {
        return resolve("manual");
      }
      return resolve("auto");
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

// Friendly install-command string for the customer's package manager.
// When called with a cwd, returns the workspace-aware variant (e.g.
// `pnpm add -D -w vitest@^2` for pnpm workspaces) so the "Run manually"
// hint in error messages is always paste-runnable. Reads package.json /
// pnpm-workspace.yaml synchronously — must stay in lockstep with
// vitestSetup.installCommand().
// Compact plain-English label for a single auto-added pin. Used in
// the init success banner + statusline + chat hook so users feel the
// VALUE, not just the count.
//
// Wording convention: each line follows the shape
//    "<subject> — pin will check <future-tense check>"
// or "pin will check <subject> <future-tense check>".
//
// Why "pin will check" and not "still requires" — "still requires"
// implies Pinned ALREADY verified the contract at install time, which
// it hasn't (HTTP pins need a running server). "pin will check" is
// honest: the pin is a permanent test that will run on every future
// commit and fail if the contract breaks.
// Compact plain-English subject of what each pin protects. Used by
// the init banner under a header that explains Pinned's role
// ("Pinned will catch if AI changes break any of these…"), so each
// line is just the SUBJECT — short, scannable, value-directed.
function summarizeClaimForBanner(claim: Claim): string {
  // Each label describes WHAT THE GUARD CATCHES in plain English —
  // a developer should understand the value without reading docs or
  // knowing what a "template" is. Matches the style of the
  // already-good "no `VITE_*` env var leaks a secret..." label.
  switch (claim.template) {
    case "rate-limit":
      return `\`${claim.route}\` stays rate-limited to ${claim.rate}/${claim.window} (AI can't silently remove the limit)`;
    case "auth-required": {
      // Synthetic-route rewrites: when the detector synthesizes a
      // "route" string like `client-err:src/lib/foo`, `client:src/api/bar`,
      // `webhook:apps/api/...`, or the literal `* (middleware)`, the
      // default `\`${route}\` requires login` label leaks the internal
      // synth syntax. Translate to plain English using the file path.
      const route = claim.route;
      const sv = (claim as { staticVerify?: { filePath: string } }).staticVerify;
      const filePath = sv?.filePath ?? "";
      if (route.startsWith("client-err:")) {
        const path = filePath || route.replace(/^client-err:/, "");
        return `Client API in \`${path}\` keeps error handling (AI can't drop the \`if (!res.ok)\` check or try/catch)`;
      }
      if (route.startsWith("client:")) {
        const path = filePath || route.replace(/^client:/, "");
        return `Client API in \`${path}\` keeps its Authorization header (AI can't strip the auth header)`;
      }
      if (route.startsWith("webhook:")) {
        const path = filePath || route.replace(/^webhook:/, "");
        return `Webhook handler in \`${path}\` keeps its verification (AI can't remove the signature/auth check)`;
      }
      if (route === "* (middleware)") {
        const path = filePath || "middleware.ts";
        return `Middleware in \`${path}\` keeps its auth check (AI can't remove auth from the middleware chain)`;
      }
      return `\`${route}\` requires login (AI can't strip the auth check)`;
    }
    case "permission-required":
      return `\`${claim.route}\` requires ${claim.role} role (AI can't weaken the permission check)`;
    case "tier-cap":
      return `\`${claim.tier}\` users stay capped at ${claim.cap} ${claim.resource} on \`${claim.route}\` (AI can't silently remove the billing/quota gate)`;
    case "idempotent":
      return `${capitalize(humanProviderFromRoute(claim.route))} webhook ignores duplicate events (AI can't break idempotency and cause double-charges)`;
    case "returns-status":
      return `${claim.method} \`${claim.route}\` rejects bad input with ${claim.status} (AI can't remove the input validation)`;
    case "cli-output-contains":
      return `\`${claim.route}\` keeps printing \`${claim.text}\` (AI can't break the expected output)`;
    case "cli-exits-zero":
      return `\`${claim.route}\` runs without crashing (AI can't break the CLI command)`;
    case "cli-creates-file":
      return `\`${claim.route}\` keeps producing \`${claim.filePath}\` (AI can't break the side-effect)`;
    case "cli-json-shape":
      return `\`${claim.route}\` JSON output keeps its required keys (AI can't break the schema downstream consumers depend on)`;
    case "cli-flag-supported":
      return `\`${claim.route}\` keeps supporting the \`${claim.flag}\` flag (AI can't accidentally remove it)`;
    case "library-returns":
      return `\`${claim.functionName}()\` in \`${claim.modulePath}\` keeps returning the expected value (AI can't change the function's contract)`;
    case "lockfile-integrity":
      return `Lockfile changes can't sneak past package.json bumps (catches AI regenerating the lockfile and silently shifting transitive deps)`;
    case "config-invariant":
      return humanizeConfigLabel(claim.label, claim.configPath);
    case "package-exports-exist":
      return `\`${claim.modulePath}\` keeps exporting its public functions (catches AI accidentally renaming or removing an export)`;
    case "secret-not-public":
      return `no \`${claim.publicPrefix}*\` env var leaks a secret to the client bundle`;
    case "url-literal-preserved":
      return `URL \`${claim.urlLiteral}\` stays in \`${claim.filePath}\` (catches AI changing the URL and breaking the call site)`;
    case "tsc-clean":
      return `\`tsc --noEmit\` stays clean`;
    case "module-export-stable":
      return `\`${claim.modulePath}\` keeps exporting \`${claim.exportName}\``;
    case "react-route-registered":
      return `Route \`${claim.routePath}\` stays registered in \`${claim.routerFilePath}\` (catches AI dropping the route and making the page unreachable)`;
    case "webhook-handler-exists":
      return `${claim.provider} webhook handler at \`${claim.filePath}\``;
    case "import-path-resolves":
      return `import \`${claim.importPath}\` keeps resolving`;
    case "changed-literal-preserved":
      return `Fix preserved: \`${claim.newValue}\` stays in \`${claim.filePath}\` (catches AI reverting the ${claim.shape} fix from \`${claim.oldValue}\`)`;
    case "form-submit-error-handling":
      return `Form in \`${claim.filePath}\` keeps its submit-handler error handling (AI can't strip the try/catch and cause unhandled promise rejections)`;
    case "page-renders":
      return `Page \`${claim.route}\` keeps rendering (catches React/Next/Vite errors that crash the page silently)`;
    case "validation-rejects-bad":
      return `\`${claim.method} ${claim.route}\` keeps rejecting malformed / incomplete bodies (catches AI removing validation)`;
    case "happy-path-with-side-effect":
      return `\`${claim.method} ${claim.route}\` actually performs its ${claim.sideEffectKind} to \`${claim.sideEffectTarget}\` (catches stub endpoints returning 200 without doing the work)`;
    case "journey":
      return `User journey \`${claim.label}\` (${claim.steps.length} step${claim.steps.length === 1 ? "" : "s"}) keeps working end-to-end (catches multi-step regressions — e.g. signup OK but /me returns stale data — that single-route pins structurally miss)`;
  }
}

// Translate the internal `config-invariant` label into a short subject
// describing what's protected. Falls back to the literal label when
// no mapping exists. Per GPT: avoid scary words like "auto-commit"
// and over-specific tech terms ("hosted LLM"); say what it IS in
// terms the user already knows.
function humanizeConfigLabel(label: string, configPath: string): string {
  switch (label) {
    case "OIDC permission":
      return `GitHub Action permission for Pinned (AI can't disable Pinned's CI guard by editing the workflow)`;
    case "auto-commit permission":
      return `GitHub Action permission to add new pins (AI can't strip Pinned's ability to grow on each PR)`;
    case "Pinned guardrail block":
      return `AI-coder rules in CLAUDE.md (AI can't silently delete the rules that tell it to respect pins + read .pinned/ai-lessons.md)`;
    default:
      return `"${label}" in ${configPath}`;
  }
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

// Best-effort "what provider is this webhook?" — pulls the segment
// after /webhooks/ which we already validated is in the known-provider
// allowlist at detection time.
function humanProviderFromRoute(route: string): string {
  const m = /^\/webhooks?\/([a-z0-9]+)/i.exec(route);
  return m ? m[1] : "incoming";
}

// Render a list of added-pin summaries as bullets. Caps the visible
// count to keep the banner short — "+ stripe webhook idempotency
//                                   + auth required on /api/admin
function installCommandStr(
  pm: "npm" | "pnpm" | "yarn" | "bun",
  cwd?: string
): string {
  const atWorkspaceRoot = cwd ? isWorkspaceRootSync(cwd) : false;
  switch (pm) {
    case "pnpm":
      return atWorkspaceRoot
        ? "pnpm add -D -w vitest@^2"
        : "pnpm add -D vitest@^2";
    case "yarn":
      return atWorkspaceRoot
        ? "yarn add -D -W vitest@^2"
        : "yarn add -D vitest@^2";
    case "bun":
      return "bun add -d vitest@^2";
    default:
      return "npm install --save-dev vitest@^2";
  }
}

function isWorkspaceRootSync(repoRoot: string): boolean {
  if (existsSync(join(repoRoot, "pnpm-workspace.yaml"))) return true;
  const pkgPath = join(repoRoot, "package.json");
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      workspaces?: string[] | { packages?: string[] };
    };
    const ws = pkg.workspaces;
    if (Array.isArray(ws) && ws.length > 0) return true;
    if (
      ws &&
      !Array.isArray(ws) &&
      typeof ws === "object" &&
      Array.isArray(ws.packages) &&
      ws.packages.length > 0
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Preview helpers — show the literal content that would be installed,
// so the user can read it before saying yes. Kept inline (small + only
// used here) rather than importing from the install modules.
function previewHookScript(
  name: "pre-commit" | "pre-push" | "post-commit"
): string {
  if (name === "post-commit") {
    return [
      `#!/bin/sh`,
      `# pinnedai:post-commit`,
      `# Runs \`pinned test\` in the BACKGROUND after every commit.`,
      `# Throttled to ≥ 2 minutes between runs via .pinnedai/.last-auto-test.`,
      `# Tests run async — commit returns immediately. Tests that need`,
      `# PREVIEW_URL skip gracefully if it's not set.`,
      `# Set PINNEDAI_SKIP_HOOK=1 to bypass.`,
      `# Idempotent install via the marker line above.`,
    ].join("\n");
  }
  const lines = [
    `#!/bin/sh`,
    `# pinnedai:${name}`,
    `# (script body — runs auto-protect against the staged/unpushed changes,`,
    `#  then \`git add tests/pinned/\` so new pins ship in the same commit.)`,
    `# Set PINNEDAI_SKIP_HOOK=1 to bypass.`,
    `# Idempotent install via the marker line above. Removing the file removes`,
    `# our block (or only our block, if you had other hook content).`,
  ];
  return lines.join("\n");
}

function previewClaudeSettings(): string {
  // Schema matches what installClaudeStatusline / installClaudeFailureHook
  // actually writes: statusLine has `type: "command"` and each
  // UserPromptSubmit entry is a wrapper `{ matcher, hooks: [{type, command}] }`.
  // Drift here would mislead users about what `pinned init` is about to do.
  return JSON.stringify(
    {
      statusLine: {
        type: "command",
        command: "node ./apps/cli/dist/cli.js statusline",
      },
      hooks: {
        UserPromptSubmit: [
          {
            matcher: "",
            hooks: [
              {
                type: "command",
                command: "node ./apps/cli/dist/cli.js hook-failure",
              },
            ],
          },
        ],
      },
    },
    null,
    2
  );
}

// Rich install prompt for manual mode. Renders a structured block:
//   what it does · why you might want it · what gets touched · bypass
// Plus [Y]/[S] show first/[N]. Loops on [S] until the user picks Y or N.
type InstallPromptSpec = {
  title: string;            // human-readable feature name
  whatItDoes: string;       // 1-2 sentences
  whyYouWant: string;       // 1-2 sentences
  touches: string;          // file path(s) modified
  bypassHint?: string;      // optional env var / command to disable later
  preview?: () => string;   // returns the literal content that would be installed
  defaultYes?: boolean;     // default value on empty input (default: true)
};

async function promptInstall(spec: InstallPromptSpec): Promise<boolean> {
  const defaultYes = spec.defaultYes !== false;
  const hint = defaultYes ? "[Y/s/n]" : "[y/s/N]";

  const header = `─── ${spec.title} ${"─".repeat(Math.max(0, 56 - spec.title.length))}`;

  while (true) {
    process.stdout.write(
      [
        "",
        header,
        `What it does:`,
        `  ${spec.whatItDoes}`,
        ``,
        `Why you might want it:`,
        `  ${spec.whyYouWant}`,
        ``,
        `What gets touched:`,
        `  ${spec.touches}`,
        ...(spec.bypassHint ? [``, `Bypass / remove later: ${spec.bypassHint}`] : []),
        ``,
        `Install? ${hint}  (Y=yes · S=show me the contents first · N=skip)`,
        `  > `,
      ].join("\n")
    );

    const choice = await new Promise<"Y" | "S" | "N">((resolve) => {
      const onData = (chunk: Buffer | string) => {
        const raw = (typeof chunk === "string" ? chunk : chunk.toString("utf8")).trim().toLowerCase();
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        if (raw === "") return resolve(defaultYes ? "Y" : "N");
        if (raw.startsWith("y")) return resolve("Y");
        if (raw.startsWith("s")) return resolve("S");
        if (raw.startsWith("n")) return resolve("N");
        return resolve(defaultYes ? "Y" : "N");
      };
      process.stdin.resume();
      process.stdin.on("data", onData);
    });

    if (choice === "Y") return true;
    if (choice === "N") return false;
    // S: show the preview and loop back to the prompt.
    if (spec.preview) {
      process.stdout.write(
        [
          ``,
          `-- preview: contents to be written --`,
          spec.preview(),
          `-- end preview --`,
          ``,
        ].join("\n")
      );
    } else {
      process.stdout.write(`(no preview available for this install)\n\n`);
    }
  }
}

// Auto-protect mode prompt. Three numbered options, defaults to "safe"
// on empty input. Non-TTY callers must use --auto-protect=<mode> flag.
async function promptAutoProtectMode(): Promise<AutoProtectMode> {
  process.stdout.write(
    [
      "",
      "How should Pinned add new protections as you code?",
      "",
      "  1. Safe auto-protect   — add obvious safe pins automatically (recommended)",
      "  2. Ask first           — suggest pins, you approve before adding",
      "  3. Manual only         — never add pins unless you run a command",
      "",
      "  > ",
    ].join("\n")
  );
  return new Promise((resolve) => {
    const onData = (chunk: Buffer | string) => {
      const raw = (typeof chunk === "string" ? chunk : chunk.toString("utf8")).trim().toLowerCase();
      process.stdin.removeListener("data", onData);
      process.stdin.pause();
      if (raw === "" || raw === "1" || raw.startsWith("s")) return resolve("safe");
      if (raw === "2" || raw.startsWith("a")) return resolve("ask");
      if (raw === "3" || raw.startsWith("m") || raw.startsWith("o") || raw.startsWith("n")) {
        return resolve("off");
      }
      // Default on unrecognized input — never block the install on a
      // typo. Safer to default to the recommendation than to fail.
      return resolve("safe");
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

// Minimal Y/S/N prompt — reads one line from stdin, accepts any
// prefix-match on yes/show/no/skip.
async function promptYSN(question: string): Promise<"Y" | "S" | "N"> {
  process.stdout.write(`${question}\n  [Y] Add instructions    [S] Show me first    [N] Skip\n  > `);
  return new Promise((resolve) => {
    const onData = (chunk: Buffer | string) => {
      const raw = (typeof chunk === "string" ? chunk : chunk.toString("utf8")).trim().toUpperCase();
      process.stdin.removeListener("data", onData);
      process.stdin.pause();
      if (raw.startsWith("Y")) return resolve("Y");
      if (raw.startsWith("S")) return resolve("S");
      return resolve("N");
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

// ---------- list ----------
// Daily-loop visibility — every dev should know what constraints
// they're working under without grep-spelunking through tests/pinned.
program
  .command("list")
  .description("List all pinned claims in this repo (reads tests/pinned/).")
  .option(
    "--dir <path>",
    "Pinned tests directory (default: tests/pinned)",
    "tests/pinned"
  )
  .option("--include-retired", "Also show retired claims.")
  .option(
    "--verbose",
    "Show full detail per pin (promise + check + metadata). Default is title-only."
  )
  .option("--quiet", "Suppress the pinned banner header.")
  .action((opts: { dir: string; includeRetired?: boolean; verbose?: boolean }) => {
    printBanner();
    assertInsideDir(opts.dir, process.cwd());

    if (!existsSync(opts.dir)) {
      out(`No tests/pinned/ directory found. Run \`pinned init\` to get started.`);
      return;
    }
    const reg = readRegistry(opts.dir);
    const last = readLastStatus(opts.dir);
    const failingSet = new Set(last?.failingClaimIds ?? []);
    const active = reg.claims.filter((c) => c.status === "active");
    const retired = reg.claims.filter((c) => c.status === "retired");

    if (active.length === 0 && retired.length === 0) {
      out(`No pinned claims found in ${opts.dir}.`);
      out("Run `pinned init` to set up, or `pinned generate` after a claim PR.");
      return;
    }
    // All active pins have been retired, and the caller didn't pass
    // --include-retired — be explicit about the empty-active state
    // instead of silently producing no output.
    if (active.length === 0 && !opts.includeRetired) {
      out(`No active pinned claims found in ${opts.dir}.`);
      out(`${retired.length} retired claim${retired.length === 1 ? "" : "s"} — pass --include-retired to see them.`);
      return;
    }

    // Default — title-only scan view, GROUPED BY STRENGTH so users
    // don't mistake static guardrails for behavioral verifications
    // (per GPT's "classify pins by strength" recommendation).
    //
    //   Strong (behavioral)  — pin runs against live behavior
    //   Guardrails (static)  — file/config invariant checks
    //   Not verified yet     — HTTP pins lacking a configured URL
    if (!opts.verbose) {
      if (active.length > 0) {
        const anySkippedShort = (last?.skippedCount ?? 0) > 0;
        const httpCfg = readConfigImport(process.cwd()).http;
        const hasUrl = !!process.env.PREVIEW_URL;
        const ctx = { hasPreviewUrl: hasUrl, httpMode: httpCfg.mode };

        const byStrength: Record<PinStrength, RegistryEntry[]> = {
          behavioral: [],
          guardrail: [],
          unverified: [],
        };
        for (const e of active) {
          byStrength[classifyPinStrength(e.claim, ctx)].push(e);
        }

        out(
          `Protected behaviors (${active.length}) — ✓ verified, ✗ broken, ⊘ skipped, ? not yet checked:`
        );

        const sections: { label: string; items: RegistryEntry[]; note: string }[] = [
          {
            label: "Strong (runs against live behavior)",
            items: byStrength.behavioral,
            note: "",
          },
          {
            label: "Guardrails (static file/config checks)",
            items: byStrength.guardrail,
            note: "",
          },
          {
            label: "Not verified yet",
            items: byStrength.unverified,
            note: "no preview URL or local-dev mode configured — set PREVIEW_URL or enable http.mode=local to verify",
          },
        ];
        let i = 0;
        for (const sec of sections) {
          if (sec.items.length === 0) continue;
          out("");
          out(`  ${sec.label} (${sec.items.length})`);
          if (sec.note) out(`    ${sec.note}`);
          for (const e of sec.items) {
            i += 1;
            let statusIcon: string;
            if (failingSet.has(e.claimId)) {
              statusIcon = "✗";
            } else if (sec.label.startsWith("Not verified")) {
              statusIcon = "⊘";
            } else if (anySkippedShort) {
              statusIcon = "?";
            } else if (last) {
              statusIcon = "✓";
            } else {
              statusIcon = "?";
            }
            out(`${String(i).padStart(4)}. ${statusIcon} ${describeClaimForUser(e.claim).title}`);
          }
        }
        out("");
        if (anySkippedShort) {
          out(`⊘ ${last?.skippedCount ?? 0} pin(s) skipped — set PREVIEW_URL / fixture tokens (see docs/preview-url.md) to verify them.`);
          out("");
        }
        out(`Run \`pinned show <claim-id>\` for full detail on any one, or \`pinned list --verbose\` for all.`);
      }
      if (opts.includeRetired && retired.length > 0) {
        if (active.length > 0) out("");
        out(`Retired (${retired.length}):`);
        for (const e of retired) {
          out(`   ⊘ ${describeClaimForUser(e.claim).title}`);
        }
      }
      return;
    }

    // --verbose — full Title / Promise / Check / metadata block per pin.
    if (active.length > 0) {
      // Status icons: ✗ broken / ✓ verified / ⊘ skipped / ? not yet checked.
      // The ⊘ state surfaces when the last `pinned test` run reported
      // skipped tests (typically due to missing PREVIEW_URL or fixture
      // tokens). Without this, pins that COULD NOT BE VERIFIED would
      // appear as ✓ verified — false confidence. The check is coarse:
      // we don't track which specific claimIds skipped (would require
      // extra parsing in `pinned test`), so if ANY pins skipped in the
      // last run, we show ? for all non-failing pins. Conservative but
      // honest: "we don't know which ones were verified" is safer than
      // false-claiming verification.
      const anySkipped = (last?.skippedCount ?? 0) > 0;
      out(`Protected behaviors (${active.length}) — ✓ verified, ✗ broken, ⊘ skipped, ? not yet checked:`);
      out("");
      let i = 0;
      for (const e of active) {
        i += 1;
        let statusIcon: string;
        if (failingSet.has(e.claimId)) {
          statusIcon = "✗";
        } else if (anySkipped) {
          // Conservative: when some pins skipped in the last run, we
          // can't tell from the cache which specific ones did. Mark
          // non-failing pins as "?" (not-yet-checked / unknown
          // verification state) rather than falsely claiming "✓".
          statusIcon = "?";
        } else if (last) {
          statusIcon = "✓";
        } else {
          statusIcon = "?";
        }
        const d = describeClaimForUser(e.claim);
        const pinnedAt = e.pinnedAt.replace(/T.*$/, "");
        out(`${String(i).padStart(2)}. ${statusIcon} ${d.title}`);
        out(`      Promise:  ${d.promise}`);
        out(`      Check:    ${d.check}`);
        out(`      Added:    ${pinnedAt} · PR ${e.prId}`);
        out(`      Test:     tests/pinned/${e.filename}`);
        out(`      Template: ${e.claim.template}`);
        out("");
      }
      if (anySkipped) {
        out(`⊘ ${last?.skippedCount ?? 0} pin(s) skipped in the last test run (typically: PREVIEW_URL or fixture tokens not set).`);
        out(`  See https://pinnedai.dev/docs/preview-url for setup.`);
        out("");
      }
    }
    if (opts.includeRetired && retired.length > 0) {
      out(`Retired (${retired.length}):`);
      out("");
      let i = 0;
      for (const e of retired) {
        i += 1;
        const d = describeClaimForUser(e.claim);
        const pinnedAt = e.pinnedAt.replace(/T.*$/, "");
        out(`${String(i).padStart(2)}. ⊘ ${d.title}`);
        out(`      Was protecting: ${d.promise}`);
        out(`      Added ${pinnedAt} in PR ${e.prId}${e.retireReason ? `, retired: ${e.retireReason}` : ""}`);
        out("");
      }
    }
  });

// ---------- show ----------
// Single-pin detail. Reads the registry entry, the test-file source,
// and any catch history for this claim. The "give me the full story
// on this pin" command.
program
  .command("show")
  .alias("describe")
  .description("Show full detail for a single pinned claim: what it asserts, what would make it fail, file, status, catch history.")
  .argument("<claim-id>", "Claim id (filename without .test.ts)")
  .option(
    "--dir <path>",
    "Pinned tests directory (default: tests/pinned)",
    "tests/pinned"
  )
  .option("--quiet", "Suppress the pinned banner header.")
  .action((claimId: string, opts: { dir: string }) => {
    printBanner();
    assertSafeId("claim id", claimId);
    assertInsideDir(opts.dir, process.cwd());

    if (!existsSync(opts.dir)) {
      err(`✗ ${opts.dir}/ does not exist. Run \`pinned init\` first.\n`);
      process.exit(1);
    }
    const reg = readRegistry(opts.dir);
    const entry = reg.claims.find((c) => c.claimId === claimId);
    if (!entry) {
      err(`✗ No pin found with id '${claimId}'. Run \`pinned list\` to see all pins.\n`);
      process.exit(1);
    }
    const last = readLastStatus(opts.dir);
    const isFailing = last?.failingClaimIds.includes(claimId) ?? false;
    const status =
      entry.status === "retired"
        ? "⊘ retired"
        : isFailing
          ? "✗ failing"
          : last
            ? "✓ passing"
            : "? not tested";
    const catches = (last?.catchHistory ?? []).filter((c) => c.claimId === claimId);

    const d = describeClaimForUser(entry.claim);
    const failureScenario = describeFailureScenario(entry.claim);
    const pinnedAtDay = entry.pinnedAt.replace(/T.*$/, "");
    out("");
    out(`◆ ${d.title}`);
    out("");
    out(`  Promise:`);
    out(`  ${d.promise}`);
    out("");
    out(`  What Pinned checks:`);
    out(`  ${d.check}`);
    out("");
    out(`  This pin FAILS if:`);
    out(`  ${failureScenario}`);
    out("");
    out(`  Status:  ${status}`);
    out(`  Added:   ${pinnedAtDay} in PR ${entry.prId} by ${entry.pinnedBy}`);
    out(`  Test:    tests/pinned/${entry.filename}`);
    if (entry.status === "retired") {
      const retiredDay = entry.retiredAt?.replace(/T.*$/, "");
      out(`  Retired: ${retiredDay ?? "(unknown date)"} — ${entry.retireReason ?? "(no reason recorded)"}`);
    }
    out("");
    out(`  --- Technical details ---`);
    out(`  Template:       ${entry.claim.template}`);
    out(`  Claim id:       ${entry.claimId}`);
    out(`  Original claim: "${entry.claim.raw}"`);
    if (catches.length > 0) {
      out("");
      out(`Catch history (${catches.length}):`);
      for (const c of catches.slice(0, 10)) {
        out(`  · ${c.caughtAt} — caught regression on this claim`);
      }
      if (catches.length > 10) out(`  ... and ${catches.length - 10} more`);
    }
    out("");
  });

// ---------- regenerate ----------
// Regenerate one or all pin .test.ts files from their stored claims.
// Necessary because pin files are self-contained — a library upgrade
// doesn't reach the existing emitted code. After a template-bug fix
// lands, this command re-emits each pin with the current template,
// applying the fix retroactively. See
// [[library-upgrades-must-include-pin-regenerate]] memory.
program
  .command("regenerate")
  .alias("regen")
  .description(
    "Regenerate pin .test.ts file(s) from the stored claim using the current template. Applies template-bug fixes retroactively to pins generated by older CLI versions."
  )
  .argument(
    "[claim-id]",
    "Claim id to regenerate. Omit + pass --all to regenerate every active pin."
  )
  .option("--all", "Regenerate every active pin in the registry.")
  .option(
    "--dir <path>",
    "Pinned tests directory (default: tests/pinned)",
    "tests/pinned"
  )
  .option(
    "--dry-run",
    "Show what would change without writing. Diffs the new emit against the on-disk file."
  )
  .option("--quiet", "Suppress the pinned banner header.")
  .action(
    (claimId: string | undefined, opts: { all?: boolean; dir: string; dryRun?: boolean }) => {
      printBanner();
      assertInsideDir(opts.dir, process.cwd());
      if (!existsSync(opts.dir)) {
        err(`✗ ${opts.dir}/ does not exist. Run \`pinned init\` first.\n`);
        process.exit(1);
      }
      if (!claimId && !opts.all) {
        err(
          "✗ Pass a claim-id, or use --all to regenerate every active pin.\n  e.g.  pinned regenerate auto-20260602-auth-required-api-admin-login-wy9ky0\n        pinned regenerate --all\n"
        );
        process.exit(1);
      }
      if (claimId) assertSafeId("claim id", claimId);

      const reg = readRegistry(opts.dir);
      const targets = opts.all
        ? reg.claims.filter((c) => c.status === "active")
        : reg.claims.filter((c) => c.status === "active" && c.claimId === claimId);

      if (targets.length === 0) {
        if (claimId) {
          err(
            `✗ No active pin with id '${claimId}'. Run \`pinned list\` to see all active pins.\n`
          );
        } else {
          out("No active pins to regenerate.");
        }
        process.exit(claimId ? 1 : 0);
      }

      out(
        `Regenerating ${targets.length} pin(s) using pinnedai@${version}'s templates...`
      );
      out("");

      let changed = 0;
      let unchanged = 0;
      let errors = 0;

      for (const entry of targets) {
        const target = join(opts.dir, entry.filename);
        try {
          const gen = generateTest(entry.claim, {
            prId: entry.prId,
            pinnedVersion: version,
          });
          const currentContent = existsSync(target)
            ? readFileSync(target, "utf8")
            : null;
          if (currentContent === gen.content) {
            unchanged += 1;
            continue;
          }
          if (opts.dryRun) {
            out(`  ~ ${entry.filename} (would update)`);
          } else {
            writeFileSync(target, gen.content);
            out(`  ✓ ${entry.filename}`);
          }
          changed += 1;
        } catch (e) {
          errors += 1;
          err(`  ✗ ${entry.filename} — ${(e as Error).message}\n`);
        }
      }

      // Write a short-lived "regenerate-allow" marker so the
      // pre-commit hook (check-guard-removal) can distinguish
      // sanctioned modifications from AI weakening attempts. Without
      // this, `git commit` after `pinned regenerate` would be blocked
      // by the hook — the documented bypass (PINNEDAI_ALLOW_PIN_EDIT=1)
      // is a foot-gun. Marker is hash-bound to the specific regenerated
      // files + has a 5-minute TTL.
      // Auto-fix `.pinnedai/` gitignore entry for existing installs.
      // `pinned init` adds it for fresh installs (0.2.3+), but repos
      // that ran an earlier init don't have it — committing a stale
      // marker file would let CI bypass the guard hook. Run on every
      // regenerate (not just when pins changed) so the fix lands the
      // first time the upgraded CLI touches the repo.
      const gitignoreResult = ensureGitignored(".pinnedai/");
      if (gitignoreResult === "added") {
        out("(also added .pinnedai/ to .gitignore so the marker + BYOK creds aren't committed)");
      }
      if (!opts.dryRun && changed > 0) {
        try {
          const markerDir = ".pinnedai";
          if (!existsSync(markerDir)) {
            mkdirSync(markerDir, { recursive: true });
          }
          const allowEntries = targets
            .map((entry) => {
              const target = join(opts.dir, entry.filename);
              if (!existsSync(target)) return null;
              const content = readFileSync(target, "utf8");
              const sha256 = createHash("sha256").update(content).digest("hex");
              return { filename: entry.filename, sha256, dir: opts.dir };
            })
            .filter((e): e is { filename: string; sha256: string; dir: string } => e !== null);
          const now = Date.now();
          const marker = {
            version: 1,
            createdAt: new Date(now).toISOString(),
            expiresAt: new Date(now + 5 * 60 * 1000).toISOString(), // 5 min TTL
            runId: randomBytes(8).toString("hex"),
            source: "regenerate" as const,
            regenerated: allowEntries,
          };
          writeFileSync(
            join(markerDir, "regenerate-allow.json"),
            JSON.stringify(marker, null, 2) + "\n"
          );
        } catch {
          /* Marker write failure is non-fatal — user will fall back to
             PINNEDAI_ALLOW_PIN_EDIT=1 if needed. */
        }
      }

      out("");
      const summary = opts.dryRun
        ? `${changed} pin(s) would change. ${unchanged} already current. ${errors} errors.`
        : `${changed} pin(s) updated. ${unchanged} already current. ${errors} errors.`;
      out(summary);
      if (!opts.dryRun && changed > 0) {
        out("");
        out("Now commit — the pre-commit hook will recognize these as sanctioned");
        out("changes (via .pinnedai/regenerate-allow.json; auto-expires in 5 min):");
        out("  git add tests/pinned/ && git commit -m \"chore(pinned): regenerate pins with latest templates\"");
      }
    }
  );

// ---------- catches ----------
// Lifetime catch history — every regression Pinned has caught.
// Surfaces the lifetime value metric in a browsable form.
program
  .command("catches")
  .description("Show the history of regressions Pinned has caught (lifetime, newest first).")
  .option(
    "--dir <path>",
    "Pinned tests directory (default: tests/pinned)",
    "tests/pinned"
  )
  .option("--limit <n>", "Show at most N entries (default: 20)", "20")
  .option("--quiet", "Suppress the pinned banner header.")
  .action(async (opts: { dir: string; limit: string }) => {
    printBanner();
    assertInsideDir(opts.dir, process.cwd());
    const last = readLastStatus(opts.dir);
    const history = last?.catchHistory ?? [];
    const total = last?.breaksCaught ?? 0;

    if (history.length === 0) {
      out("No regressions caught yet.");
      if (total > 0) {
        out(`(Lifetime count: ${total} — history was started after some catches.)`);
      } else {
        out("Pinned will track regressions as they're caught.");
      }
      return;
    }
    const limit = Math.max(1, parseInt(opts.limit, 10) || 20);
    out("");
    out(`◆ Regressions Pinned has caught — ${history.length} recorded, ${total} lifetime`);
    out("");
    // Look up each catch's current claim entry so we can render the
    // human Title. Fall back to the cached claimText if the pin was
    // retired or the registry is missing.
    const reg = existsSync(opts.dir) ? readRegistry(opts.dir) : { version: 1 as const, claims: [] };
    const regById = new Map(reg.claims.map((e) => [e.claimId, e]));
    // Sort by severity (highest first) then by date (newest first)
    // when layman fields are present. Mixed cache (some with, some
    // without) sorts by date alone — falls through to original order.
    const { SEVERITY_RANK } = await import("./catchImpact.js");
    const ranked = [...history];
    if (ranked.some((c) => c.severity)) {
      ranked.sort((a, b) => {
        const ra = SEVERITY_RANK[a.severity ?? "info"];
        const rb = SEVERITY_RANK[b.severity ?? "info"];
        if (ra !== rb) return rb - ra;
        return (b.caughtAt ?? "").localeCompare(a.caughtAt ?? "");
      });
    }

    let i = 0;
    for (const c of ranked.slice(0, limit)) {
      i += 1;
      const dateOnly = c.caughtAt.replace(/T.*$/, "");
      const entry = regById.get(c.claimId);
      // Layman path: render headline + impact + severity badge when
      // the cache carries them (records from `pinned backtest
      // --record-catches`). Falls back to the technical title for
      // older cache entries.
      if (c.severity && c.laymanHeadline) {
        const badge =
          c.severity === "critical" ? "🔴 CRITICAL" :
          c.severity === "high" ? "🟠 HIGH" :
          c.severity === "medium" ? "🟡 MEDIUM" :
          c.severity === "low" ? "🔵 LOW" :
          "⚪ INFO";
        out(`${String(i).padStart(2)}. ${badge} — ${c.laymanHeadline}`);
        if (c.userImpact) {
          // Wrap impact text to ~76 chars for terminal readability.
          const wrapped = wrapText(c.userImpact, 76, "      ");
          for (const line of wrapped) out(line);
        }
        out(`      Caught: ${dateOnly}${c.originPr ? ` · from ${c.originPr}` : ""}`);
        if (entry) out(`      Test:   tests/pinned/${entry.filename}`);
        else if (c.claimId) out(`      Test:   tests/pinned/${c.claimId}.test.ts`);
        out("");
      } else {
        // Legacy / un-translated entry
        const title = entry
          ? describeClaimForUser(entry.claim).title
          : c.claimText ?? c.claimId;
        out(`${String(i).padStart(2)}. 🛟 ${title}`);
        out(`      Caught: ${dateOnly}`);
        if (entry) out(`      Test:   tests/pinned/${entry.filename}`);
        out("");
      }
    }
    if (ranked.length > limit) {
      out(`... and ${ranked.length - limit} more (use --limit ${ranked.length})`);
    }
  });

// Simple word-wrap for terminal output. Keeps existing words intact;
// breaks only on whitespace. Lines are indented by `indent` (caller-
// supplied; usually 6 spaces so impact text aligns under the headline).
function wrapText(text: string, width: number, indent: string): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    if ((current + " " + w).trimStart().length > width - indent.length) {
      if (current) lines.push(indent + current.trim());
      current = w;
    } else {
      current = current + " " + w;
    }
  }
  if (current.trim()) lines.push(indent + current.trim());
  return lines;
}

// ---------- scan-diff ----------
// The "No proof found" detector. Looks at the changed files in a PR,
// cross-references the PR description + existing pins, and warns
// about risk surfaces (auth, routes, webhooks, env) that have no
// claim covering them. Used by the Action to post the warning comment
// — see [[oidc-hosted-endpoint-mvp]] for the runtime context.
// `scan` is the canonical name (solo AI coders run "scan", not
// "scan-diff"). `scan-diff` is kept as an alias for back-compat —
// they share the same `.action()`.
program
  .command("scan")
  .alias("scan-diff")
  .description(
    "Scan the current diff for risk surfaces (auth, webhook, env) that aren't covered by a pinned claim. Used by the GitHub Action to post 'no proof found' nudges."
  )
  .option(
    "--base <ref>",
    "Git ref to diff against (default: origin/main)",
    "origin/main"
  )
  .option(
    "--description <text>",
    "PR description text — claims here count as coverage."
  )
  .option(
    "--dir <path>",
    "Pinned tests directory (for existing-pins coverage)",
    "tests/pinned"
  )
  .option("--json", "Emit JSON instead of human text.")
  .option(
    "--markdown",
    "Emit a Markdown comment body (for the GitHub Action)."
  )
  .option("--quiet", "Suppress the pinned banner header.")
  .action(
    async (opts: {
      base: string;
      description?: string;
      dir: string;
      json?: boolean;
      markdown?: boolean;
    }) => {
      printBanner();
      assertInsideDir(opts.dir, process.cwd());
      const changedFiles = readChangedFilesFromGit(opts.base);
      const body =
        opts.description ?? process.env.GITHUB_PR_BODY ?? "";
      const prBodyClaims = body ? parseClaims(body) : [];
      const existingPins = readRegistry(opts.dir).claims;

      const result = scanDiffFull({
        changedFiles,
        prBodyClaims,
        existingPins,
      });

      if (opts.json) {
        out(JSON.stringify(result, null, 2));
        return;
      }
      if (opts.markdown) {
        // Touched-pins block (REVIEW state) renders first when present
        // — it's the most urgent signal in scan output: this diff edits
        // code that was previously protected, so CI may fail on merge.
        // Suggestions for unprotected risks follow as a secondary call
        // to action.
        const touched = renderTouchedPinsMarkdown(result.touchedPins);
        const suggestions = renderSuggestionsMarkdown(
          result.suggestions,
          result.coverage
        );
        out([touched, suggestions].filter(Boolean).join("\n\n"));
        return;
      }
      const touchedHuman = renderTouchedPinsHuman(result.touchedPins);
      const suggestionsHuman = renderSuggestionsHuman(
        result.suggestions,
        result.coverage
      );
      out([touchedHuman, suggestionsHuman].filter(Boolean).join("\n\n"));
    }
  );

// ---------- scan-pr ----------
// Convenience command for AI agents responding to a PR notification.
// Takes a GitHub PR URL or number, fetches the PR body via `gh pr view`,
// runs `pinned check` on the body, then `pinned scan-diff --base <ref>`
// for the diff classifier. Output is the combined human-readable
// summary an AI can paste back to the user as a PR-impact summary.
//
// Requires `gh` CLI installed and authenticated. If absent, we surface
// a clear error pointing at the gh install docs — we don't auto-install
// gh (it's a system-level tool customers should already have).
program
  .command("scan-pr")
  .description(
    "One-shot: fetch a GitHub PR's body + diff via `gh`, then run `pinned check` and `pinned scan` on it. Useful when an AI agent is responding to a PR notification and wants the full Pinned summary in one command."
  )
  .argument(
    "<url-or-number>",
    "GitHub PR URL (https://github.com/<owner>/<repo>/pull/<n>) or just a PR number if you're inside the repo."
  )
  .option(
    "--repo <owner/repo>",
    "Required if you pass just a number and aren't inside the target repo's git directory."
  )
  .option(
    "--dir <path>",
    "Pinned tests directory (default: tests/pinned)",
    "tests/pinned"
  )
  .option(
    "--json",
    "Output a JSON blob (claims + scan + touched pins) for downstream tools."
  )
  .option("--quiet", "Suppress the pinned banner header.")
  .action(
    async (
      urlOrNumber: string,
      opts: { repo?: string; dir: string; json?: boolean }
    ) => {
      printBanner();
      assertInsideDir(opts.dir, process.cwd());

      // Validate gh CLI exists and is authenticated. Distinguish
      // "gh not installed" from "gh installed but not logged in" so
      // the customer sees the correct remediation step.
      const ghCheck = childSpawnSync("gh", ["--version"], {
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
      });
      if (ghCheck.status !== 0) {
        err(
          "✗ The `gh` CLI is required for `pinned scan-pr`.\n" +
            "  Install: https://cli.github.com/\n" +
            "  After install, run: gh auth login\n"
        );
        process.exit(2);
      }
      // gh is installed — check authentication. `gh auth status` exits
      // 0 if at least one host is authenticated, non-zero otherwise.
      const authCheck = childSpawnSync("gh", ["auth", "status"], {
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
      });
      if (authCheck.status !== 0) {
        err(
          "✗ `gh` is installed but not authenticated.\n" +
            "  Run: gh auth login\n" +
            "  After authenticating, re-run pinned scan-pr.\n"
        );
        process.exit(2);
      }

      // Normalize the PR target. Three forms supported:
      //   - Full URL: https://github.com/owner/repo/pull/123
      //   - Just a number, with --repo owner/repo
      //   - Just a number, inside the target repo's git checkout
      const isUrl = /^https?:\/\//.test(urlOrNumber);
      const ghArgs: string[] = ["pr", "view"];
      if (isUrl) {
        // Validate the URL shape before passing to gh — defensive
        // against shell-injection-shaped args.
        if (!/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/.test(urlOrNumber)) {
          err(
            "✗ Not a recognized GitHub PR URL.\n" +
              "  Expected: https://github.com/<owner>/<repo>/pull/<n>\n"
          );
          process.exit(2);
        }
        ghArgs.push(urlOrNumber);
      } else {
        if (!/^\d+$/.test(urlOrNumber)) {
          err(
            "✗ <url-or-number> must be either a full GitHub PR URL or a numeric PR id.\n"
          );
          process.exit(2);
        }
        ghArgs.push(urlOrNumber);
        if (opts.repo) {
          // Light validation — owner/repo with no slashes inside parts.
          if (!/^[a-zA-Z0-9][\w.-]*\/[a-zA-Z0-9][\w.-]*$/.test(opts.repo)) {
            err("✗ --repo must look like 'owner/repo'.\n");
            process.exit(2);
          }
          ghArgs.push("--repo", opts.repo);
        }
      }
      ghArgs.push("--json", "body,baseRefName,number,title,url");

      const ghResult = childSpawnSync("gh", ghArgs, {
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
      });
      if (ghResult.status !== 0) {
        err(
          `✗ gh pr view failed:\n${(ghResult.stderr || ghResult.stdout || "").trim()}\n`
        );
        process.exit(ghResult.status ?? 1);
      }

      let prData: {
        body: string;
        baseRefName: string;
        number: number;
        title: string;
        url: string;
      };
      try {
        prData = JSON.parse(ghResult.stdout ?? "{}");
      } catch (e) {
        err(`✗ Could not parse gh output as JSON: ${(e as Error).message}\n`);
        process.exit(1);
      }

      const body = prData.body ?? "";
      const claims = parseClaims(body);

      // For the diff classifier, prefer `origin/<base>` over `<base>`
      // since the customer's clone may not have that branch checked out.
      const baseRef = `origin/${prData.baseRefName || "main"}`;
      const changedFiles = readChangedFilesFromGit(baseRef);
      const existingPins = existsSync(opts.dir)
        ? readRegistry(opts.dir).claims
        : [];
      const scan = scanDiffFull({
        changedFiles,
        prBodyClaims: claims,
        existingPins,
      });

      if (opts.json) {
        out(
          JSON.stringify(
            {
              pr: {
                number: prData.number,
                title: prData.title,
                url: prData.url,
                baseRef: prData.baseRefName,
              },
              claimsFromBody: claims,
              scan,
            },
            null,
            2
          )
        );
        return;
      }

      // Human-readable summary.
      out("");
      out(`◆ pinned scan-pr — ${prData.url}`);
      out(`  PR #${prData.number}: ${prData.title}`);
      out(`  Base: ${prData.baseRefName}`);
      out("");
      if (claims.length === 0) {
        out("No claims parsed from the PR body.");
      } else {
        out(`Claims parsed from PR body (${claims.length}):`);
        for (const c of claims) {
          out(`  • ${describeClaim(c)}`);
        }
      }
      out("");
      const touchedHuman = renderTouchedPinsHuman(scan.touchedPins);
      const suggestionsHuman = renderSuggestionsHuman(
        scan.suggestions,
        scan.coverage
      );
      const blocks = [touchedHuman, suggestionsHuman].filter(Boolean);
      if (blocks.length > 0) out(blocks.join("\n\n"));
    }
  );

// ---------- guard ----------
// The frictionless one-shot for AI-coder users: scans the local diff
// for unprotected risk surfaces, surfaces existing-pin coverage, runs
// any pins that touch the diff, and returns a PASS/REVIEW/BLOCK
// summary with a matching exit code. Pure local — no GitHub, no
// signup, no API key required. Designed to be the "first value in
// 30 seconds" command for users evaluating Pinned.
//
// ---------- backtest (INTERNAL — not in --help) ----------
// "What would Pinned have caught if installed at commit N and replayed
// to HEAD?" Replays a target repo's git history, parses claims from
// commit messages (and optionally diff-derived in extended mode),
// generates pin tests, then checks out historical commits in a worktree
// and runs the pin tests at each. Catches = green → red transitions.
//
// This is calibration only — hidden from the main --help output. Used
// to answer the "does Pinned actually catch real regressions?" question
// before launch.
program
  .command("backtest", { hidden: true })
  .description("(internal) Replay a target repo's git history against generated pins to measure real catches.")
  .requiredOption("--repo <path>", "Absolute path to the target git repo.")
  .option("--from <commit>", "Start commit (inclusive). Default: full history.")
  .option("--to <commit>", "End commit. Default: HEAD.", "HEAD")
  .option("--mode <product|extended|bug-fix>", "product = PR/commit claims only. extended = + diff-derived inference. bug-fix = mines fix commits, replays pins against parent (the 'real catch' benchmark).", "product")
  .option("--max-replay <n>", "Max forward-commits to replay per pin (forward modes only).", "50")
  .option("--max-fixes <n>", "Max fix-commits to evaluate in bug-fix mode (newest first).", "30")
  .option("--vitest-timeout <ms>", "Per-commit vitest timeout (ms).", "30000")
  .option("--json", "Emit the full backtest report as JSON.")
  .option("--quiet", "Suppress the pinned banner header.")
  .option(
    "--record-catches",
    "(bug-fix mode) Write real-catches into the target repo's tests/pinned/.last-status.json so its statusline reflects 'caught N catches today'. Off by default — the benchmark is read-only on the target unless this is set."
  )
  .action(async (opts: {
    repo: string;
    from?: string;
    to: string;
    mode: string;
    maxReplay: string;
    maxFixes: string;
    vitestTimeout: string;
    json?: boolean;
    quiet?: boolean;
    recordCatches?: boolean;
  }) => {
    if (!opts.quiet) printBanner();
    if (opts.mode !== "product" && opts.mode !== "extended" && opts.mode !== "bug-fix") {
      err(`✗ Invalid --mode '${opts.mode}'. Use: product | extended | bug-fix\n`);
      process.exit(1);
    }
    if (opts.mode === "bug-fix") {
      // Surface LLM mode at start so users see whether the
      // benchmark is running regex-only or with LLM-as-proposer.
      // Per [[three-mode-llm-architecture]] privacy invariant: print
      // mode on every invocation, no silent network calls.
      const { activeByokProvider } = await import("./llmDirect.js");
      const byok = activeByokProvider();
      if (byok && (
        (byok === "anthropic" && process.env.PINNEDAI_ANTHROPIC_KEY) ||
        (byok === "openai" && process.env.PINNEDAI_OPENAI_KEY)
      )) {
        if (!opts.quiet) {
          out(`pinned: LLM proposer enabled via BYOK (${byok}) — context sent per commit: commit msg + diff hunks + file paths (no secrets, no whole codebase).`);
        }
      } else if (byok) {
        if (!opts.quiet) {
          out(`pinned: PINNEDAI_BYOK=${byok} set but PINNEDAI_${byok.toUpperCase()}_KEY missing — LLM proposer DISABLED, falling back to regex-only.`);
        }
      } else if (!opts.quiet) {
        out(`pinned: regex-only mode (set PINNEDAI_BYOK=anthropic + PINNEDAI_ANTHROPIC_KEY to enable LLM proposer).`);
      }
      const { runBugFixBenchmark } = await import("./backtest.js");
      const report = await runBugFixBenchmark({
        repoPath: resolve(opts.repo),
        fromCommit: opts.from,
        toCommit: opts.to,
        maxFixCommits: parseInt(opts.maxFixes, 10),
        vitestTimeoutMs: parseInt(opts.vitestTimeout, 10),
      });
      if (opts.json) {
        out(JSON.stringify(report, null, 2));
        return;
      }
      out("");
      out(`◆ pinned backtest (bug-fix mode) — ${report.repo}`);
      out(`  commits walked:     ${report.commitsScanned}`);
      out(`  fix-shaped matched: ${report.fixCommitsMatched}`);
      out(`  fix-commits evaluated: ${report.fixCommitsEvaluated}`);
      out(`  pins generated:     ${report.pinsGenerated}`);
      out(`  by template:`);
      for (const [t, n] of Object.entries(report.pinsByTemplate)) {
        out(`    ${t.padEnd(22)} ${n}`);
      }
      out(`  not-testable (HTTP, no preview): ${report.notTestableHttp}`);
      out(`  no-signal (passes at both parent & fix): ${report.noSignal}`);
      out(`  broken-at-fix (failed positive control):  ${report.brokenAtFix}`);
      out(`  no-parent (initial commits):              ${report.noParent}`);
      out("");
      out(`  ★ REAL CATCHES (fail-at-parent, pass-at-fix): ${report.realCatches}`);
      if (report.realCatches > 0) {
        out(`  by template:`);
        for (const [t, n] of Object.entries(report.realCatchesByTemplate)) {
          out(`    ${t.padEnd(22)} ${n}`);
        }
        out("");
        out("  Real catches:");
        for (const fx of report.fixes) {
          const catches = fx.pins.filter((p) => p.classification === "real-catch");
          if (catches.length === 0) continue;
          out(`    ${fx.fixCommit.slice(0, 8)}  ${fx.subject}`);
          for (const p of catches) {
            out(`      → ${p.claim.template}  (${p.filename})`);
            // Sibling suggestions — surfaced for every real-catch
            // in a high-value category. High-confidence ones are
            // what a live `pinned guard` flow would auto-pin in
            // observe mode (per memory:
            // sibling-discovery-confidence-tiered-no-approval).
            const siblings = p.siblings ?? [];
            const high = siblings.filter((s) => s.confidence === "high");
            const medium = siblings.filter((s) => s.confidence === "medium");
            if (high.length > 0) {
              out(`        ◆ Related protection opportunities (high confidence — would auto-pin in observe mode):`);
              for (const s of high) {
                const routeDisplay = s.route ? `  →  ${s.route}` : "";
                out(`            + ${s.filePath}${routeDisplay}`);
              }
            }
            if (medium.length > 0) {
              out(`        ? Related candidates (medium — review with \`pinned audit --learned\` and pin manually):`);
              for (const s of medium) {
                const routeDisplay = s.route ? `  →  ${s.route}` : "";
                out(`            ? ${s.filePath}${routeDisplay}`);
              }
            }
          }
        }
      }
      out(`  duration:           ${(report.durationMs / 1000).toFixed(1)}s`);

      // Optional: record catches into the target repo's status cache
      // so its statusline reflects "★ N catches today" per
      // [[statusline catch decay]]. Read-only by default; opt-in via
      // --record-catches flag.
      if (opts.recordCatches) {
        const { recordBenchmarkCatches } = await import("./statusline.js");
        const { deriveCatchImpact } = await import("./catchImpact.js");
        const targetPinnedDir = resolve(opts.repo, "tests/pinned");
        const catches: import("./statusline.js").BenchmarkCatchInput[] = [];
        for (const fx of report.fixes) {
          for (const p of fx.pins) {
            if (p.classification !== "real-catch") continue;
            // Compute the layman-friendly severity/headline/impact at
            // record-time so the cache is rich enough for `pinned
            // catches`, CATCHES.md, and the chat hook to render
            // without re-deriving on every read.
            const impact = deriveCatchImpact(p.claim);
            catches.push({
              claimId: p.filename.replace(/\.test\.ts$/, ""),
              template: p.claim.template,
              route: "route" in p.claim ? (p.claim as { route: string }).route : undefined,
              claimText: p.claim.raw,
              fixSha: fx.fixCommit,
              severity: impact.severity,
              laymanHeadline: impact.headline,
              userImpact: impact.impact,
            });
          }
        }
        const result = recordBenchmarkCatches(targetPinnedDir, catches);
        if (result.recorded > 0) {
          out("");
          out(`  ↳ Recorded ${result.recorded} catch${result.recorded === 1 ? "" : "es"} into ${relative(process.cwd(), targetPinnedDir)}/.last-status.json`);
          out(`    (statusline will show "★ ${result.recorded} catches today" for the next 24h)`);
        } else if (result.skipped > 0) {
          out("");
          out(`  ↳ All ${result.skipped} catch${result.skipped === 1 ? "" : "es"} were already recorded — no statusline update.`);
        }
      }

      return;
    }
    const { runBacktest } = await import("./backtest.js");
    const report = await runBacktest({
      repoPath: resolve(opts.repo),
      fromCommit: opts.from,
      toCommit: opts.to,
      mode: opts.mode as "product" | "extended",
      maxReplayCommits: parseInt(opts.maxReplay, 10),
      vitestTimeoutMs: parseInt(opts.vitestTimeout, 10),
    });
    if (opts.json) {
      out(JSON.stringify(report, null, 2));
      return;
    }
    out("");
    out(`◆ pinned backtest — ${report.repo}`);
    out(`  mode:           ${report.mode}`);
    out(`  commits walked: ${report.commitsScanned}`);
    out(`  pins generated: ${report.pinsGenerated}`);
    out(`  by template:`);
    for (const [t, n] of Object.entries(report.pinsByTemplate)) {
      out(`    ${t.padEnd(22)} ${n}`);
    }
    out(`  not-testable (HTTP, no preview): ${report.notTestableHttp}`);
    out(`  broken-at-birth (claim didn't match code at install): ${report.brokenAtBirth}`);
    out(`  ★ catches:      ${report.catches}`);
    if (report.catches > 0) {
      out(`  catches by template:`);
      for (const [t, n] of Object.entries(report.catchesByTemplate)) {
        out(`    ${t.padEnd(22)} ${n}`);
      }
    }
    out(`  duration:       ${(report.durationMs / 1000).toFixed(1)}s`);
  });

// Exit codes:
//   0 — PASS:   no unprotected surfaces touched, no pins failing
//   1 — REVIEW: unprotected risk surfaces detected OR pins skipped
//                (PREVIEW_URL not set, fixture tokens missing, etc.)
//   2 — BLOCK:  at least one pin's test failed against the current
//                code (real regression catch)
//
// AI agents reading the output should choose action based on exit
// code: 0 → continue, 1 → surface review to user, 2 → fix code first.
program
  .command("guard")
  .description(
    "One-shot guard check: scan diff for unprotected behavior + run existing pins against current code. Exit 0 (PASS) / 1 (REVIEW) / 2 (BLOCK). Frictionless — no signup, no API key, runs locally. Use this as your AI-coder pre-merge sanity check."
  )
  .option(
    "--base <ref>",
    "Git ref to diff against (default: origin/main, falls back to HEAD~1)",
    "origin/main"
  )
  .option(
    "--dir <path>",
    "Pinned tests directory (default: tests/pinned)",
    "tests/pinned"
  )
  .option(
    "--json",
    "Emit a structured JSON summary for AI-agent consumption."
  )
  .option(
    "--no-test",
    "Skip running `pinned test` — only scan + report. Use when day-zero verification isn't viable yet."
  )
  .option("--quiet", "Suppress the pinned banner header.")
  .action(
    async (opts: {
      base: string;
      dir: string;
      json?: boolean;
      test?: boolean;
      quiet?: boolean;
    }) => {
      if (!opts.quiet) printBanner();
      assertInsideDir(opts.dir, process.cwd());

      // Stale-pin warning — surface pins generated by an older CLI
      // version so users know to run `pinned regenerate --all`. Pins
      // without a generated-by header (pre-0.2.1) are also flagged.
      // Non-blocking; just informational.
      if (!opts.quiet && existsSync(opts.dir)) {
        const stale = findStalePins(opts.dir, version);
        if (stale.length > 0) {
          const olderCount = stale.filter((s) => s.version !== null).length;
          const unstampedCount = stale.length - olderCount;
          out("");
          out(`⚠ ${stale.length} pin(s) generated by older pinnedai (current: ${version}):`);
          if (olderCount > 0) {
            const oldestVer = stale
              .map((s) => s.version)
              .filter((v): v is string => v !== null)
              .sort()[0];
            out(`  · ${olderCount} stamped older (oldest: ${oldestVer})`);
          }
          if (unstampedCount > 0) {
            out(`  · ${unstampedCount} unstamped (generated by pinnedai < 0.2.1)`);
          }
          out(`  Run \`pinned regenerate --all\` to apply current templates`);
          out(`  (fixes any template bugs that landed since these pins were created).`);
          out("");
        }
      }

      // Phase 1 — scan-diff against the base ref + working tree.
      //
      // Two correctness fixes (audit-3):
      // 1. The `--help` advertises "falls back to HEAD~1" but the old
      //    code silently returned [] when `origin/main` was unreachable.
      //    Implement the fallback chain explicitly.
      // 2. The guard is called by `pinned_before_done_check` from MCP —
      //    agents call it BEFORE they commit, so the uncommitted
      //    working tree is exactly what needs to be scanned. We always
      //    union working-tree changes into the result so a freshly-added
      //    /api/admin route doesn't slip past with verdict=PASS.
      const baseRefCandidates = [
        opts.base,
        // Only chain to fallbacks when the user accepted the default.
        ...(opts.base === "origin/main"
          ? ["main", "HEAD~1"]
          : []),
      ];
      let changedFiles: ReturnType<typeof readChangedFilesFromGit> = [];
      for (const ref of baseRefCandidates) {
        changedFiles = readChangedFilesFromGit(ref);
        if (changedFiles.length > 0) break;
      }
      // Always also include uncommitted work — guard runs at "about to
      // ship" time, not "about to merge" time.
      const workingTreeFiles = readChangedFilesFromGit("WORKING_TREE");
      const byPath = new Map<string, (typeof changedFiles)[number]>();
      for (const f of changedFiles) byPath.set(f.path, f);
      // Working-tree state wins on conflict — it's the more recent truth.
      for (const f of workingTreeFiles) byPath.set(f.path, f);
      changedFiles = Array.from(byPath.values());
      const body = process.env.GITHUB_PR_BODY ?? "";
      const prBodyClaims = body ? parseClaims(body) : [];
      const existingPins = existsSync(opts.dir)
        ? readRegistry(opts.dir).claims
        : [];
      const scan = scanDiffFull({
        changedFiles,
        prBodyClaims,
        existingPins,
      });

      // Phase 2 — pinned test (unless --no-test).
      // We spawn it as a child process so it inherits the customer's
      // vitest config + node_modules. Skip when:
      //   • opts.test === false (--no-test)
      //   • tests/pinned/ doesn't exist yet (pre-init)
      //   • tests/pinned/ exists but has zero .test.ts files (vitest
      //     would exit 1 with "No test files found" — a fresh
      //     pinned-init on a repo with no patterns yet to protect gets
      //     stuck in this state, and guard would falsely BLOCK).
      let pinTestFileCount = 0;
      if (existsSync(opts.dir)) {
        try {
          const fs = await import("node:fs");
          pinTestFileCount = fs
            .readdirSync(opts.dir)
            .filter((f) => f.endsWith(".test.ts"))
            .length;
        } catch {
          // ignore
        }
      }
      const shouldTest =
        opts.test !== false && existsSync(opts.dir) && pinTestFileCount > 0;
      let testExitCode = 0;
      let testOutput = "";
      if (shouldTest) {
        const cliBin = process.argv[1];
        const testRun = childSpawnSync(
          "node",
          [cliBin, "test", "--quiet", "--dir", opts.dir],
          {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            maxBuffer: 16 * 1024 * 1024,
            timeout: 120_000,
          }
        );
        testExitCode = testRun.status ?? 0;
        testOutput = (testRun.stdout ?? "") + (testRun.stderr ?? "");
      }

      // Compute verdict — PASS / REVIEW / BLOCK.
      // BLOCK takes precedence (real test failures = exit 2).
      // REVIEW = unprotected risks OR test runner reported skipped pins.
      // PASS = nothing actionable.
      const hasUnprotectedRisks = scan.suggestions.length > 0;
      const hasTouchedPins = scan.touchedPins.length > 0;
      const testFailed = testExitCode !== 0;
      const skippedFromTest = /(\d+)\s+skipped/.exec(testOutput);
      const skippedCount = skippedFromTest !== null ? parseInt(skippedFromTest[1], 10) : 0;
      const passedFromTest = /(\d+)\s+passed/.exec(testOutput);
      const passedCount = passedFromTest !== null ? parseInt(passedFromTest[1], 10) : 0;
      const hasSkippedPins = skippedCount > 0;
      // "Mostly inactive" = most of what ran was actually skipped. This
      // is the false-confidence trap surfaced by dogfooding 2026-06-02:
      // guard returning REVIEW with skipped pins reads as "almost-PASS"
      // when in fact Pinned is verifying nothing. We escalate the
      // messaging when the skip ratio is high.
      const totalRan = skippedCount + passedCount;
      const skipRatio = totalRan > 0 ? skippedCount / totalRan : 0;
      const mostlyInactive = totalRan > 0 && skipRatio >= 0.5;
      const fullyInactive = totalRan > 0 && passedCount === 0 && skippedCount > 0;

      let verdict: "PASS" | "REVIEW" | "BLOCK";
      let exitCode: 0 | 1 | 2;
      if (testFailed) {
        verdict = "BLOCK";
        exitCode = 2;
      } else if (hasUnprotectedRisks || hasSkippedPins) {
        verdict = "REVIEW";
        exitCode = 1;
      } else {
        verdict = "PASS";
        exitCode = 0;
      }

      if (opts.json) {
        out(
          JSON.stringify(
            {
              schema: "pinnedai.guard.v1",
              verdict,
              exitCode,
              touchedPins: scan.touchedPins.length,
              unprotectedSurfaces: scan.suggestions.map((s) => ({
                template: s.template,
                route: s.route,
                files: s.files,
                suggestedPin: s.suggestedPin,
                reason: s.reason,
              })),
              testFailed,
              skippedPins:
                skippedFromTest !== null
                  ? parseInt(skippedFromTest[1], 10)
                  : 0,
            },
            null,
            2
          )
        );
        process.exit(exitCode);
      }

      // Human-readable summary.
      out("");
      out(`◆ pinned guard · ${verdict}`);
      out("");

      if (hasTouchedPins) {
        const touched = renderTouchedPinsHuman(scan.touchedPins);
        if (touched) out(touched);
        out("");
      }

      if (hasUnprotectedRisks) {
        out(
          `⚠ ${scan.suggestions.length} unprotected risk surface${scan.suggestions.length === 1 ? "" : "s"} detected:`
        );
        for (const s of scan.suggestions) {
          out(`  • ${s.reason}`);
          for (const f of s.files) out(`      ${f}`);
          out(`    Suggested pin: "${s.suggestedPin}"`);
        }
        out("");
        out(
          `  To turn these into pins, run:  pinned protect  (interactive)`
        );
        out(`  Or add the suggested claim lines to your PR description.`);
        out("");
      }

      if (testFailed) {
        out(`✗ pinned test failed — at least one pin caught a regression.`);
        out(`  Run \`pinned test\` for full output, or \`pinned catches\` for history.`);
        out("");
      } else if (fullyInactive) {
        // EVERY pin skipped. Pinned is providing zero protection.
        // Loud to break the "false confidence" trap surfaced by
        // dogfooding 2026-06-02: REVIEW + ⊘ skipped read as
        // "almost-PASS" when in fact nothing was verified.
        out(`⚠ NOT VERIFYING — all ${skippedCount} pin(s) skipped this run.`);
        out(`  Pinned is providing ZERO protection right now. REVIEW is NOT 'almost-PASS'.`);
        out(`  Most common cause: PREVIEW_URL env var is unset, so live HTTP pins skip silently.`);
        out(`  Fix: export PREVIEW_URL=https://your-preview-deploy.vercel.app  (then re-run)`);
        out(`  Docs: https://pinnedai.dev/docs/preview-url`);
        out("");
      } else if (mostlyInactive) {
        // Majority skipped — also serious but less catastrophic than
        // fullyInactive. Still call out the gap explicitly so it's not
        // perceived as a near-pass.
        out(
          `⚠ MOSTLY NOT VERIFYING — ${skippedCount} of ${totalRan} pin(s) skipped (${Math.round(skipRatio * 100)}%).`
        );
        out(`  Only ${passedCount} pin(s) actually ran. The skipped ones provide no protection.`);
        out(`  Likely cause: PREVIEW_URL or fixture tokens unset. See https://pinnedai.dev/docs/preview-url.`);
        out("");
      } else if (hasSkippedPins) {
        out(
          `⊘ ${skippedCount} pin(s) skipped this run — those aren't verifying (set PREVIEW_URL / fixture tokens to enable).`
        );
        out(
          `  See https://pinnedai.dev/docs/preview-url. The other ${passedCount} pin(s) verified normally.`
        );
        out("");
      } else if (verdict === "PASS") {
        out(`✓ No unprotected surfaces, no pins failing. Safe to merge.`);
        out("");
      }

      process.exit(exitCode);
    }
  );

// Run one `git diff` (no path filter) and return a map of
// path → "added lines body" (concatenated "+" lines from unified diff,
// with the leading + stripped, joined by newlines). Empty string for
// files with no added lines.
function readDiffAddedLinesPerFile(base: string): Map<string, string> {
  const result = new Map<string, string>();
  let args: string[];
  if (base === "WORKING_TREE" || base === "" || base === "WORKTREE") {
    args = ["diff", "HEAD"];
  } else {
    args = ["diff", `${base}...HEAD`];
  }
  let raw = "";
  try {
    raw = execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return result;
  }
  if (!raw) return result;

  // Split by file. Each section starts with "diff --git a/<path> b/<path>".
  // sections[0] is empty (before the first "diff --git" header).
  const sections = raw.split(/^diff --git a\//gm).slice(1);
  for (const section of sections) {
    const firstLine = section.split("\n")[0];
    const pathMatch = /^(\S+)/.exec(firstLine);
    if (!pathMatch) continue;
    const path = pathMatch[1];
    const added = section
      .split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
      .map((l) => l.slice(1))
      .join("\n");
    result.set(path, added);
  }
  return result;
}

function readChangedFilesFromGit(base: string): ChangedFile[] {
  // Two modes:
  //   base === "WORKING_TREE" or "" → working-tree changes vs HEAD
  //                                   (uncommitted + untracked files).
  //   base === "<ref>"              → committed diff <ref>...HEAD
  //
  // Defensive: validate `base` against a safe ref pattern, and use
  // execFileSync (no shell) so a malicious base value can't inject
  // shell commands.
  // Git refs can include `~N` (parent), `^N` (parent-of-merge), and `@`
  // (e.g. `HEAD@{1}`). The regex must permit them; previously `~` was
  // rejected, causing `pinned scan-diff --base HEAD~1` to silently
  // no-op. Path-traversal is still blocked by the absence of `..`,
  // whitespace, and quote characters.
  const files: ChangedFile[] = [];

  if (base === "WORKING_TREE" || base === "" || base === "WORKTREE") {
    // git diff HEAD --name-status → tracked, modified/added/deleted
    let trackedRaw = "";
    try {
      trackedRaw = execFileSync("git", ["diff", "HEAD", "--name-status"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      // No HEAD yet (fresh repo) — fall through to untracked-only.
    }
    for (const line of trackedRaw.split("\n")) {
      const m = /^([AMD])\s+(.+)$/.exec(line.trim());
      if (!m) continue;
      const status = m[1] === "A" ? "added" : m[1] === "M" ? "modified" : "deleted";
      files.push({ path: m[2], status });
    }
    // git ls-files --others --exclude-standard → untracked (new) files
    let untrackedRaw = "";
    try {
      untrackedRaw = execFileSync(
        "git",
        ["ls-files", "--others", "--exclude-standard"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      );
    } catch {
      // Not a git repo — return what we have.
    }
    for (const path of untrackedRaw.split("\n")) {
      const p = path.trim();
      if (p) files.push({ path: p, status: "added" });
    }
    // Same addedLines population for the working-tree branch — pass
    // the same sentinel so readDiffAddedLinesPerFile uses `git diff HEAD`.
    const addedLinesMap = readDiffAddedLinesPerFile(base);
    for (const f of files) {
      if (f.status === "modified") {
        f.addedLines = addedLinesMap.get(f.path) ?? "";
      }
    }
    return files;
  }

  if (!/^[A-Za-z0-9._\/~^@{}-]+$/.test(base) || base.includes("..")) {
    process.stderr.write(`✗ Invalid --base ref '${base}'\n`);
    return [];
  }
  let raw = "";
  try {
    raw = execFileSync(
      "git",
      ["diff", `${base}...HEAD`, "--name-status"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
  } catch {
    // No git repo / no base ref — return empty, scan still runs cleanly.
    return [];
  }
  for (const line of raw.split("\n")) {
    const m = /^([AMD])\s+(.+)$/.exec(line.trim());
    if (!m) continue;
    const status =
      m[1] === "A" ? "added" : m[1] === "M" ? "modified" : "deleted";
    files.push({ path: m[2], status });
  }
  // Populate addedLines per modified file from the diff body, so the
  // classifier can scan only newly-added content (not re-detect every
  // pre-existing pattern in the file on every commit).
  const addedLinesMap = readDiffAddedLinesPerFile(base);
  for (const f of files) {
    if (f.status === "modified") {
      f.addedLines = addedLinesMap.get(f.path) ?? "";
    }
  }
  return files;
}

// ---------- pr-comment ----------
// The short-form PR comment that replaces raw scan-diff --markdown
// output in the workflow. Picks one of 4 templates based on what's
// in the diff + description: quiet-success, claims-added, risky-no-pin,
// or broken-pin (regression caught).
//
// Used by the GitHub Action — the workflow runs:
//   pinned pr-comment --description "$BODY" --base "origin/$BASE"
// and pipes the markdown into `gh pr comment`.
program
  .command("pr-comment")
  .description(
    "Render a short Markdown comment summarizing pinned's view of this PR. Designed for `gh pr comment --body $(pinned pr-comment ...)`."
  )
  .option(
    "--base <ref>",
    "Git ref to diff against (default: origin/main)",
    "origin/main"
  )
  .option(
    "--description <text>",
    "PR description text — claims here are counted as 'will be added'."
  )
  .option(
    "--dir <path>",
    "Pinned tests directory (for total + coverage count)",
    "tests/pinned"
  )
  .option(
    "--pr-id <id>",
    "PR identifier — used for the prId field on previewed pins."
  )
  .option("--quiet", "Suppress the pinned banner header.")
  .action(
    async (opts: {
      base: string;
      description?: string;
      dir: string;
      prId?: string;
    }) => {
      printBanner();
      assertInsideDir(opts.dir, process.cwd());
      const body = opts.description ?? process.env.GITHUB_PR_BODY ?? "";
      const regex = parseClaims(body);
      const llm = await llmExtract(body);
      const llmClaims = llm.ok ? llm.claims : [];
      const allClaims = unionClaims(regex, llmClaims);

      const changedFiles = readChangedFilesFromGit(opts.base);
      const registry = existsSync(join(opts.dir, ".registry.json"))
        ? readRegistry(opts.dir)
        : { version: 1 as const, claims: [] };
      const existingPins = registry.claims;
      const totalActivePins = existingPins.filter((c) => c.status === "active").length;

      const scan = scanDiffFull({
        changedFiles,
        prBodyClaims: allClaims,
        existingPins,
      });

      // "Added" = claims in description that aren't already pinned by claimKey
      const existingKeys = new Set(
        existingPins
          .filter((c) => c.status === "active")
          .map((c) => `${c.claim.template}:${JSON.stringify(c.claim)}`)
      );
      const addedPins = allClaims
        .filter(
          (c) => !existingKeys.has(`${c.template}:${JSON.stringify(c)}`)
        )
        .map((c) => {
          const gen = generateTest(c, { prId: opts.prId ?? "this-pr" });
          return { filename: gen.filename, claim: c };
        });

      const comment = renderPrComment({
        totalActivePins: totalActivePins + addedPins.length,
        addedPins,
        suggestions: scan.suggestions,
        coverage: scan.coverage,
        // v0.1: brokenPins detection requires a separate test run; the
        // workflow can produce these by parsing vitest output and
        // calling pinned pr-comment with --broken-pin entries (v0.2).
        brokenPins: [],
        prNumber: null,
      });
      out(comment);
    }
  );

// ---------- baseline / risks ----------
// One-shot: walk the working tree, find candidate pins from current
// state (not just the diff). The "wow" moment when you install on a
// 6-month-old repo and instantly see 10+ suggested pins.
//
// `pinned risks` is the same command — more natural name for solo AI
// coders ("what risks does this repo have?"). Pairs with `pinned protect`
// which turns risks into actual pins interactively.
program
  .command("baseline")
  .alias("risks")
  .description(
    "Scan the entire working tree for risk surfaces and suggest pins to add. Run once after `pinned init` on an existing repo. Alias: `pinned risks`."
  )
  .option(
    "--dir <path>",
    "Pinned tests directory (for already-pinned check)",
    "tests/pinned"
  )
  .option("--json", "Emit JSON instead of human text.")
  .option("--markdown", "Emit Markdown.")
  .option("--quiet", "Suppress the pinned banner header.")
  .action((opts: { dir: string; json?: boolean; markdown?: boolean }) => {
    printBanner();
    assertInsideDir(opts.dir, process.cwd());
    const root = process.cwd();
    const allFiles = walkRepo(root);
    const changed: ChangedFile[] = allFiles.map((p) => ({
      path: p,
      status: "added",
    }));
    const existingPins = readRegistry(opts.dir).claims;
    const result = scanDiffFull({
      changedFiles: changed,
      prBodyClaims: [],
      existingPins,
    });
    if (opts.json) {
      out(JSON.stringify(result.suggestions, null, 2));
      return;
    }
    if (opts.markdown) {
      out(renderSuggestionsMarkdown(result.suggestions, []));
      return;
    }
    if (result.suggestions.length === 0) {
      out("✓ No candidate pins detected in the current working tree.");
      return;
    }
    out(
      `Found ${result.suggestions.length} candidate pin(s) in your repo. Add the suggested lines to your next PR description (or comment \`@pinned add:\` on any PR):`
    );
    out("");
    for (const s of result.suggestions) {
      out(`  • ${s.reason}`);
      for (const f of s.files.slice(0, 3)) out(`      ${f}`);
      if (s.files.length > 3) out(`      … and ${s.files.length - 3} more`);
      out(`    → ${s.suggestedPin}`);
      out("");
    }
  });

function walkRepo(root: string): string[] {
  const IGNORE_DIRS = new Set([
    "node_modules",
    ".git",
    ".next",
    "dist",
    "build",
    "out",
    ".turbo",
    ".cache",
    "coverage",
    "tests/pinned",
  ]);
  const files: string[] = [];

  // Use lstatSync (not statSync) so we don't follow symlinks. This
  // prevents two failure modes:
  //   1. Symlink loops (a -> b -> a) infinite recursion
  //   2. Symlinks that escape the repo (e.g. -> /etc/passwd)
  const walk = (rel: string): void => {
    const abs = join(root, rel);
    let entries;
    try {
      entries = readdirSync(abs);
    } catch {
      return;
    }
    for (const name of entries) {
      const relPath = rel ? `${rel}/${name}` : name;
      if (IGNORE_DIRS.has(relPath) || IGNORE_DIRS.has(name)) continue;
      let st;
      try {
        st = lstatSync(join(abs, name));
      } catch {
        continue;
      }
      // Skip symlinks entirely — too easy to misuse, and not worth
      // resolving them safely for a one-shot baseline scan.
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        walk(relPath);
      } else if (st.isFile()) {
        files.push(relPath);
      }
    }
  };

  walk("");
  return files;
}

// ---------- doctor ----------
// Diagnose common setup issues. "Why isn't pinnedai working?" answered.
program
  .command("doctor")
  .description("Health check for pinnedai setup in this repo.")
  .option("--quiet", "Suppress the pinned banner header.")
  .option(
    "--json",
    "Emit structured JSON for AI-agent consumption. Includes per-check name / severity / detail / fix. Exits non-zero if any check failed."
  )
  .action(async (opts: { json?: boolean }) => {
    if (!opts.json) printBanner();
    const cwd = process.cwd();
    const checks: {
      name: string;
      result: "ok" | "warn" | "fail";
      detail: string;
      fix?: string;
    }[] = [];

    // tests/pinned/ exists
    const pinnedDir = join(cwd, "tests", "pinned");
    if (existsSync(pinnedDir)) {
      checks.push({ name: "tests/pinned/ directory", result: "ok", detail: "present" });
    } else {
      checks.push({
        name: "tests/pinned/ directory",
        result: "fail",
        detail: "missing — run `pinned init`",
      });
    }

    // .github/workflows/pinned.yml exists
    const workflowPath = join(cwd, ".github", "workflows", "pinned.yml");
    if (existsSync(workflowPath)) {
      const workflowContent = readFileSync(workflowPath, "utf8");
      checks.push({
        name: ".github/workflows/pinned.yml",
        result: "ok",
        detail: "present",
      });
      if (workflowContent.includes("id-token: write")) {
        checks.push({
          name: "Workflow OIDC permission",
          result: "ok",
          detail: "id-token: write declared",
        });
      } else {
        checks.push({
          name: "Workflow OIDC permission",
          result: "fail",
          detail: "missing `id-token: write` — LLM extraction won't work",
        });
      }
      if (workflowContent.includes("contents: write")) {
        checks.push({
          name: "Workflow auto-commit permission",
          result: "ok",
          detail: "contents: write declared",
        });
      } else {
        checks.push({
          name: "Workflow auto-commit permission",
          result: "warn",
          detail: "no `contents: write` — auto-commit will be skipped",
        });
      }
    } else {
      checks.push({
        name: ".github/workflows/pinned.yml",
        result: "fail",
        detail: "missing — run `pinned init`",
      });
    }

    // Vitest availability — THE most load-bearing health check. Without
    // a runnable test framework, `pinned test` cannot execute, pins
    // never verify, and regressions silently slip through. Severity:
    //   - fail when active pins exist but vitest is absent (broken)
    //   - warn when no pins yet but vitest absent (will block first test)
    //   - ok when present
    const { detectVitest, detectPackageManager } = await import("./vitestSetup.js");
    const hasVitest = detectVitest(cwd);

    // PINS.md + .registry.json — read registry ONCE and reuse for both
    // the pin-count check and the PREVIEW_URL check below. A transient
    // mutation between reads would otherwise crash the second read
    // after the first had already reported a clean result.
    const pinsPath = join(pinnedDir, "PINS.md");
    const registryPath = join(pinnedDir, ".registry.json");
    let registrySnapshot: { active: number; total: number } | null = null;

    if (existsSync(pinsPath) && existsSync(registryPath)) {
      const reg = readRegistry(pinnedDir);
      const active = countActivePins(reg);
      registrySnapshot = { active, total: reg.claims.length };
      checks.push({
        name: "PINS.md registry",
        result: "ok",
        detail: `${active} active pin(s), ${reg.claims.length - active} retired`,
      });
      // No pin-count cap to warn about — every tier gets unlimited pins.
    } else {
      checks.push({
        name: "PINS.md registry",
        result: "warn",
        detail: "no pins yet — open a PR with a claim",
      });
    }

    // Vitest check — placed AFTER the registry read so we can correctly
    // escalate severity when there are active pins to verify.
    const pm = detectPackageManager(cwd);
    const installCmd = `${pm} ${pm === "npm" ? "install --save-dev" : "add -D"} vitest@^2`;
    if (hasVitest) {
      checks.push({
        name: "Vitest test runner",
        result: "ok",
        detail: "present in package.json — `pinned test` can run",
      });
    } else if (registrySnapshot && registrySnapshot.active > 0) {
      checks.push({
        name: "Vitest test runner",
        result: "fail",
        detail: `MISSING — \`pinned test\` cannot run, ${registrySnapshot.active} pin(s) will never verify`,
        fix: installCmd,
      });
    } else {
      checks.push({
        name: "Vitest test runner",
        result: "warn",
        detail: "not in package.json — install before your first pin runs",
        fix: installCmd,
      });
    }

    // PREVIEW_URL — only warn if there ARE active pins (since the
    // generated tests need PREVIEW_URL to run). Uses the snapshot
    // from above so no double-read of the registry.
    if (registrySnapshot && registrySnapshot.active > 0) {
      if (process.env.PREVIEW_URL) {
        checks.push({
          name: "PREVIEW_URL",
          result: "ok",
          detail: process.env.PREVIEW_URL,
        });
      } else {
        checks.push({
          name: "PREVIEW_URL",
          result: "warn",
          detail: "not set — web-template pins will skip silently. See setup guide at https://pinnedai.dev/docs/preview-url (covers Vercel / Fly / Cloudflare / Render / Railway / tunnel-from-CI).",
        });
      }
    }

    // BYOK opt-in status. Local check confirms the env wiring is
    // consistent with the selected provider. Covers all 4 providers.
    const byok = activeByokProvider();
    if (byok === "claude-code") {
      // No env key needed — just check the binary is on PATH.
      try {
        execFileSync("command", ["-v", "claude"], { stdio: "ignore" });
        checks.push({
          name: `BYOK (claude-code)`,
          result: "ok",
          detail: `\`claude\` CLI found on PATH — uses your Claude Pro/Max subscription`,
        });
      } catch {
        checks.push({
          name: `BYOK (claude-code)`,
          result: "fail",
          detail: `PINNEDAI_BYOK=claude-code but \`claude\` CLI is not on PATH. Install Claude Code from claude.ai/download or pick a different provider.`,
        });
      }
    } else if (byok === "github-models") {
      const tok = process.env.PINNEDAI_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
      if (tok) {
        const which = process.env.PINNEDAI_GITHUB_TOKEN ? "PINNEDAI_GITHUB_TOKEN" : "GITHUB_TOKEN";
        checks.push({
          name: `BYOK (github-models)`,
          result: "ok",
          detail: `${which} present — uses Microsoft's free GitHub Models tier`,
        });
      } else {
        checks.push({
          name: `BYOK (github-models)`,
          result: "fail",
          detail: `PINNEDAI_BYOK=github-models but neither PINNEDAI_GITHUB_TOKEN nor GITHUB_TOKEN is set. Use \`gh auth token\` to get one.`,
        });
      }
    } else if (byok) {
      const envName =
        byok === "anthropic"
          ? "PINNEDAI_ANTHROPIC_KEY"
          : "PINNEDAI_OPENAI_KEY";
      if (process.env[envName]) {
        checks.push({
          name: `BYOK (${byok})`,
          result: "ok",
          detail: `${envName} present — LLM proposer will run via your ${byok} key`,
        });
      } else {
        checks.push({
          name: `BYOK (${byok})`,
          result: "fail",
          detail: `PINNEDAI_BYOK=${byok} but ${envName} is not set`,
        });
      }
    } else if (process.env.PINNEDAI_BYOK) {
      checks.push({
        name: "BYOK opt-in",
        result: "fail",
        detail: `PINNEDAI_BYOK='${process.env.PINNEDAI_BYOK}' is not recognized. Expected: anthropic | openai | claude-code | github-models.`,
      });
    }

    const fails = checks.filter((c) => c.result === "fail").length;
    const warns = checks.filter((c) => c.result === "warn").length;

    // JSON mode for AI agents / CI scripts. Schema is stable across
    // versions: an agent that polls `pinned doctor --json` after
    // setup can parse this and know whether to block / retry / proceed.
    if (opts.json) {
      const verdict: "healthy" | "degraded" | "broken" =
        fails > 0 ? "broken" : warns > 0 ? "degraded" : "healthy";
      out(
        JSON.stringify(
          {
            schema: "pinnedai.doctor.v1",
            verdict,
            errors: fails,
            warnings: warns,
            checks: checks.map((c) => ({
              name: c.name,
              severity: c.result,
              detail: c.detail,
              fix: c.fix,
            })),
          },
          null,
          2
        )
      );
      if (fails > 0) process.exit(1);
      return;
    }

    // Print results
    out("pinned doctor — setup health check");
    out("");
    const symbol = { ok: "✓", warn: "⚠", fail: "✗" };
    for (const c of checks) {
      out(`  ${symbol[c.result]} ${c.name.padEnd(40)} ${c.detail}`);
      if (c.fix && c.result !== "ok") {
        out(`    → fix: ${c.fix}`);
      }
    }
    out("");
    if (fails === 0 && warns === 0) {
      out("All checks passed.");
    } else {
      out(`${fails} error(s), ${warns} warning(s).`);
      if (fails > 0) process.exit(1);
    }
  });

// ---------- protect ----------
// Turn unpinned risks into pins. Interactive by default — shows the
// candidate list from baseline + asks before adding. `--all` skips
// the prompt for CI / scripted usage; `--dry-run` shows what would
// be added without writing files.
//
// This is the actionable counterpart to `pinned risks`. The product
// loop becomes: status line shows ⚠ 2 risks → user runs `pinned protect`
// → tests added → future AI changes can't silently break it.
program
  .command("protect")
  .description(
    "Turn unpinned risks into pins. Interactive: lists candidates from `pinned risks`, asks which to pin, generates tests for the chosen ones."
  )
  .option(
    "--all",
    "Protect every detected risk without asking (use in CI / scripts)."
  )
  .option(
    "--dry-run",
    "Print what would be pinned without writing files."
  )
  .option(
    "--dir <path>",
    "Pinned tests directory (default: tests/pinned)",
    "tests/pinned"
  )
  .option("--quiet", "Suppress the pinned banner header.")
  .action(
    async (opts: { all?: boolean; dryRun?: boolean; dir: string }) => {
      printBanner();
      assertInsideDir(opts.dir, process.cwd());
      const root = process.cwd();
      const allFiles = walkRepo(root);
      const changed: ChangedFile[] = allFiles.map((p) => ({
        path: p,
        status: "added",
      }));
      const existingPins = existsSync(opts.dir)
        ? readRegistry(opts.dir).claims
        : [];
      const result = scanDiffFull({
        changedFiles: changed,
        prBodyClaims: [],
        existingPins,
      });
      if (result.suggestions.length === 0) {
        out("✓ No unpinned risks detected. Nothing to protect.");
        return;
      }

      out(`Pinned can protect ${result.suggestions.length} unpinned risk${result.suggestions.length === 1 ? "" : "s"}:`);
      out("");
      for (let i = 0; i < result.suggestions.length; i++) {
        const s = result.suggestions[i];
        out(`  [${i + 1}] ${s.reason}`);
        out(`      → ${s.suggestedPin}`);
        out("");
      }

      // Decide which to pin
      let selected: number[] = [];
      if (opts.all) {
        selected = result.suggestions.map((_, i) => i);
        out(`(--all: protecting all ${selected.length} risks)`);
      } else if (!process.stdin.isTTY) {
        err(
          "✗ `pinned protect` requires --all in non-interactive shells (no TTY for prompting).\n"
        );
        process.exit(1);
      } else {
        const choice = await promptProtectChoice(result.suggestions.length);
        if (choice === "cancel") {
          out("Cancelled. No pins added.");
          return;
        }
        selected = choice;
      }

      if (opts.dryRun) {
        out("");
        out(`(--dry-run: ${selected.length} pin${selected.length === 1 ? "" : "s"} would be added.)`);
        return;
      }

      // Pin each selected suggestion via the claim parser
      mkdirSync(opts.dir, { recursive: true });
      let registry = readRegistry(opts.dir);
      let written = 0;
      const addedSummaries: string[] = [];
      const prId = `protect-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
      for (const idx of selected) {
        const s = result.suggestions[idx];
        const parsed = parseClaims(s.suggestedPin);
        if (parsed.length === 0) {
          out(`  (skipped: suggested pin "${s.suggestedPin}" didn't parse cleanly)`);
          continue;
        }
        for (const claim of parsed) {
          const gen = generateTest(claim, { prId, pinnedVersion: version });
          const target = join(opts.dir, gen.filename);
          assertInsideDir(target, opts.dir);
          try {
            writeFileSync(target, gen.content, { flag: "wx" });
            out(`  ✓ ${relative(process.cwd(), target)}`);
            registry = addEntry(registry, {
              claimId: gen.claimId,
              prId,
              claim,
              filename: gen.filename,
            });
            written += 1;
            addedSummaries.push(summarizeClaimForBanner(claim));
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "EEXIST") {
              out(`  = ${gen.filename} (already pinned, skipping)`);
              continue;
            }
            throw e;
          }
        }
      }
      if (written > 0) {
        writeRegistry(opts.dir, registry);
        stampPinAddedToCache(
          opts.dir,
          written,
          countActivePins(registry),
          addedSummaries
        );
        out("");
        out(`★ Pinned now protects ${written} more thing${written === 1 ? "" : "s"}:`);
        for (const s of addedSummaries.slice(0, 5)) {
          out(`   + ${s}`);
        }
        if (addedSummaries.length > 5) {
          out(`   + …and ${addedSummaries.length - 5} more`);
        }
        out("");
        out(`If AI changes break any of these, your tests will fail and Pinned will tell you.`);
      }
    }
  );

// ---------- auto-protect ----------
// Run the classifier against the current diff. In `safe` mode, auto-add
// pins for deterministic candidates (respecting safety budget). In `ask`
// mode, just record the suggestion count for the statusline. In `off`
// mode, no-op.
program
  .command("auto-protect")
  .description(
    "Run the auto-protect classifier against the current diff. Auto-adds safe pins in `safe` mode; records suggestions in `ask` mode; no-op in `off` mode."
  )
  .option(
    "--base <ref>",
    "Diff base. Default: WORKING_TREE (uncommitted + untracked). Pass any git ref (e.g. main) to scan committed diffs against that ref.",
    "WORKING_TREE"
  )
  .option(
    "--mode <mode>",
    "Override the configured auto-protect mode: safe | ask | off"
  )
  .option(
    "--budget <n>",
    "Override safety_budget_per_run (max pins auto-added per invocation)",
    (v) => parseInt(v, 10)
  )
  .option(
    "--dry-run",
    "Print what would happen without writing files or updating the cache."
  )
  .option(
    "--dir <path>",
    "Pinned tests directory (default: tests/pinned)",
    "tests/pinned"
  )
  .option("--quiet", "Suppress the pinned banner header.")
  .option(
    "--auto-stage",
    "Stage the specific files Pinned wrote this run (newly authored pin files + .registry.json + PINS.md). Used by the pre-commit hook. Replaces the previous blanket `git add tests/pinned/` so unrelated changes in tests/pinned/ aren't silently bundled into the user's commit."
  )
  .action(async (opts: {
    base: string;
    mode?: string;
    budget?: number;
    dryRun?: boolean;
    dir: string;
    quiet?: boolean;
    autoStage?: boolean;
  }) => {
    printBanner();
    assertInsideDir(opts.dir, process.cwd());
    const cwd = process.cwd();

    // Resolve effective mode: --mode flag → env → config.
    const cfg = readConfigImport(cwd);
    let mode: AutoProtectMode = effectiveModeImport(cwd);
    if (opts.mode) {
      const m = opts.mode.toLowerCase();
      if (m !== "safe" && m !== "ask" && m !== "off") {
        err(`✗ Invalid --mode '${opts.mode}'. Use: safe | ask | off\n`);
        process.exit(1);
      }
      mode = m;
    }
    const budget = opts.budget ?? cfg.safety_budget_per_run;

    if (mode === "off") {
      out(`auto-protect: off (nothing to do — change with \`pinned init --auto-protect safe\`)`);
      return;
    }

    const changed = readChangedFilesFromGit(opts.base);
    if (changed.length === 0) {
      out(`No changed files vs ${opts.base}. Nothing to classify.`);
      return;
    }

    const existingPins = existsSync(opts.dir)
      ? readRegistry(opts.dir).claims
      : [];
    const { classifyDiff, applySafetyBudget, applyMode } = await import("./autoProtect.js");
    const classified = classifyDiff({
      repoRoot: cwd,
      changedFiles: changed,
      prBodyClaims: [],
      existingPins,
    });
    const budgeted = applySafetyBudget(classified, budget);
    const gated = applyMode(
      { safe: budgeted.safe, ask: budgeted.ask },
      mode
    );

    // Suggestion count surfaces in the statusline (ask mode) and in
    // `pinned status`. Updated even in safe mode — there may be ask
    // candidates that the classifier wouldn't auto-pin.
    const suggestedCount = gated.suggested.length;

    if (opts.dryRun) {
      out(`(--dry-run)`);
      out(`Mode: ${mode}`);
      out(`Safety budget: ${budget}`);
      out("");
      if (gated.autoAdd.length > 0) {
        out(`Would auto-add ${gated.autoAdd.length} pin${gated.autoAdd.length === 1 ? "" : "s"}:`);
        for (const c of gated.autoAdd) {
          out(`  + ${c.claim.template} · ${c.reason}`);
          out(`    triggered by: ${c.triggeredBy}`);
        }
        out("");
      }
      if (gated.suggested.length > 0) {
        out(`Would suggest ${gated.suggested.length} pin${gated.suggested.length === 1 ? "" : "s"} (run \`pinned protect\` to review):`);
        for (const c of gated.suggested) {
          out(`  ? ${c.claim.template} · ${c.reason}`);
        }
      }
      if (gated.autoAdd.length === 0 && gated.suggested.length === 0) {
        out("✓ No new behaviors to protect.");
      }
      return;
    }

    // Write pin files for autoAdd candidates.
    let written = 0;
    let registry = existsSync(opts.dir)
      ? readRegistry(opts.dir)
      : { version: 1 as const, claims: [] };
    if (!existsSync(opts.dir)) mkdirSync(opts.dir, { recursive: true });
    const prId = `auto-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;

    const addedSummariesAP: string[] = [];
    const writtenPinPaths: string[] = [];
    for (const cand of gated.autoAdd) {
      const gen = generateTest(cand.claim, { prId });
      const target = join(opts.dir, gen.filename);
      assertInsideDir(target, opts.dir);
      try {
        writeFileSync(target, gen.content, { flag: "wx" });
        out(`+ ${relative(cwd, target)}  [auto-protect: ${cand.reason}]`);
        registry = addEntry(registry, {
          claimId: gen.claimId,
          prId,
          claim: cand.claim,
          filename: gen.filename,
        });
        written += 1;
        addedSummariesAP.push(summarizeClaimForBanner(cand.claim));
        writtenPinPaths.push(relative(cwd, target));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") {
          continue; // already pinned — silent
        }
        throw e;
      }
    }
    if (written > 0) {
      writeRegistry(opts.dir, registry);
      // Sanctioned-write marker: tells the pre-commit hook that the
      // about-to-follow `check-guard-removal` should NOT flag the
      // registry / PINS.md modifications or the newly-authored pin
      // files. Same mechanism `pinned regenerate` uses. Without this
      // marker, auto-protect's own writes would block the user's
      // commit — the hook would call its own work AI tampering.
      const registryRel = relative(cwd, join(opts.dir, ".registry.json"));
      const pinsRel = relative(cwd, join(opts.dir, "PINS.md"));
      const allWritten = [registryRel, pinsRel, ...writtenPinPaths];
      writeSanctionedWriteMarker("auto-protect", allWritten);

      // --auto-stage: stage ONLY the files Pinned just authored, with
      // a visible notice. Replaces the previous blanket `git add
      // tests/pinned/` from the shell hook, which silently bundled any
      // unrelated change in tests/pinned/ into the user's commit.
      if (opts.autoStage) {
        const staged: string[] = [];
        for (const p of allWritten) {
          try {
            childSpawnSync("git", ["add", "--", p], {
              cwd,
              stdio: "ignore",
            });
            staged.push(p);
          } catch {
            /* best-effort; user can stage manually if this fails */
          }
        }
        if (staged.length > 0 && !opts.quiet) {
          out("");
          out(
            `pinned: auto-staged ${staged.length} file${staged.length === 1 ? "" : "s"} into this commit:`
          );
          for (const p of staged.slice(0, 6)) {
            out(`   • ${p}`);
          }
          if (staged.length > 6) {
            out(`   • …and ${staged.length - 6} more`);
          }
          out(
            `   (this replaces the pre-0.2.7 blanket \`git add tests/pinned/\` —`
          );
          out(
            `    only files Pinned itself authored this run are staged; unrelated`
          );
          out(`    changes in tests/pinned/ stay where you left them)`);
        }
      }
    }

    // Stamp the cache so the statusline + status command surface the
    // new state. Carry forward everything we shouldn't lose.
    const prev = readLastStatus(opts.dir);
    const { sha, dirtyHash } = captureGitState(cwd);
    writeLastStatus(opts.dir, {
      // Spread `prev` so every field of LastStatus is preserved by
      // default — only the fields auto-protect computes are overridden.
      // This is the right pattern for ALL writeLastStatus callers:
      // wholesale replacement silently drops fields owned by other
      // surfaces (lastAutoProtectAt, lastAddNotifiedAt, etc.).
      ...(prev ?? {}),
      status: prev?.status ?? "green",
      failingCount: prev?.failingCount ?? 0,
      failingClaimIds: prev?.failingClaimIds ?? [],
      totalPins: countActivePins(registry),
      recentlyAddedCount: written > 0 ? written : prev?.recentlyAddedCount,
      recentlyAddedAt: written > 0 ? new Date().toISOString() : prev?.recentlyAddedAt,
      recentlyAddedSummaries:
        written > 0 ? addedSummariesAP.slice(0, 5) : prev?.recentlyAddedSummaries,
      suggestedCount,
      lastCheckedSha: sha ?? undefined,
      lastCheckedDirtyHash: dirtyHash ?? undefined,
      updatedAt: new Date().toISOString(),
    });

    out("");
    if (written > 0) {
      // Name the added pins so the user sees what they got, not just
      // a count. Same pattern as init's success banner.
      out(`★ Pinned now protects ${written} more thing${written === 1 ? "" : "s"}:`);
      for (const s of addedSummariesAP.slice(0, 5)) {
        out(`   + ${s}`);
      }
      if (addedSummariesAP.length > 5) {
        out(`   + …and ${addedSummariesAP.length - 5} more`);
      }
      if (suggestedCount > 0) {
        out("");
        out(
          `   ${suggestedCount} more pin${suggestedCount === 1 ? "" : "s"} suggested — run \`pinned protect\` to review.`
        );
      }
    } else if (suggestedCount > 0) {
      out(
        `${suggestedCount} pin${suggestedCount === 1 ? "" : "s"} suggested — run \`pinned protect\` to review.`
      );
    } else {
      out(`✓ No new behaviors to protect.`);
    }

    // Host-conditional warnings (0.2.7+). Surface AFTER the pin
    // counts so the user sees the divergence-risk note when their
    // newly-added pin would otherwise false-fail on first PREVIEW_URL run.
    const hostWarnings = classified.warnings?.hostConditional;
    if (hostWarnings && hostWarnings.length > 0 && !opts.quiet) {
      out("");
      out(
        `⚠ Host-conditional handler${hostWarnings.length === 1 ? "" : "s"} detected (${hostWarnings.length})`
      );
      out(
        `   These handlers read the request host header and gate behavior on it.`
      );
      out(
        `   When Pinned probes against PREVIEW_URL, the handler likely takes its`
      );
      out(
        `   non-prod branch — happy-path / journey pins for these routes may`
      );
      out(
        `   false-fail on first run.`
      );
      for (const w of hostWarnings.slice(0, 5)) {
        out(`   • ${w.filePath}${w.route ? `  (${w.route})` : ""}`);
      }
      if (hostWarnings.length > 5) {
        out(`   • …and ${hostWarnings.length - 5} more`);
      }
      out(
        `   See https://pinnedai.dev/docs/host-conditional for the wrapper that`
      );
      out(`   makes Pinned probes follow the prod branch.`);
    }
  });

// ---------- review ----------
// User-facing wrapper around auto-protect (+ optional safety pass).
// Closes the discoverability gap created by the statusline's
// "N to review" indicator — typing `pinned review` does what the
// status told you needs doing.
//
// Behavior:
//   pinned review            — runs auto-protect, prints a friendly report
//   pinned review --deep     — also runs the deterministic Safety Pass
//   pinned review --dry-run  — preview only, write nothing
//
// Internally invokes `pinned auto-protect` via spawn so we get the
// identical classification logic + cache writes that the hooks use.
// Output is post-processed for a more polished UX.
program
  .command("review")
  .description(
    "Run a review now: scans for Pinned-relevant changes, auto-adds safe pins, reports what was protected. Run `pinned review --deep` to also run the Safety Pass."
  )
  .option(
    "--deep",
    "Also run the deterministic Safety Pass after auto-protect."
  )
  .option(
    "--dry-run",
    "Preview what would happen without writing pin files."
  )
  .option(
    "--mode <mode>",
    "Override the configured auto-protect mode for this run: safe | ask | off."
  )
  .option(
    "--dir <path>",
    "Pinned tests directory (default: tests/pinned)",
    "tests/pinned"
  )
  .option("--quiet", "Suppress the pinned banner header.")
  .action(async (opts: { deep?: boolean; dryRun?: boolean; mode?: string; dir: string }) => {
    printBanner();
    assertInsideDir(opts.dir, process.cwd());

    const cwd = process.cwd();
    const { countRelevantChanges } = await import("./statusline.js");
    const changes = countRelevantChanges(cwd);

    // Header — set the user's expectation for what's about to happen.
    out("");
    out(`◆ Reviewing this repo`);
    out("");
    if (changes && changes.relevant > 0) {
      out(
        `  ${changes.relevant} Pinned-relevant change${changes.relevant === 1 ? "" : "s"} detected${
          changes.hasHighRisk ? " (includes a high-risk path)" : ""
        }.`
      );
    } else if (changes && changes.total > 0) {
      out(`  ${changes.total} uncommitted file${changes.total === 1 ? "" : "s"}, none match Pinned's patterns.`);
    } else {
      out(`  No uncommitted changes detected.`);
    }
    out("");

    // Capture pin count BEFORE auto-protect so we can report the delta.
    const regBefore = existsSync(opts.dir)
      ? readRegistry(opts.dir)
      : { version: 1 as const, claims: [] };
    const pinsBefore = countActivePins(regBefore);

    // Run auto-protect with the same args the user passed. Run as a
    // child so we get the canonical classification + cache-write
    // behavior; capture stdout for our friendlier report.
    out(`Running auto-protect…`);
    const { spawnSync } = await import("node:child_process");
    const autoArgs = ["auto-protect", "--dir", opts.dir];
    if (opts.dryRun) autoArgs.push("--dry-run");
    if (opts.mode) autoArgs.push("--mode", opts.mode);
    autoArgs.push("--quiet");
    const r = spawnSync(process.execPath, [process.argv[1], ...autoArgs], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const autoOutput = (r.stdout ?? "") + (r.stderr ?? "");
    // Forward the auto-protect summary lines (filtering the banner).
    for (const line of autoOutput.split("\n")) {
      if (line.startsWith("◆ pinned")) continue;
      if (line.trim().length === 0) continue;
      out(`  ${line}`);
    }

    // Post-review pin count + delta.
    const regAfter = existsSync(opts.dir)
      ? readRegistry(opts.dir)
      : { version: 1 as const, claims: [] };
    const pinsAfter = countActivePins(regAfter);
    const delta = pinsAfter - pinsBefore;

    out("");
    if (delta > 0) {
      out(`✓ Added ${delta} pin${delta === 1 ? "" : "s"}. Total now: ${pinsAfter}.`);
      out(`  Statusline will show \`+${delta} pin${delta === 1 ? "" : "s"} · ${pinsAfter} total\` for the next 2 minutes.`);
    } else if (changes && changes.relevant > 0) {
      out(`✓ Scan complete. No new pins added — see suggestions above (if any).`);
    } else {
      out(`✓ Nothing to review.`);
    }

    // --deep: also run Safety Pass after the auto-protect cycle.
    if (opts.deep) {
      out("");
      out(`◆ Running deep checks (--deep)`);
      out("");
      out(`Safety Pass:`);
      const findings = runSafetyPass(cwd);
      const warns = findings.filter((f) => f.severity === "warn").length;
      const infos = findings.filter((f) => f.severity === "info").length;
      if (warns > 0) {
        out(`  ⚠ ${warns} warning${warns === 1 ? "" : "s"} — run \`pinned safety\` for details`);
      } else {
        out(`  ✓ no warnings (${infos} info-level finding${infos === 1 ? "" : "s"})`);
      }
    }

    out("");
    out(`Next:`);
    if (delta > 0) {
      out(`  pinned status        # see the updated state`);
      out(`  git commit           # ship the new pins`);
    } else {
      out(`  pinned protect       # convert any pending suggestions into pins`);
      out(`  pinned status        # see verification streak`);
    }
  });

// ---------- watch ----------
// Layer-2 background mode. Debounced fs watcher. After 3s of quiet,
// runs auto-protect against WORKING_TREE. Never calls vitest, never
// calls the Worker (cost discipline — see [[oidc-hosted-endpoint-mvp]]).
//
// Designed for solo AI-coder workflows where Claude/Cursor are
// continuously editing the repo. Long quiet windows trigger the scan;
// busy spurts get coalesced.
program
  .command("watch")
  .description(
    "Background watcher. Runs auto-protect after 3s of file-system quiet. Never calls vitest or the LLM."
  )
  .option(
    "--debounce <ms>",
    "Quiet window before triggering (default: 3000)",
    (v) => parseInt(v, 10),
    3000
  )
  .option(
    "--root <path>",
    "Repo root to watch (default: current working directory)"
  )
  .option(
    "--dir <path>",
    "Pinned tests directory (default: tests/pinned)",
    "tests/pinned"
  )
  .option("--quiet", "Suppress the pinned banner header.")
  .action(async (opts: { debounce: number; root?: string; dir: string }) => {
    printBanner();
    const root = opts.root ?? process.cwd();
    assertInsideDir(opts.dir, process.cwd());
    if (!existsSync(root)) {
      err(`✗ Watch root does not exist: ${root}\n`);
      process.exit(1);
    }
    out(`Watching ${root} (debounce ${opts.debounce}ms). Press Ctrl+C to stop.`);

    const { watch } = await import("node:fs");
    const { spawn } = await import("node:child_process");
    let timer: NodeJS.Timeout | null = null;
    let running = false;

    const trigger = () => {
      if (running) return; // overlap guard
      running = true;
      const child = spawn(
        process.execPath,
        [process.argv[1], "auto-protect", "--base", "WORKING_TREE", "--quiet"],
        { stdio: ["ignore", "pipe", "pipe"], cwd: root }
      );
      const chunks: Buffer[] = [];
      child.stdout?.on("data", (c: Buffer) => chunks.push(c));
      child.stderr?.on("data", (c: Buffer) => chunks.push(c));
      child.on("close", () => {
        running = false;
        const output = Buffer.concat(chunks).toString("utf8").trim();
        const ts = new Date().toLocaleTimeString();
        // Only print non-empty / non-trivial output.
        if (output && !/No changed files vs|No new behaviors/.test(output)) {
          process.stdout.write(`[${ts}] ${output}\n`);
        }
      });
    };

    const onChange = (_evt: string, filename: string | null) => {
      // Ignore changes inside tests/pinned/ (our own writes) and
      // .git/, node_modules/, dist/ — common noise sources.
      if (!filename) return;
      if (
        filename.startsWith("tests/pinned/") ||
        filename.startsWith(".git/") ||
        filename.startsWith("node_modules/") ||
        filename.startsWith("dist/") ||
        filename.startsWith(".pinnedai/") ||
        filename === ".last-status.json"
      ) {
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(trigger, opts.debounce);
    };

    try {
      watch(root, { recursive: true }, onChange);
    } catch (e) {
      err(
        `✗ Recursive fs.watch failed on this platform (${(e as Error).message}). Watch mode is supported on macOS, Windows, and Linux 4.x+.\n`
      );
      process.exit(1);
    }

    // Trigger once on startup so the cache reflects current state.
    trigger();

    // Keep process alive until SIGINT.
    process.on("SIGINT", () => {
      out("");
      out("Watch stopped.");
      process.exit(0);
    });
    await new Promise(() => {}); // never resolves
  });

// Interactive prompt for `pinned protect`. Returns the indices the
// user wants to pin, or "cancel".
async function promptProtectChoice(count: number): Promise<number[] | "cancel"> {
  process.stdout.write(
    `Protect these risks?\n  [Y] all (1-${count})    [1,3,5] choose by index    [N] cancel\n  > `
  );
  return new Promise((resolve) => {
    const onData = (chunk: Buffer | string) => {
      const raw = (typeof chunk === "string" ? chunk : chunk.toString("utf8")).trim();
      process.stdin.removeListener("data", onData);
      process.stdin.pause();
      const upper = raw.toUpperCase();
      if (upper === "" || upper.startsWith("Y")) {
        resolve(Array.from({ length: count }, (_, i) => i));
        return;
      }
      if (upper.startsWith("N")) {
        resolve("cancel");
        return;
      }
      // Parse comma-separated numbers, 1-indexed
      const indices = raw
        .split(/[,\s]+/)
        .map((s) => parseInt(s, 10))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= count)
        .map((n) => n - 1);
      resolve(indices.length > 0 ? indices : "cancel");
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

// ---------- safety ----------
// Pinned Safety Pass — deterministic static scan + optional tiny LLM
// summary via the hosted Worker. Default: pure deterministic, zero
// LLM cost.
program
  .command("safety")
  .description(
    "Run a deterministic Safety Pass (env-vars, NEXT_PUBLIC secret-shape, CORS wildcards, destructive SQL, lint escape hatches). Optional --summarize calls the hosted LLM for a 3-bullet summary."
  )
  .option(
    "--summarize",
    "Send the deterministic findings (compact JSON, NOT the diff) to the hosted LLM for a 3-bullet markdown summary. Counts against monthly LLM quota."
  )
  .option("--json", "Emit findings as JSON instead of human-readable text.")
  .option(
    "--dir <path>",
    "Pinned tests directory (default: tests/pinned)",
    "tests/pinned"
  )
  .option("--quiet", "Suppress the pinned banner header.")
  .action(
    async (opts: { summarize?: boolean; json?: boolean; dir: string }) => {
      printBanner();
      // Defense in depth: any user-supplied --dir must stay inside the
      // current working directory before any fs read/write. Even if
      // this command's primary action targets process.cwd(), the cache
      // writer downstream may consult opts.dir.
      assertInsideDir(opts.dir, process.cwd());
      const root = process.cwd();
      const findings = runSafetyPass(root);

      if (opts.json) {
        out(JSON.stringify(findings, null, 2));
      } else {
        out(renderSafetyHuman(findings));
      }

      if (opts.summarize && findings.length > 0) {
        // Gate on BYOK actually being active. The hosted Worker (which
        // llmSafetySummarize routes through) is undeployed; without
        // BYOK the call fails opaquely. Be honest about it.
        const { activeByokProvider } = await import("./llmDirect.js");
        const prov = activeByokProvider();
        if (!prov) {
          out("");
          err(
            "(--summarize needs a BYOK LLM. Set one of:\n" +
              "    PINNEDAI_BYOK=claude-code      (uses your local `claude` CLI subscription, $0)\n" +
              "    PINNEDAI_BYOK=github-models    (free tier — needs PINNEDAI_GITHUB_TOKEN or GITHUB_TOKEN)\n" +
              "    PINNEDAI_BYOK=anthropic        (needs PINNEDAI_ANTHROPIC_KEY)\n" +
              "    PINNEDAI_BYOK=openai           (needs PINNEDAI_OPENAI_KEY)\n" +
              "  Hosted summarization isn't deployed yet — see roadmap.)\n"
          );
        } else {
          out("");
          out(`(--summarize requested; calling LLM via BYOK provider: ${prov}…)`);
          const summary = await llmSafetySummarize(findings);
          if (summary.ok) {
            out("");
            out("Summary:");
            out(summary.markdown);
          } else {
            err(`(summarize unavailable: ${summary.reason})\n`);
          }
        }
      }

      // Update the cache so statusline + status command can read it.
      if (existsSync(opts.dir)) {
        const reg = readRegistry(opts.dir);
        const prior = readLastStatus(opts.dir);
        writeLastStatus(opts.dir, {
          ...(prior ?? {}),
          status: prior?.status ?? "green",
          failingCount: prior?.failingCount ?? 0,
          failingClaimIds: prior?.failingClaimIds ?? [],
          totalPins: countActivePins(reg),
          safetyNotes: findings.filter((f) => f.severity === "warn").length,
          updatedAt: prior?.updatedAt ?? new Date().toISOString(),
        });
      }
    }
  );

// ---------- status ----------
// Full breakdown: pins + risks + safety + suggested next.
program
  .command("status")
  .description(
    "Show the full Pinned status: pins (active/passing/failing) + unpinned risks + Safety Pass findings + suggested next actions."
  )
  .option(
    "--refresh",
    "Re-run risks + safety scans (slower; otherwise reads from cache)."
  )
  .option(
    "--dir <path>",
    "Pinned tests directory (default: tests/pinned)",
    "tests/pinned"
  )
  .option("--quiet", "Suppress the pinned banner header.")
  .action((opts: { refresh?: boolean; dir: string }) => {
    printBanner();
    // Defense in depth — any user-supplied --dir must stay inside cwd
    // before any fs read/write. Status reads the registry + cache.
    assertInsideDir(opts.dir, process.cwd());
    if (!existsSync(opts.dir)) {
      out(
        `No tests/pinned/ directory found. Run \`pinned init\` to get started.`
      );
      return;
    }
    const reg = readRegistry(opts.dir);
    const totalPins = countActivePins(reg);
    let cache = readLastStatus(opts.dir);

    if (opts.refresh) {
      const root = process.cwd();
      const allFiles = walkRepo(root);
      const changed: ChangedFile[] = allFiles.map((p) => ({
        path: p,
        status: "added",
      }));
      const scan = scanDiffFull({
        changedFiles: changed,
        prBodyClaims: [],
        existingPins: reg.claims,
      });
      const findings = runSafetyPass(root);
      const { sha, dirtyHash } = captureGitState(root);
      cache = {
        status: cache?.status ?? "green",
        failingCount: cache?.failingCount ?? 0,
        failingClaimIds: cache?.failingClaimIds ?? [],
        totalPins,
        unpinnedRisks: scan.suggestions.length,
        safetyNotes: findings.filter((f) => f.severity === "warn").length,
        // Preserve auto-protect surfaces across refresh.
        recentlyAddedCount: cache?.recentlyAddedCount,
        recentlyAddedAt: cache?.recentlyAddedAt,
        suggestedCount: cache?.suggestedCount,
        breaksCaught: cache?.breaksCaught,
        lastCatchAt: cache?.lastCatchAt,
        lastCatchClaimId: cache?.lastCatchClaimId,
        lastCheckedSha: sha ?? cache?.lastCheckedSha,
        lastCheckedDirtyHash: dirtyHash ?? cache?.lastCheckedDirtyHash,
        updatedAt: cache?.updatedAt ?? new Date().toISOString(),
      };
      writeLastStatus(opts.dir, cache);
    }

    // Pin-growth stats — compounding-value signal. Counts active pins
    // pinned in the last 7 / 30 days. Surfaces only if there's growth.
    const now = Date.now();
    const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
    const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
    let addedThisWeek = 0;
    let addedThisMonth = 0;
    for (const e of reg.claims) {
      if (e.status !== "active") continue;
      const t = new Date(e.pinnedAt).getTime();
      if (!Number.isFinite(t)) continue;
      const age = now - t;
      if (age <= WEEK_MS) addedThisWeek += 1;
      if (age <= MONTH_MS) addedThisMonth += 1;
    }

    out("");
    out(`◆ Pinned status`);
    out(``);
    out(`Protected behaviors:`);
    if (cache?.status === "failing") {
      out(`  ✗ ${cache.failingCount} of ${totalPins} failing`);
      // Show the human title of each failing pin (not the cryptic id).
      const regById = new Map(reg.claims.map((c) => [c.claimId, c]));
      for (const id of cache.failingClaimIds.slice(0, 5)) {
        const e = regById.get(id);
        if (e) {
          out(`     · ${describeClaimForUser(e.claim).title}`);
          out(`         (tests/pinned/${e.filename})`);
        } else {
          out(`     · tests/pinned/${id}.test.ts`);
        }
      }
    } else if (cache) {
      // Critical: "all passing" is a LIE if every pin actually skipped.
      // A pin that skips (no PREVIEW_URL / no fixture token) provides
      // zero protection — surfacing it as "passing" is the most
      // dangerous UI line in Pinned (caught by socialideagen dogfood
      // 2026-06-02 as a HIGH-severity TRUST bug).
      const skipped = cache.skippedCount ?? 0;
      const verifiedCount = totalPins - skipped;
      if (skipped > 0 && verifiedCount === 0) {
        out(`  ⚠ ${totalPins} active — NOT VERIFYING (all ${skipped} skipped). Pinned is providing ZERO protection right now.`);
        out(`    Set PREVIEW_URL to verify live pins. See https://pinnedai.dev/docs/preview-url.`);
      } else if (skipped > 0) {
        out(`  ⚠ ${totalPins} active — ${verifiedCount} verified, ${skipped} skipped (no PREVIEW_URL / fixture tokens — those aren't verifying).`);
      } else if (totalPins === 0) {
        out(`  ${totalPins} active.`);
      } else {
        out(`  ✓ ${totalPins} active, all verified.`);
      }
    } else {
      out(`  ? ${totalPins} active, not tested yet — run \`pinned test\``);
    }
    if (addedThisWeek > 0 || addedThisMonth > 0) {
      out(`  +${addedThisWeek} this week · +${addedThisMonth} this month`);
    }
    // Verification streak — the primary positive metric. Silence
    // should feel like uptime, not absence. Surface this even when
    // catches are 0 (which they usually will be — by design).
    const streak = cache?.verifiedStreak ?? 0;
    const checksRun = cache?.checksRun ?? 0;
    if (checksRun > 0 || streak > 0) {
      out("");
      out(`Verification:`);
      const skippedNow = cache?.skippedCount ?? 0;
      const verifiedNow = totalPins - skippedNow;
      if (cache?.status === "failing") {
        out(`  Streak broken on the current check. Fix above, then verify again.`);
      } else if (skippedNow > 0 && verifiedNow === 0) {
        // Don't report a "successful streak" when every pin is skipped
        // — that's the false-confidence trap. The streak is technically
        // unbroken but contains zero verifications.
        out(`  ⚠ ${checksRun} run${checksRun === 1 ? "" : "s"} recorded, but ALL pins skipped each time.`);
        out(`    There is no actual verification streak. Set PREVIEW_URL to start verifying.`);
      } else if (streak > 0) {
        const lastVerifiedAt = cache?.lastVerifiedAt;
        const ageLabel = lastVerifiedAt
          ? (() => {
              const mins = Math.floor((now - new Date(lastVerifiedAt).getTime()) / 60_000);
              if (mins < 1) return "just now";
              if (mins < 60) return `${mins}m ago`;
              if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
              return `${Math.floor(mins / 1440)}d ago`;
            })()
          : "unknown";
        const skipNote = skippedNow > 0 ? ` (${skippedNow} skipped — not verified)` : "";
        out(`  ✓ ${streak} consecutive successful run${streak === 1 ? "" : "s"} · ${checksRun} total · last: ${ageLabel}${skipNote}`);
      } else {
        out(`  ${checksRun} total run${checksRun === 1 ? "" : "s"} — no current streak.`);
      }
    }
    // Lifetime "breaks caught" — surface only when nonzero AND in a
    // separate, calm section. NOT the headline metric — catches are
    // rare by design (we catch deletion-class bugs, not subtle ones).
    const caught = cache?.breaksCaught ?? 0;
    if (caught > 0) {
      out("");
      out(`Recent catches:`);
      out(`  ${caught} regression${caught === 1 ? "" : "s"} caught lifetime. Run \`pinned catches\` for history.`);
    }
    // Trim convention: show "Unpinned risks" / "Safety Pass" sections
    // only when there's something to act on OR when the user hasn't
    // scanned yet (so they know `pinned risks` / `pinned safety` exist).
    // Hide the green-default "✓ none" / "✓ no warnings" rows — they
    // bloat the output without telling the user anything actionable.
    const risks = cache?.unpinnedRisks ?? 0;
    const notes = cache?.safetyNotes ?? 0;
    const risksUnscanned = typeof cache?.unpinnedRisks !== "number";
    const safetyUnscanned = typeof cache?.safetyNotes !== "number";
    if (risks > 0 || risksUnscanned) {
      out("");
      out(`Unpinned risks:`);
      if (risks > 0) {
        out(`  ⚠ ${risks} detected — run \`pinned protect\` to add tests`);
      } else {
        out(`  ? not scanned yet — run \`pinned risks\``);
      }
    }
    if (notes > 0 || safetyUnscanned) {
      out("");
      out(`Safety Pass:`);
      if (notes > 0) {
        out(
          `  ⚠ ${notes} warning${notes === 1 ? "" : "s"} — run \`pinned safety\` for details`
        );
      } else {
        out(`  ? not scanned yet — run \`pinned safety\``);
      }
    }

    out("");
    out(`Suggested next:`);
    if (cache?.status === "failing") {
      out(`  pinned fix-prompt   # paste-ready repair prompt for Claude/Cursor`);
    } else if (risks > 0) {
      out(`  pinned protect      # interactive add-pin flow`);
    } else if (notes > 0) {
      out(`  pinned safety       # see Safety Pass details`);
    } else if (cache) {
      out(`  ✓ nothing to do.`);
    } else {
      out(`  pinned test         # run pinned tests + cache status`);
    }
  });

// ---------- fix-prompt ----------
program
  .command("fix-prompt")
  .description(
    "Emit a paste-ready repair prompt for Claude/Cursor. Targets failing pins by default; --risk N / --safety N for unpinned risks or Safety Pass findings."
  )
  .option(
    "--dir <path>",
    "Pinned tests directory (default: tests/pinned)",
    "tests/pinned"
  )
  .option(
    "--risk <index>",
    "Generate a prompt for the Nth unpinned risk (1-indexed).",
    (v) => parseInt(v, 10)
  )
  .option(
    "--safety <index>",
    "Generate a prompt for the Nth Safety Pass finding (1-indexed).",
    (v) => parseInt(v, 10)
  )
  .option("--quiet", "Suppress the pinned banner header.")
  .action((opts: { dir: string; risk?: number; safety?: number }) => {
    printBanner();
    // Defense in depth — fix-prompt reads the registry/cache via the
    // helpers below, and the risk path walks the repo from opts.dir.
    assertInsideDir(opts.dir, process.cwd());
    if (opts.risk !== undefined) {
      emitRiskFixPrompt(opts.dir, opts.risk);
      return;
    }
    if (opts.safety !== undefined) {
      emitSafetyFixPrompt(opts.dir, opts.safety);
      return;
    }
    const cache = readLastStatus(opts.dir);
    if (!cache || cache.status !== "failing") {
      out(
        "✓ No failing pins. Run `pinned safety` or `pinned risks` first, then `pinned fix-prompt --safety N` or `--risk N`."
      );
      return;
    }
    out("");
    out("═══ Paste this into Claude Code / Cursor ═══");
    out("");
    out(
      `Pinned has ${cache.failingCount} failing protected behavior${cache.failingCount === 1 ? "" : "s"}.`
    );
    out("");
    out(`Failing test${cache.failingCount === 1 ? "" : "s"}:`);
    for (const id of cache.failingClaimIds) {
      out(`  - tests/pinned/${id}.test.ts`);
    }
    out("");
    out("Task: read each failing pinned test file. Each contains the original");
    out("PR claim, the expected behavior, and the actual failure. Fix the");
    out("application code so the claim holds again.");
    out("");
    out("Do NOT modify any file in tests/pinned/. Do NOT add @ts-ignore or");
    out("eslint-disable. If the claim is genuinely no longer applicable, ask");
    out("the user before running `pinned retire`.");
    out("");
    out("After fixing, re-run: npx pinnedai test");
    out("");
    out("═══════════════════════════════════════════");
  });

function emitRiskFixPrompt(dir: string, index: number): void {
  const root = process.cwd();
  const allFiles = walkRepo(root);
  const changed: ChangedFile[] = allFiles.map((p) => ({
    path: p,
    status: "added",
  }));
  const existingPins = existsSync(dir) ? readRegistry(dir).claims : [];
  const scan = scanDiffFull({
    changedFiles: changed,
    prBodyClaims: [],
    existingPins,
  });
  if (index < 1 || index > scan.suggestions.length) {
    err(
      `✗ No risk #${index}. There are ${scan.suggestions.length} unpinned risks. Run \`pinned risks\` to see the list.\n`
    );
    process.exit(1);
  }
  const risk = scan.suggestions[index - 1];
  out("");
  out("═══ Paste this into Claude Code / Cursor ═══");
  out("");
  out(`Pinned detected an unpinned risk in this repo:`);
  out("");
  out(`  ${risk.reason}`);
  out("");
  out(`Affected file${risk.files.length === 1 ? "" : "s"}:`);
  for (const f of risk.files.slice(0, 5)) out(`  - ${f}`);
  out("");
  out(
    `Task: confirm whether this route/handler is intentionally unprotected.`
  );
  out(
    `If it should require auth / rate-limiting / idempotency, implement the`
  );
  out(`protection in the application code. Do not just add a test.`);
  out("");
  out(`After implementing, add the claim to your PR description:`);
  out(`  ${risk.suggestedPin}`);
  out("");
  out(`Or pin it directly: pnpm pinned protect`);
  out("");
  out("═══════════════════════════════════════════");
}

function emitSafetyFixPrompt(_dir: string, index: number): void {
  const root = process.cwd();
  const findings = runSafetyPass(root);
  const warns = findings.filter((f) => f.severity === "warn");
  if (index < 1 || index > warns.length) {
    err(
      `✗ No safety warning #${index}. There are ${warns.length} warnings. Run \`pinned safety\` to see the list.\n`
    );
    process.exit(1);
  }
  const f = warns[index - 1];
  out("");
  out("═══ Paste this into Claude Code / Cursor ═══");
  out("");
  out(`Pinned Safety Pass found an issue:`);
  out("");
  out(`  ${f.message}`);
  out(`  Location: ${f.file}${f.line ? `:${f.line}` : ""}`);
  if (f.snippet) out(`  Line:     ${f.snippet}`);
  out("");
  out(`Task: ${f.suggested}`);
  out("");
  out(`Make the smallest possible fix. Do not rewrite unrelated code.`);
  out("");
  out("═══════════════════════════════════════════");
}

// ---------- statusline ----------
// Quiet always-on visibility for the Claude Code bottom bar. Reads
// the cached status file (written by `pinned test`) so it's fast
// enough to fire every 10s without re-running vitest.
program
  .command("statusline")
  .description(
    "Emit a one-line status indicator for the Claude Code statusline. Configure via `.claude/settings.json` → statusLine.command = 'pinned statusline'."
  )
  .option(
    "--dir <path>",
    "Pinned tests directory (default: tests/pinned)",
    "tests/pinned"
  )
  .action((opts: { dir: string }) => {
    // Statusline must NEVER print the banner — that would corrupt the
    // bottom-bar output. Suppress unconditionally.
    // Defense in depth — even though the statusline only READS the
    // cache, treat the --dir argument like every other CLI command:
    // it must stay inside cwd. Otherwise a misconfigured statusline
    // command in .claude/settings.json could read state from arbitrary
    // dirs on disk.
    assertInsideDir(opts.dir, process.cwd());
    if (!existsSync(opts.dir)) {
      process.stdout.write(`◆ pinned · not initialized (run \`pinned init\`)\n`);
      return;
    }
    const reg = readRegistry(opts.dir);
    const total = countActivePins(reg);
    const lastStatus = readLastStatus(opts.dir);
    // Auto-protect mode controls whether `+N suggested` surfaces. We
    // resolve from the env override + config so `PINNEDAI_AUTO_PROTECT=off`
    // works as a one-shot suppressor.
    const mode = effectiveModeImport(process.cwd());
    const cfg = readConfigImport(process.cwd());
    const line = formatStatusline({
      totalPins: total,
      lastStatus,
      mode,
      showPendingChanges: cfg.show_pending_changes,
      showReviewCount: cfg.show_review_count,
      statuslineMode: cfg.statusline_mode,
      // Pass active pins so the "REVIEW · N touched" state can fire
      // when the working tree intersects a guarded route or file.
      activePins: reg.claims.filter((p) => p.status === "active"),
    });
    // In minimal mode, line may be empty — emit nothing so the
    // VS Code extension / Claude Code statusline hides the item
    // (rather than rendering an empty newline).
    if (line) process.stdout.write(line + "\n");
  });

// ---------- hook-failure ----------
// Chat-injection content for Claude Code's UserPromptSubmit /
// SessionStart hooks. Emits a warning ONLY when a pin is failing;
// emits the empty string when green. Empty stdout = no context
// pollution.
program
  .command("hook-failure")
  .description(
    "Emit a Claude Code chat-injection: failure warning when a pinned test is broken; one-shot celebration after fresh pins; empty otherwise. Wire into `.claude/settings.json` under hooks.UserPromptSubmit or SessionStart."
  )
  .option(
    "--dir <path>",
    "Pinned tests directory (default: tests/pinned)",
    "tests/pinned"
  )
  .action(async (opts: { dir: string }) => {
    // Defense in depth — hook-failure writes cache stamps and spawns
    // a background process. A misconfigured .claude/settings.json
    // hook with --dir=../../somewhere could mutate state outside cwd.
    assertInsideDir(opts.dir, process.cwd());
    if (!existsSync(opts.dir)) {
      // Repo isn't pinned-initialized — emit nothing (don't pollute chat
      // for repos that don't use pinned).
      return;
    }
    const lastStatus = readLastStatus(opts.dir);
    const { formatChatHook, CHAT_HOOK_AUTO_PROTECT_TTL_MS } = await import(
      "./statusline.js"
    );
    const result = formatChatHook(lastStatus);
    if (result.text) process.stdout.write(result.text + "\n");

    // Background auto-protect kick — cheap-check + throttled.
    //
    // The chat hook fires on EVERY user message in Claude Code. We
    // want pin growth to happen automatically, but we also can't run
    // full auto-protect on every chat turn — that would waste CPU/disk
    // on turns where the user is just talking ("what do you think of
    // this color?") and not editing code.
    //
    // So every turn does only CHEAP checks:
    //   1. read cache (already done above)
    //   2. capture current git state (`git rev-parse HEAD` + diff hash)
    //   3. compare against cached lastCheckedSha / lastCheckedDirtyHash
    //   4. check throttle (≥ CHAT_HOOK_AUTO_PROTECT_TTL_MS since last kick)
    //   5. respect auto_protect mode ("off" → never kick)
    //
    // The full auto-protect run (scan diff, classify, write pins) only
    // happens when ALL of those gates pass. That means a chatty turn
    // with no code changes costs ~5ms and zero file writes.
    //
    // Run model:
    //   - detached child process (parent returns immediately)
    //   - non-blocking (no await, stdio ignored)
    //   - zero LLM cost (auto-protect is Layer-1+2 only)
    let lastAddNotifiedAt = result.stampAddNotifiedAt;
    let lastAutoProtectAt = lastStatus?.lastAutoProtectAt;

    const repoRoot = process.cwd();
    const mode = effectiveModeImport(repoRoot);

    // Gate 1 — throttle. ≥ CHAT_HOOK_AUTO_PROTECT_TTL_MS since last kick.
    const sinceLastKick = lastAutoProtectAt
      ? Date.now() - new Date(lastAutoProtectAt).getTime()
      : Infinity;
    const throttlePassed = sinceLastKick >= CHAT_HOOK_AUTO_PROTECT_TTL_MS;

    // Gate 2 — git drift. Working tree differs from last-checked state.
    // Drift on SHA or dirtyHash ONLY when both the cached value and
    // the current value are present and differ. If neither side has a
    // cached reference yet (first-time fire), treat as drifted so the
    // initial scan runs. Layer-1 cheap — two git commands.
    const current = captureGitState(repoRoot);
    const hasCacheRef =
      !!lastStatus?.lastCheckedSha || !!lastStatus?.lastCheckedDirtyHash;
    const shaDrifted =
      !!current.sha &&
      !!lastStatus?.lastCheckedSha &&
      current.sha !== lastStatus.lastCheckedSha;
    const dirtyDrifted =
      !!current.dirtyHash &&
      !!lastStatus?.lastCheckedDirtyHash &&
      current.dirtyHash !== lastStatus.lastCheckedDirtyHash;
    const sawDrift = !hasCacheRef || shaDrifted || dirtyDrifted;

    // Gate 3 — mode. "off" never kicks.
    const modeAllows = mode !== "off";

    // Gate 4 — relevance threshold. Don't fire auto-protect for every
    // tiny edit; wait until enough Pinned-relevant changes accumulate
    // OR a single high-risk path was touched (admin route, webhook,
    // middleware, env file). This keeps Pinned from feeling twitchy
    // during normal AI-coding.
    const cfg = readConfigImport(repoRoot);
    const { countRelevantChanges } = await import("./statusline.js");
    const changes = countRelevantChanges(repoRoot);
    const reviewThreshold = cfg.auto_review_threshold;
    const enoughRelevant =
      !!changes && changes.relevant >= reviewThreshold;
    const highRiskTouched = !!changes && changes.hasHighRisk;
    const relevanceAllows = !changes || enoughRelevant || highRiskTouched;

    const shouldKick =
      modeAllows && throttlePassed && sawDrift && relevanceAllows;

    if (shouldKick) {
      try {
        const { spawn } = await import("node:child_process");
        const child = spawn(
          process.execPath,
          [process.argv[1], "auto-protect", "--quiet"],
          {
            cwd: repoRoot,
            detached: true,
            stdio: "ignore",
          }
        );
        child.unref();
        lastAutoProtectAt = new Date().toISOString();
      } catch {
        // Best-effort — if spawn fails, the chat hook still works.
      }
    }

    // Stamp lastAddNotifiedAt + lastAutoProtectAt back to the cache.
    if (lastStatus && (lastAddNotifiedAt || shouldKick)) {
      writeLastStatus(opts.dir, {
        ...lastStatus,
        lastAddNotifiedAt: lastAddNotifiedAt ?? lastStatus.lastAddNotifiedAt,
        lastAutoProtectAt,
      });
    }
  });

// ---------- test ----------
// Runs vitest on tests/pinned/ and writes .last-status.json so the
// statusline + hook know if anything is failing.
program
  .command("test")
  .description(
    "Run all pinned tests in tests/pinned/ and update the cached status (powers statusline + failure hook)."
  )
  .option(
    "--dir <path>",
    "Pinned tests directory (default: tests/pinned)",
    "tests/pinned"
  )
  .option("--quiet", "Suppress the pinned banner header.")
  .action(async (opts: { dir: string }) => {
    printBanner();
    assertInsideDir(opts.dir, process.cwd());
    if (!existsSync(opts.dir)) {
      err(`✗ ${opts.dir}/ does not exist. Run \`pinned init\` first.\n`);
      process.exit(1);
    }

    // Local-dev-server mode (config.http.mode === "local"):
    // Spawn the user's dev server before invoking vitest, then tear
    // it down on completion. Detects already-running servers and
    // attaches instead of duplicating. Only triggered from explicit
    // `pinned test` — never from statusline / hooks / chat hooks.
    //
    // If PREVIEW_URL is already set by the environment (e.g. CI sets
    // it from the Vercel preview), we use that and skip dev-server
    // startup entirely.
    const httpCfg = readConfigImport(process.cwd()).http;
    let devHandle: import("./devServer.js").DevServerHandle | null = null;
    const childEnv: Record<string, string | undefined> = { ...process.env };
    if (!process.env.PREVIEW_URL && httpCfg.mode === "local") {
      try {
        const { startIfNeeded } = await import("./devServer.js");
        devHandle = await startIfNeeded({
          start: httpCfg.start,
          url: httpCfg.url,
          readyPath: httpCfg.ready_path,
          timeoutSeconds: httpCfg.timeout_seconds,
          cwd: process.cwd(),
        });
        childEnv.PREVIEW_URL = devHandle.url;
      } catch (e) {
        err(`✗ pinned: local dev server failed to start.\n  ${(e as Error).message}\n`);
        // Continue without PREVIEW_URL — HTTP pins will skip with the
        // existing "not verified" message. Better than blocking the
        // whole `pinned test` run on a flaky dev server.
      }
    }

    const { spawnSync } = await import("node:child_process");
    // Exclude `tests/pinned/retired/` from the run. Retired pins have
    // audit entries and intentionally fail (the original assertion is
    // preserved so git history is meaningful) — running them would make
    // `pinned retire` a guaranteed CI break, which contradicts the
    // documented retire workflow. Customers can override with a custom
    // vitest config; the default invocation must not punish retirement.
    const result = spawnSync(
      "npx",
      [
        "--no-install",
        "vitest",
        "run",
        opts.dir,
        "--exclude",
        "**/retired/**",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        env: childEnv as NodeJS.ProcessEnv,
      }
    );
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    // Tear down ONLY the dev server we started (devHandle.started=true).
    if (devHandle && devHandle.started) {
      try {
        await devHandle.stop();
      } catch {
        /* best effort */
      }
    }

    // Parse "FAIL  tests/pinned/<id>.test.ts" lines from vitest output.
    const combined = (result.stdout ?? "") + (result.stderr ?? "");
    const failPattern = /FAIL\s+([^\s]+\.test\.ts)/g;
    const failingFiles = new Set<string>();
    let m;
    while ((m = failPattern.exec(combined)) !== null) {
      failingFiles.add(m[1]);
    }

    // Distinguish CATCH failures (real contract regression) from INFRA
    // failures (preview down, DNS error, transient 5xx after retries).
    // Generated templates emit "PINNED INFRA FAILURE" for the latter;
    // the catch ledger should NOT increment for infra issues. Without
    // this, a customer with a flaky preview deploy would see fake
    // 🛟 caught celebrations every CI run.
    //
    // Per-failing-file: if its output block contains "PINNED INFRA
    // FAILURE" but NOT "PINNED FAILURE", classify as infra.
    // Customers can override with PINNED_TREAT_INFRA_AS_CATCH=1.
    const treatInfraAsCatch =
      process.env.PINNED_TREAT_INFRA_AS_CATCH === "1";
    const infraFailingFiles = new Set<string>();
    const realFailingFiles = new Set<string>();
    for (const file of failingFiles) {
      // Find the section of output bound to this file. Vitest prints
      // a stanza like:
      //   FAIL  tests/pinned/xxx.test.ts > pinned: ...
      //   ... AssertionError: ...
      //   ... error message text ...
      // We scan forward from the FAIL line up to the next FAIL or
      // 200 lines (whichever comes first) for the discriminating
      // header strings.
      const escapedFile = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const failRe = new RegExp(`FAIL\\s+${escapedFile}([\\s\\S]*?)(?=FAIL\\s|$)`);
      const sectionMatch = failRe.exec(combined);
      const section = sectionMatch ? sectionMatch[1] : "";
      const isInfra =
        section.includes("PINNED INFRA FAILURE") &&
        !section.includes("PINNED FAILURE");
      if (isInfra && !treatInfraAsCatch) {
        infraFailingFiles.add(file);
      } else {
        realFailingFiles.add(file);
      }
    }
    const failingClaimIds = [...realFailingFiles].map((f) =>
      f.replace(/^.*\//, "").replace(/\.test\.ts$/, "")
    );
    if (infraFailingFiles.size > 0) {
      out("");
      out(
        `⊘ ${infraFailingFiles.size} pin(s) had infrastructure failures (preview down, network blip, etc.) — NOT counted as catches. Set PINNED_TREAT_INFRA_AS_CATCH=1 to override.`
      );
    }

    // Parse the skipped count from vitest's summary line. Format:
    //   "Tests  N passed | M skipped (T)"
    // Skipped tests are pins that couldn't actually verify (no
    // PREVIEW_URL, etc.) — surfaced loudly in the statusline so
    // users know which pins are silent vs verified.
    let skippedCount = 0;
    const skipPattern = /(\d+)\s+skipped/;
    const skipMatch = skipPattern.exec(combined);
    if (skipMatch) {
      skippedCount = parseInt(skipMatch[1], 10);
    }

    // Distinguish "vitest actually ran" from "setup failure (vitest
    // missing, npx couldn't resolve, etc.)". Vitest's normal output
    // includes "Test Files" / "passed" / explicit FAIL/PASS markers.
    // If exit code != 0 AND none of those markers appear, the runner
    // never actually executed tests — treat as a setup issue and
    // leave the cache alone (don't reset the streak, don't count
    // this as a real test run).
    const ranTests =
      /Test Files\s+\d/.test(combined) ||
      /\d+ (?:passed|failed|skipped)/.test(combined) ||
      failingClaimIds.length > 0;
    if (!ranTests && result.status !== 0) {
      out("");
      out(`✗ Vitest could not be invoked. Pinned tests were not executed.`);
      out(`  Common causes: vitest not installed (run \`pinned doctor\` to check),`);
      out(`  or the test runner isn't on the PATH for this repo.`);
      out(`  Cache left untouched; streak preserved.`);
      process.exit(result.status ?? 1);
    }

    const reg = readRegistry(opts.dir);
    const totalPins = countActivePins(reg);

    // --- Catch detection: which claims transitioned green → failing?
    // We compare the new failing-claim set against the PREVIOUS green
    // status. Any new failure that was passing last time = a regression
    // we just caught. Increment the lifetime counter + stamp the
    // transient state so the statusline can show "caught N break".
    //
    // Carry forward breaksCaught + recentlyAdded/suggested counters so
    // the cache doesn't lose long-lived state on each test run.
    const prev = readLastStatus(opts.dir);
    const prevFailing = new Set(prev?.failingClaimIds ?? []);
    const newFailures = failingClaimIds.filter((id) => !prevFailing.has(id));
    let breaksCaught = prev?.breaksCaught ?? 0;
    let lastCatchAt = prev?.lastCatchAt;
    let lastCatchClaimId = prev?.lastCatchClaimId;
    let catchHistory = prev?.catchHistory ?? [];
    if (newFailures.length > 0 && prev && prev.status === "green") {
      // Real catch: was green, now failing on a claim that wasn't
      // failing before. Don't count test-runner errors (exit non-zero
      // with zero parsed FAIL lines) — those aren't regressions.
      breaksCaught += newFailures.length;
      lastCatchAt = new Date().toISOString();
      lastCatchClaimId = newFailures[0];
      // Append catch records — newest first. Cap at CATCH_HISTORY_LIMIT
      // to keep the cache file small. Each record carries enough to
      // re-tell the story without re-reading the registry.
      const regByCl = new Map(reg.claims.map((e) => [e.claimId, e]));
      const newRecords = newFailures.map((id) => {
        const e = regByCl.get(id);
        return {
          caughtAt: lastCatchAt as string,
          claimId: id,
          claimText: e?.claim.raw,
          template: e?.claim.template,
          route:
            e?.claim &&
            "route" in e.claim &&
            typeof (e.claim as { route?: unknown }).route === "string"
              ? ((e.claim as { route: string }).route)
              : undefined,
          // Carry the bad_case + bugFixOrigin + originPr into the
          // catch record so CATCHES.md and the chat-hook celebration
          // can speak in human terms about what was protected.
          badCase: e?.badCase,
          originPr: e?.prId,
          bugFixOrigin: e?.bugFixOrigin,
        };
      });
      catchHistory = [...newRecords, ...catchHistory].slice(0, CATCH_HISTORY_LIMIT);

      // Render CATCHES.md — the customer-visible "Pinned has saved
      // me N times" ledger. Grows over time, becomes evidence rather
      // than marketing. Written transactionally alongside the
      // .last-status.json cache update so the two stay consistent.
      const catchesPath = join(opts.dir, "CATCHES.md");
      const catchesMd = renderCatchesMarkdown({
        catchHistory,
        breaksCaught,
      });
      writeFileSync(catchesPath, catchesMd);
    }

    const caughtNow = newFailures.length > 0 && prev?.status === "green";
    const { sha, dirtyHash } = captureGitState(process.cwd());

    // Verification metrics — the primary positive signal of pinned's
    // value. Catches are rare (deletion-class bugs only); silence
    // should still feel like uptime, not absence.
    const isGreen = result.status === 0;
    const checksRun = (prev?.checksRun ?? 0) + 1;
    const verifiedStreak = isGreen ? (prev?.verifiedStreak ?? 0) + 1 : 0;
    const lastVerifiedAt = isGreen ? new Date().toISOString() : prev?.lastVerifiedAt;

    writeLastStatus(opts.dir, {
      // Preserve every existing field by default; this command owns
      // status/failing*/breaks-caught/streak — everything else
      // (autoProtect throttle stamps, suggestion counts, safety notes)
      // is carried forward untouched.
      ...(prev ?? {}),
      status: isGreen ? "green" : "failing",
      failingCount: failingClaimIds.length,
      failingClaimIds,
      totalPins,
      breaksCaught,
      lastCatchAt,
      lastCatchClaimId,
      catchHistory,
      checksRun,
      verifiedStreak,
      lastVerifiedAt,
      skippedCount,
      lastCheckedSha: sha ?? undefined,
      lastCheckedDirtyHash: dirtyHash ?? undefined,
      updatedAt: new Date().toISOString(),
    });
    out("");
    out(
      `~ ${relative(process.cwd(), join(opts.dir, ".last-status.json"))} (status cache updated)`
    );

    // Emit COVERED event when the suite passed — surfaces in the
    // statusline as "N guards passed" for ~60s.
    if (isGreen && totalPins > 0) {
      try {
        const { recordCoveredRun } = await import("./statusline.js");
        recordCoveredRun(opts.dir, { passedCount: totalPins - skippedCount });
      } catch { /* */ }
    }

    if (caughtNow) {
      out(
        `🛟 Pinned caught ${newFailures.length} regression${newFailures.length === 1 ? "" : "s"} — ${newFailures.slice(0, 3).join(", ")}`
      );
    }
    process.exit(result.status ?? 1);
  });

// ---------- check-guard-removal (internal — called by hooks) ----------
//
// Inspects the staged diff for attempts to remove or weaken pinned
// tests. Returns:
//   exit 0 — nothing concerning in staged diff
//   exit 2 — at least one pinned test was deleted/modified/weakened
//            without going through the retire flow
//
// Bypass: PINNEDAI_ALLOW_PIN_EDIT=1 (single commit override; no audit).
//
// What counts as "legitimate" (does NOT block):
//   - A new pin file added under tests/pinned/ (additions are always OK)
//   - A pin file moved from tests/pinned/<id>.test.ts to
//     tests/pinned/retired/<id>.test.ts in the SAME commit — this is
//     what `pinned retire` produces and must be allowed
//
// What blocks:
//   - Pin file deleted with no matching retired/ destination
//   - Pin file modified at all (any content change is suspicious —
//     the user should retire and regenerate, not edit in place)
//   - Pin file content weakened — .skip / xit / xdescribe / no-op
//     expects. Surfaces with a specific message instead of the
//     generic "modification" one.
program
  .command("check-guard-removal", { hidden: true })
  .description("(internal) Block commits/PRs that delete/modify/weaken pinned tests.")
  .option("--dir <path>", "Pinned tests directory.", "tests/pinned")
  // --base flips the diff scope from "staged index" (pre-commit hook
  // context) to "<base>...HEAD" (CI context, after actions/checkout).
  // In CI the index is empty so the staged diff is always zero —
  // without --base, the workflow would silently exit 0 and never catch
  // a `git commit --no-verify` bypass. The generated workflow at
  // `pinned init` passes --base "origin/<pr.base.ref>".
  .option(
    "--base <ref>",
    "Diff against <ref>...HEAD (CI mode). Default is staged index (hook mode)."
  )
  .option("--quiet", "Suppress non-error output.")
  .action(async (opts: { dir: string; base?: string; quiet?: boolean }) => {
    if (process.env.PINNEDAI_ALLOW_PIN_EDIT === "1") {
      if (!opts.quiet) out("pinned: PINNEDAI_ALLOW_PIN_EDIT=1 set — guard-removal check bypassed for this commit.");
      process.exit(0);
    }
    // Regenerate-allow marker — written by `pinned regenerate`. When
    // every modified pin file in the staged diff has a matching entry
    // (filename + sha256 of current content) in the marker AND the
    // marker hasn't expired, allow the commit. This lets users follow
    // the success-message instructions from `pinned regenerate` without
    // needing PINNEDAI_ALLOW_PIN_EDIT=1.
    const regenAllow = readRegenerateAllowMarker();
    const cwd = process.cwd();
    // Compute diff scope. CI passes --base; the pre-commit hook does
    // not. We still emit clean exit 0 when not in a git repo so the
    // hook entry point never blocks unrelated commits.
    let diffRaw: string;
    try {
      const gitArgs = opts.base
        ? ["diff", `${opts.base}...HEAD`, "--name-status", "--", `${opts.dir}/`]
        : ["diff", "--cached", "--name-status", "--", `${opts.dir}/`];
      diffRaw = execFileSync("git", gitArgs, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      process.exit(0);
    }
    // Parse: tab-separated "STATUS\tPATH" (or "STATUS\tOLD\tNEW" for renames)
    type DiffEntry = { status: string; path: string; oldPath?: string };
    const entries: DiffEntry[] = [];
    for (const line of diffRaw.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      const status = parts[0];
      if (status?.startsWith("R")) {
        entries.push({ status: "R", oldPath: parts[1], path: parts[2] });
      } else if (status === "A" || status === "M" || status === "D") {
        entries.push({ status, path: parts[1] });
      }
    }
    // Pin file = direct child of tests/pinned/ ending in .test.ts.
    // Nested files under tests/pinned/retired/* are NOT pin files.
    const isPinFile = (p: string): boolean => {
      const prefix = opts.dir.replace(/\/+$/, "") + "/";
      if (!p.startsWith(prefix)) return false;
      const rest = p.slice(prefix.length);
      if (rest.includes("/")) return false; // nested (e.g., retired/)
      return rest.endsWith(".test.ts");
    };
    const isRetiredDest = (p: string): boolean => {
      const prefix = opts.dir.replace(/\/+$/, "") + "/retired/";
      return p.startsWith(prefix) && p.endsWith(".test.ts");
    };
    // Build sets of retired-destination basenames AND matching audit
    // file basenames added in this commit. The retire-flow exception
    // ONLY applies when BOTH landed together — moving a pin to
    // retired/ without the audit file is an AI bypass tactic (was
    // allowed pre-2026-05-23 per mutation-test scoreboard finding).
    const addedRetiredBasenames = new Set<string>();
    const addedAuditBasenames = new Set<string>();
    const dirPrefix = opts.dir.replace(/\/+$/, "");
    for (const e of entries) {
      if ((e.status === "A" || e.status === "R") && isRetiredDest(e.path)) {
        const base = e.path.slice(e.path.lastIndexOf("/") + 1);
        addedRetiredBasenames.add(base);
      }
      // Audit file: tests/pinned/retired/<claimId>.audit.json — written
      // by `pinned retire`. Required companion to the pin-file move.
      if (
        (e.status === "A" || e.status === "R") &&
        e.path.startsWith(`${dirPrefix}/retired/`) &&
        e.path.endsWith(".audit.json")
      ) {
        const auditBase = e.path.slice(e.path.lastIndexOf("/") + 1);
        // Map <claimId>.audit.json → <claimId>.test.ts for membership lookup
        const claimId = auditBase.replace(/\.audit\.json$/, "");
        addedAuditBasenames.add(`${claimId}.test.ts`);
      }
    }
    type Violation = { path: string; kind: "deleted" | "modified" | "weakened"; detail?: string };
    const violations: Violation[] = [];
    for (const e of entries) {
      if (!isPinFile(e.path) && !(e.status === "R" && e.oldPath && isPinFile(e.oldPath))) continue;
      const checkPath = e.status === "R" && e.oldPath ? e.oldPath : e.path;
      const base = checkPath.slice(checkPath.lastIndexOf("/") + 1);
      if (e.status === "D") {
        // Retire-flow exception: BOTH the retired-destination file AND
        // the matching .audit.json must have landed in this commit.
        // Without the audit file, a "retire" move is just a hidden
        // deletion. See [[strategic-pivot-guard-integrity]] retire-flow
        // bypass finding (mutation test #21).
        if (addedRetiredBasenames.has(base) && addedAuditBasenames.has(base)) continue;
        violations.push({
          path: checkPath,
          kind: "deleted",
          detail: addedRetiredBasenames.has(base)
            ? "moved to retired/ but no matching .audit.json — use `pinned retire` instead of manual mv"
            : undefined,
        });
        continue;
      }
      if (e.status === "R") {
        // Rename out of tests/pinned/ root is suspicious unless it's
        // exactly to tests/pinned/retired/<same-name> AND the matching
        // .audit.json file was also added in this commit.
        const newBase = e.path.slice(e.path.lastIndexOf("/") + 1);
        if (isRetiredDest(e.path) && newBase === base && addedAuditBasenames.has(base)) continue;
        violations.push({
          path: checkPath,
          kind: "deleted",
          detail: isRetiredDest(e.path) && newBase === base
            ? `renamed to ${e.path} but no matching .audit.json — use \`pinned retire\` instead of manual mv`
            : `renamed to ${e.path}`,
        });
        continue;
      }
      if (e.status === "M") {
        // Look at the added lines for weakening signals. Diff scope
        // mirrors the outer name-status diff: hook mode uses the staged
        // index, CI mode uses <base>...HEAD. Without this branch CI
        // would always see an empty diff and skip the weakening check
        // entirely, silently fail-opening on `--no-verify` bypass PRs.
        let stagedAdded = "";
        try {
          const diffArgs = opts.base
            ? ["diff", `${opts.base}...HEAD`, "--unified=0", "--no-color", "--", e.path]
            : ["diff", "--cached", "--unified=0", "--no-color", "--", e.path];
          stagedAdded = execFileSync("git", diffArgs, {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          });
        } catch {
          /* ignore — fall through to generic modified */
        }
        const addedLines = stagedAdded
          .split("\n")
          .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
          .map((l) => l.slice(1))
          .join("\n");
        const weakening = detectWeakeningPattern(addedLines);
        if (weakening) {
          violations.push({ path: e.path, kind: "weakened", detail: weakening });
        } else {
          violations.push({ path: e.path, kind: "modified" });
        }
      }
    }
    // Layer-1 Guard Integrity: also check Pinned infrastructure
    // (workflow file, registry) and the additional weakening patterns
    // not covered by the legacy detectWeakeningPattern (.toBeTruthy,
    // .toBeDefined, || true, ?? true, catch fallthrough, commented
    // assertions, .skipIf(true), .todo). Wired here so the same
    // pre-commit hook covers the full Layer-1 surface from
    // [[strategic-pivot-guard-integrity]].
    try {
      const { detectGuardIntegrityViolations } = await import("./guardIntegrity.js");
      const integrityPaths = [".github/workflows/pinned.yml", `${opts.dir}/.registry.json`];
      let extraDiffRaw = "";
      try {
        extraDiffRaw = execFileSync(
          "git",
          ["diff", "--cached", "--name-status", "--", ...integrityPaths],
          { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
        );
      } catch { /* paths may not exist yet — that's fine */ }
      const extraFiles: import("./scanDiff.js").ChangedFile[] = [];
      // Re-use the pin-file entries we already parsed above, adding
      // their addedLines so guardIntegrity can inspect for .toBeTruthy etc.
      for (const e of entries) {
        if (!isPinFile(e.path) && !(e.status === "R" && e.oldPath && isPinFile(e.oldPath))) continue;
        const target = e.status === "R" && e.oldPath ? e.oldPath : e.path;
        let added = "";
        if (e.status === "M") {
          try {
            const raw = execFileSync(
              "git",
              ["diff", "--cached", "--unified=0", "--no-color", "--", e.path],
              { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
            );
            added = raw
              .split("\n")
              .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
              .map((l) => l.slice(1))
              .join("\n");
          } catch { /* */ }
        }
        extraFiles.push({
          path: target,
          status: e.status === "A" ? "added" : e.status === "D" ? "deleted" : "modified",
          addedLines: added || undefined,
        });
      }
      // Add workflow / registry entries from the extra diff query
      for (const line of extraDiffRaw.split("\n")) {
        if (!line.trim()) continue;
        const parts = line.split("\t");
        const st = parts[0];
        const p = parts[parts.length - 1];
        if (!p) continue;
        let added = "";
        if (st === "M") {
          try {
            const raw = execFileSync(
              "git",
              ["diff", "--cached", "--unified=0", "--no-color", "--", p],
              { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
            );
            added = raw
              .split("\n")
              .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
              .map((l) => l.slice(1))
              .join("\n");
          } catch { /* */ }
        }
        extraFiles.push({
          path: p,
          status: st === "A" ? "added" : st === "D" ? "deleted" : "modified",
          addedLines: added || undefined,
        });
      }
      const extraViolations = detectGuardIntegrityViolations({ changedFiles: extraFiles });

      // Commit-time mistake detection — fires on the same staged
      // diff. Picks up SECRET/ENV/HARDCODED/ERR_DROP/AUTH_DROP
      // patterns per [[commitMistakes.ts]] + [[oss-mining-growth-plan]].
      // Block-severity findings exit non-zero same as guard-integrity.
      try {
        const { detectCommitMistakes } = await import("./commitMistakes.js");
        // Query the FULL staged diff (not pin-dir-filtered) so we can
        // catch secrets / hardcoded URLs / error-handling removal /
        // auth-header removal in ANY staged file, not just tests/pinned/.
        const fullStagedRaw = execFileSync(
          "git",
          ["diff", "--cached", "--name-status"],
          { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
        );
        type StageEntry = { path: string; status: "added" | "modified" | "deleted" };
        const stagedEntries: StageEntry[] = [];
        for (const line of fullStagedRaw.split("\n")) {
          if (!line.trim()) continue;
          const parts = line.split("\t");
          const st = parts[0];
          const p = parts[parts.length - 1];
          if (!p) continue;
          if (st === "A") stagedEntries.push({ path: p, status: "added" });
          else if (st === "M" || st?.startsWith("R") || st?.startsWith("C")) stagedEntries.push({ path: p, status: "modified" });
          else if (st === "D") stagedEntries.push({ path: p, status: "deleted" });
        }
        const addedByFile = new Map<string, string[]>();
        const removedByFile = new Map<string, string[]>();
        for (const e of stagedEntries) {
          if (e.status === "deleted") continue;
          try {
            const raw = execFileSync(
              "git",
              ["diff", "--cached", "--unified=0", "--no-color", "--", e.path],
              { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
            );
            const added: string[] = [];
            const removed: string[] = [];
            for (const line of raw.split("\n")) {
              if (line.startsWith("+++") || line.startsWith("---")) continue;
              if (line.startsWith("+")) added.push(line.slice(1));
              else if (line.startsWith("-")) removed.push(line.slice(1));
            }
            if (added.length > 0) addedByFile.set(e.path, added);
            if (removed.length > 0) removedByFile.set(e.path, removed);
          } catch { /* */ }
        }
        const mistakeFiles = stagedEntries.filter((e) => e.status !== "deleted");
        const mistakes = detectCommitMistakes({
          repoRoot: cwd,
          changedFiles: mistakeFiles,
          addedLinesByFile: addedByFile,
          removedLinesByFile: removedByFile,
        });
        // Local de-dupe set (doesn't depend on the outer-scoped
        // `seenPaths` which is declared later in this function — the
        // 2026-05-23 wiring bug surfaced via smoke test).
        const mistakesSeen = new Set<string>();
        for (const m of mistakes) {
          const key = `${m.file}|${m.type}`;
          if (mistakesSeen.has(key)) continue;
          mistakesSeen.add(key);
          violations.push({
            path: m.file,
            kind: "modified",
            detail: `${m.type}: ${m.evidence}${m.matchedLine ? ` [evidence: ${m.matchedLine}]` : ""}`,
          });
        }
      } catch (e) {
        if (!opts.quiet) err(`pinned: commit-mistakes detector failed (continuing): ${(e as Error).message}`);
      }
      // Translate to the legacy Violation shape so the existing error
      // output formats them consistently. Skip duplicates already
      // present in `violations` (e.g., the legacy detector + new
      // detector both flagging the same pin file).
      const seenPaths = new Set(violations.map((v) => `${v.path}|${v.kind}`));
      for (const ev of extraViolations) {
        // Map new types onto kinds the existing output recognizes.
        let kind: "deleted" | "modified" | "weakened" = "modified";
        if (ev.type === "pin-deleted" || ev.type === "workflow-modified" || ev.type === "registry-entry-removed") {
          kind = ev.severity === "block" && ev.type !== "workflow-modified" ? "deleted" : "modified";
          if (ev.type === "pin-deleted") kind = "deleted";
        } else {
          kind = "weakened";
        }
        const key = `${ev.file}|${kind}`;
        if (seenPaths.has(key)) continue;
        seenPaths.add(key);
        violations.push({
          path: ev.file,
          kind,
          detail: `${ev.type}: ${ev.evidence}${ev.after ? ` [evidence: ${ev.after}]` : ""}`,
        });
      }
    } catch (e) {
      if (!opts.quiet) err(`pinned: guard-integrity detector failed (continuing): ${(e as Error).message}`);
    }

    // If a sanctioned-write marker is in scope, drop violations on
    // files whose CURRENT on-disk content matches the marker's recorded
    // sha256. Those modifications were sanctioned by `pinned regenerate`
    // or `pinned auto-protect` and shouldn't be treated as AI tampering.
    //
    // Two match strategies, both consulted:
    //   1. `regenerated` (legacy): match by basename against files inside
    //      the pinned dir. Written by `pinned regenerate`.
    //   2. `sanctionedFiles` (0.2.7+): match by full repo-relative path,
    //      covers .registry.json + PINS.md + auto-protect's new pins.
    //      Written by `pinned auto-protect`.
    if (regenAllow && violations.length > 0) {
      const filtered: typeof violations = [];
      let allowedCount = 0;
      let allowedSources = new Set<string>();
      for (const v of violations) {
        let matched: { sha256: string } | undefined;
        // Strategy 2: exact repo-relative path match.
        const sanctionedByPath = regenAllow.sanctionedFiles?.find((s) => s.path === v.path);
        if (sanctionedByPath) {
          matched = sanctionedByPath;
        } else {
          // Strategy 1: basename match against `regenerated` (legacy).
          const basename = v.path.split("/").pop() ?? v.path;
          const sanctionedByBasename = regenAllow.regenerated?.find((r) => r.filename === basename);
          if (sanctionedByBasename) matched = sanctionedByBasename;
        }
        if (!matched) {
          filtered.push(v);
          continue;
        }
        // Re-hash current file content. If it matches the marker's sha256,
        // this is exactly the file the CLI wrote — sanctioned. If not, the
        // file was edited AFTER the sanctioned write (could be AI tampering
        // on top); keep it as a violation.
        try {
          const currentContent = readFileSync(join(cwd, v.path), "utf8");
          const currentSha = createHash("sha256").update(currentContent).digest("hex");
          if (currentSha === matched.sha256) {
            allowedCount += 1;
            if (sanctionedByPath) allowedSources.add("auto-protect");
            else allowedSources.add("regenerate");
            continue;
          }
        } catch { /* fall through to keeping as violation */ }
        filtered.push(v);
      }
      if (allowedCount > 0 && !opts.quiet) {
        const srcLabel = regenAllow.source ?? Array.from(allowedSources).join(" + ");
        out(
          `pinned: ${allowedCount} pinned write(s) sanctioned via .pinnedai/regenerate-allow.json (created by \`pinned ${srcLabel}\`).`
        );
      }
      violations.length = 0;
      violations.push(...filtered);
    }

    if (violations.length === 0) process.exit(0);

    // Record a BLOCK event in the status cache so the statusline shows
    // "Pinned · blocked: <terse>" for ~2 min. Visible AHA moment.
    // Best-effort — never let cache write failure stop the block.
    try {
      const { recordGuardBlocked } = await import("./statusline.js");
      const first = violations[0];
      // Map the legacy "kind" + path into a human-obvious short label.
      // Statusline truncates at 50 chars so keep it tight.
      const fileBase = first.path.split("/").pop() ?? first.path;
      const kindLabel =
        first.kind === "deleted" ? "AI deleted pin"
          : first.kind === "weakened" ? "AI weakened pin"
          : "AI edited pin";
      const more = violations.length > 1 ? ` (+${violations.length - 1})` : "";
      const summary = `${kindLabel} ${fileBase}${more}`;
      recordGuardBlocked(opts.dir, { summary });
    } catch { /* */ }

    // Auto-fire LEARNED: each block becomes a lesson the next agent
    // reading .pinned/ai-lessons.md sees. Dedupe by guardId so repeat
    // attempts append evidence rather than duplicating entries.
    try {
      const { appendLesson } = await import("./aiLessons.js");
      for (const v of violations.slice(0, 3)) {
        const fileBase = v.path.split("/").pop() ?? v.path;
        const guardId = `block-${v.kind}-${fileBase.replace(/\W+/g, "-")}`.toLowerCase();
        const titleVerb = v.kind === "deleted" ? "Don't delete" : v.kind === "weakened" ? "Don't weaken" : "Don't edit";
        appendLesson({
          guardId,
          title: `${titleVerb} ${fileBase}`,
          pastMistake: v.detail
            ? `${v.kind}: ${v.path} — ${v.detail}`
            : `${v.kind}: ${v.path}`,
          rule: `Do not ${v.kind === "deleted" ? "delete" : v.kind === "weakened" ? "weaken" : "edit"} ${v.path}. Fix the application code instead.`,
          plainEnglish: `don't ${v.kind === "deleted" ? "delete" : v.kind === "weakened" ? "weaken" : "edit"} ${fileBase}`,
          kind: "guard-block",
        }, { repoRoot: cwd, statusCacheDir: opts.dir });
      }
    } catch { /* best-effort */ }

    err("");
    err("✗ pinned: refusing to commit — protected pin tests were removed, modified, or weakened.");
    err("");
    for (const v of violations) {
      const tag = v.kind === "deleted" ? "DELETED" : v.kind === "weakened" ? "WEAKENED" : "MODIFIED";
      const detail = v.detail ? `  (${v.detail})` : "";
      err(`  [${tag}] ${v.path}${detail}`);
    }
    err("");
    err("  Pinned tests are permanent contracts. Allowed paths:");
    err("    • Retire the pin (recommended): pinned retire <claim-id> --reason=\"...\"");
    err("      — moves the test to tests/pinned/retired/ with an audit entry,");
    err("        commit the move and the guard does not fire again.");
    err("    • Bypass for ONE commit (no audit trail):");
    err("        PINNEDAI_ALLOW_PIN_EDIT=1 git commit ...");
    err("");
    err("  If you are an AI agent and a pinned test is failing, FIX THE APPLICATION CODE.");
    err("  Do not modify, skip, or delete the pinned test to make it pass.");
    err("");
    process.exit(2);
  });

// Detect content that weakens a test rather than just modifying it.
// Returns a short human-readable detail string when a weakening shape
// is present, or null. Conservative: only flags very-likely weakening
// (the goal is a SPECIFIC error message; non-weakening edits already
// get blocked by the generic "modified" branch upstream).
function detectWeakeningPattern(addedSource: string): string | null {
  if (!addedSource) return null;
  // `it.skip(`, `describe.skip(`, `test.skip(`
  if (/\b(?:it|test|describe)\.skip\s*\(/.test(addedSource)) return ".skip added to a previously-active test";
  // `xit(`, `xtest(`, `xdescribe(` — jest shorthand for skip
  if (/\b(?:xit|xtest|xdescribe)\s*\(/.test(addedSource)) return "xit/xtest/xdescribe (skip shorthand) added";
  // `expect(true).toBe(true)` or `expect(1).toBe(1)` — no-op assertion
  if (/\bexpect\s*\(\s*(?:true|1|"")\s*\)\.toBe\s*\(\s*(?:true|1|"")\s*\)/.test(addedSource)) {
    return "no-op assertion (expect(true).toBe(true) etc.) added";
  }
  // `expect.assertions(0)` — declares zero assertions, defeating the test
  if (/\bexpect\.assertions\s*\(\s*0\s*\)/.test(addedSource)) return "expect.assertions(0) added — defeats the test";
  // `return;` as the literal first statement of an `it(...)` body —
  // a sneaky way to skip without using .skip. Conservative match.
  if (/\bit\s*\([^)]*,\s*(?:async\s+)?\(\)\s*=>\s*\{\s*return\s*;/.test(addedSource)) {
    return "early return added to test body — defeats the assertions";
  }
  return null;
}

// ---------- install-agent-rules / uninstall-agent-rules / agent-rules ----------
//
// Opt-in wiring of AI coder config files (CLAUDE.md, .cursorrules,
// .github/copilot-instructions.md, etc.) to point at .pinned/ai-lessons.md.
// Per [[tier-model-final-2026-05-23]] this is strictly opt-in — Pinned
// never silently modifies user-owned agent files.

program
  .command("install-agent-rules")
  .description(
    "Add a Pinned-managed rules block to your AI coder's config file(s) (CLAUDE.md, .cursorrules, etc.) so the agent reads .pinned/ai-lessons.md before edits. Opt-in only."
  )
  .option("--path <path>", "Only install into this specific file (relative to repo root).")
  .option("--create", "If no agent config exists, create CLAUDE.md.")
  .option("--quiet", "Suppress non-error output.")
  .action(async (opts: { path?: string; create?: boolean; quiet?: boolean }) => {
    const { wireAgents } = await import("./agentConfig.js");
    const results = wireAgents({
      repoRoot: process.cwd(),
      installAgentRules: true,
      createIfAbsent: opts.create === true,
      onlyPath: opts.path,
    });
    const acted = results.filter((r) => r.action !== "skipped");
    if (acted.length === 0) {
      if (!opts.quiet) {
        out("");
        out("No agent config files found to wire.");
        out("");
        out("Either:");
        out("  • Create one yourself (CLAUDE.md, .cursorrules, .github/copilot-instructions.md, etc.) and re-run, OR");
        out("  • Run with --create to bootstrap CLAUDE.md.");
        out("");
      }
      return;
    }
    if (!opts.quiet) {
      out("");
      out("✓ Pinned agent rules installed:");
      for (const r of acted) {
        out(`  ${r.action.padEnd(10)} ${r.target.path}  (${r.target.name})`);
      }
      out("");
      out("Each file now points your AI coder at .pinned/ai-lessons.md and the Pinned guard rules.");
      out("Re-run anytime — the block is idempotent.");
      out("Undo: pinned uninstall-agent-rules");
      out("");
    }
  });

// `pinned install-claude` — opt-in helper that drops Claude-Code-style
// slash commands into .claude/commands/*.md so users get clickable
// /pinned-status /pinned-list /pinned-review /pinned-done shortcuts
// inside Claude Code. NOT auto-run by `pinned init` — must be invoked
// explicitly (see [[locked-decisions]] in CLAUDE.md: don't add
// .claude/commands/* during normal init).
program
  .command("install-claude")
  .description(
    "Opt-in: add /pinned-status, /pinned-list, /pinned-review, and /pinned-done slash commands to .claude/commands/ for Claude Code."
  )
  .option("--quiet", "Suppress non-error output.")
  .action(async (opts: { quiet?: boolean }) => {
    const cwd = process.cwd();
    const commandsDir = join(cwd, ".claude", "commands");
    const fs = await import("node:fs");
    if (!fs.existsSync(commandsDir)) {
      fs.mkdirSync(commandsDir, { recursive: true });
    }
    // Each slash command is a markdown file. Claude Code reads the file
    // when the user types `/<name>` and treats the contents as the
    // instructions for that one turn.
    type CommandFile = { slug: string; body: string };
    const commands: CommandFile[] = [
      {
        slug: "pinned-status",
        body: [
          "Show the current Pinned guard state for this repository.",
          "",
          "Run `pinned status` in the project shell and summarize the output for the user. Highlight the total guard count, any failing guards, and the last block event if present.",
        ].join("\n"),
      },
      {
        slug: "pinned-list",
        body: [
          "List the active Pinned guards in this repository.",
          "",
          "Run `pinned list --verbose` in the project shell and present the result as a bulleted list. If the user follows up asking about a specific guard, read the corresponding test file from `tests/pinned/`.",
        ].join("\n"),
      },
      {
        slug: "pinned-review",
        body: [
          "Run a full Pinned review: Guard Integrity check + scan-diff + AI-lessons check.",
          "",
          "1. Run `pinned review` in the project shell.",
          "2. Summarize the PASS / REVIEW / BLOCK status in plain English.",
          "3. If REVIEW or BLOCK, list the specific actions the user should take.",
        ].join("\n"),
      },
      {
        slug: "pinned-done",
        body: [
          "Pre-completion check — call this BEFORE telling the user a code change is finished.",
          "",
          "1. Run `pinned review` to check for unprotected risk surfaces.",
          "2. Run `pinned check-guard-removal` to detect any guard weakening/skip/delete.",
          "3. Report the PASS / REVIEW / BLOCK summary in your final response. Do NOT say the work is done if the status is BLOCK without explicit user acknowledgement.",
        ].join("\n"),
      },
    ];

    const written: string[] = [];
    const skipped: string[] = [];
    for (const cmd of commands) {
      const path = join(commandsDir, `${cmd.slug}.md`);
      if (fs.existsSync(path)) {
        skipped.push(cmd.slug);
        continue;
      }
      fs.writeFileSync(path, cmd.body + "\n");
      written.push(cmd.slug);
    }

    if (!opts.quiet) {
      out("");
      if (written.length > 0) {
        out("✓ Pinned slash commands installed in Claude Code:");
        for (const slug of written) {
          out(`  /${slug}    .claude/commands/${slug}.md`);
        }
      }
      if (skipped.length > 0) {
        out("");
        out(`Skipped (already present): ${skipped.map((s) => "/" + s).join(", ")}`);
      }
      out("");
      out("Type any of the slash commands inside Claude Code to invoke them.");
      out("Remove anytime with: rm -f .claude/commands/pinned-*.md");
      out("");
    }
  });

program
  .command("uninstall-agent-rules")
  .description("Remove the Pinned-managed rules block from all agent config files. Files themselves are preserved.")
  .option("--quiet", "Suppress non-error output.")
  .action(async (opts: { quiet?: boolean }) => {
    const { KNOWN_AGENT_TARGETS, unwireAgent } = await import("./agentConfig.js");
    const removed: string[] = [];
    const skipped: string[] = [];
    for (const t of KNOWN_AGENT_TARGETS) {
      const abs = join(process.cwd(), t.path);
      const r = unwireAgent(abs);
      if (r === "removed") removed.push(t.path);
      else skipped.push(`${t.path} (${r})`);
    }
    if (!opts.quiet) {
      out("");
      if (removed.length === 0) {
        out("No Pinned rule blocks found in known agent config files.");
      } else {
        out("✓ Removed Pinned rule blocks from:");
        for (const p of removed) out(`  - ${p}`);
      }
      out("");
    }
  });

program
  .command("agent-rules")
  .description("Show which agent config files have the Pinned rule block installed.")
  .action(async () => {
    const { statusAgents } = await import("./agentConfig.js");
    const rows = statusAgents(process.cwd());
    out("");
    out("Agent config file              | exists | pinned block");
    out("-------------------------------|--------|-------------");
    for (const r of rows) {
      const path = r.target.path.padEnd(30);
      const exists = (r.exists ? "yes" : "no").padEnd(6);
      const block = r.exists ? (r.hasPinnedBlock ? "✓ wired" : "—") : "—";
      out(`${path} | ${exists} | ${block}`);
    }
    out("");
    const wiredCount = rows.filter((r) => r.hasPinnedBlock).length;
    if (wiredCount === 0) {
      out("No agent config files are wired. Run `pinned install-agent-rules` to opt in.");
    } else {
      out(`${wiredCount} agent config file(s) wired. Your AI coder will read .pinned/ai-lessons.md before edits.`);
    }
    out("");
  });

// ---------- context (AI preflight) ----------
//
// Prints the current Pinned context as plain text — meant to be run
// BEFORE the AI starts editing. Surfaces all AI lessons + the rule
// "do not delete/skip/weaken pinned tests." Output is short enough
// to paste into a prompt or include in CI logs.
//
// Per [[strategic-pivot-guard-integrity]]: the lessons file alone isn't
// enough — agent configs must point at it. This command is the
// runtime form ("read the rules NOW") that complements the static
// CLAUDE.md / .cursorrules pointers.

program
  .command("context")
  .description("Print the current Pinned context (lessons + rules) for an AI coder to read before editing.")
  .option("--json", "Emit machine-readable JSON.")
  .action(async (opts: { json?: boolean }) => {
    const cwd = process.cwd();
    const { readLessons, readLessonsJson } = await import("./aiLessons.js");
    const lessons = readLessonsJson({ repoRoot: cwd });
    const count = readLessons({ repoRoot: cwd }).count;

    if (opts.json) {
      out(JSON.stringify({
        rules: [
          "Do not delete, skip, or weaken any test in tests/pinned/.",
          "Do not add .skip / .only / xit / xtest / .todo to pinned tests.",
          "Do not replace exact assertions (toBe(401)) with loose ones (toBeTruthy/toBeDefined).",
          "Do not add || true / ?? true / catch(() => true) to bypass assertions.",
          "Do not delete .github/workflows/pinned.yml or modify tests/pinned/.registry.json by hand.",
          "To retire a pin, run `pinned retire <claim-id> --reason=\"...\"` — never delete or rename manually.",
          "If a pinned test fails, FIX THE APPLICATION CODE — do not modify the test.",
        ],
        lessons,
      }, null, 2));
      return;
    }

    out("");
    out("Pinned context for AI coders (read before editing):");
    out("");
    out("RULES:");
    out("  - Do not delete, skip, or weaken any test in tests/pinned/.");
    out("  - Do not add .skip / .only / xit / xtest / .todo to pinned tests.");
    out("  - Do not replace exact assertions like toBe(401) with loose ones (toBeTruthy/toBeDefined).");
    out("  - Do not add || true / ?? true / catch(() => true) to bypass assertions.");
    out("  - Do not delete .github/workflows/pinned.yml or modify tests/pinned/.registry.json by hand.");
    out("  - To retire a pin, run `pinned retire <claim-id> --reason=\"...\"` — never delete/rename manually.");
    out("  - If a pinned test fails, FIX THE APPLICATION CODE — do not modify the test.");
    out("");
    if (lessons.length === 0) {
      out("LESSONS: none yet. Pinned will add lessons as it learns from real bug fixes and guard violations.");
    } else {
      out(`LESSONS (${lessons.length}):`);
      for (const l of lessons) {
        out(`  - ${l.rule}`);
        if (l.plainEnglish && l.plainEnglish !== l.rule) {
          out(`      tl;dr: ${l.plainEnglish}`);
        }
      }
    }
    out("");
    out(`(${count} total in .pinned/ai-lessons.md — read the file for full Past mistake / Rule / Guard details.)`);
    out("");
  });

// ---------- probe-admin (P0 #3 reporter) ----------
//
// Enumerate admin-shape routes (path-detected) and report their
// protection state: explicit inline auth, covered by middleware, or
// unprotected. Lightweight reporter — does NOT make HTTP requests
// (that requires PREVIEW_URL, deferred to v0.2). Per
// [[strategic-pivot-guard-integrity]] this is P0 #3.

program
  .command("probe-admin")
  .description("Enumerate inferred admin/internal routes and report their protection state.")
  .option("--json", "Emit machine-readable JSON.")
  .action(async (opts: { json?: boolean }) => {
    const cwd = process.cwd();
    const { scanDiffFull, detectAuthChecksInDiff } = await import("./scanDiff.js");
    const { readdirSync, lstatSync } = await import("node:fs");

    const files: string[] = [];
    const walk = (dir: string, rel: string): void => {
      let entries: string[];
      try { entries = readdirSync(dir); } catch { return; }
      for (const name of entries) {
        if (name === "node_modules" || name === ".git" || name === "dist" || name === "build") continue;
        const next = join(dir, name);
        let st;
        try { st = lstatSync(next); } catch { continue; }
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) walk(next, rel ? `${rel}/${name}` : name);
        else if (st.isFile()) files.push(rel ? `${rel}/${name}` : name);
      }
    };
    walk(cwd, "");

    const changed = files.map((p) => ({ path: p, status: "added" as const }));
    const scan = scanDiffFull({ changedFiles: changed, prBodyClaims: [], existingPins: [] });
    const adminRoutes = scan.suggestions.filter((s) => s.template === "auth-required" && s.route);

    // Check whether middleware covers the routes (single middleware-auth hit)
    const diffByFile = new Map<string, string[]>();
    for (const f of changed) {
      try {
        const content = (await import("node:fs")).readFileSync(join(cwd, f.path), "utf8");
        diffByFile.set(f.path, content.split("\n"));
      } catch { /* */ }
    }
    let middlewareHit: { filePath: string; signature: string } | null = null;
    try {
      const hits = detectAuthChecksInDiff(diffByFile);
      const mw = hits.find((h) => h.route === "* (middleware)");
      if (mw) middlewareHit = { filePath: mw.filePath, signature: mw.signature };
    } catch { /* */ }

    type Report = {
      route: string;
      file: string;
      protection: "middleware" | "inline" | "none";
    };
    const reports: Report[] = adminRoutes.map((s) => {
      const file = s.files[0] ?? "";
      // For simplicity: if middleware-auth detected, attribute all
      // routes to it (real middleware matchers can be narrower but
      // this is the best signal we have without parsing the matcher).
      const protection: Report["protection"] = middlewareHit ? "middleware" : "none";
      return { route: s.route!, file, protection };
    });

    if (opts.json) {
      out(JSON.stringify({
        adminRoutes: reports,
        middlewareAuth: middlewareHit,
      }, null, 2));
      return;
    }

    out("");
    out("Pinned · probe-admin");
    out(`  inferred admin/internal routes: ${reports.length}`);
    if (middlewareHit) {
      out(`  middleware auth detected: ${middlewareHit.filePath}`);
      out(`    signature: ${middlewareHit.signature.slice(0, 80)}`);
    } else {
      out(`  middleware auth: none detected`);
    }
    out("");
    if (reports.length === 0) {
      out("  No admin/internal route shapes found in repo.");
    } else {
      out("  Routes:");
      for (const r of reports.slice(0, 30)) {
        const tag = r.protection === "middleware" ? "✓ middleware" : r.protection === "inline" ? "✓ inline" : "⚠ no protection";
        out(`    ${r.route.padEnd(40)}  ${tag.padEnd(15)}  ${r.file}`);
      }
      if (reports.length > 30) out(`    ... and ${reports.length - 30} more`);
    }
    out("");
    if (!middlewareHit && reports.some((r) => r.protection === "none")) {
      out("  Hint: if these routes ARE auth-protected by something Pinned doesn't recognize, add the missing pattern to AUTH_CHECK_PATTERNS or set PREVIEW_URL and use the auth-required template's HTTP test.");
      out("");
    }
  });

// ---------- audit --learned ----------
//
// Scans the repo for sibling code paths that may exhibit the same
// mistake patterns Pinned has already learned (from bug-fix guards
// or proactive failure-mode detection). Per [[strategic-pivot-guard-integrity]]
// this closes the loop: bug → guard → siblings audited → future
// edits checked → AI lesson saved.
//
// High-confidence findings would auto-pin in observe mode (Pro
// feature in the eventual cloud version); v0.1 just SURFACES them.

program
  .command("audit")
  .description("Audit the repo for sibling code paths that may share a learned mistake pattern.")
  .option("--learned", "Use patterns Pinned has learned (currently: auth-required + returns-status).")
  .option("--category <cat>", "Only audit one category: auth | validation")
  .option("--verbose", "Show low-confidence findings too.")
  .option("--json", "Emit machine-readable JSON.")
  .action(async (opts: { learned?: boolean; category?: string; verbose?: boolean; json?: boolean }) => {
    if (!opts.learned) {
      err("audit currently supports --learned only. Run: pinned audit --learned");
      process.exit(1);
    }
    const cwd = process.cwd();
    const { findUnprotectedSiblings, AUTH_CHECK_PATTERNS } = await import("./scanDiff.js");
    const { readLessons } = await import("./aiLessons.js");

    const lessons = readLessons({ repoRoot: cwd });

    const VALIDATION_PATTERNS: RegExp[] = [
      /\bz\.object\s*\(/,
      /\.parseAsync\s*\(/,
      /\.safeParse(?:Async)?\s*\(/,
      /\byup\.object\s*\(/,
      /\bvalidate\s*\([^)]*req\.body/,
      /\bschema\.parse\s*\(/,
      /\b(?:reply|res)\.(?:code|status)\s*\(\s*400\b/,
    ];

    const wantAuth = !opts.category || opts.category === "auth";
    const wantValidation = !opts.category || opts.category === "validation";

    type Finding = {
      category: "auth" | "validation";
      filePath: string;
      route: string | null;
      confidence: "high" | "medium" | "low";
      reason: string;
    };
    const findings: Finding[] = [];

    if (wantAuth) {
      try {
        const out = findUnprotectedSiblings({
          repoPath: cwd,
          patterns: AUTH_CHECK_PATTERNS,
          triggerFilePath: "",
          triggerRoute: "* (middleware)",
          category: "auth",
        });
        for (const s of out) {
          if (!opts.verbose && s.confidence === "low") continue;
          findings.push({ category: "auth", filePath: s.filePath, route: s.route, confidence: s.confidence, reason: s.reason });
        }
      } catch (e) {
        if (!opts.json) err(`auth audit failed: ${(e as Error).message}`);
      }
    }
    if (wantValidation) {
      try {
        const out = findUnprotectedSiblings({
          repoPath: cwd,
          patterns: VALIDATION_PATTERNS,
          triggerFilePath: "",
          triggerRoute: "* (middleware)",
          category: "validation",
        });
        for (const s of out) {
          if (!opts.verbose && s.confidence === "low") continue;
          findings.push({ category: "validation", filePath: s.filePath, route: s.route, confidence: s.confidence, reason: s.reason });
        }
      } catch (e) {
        if (!opts.json) err(`validation audit failed: ${(e as Error).message}`);
      }
    }

    const high = findings.filter((f) => f.confidence === "high");
    const medium = findings.filter((f) => f.confidence === "medium");
    const low = findings.filter((f) => f.confidence === "low");

    if (opts.json) {
      out(JSON.stringify({
        lessonsCount: lessons.count,
        learnedGuardIds: lessons.guardIds,
        findings: {
          high: high.length,
          medium: medium.length,
          low: low.length,
          total: findings.length,
        },
        details: findings,
      }, null, 2));
    } else {
      // Plain-English banner. Avoids internal jargon like "high-confidence
      // findings would auto-pin in observe mode" — devs don't know what
      // observe mode is and shouldn't need to. Just say WHAT was checked
      // and what to do.
      out("");
      out("◆ Pinned · AUDIT");
      out("");
      const learnedFrom = lessons.count > 0
        ? `${lessons.count} lesson${lessons.count === 1 ? "" : "s"}`
        : "what Pinned has learned in this repo";
      out(`Checked similar code paths based on ${learnedFrom}.`);
      out("");
      if (findings.length === 0) {
        out("✓ No similar code paths look risky.");
        out("  Either this repo is well-covered or Pinned didn't recognize the pattern in other files.");
      } else {
        const totalSurfaced = high.length + medium.length;
        out(`Found ${totalSurfaced} place${totalSurfaced === 1 ? "" : "s"} worth a look:`);
        // Plain-English category labels (replace "auth" / "validation"
        // with a verb the user can act on).
        const friendlyCategory = (c: string): string => {
          if (c === "auth") return "looks like a route file with no login check";
          if (c === "validation") return "looks like a write route with no input validation";
          return c;
        };
        if (high.length > 0) {
          out("");
          out(`  Most likely to need attention (${high.length}):`);
          for (const f of high.slice(0, 20)) {
            const path = f.route ?? f.filePath;
            out(`    ⚠ ${path}  —  ${friendlyCategory(f.category)}`);
          }
        }
        if (medium.length > 0) {
          out("");
          out(`  Worth checking when you have time (${medium.length}):`);
          for (const f of medium.slice(0, 20)) {
            const path = f.route ?? f.filePath;
            out(`    · ${path}  —  ${friendlyCategory(f.category)}`);
          }
        }
        if (low.length > 0 && opts.verbose) {
          out("");
          out(`  Less likely matches (${low.length} · shown because --verbose):`);
          for (const f of low.slice(0, 10)) {
            out(`    · ${f.filePath}  —  ${friendlyCategory(f.category)}`);
          }
        }
        out("");
        out("Open each file and decide:");
        out("  • If it should have the same protection — add the check, then run `pinned init --auto` again to capture it.");
        out("  • If it's intentionally public / different — ignore it.");
      }
      out("");
    }

    // Record AUDIT event in status cache so statusline can show
    // "Pinned · AUDIT · N sibling risks checked".
    try {
      const { recordSiblingAudit } = await import("./statusline.js").catch(() => ({ recordSiblingAudit: null as null | ((d: string, a: { count: number }) => void) }));
      if (recordSiblingAudit) recordSiblingAudit(resolve(cwd, "tests/pinned"), { count: findings.length });
    } catch { /* */ }
  });

// ---------- retire ----------
program
  .command("retire")
  .description(
    "Retire a pinned claim — moves the test to tests/pinned/retired/ and writes an audit entry."
  )
  .argument("<claim-id>", "Claim id (filename without .test.ts)")
  .requiredOption(
    "--reason <text>",
    "Why this claim no longer applies — written into the audit log."
  )
  .option(
    "--dir <path>",
    "Pinned tests directory (default: tests/pinned)",
    "tests/pinned"
  )
  .option("--quiet", "Suppress the pinned banner header.")
  .action((claimId: string, opts: { reason: string; dir: string }) => {
    printBanner();
    assertSafeId("claim id", claimId);
    // --dir must stay inside the current working directory.
    // Otherwise a malicious invocation `pinned retire ... --dir ../../etc`
    // could move files anywhere on disk.
    assertInsideDir(opts.dir, process.cwd());
    const src = join(opts.dir, `${claimId}.test.ts`);
    assertInsideDir(src, opts.dir);
    if (!existsSync(src)) {
      err(`✗ No pinned claim found at ${src}\n`);
      process.exit(1);
    }
    const retiredDir = join(opts.dir, "retired");
    mkdirSync(retiredDir, { recursive: true });
    const dest = join(retiredDir, `${claimId}.test.ts`);
    assertInsideDir(dest, retiredDir);
    renameSync(src, dest);

    const retiredBy =
      process.env.GITHUB_ACTOR ?? process.env.USER ?? "unknown";
    const audit = {
      claimId,
      retiredAt: new Date().toISOString(),
      reason: opts.reason,
      retiredBy,
    };
    writeFileSync(
      join(retiredDir, `${claimId}.audit.json`),
      JSON.stringify(audit, null, 2) + "\n"
    );

    // Update the registry + regenerate PINS.md so the retired status
    // shows up in the human-facing view.
    const registry = retireEntry(
      readRegistry(opts.dir),
      claimId,
      opts.reason,
      retiredBy
    );
    writeRegistry(opts.dir, registry);

    out(`- ${relative(process.cwd(), src)}`);
    out(`+ ${relative(process.cwd(), dest)}`);
    out(`+ ${relative(process.cwd(), join(retiredDir, `${claimId}.audit.json`))}`);
    out(`~ ${relative(process.cwd(), join(opts.dir, "PINS.md"))}`);
    out("");
    out("Commit the move so the audit trail is preserved in git history.");
  });

// ---------- helpers ----------

// Human-friendly status string describing where the LLM call landed.
// Surfaces cache hits, quota counters, and BYOK routing so operators
// know exactly what just ran.
function describeLlmMode(
  llm: Extract<Awaited<ReturnType<typeof llmExtract>>, { ok: true }>
): string {
  const planTag = `plan: ${llm.plan}`;
  if (llm.source === "byok-anthropic" || llm.source === "byok-openai") {
    return `LLM via ${llm.source} (your provider key, never our infra) [${planTag}]`;
  }
  const cacheTag = llm.cached ? "cached" : "fresh";
  if (llm.quota) {
    return `LLM ${cacheTag} via hosted Worker; ${llm.quota.calls}/${llm.quota.limit} this month [${planTag}]`;
  }
  if (llm.cached) {
    return `LLM cached via hosted Worker (no quota burned) [${planTag}]`;
  }
  return `LLM via hosted Worker [${planTag}]`;
}

// Plain-English failure scenario per template. Surfaced in `pinned show`
// (alias `describe`) to make the pin's contract explicit — addresses the
// "pins are a black box; I have to read the generated test file to see
// what's being checked" feedback. Each line should answer: what concrete
// change to the code would cause this pin to fail?
function describeFailureScenario(c: Claim): string {
  switch (c.template) {
    case "auth-required":
      return `${c.route} starts serving protected content without auth (any non-401/403, non-login-redirect, non-login-form response means the auth check was removed).`;
    case "rate-limit":
      return `${c.route} stops returning 429 after the ${c.rate}/${c.window} threshold (the rate limiter was removed or its threshold was raised).`;
    case "permission-required":
      return `${c.route} stops requiring the '${c.role}' role (the role check is removed, or a non-${c.role} role gains access).`;
    case "tier-cap":
      return `${c.route} stops enforcing the ${c.tier}-tier cap of ${c.cap} ${c.resource} (the cap is raised, removed, or applied to the wrong tier).`;
    case "idempotent":
      return `${c.route} stops deduplicating by ${c.idField} — the same payload twice produces different responses or double side-effects.`;
    case "returns-status":
      return `${c.method} ${c.route} stops returning ${c.status}${c.condition ? ` on ${c.condition}` : ""} (validation logic was removed or weakened).`;
    case "cli-output-contains":
      return `\`${c.route}\` stops printing "${c.text.length > 60 ? c.text.slice(0, 59) + "…" : c.text}" to stdout (the output line was renamed, removed, or moved to stderr).`;
    case "cli-exits-zero":
      return `\`${c.route}\` starts exiting with a non-zero code (introduced bug, removed dependency, syntax error).`;
    case "cli-creates-file":
      return `\`${c.route}\` stops creating ${c.filePath} (the write logic was removed or the path changed).`;
    case "cli-flag-supported":
      return `\`${c.route}\` rejects the ${c.flag} flag (the flag was renamed, removed, or its handler broken).`;
    case "cli-json-shape":
      return `\`${c.route}\`'s JSON output loses any of: ${c.keys.join(", ")} (the response shape was refactored without backward compatibility).`;
    case "library-returns":
      return `${c.functionName} in ${c.modulePath} stops returning ${JSON.stringify(c.expected)} (signature changed, default removed, dependency injection rewired).`;
    case "lockfile-integrity":
      return `${c.lockfilePath} content drifts (sha256 != ${c.expectedSha256.slice(0, 12)}…) — pin assumes the lockfile is the source of truth for installed dep versions.`;
    case "config-invariant":
      return `${c.configPath} loses '${c.label}' — a config key that was present at pin time is missing or relocated.`;
    case "package-exports-exist":
      return `${c.modulePath} stops exporting any of: [${c.exports.join(", ")}] — a refactor accidentally drops an export that something imports.`;
    case "secret-not-public":
      return `A file in the public surface contains a value matching the secret marker pattern (${c.secretMarkers.join(", ")}) — looks like an API key was committed.`;
    case "url-literal-preserved":
      return `${c.filePath} stops containing the literal "${c.urlLiteral}" (URL drift — search-and-replace, typo in a config rename, or environment variable hardcoded somewhere else).`;
    case "tsc-clean":
      return `\`tsc -p ${c.tsconfigPath}\` exits non-zero — TypeScript compilation broke somewhere.`;
    case "module-export-stable":
      return `${c.modulePath} stops exporting '${c.exportName}' — an AI refactor renamed or removed a symbol something else depends on.`;
    case "react-route-registered":
      return `${c.routerFilePath} no longer registers the route '${c.routePath}' — link or navigation to this path will 404.`;
    case "webhook-handler-exists":
      return `${c.filePath} loses its ${c.provider} signature verification (the verify call was removed, leaving the webhook accepting unsigned payloads).`;
    case "import-path-resolves":
      return `${c.sourceFilePath} can't resolve '${c.importPath}' — the imported file was renamed, removed, or its export changed.`;
    case "changed-literal-preserved":
      return `${c.filePath} reverts to the old ${c.shape} value '${c.oldValue}' (the fix that changed it to '${c.newValue}' was undone).`;
    case "form-submit-error-handling":
      return `Submit handler in ${c.filePath} loses its error-state path (no setError/catch/toast on submit failure — UI silently swallows errors).`;
    case "page-renders":
      return `${c.route} stops rendering — server returns a 500-class status, the body is missing/empty, or a React/Next/Vite error overlay (\`Application error: a client-side exception\`, \`__NEXT_ERROR_CODE\`, \`Cannot read prop\`, etc.) leaks into the response.`;
    case "validation-rejects-bad":
      return `${c.method} ${c.route} starts accepting bodies it should reject (malformed JSON returns 2xx, or a required field can now be omitted) — validation was removed or weakened.`;
    case "happy-path-with-side-effect":
      return `${c.method} ${c.route} returns 2xx but no longer emits the X-Pinned-Side-Effect header — the endpoint may be a stub returning a happy status without actually performing the ${c.sideEffectKind} to \`${c.sideEffectTarget}\` (misleading-green).`;
    default:
      return `the contract described above is broken.`;
  }
}

// Read the short-lived sanctioned-write marker written by
// `pinned regenerate` and `pinned auto-protect`. Returns null if the
// marker doesn't exist, has expired, or fails to parse. The marker
// authorizes pre-commit-hook bypass ONLY for files matching the
// recorded paths + sha256s — so it's not a general "allow any pin
// edit" toggle, only a "the pinned CLI wrote these exact bytes"
// attestation.
//
// Two arrays, both honored by check-guard-removal:
//   - `regenerated` — pin files inside the pinned dir, matched by basename.
//     (Legacy from 0.2.1+; written by `pinned regenerate`.)
//   - `sanctionedFiles` — arbitrary repo-relative paths (registry,
//     PINS.md, newly-authored pin files), matched by full path.
//     (Added 0.2.7; written by `pinned auto-protect`.)
//
// Either array can be present without the other. `source` records
// which command wrote the marker (for debugging / human output).
type RegenerateAllowMarker = {
  version: number;
  createdAt: string;
  expiresAt: string;
  runId: string;
  source?: "regenerate" | "auto-protect";
  regenerated?: Array<{ filename: string; sha256: string; dir: string }>;
  sanctionedFiles?: Array<{ path: string; sha256: string }>;
};
// Idempotent + safe append-to-gitignore. Used by pinned init AND by
// pinned regenerate (so existing repos auto-fix when they next
// regenerate — don't need to wait for re-init). No-op if:
//   - .gitignore already contains an exact-match line for the pattern
//   - .gitignore already contains the pattern as part of a broader rule
//   - Not in a git repo (no .git directory at cwd)
// Writes a leading newline if .gitignore exists and doesn't end with one,
// so the appended line doesn't accidentally extend the previous line.
function ensureGitignored(pattern: string): "added" | "already" | "no-git" {
  const gitignorePath = ".gitignore";
  if (!existsSync(".git")) return "no-git";
  let current = "";
  try {
    current = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  } catch {
    return "no-git";
  }
  // Match the pattern as a standalone line (ignoring leading/trailing
  // whitespace + optional leading `/`). e.g. ".pinnedai/" matches both
  // ".pinnedai/" and "/.pinnedai/" but NOT ".pinnedai.bak/".
  const normalized = pattern.replace(/^\/+/, "").replace(/\/+$/, "");
  const lineRegex = new RegExp(
    `^\\s*\\/?${normalized.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\/?\\s*$`,
    "m"
  );
  if (lineRegex.test(current)) return "already";
  const prefix = current && !current.endsWith("\n") ? "\n" : "";
  const append = `${prefix}${pattern}\n`;
  try {
    writeFileSync(gitignorePath, current + append);
    return "added";
  } catch {
    return "no-git";
  }
}

function readRegenerateAllowMarker(): RegenerateAllowMarker | null {
  const markerPath = join(".pinnedai", "regenerate-allow.json");
  if (!existsSync(markerPath)) return null;
  try {
    const raw = readFileSync(markerPath, "utf8");
    const parsed = JSON.parse(raw) as RegenerateAllowMarker;
    if (!parsed.expiresAt) return null;
    if (new Date(parsed.expiresAt).getTime() < Date.now()) return null;
    // Marker is valid if at least one of the two arrays is present.
    const hasRegenerated = Array.isArray(parsed.regenerated);
    const hasSanctioned = Array.isArray(parsed.sanctionedFiles);
    if (!hasRegenerated && !hasSanctioned) return null;
    return parsed;
  } catch {
    return null;
  }
}

// Write a sanctioned-write marker. Called by `auto-protect` after it
// modifies the registry / PINS.md / writes new pin files inside a
// pre-commit hook run, so the subsequent `check-guard-removal` step
// doesn't fight itself.
//
// Marker has a 5-min TTL and binds to specific sha256s of the
// repo-relative paths it sanctions. If anything edits those files
// between write and commit, the sha256 won't match and the change is
// flagged normally.
function writeSanctionedWriteMarker(
  source: "auto-protect",
  repoRelativeFiles: string[]
): void {
  try {
    const markerDir = ".pinnedai";
    if (!existsSync(markerDir)) mkdirSync(markerDir, { recursive: true });
    const sanctionedFiles = repoRelativeFiles
      .map((p) => {
        if (!existsSync(p)) return null;
        const content = readFileSync(p, "utf8");
        const sha256 = createHash("sha256").update(content).digest("hex");
        return { path: p, sha256 };
      })
      .filter((e): e is { path: string; sha256: string } => e !== null);
    if (sanctionedFiles.length === 0) return;
    const now = Date.now();
    // If a regenerate marker already exists and hasn't expired, merge
    // into it (rare — but possible when a user runs `pinned regenerate`
    // followed by `pinned auto-protect` within 5 minutes). Preserves
    // both `regenerated` and `sanctionedFiles` arrays.
    const existing = readRegenerateAllowMarker();
    const merged: RegenerateAllowMarker = {
      version: 1,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 5 * 60 * 1000).toISOString(),
      runId: randomBytes(8).toString("hex"),
      source,
      regenerated: existing?.regenerated,
      sanctionedFiles: [
        ...(existing?.sanctionedFiles ?? []).filter(
          (e) => !sanctionedFiles.some((s) => s.path === e.path)
        ),
        ...sanctionedFiles,
      ],
    };
    writeFileSync(
      join(markerDir, "regenerate-allow.json"),
      JSON.stringify(merged, null, 2) + "\n"
    );
  } catch {
    /* Marker write failure is non-fatal — the user will see the hook
       block and can use PINNEDAI_ALLOW_PIN_EDIT=1 to bypass once. */
  }
}

// Scan tests/pinned/*.test.ts files for the `// generated-by:
// pinnedai@X.Y.Z` header. Pins missing the header (pre-0.2.1) OR
// stamped with a version older than `currentVersion` are returned as
// "stale" — the user is advised to `pinned regenerate --all` to apply
// template fixes shipped since those pins were generated.
function findStalePins(
  dir: string,
  currentVersion: string
): Array<{ file: string; version: string | null }> {
  if (!existsSync(dir)) return [];
  let files: string[] = [];
  try {
    files = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(".test.ts"))
      .map((d) => d.name);
  } catch {
    return [];
  }
  const stale: Array<{ file: string; version: string | null }> = [];
  for (const file of files) {
    const full = join(dir, file);
    let head = "";
    try {
      head = readFileSync(full, "utf8").slice(0, 2048);
    } catch {
      continue;
    }
    const m = /\/\/\s*generated-by:\s*pinnedai@([0-9]+\.[0-9]+\.[0-9]+[A-Za-z0-9.-]*)/.exec(head);
    if (!m) {
      stale.push({ file, version: null });
      continue;
    }
    const v = m[1];
    if (compareSemverLoose(v, currentVersion) < 0) {
      stale.push({ file, version: v });
    }
  }
  return stale;
}

// Loose semver compare — major.minor.patch only (ignores prerelease).
// Returns -1 if a<b, 0 if equal, 1 if a>b.
function compareSemverLoose(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
  }
  return 0;
}

function describeClaim(c: Claim): string {
  switch (c.template) {
    case "rate-limit":
      return `rate-limit     ${c.route}  →  ${c.rate}/${c.window}`;
    case "auth-required":
      return `auth-required  ${c.route}  →  401/403 without auth`;
    case "permission-required":
      return `permission     ${c.route}  →  ${c.role}-role only (3-direction check)`;
    case "tier-cap":
      return `tier-cap       ${c.route}  →  ${c.tier}: ${c.cap} ${c.resource} (3-direction check)`;
    case "idempotent":
      return `idempotent     ${c.route}  →  dedup by ${c.idField}`;
    case "returns-status":
      return `returns-status ${c.method} ${c.route}  →  ${c.status}${c.condition ? ` on ${c.condition}` : ""}`;
    case "cli-output-contains": {
      const t = c.text.length > 40 ? c.text.slice(0, 39) + "…" : c.text;
      return `cli-output     \`${c.route}\`  →  stdout contains "${t}"`;
    }
    case "cli-exits-zero":
      return `cli-exits      \`${c.route}\`  →  exits 0`;
    case "cli-creates-file":
      return `cli-creates    \`${c.route}\`  →  creates ${c.filePath}`;
    case "cli-flag-supported":
      return `cli-flag       \`${c.route}\`  →  supports ${c.flag}`;
    case "cli-json-shape":
      return `cli-json       \`${c.route}\`  →  JSON has keys: ${c.keys.join(", ")}`;
    case "library-returns":
      return `library        ${c.functionName} in ${c.modulePath}  →  returns ${JSON.stringify(c.expected)}`;
    case "lockfile-integrity":
      return `lockfile       ${c.lockfilePath}  →  sha256 ${c.expectedSha256.slice(0, 12)}…`;
    case "config-invariant":
      return `config         ${c.configPath}  →  ${c.label} present`;
    case "package-exports-exist":
      return `pkg-exports    ${c.modulePath}  →  exports [${c.exports.join(", ")}]`;
    case "secret-not-public":
      return `secret-shape   ${c.publicPrefix}*  →  none contains [${c.secretMarkers.join(", ")}]`;
    case "url-literal-preserved":
      return `url-literal    ${c.filePath}  →  contains "${c.urlLiteral}"`;
    case "tsc-clean":
      return `tsc-clean      ${c.tsconfigPath}  →  exits 0`;
    case "module-export-stable":
      return `export-stable  ${c.modulePath}  →  exports ${c.exportName}`;
    case "react-route-registered":
      return `route          ${c.routerFilePath}  →  path ${c.routePath}`;
    case "webhook-handler-exists":
      return `webhook        ${c.filePath}  →  ${c.provider} handler signature`;
    case "import-path-resolves":
      return `import         ${c.sourceFilePath}  →  ${c.importPath} resolves`;
    case "changed-literal-preserved":
      return `changed-literal ${c.filePath}  →  ${c.shape}: ${c.oldValue} → ${c.newValue}`;
    case "form-submit-error-handling":
      return `form-error     ${c.filePath}  →  onSubmit keeps try/catch or .catch`;
    case "page-renders":
      return `page-renders   ${c.route}  →  GET returns rendered HTML (no error markers)`;
    case "validation-rejects-bad":
      return `validation     ${c.method} ${c.route}  →  rejects ${c.requiredFields.length || 1} bad-input case(s)`;
    case "happy-path-with-side-effect":
      return `happy-path     ${c.method} ${c.route}  →  emits X-Pinned-Side-Effect (${c.sideEffectKind}: ${c.sideEffectTarget})`;
    case "journey": {
      const path = c.steps.map((s) => `${s.method} ${s.route}`).join(" → ");
      return `journey        ${c.label}  →  ${path}`;
    }
  }
}

async function resolveBody(explicit?: string): Promise<string | null> {
  if (explicit && explicit.trim()) return explicit;
  // Whitespace-only GITHUB_PR_BODY (empty PR description, just blanks)
  // should NOT short-circuit stdin — it'd produce a confusing "no
  // claims found" parse of meaningless whitespace.
  if (process.env.GITHUB_PR_BODY && process.env.GITHUB_PR_BODY.trim()) {
    return process.env.GITHUB_PR_BODY;
  }
  const piped = await readStdin();
  if (piped.trim()) return piped;
  return null;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  // Cap stdin at 200KB. Fail closed if exceeded — a truncated body
  // would generate incomplete pins, which is worse than refusing.
  const MAX_STDIN_BYTES = 200_000;
  let data = "";
  let size = 0;
  for await (const chunk of process.stdin) {
    const piece = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    size += Buffer.byteLength(piece, "utf8");
    if (size > MAX_STDIN_BYTES) {
      throw new Error(
        `stdin exceeded ${MAX_STDIN_BYTES} bytes — refusing to process a truncated PR body. Trim the input or pass --description.`
      );
    }
    data += piece;
  }
  return data;
}

function out(s: string): void {
  process.stdout.write(s + "\n");
}

function err(s: string): void {
  process.stderr.write(s);
}

const WORKFLOW_YAML = `# Generated by \`pinnedai init\`. Tweak freely.
#
# Two triggers:
#   - pull_request — scans the diff, posts suggestions, auto-commits pins
#   - issue_comment — listens for \`@pinned add: <claim>\` to pin from a comment
#
# Auto-commit is on by default (opt out with PINNEDAI_AUTOCOMMIT=false
# repo variable). BYOK (bring-your-own-key) LLM mode is opt-in via repo
# secrets: set PINNEDAI_BYOK=anthropic | openai | claude-code | github-models
# and provide the matching key (PINNEDAI_ANTHROPIC_KEY / PINNEDAI_OPENAI_KEY /
# PINNEDAI_GITHUB_TOKEN). Without BYOK, Pinned runs in deterministic mode
# (regex-based detectors only) — fully functional, just no LLM proposer.

name: pinned
on:
  pull_request:
    types: [opened, synchronize, edited]
  issue_comment:
    types: [created]

permissions:
  pull-requests: write
  contents: write
  id-token: write

# One concurrent job per PR — prevents the pull_request job and the
# @pinned-add issue_comment job from racing on the same registry file.
concurrency:
  group: pinned-\${{ github.event.pull_request.number || github.event.issue.number }}
  cancel-in-progress: false

jobs:
  # ---------- PR-open job ----------
  pin:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          ref: \${{ github.event.pull_request.head.ref }}
      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      # GUARD INTEGRITY CHECK — backstop for Layer 1 (pre-commit hook).
      # Catches the case where AI used \`git commit --no-verify\` locally
      # to bypass the pre-commit hook and pushed a .skip()/.only()/
      # weakened-assertion/deleted-pin commit. Without this CI-side
      # check, vitest would report skipped tests as success (exit 0)
      # and the PR would be incorrectly greenlit.
      - name: Guard Integrity — block bypassed/.skip'd/weakened pins
        run: npx -y pinnedai@${version} check-guard-removal --base "origin/\${{ github.event.pull_request.base.ref }}"

      # Run the pinned test suite. Pins with no PREVIEW_URL self-skip
      # via it.skipIf — they don't fail-fast. Add a vitest install
      # fallback in case the customer repo doesn't have it locally.
      - name: Run pinned tests (block on broken guards)
        run: |
          # Exclude tests/pinned/retired/** — retired pins have audit
          # entries and intentionally preserve their original assertion
          # so git history is honest; running them would make every
          # "pinned retire" a guaranteed CI break.
          if [ -d tests/pinned ] && ls tests/pinned/*.test.ts >/dev/null 2>&1; then
            if [ -f node_modules/.bin/vitest ]; then
              ./node_modules/.bin/vitest run tests/pinned/ --exclude '**/retired/**' --reporter=verbose --no-coverage
            else
              # Last-resort: vitest not installed in the repo. Fall back
              # to npx with no-install so this step doesn't silently pass.
              npx -y -p vitest@^2 vitest run tests/pinned/ --exclude '**/retired/**' --reporter=verbose --no-coverage
            fi
          else
            echo "No pinned tests to run yet — first PR will create them."
          fi

      - name: Parse claims from PR description
        env:
          GITHUB_PR_BODY: \${{ github.event.pull_request.body }}
          PINNEDAI_BYOK: \${{ vars.PINNEDAI_BYOK }}
          PINNEDAI_ANTHROPIC_KEY: \${{ secrets.PINNEDAI_ANTHROPIC_KEY }}
          PINNEDAI_OPENAI_KEY: \${{ secrets.PINNEDAI_OPENAI_KEY }}
        run: npx -y pinnedai@${version} check

      - name: Compose Pinned PR comment
        id: prc
        env:
          GITHUB_PR_BODY: \${{ github.event.pull_request.body }}
          PINNEDAI_BYOK: \${{ vars.PINNEDAI_BYOK }}
          PINNEDAI_ANTHROPIC_KEY: \${{ secrets.PINNEDAI_ANTHROPIC_KEY }}
          PINNEDAI_OPENAI_KEY: \${{ secrets.PINNEDAI_OPENAI_KEY }}
          BASE_REF: \${{ github.event.pull_request.base.ref }}
          PR_NUM: \${{ github.event.pull_request.number }}
          RUN_ID: \${{ github.run_id }}
        run: |
          BODY=$(npx -y pinnedai@${version} pr-comment \\
            --base "origin/$BASE_REF" \\
            --pr-id "pr-$PR_NUM" \\
            --quiet)
          # Random delimiter so adversarial diff content can't
          # accidentally (or maliciously) match it and corrupt the
          # GITHUB_OUTPUT block. $RUN_ID is the GitHub run id env var.
          DELIM="PINNED_EOF_$(openssl rand -hex 16 2>/dev/null || echo "\${RUN_ID}_$RANDOM")"
          {
            echo "body<<$DELIM"
            echo "$BODY"
            echo "$DELIM"
          } >> "$GITHUB_OUTPUT"
          echo "$BODY"

      - name: Post Pinned comment on PR
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          PR_NUM: \${{ github.event.pull_request.number }}
          COMMENT_BODY: \${{ steps.prc.outputs.body }}
        # Always post — even quiet-success comments reinforce that
        # Pinned ran. The body adapts to what was found.
        run: gh pr comment "$PR_NUM" --body "$COMMENT_BODY"

      - name: Auto-commit pinned tests
        if: \${{ vars.PINNEDAI_AUTOCOMMIT != 'false' }}
        env:
          GITHUB_PR_BODY: \${{ github.event.pull_request.body }}
          PINNEDAI_BYOK: \${{ vars.PINNEDAI_BYOK }}
          PINNEDAI_ANTHROPIC_KEY: \${{ secrets.PINNEDAI_ANTHROPIC_KEY }}
          PINNEDAI_OPENAI_KEY: \${{ secrets.PINNEDAI_OPENAI_KEY }}
          PR_NUM: \${{ github.event.pull_request.number }}
          HEAD_REF: \${{ github.event.pull_request.head.ref }}
        run: |
          npx -y pinnedai@${version} generate \\
            --pr-id "pr-$PR_NUM" \\
            --description "$GITHUB_PR_BODY"

          if ! git diff --quiet -- tests/pinned/ 2>/dev/null; then
            git config user.name "pinned[bot]"
            git config user.email "bot@pinnedai.dev"
            git add tests/pinned/
            git commit -m "Pin claims from PR #$PR_NUM"
            git push origin "HEAD:$HEAD_REF"
          else
            echo "No new pins to commit."
          fi

  # ---------- @pinned add: comment trigger ----------
  # Lets reviewers / authors pin a claim directly from a PR comment,
  # without editing the PR description. Example comment body:
  #   @pinned add: Auth required on /api/admin/export.
  #
  # Gated to trusted commenters (OWNER / MEMBER / COLLABORATOR) so an
  # outside contributor can't trigger a commit-and-push on a public
  # repo by leaving an @pinned comment.
  pin-from-comment:
    if: >-
      github.event_name == 'issue_comment' &&
      github.event.issue.pull_request != null &&
      contains(github.event.comment.body, '@pinned add:') &&
      contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association)
    runs-on: ubuntu-latest
    steps:
      - name: Extract claim sentence
        id: extract
        env:
          COMMENT_BODY: \${{ github.event.comment.body }}
          RUN_ID: \${{ github.run_id }}
        run: |
          CLAIM=$(printf '%s' "$COMMENT_BODY" | grep -oE '@pinned add:[[:space:]]*.*' | head -1 | sed -E 's/^@pinned add:[[:space:]]*//')
          if [ -z "$CLAIM" ]; then
            echo "No claim text found after \`@pinned add:\`" >&2
            exit 1
          fi
          # Random delimiter so a multiline comment containing the
          # delimiter literal can't corrupt the GITHUB_OUTPUT block.
          DELIM="PIN_EOF_$(openssl rand -hex 16 2>/dev/null || echo "\${RUN_ID}_$RANDOM")"
          {
            echo "claim<<$DELIM"
            echo "$CLAIM"
            echo "$DELIM"
          } >> "$GITHUB_OUTPUT"

      - name: Resolve PR head ref
        id: pr
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          PR_NUM: \${{ github.event.issue.number }}
          REPO: \${{ github.repository }}
        run: |
          REF=$(gh pr view "$PR_NUM" --json headRefName --jq .headRefName --repo "$REPO")
          echo "ref=$REF" >> "$GITHUB_OUTPUT"

      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          ref: \${{ steps.pr.outputs.ref }}
      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Generate the pin
        env:
          PINNEDAI_BYOK: \${{ vars.PINNEDAI_BYOK }}
          PINNEDAI_ANTHROPIC_KEY: \${{ secrets.PINNEDAI_ANTHROPIC_KEY }}
          PINNEDAI_OPENAI_KEY: \${{ secrets.PINNEDAI_OPENAI_KEY }}
          PR_NUM: \${{ github.event.issue.number }}
          CLAIM_TEXT: \${{ steps.extract.outputs.claim }}
        run: |
          npx -y pinnedai@${version} generate \\
            --pr-id "pr-$PR_NUM" \\
            --description "$CLAIM_TEXT"

      - name: Commit and push
        id: commit
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          BRANCH_REF: \${{ steps.pr.outputs.ref }}
          ACTOR: \${{ github.event.comment.user.login }}
        run: |
          if ! git diff --quiet -- tests/pinned/ 2>/dev/null; then
            git config user.name "pinned[bot]"
            git config user.email "bot@pinnedai.dev"
            git add tests/pinned/
            git commit -m "Pin via @pinned add: from $ACTOR"
            git push origin "HEAD:$BRANCH_REF"
            echo "committed=true" >> "$GITHUB_OUTPUT"
          else
            echo "committed=false" >> "$GITHUB_OUTPUT"
          fi

      - name: Acknowledge in PR comment
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          PR_NUM: \${{ github.event.issue.number }}
          REPO: \${{ github.repository }}
          CLAIM_TEXT: \${{ steps.extract.outputs.claim }}
          COMMITTED: \${{ steps.commit.outputs.committed }}
        run: |
          # Sanitize the claim text for inclusion in a markdown code span
          # — backticks in the claim could break out of the inline code.
          SAFE_CLAIM=$(printf '%s' "$CLAIM_TEXT" | tr -d '\`')
          if [ "$COMMITTED" = "true" ]; then
            gh pr comment "$PR_NUM" --repo "$REPO" --body "✓ Pinned: \\\`$SAFE_CLAIM\\\`"
          else
            gh pr comment "$PR_NUM" --repo "$REPO" --body "Could not parse a recognizable claim from \\\`$SAFE_CLAIM\\\`. Try \\\`@pinned add: Auth required on /api/X.\\\` or \\\`@pinned add: Rate-limits /api/X to N req/min.\\\`"
          fi
`;

const TESTS_README = `# tests/pinned/

This directory is managed by [pinnedai](https://pinnedai.dev).

Each \`*.test.ts\` file here was generated from a PR description claim
and is **pinned permanently to your CI**. If a future commit regresses
the claim, the test fails and points back at the original PR.

To retire a claim that no longer applies:

\`\`\`bash
npx pinnedai retire <claim-id> --reason="<why>"
\`\`\`

To list everything currently pinned:

\`\`\`bash
npx pinnedai list
\`\`\`
`;

await program.parseAsync(process.argv);
