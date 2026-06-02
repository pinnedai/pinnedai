// Internal calibration tool: "what would Pinned have caught if it
// were installed at commit N and replayed forward to HEAD?"
//
// Walks git log in chronological order, parses claim-shaped text out of
// commit messages and (optionally) merged-PR descriptions, generates the
// would-be pin test, then replays the repo's history against that pin
// to detect transitions green → red (= catch). Used pre-launch as the
// load-bearing answer to "does Pinned actually catch real regressions?"
//
// Scope and constraints:
//   - HTTP templates (rate-limit/auth-required/idempotent) need
//     PREVIEW_URL or a fixture server to verify. Without it, those pin
//     tests skip silently — backtest reports them as "not testable
//     without preview." The real signal comes from CLI / library
//     templates, which run against the codebase directly.
//   - Each pin is replayed only at commits that touched its
//     covers.files (or the route's source file, derived from the
//     claim's route). Touching nothing = no replay.
//   - Backtest runs in a git WORKTREE — the repo's working tree is
//     untouched. The worktree is removed on completion.
//   - The output is a structured report (JSON), no global state.
//
// Two modes:
//   "product": parse PR/commit descriptions only — mirrors how the
//              shipping product extracts claims. The honest baseline.
//   "extended": product mode PLUS diff-derived inference (treat new
//              admin route files as implicit claims). Higher coverage,
//              not the product's contract — useful for calibration to
//              understand the upper bound of catches.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClaims, type Claim, claimSlug } from "./claimParser.js";
import { generateTest } from "./index.js";
import { scanDiffFull, type ChangedFile } from "./scanDiff.js";

export type BacktestMode = "product" | "extended";

// ---- Bug-fix benchmark types ----
//
// A targeted backtest that only looks at commits whose subject matches
// a fix/bug keyword. For each such commit C, we generate pins at C
// (the fix state), then replay each pin against C^ (the buggy parent).
//
// The headline metric is "real catches": pins that FAIL at the parent
// AND PASS at the fix. That's the only pattern that proves a guard
// would have caught a real regression. Random commit sweeps don't
// produce these — bug-fix commits do because the parent is, by
// definition, the broken state.
//
// Keyword set is intentionally broad to catch fix-shaped subjects
// across project conventions:
//   - core fix verbs: fix(es|ed), bug, regression, prevent, bypass
//   - high-value behaviors: auth, permission, webhook, idempotent,
//     rate-limit, quota, cap, race, tenant, leak, unauthorized
const FIX_KEYWORD_RE = /\b(fix(?:e[sd])?|bug|regression|prevent|bypass|unauthor[iz]ed|quota|cap(?:ped)?|webhook|idempotent|permission|auth(?:[a-z]*)?|race|tenant|leak)\b/i;

export type BugFixBenchOptions = {
  repoPath: string;
  fromCommit?: string;
  toCommit?: string;
  // Max number of fix-commits to evaluate. Bounds runtime — a
  // long-history repo can have hundreds of fix commits.
  maxFixCommits?: number;
  vitestTimeoutMs?: number;
};

export type BugFixPinResult = {
  claim: Claim;
  filename: string;
  fixVerdict: "pass" | "fail" | "skip" | "infra-fail";
  parentVerdict: "pass" | "fail" | "skip" | "infra-fail" | "no-parent";
  // The only classification that proves the pin is a real guard:
  //   real-catch:    parent=fail, fix=pass — would have caught the bug
  //   no-signal:     parent=pass, fix=pass — pin doesn't encode this bug
  //   broken-at-fix: fix=fail — pin failed its own positive control
  //   no-parent:     fix-commit is the first commit in history
  //   skipped:       fix or parent verdict was skip/infra-fail
  classification: "real-catch" | "no-signal" | "broken-at-fix" | "no-parent" | "skipped";
  // Sibling-bug discovery results — populated ONLY when
  // classification === "real-catch" AND the catch is in a high-value
  // category (auth-required / returns-status today; tier-cap /
  // webhook-idempotency / etc. as those detectors land). See memory
  // [[sibling-discovery-confidence-tiered-no-approval]] for the model.
  // The benchmark only SURFACES siblings — actual auto-pinning lives
  // in the live `pinned guard` path. No CI behavior derives from
  // these here; they're suggestions in the report.
  siblings?: import("./scanDiff.js").SiblingSuggestion[];
};

export type BugFixCommitResult = {
  fixCommit: string;
  parentCommit: string | null;
  subject: string;
  body: string;
  pins: BugFixPinResult[];
};

export type BugFixReport = {
  repo: string;
  commitsScanned: number;        // total commits in walked range
  fixCommitsMatched: number;     // commits whose subject matched FIX_KEYWORD_RE
  fixCommitsEvaluated: number;   // after maxFixCommits cap
  pinsGenerated: number;
  pinsByTemplate: Record<string, number>;
  realCatches: number;
  realCatchesByTemplate: Record<string, number>;
  noSignal: number;
  brokenAtFix: number;
  noParent: number;
  notTestableHttp: number;
  durationMs: number;
  fixes: BugFixCommitResult[];
};

export type BacktestOptions = {
  repoPath: string;
  fromCommit?: string; // default: walk full history
  toCommit?: string;   // default: HEAD
  mode: BacktestMode;
  // How many commits forward to replay against each pin. A pin's
  // protected files might not be touched again for many commits; bound
  // to keep individual repos tractable.
  maxReplayCommits?: number;
  // Vitest invocation timeout per commit.
  vitestTimeoutMs?: number;
};

export type BacktestPin = {
  claim: Claim;
  originCommit: string;
  originSubject: string;
  filename: string;
  // Each commit in chronological order where this pin's covers.files
  // were touched. Each entry records whether the test passed or failed.
  replays: { commit: string; subject: string; outcome: "pass" | "fail" | "skip" | "infra-fail" }[];
  // True if a replay flipped from pass → fail. That's the catch.
  caughtRegression: boolean;
  // True if the pin failed AT INSTALL time (commit N+0). Indicates a
  // claim that didn't match the contemporaneous code — a false
  // positive at generation time, not a catch.
  brokenAtBirth: boolean;
};

export type BacktestReport = {
  repo: string;
  mode: BacktestMode;
  commitsScanned: number;
  pinsGenerated: number;
  pinsByTemplate: Record<string, number>;
  brokenAtBirth: number;
  catches: number;
  catchesByTemplate: Record<string, number>;
  notTestableHttp: number;
  durationMs: number;
  pins: BacktestPin[];
};

export async function runBacktest(opts: BacktestOptions): Promise<BacktestReport> {
  const startedAt = Date.now();
  const { repoPath, mode } = opts;
  const fromCommit = opts.fromCommit ?? "";
  const toCommit = opts.toCommit ?? "HEAD";
  const maxReplay = opts.maxReplayCommits ?? 50;
  const vitestTimeoutMs = opts.vitestTimeoutMs ?? 30_000;

  if (!existsSync(join(repoPath, ".git"))) {
    throw new Error(`Not a git repo: ${repoPath}`);
  }

  // List all commits in chronological order (oldest first).
  const range = fromCommit ? `${fromCommit}..${toCommit}` : toCommit;
  const log = git(
    repoPath,
    ["log", range, "--reverse", "--pretty=format:%H%n%s%n%b%n---PINNED-BACKTEST-DELIM---"]
  );
  const entries = log.split("---PINNED-BACKTEST-DELIM---\n").filter((s) => s.trim());
  const commits = entries.map((entry) => {
    const lines = entry.split("\n");
    return {
      sha: lines[0]?.trim() ?? "",
      subject: lines[1]?.trim() ?? "",
      body: lines.slice(2).join("\n").trim(),
    };
  }).filter((c) => c.sha.length === 40);

  const pinsByTemplate: Record<string, number> = {};
  const catchesByTemplate: Record<string, number> = {};
  const pins: BacktestPin[] = [];
  let brokenAtBirth = 0;
  let catches = 0;
  let notTestableHttp = 0;

  // Set up an isolated worktree so vitest replays can checkout
  // historical commits without touching the user's actual working tree.
  const worktreePath = mkdtempSync(join(tmpdir(), "pinned-backtest-wt-"));
  try {
    git(repoPath, ["worktree", "add", "--detach", worktreePath, toCommit]);
  } catch (e) {
    rmSync(worktreePath, { recursive: true, force: true });
    throw new Error(`Failed to create worktree at ${worktreePath}: ${(e as Error).message}`);
  }

  // Install vitest into the worktree ONCE. Historical checkouts won't
  // have node_modules (we never run npm install per-commit — too slow,
  // and dep versions changing would themselves cause spurious fails).
  // We use a stable vitest binary symlinked from THIS pinnedai install
  // so the version is consistent across every replay commit.
  //
  // Layout we create:
  //   <worktree>/node_modules/.bin/vitest          (symlink)
  //   <worktree>/node_modules/vitest               (symlink to our vitest dir)
  //
  // Symlinks survive `git checkout` since they're outside the tracked
  // file set. If a later commit had its own node_modules our symlinks
  // would conflict, but historical commits in 99% of repos don't
  // commit node_modules.
  await installBacktestVitest(worktreePath);

  // Pre-compute "files touched per commit" so we can scope each pin's
  // replays to commits that actually touched the pin's covered files.
  // For filesystem templates (lockfile / config / exports / library /
  // secret-not-public / CLI), commits that touch nothing relevant
  // can't change the pin's verdict — so skipping them is safe and
  // ~30× faster than replaying the whole window.
  //
  // Format: Map<sha, Set<files>>. One git log call walks the whole
  // range. Renames are followed because git log --name-only resolves
  // them. R<score> status lines are split into old/new paths.
  const filesByCommit = await buildFilesByCommit(repoPath, commits);

  // Pin holding area — generated tests go here. Worktree gets a
  // tests/pinned/ subdir for each replay; we add/remove individually.
  const pinHolding = mkdtempSync(join(tmpdir(), "pinned-backtest-pins-"));

  try {
    for (let i = 0; i < commits.length; i++) {
      const c = commits[i];
      // Combined claim source: commit subject + body. In product mode
      // we use exactly this. In extended mode we also union diff-derived.
      const text = `${c.subject}\n\n${c.body}`;
      const explicit = parseClaims(text);

      let claimsForThisCommit: Claim[] = explicit;
      if (mode === "extended") {
        // Run baseline-style detection on this commit's diff.
        const changed = filesChanged(repoPath, c.sha);
        if (changed.length > 0) {
          const scan = scanDiffFull({
            changedFiles: changed,
            prBodyClaims: explicit,
            existingPins: [],
          });
          // Convert suggestions back to Claims by parsing their suggestedPin
          for (const s of scan.suggestions) {
            const parsed = parseClaims(s.suggestedPin);
            claimsForThisCommit = claimsForThisCommit.concat(parsed);
          }
        }
        // Plus the non-HTTP detectors that emit pins from filesystem
        // state directly. These produce the highest-signal backtest
        // catches because they assert against concrete content that
        // can change in a single commit. Checkout the worktree to
        // commit-N first so the detectors see THAT commit's state,
        // not HEAD's.
        gitWorktreeCheckout(worktreePath, c.sha);
        const { detectCliLibraryPins, detectLockfilePins, detectConfigInvariantPins, detectPackageExportsPins } = await import("./scanDiff.js");
        for (const cli of detectCliLibraryPins(worktreePath)) {
          if (cli.template !== "cli-exits-zero") continue;
          claimsForThisCommit.push({
            template: "cli-exits-zero",
            route: `${cli.identifier} --help`,
            raw: cli.suggestedPin,
          });
        }
        for (const lock of detectLockfilePins(worktreePath)) {
          claimsForThisCommit.push({
            template: "lockfile-integrity",
            lockfilePath: lock.lockfilePath,
            expectedSha256: lock.expectedSha256,
            packageJsonSha256: lock.packageJsonSha256,
            raw: lock.suggestedPin,
          });
        }
        for (const cfg of detectConfigInvariantPins(worktreePath)) {
          claimsForThisCommit.push({
            template: "config-invariant",
            configPath: cfg.configPath,
            expected: cfg.expected,
            label: cfg.label,
            raw: cfg.suggestedPin,
          });
        }
        for (const exp of detectPackageExportsPins(worktreePath)) {
          claimsForThisCommit.push({
            template: "package-exports-exist",
            modulePath: exp.modulePath,
            exports: exp.exports,
            raw: exp.suggestedPin,
          });
        }
      }

      // Dedup within this commit
      const seen = new Set<string>();
      const newClaims = claimsForThisCommit.filter((cl) => {
        const k = claimKey(cl);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });

      for (const claim of newClaims) {
        const template = claim.template;
        pinsByTemplate[template] = (pinsByTemplate[template] ?? 0) + 1;

        // HTTP templates without PREVIEW_URL fixture aren't testable in
        // this backtest harness. Count them but don't waste replay time.
        if (
          template === "rate-limit" ||
          template === "auth-required" ||
          template === "permission-required" ||
          template === "idempotent" ||
          template === "tier-cap" ||
          template === "returns-status"
        ) {
          notTestableHttp += 1;
          continue;
        }

        // Generate the test file (uses the same code path as
        // `pinned generate`). The PR id placeholder shows the commit
        // sha so a reader of the test file can trace back.
        const gen = generateTest(claim, { prId: `backtest-${c.sha.slice(0, 8)}` });
        const testPath = join(pinHolding, gen.filename);
        writeFileSync(testPath, gen.content);

        // Day-zero check: does the pin pass at THIS commit's working tree?
        // If not, the claim didn't match the contemporaneous code —
        // false positive at generation time (broken-at-birth).
        gitWorktreeCheckout(worktreePath, c.sha);
        const dayZero = runVitestAt(worktreePath, testPath, vitestTimeoutMs);

        const replays: BacktestPin["replays"] = [];
        if (dayZero === "fail") {
          brokenAtBirth += 1;
          pins.push({
            claim,
            originCommit: c.sha,
            originSubject: c.subject,
            filename: gen.filename,
            replays: [{ commit: c.sha, subject: c.subject, outcome: "fail" }],
            caughtRegression: false,
            brokenAtBirth: true,
          });
          continue;
        }
        if (dayZero === "skip" || dayZero === "infra-fail") {
          // Can't establish a baseline — skip.
          pins.push({
            claim,
            originCommit: c.sha,
            originSubject: c.subject,
            filename: gen.filename,
            replays: [{ commit: c.sha, subject: c.subject, outcome: dayZero }],
            caughtRegression: false,
            brokenAtBirth: false,
          });
          continue;
        }

        // Replay against subsequent commits — BUT filter to commits
        // that touched files the pin actually covers. A commit that
        // touched nothing relevant can't change the pin's verdict, so
        // skipping is mathematically equivalent for lockfile +
        // config-invariant (read 1 file, file unchanged → sha
        // unchanged), and ~90% accurate for everything else (may
        // miss transitive-dependency edges).
        const subsequentAll = commits.slice(i + 1, i + 1 + maxReplay);
        const relevantPaths = relevantPathsForClaim(claim);
        const subsequent =
          relevantPaths === null
            ? subsequentAll // template has no known coverage → can't optimize
            : subsequentAll.filter((next) => {
                const touched = filesByCommit.get(next.sha);
                if (!touched) return true; // safe default: don't skip on unknown
                return [...touched].some((f) => relevantPaths.some((p) => pathMatchesCovered(f, p)));
              });
        let caughtThis = false;
        for (const next of subsequent) {
          gitWorktreeCheckout(worktreePath, next.sha);
          const outcome = runVitestAt(worktreePath, testPath, vitestTimeoutMs);
          replays.push({ commit: next.sha, subject: next.subject, outcome });
          if (outcome === "fail") {
            caughtThis = true;
            break;
          }
        }
        if (caughtThis) {
          catches += 1;
          catchesByTemplate[template] = (catchesByTemplate[template] ?? 0) + 1;
        }
        pins.push({
          claim,
          originCommit: c.sha,
          originSubject: c.subject,
          filename: gen.filename,
          replays,
          caughtRegression: caughtThis,
          brokenAtBirth: false,
        });
      }
    }
  } finally {
    try {
      git(repoPath, ["worktree", "remove", "--force", worktreePath]);
    } catch {
      rmSync(worktreePath, { recursive: true, force: true });
    }
    rmSync(pinHolding, { recursive: true, force: true });
  }

  return {
    repo: repoPath,
    mode,
    commitsScanned: commits.length,
    pinsGenerated: pins.length,
    pinsByTemplate,
    brokenAtBirth,
    catches,
    catchesByTemplate,
    notTestableHttp,
    durationMs: Date.now() - startedAt,
    pins,
  };
}

// ---- Historical-pin generator for init --auto ----
//
// Walks the last N fix-shaped commits and emits Claim[] derived from
// the diff-aware detectors. Each candidate is filtered: only kept if
// the signature is STILL present at the current HEAD (i.e. the fix's
// protected thing is genuinely active in the live codebase). Dedupes
// by claim key so the same pattern across multiple fixes only emits
// one pin.
//
// This is what task #20 unlocks: 2-5× more init baseline pins,
// specifically the "missing thing restored by past fix, don't let
// future AI remove it again" class — the high-value pin shape.
export async function collectHistoricalPinsForInit(opts: {
  repoPath: string;
  maxFixCommits?: number;
  headSha?: string;
  // Per-template cap to prevent pin explosion (e.g., from a giant
  // types file with 100+ exports). Default: 5 per template.
  maxPinsPerTemplate?: number;
  // Whether to fire the LLM proposer during the historical pass.
  // Default: false (init stays fast & free). Set true when called from
  // the separate `pinned enrich --llm-past-fixes` command.
  enableLlm?: boolean;
}): Promise<Claim[]> {
  const repoPath = opts.repoPath;
  const maxFixCommits = opts.maxFixCommits ?? 30;
  let headSha = opts.headSha;
  try {
    if (!headSha) headSha = git(repoPath, ["rev-parse", "HEAD"]).trim();
  } catch {
    return [];
  }
  if (!headSha) return [];

  // Walk the recent history, find fix-shaped commits.
  let log: string;
  try {
    log = git(repoPath, [
      "log",
      "--max-count=2000",
      "--pretty=format:%H%x09%s%x09%b%x1e",
    ]);
  } catch {
    return [];
  }
  const commits = log.split("\x1e").map((entry) => {
    const fields = entry.trim().split("\t");
    return {
      sha: fields[0] ?? "",
      subject: fields[1] ?? "",
      body: (fields[2] ?? "").trim(),
    };
  }).filter((c) => c.sha.length === 40);

  const fixCommits = commits
    .filter((c) => FIX_KEYWORD_RE.test(c.subject) || FIX_KEYWORD_RE.test(c.body.split("\n").slice(0, 3).join(" ")))
    .slice(0, maxFixCommits);

  if (fixCommits.length === 0) return [];

  // Parent lookup helper — git's first-parent for each fix.
  const parentOf = (sha: string): string | null => {
    try {
      const out = git(repoPath, ["rev-parse", `${sha}^`]).trim();
      return out.length === 40 ? out : null;
    } catch {
      return null;
    }
  };

  const seenKeys = new Set<string>();
  const allClaims: Claim[] = [];

  // PER-TEMPLATE CAP — addresses the pin explosion observed on
  // quantasyte (213 pins, mostly from client.ts's 100+ type exports)
  // and back-in-play (55 pins, mostly from relative-import-resolves).
  // Each template fires at most N times across the entire historical
  // pass. Preserves real catches (e.g., myhpifinal's 2 toast exports)
  // while killing pathological explosions.
  //
  // Per the launch direction (2026-05-25): pin QUALITY matters more
  // than pin count. ≤5 pins per template keeps the install banner
  // readable and avoids alert fatigue.
  const MAX_PER_TEMPLATE = opts.maxPinsPerTemplate ?? 5;
  // Templates that are inherently per-file-or-route (only one
  // makes sense per repo); cap them harder.
  const SINGLETON_TEMPLATES = new Set(["tsc-clean"]);
  // Templates KNOWN to produce explosions on monorepos / giant
  // type-export files — drop entirely from historical pass for now,
  // per the Tier-3 disable direction. Users with these patterns can
  // still get pins via the live `pinned guard` mode (which sees only
  // the current PR's diff, naturally bounded).
  const HISTORICAL_TIER3_DISABLED = new Set<string>([
    "import-path-resolves",   // explosion on quantasyte's apps/api imports
    "module-export-stable",   // explosion on quantasyte's apps/app/src/api/client.ts (100+ TS type exports)
  ]);
  const perTemplateCount: Record<string, number> = {};

  for (const fc of fixCommits) {
    const parentSha = parentOf(fc.sha);
    if (!parentSha) continue;
    // Run the diff-aware detectors via the same path the bug-fix
    // backtest uses. We pass a dummy worktree (the current repo's
    // working tree) because the current-state detectors get filtered
    // out below by dedup against the main init scan's pins.
    let claims: Claim[];
    try {
      claims = await collectAutoPinClaimsAt(repoPath, {
        repoPath,
        fixSha: fc.sha,
        parentSha,
        commitMessage: fc.subject,
        commitBody: fc.body,
        enableLlm: opts.enableLlm ?? false,
      });
    } catch {
      continue;
    }

    for (const claim of claims) {
      // Drop Tier-3 templates entirely (pin explosion risk).
      if (HISTORICAL_TIER3_DISABLED.has(claim.template)) continue;

      // Per-template cap.
      const tplKey = claim.template;
      const cap = SINGLETON_TEMPLATES.has(tplKey) ? 1 : MAX_PER_TEMPLATE;
      if ((perTemplateCount[tplKey] ?? 0) >= cap) continue;

      // Only keep pins whose signature is STILL present at HEAD.
      // The replayStaticInline returns "pass" when the captured
      // signature/identifier still appears in the file at HEAD.
      // "skip" means the template needs runtime — drop those.
      const verdict = replayStaticInline(claim, repoPath, headSha);
      if (verdict !== "pass") continue;

      // Use the same dedup key as claimKey() to merge cross-fix
      // duplicates (e.g., same `requireAuth()` signature added by
      // multiple fix commits).
      const key = `${claim.template}|${(claim as { staticVerify?: { signature: string } }).staticVerify?.signature ?? JSON.stringify(claim)}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      allClaims.push(claim);
      perTemplateCount[tplKey] = (perTemplateCount[tplKey] ?? 0) + 1;
    }
  }

  return allClaims;
}

// ---- Inline static-mode replay ----
//
// Spawn-free replacement for runVitestAt for static-mode pins (the
// dominant case in bug-fix backtest). Reads file content directly
// via `git show sha:path` and applies the same substring/regex check
// the generated template would have run at runtime — but inline, in
// the same process, with no vitest invocation.
//
// Why this exists: the vitest-spawn approach leaked worker processes
// on the 2026-05-25 sweep (collapsed system memory to <100MB on a
// 16GB machine). Inline replay removes the entire process-spawn
// surface for ~95% of pins.
//
// Returns:
//   "pass" — the static check would have passed at this sha
//   "fail" — the static check would have failed
//   "skip" — the pin's template is not inline-checkable (caller marks skipped)
function replayStaticInline(
  claim: Claim,
  repoPath: string,
  sha: string
): "pass" | "fail" | "skip" {
  // Mirror the template's runtime normalization so verdicts match.
  const norm = (s: string) => s.replace(/\s+/g, "").replace(/,(?=[)\]}])/g, "");
  // Strip line comments to match the diff-aware detector's signature
  // capture (which also strips comments).
  const stripComments = (s: string) =>
    s.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n").replace(/\/\*[\s\S]*?\*\//g, "");

  function readFileAtSha(filePath: string): string | null {
    try {
      return git(repoPath, ["show", `${sha}:${filePath}`]);
    } catch {
      return null;
    }
  }

  const sv = (claim as { staticVerify?: { filePath: string; signature: string } }).staticVerify;
  if (sv) {
    const content = readFileAtSha(sv.filePath);
    if (content === null) return "fail"; // file doesn't exist at this sha → signature absent
    const cleaned = stripComments(content);
    return norm(cleaned).includes(norm(sv.signature)) ? "pass" : "fail";
  }

  // Templates with their own inline check logic (no staticVerify field).
  switch (claim.template) {
    case "url-literal-preserved": {
      const content = readFileAtSha(claim.filePath);
      if (content === null) return "fail";
      return content.includes(claim.urlLiteral) ? "pass" : "fail";
    }
    case "module-export-stable": {
      const content = readFileAtSha(claim.modulePath);
      if (content === null) return "fail";
      const escaped = claim.exportName.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
      const re = new RegExp(
        "\\bexport\\s+(?:default\\s+)?" +
          "(?:" +
          "(?:async\\s+)?function\\s+" + escaped + "\\b" + "|" +
          "class\\s+" + escaped + "\\b" + "|" +
          "(?:const|let|var)\\s+" + escaped + "\\b" + "|" +
          "(?:type|interface|enum)\\s+" + escaped + "\\b" +
          ")"
      );
      const reBracketed = new RegExp(
        "\\bexport\\s*\\{[^}]*\\b" + escaped + "\\b(?:\\s+as\\s+\\w+)?[^}]*\\}"
      );
      const cleaned = stripComments(content);
      return re.test(cleaned) || reBracketed.test(cleaned) ? "pass" : "fail";
    }
    case "react-route-registered": {
      const content = readFileAtSha(claim.routerFilePath);
      if (content === null) return "fail";
      const escaped = claim.routePath.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
      const re = new RegExp("path\\s*[:=]\\s*[\"'`]" + escaped + "[\"'`]");
      return re.test(content) ? "pass" : "fail";
    }
    case "webhook-handler-exists": {
      const content = readFileAtSha(claim.filePath);
      if (content === null) return "fail";
      return norm(stripComments(content)).includes(norm(claim.handlerSignature)) ? "pass" : "fail";
    }
    case "import-path-resolves": {
      const content = readFileAtSha(claim.sourceFilePath);
      if (content === null) return "pass"; // file gone → contract no longer in effect
      const cleaned = stripComments(content);
      const escaped = claim.importPath.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
      const re = new RegExp(
        "(?:import\\s[^;]*from\\s*[\"'`]" + escaped + "[\"'`])|" +
          "(?:require\\(\\s*[\"'`]" + escaped + "[\"'`]\\s*\\))"
      );
      // Without the worktree's node_modules we can't verify resolution,
      // but the import LINE being present is the minimum signal. If
      // the line was removed in a later commit, that's the catch.
      return re.test(cleaned) ? "pass" : "fail";
    }
    case "changed-literal-preserved": {
      const content = readFileAtSha(claim.filePath);
      if (content === null) return "fail";
      return content.includes(claim.newValue) ? "pass" : "fail";
    }
    case "form-submit-error-handling": {
      const content = readFileAtSha(claim.filePath);
      if (content === null) return "fail";
      return norm(stripComments(content)).includes(norm(claim.signature)) ? "pass" : "fail";
    }
    case "config-invariant": {
      const content = readFileAtSha(claim.configPath);
      if (content === null) return "fail";
      return content.includes(claim.expected) ? "pass" : "fail";
    }
    default:
      // Templates that need true runtime execution — tsc-clean, cli-*,
      // library-returns, lockfile-integrity, secret-not-public,
      // package-exports-exist, HTTP templates without staticVerify.
      // We don't spawn vitest for these in bug-fix backtest; mark as
      // skip so they don't false-fire and don't leak processes.
      return "skip";
  }
}

// ---- git helpers ----

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function gitWorktreeCheckout(worktree: string, sha: string): void {
  spawnSync("git", ["checkout", "-q", "--detach", sha], {
    cwd: worktree,
    stdio: "ignore",
  });
}

function filesChanged(repo: string, sha: string): ChangedFile[] {
  let out = "";
  try {
    out = git(repo, ["show", "--name-status", "--pretty=", sha]);
  } catch {
    return [];
  }
  const files: ChangedFile[] = [];
  for (const line of out.split("\n")) {
    const m = /^([AMD])\s+(.+)$/.exec(line.trim());
    if (!m) continue;
    const code = m[1];
    const path = m[2];
    files.push({
      path,
      status: code === "A" ? "added" : code === "D" ? "deleted" : "modified",
    });
  }
  return files;
}

function claimKey(c: Claim): string {
  const slug = claimSlug(c);
  return `${c.template}:${slug}`;
}

// ---- vitest replay ----
//
// Runs vitest against ONE test file in the historical worktree. Returns
// a coarse outcome:
//   "pass"       — test ran and exit 0
//   "fail"       — test ran and exit non-zero (excluding infra failures)
//   "skip"       — test skipped (e.g., PREVIEW_URL gating)
//   "infra-fail" — vitest couldn't be invoked, package missing, etc.
//
// We rely on the test file's PINNED FAILURE / PINNED INFRA FAILURE
// header to distinguish real catches from infra issues — but only the
// templates ship that distinction. CLI / library templates don't have
// preview-gated skips, so the simpler exit-code mapping is sufficient.
function runVitestAt(
  worktree: string,
  testPath: string,
  timeoutMs: number
): "pass" | "fail" | "skip" | "infra-fail" {
  // Copy the test file into the worktree under a tests/pinned subdir
  // (vitest config in the worktree may filter to a specific dir).
  const target = join(worktree, "tests", "pinned-backtest");
  mkdirSync(target, { recursive: true });
  const targetPath = join(target, "current.test.ts");
  try {
    const content = readFileSync(testPath, "utf8");
    writeFileSync(targetPath, content);
  } catch {
    return "infra-fail";
  }
  // Find a usable vitest binary in the worktree.
  let vitestBin: string | null = null;
  for (const candidate of [
    join(worktree, "node_modules", ".bin", "vitest"),
    join(worktree, "..", "node_modules", ".bin", "vitest"),
  ]) {
    if (existsSync(candidate)) {
      vitestBin = candidate;
      break;
    }
  }
  if (!vitestBin) {
    // Try npx with no-install — fast if vitest is in PATH, else infra-fail.
    vitestBin = "npx";
  }
  // Write a minimal vitest config in the worktree that ONLY includes
  // our backtest test file. Otherwise the customer's vitest.config.ts
  // (if present) restricts the include pattern to their src/ tree and
  // our backtest file gets skipped. We write to a sibling path that
  // wouldn't conflict with the customer's config.
  const cfgPath = join(worktree, "tests", "pinned-backtest", "vitest.backtest.config.mjs");
  writeFileSync(
    cfgPath,
    `import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["tests/pinned-backtest/**/*.test.ts"], root: ${JSON.stringify(worktree)}, passWithNoTests: false } });
`
  );
  // Memory cap only — DO NOT add `--pool=forks` /
  // `--poolOptions.forks.singleFork=true` / `--no-file-parallelism`
  // here. Those flags are unrecognized by older vitest versions
  // (notably the 0.x and early-1.x lines several dyad-apps repos
  // still pin), and unrecognized flags cause vitest to bail with an
  // infra-fail before it ever runs the test — which made bug-fix
  // backtest report skip/skip across 5 of 11 repos in the 2026-05-25
  // sweep. NODE_OPTIONS heap cap alone is enough to prevent the
  // Jetsam OOM scenario from re-recurring without breaking customer
  // vitest setups.
  const args = vitestBin === "npx"
    ? ["--no-install", "vitest", "run", "--no-coverage", "--reporter=verbose", "--config", cfgPath, targetPath]
    : ["run", "--no-coverage", "--reporter=verbose", "--config", cfgPath, targetPath];
  const childHeapMb = Number(process.env.PINNEDAI_BACKTEST_HEAP_MB || "1024");
  const r = spawnSync(vitestBin, args, {
    cwd: worktree,
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      // Cap the vitest child's V8 heap. Default is ~4 GB; that's
      // unnecessary for a single-test-file replay and exactly what
      // climbs into Jetsam territory when many spawns overlap.
      NODE_OPTIONS: [
        process.env.NODE_OPTIONS ?? "",
        `--max-old-space-size=${childHeapMb}`,
      ]
        .filter(Boolean)
        .join(" "),
    },
  });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  // PINNEDAI_BACKTEST_DEBUG=1 surfaces every replay's vitest stderr
  // and exit code so we can diagnose silent infra-fails.
  if (process.env.PINNEDAI_BACKTEST_DEBUG === "1") {
    process.stderr.write(
      `[backtest] ${vitestBin} run @ ${worktree} status=${r.status} sig=${r.signal} bytes=${out.length}\n`
    );
    if (out.length > 0 && out.length < 4000) {
      process.stderr.write(`[backtest stdout/stderr]\n${out}\n`);
    }
  }
  // Cleanup
  try { rmSync(target, { recursive: true, force: true }); } catch {}

  if (r.status === null || r.signal === "SIGTERM" || r.signal === "SIGKILL") return "infra-fail";
  if (r.status === 0) {
    if (/\d+\s+skipped/.test(out) && !/\d+\s+passed/.test(out)) return "skip";
    return "pass";
  }
  // Heuristic: distinguish "vitest didn't run" from "test failed"
  const ranTests =
    /Test Files\s+\d/.test(out) || /\d+ (?:passed|failed|skipped)/.test(out);
  if (!ranTests) return "infra-fail";
  return "fail";
}

// Pre-compute file-touch index: one git log call walks the whole
// commit range and returns a map of sha → set of paths touched.
// Used by the per-pin replay filter so we skip commits that can't
// possibly change a given pin's verdict.
async function buildFilesByCommit(
  repoPath: string,
  commits: { sha: string }[]
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (commits.length === 0) return out;
  // `git log --name-status` emits "<sha>\nA\tpath\nM\tpath\nR<score>\told\tnew\n" etc.
  // Use a delimiter we can split on cleanly.
  const range = commits.length === 1
    ? commits[0].sha
    : `${commits[0].sha}^..${commits[commits.length - 1].sha}`;
  let raw: string;
  try {
    raw = git(repoPath, [
      "log",
      range,
      "--name-status",
      "--pretty=format:---PINNED-COMMIT-DELIM---%n%H",
    ]);
  } catch {
    // Some ranges (e.g. when the from-commit is the first in history)
    // fail with `bad revision`. Fall back to per-commit show calls.
    for (const c of commits) {
      out.set(c.sha, new Set(filesChanged(repoPath, c.sha).map((f) => f.path)));
    }
    return out;
  }
  const blocks = raw.split("---PINNED-COMMIT-DELIM---").filter((b) => b.trim());
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim());
    if (lines.length === 0) continue;
    const sha = lines[0].trim();
    const files = new Set<string>();
    for (const line of lines.slice(1)) {
      // Status: A|M|D + tab + path  OR  R<score> + tab + old + tab + new
      const m = /^([AMDR])\S*\t(.+)$/.exec(line);
      if (!m) continue;
      if (m[1] === "R") {
        const parts = m[2].split("\t");
        for (const p of parts) files.add(p);
      } else {
        files.add(m[2]);
      }
    }
    out.set(sha, files);
  }
  return out;
}

// Determine which file paths a pin's verdict depends on. Returns:
//   - string[] of repo-relative paths/globs the pin reads, OR
//   - null when the template has no known coverage (no optimization
//     possible — caller will replay against the full window).
function relevantPathsForClaim(claim: Claim): string[] | null {
  switch (claim.template) {
    case "lockfile-integrity":
      // Pin now also depends on package.json (gating logic) so a
      // package.json-only commit can flip the verdict from FAIL
      // (silent regen) to PASS (legit update).
      return [claim.lockfilePath, "package.json"];
    case "config-invariant":
      return [claim.configPath];
    case "package-exports-exist":
      // The entry file directly. Re-exports through other files are
      // the accepted ~5% miss for the optimization.
      return [claim.modulePath];
    case "library-returns":
      return [claim.modulePath];
    case "secret-not-public":
      // Whole-repo scan; the optimization just requires that a commit
      // touched ANY source/env file that could contain a public-env
      // reference. Broad enough that we keep ~95-98% of catches.
      return [".env", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
    case "cli-exits-zero":
    case "cli-flag-supported":
    case "cli-json-shape":
    case "cli-output-contains":
    case "cli-creates-file": {
      // CLI binary's behavior depends on its source tree. Optimization:
      // scope to commits touching the directory of the binary's entry
      // file. The binary's path comes via claim.route, which we
      // reverse-parse from `<binary> [args]`. Fallback to any source
      // file extension if we can't pinpoint a directory.
      // Honest miss: changes deep in shared utility dirs.
      const binary = claim.route.split(/\s+/)[0] ?? "";
      // Try to resolve binary → package.json bin entry → file path.
      // We don't have repo-context here, so fall back to a broad
      // extension match.
      void binary;
      return [".ts", ".tsx", ".js", ".jsx", ".mjs", "package.json"];
    }
    case "rate-limit":
    case "auth-required":
    case "permission-required":
    case "tier-cap":
    case "idempotent":
    case "returns-status":
      // HTTP templates aren't replayed in backtest at all, but defining
      // a fallback keeps the switch exhaustive.
      return null;
    case "url-literal-preserved":
      return [claim.filePath];
    case "tsc-clean":
      // Repo-wide TS source — any .ts/.tsx change could affect.
      return [".ts", ".tsx", "tsconfig.json"];
    case "module-export-stable":
      return [claim.modulePath];
    case "react-route-registered":
      return [claim.routerFilePath];
    case "webhook-handler-exists":
      return [claim.filePath];
    case "import-path-resolves":
      return [claim.sourceFilePath, "package.json"];
    case "changed-literal-preserved":
      return [claim.filePath];
    case "form-submit-error-handling":
      return [claim.filePath];
    case "page-renders":
    case "validation-rejects-bad":
    case "happy-path-with-side-effect":
    case "journey":
      // Live-HTTP templates — no static-file optimization; replay
      // against full window. Same as other HTTP templates above.
      return null;
  }
}

// Match a touched file against a covered-path entry. Supports:
//   - exact path match ("pnpm-lock.yaml" matches "pnpm-lock.yaml")
//   - extension match (".ts" matches "src/foo.ts")
//   - prefix match for directory coverage ("src/cli/" matches "src/cli/foo.ts")
function pathMatchesCovered(touched: string, covered: string): boolean {
  if (covered.startsWith(".")) {
    // Extension form like ".ts" — match any file ending with it.
    return touched.endsWith(covered);
  }
  if (covered.endsWith("/")) {
    return touched.startsWith(covered);
  }
  return touched === covered;
}

// Install vitest into the historical worktree by symlinking from our
// own pinnedai install. Faster than `npm install` (no network), and
// guarantees a known vitest version across every replay commit
// regardless of what was in the historical lockfile.
async function installBacktestVitest(worktreePath: string): Promise<void> {
  const { existsSync, mkdirSync, symlinkSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  // Walk up from this script to find pinnedai's own node_modules. The
  // built CLI lives at apps/cli/dist/cli.js; vitest is in apps/cli/
  // node_modules. process.argv[1] points at the running cli.js.
  const cliPath = process.argv[1];
  const candidates = [
    resolve(cliPath, "..", "..", "node_modules"),                   // apps/cli/node_modules
    resolve(cliPath, "..", "..", "..", "..", "node_modules"),       // monorepo root node_modules (pnpm workspace)
    resolve(cliPath, "..", "..", "..", "..", "..", "node_modules"), // nested workspace
  ];
  let ourNodeModules: string | null = null;
  for (const c of candidates) {
    if (existsSync(`${c}/vitest`) || existsSync(`${c}/.bin/vitest`)) {
      ourNodeModules = c;
      break;
    }
  }
  if (!ourNodeModules) {
    // No vitest available locally — replays will fall back to npx
    // and likely fail. Surface but don't throw; the caller has
    // explicit infra-fail handling.
    process.stderr.write(
      "pinned backtest: no local vitest found to symlink — replays may fail to run.\n"
    );
    return;
  }
  // Make node_modules/.bin/vitest available in the worktree.
  const wtNm = `${worktreePath}/node_modules`;
  mkdirSync(`${wtNm}/.bin`, { recursive: true });
  try {
    symlinkSync(`${ourNodeModules}/.bin/vitest`, `${wtNm}/.bin/vitest`);
  } catch {
    /* already exists or platform doesn't support */
  }
  // vitest needs to resolve its sibling packages too. Linking the
  // whole node_modules is safest — pnpm-style hoisted layouts may
  // require deep dep resolution.
  try {
    symlinkSync(`${ourNodeModules}/vitest`, `${wtNm}/vitest`);
  } catch {
    /* ignore */
  }
  // Also ensure a package.json exists so vitest's loader doesn't bail.
  // Use a minimal one if the historical commit doesn't have one (rare
  // but possible for very early commits).
  if (!existsSync(`${worktreePath}/package.json`)) {
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(
      `${worktreePath}/package.json`,
      JSON.stringify({ name: "backtest-fixture", type: "module" }, null, 2)
    );
  }
}

// ============================================================
// Bug-fix benchmark
// ============================================================
//
// Mines bug-fix commits, generates auto-pins at each fix, replays
// against the parent commit. The headline metric is "real-catch":
// pin failed at parent AND passed at fix — proves the guard would
// have caught the regression.
//
// Why this is the right shape (vs the forward-replay backtest above):
// random commit sweeps mostly produce noise because most commits
// aren't regressions. Bug-fix commits are the only commits where the
// PARENT is, by definition, the broken state — making the fail-before/
// pass-after test directly meaningful.
//
// What gets pinned: filesystem auto-detectors at the fix state. We
// ignore PR claims (most bug-fix commit subjects are short and don't
// fit the "rate-limits X to N" shape). HTTP templates are counted but
// not testable here (no live server).
export async function runBugFixBenchmark(
  opts: BugFixBenchOptions
): Promise<BugFixReport> {
  const startedAt = Date.now();
  const { repoPath } = opts;
  const fromCommit = opts.fromCommit ?? "";
  const toCommit = opts.toCommit ?? "HEAD";
  const maxFixCommits = opts.maxFixCommits ?? 30;
  // Reserved for v0.2 vitest spawn path; inline static replay doesn't use it.
  void opts.vitestTimeoutMs;

  if (!existsSync(join(repoPath, ".git"))) {
    throw new Error(`Not a git repo: ${repoPath}`);
  }

  // Walk commits newest-first so the cap picks the most recent fixes
  // (most representative of current code patterns).
  const range = fromCommit ? `${fromCommit}..${toCommit}` : toCommit;
  const log = git(
    repoPath,
    ["log", range, "--pretty=format:%H%n%s%n%b%n---PINNED-BACKTEST-DELIM---"]
  );
  const entries = log.split("---PINNED-BACKTEST-DELIM---\n").filter((s) => s.trim());
  const allCommits = entries.map((entry) => {
    const lines = entry.split("\n");
    return {
      sha: lines[0]?.trim() ?? "",
      subject: lines[1]?.trim() ?? "",
      body: lines.slice(2).join("\n").trim(),
    };
  }).filter((c) => c.sha.length === 40);

  // Filter to fix-shaped commits.
  const matched = allCommits.filter((c) =>
    FIX_KEYWORD_RE.test(c.subject) || FIX_KEYWORD_RE.test(c.body.split("\n").slice(0, 3).join(" "))
  );
  const fixCommits = matched.slice(0, maxFixCommits);

  const pinsByTemplate: Record<string, number> = {};
  const realCatchesByTemplate: Record<string, number> = {};
  const fixes: BugFixCommitResult[] = [];
  let pinsGenerated = 0;
  let realCatches = 0;
  let noSignal = 0;
  let brokenAtFix = 0;
  let noParent = 0;
  let notTestableHttp = 0;

  const worktreePath = mkdtempSync(join(tmpdir(), "pinned-bugfix-wt-"));
  try {
    git(repoPath, ["worktree", "add", "--detach", worktreePath, toCommit]);
  } catch (e) {
    rmSync(worktreePath, { recursive: true, force: true });
    throw new Error(`Failed to create worktree at ${worktreePath}: ${(e as Error).message}`);
  }
  await installBacktestVitest(worktreePath);
  const pinHolding = mkdtempSync(join(tmpdir(), "pinned-bugfix-pins-"));

  try {
    for (const fc of fixCommits) {
      const parentSha = parentOf(repoPath, fc.sha);
      const pinResults: BugFixPinResult[] = [];

      // Generate pins from filesystem state at the FIX commit PLUS
      // diff-aware pins that encode what the fix changed (the catches
      // come from those — the whole-repo pins almost never flip
      // between parent and fix on their own).
      gitWorktreeCheckout(worktreePath, fc.sha);
      const claims = await collectAutoPinClaimsAt(worktreePath, {
        repoPath,
        fixSha: fc.sha,
        parentSha: parentSha,
        commitMessage: fc.subject,
        commitBody: fc.body,
      });

      for (const claim of claims) {
        const template = claim.template;
        pinsByTemplate[template] = (pinsByTemplate[template] ?? 0) + 1;
        pinsGenerated += 1;

        // HTTP templates need a live server — skip UNLESS the claim
        // carries a `staticVerify` fingerprint (added by the diff-aware
        // detectors). Static-mode pins read the source file and check
        // for the captured signature, so they can run in backtest
        // without PREVIEW_URL — and that's the whole point: they're
        // how we get real catches on real repos when the original fix
        // didn't ship with HTTP fixtures. Without this carve-out the
        // auth-required pins from `detectAuthChecksInDiff` get
        // discarded immediately.
        const hasStaticVerify = (claim as { staticVerify?: unknown }).staticVerify != null;
        if (
          !hasStaticVerify &&
          (template === "rate-limit" ||
            template === "auth-required" ||
            template === "permission-required" ||
            template === "idempotent" ||
            template === "tier-cap" ||
            template === "returns-status")
        ) {
          notTestableHttp += 1;
          pinResults.push({
            claim,
            filename: "",
            fixVerdict: "skip",
            parentVerdict: "skip",
            classification: "skipped",
          });
          continue;
        }

        const gen = generateTest(claim, { prId: `bugfix-${fc.sha.slice(0, 8)}` });
        // INLINE STATIC REPLAY (no vitest spawn — kills the leak from
        // the 2026-05-25 sweep). For pins with a static-mode check
        // (most templates in bug-fix mode), we read file content via
        // `git show sha:path` and run the same substring/regex check
        // inline. Eliminates ~300ms/spawn × thousands of pins.
        // Vitest is only used as a fallback if the inline replayer
        // returns "skip" (template requires true runtime — tsc-clean,
        // cli-*, library-returns, package-exports-exist, lockfile-integrity,
        // secret-not-public, HTTP without staticVerify). And even there,
        // we now skip those entirely in bug-fix mode rather than spawning.
        const fixVerdict = replayStaticInline(claim, repoPath, fc.sha);
        const testPath = ""; // unused for inline replay; kept for shape compat
        void gen; // generated test file isn't written to disk in inline mode
        void testPath;
        if (fixVerdict === "fail") {
          brokenAtFix += 1;
          pinResults.push({
            claim,
            filename: gen.filename,
            fixVerdict,
            parentVerdict: "skip",
            classification: "broken-at-fix",
          });
          continue;
        }
        if (fixVerdict !== "pass") {
          // "skip" — template requires runtime we won't spawn in bug-fix mode.
          pinResults.push({
            claim,
            filename: gen.filename,
            fixVerdict,
            parentVerdict: "skip",
            classification: "skipped",
          });
          continue;
        }

        // Real test: replay against the parent (buggy) commit.
        if (!parentSha) {
          noParent += 1;
          pinResults.push({
            claim,
            filename: gen.filename,
            fixVerdict,
            parentVerdict: "no-parent",
            classification: "no-parent",
          });
          continue;
        }
        const parentVerdict = replayStaticInline(claim, repoPath, parentSha);
        let classification: BugFixPinResult["classification"];
        let siblings: import("./scanDiff.js").SiblingSuggestion[] | undefined;
        if (parentVerdict === "fail") {
          classification = "real-catch";
          realCatches += 1;
          realCatchesByTemplate[template] = (realCatchesByTemplate[template] ?? 0) + 1;
          // Sibling-bug discovery — runs at the FIX commit (the state
          // where the user's repo is). Only for high-value templates
          // where the "find similar unprotected code" story makes
          // sense; explicitly NOT for lockfile / config / secret /
          // exports / cli (those don't have meaningful siblings).
          gitWorktreeCheckout(worktreePath, fc.sha);
          siblings = await collectSiblings(worktreePath, claim);
        } else if (parentVerdict === "pass") {
          classification = "no-signal";
          noSignal += 1;
        } else {
          // skip / infra-fail at parent — treat as inconclusive.
          classification = "skipped";
        }
        pinResults.push({
          claim,
          filename: gen.filename,
          fixVerdict,
          parentVerdict,
          classification,
          siblings,
        });
      }

      fixes.push({
        fixCommit: fc.sha,
        parentCommit: parentSha,
        subject: fc.subject,
        body: fc.body,
        pins: pinResults,
      });
    }
  } finally {
    try {
      git(repoPath, ["worktree", "remove", "--force", worktreePath]);
    } catch {
      rmSync(worktreePath, { recursive: true, force: true });
    }
    rmSync(pinHolding, { recursive: true, force: true });
  }

  return {
    repo: repoPath,
    commitsScanned: allCommits.length,
    fixCommitsMatched: matched.length,
    fixCommitsEvaluated: fixCommits.length,
    pinsGenerated,
    pinsByTemplate,
    realCatches,
    realCatchesByTemplate,
    noSignal,
    brokenAtFix,
    noParent,
    notTestableHttp,
    durationMs: Date.now() - startedAt,
    fixes,
  };
}

// Returns the first-parent commit sha, or null if `sha` is the
// initial commit (no parent).
function parentOf(repo: string, sha: string): string | null {
  try {
    const out = git(repo, ["rev-parse", `${sha}^`]).trim();
    return out.length === 40 ? out : null;
  } catch {
    return null;
  }
}

// Collect every auto-pin-able claim from a worktree's current state.
// Mirrors the detector set in `pinned init --auto`. Keeping this in
// one place so the bug-fix benchmark stays representative of what
// the shipping product would actually pin.
//
// When `bugFixContext` is supplied, ALSO runs diff-aware detectors
// that look at what THIS commit added vs. its parent — letting us
// generate pins that encode the fix's actual behavioral contract
// (not just whole-repo snapshot pins). These are the ones that
// produce real-catches when replayed against the parent commit.
async function collectAutoPinClaimsAt(
  worktree: string,
  bugFixContext?: {
    repoPath: string;
    fixSha: string;
    parentSha: string | null;
    // Commit message + body — passed to the LLM proposer so it can
    // factor the developer's stated intent into candidate generation.
    // Optional; the LLM works on diff-only when missing, just less
    // contextually rich.
    commitMessage?: string;
    commitBody?: string;
    // Whether to fire the LLM proposer (BYOK). Default: true. Init's
    // historical pass passes `false` to keep init fast (LLM mode adds
    // ~3-5 min per repo). The separate `pinned enrich --llm` command
    // passes `true` to opt into the slower, more thorough analysis.
    enableLlm?: boolean;
  }
): Promise<Claim[]> {
  const claims: Claim[] = [];
  const {
    detectCliLibraryPins,
    detectLockfilePins,
    detectConfigInvariantPins,
    detectPackageExportsPins,
    detectSecretNotPublicPins,
    detectAuthChecksInDiff,
    detectValidationAddedInDiff,
    detectClientFetchAuthInDiff,
    detectClientErrorHandlingAddedInDiff,
    detectIdempotencyAddedInDiff,
    detectRateLimitAddedInDiff,
    detectPermissionAddedInDiff,
    detectUrlLiteralAddedInDiff,
    detectTscCleanAddedInDiff,
    detectModuleExportAddedInDiff,
    detectReactRouteAddedInDiff,
    detectWebhookHandlerAddedInDiff,
    detectImportPathAddedInDiff,
    detectChangedLiteralInDiff,
    detectFormSubmitErrorHandlingInDiff,
  } = await import("./scanDiff.js");
  for (const cli of detectCliLibraryPins(worktree)) {
    if (cli.template !== "cli-exits-zero") continue;
    claims.push({
      template: "cli-exits-zero",
      route: `${cli.identifier} --help`,
      raw: cli.suggestedPin,
    });
  }
  for (const lock of detectLockfilePins(worktree)) {
    claims.push({
      template: "lockfile-integrity",
      lockfilePath: lock.lockfilePath,
      expectedSha256: lock.expectedSha256,
      packageJsonSha256: lock.packageJsonSha256,
      raw: lock.suggestedPin,
    });
  }
  for (const cfg of detectConfigInvariantPins(worktree)) {
    claims.push({
      template: "config-invariant",
      configPath: cfg.configPath,
      expected: cfg.expected,
      label: cfg.label,
      raw: cfg.suggestedPin,
    });
  }
  for (const exp of detectPackageExportsPins(worktree)) {
    claims.push({
      template: "package-exports-exist",
      modulePath: exp.modulePath,
      exports: exp.exports,
      raw: exp.suggestedPin,
    });
  }
  for (const sec of detectSecretNotPublicPins(worktree)) {
    claims.push({
      template: "secret-not-public",
      publicPrefix: sec.publicPrefix,
      secretMarkers: sec.secretMarkers,
      raw: sec.suggestedPin,
    });
  }

  // Diff-aware: pins that encode what the fix actually added.
  // Bug-fix mode passes the context; production `pinned init --auto`
  // does not, so this branch is bug-fix-benchmark-only for now.
  // Eventually the same detector can run in `pinned guard` against
  // the current branch's diff to produce live "PR added auth → pin
  // it" suggestions.
  if (bugFixContext && bugFixContext.parentSha) {
    const diff = readAddedLinesByFile(
      bugFixContext.repoPath,
      bugFixContext.fixSha,
      bugFixContext.parentSha
    );
    for (const hit of detectAuthChecksInDiff(diff)) {
      claims.push({
        template: "auth-required",
        route: hit.route,
        raw: hit.suggestedPin,
        staticVerify: {
          filePath: hit.filePath,
          signature: hit.signature,
        },
      });
    }
    for (const hit of detectValidationAddedInDiff(diff)) {
      claims.push({
        template: "returns-status",
        route: hit.route,
        method: hit.method,
        status: 400,
        raw: hit.suggestedPin,
        staticVerify: {
          filePath: hit.filePath,
          signature: hit.signature,
        },
      });
    }
    // Client-side fetch correctness — same shape as the server
    // auth-required detector but targeting client API wrappers
    // (apps/app/src/api/*.ts, src/lib/fetcher.ts, etc.). Generates
    // auth-required pins with a client:* route synthesizer.
    for (const hit of detectClientFetchAuthInDiff(diff, bugFixContext.repoPath)) {
      claims.push({
        template: "auth-required",
        route: hit.route,
        raw: hit.suggestedPin,
        staticVerify: {
          filePath: hit.filePath,
          signature: hit.signature,
        },
      });
    }
    // Client-side error-handling preservation — catches "AI stripped
    // the if (!res.ok) / try-catch / .catch handler" regressions.
    // Same template + static-mode replay; client-err:* route synth.
    for (const hit of detectClientErrorHandlingAddedInDiff(diff, bugFixContext.repoPath)) {
      claims.push({
        template: "auth-required",
        route: hit.route,
        raw: hit.suggestedPin,
        staticVerify: {
          filePath: hit.filePath,
          signature: hit.signature,
        },
      });
    }
    // Idempotency-added — webhook/mutation fixes that wire a dedupe
    // lookup against a payload field (event_id / idempotency-key /
    // signature). Tight FP guard: requires BOTH a known field name
    // AND a lookup verb.
    for (const hit of detectIdempotencyAddedInDiff(diff)) {
      claims.push({
        template: "idempotent",
        route: hit.route,
        idField: hit.idField,
        raw: hit.suggestedPin,
        staticVerify: {
          filePath: hit.filePath,
          signature: hit.signature,
        },
      });
    }
    // Rate-limit-added — fixes that wire a limiter (express-rate-limit /
    // upstash / rate-limiter-flexible / 429-response shape). Library-
    // named patterns dominate; bare `429` literals require a full-line
    // length guard so lint reformat can't manufacture matches.
    for (const hit of detectRateLimitAddedInDiff(diff)) {
      claims.push({
        template: "rate-limit",
        route: hit.route,
        rate: hit.rate,
        window: hit.window,
        raw: hit.suggestedPin,
        staticVerify: {
          filePath: hit.filePath,
          signature: hit.signature,
        },
      });
    }
    // Permission/ownership-added — authorization decisions (does THIS
    // user have the right on THIS resource), distinct from auth. Skipped
    // when the same diff already matches auth-required (auth dominates).
    for (const hit of detectPermissionAddedInDiff(diff)) {
      claims.push({
        template: "permission-required",
        route: hit.route,
        role: "authenticated",
        raw: hit.suggestedPin,
        staticVerify: {
          filePath: hit.filePath,
          signature: hit.signature,
        },
      });
    }

    // Phase 1+2 (2026-05-25): six added-line detectors targeting the
    // dyad-apps fix classes from the audit (url literals, TS-clean,
    // exports, react routes, webhooks, imports). Each is conservative
    // by design — FP-safety bar matches the existing detectors.
    for (const hit of detectUrlLiteralAddedInDiff(diff)) {
      claims.push({
        template: "url-literal-preserved",
        filePath: hit.filePath,
        urlLiteral: hit.urlLiteral,
        label: hit.label,
        raw: hit.suggestedPin,
      });
    }
    for (const hit of detectTscCleanAddedInDiff(diff, bugFixContext.repoPath)) {
      claims.push({
        template: "tsc-clean",
        tsconfigPath: hit.tsconfigPath,
        raw: hit.suggestedPin,
      });
    }
    for (const hit of detectModuleExportAddedInDiff(diff)) {
      // FILE-EXISTED-AT-PARENT GATE: only emit module-export-stable
      // when the FILE was present at the parent commit. Catches the
      // "missing export restored" class (high value). Skips the
      // "brand-new file added in this commit" class (weak value —
      // future AI rarely deletes brand-new code it just added; also
      // creates pin explosion). Per the 2026-05-25 audit where 13/14
      // back-in-play "real catches" were all on new files.
      if (bugFixContext.parentSha) {
        try {
          execFileSync("git", ["cat-file", "-e", `${bugFixContext.parentSha}:${hit.modulePath}`], {
            cwd: bugFixContext.repoPath,
            stdio: "ignore",
          });
        } catch {
          continue; // file did not exist at parent — skip
        }
      }
      claims.push({
        template: "module-export-stable",
        modulePath: hit.modulePath,
        exportName: hit.exportName,
        raw: hit.suggestedPin,
      });
    }
    for (const hit of detectReactRouteAddedInDiff(diff)) {
      claims.push({
        template: "react-route-registered",
        routerFilePath: hit.routerFilePath,
        routePath: hit.routePath,
        raw: hit.suggestedPin,
      });
    }
    for (const hit of detectWebhookHandlerAddedInDiff(diff)) {
      claims.push({
        template: "webhook-handler-exists",
        filePath: hit.filePath,
        handlerSignature: hit.handlerSignature,
        provider: hit.provider,
        raw: hit.suggestedPin,
      });
    }
    // Tier-3 import-path-resolves: per the 2026-05-25 sweep FP audit,
    // this template's catches are mechanically real but low-value-per-pin
    // (every new relative import triggers one). It's already gated out
    // of init's historical pass via HISTORICAL_TIER3_DISABLED; gate it
    // here too so the bug-fix backtest doesn't produce inflated numbers
    // for the proof page. The detector still runs (so the test surface
    // stays exercised) — we just don't emit the claims.
    const SUPPRESS_TIER3 = process.env.PINNEDAI_INCLUDE_TIER3 !== "1";
    if (!SUPPRESS_TIER3) {
      for (const hit of detectImportPathAddedInDiff(diff)) {
        claims.push({
          template: "import-path-resolves",
          sourceFilePath: hit.sourceFilePath,
          importPath: hit.importPath,
          raw: hit.suggestedPin,
        });
      }
    }

    // Changed-value mode — the critical new addition per GPT review.
    // Pairs removed+added literals in the same hunk to catch URL
    // typos, status code corrections, env-key renames. Uses the
    // hunk-aware diff shape (readDiffByFile), distinct from the
    // added-only map the other detectors consume.
    const hunkDiff = readDiffByFile(
      bugFixContext.repoPath,
      bugFixContext.fixSha,
      bugFixContext.parentSha
    );
    for (const hit of detectChangedLiteralInDiff(hunkDiff)) {
      claims.push({
        template: "changed-literal-preserved",
        filePath: hit.filePath,
        oldValue: hit.oldValue,
        newValue: hit.newValue,
        shape: hit.shape,
        raw: hit.suggestedPin,
      });
    }

    // Form-submit error-handling — Phase 2 UI/flow pack. Fires when a
    // fix adds a <form> element with an onSubmit handler wrapped in
    // try/catch or .catch. FP-safe: requires BOTH a form element AND
    // an error-handling shape in the same added lines.
    for (const hit of detectFormSubmitErrorHandlingInDiff(diff)) {
      claims.push({
        template: "form-submit-error-handling",
        filePath: hit.filePath,
        signature: hit.signature,
        raw: hit.suggestedPin,
      });
    }

    // LLM-as-proposer (BYOK only for v1; OIDC Worker is post-launch
    // wiring per [[three-mode-llm-architecture]]). Catches commits
    // whose fixes use custom-named helpers the regex pattern set
    // doesn't enumerate. Signature-verification guardrail ensures
    // the LLM can't hallucinate code that isn't in the diff.
    //
    // Fires AFTER the regex detectors, so dedup-by-(template,
    // filePath, signature) keeps the LLM from re-proposing what
    // regex already found. Gated by PINNEDAI_BYOK env — silent
    // no-op otherwise. Per-commit cost: ~3000 input tokens ≈ $0.004
    // Haiku / $0.015 Sonnet / $0.0007 gpt-4o-mini.
    try {
      // Skip the LLM proposer when explicitly disabled (e.g. init's
      // historical pass passes enableLlm: false to keep init fast).
      // Default behavior preserved: bug-fix backtest + the future
      // `pinned enrich --llm-past-fixes` command both call with
      // enableLlm: true (or undefined, which defaults to true).
      if (bugFixContext.enableLlm === false) {
        // intentional no-op
      } else {
      const { proposeBugFixCandidates } = await import("./llmBugFixPropose.js");
      const llmResult = await proposeBugFixCandidates({
        commitMessage: bugFixContext.commitMessage ?? "",
        commitBody: bugFixContext.commitBody,
        diffByFile: diff,
      });
      if (llmResult.ok && llmResult.candidates.length > 0) {
        // Dedup signature against what the regex detectors already
        // emitted — `${template}|${filePath}|${signature}` as the key.
        const seenSigKey = new Set<string>();
        for (const c of claims) {
          const sv = (c as { staticVerify?: { filePath: string; signature: string } }).staticVerify;
          if (!sv) continue;
          seenSigKey.add(`${c.template}|${sv.filePath}|${sv.signature}`);
        }
        for (const cand of llmResult.candidates) {
          const key = `${cand.template}|${cand.filePath}|${cand.signature}`;
          if (seenSigKey.has(key)) continue;
          seenSigKey.add(key);
          if (cand.template === "auth-required") {
            claims.push({
              template: "auth-required",
              route: cand.route ?? cand.filePath,
              raw: cand.badCase ?? `[llm] auth required (added in this fix)`,
              staticVerify: {
                filePath: cand.filePath,
                signature: cand.signature,
              },
            });
          } else if (cand.template === "returns-status") {
            claims.push({
              template: "returns-status",
              route: cand.route ?? cand.filePath,
              method: cand.method ?? "POST",
              status: 400,
              raw: cand.badCase ?? `[llm] validation added in this fix`,
              staticVerify: {
                filePath: cand.filePath,
                signature: cand.signature,
              },
            });
          } else if (cand.template === "idempotent") {
            claims.push({
              template: "idempotent",
              route: cand.route ?? cand.filePath,
              idField: cand.idField ?? "event_id",
              raw: cand.badCase ?? `[llm] idempotency check added in this fix`,
              staticVerify: {
                filePath: cand.filePath,
                signature: cand.signature,
              },
            });
          } else if (cand.template === "rate-limit") {
            claims.push({
              template: "rate-limit",
              route: cand.route ?? cand.filePath,
              rate: cand.rate ?? 60,
              window: "minute",
              raw: cand.badCase ?? `[llm] rate limit added in this fix`,
              staticVerify: {
                filePath: cand.filePath,
                signature: cand.signature,
              },
            });
          } else if (cand.template === "permission-required") {
            claims.push({
              template: "permission-required",
              route: cand.route ?? cand.filePath,
              role: "authenticated",
              raw: cand.badCase ?? `[llm] authorization check added in this fix`,
              staticVerify: {
                filePath: cand.filePath,
                signature: cand.signature,
              },
            });
          } else if (cand.template === "url-literal-preserved" && cand.urlLiteral) {
            claims.push({
              template: "url-literal-preserved",
              filePath: cand.filePath,
              urlLiteral: cand.urlLiteral,
              label: cand.urlLiteral.split("/").filter(Boolean).pop() ?? cand.urlLiteral,
              raw: cand.badCase ?? `[llm] URL ${cand.urlLiteral} preserved in this fix`,
            });
          } else if (cand.template === "module-export-stable" && cand.exportName) {
            claims.push({
              template: "module-export-stable",
              modulePath: cand.filePath,
              exportName: cand.exportName,
              raw: cand.badCase ?? `[llm] ${cand.filePath} exports ${cand.exportName}`,
            });
          } else if (cand.template === "react-route-registered" && cand.routePath) {
            claims.push({
              template: "react-route-registered",
              routerFilePath: cand.routerFilePath ?? cand.filePath,
              routePath: cand.routePath,
              raw: cand.badCase ?? `[llm] route ${cand.routePath} registered`,
            });
          } else if (cand.template === "webhook-handler-exists" && cand.handlerSignature) {
            claims.push({
              template: "webhook-handler-exists",
              filePath: cand.filePath,
              handlerSignature: cand.handlerSignature,
              provider: cand.provider ?? "generic",
              raw: cand.badCase ?? `[llm] ${cand.provider ?? "generic"} webhook handler at ${cand.filePath}`,
            });
          } else if (cand.template === "import-path-resolves" && cand.importPath) {
            claims.push({
              template: "import-path-resolves",
              sourceFilePath: cand.sourceFilePath ?? cand.filePath,
              importPath: cand.importPath,
              raw: cand.badCase ?? `[llm] import ${cand.importPath} keeps resolving`,
            });
          } else if (cand.template === "changed-literal-preserved" && cand.oldValue && cand.newValue && cand.literalShape) {
            claims.push({
              template: "changed-literal-preserved",
              filePath: cand.filePath,
              oldValue: cand.oldValue,
              newValue: cand.newValue,
              shape: cand.literalShape,
              raw: cand.badCase ?? `[llm] ${cand.literalShape}: ${cand.oldValue} → ${cand.newValue}`,
            });
          }
        }
      }
      } // close: else { for enableLlm !== false
    } catch {
      // LLM call failed — silent no-op. Regex detectors already
      // produced everything they could. Don't let LLM problems
      // break the benchmark.
    }
  }

  // Dedup
  const seen = new Set<string>();
  return claims.filter((c) => {
    const k = `${c.template}:${claimSlug(c)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// After a real-catch, find sibling files in the same repo that
// PROBABLY need the same protection but don't have it. Returns at
// most SIBLING_CAP_HIGH + SIBLING_CAP_MEDIUM suggestions (see
// scanDiff.ts). High-confidence ones are what the live `pinned guard`
// path would auto-pin in observe mode; medium are bulk-accept
// candidates. The benchmark just SURFACES them — no auto-pinning
// happens in this read-only flow.
async function collectSiblings(
  repoPath: string,
  claim: Claim
): Promise<import("./scanDiff.js").SiblingSuggestion[] | undefined> {
  const { findUnprotectedSiblings, AUTH_CHECK_PATTERNS } = await import("./scanDiff.js");
  if (claim.template === "auth-required") {
    const sv = (claim as { staticVerify?: { filePath: string } }).staticVerify;
    const triggerFile = sv?.filePath;
    if (!triggerFile) return undefined;
    return findUnprotectedSiblings({
      repoPath,
      patterns: AUTH_CHECK_PATTERNS,
      triggerFilePath: triggerFile,
      triggerRoute: claim.route,
      category: "auth",
    });
  }
  if (claim.template === "returns-status") {
    // For returns-status we look for OTHER route files that don't
    // have ANY validation pattern. The category-specific pattern set
    // for siblings is the union of schema-library calls + plain-TS
    // (reply.code(400)) — same as DIFF_VALIDATION_PATTERNS internal
    // to scanDiff. Re-using AUTH_CHECK_PATTERNS would be wrong (we'd
    // skip files that have auth but no validation, when validation
    // is the actual gap). We pass a focused set via an inline regex
    // array to keep the call site clear.
    const validationPatterns: RegExp[] = [
      /\bz\.object\s*\(/,
      /\.parseAsync\s*\(/,
      /\.safeParse(?:Async)?\s*\(/,
      /\byup\.object\s*\(/,
      /\bvalidate\s*\([^)]*req\.body/,
      /\bschema\.parse\s*\(/,
      /\b(?:reply|res)\.(?:code|status)\s*\(\s*400\b/,
    ];
    const sv = (claim as { staticVerify?: { filePath: string } }).staticVerify;
    const triggerFile = sv?.filePath;
    if (!triggerFile) return undefined;
    return findUnprotectedSiblings({
      repoPath,
      patterns: validationPatterns,
      triggerFilePath: triggerFile,
      triggerRoute: claim.route,
      category: "validation",
    });
  }
  // Other templates (lockfile / config / secret / exports / cli) don't
  // have meaningful siblings. Return undefined so the report omits
  // the section entirely.
  return undefined;
}

// Read the full structured diff between sha and parentSha. Returns a
// per-file shape that exposes BOTH added and removed lines, broken
// down by hunk so changed-value detectors can pair removed+added
// within the same hunk. The legacy `readAddedLinesByFile` is now a
// thin adapter on top.
//
// Why per-hunk: paired removed/added detection (URL typo, status code
// correction, env key rename) is only safe within a hunk — two
// unrelated edits in different parts of the file shouldn't be paired.
// Without hunk grouping, "removed /api/foo + added /api/bar" might
// pair the wrong removal with the wrong addition.
export type DiffHunk = { added: string[]; removed: string[] };
export type DiffFile = { added: string[]; removed: string[]; hunks: DiffHunk[] };

export function readDiffByFile(
  repo: string,
  sha: string,
  parentSha: string
): Map<string, DiffFile> {
  const out = new Map<string, DiffFile>();
  let raw: string;
  try {
    raw = git(repo, [
      "diff",
      "--unified=0",
      "--no-color",
      "--no-prefix",
      "--diff-filter=ACMR",
      `${parentSha}..${sha}`,
    ]);
  } catch {
    return out;
  }
  let currentFile: string | null = null;
  let currentHunk: DiffHunk | null = null;
  const flushHunk = () => {
    if (!currentFile || !currentHunk) return;
    if (currentHunk.added.length === 0 && currentHunk.removed.length === 0) {
      currentHunk = null;
      return;
    }
    const file = out.get(currentFile);
    if (file) file.hunks.push(currentHunk);
    currentHunk = null;
  };
  for (const line of raw.split("\n")) {
    const diffH = /^diff --git (\S+) (\S+)$/.exec(line);
    if (diffH) {
      flushHunk();
      currentFile = diffH[2];
      if (!out.has(currentFile)) {
        out.set(currentFile, { added: [], removed: [], hunks: [] });
      }
      continue;
    }
    if (!currentFile) continue;
    if (line.startsWith("@@")) {
      flushHunk();
      currentHunk = { added: [], removed: [] };
      continue;
    }
    if (line.startsWith("---") || line.startsWith("+++") ||
        line.startsWith("index ") || line.startsWith("new file mode") ||
        line.startsWith("deleted file mode") || line.startsWith("similarity index") ||
        line.startsWith("rename from") || line.startsWith("rename to") ||
        line.startsWith("Binary files")) {
      continue;
    }
    if (line.startsWith("+")) {
      const added = line.slice(1);
      const file = out.get(currentFile)!;
      file.added.push(added);
      if (currentHunk) currentHunk.added.push(added);
    } else if (line.startsWith("-")) {
      const removed = line.slice(1);
      const file = out.get(currentFile)!;
      file.removed.push(removed);
      if (currentHunk) currentHunk.removed.push(removed);
    }
  }
  flushHunk();
  // Prune files with no actual content (header-only diffs we tracked
  // but never accumulated lines for).
  for (const [path, dfile] of out.entries()) {
    if (dfile.added.length === 0 && dfile.removed.length === 0) out.delete(path);
  }
  return out;
}

// Legacy added-lines-only view — thin adapter over readDiffByFile so
// the existing detectors keep working unchanged.
function readAddedLinesByFile(
  repo: string,
  sha: string,
  parentSha: string
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [filePath, dfile] of readDiffByFile(repo, sha, parentSha).entries()) {
    if (dfile.added.length > 0) out.set(filePath, dfile.added);
  }
  return out;
}
