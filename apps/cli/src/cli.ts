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
import { dirname, join, relative, resolve, sep } from "node:path";

import { execFileSync, spawnSync as childSpawnSync } from "node:child_process";
import {
  parseClaims,
  unionClaims,
  describeClaimForUser,
  detectBugFixPhrase,
} from "./claimParser.js";
import type { Claim } from "./claimParser.js";
import { generateTest } from "./index.js";
import {
  readRegistry,
  writeRegistry,
  addEntry,
  retireEntry,
  countActivePins,
  renderCatchesMarkdown,
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
    const gen = generateTest(first, { prId: "pr-demo" });
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
      err(
        "✗ No PR description provided. Pass --description, pipe stdin, set GITHUB_PR_BODY, or run `npx pinnedai try` for a demo.\n"
      );
      process.exit(1);
    }
    const regexClaims = parseClaims(body);
    const llm = await llmExtract(body);
    const llmClaims = llm.ok ? llm.claims : [];
    const claims = unionClaims(regexClaims, llmClaims);
    const llmContribution = claims.length - regexClaims.length;

    if (opts.json) {
      out(JSON.stringify(claims, null, 2));
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
    if (claims.length === 0) {
      out("No claims found. Examples of claim phrasings Pinned recognizes:");
      out('  "Rate-limits /api/users to 60 req/min."');
      out('  "Auth required on /api/admin/export."');
      out('  "Makes /webhooks/stripe idempotent on event_id."');
      return;
    }
    out(`Found ${claims.length} claim(s):`);
    for (const c of claims) out(`  • ${describeClaim(c)}`);
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
      const regexClaims = parseClaims(body);
      const llm = await llmExtract(body);
      const llmClaims = llm.ok ? llm.claims : [];
      const claims = unionClaims(regexClaims, llmClaims);
      if (llm.ok) {
        out(`(${describeLlmMode(llm)})`);
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
            out("(LLM fallback skipped: no GitHub OIDC context — running outside CI.");
            out(" Real PRs going through the GitHub Action get natural-language extraction.)");
          } else if (llm.reason === "error") {
            out(`(LLM fallback unavailable: ${llm.error.slice(0, 200)})`);
            out(" Try again in a moment, or check api.pinnedai.dev status.");
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
        const gen = generateTest(claim, { prId: opts.prId });
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
          out(`  → CLAUDE.md (created — no AI rule file exists yet)`);
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
        const { detectCliLibraryPins, detectLockfilePins, detectConfigInvariantPins, detectPackageExportsPins } = await import("./scanDiff.js");
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
            const gen = generateTest(claim, { prId });
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
            const gen = generateTest(claim, { prId });
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
              raw: `lockfile-integrity ${lock.lockfilePath} sha256 ${lock.expectedSha256.slice(0, 12)}`,
            };
            const gen = generateTest(claim, { prId });
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
            const gen = generateTest(claim, { prId });
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
        if (baselineAutoAdded > 0) {
          writeRegistry(pinnedDir, registry);
          stampPinAddedToCache(
            pinnedDir,
            baselineAutoAdded,
            countActivePins(registry),
            baselineAddedSummaries
          );
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
        // Name the pins so the user FEELS the value, not just sees +N.
        // "+ Added 4 pins" is abstract; "+ Added Stripe webhook
        // idempotency, auth on /api/admin, lockfile integrity + 1 more"
        // shows what's actually being protected.
        const namedSummary =
          baselineAddedSummaries.length > 0
            ? renderAddedSummaryList(baselineAddedSummaries)
            : "";
        out(
          `★ Pinned is now protecting ${baselineAutoAdded} thing${baselineAutoAdded === 1 ? "" : "s"} in your repo:`
        );
        if (namedSummary) {
          out(namedSummary);
        }
        out("");
        out(
          `   If AI changes break any of these, your tests will fail and Pinned will tell you.`
        );
      }
      if (baselineSuggested > 0) {
        out("");
        out(
          `? ${baselineSuggested} more candidate${baselineSuggested === 1 ? "" : "s"} need review. Run \`pinned protect\` to add the ones that apply.`
        );
      }
    }
    out("");
    out("Try it:");
    out("  npx pinnedai try            # local demo");
    out("  pinned status               # see pins + risks + safety + breaks caught");
    out("  pinned auto-protect         # scan working tree, auto-add safe pins");
    if (wantPreCommit && wantPostCommit) {
      out("");
      out("Auto-protection is fully wired:");
      out("  · git commit  → auto-adds new pins (pre-commit hook)");
      out("  · git commit  → auto-verifies existing pins in the background (post-commit hook)");
      out("  · git push    → backstop scan (pre-push hook)");
      out("Set PINNEDAI_SKIP_HOOK=1 on any git command to bypass.");
    } else if (wantPreCommit) {
      out("");
      out("Pre-commit hook is installed — pin growth happens automatically on every commit.");
      out("Set PINNEDAI_SKIP_HOOK=1 to bypass for one commit.");
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
  // Fallback: if no AI rule files exist, create CLAUDE.md (the most
  // common convention and the one our docs point to).
  const targets = detected.length > 0 ? detected : ["CLAUDE.md"];

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
  switch (claim.template) {
    case "rate-limit":
      return `${claim.route} rate limit: ${claim.rate}/${claim.window}`;
    case "auth-required":
      return `${claim.route} auth check`;
    case "permission-required":
      return `${claim.route} ${claim.role}-only access`;
    case "tier-cap":
      return `${claim.tier}-tier limit: ${claim.cap} ${claim.resource} on ${claim.route}`;
    case "idempotent":
      return `${capitalize(humanProviderFromRoute(claim.route))} webhook duplicate-event handling`;
    case "returns-status":
      return `${claim.method} ${claim.route} input validation`;
    case "cli-output-contains":
      return `\`${claim.route}\` output content`;
    case "cli-exits-zero":
      return `\`${claim.route}\` runs without crashing`;
    case "cli-creates-file":
      return `\`${claim.route}\` produces ${claim.filePath}`;
    case "cli-json-shape":
      return `\`${claim.route}\` JSON output shape`;
    case "cli-flag-supported":
      return `\`${claim.flag}\` flag on \`${claim.route}\``;
    case "library-returns":
      return `${claim.functionName}() return value`;
    case "lockfile-integrity":
      return `dependency lockfile`;
    case "config-invariant":
      return humanizeConfigLabel(claim.label, claim.configPath);
    case "package-exports-exist":
      return `\`${claim.modulePath}\` keeps exporting ${claim.exports.length} symbol${claim.exports.length === 1 ? "" : "s"}`;
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
      return `GitHub Action permission for Pinned`;
    case "auto-commit permission":
      return `GitHub Action permission to add new pins`;
    case "Pinned guardrail block":
      return `AI-coder rules in CLAUDE.md`;
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
//                                   + lockfile integrity + 1 more"
// reads better than dumping all 10 names. The full list is one
// `pinned list` away.
function renderAddedSummaryList(summaries: string[]): string {
  if (summaries.length === 0) return "";
  const MAX_VISIBLE = 5;
  const visible = summaries.slice(0, MAX_VISIBLE);
  const rest = summaries.length - visible.length;
  const lines = visible.map((s) => `   + ${s}`);
  if (rest > 0) {
    lines.push(`   + …and ${rest} more`);
  }
  return lines.join("\n");
}

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
  return JSON.stringify(
    {
      statusLine: { command: "node ./apps/cli/dist/cli.js statusline" },
      hooks: {
        UserPromptSubmit: [
          { command: "node ./apps/cli/dist/cli.js hook-failure", matcher: "*" },
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

    // Default — title-only scan view. Run `pinned show <id>` for detail.
    if (!opts.verbose) {
      if (active.length > 0) {
        // See verbose-mode comment below for the rationale on ⊘/?.
        const anySkippedShort = (last?.skippedCount ?? 0) > 0;
        out(`Protected behaviors (${active.length}) — ✓ verified, ✗ broken, ⊘ skipped, ? not yet checked:`);
        out("");
        let i = 0;
        for (const e of active) {
          i += 1;
          let statusIcon: string;
          if (failingSet.has(e.claimId)) {
            statusIcon = "✗";
          } else if (anySkippedShort) {
            // Conservative — can't tell WHICH pins skipped from the
            // aggregate count. Never falsely claim "verified."
            statusIcon = "?";
          } else if (last) {
            statusIcon = "✓";
          } else {
            statusIcon = "?";
          }
          out(`${String(i).padStart(2)}. ${statusIcon} ${describeClaimForUser(e.claim).title}`);
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
  .description("Show full detail for a single pinned claim: text, file, status, catch history.")
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
  .action((opts: { dir: string; limit: string }) => {
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
    let i = 0;
    for (const c of history.slice(0, limit)) {
      i += 1;
      const dateOnly = c.caughtAt.replace(/T.*$/, "");
      const entry = regById.get(c.claimId);
      const title = entry
        ? describeClaimForUser(entry.claim).title
        : c.claimText ?? c.claimId;
      out(`${String(i).padStart(2)}. 🛟 ${title}`);
      out(`      Caught: ${dateOnly}`);
      if (entry) out(`      Test:   tests/pinned/${entry.filename}`);
      out("");
    }
    if (history.length > limit) {
      out(`... and ${history.length - limit} more (use --limit ${history.length})`);
    }
  });

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
  .option("--mode <product|extended>", "product = PR/commit claims only (matches shipping product). extended = + diff-derived inference.", "product")
  .option("--max-replay <n>", "Max forward-commits to replay per pin.", "50")
  .option("--vitest-timeout <ms>", "Per-commit vitest timeout (ms).", "30000")
  .option("--json", "Emit the full backtest report as JSON.")
  .option("--quiet", "Suppress the pinned banner header.")
  .action(async (opts: {
    repo: string;
    from?: string;
    to: string;
    mode: string;
    maxReplay: string;
    vitestTimeout: string;
    json?: boolean;
    quiet?: boolean;
  }) => {
    if (!opts.quiet) printBanner();
    if (opts.mode !== "product" && opts.mode !== "extended") {
      err(`✗ Invalid --mode '${opts.mode}'. Use: product | extended\n`);
      process.exit(1);
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

      // Phase 1 — scan-diff against the base ref.
      const changedFiles = readChangedFilesFromGit(opts.base);
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
      // vitest config + node_modules. Skip if no tests/pinned/ yet.
      const shouldTest = opts.test !== false && existsSync(opts.dir);
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
      const hasSkippedPins =
        skippedFromTest !== null && parseInt(skippedFromTest[1], 10) > 0;

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
      } else if (hasSkippedPins) {
        out(
          `⊘ Some pins SKIPPED (no PREVIEW_URL / fixture tokens) — they're not currently verifying.`
        );
        out(
          `  See https://pinnedai.dev/docs/preview-url to enable verification.`
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

    // BYOK opt-in status. Identity / plan is server-side via OIDC; the
    // local check is only useful for confirming the BYOK env wiring.
    const byok = activeByokProvider();
    if (byok) {
      const envName =
        byok === "anthropic"
          ? "PINNEDAI_ANTHROPIC_KEY"
          : "PINNEDAI_OPENAI_KEY";
      if (process.env[envName]) {
        checks.push({
          name: `BYOK (${byok})`,
          result: "ok",
          detail: `${envName} present — BYOK active when org is on a paid plan`,
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
        detail: `PINNEDAI_BYOK='${process.env.PINNEDAI_BYOK}' is not recognized. Expected 'anthropic' or 'openai'.`,
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
          const gen = generateTest(claim, { prId });
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
  .action(async (opts: {
    base: string;
    mode?: string;
    budget?: number;
    dryRun?: boolean;
    dir: string;
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
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") {
          continue; // already pinned — silent
        }
        throw e;
      }
    }
    if (written > 0) {
      writeRegistry(opts.dir, registry);
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
      suggestedCount,
      lastCheckedSha: sha ?? undefined,
      lastCheckedDirtyHash: dirtyHash ?? undefined,
      updatedAt: new Date().toISOString(),
    });

    out("");
    if (written > 0 && suggestedCount > 0) {
      out(
        `✓ Auto-added ${written} pin${written === 1 ? "" : "s"}. ${suggestedCount} more suggested — run \`pinned protect\` to review.`
      );
    } else if (written > 0) {
      out(`✓ Auto-added ${written} pin${written === 1 ? "" : "s"}.`);
    } else if (suggestedCount > 0) {
      out(
        `${suggestedCount} pin${suggestedCount === 1 ? "" : "s"} suggested — run \`pinned protect\` to review.`
      );
    } else {
      out(`✓ No new behaviors to protect.`);
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
        out("");
        out("(--summarize requested; calling hosted LLM…)");
        const summary = await llmSafetySummarize(findings);
        if (summary.ok) {
          out("");
          out("Summary:");
          out(summary.markdown);
        } else {
          err(`(summarize unavailable: ${summary.reason})\n`);
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
      out(`  ✓ ${totalPins} active, all passing`);
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
      if (cache?.status === "failing") {
        out(`  Streak broken on the current check. Fix above, then verify again.`);
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
        out(`  ✓ ${streak} consecutive successful run${streak === 1 ? "" : "s"} · ${checksRun} total · last: ${ageLabel}`);
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
    out("After fixing, re-run: pnpm pinned:test");
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
    const result = spawnSync(
      "npx",
      ["--no-install", "vitest", "run", opts.dir],
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
    if (caughtNow) {
      out(
        `🛟 Pinned caught ${newFailures.length} regression${newFailures.length === 1 ? "" : "s"} — ${newFailures.slice(0, 3).join(", ")}`
      );
    }
    process.exit(result.status ?? 1);
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
# Auto-commit is on for both Free and Pro (opt out with PINNEDAI_AUTOCOMMIT=false
# repo variable). Pro/Team/Enterprise orgs are detected automatically via OIDC —
# no license key needed. BYOK (opt-in, paid only) is activated by setting
# PINNEDAI_BYOK=anthropic or PINNEDAI_BYOK=openai in repo variables, plus the
# matching PINNEDAI_ANTHROPIC_KEY / PINNEDAI_OPENAI_KEY secret.

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
