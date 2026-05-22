// Statusline + chat-failure-hook content.
//
// Statusline:        always-on visibility. Cached + cheap git-state.
//                    Layer-1 only: reads cache + git rev-parse + diff.
//                    Never calls Worker/LLM/vitest.
// Failure-only hook: emits text ONLY when a pinned test is failing.
//                    Emits NOTHING when green — keeps chat clean.
//
// State priority (highest → lowest):
//   1. ✗ N broken              (broken pin — fix now)
//   2. caught N break          (transient: just caught a regression; ~30min decay)
//   3. ⚠ N risks               (unpinned risk surfaces)
//   4. ⚠ N notes               (Safety Pass warnings)
//   5. +N pin just added       (transient: auto-protect just added; ~10min decay)
//   6. +N suggested            (ask-mode: pending suggestions)
//   7. check pending           (drifted AND last check > 10min old; cyan/blue — opt-in via config.show_pending_changes)
//   8. ✓ / N changes queued   (calm-green; "N changes queued" if uncommitted, plain ✓ if clean. Wall-clock age was removed in v0.1.1 because sitting away from the laptop doesn't decay verification.)
//   9. ?                       (no cache yet, never tested)
//   0. 0 pins                  (registry empty)
//
// Why the transient states (caught / just-added) appear ABOVE the
// background ⚠/+N suggested signals: they're event moments that the
// user just-now created or just-now experienced. Burying them under
// "you have 2 unprotected routes" would dilute the dopamine of the
// catch and the satisfaction of the auto-pin add.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync as childSpawnSync } from "node:child_process";
import { findTouchedPins } from "./scanDiff.js";
import type { ChangedFile, TouchedPin } from "./scanDiff.js";
import type { RegistryEntry } from "./registry.js";

export type LastStatus = {
  status: "green" | "failing";
  failingCount: number;
  failingClaimIds: string[];
  totalPins: number;
  unpinnedRisks?: number;
  safetyNotes?: number;
  // Number of pins that SKIPPED in the last `pinned test` run because
  // PREVIEW_URL was unreachable / unset. Surface as `⊘ N skipped (no
  // preview)` in the statusline so users know protection is OFF and
  // why — without this, a "✓ N pins" reading conflates verified pass
  // with silently-skipped pass.
  skippedCount?: number;
  // Working-tree snapshot at the time of the last check. The
  // statusline compares CURRENT git state against these to detect
  // "changes pending" — files have changed since the cache was
  // written, so the cached green/red status is informational only.
  lastCheckedSha?: string;
  lastCheckedDirtyHash?: string;
  updatedAt: string;
  // ----- Auto-protect surfaces -----
  // Set by `pinned auto-protect` (and `watch` when mode=safe).
  // Decays after RECENTLY_ADDED_TTL_MS so the statusline returns to a
  // calm green state once the user has had time to notice.
  recentlyAddedCount?: number;
  recentlyAddedAt?: string; // ISO timestamp of last auto-add batch
  // Set by `pinned auto-protect` when mode=ask, or by the classifier
  // when it finds candidates that need human confirmation.
  // Persistent (no decay) — survives until `pinned protect` consumes
  // them or the classifier re-runs and finds zero.
  suggestedCount?: number;
  // ----- Add-celebration "shown" flag -----
  // Stamped by the hook when it has emitted the "added N pins" line.
  // Compared against recentlyAddedAt: hook emits only when
  // recentlyAddedAt > lastAddNotifiedAt (i.e. we have a fresh add we
  // haven't told the AI about yet). One injection per add-event.
  lastAddNotifiedAt?: string;
  // Throttle stamp for chat-hook auto-protect kicks. The chat hook
  // (UserPromptSubmit) fires on every chat turn; we only want to
  // trigger background auto-protect once per CHAT_HOOK_AUTO_PROTECT_TTL_MS
  // (60s) to avoid runaway runs during fast back-and-forth.
  lastAutoProtectAt?: string;
  // ----- Lifetime safety findings (small catches) -----
  // Counts the total Safety Pass findings raised since install.
  // Surfaced in `pinned status` so the bug-fix engine's contribution
  // is visible even when current findings are 0. Incremented each
  // time Safety Pass detects something new (deduped by file:line).
  safetyFindingsLifetime?: number;
  // ----- Verification streak (primary positive metric) -----
  // checksRun:        total number of `pinned test` invocations that
  //                   produced a status (green or failing). Lifetime.
  // verifiedStreak:   consecutive green runs since the last failure.
  //                   Resets to 0 when status flips to "failing".
  // lastVerifiedAt:   ISO timestamp of the most recent green run.
  // These are the metrics that make silence read as reliability rather
  // than absence. A user who hasn't caught any regressions still sees
  // "47 consecutive successful runs over 23 days" — uptime, not
  // emptiness.
  checksRun?: number;
  verifiedStreak?: number;
  lastVerifiedAt?: string;
  // ----- "Caught a break" lifetime tracking (kept; surfaced only when > 0) -----
  // Incremented when a previously-passing pin starts failing. Tracks
  // the moments where Pinned demonstrably caught a regression.
  // Lifetime — never decays. Surfaced in `pinned status`.
  breaksCaught?: number;
  // Most recent catch — drives the transient "caught N break"
  // statusline state (decays after RECENTLY_CAUGHT_TTL_MS).
  lastCatchAt?: string;
  lastCatchClaimId?: string;
  // Rolling history of catches. Cap CATCH_HISTORY_LIMIT entries
  // (newest first). Used by `pinned status` and `pinned catches` to
  // show what regressions were caught and when.
  catchHistory?: CatchRecord[];
};

// One regression catch event.
export type CatchRecord = {
  caughtAt: string;
  claimId: string;
  claimText?: string; // raw text from the registry (the original claim)
  template?: string;
  route?: string;
  // Plain-English description of what was caught — pulled from the
  // pin's registry entry at catch time so CATCHES.md and chat-hook
  // celebrations speak in human terms ("a Free user with 1 watched
  // domain adds a 2nd") rather than test-name jargon. Optional for
  // backward compat with pre-v0.1 cache entries.
  badCase?: string;
  // The PR this pin was originally extracted from. Lets CATCHES.md
  // and chat-hook show "originally pinned in PR #42" links so the
  // catch story has provenance.
  originPr?: string;
  // True when the original pin was extracted from a bug-fix PR.
  // CATCHES.md highlights these — they're the most narratively
  // satisfying catches ("Pinned re-caught a regression that was
  // fixed once already").
  bugFixOrigin?: boolean;
};

export const CATCH_HISTORY_LIMIT = 50;

// Auto-protect surface decay windows. Kept short so the statusline
// returns to the stable "✓ N pins" baseline quickly — the celebration
// is meant to be noticed, not lived in.
export const RECENTLY_ADDED_TTL_MS = 2 * 60 * 1000; // 2 minutes
export const RECENTLY_CAUGHT_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Chat-hook auto-protect throttle. The UserPromptSubmit hook fires
// on every chat turn — we only kick a background auto-protect once
// per this interval to avoid runaway during fast back-and-forth.
// Cost is zero (no LLM), but disk/CPU is non-zero — and the
// statusline celebration already has its own 2-min decay, so firing
// more often than that doesn't even produce additional visible signal.
export const CHAT_HOOK_AUTO_PROTECT_TTL_MS = 60 * 1000; // 60 seconds

// "check pending" only surfaces after this much elapsed since the last
// check, AND only when the working tree has drifted from the cache.
// Combined gate prevents the statusline from showing "check pending"
// during normal active editing.
export const PENDING_STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

const STATUS_FILENAME = ".last-status.json";

// ANSI color codes — terminals + Claude Code statusline honor these.
// Kept minimal: one color per state, not the whole line.
const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

export function readLastStatus(dir: string): LastStatus | null {
  const path = join(dir, STATUS_FILENAME);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LastStatus;
  } catch {
    return null;
  }
}

export function writeLastStatus(dir: string, status: LastStatus): void {
  const path = join(dir, STATUS_FILENAME);
  writeFileSync(path, JSON.stringify(status, null, 2) + "\n");
}

// Count CHANGED FILES partitioned into:
//   total       — every uncommitted file (git status --porcelain rows)
//   relevant    — subset that matches Pinned's detection patterns
//                 (Next.js routes, webhooks, middleware, env files,
//                 CLI source containing Commander patterns, etc.)
//   touched     — pins whose protected behavior this diff intersects
//                 (route match via deriveRouteFromPath OR file match
//                 via covers.files). Empty when activePins is omitted.
//
// Used by the statusline. We deliberately do NOT show raw uncommitted
// counts — that would turn Pinned into a git-hygiene nag. We show:
//   touched.length > 0 → "N protected behavior touched" (strongest signal)
//   relevant > 0       → "N to review"                  (Pinned-relevant edits)
//   total > 0          → "active editing"               (general editing)
//   else               → "✓"                            (clean tree)
export function countRelevantChanges(
  cwd: string = process.cwd(),
  opts?: { activePins?: RegistryEntry[] }
): {
  total: number;
  relevant: number;
  hasHighRisk: boolean;
  touchedPins: TouchedPin[];
} | null {
  const result = childSpawnSync(
    "git",
    // --untracked-files=all expands untracked directories into their
    // individual files (otherwise we get "app/" not "app/api/admin/
    // export/route.ts" and the pattern matcher misses everything).
    ["status", "--porcelain", "--untracked-files=all"],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 8 * 1024 * 1024,
    }
  );
  if (result.status !== 0) return null;
  const lines = (result.stdout || "")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  const total = lines.length;
  let relevant = 0;
  let hasHighRisk = false;
  // Build ChangedFile[] in parallel so we can intersect with pins.
  // Porcelain status codes are mapped coarsely: 'D' → deleted,
  // '?' / 'A' / 'AM' → added, everything else → modified. The
  // intersection only cares about presence in the diff, not the
  // exact mutation, so this is sufficient for findTouchedPins.
  const changedFiles: ChangedFile[] = [];
  for (const line of lines) {
    // Porcelain format: "XY path" — first 3 chars are status codes.
    const path = line.slice(3).trim().split(" -> ").pop() ?? "";
    if (isPinnedRelevantPath(path)) relevant += 1;
    if (isHighRiskPath(path)) hasHighRisk = true;
    const code = line.slice(0, 2);
    const status: ChangedFile["status"] = /D/.test(code)
      ? "deleted"
      : /^(?:\?\?|A.|.A)/.test(code)
        ? "added"
        : "modified";
    if (path) changedFiles.push({ path, status });
  }
  const activePins = (opts?.activePins ?? []).filter(
    (p) => p.status === "active"
  );
  const touchedPins =
    activePins.length > 0
      ? findTouchedPins({
          changedFiles,
          prBodyClaims: [],
          existingPins: activePins,
        })
      : [];
  return { total, relevant, hasHighRisk, touchedPins };
}

// "High-risk" — paths so likely to need pinning that we trigger an
// immediate background auto-protect run regardless of how many other
// changes are pending. The threshold-of-N (default 10) is bypassed
// for these. Subset of isPinnedRelevantPath.
export function isHighRiskPath(path: string): boolean {
  // Admin/internal routes — auth removal is the #1 AI regression.
  if (/\/api\/admin\//.test(path) || /\/api\/internal\//.test(path)) return true;
  // Webhook handlers — idempotency and signature verification surfaces.
  if (/webhook/i.test(path) && /\.(?:ts|tsx|js|jsx|py|rb|go)$/.test(path)) return true;
  // Auth middleware — sweeping behavior change.
  if (/(?:^|\/)middleware\.(?:ts|tsx|js|jsx)$/.test(path)) return true;
  // Env file changes — new required secrets / config flips.
  if (/(?:^|\/)\.env(?:\.[\w.-]+)?$/.test(path)) return true;
  return false;
}

// Path patterns Pinned cares about — should mirror scanDiff + autoProtect.
// "Caring about" = the classifier might propose a pin from this file.
function isPinnedRelevantPath(path: string): boolean {
  // Skip our own working artifacts
  if (path.startsWith("tests/pinned/")) return false;
  if (path.startsWith(".pinnedai/")) return false;
  if (path.startsWith("node_modules/")) return false;
  if (path.startsWith("dist/") || path.startsWith("build/")) return false;
  if (path === "package-lock.json" || path === "pnpm-lock.yaml" || path === "yarn.lock") return false;

  // Skip noise: docs, styles, configs that don't drive behavior
  if (/\.(?:md|css|scss|sass|less|svg|png|jpg|gif|webp|ico|woff2?)$/i.test(path)) return false;

  // Pinned-relevant patterns
  if (/^(?:src\/)?app\/api\/.+\/route\.(?:ts|tsx|js|jsx)$/.test(path)) return true;     // Next.js App Router
  if (/^(?:src\/)?pages\/api\/.+\.(?:ts|tsx|js|jsx)$/.test(path)) return true;          // Next.js Pages Router
  if (/^(?:src\/)?routes\/.+\.(?:ts|tsx|js|jsx)$/.test(path)) return true;              // Express / Fastify / Hono
  if (/^(?:src\/)?(?:handlers|controllers|api)\/.+\.(?:ts|js)$/.test(path)) return true;
  if (/webhook/i.test(path) && /\.(?:ts|tsx|js|jsx|py|rb|go)$/.test(path)) return true; // webhook handlers
  if (/(?:^|\/)middleware\.(?:ts|tsx|js|jsx)$/.test(path)) return true;                  // auth middleware
  if (/(?:^|\/)\.env(?:\.[\w.-]+)?$/.test(path)) return true;                            // env files
  // CLI source files — likely to contain new Commander commands/options
  if (/(?:^|\/)cli\.(?:ts|js)$/.test(path)) return true;
  if (/^(?:src|apps\/cli\/src)\/.+\.ts$/.test(path)) return false; // generic src — not Pinned-relevant by default

  return false;
}

// Capture the current git state — used by writers to record the
// working-tree snapshot at check-time so the statusline can detect
// drift later. Layer-1: cheap, no LLM, no vitest.
export function captureGitState(cwd: string = process.cwd()): {
  sha: string | null;
  dirtyHash: string | null;
} {
  const shaResult = childSpawnSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const sha = shaResult.status === 0 ? shaResult.stdout.trim() : null;

  const diffResult = childSpawnSync("git", ["diff", "HEAD"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 32 * 1024 * 1024,
  });
  const dirtyHash =
    diffResult.status === 0
      ? createHash("sha256").update(diffResult.stdout).digest("hex").slice(0, 16)
      : null;

  return { sha, dirtyHash };
}

// Short, persistent indicator for the Claude Code statusline.
// Targets ≤ ~40 chars. Color only on the status indicator.
export function formatStatusline(opts: {
  totalPins: number;
  lastStatus: LastStatus | null;
  cwd?: string;
  // Set to false to disable ANSI colors (tests, dumb terminals).
  color?: boolean;
  // Current auto-protect mode. Controls whether `+N suggested` surfaces.
  // `off` mode never shows suggestion counts even if the cache holds them.
  mode?: "safe" | "ask" | "off";
  // Override "now" for tests. Defaults to Date.now().
  now?: number;
  // If false, suppress the "changes pending" branch. Users without
  // `pinned watch` running will see this state most of the time; some
  // prefer to hide it and fall through to the cached green/red status.
  showPendingChanges?: boolean;
  // If false, suppress the "N to review" / "active editing" surfacing
  // in the calm-green state — falls through to plain ✓ regardless of
  // pending edits. Default true. Config: show_review_count.
  showReviewCount?: boolean;
  // "all" (default) shows every state; "minimal" returns empty string
  // for calm states (✓ / N to review / active editing / check pending)
  // so the statusline disappears unless something actionable happens.
  // VS Code extension treats empty output as "hide the item"; Claude
  // Code renders nothing for an empty line.
  statuslineMode?: "all" | "minimal";
  // Active pins (status === "active") for the diff-intersection state
  // — "N protected behavior touched". When omitted, that state never
  // fires and the statusline falls through to the existing precedence.
  // The CLI's `statusline` command always passes this; tests omit it
  // to exercise the non-touched code paths in isolation.
  activePins?: RegistryEntry[];
}): string {
  const { totalPins, lastStatus } = opts;
  const useColor = opts.color !== false;
  const mode = opts.mode ?? "safe";
  const now = opts.now ?? Date.now();
  const c = useColor
    ? C
    : { reset: "", dim: "", green: "", yellow: "", red: "", cyan: "" };

  const minimal = opts.statuslineMode === "minimal";
  const prefix = `${c.dim}◆ pinned${c.reset}`;
  if (totalPins === 0) {
    // Calm "0 pins" state — hide in minimal mode.
    return minimal ? "" : `${prefix} · 0 pins`;
  }
  if (!lastStatus) {
    // No cache → "?" — calm. Hide in minimal mode.
    return minimal ? "" : `${prefix} · ${totalPins} pins · ${c.yellow}?${c.reset}`;
  }

  // 1. Broken pin — highest priority. Require count > 0 so we never
  // display "✗ 0 broken" (red signal with zero count = confusing UX).
  if (lastStatus.status === "failing" && lastStatus.failingCount > 0) {
    return `${prefix} · ${totalPins} pins · ${c.red}✗ ${lastStatus.failingCount} broken${c.reset}`;
  }
  // 2. "Caught N break" — transient celebration when a regression was
  // recently caught. Decays after RECENTLY_CAUGHT_TTL_MS. Wording per
  // GPT guidance: "caught", not "saves" — concrete + dev-friendly.
  if (lastStatus.lastCatchAt) {
    const age = now - new Date(lastStatus.lastCatchAt).getTime();
    if (Number.isFinite(age) && age >= 0 && age < RECENTLY_CAUGHT_TTL_MS) {
      return `${prefix} · ${totalPins} pins · ${c.green}🛟 caught 1 break${c.reset}`;
    }
  }
  // 2.5. Protected behavior touched — diff-intersection alert. This
  // is the Guardrail positioning's load-bearing surface: when Claude/
  // Cursor edits a file already guarded by a Pinned pin, surface that
  // amber state above generic "unpinned risks" warnings. Strongest
  // urgency next to broken/caught: existing protected behavior is on
  // the line. Computed inline from git status + the active pin set,
  // so it reflects the LIVE working tree, not the cached status.
  const checkCwd = opts.cwd ?? process.cwd();
  if (opts.activePins && opts.activePins.length > 0) {
    const cachedChanges = countRelevantChanges(checkCwd, {
      activePins: opts.activePins,
    });
    if (cachedChanges !== null && cachedChanges.touchedPins.length > 0) {
      const n = cachedChanges.touchedPins.length;
      return `${prefix} · ${totalPins} pins · ${c.yellow}REVIEW · ${n} touched${c.reset}`;
    }
  }
  // 2.75. Skipped pins — when the last `pinned test` run had pins
  // that couldn't actually verify (no PREVIEW_URL / preview down /
  // missing module file), surface that LOUDLY instead of silently
  // showing ✓. Users need to know protection is OFF, not assume
  // green = verified. Cyan (informational, not warning red).
  if (typeof lastStatus.skippedCount === "number" && lastStatus.skippedCount > 0) {
    // The "(no preview)" hint points at the docs without bloating the
    // statusline. Users who see this run `pinned doctor` for the full
    // explanation + a link to pinnedai.dev/docs/preview-url.
    return `${prefix} · ${totalPins} pins · ${c.cyan}⊘ ${lastStatus.skippedCount} skipped (no preview)${c.reset}`;
  }
  // 3. Unpinned risks
  if (typeof lastStatus.unpinnedRisks === "number" && lastStatus.unpinnedRisks > 0) {
    return `${prefix} · ${totalPins} pins · ${c.yellow}⚠ ${lastStatus.unpinnedRisks} risks${c.reset}`;
  }
  // 4. Safety notes
  if (typeof lastStatus.safetyNotes === "number" && lastStatus.safetyNotes > 0) {
    return `${prefix} · ${totalPins} pins · ${c.yellow}⚠ ${lastStatus.safetyNotes} notes${c.reset}`;
  }
  // 5. Recently added — transient celebration of auto-protect work.
  // Decays after RECENTLY_ADDED_TTL_MS. Format: "+N pins · M total"
  // (per the launch UX spec — shows both the delta AND the new total
  // so the growth feels concrete).
  if (
    typeof lastStatus.recentlyAddedCount === "number" &&
    lastStatus.recentlyAddedCount > 0 &&
    lastStatus.recentlyAddedAt
  ) {
    const age = now - new Date(lastStatus.recentlyAddedAt).getTime();
    if (Number.isFinite(age) && age >= 0 && age < RECENTLY_ADDED_TTL_MS) {
      const n = lastStatus.recentlyAddedCount;
      // Single transient prefix replaces the standard "N pins ·" prefix
      // for the duration of the celebration.
      const label = `${c.green}+${n} pin${n === 1 ? "" : "s"}${c.reset} · ${totalPins} total`;
      return `${prefix} · ${label}`;
    }
  }
  // 6. Suggested pins — surfaced ONLY in ask mode. In safe mode, the
  // classifier would have auto-added the obvious ones, so the ask
  // counter wouldn't be material. In off mode, suppress entirely.
  if (
    mode === "ask" &&
    typeof lastStatus.suggestedCount === "number" &&
    lastStatus.suggestedCount > 0
  ) {
    return `${prefix} · ${totalPins} pins · ${c.yellow}+${lastStatus.suggestedCount} suggested${c.reset}`;
  }
  // 7. Check pending — the user has drifted from the last check AND
  // the last check is genuinely stale. We require BOTH conditions so
  // normal active editing (which constantly flips drift on) doesn't
  // produce a persistent indicator. Only fires when:
  //   - showPendingChanges is true (default false — user opt-in), AND
  //   - working tree differs from cache, AND
  //   - last check is > PENDING_STALE_THRESHOLD_MS old.
  // Cyan/blue — informational, not a warning.
  const showPending = opts.showPendingChanges === true;
  if (showPending && (lastStatus.lastCheckedSha || lastStatus.lastCheckedDirtyHash)) {
    const lastCheckAge = now - new Date(lastStatus.updatedAt).getTime();
    if (Number.isFinite(lastCheckAge) && lastCheckAge >= PENDING_STALE_THRESHOLD_MS) {
      const { sha, dirtyHash } = captureGitState(checkCwd);
      const shaDrifted =
        !!sha && !!lastStatus.lastCheckedSha && sha !== lastStatus.lastCheckedSha;
      const dirtyDrifted =
        !!dirtyHash &&
        !!lastStatus.lastCheckedDirtyHash &&
        dirtyHash !== lastStatus.lastCheckedDirtyHash;
      if (shaDrifted || dirtyDrifted) {
        return `${prefix} · ${totalPins} pins · ${c.cyan}check pending${c.reset}`;
      }
    }
  }
  // 8. Calm-green state. Shape: `✓ N verified` when there's a
  // verified-streak counter, plain `✓` otherwise.
  //
  // Why include verifiedStreak: a plain `✓` looks dead after the
  // first few minutes — users glance, see no change, assume the
  // tool isn't running. verifiedStreak ticks up after every
  // post-commit `pinned test` run (so it grows during normal
  // coding), resets only on a real catch. That gives a "alive"
  // signal without resorting to passive nag counts ("N to review")
  // or git-hygiene noise ("active editing").
  //
  // No streak (first install, or no test runs yet) → plain `✓`,
  // since "✓ 0 verified" would read as a warning rather than calm.
  //
  // statuslineMode: "minimal" still suppresses the ✓ entirely.
  if (minimal) return "";
  const streak = lastStatus.verifiedStreak ?? 0;
  if (streak > 0) {
    return `${prefix} · ${totalPins} pins · ${c.green}✓ ${streak} verified${c.reset}`;
  }
  return `${prefix} · ${totalPins} pins · ${c.green}✓${c.reset}`;
}

// Chat-injection content. Three outcomes, in priority order:
//
//   1. status === "failing" → failure message (existing behavior)
//   2. fresh add we haven't notified about yet (recentlyAddedAt
//      within RECENTLY_ADDED_TTL_MS AND > lastAddNotifiedAt)
//      → one-shot celebration message
//   3. otherwise → empty string (no chat pollution)
//
// Failure trumps celebration: if a pin is broken, the user shouldn't
// see "🎉 added 2 pins" sitting on top of "✗ regression caught."
//
// The caller is responsible for stamping lastAddNotifiedAt back to the
// cache after emitting the celebration (so we don't re-emit on next
// invocation). The pure function below returns the text + an optional
// stamp-update via formatChatHook(); formatFailureHook() is kept as a
// back-compat alias that returns only the text (no stamp).
export type ChatHookResult = {
  text: string;
  // If non-null, the caller should write this value to
  // lastAddNotifiedAt in the cache so the next invocation suppresses
  // the celebration.
  stampAddNotifiedAt: string | null;
};

export function formatChatHook(
  lastStatus: LastStatus | null,
  now: number = Date.now()
): ChatHookResult {
  // 1. Failure trumps everything.
  if (lastStatus && lastStatus.status === "failing" && lastStatus.failingCount > 0) {
    return {
      text: failureMessage(lastStatus),
      stampAddNotifiedAt: null,
    };
  }
  // 2. Fresh add we haven't notified about yet.
  if (
    lastStatus &&
    typeof lastStatus.recentlyAddedCount === "number" &&
    lastStatus.recentlyAddedCount > 0 &&
    lastStatus.recentlyAddedAt
  ) {
    const addedAt = new Date(lastStatus.recentlyAddedAt).getTime();
    const age = now - addedAt;
    const notifiedAt = lastStatus.lastAddNotifiedAt
      ? new Date(lastStatus.lastAddNotifiedAt).getTime()
      : -Infinity;
    if (Number.isFinite(age) && age >= 0 && age < RECENTLY_ADDED_TTL_MS && addedAt > notifiedAt) {
      return {
        text: addCelebrationMessage(lastStatus.recentlyAddedCount),
        stampAddNotifiedAt: lastStatus.recentlyAddedAt,
      };
    }
  }
  // 3. Nothing to say.
  return { text: "", stampAddNotifiedAt: null };
}

// Back-compat — the existing CLI command uses formatFailureHook and the
// downstream `.claude/settings.json` references hook-failure. We keep
// the function name + behavior but expand the content path.
export function formatFailureHook(lastStatus: LastStatus | null): string {
  return formatChatHook(lastStatus).text;
}

function addCelebrationMessage(n: number): string {
  // One-line, factual. AI agents read this and weave it into their
  // response. Avoid emoji-heavy or hype-y wording — feels less honest.
  return [
    `Pinned auto-pinned ${n} new behavior${n === 1 ? "" : "s"}.`,
    ``,
    `Future commits that break these contracts will fail CI with a back-reference to this PR.`,
    `Run \`pinned catches\` to see what's been protected; \`pinned list --verbose\` for full detail.`,
  ].join("\n");
}

function failureMessage(lastStatus: LastStatus): string {
  const n = lastStatus.failingCount;
  const totalCaught = lastStatus.breaksCaught ?? 0;
  // Pull the most recent catch records that match the currently-failing
  // claim IDs so we can speak in human terms ("Without Pinned, this
  // would have shipped: <bad_case>"). Falls back gracefully when the
  // history is empty (pre-v0.1 cache) or doesn't have bad_case yet.
  const failingSet = new Set(lastStatus.failingClaimIds);
  const recentCatchesForFailing =
    (lastStatus.catchHistory ?? []).filter((c) => failingSet.has(c.claimId));

  const lines: string[] = [
    `🛟 Pinned caught a regression — ${n} protected behavior${n === 1 ? " is" : "s are"} failing.`,
  ];

  // Human-readable "what was caught" line for each failing pin.
  // This is the load-bearing UX line — the user (and the AI agent
  // reading this hook) sees concrete impact, not a test-name list.
  for (const c of recentCatchesForFailing.slice(0, 3)) {
    if (c.badCase) {
      const prSuffix = c.originPr ? ` (originally pinned in ${c.originPr})` : "";
      lines.push(``);
      lines.push(`  Without Pinned, this would have shipped: ${c.badCase}${prSuffix}`);
    }
  }

  lines.push(``);
  lines.push(`Before continuing this task:`);
  lines.push(`  1. Inspect the failing pinned test${n === 1 ? "" : "s"}:`);
  for (const id of lastStatus.failingClaimIds.slice(0, 5)) {
    lines.push(`     - tests/pinned/${id}.test.ts`);
  }
  if (lastStatus.failingClaimIds.length > 5) {
    lines.push(`     - …and ${lastStatus.failingClaimIds.length - 5} more`);
  }
  lines.push(``);
  lines.push(`  2. Fix the application code first. The pinned test failure means a`);
  lines.push(`     contract from an earlier PR has been regressed. Pinned catches are`);
  lines.push(`     double-confirmed — if a failure looks unrelated to your change,`);
  lines.push(`     re-run \`npx vitest run <file>\` once before changing code.`);
  lines.push(``);
  lines.push(`  3. Do NOT delete or weaken any test in tests/pinned/ unless the user`);
  lines.push(`     explicitly asks to retire the pin.`);
  lines.push(``);
  if (totalCaught > 0) {
    lines.push(`  See tests/pinned/CATCHES.md for the running ledger (Pinned has caught ${totalCaught} regression${totalCaught === 1 ? "" : "s"} in this repo).`);
    lines.push(``);
  }
  lines.push(`  Run \`pnpm pinned:test\` to re-verify after fixing.`);
  return lines.join("\n");
}

