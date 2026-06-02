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
  // Short list of human-readable summaries of the most recent pin
  // additions — e.g. ["auth required on /api/admin/scans",
  // "stripe webhook idempotency", "lockfile integrity"]. Used by the
  // statusline transient celebration + chat-hook add-message so users
  // SEE what was protected, not just a count. Capped at 5 entries by
  // the writer; the renderer further truncates for terminal width.
  recentlyAddedSummaries?: string[];
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
  // ----- AI Lessons surface (post-2026-05-23 pivot) -----
  // lessonsLifetime: total entries currently in .pinned/ai-lessons.md.
  //                  Used in the calm-green baseline display
  //                  ("PASS · N guards · M lessons") so the AI memory
  //                  surface is always visible to the user.
  // lastLessonAt:    ISO timestamp of the most recent lesson append.
  //                  Drives the transient "LEARNED · <summary>" state.
  // lastLessonSummary: plain-English summary of the most recent
  //                  lesson (from LessonInput.plainEnglish). Shown
  //                  in the statusline for LEARNED_WINDOW_MS after
  //                  the append.
  lessonsLifetime?: number;
  lastLessonAt?: string;
  lastLessonSummary?: string;
  // ----- BLOCK event (Guard Integrity violation refused) -----
  lastBlockAt?: string;
  lastBlockSummary?: string;
  blocksLifetime?: number;
  // ----- AUDIT event (pinned audit --learned ran) -----
  lastAuditAt?: string;
  lastAuditCount?: number;
  auditsLifetime?: number;
  // ----- SAVED event (auto-protect added new pins) -----
  lastSavedAt?: string;
  lastSavedCount?: number;
  lastSavedSummaries?: string[];
  guardsSavedLifetime?: number;
  // ----- COVERED event (vitest pin suite passed) -----
  lastCoveredAt?: string;
  lastCoveredCount?: number;
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
  // Layman-friendly catch description — derived deterministically
  // from the claim shape at record-time via deriveCatchImpact(). All
  // three fields are optional for backward compat with cache
  // entries written before the impact translator existed. See
  // `apps/cli/src/catchImpact.ts` for the mapping rules.
  severity?: "critical" | "high" | "medium" | "low" | "info";
  // 3-6 word title for the layman-friendly catch listing ("Admin
  // dashboard auth check" instead of "auth required on * (middleware)
  // (added in this fix)").
  laymanHeadline?: string;
  // 1-2 sentence plain-English consequence: "Without this protection,
  // ..." — designed for the non-developer founder reading their
  // statusline / dashboard, not the dev reading the test file.
  userImpact?: string;
};

export const CATCH_HISTORY_LIMIT = 50;

// Multi-line "Pinned added N protections" celebration TTL — the
// expanded bullet view collapses back to a one-line steady state
// after this window. 3 minutes balances "long enough to notice on a
// casual glance" with "doesn't dominate the statusline as static
// info." Single-line fallback shows under the same window when no
// summaries are available.
export const RECENTLY_ADDED_TTL_MS = 3 * 60 * 1000; // 3 minutes
// Catch-event decay (per GPT spec + user request). Tiered:
//   - 0-24h:  prominent, emphasized in statusline ("VERIFIED · N catches today")
//   - 24-72h: subtle, shown as historical context ("last catch 2d ago")
//   - >72h:   hidden from statusline (still visible in catchHistory / proof log)
// The goal: catches are event badges, not the permanent status. Coverage
// (N guards) is the permanent value signal so a quiet week doesn't make
// users think "why am I paying?" They see "PASS · 34 guards" baseline.
export const CATCH_PROMINENT_WINDOW_MS = 24 * 60 * 60 * 1000;  // 24h
export const CATCH_SUBTLE_WINDOW_MS = 72 * 60 * 60 * 1000;     // 72h
// Back-compat alias — keep referencing this from older code paths.
// The catch-celebration branch in formatStatusline now uses the
// prominent window directly.
export const RECENTLY_CAUGHT_TTL_MS = CATCH_PROMINENT_WINDOW_MS;

// LEARNED transient — how long the "Pinned · LEARNED · <summary>" line
// stays prominent in the statusline after a lesson is added. After
// this window, the baseline shows "PASS · N guards · M lessons" with
// the lessons count as the persistent signal. Per the
// [[strategic-pivot-guard-integrity]] statusline UX rule.
export const LEARNED_WINDOW_MS = 2 * 60 * 1000; // 2 minutes
export const BLOCK_WINDOW_MS = 2 * 60 * 1000; // 2 minutes
export const SAVED_WINDOW_MS = 90 * 1000; // 90 seconds
export const COVERED_WINDOW_MS = 60 * 1000; // 60 seconds
export const AUDIT_WINDOW_MS = 90 * 1000; // 90 seconds

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

// Record catches from a bug-fix benchmark run into the target repo's
// status cache so its statusline reflects "Pinned just caught N
// regressions in this repo." Idempotent: dedupes by claimId so
// re-running the benchmark doesn't double-count.
//
// `dir` is typically `<targetRepo>/tests/pinned/` — same location
// readLastStatus/writeLastStatus operate on. If the dir doesn't
// exist (target repo never installed Pinned), this is a no-op. The
// caller decides whether to create the dir or skip.
export type BenchmarkCatchInput = {
  claimId: string;
  claimText?: string;
  template?: string;
  route?: string;
  badCase?: string;
  // The fix commit sha this catch was learned from. Recorded as
  // originPr in CatchRecord since the benchmark works on commits,
  // not PRs — using "commit:<sha>" prefix for clarity.
  fixSha?: string;
  // Optional pre-computed layman impact fields. When supplied, they
  // get stored in CatchRecord; otherwise we leave them undefined and
  // the renderer falls back to the technical description. Caller
  // (cli.ts bug-fix mode) populates these via deriveCatchImpact().
  severity?: "critical" | "high" | "medium" | "low" | "info";
  laymanHeadline?: string;
  userImpact?: string;
};

// Record a SAVED event — auto-protect just added N new pins to the
// registry. Drives the transient "Pinned · SAVED · N guard(s)
// created" statusline display. Mirrors the existing
// recentlyAddedSummaries surface but uses the unified event-naming
// the strategic pivot statusline UX section locks in.
export function recordGuardsSaved(
  dir: string,
  saved: { count: number; summaries?: string[] }
): void {
  if (!existsSync(dir)) return;
  const existing = readLastStatus(dir) ?? {
    status: "green" as const,
    failingCount: 0,
    failingClaimIds: [],
    totalPins: 0,
    updatedAt: new Date().toISOString(),
  };
  const next: LastStatus = {
    ...existing,
    lastSavedAt: new Date().toISOString(),
    lastSavedCount: saved.count,
    lastSavedSummaries: saved.summaries?.slice(0, 5),
    guardsSavedLifetime: (existing.guardsSavedLifetime ?? 0) + saved.count,
    updatedAt: new Date().toISOString(),
  };
  try {
    writeFileSync(join(dir, STATUS_FILENAME), JSON.stringify(next, null, 2));
  } catch { /* */ }
}

// Record a COVERED event — vitest just ran the pinned suite and
// N guards passed. Drives transient
// "Pinned · COVERED · N guards passed" statusline display.
// Distinct from VERIFIED (which is the running streak counter).
export function recordCoveredRun(
  dir: string,
  covered: { passedCount: number }
): void {
  if (!existsSync(dir)) return;
  const existing = readLastStatus(dir) ?? {
    status: "green" as const,
    failingCount: 0,
    failingClaimIds: [],
    totalPins: 0,
    updatedAt: new Date().toISOString(),
  };
  const next: LastStatus = {
    ...existing,
    lastCoveredAt: new Date().toISOString(),
    lastCoveredCount: covered.passedCount,
    updatedAt: new Date().toISOString(),
  };
  try {
    writeFileSync(join(dir, STATUS_FILENAME), JSON.stringify(next, null, 2));
  } catch { /* */ }
}

// Record an AUDIT event — "pinned audit --learned" ran and looked
// at N candidate sibling files. Drives transient
// "Pinned · AUDIT · N sibling risks checked" display.
export function recordSiblingAudit(
  dir: string,
  audit: { count: number }
): void {
  if (!existsSync(dir)) return;
  const existing = readLastStatus(dir) ?? {
    status: "green" as const,
    failingCount: 0,
    failingClaimIds: [],
    totalPins: 0,
    updatedAt: new Date().toISOString(),
  };
  const next: LastStatus = {
    ...existing,
    lastAuditAt: new Date().toISOString(),
    lastAuditCount: audit.count,
    auditsLifetime: (existing.auditsLifetime ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  };
  try {
    writeFileSync(join(dir, STATUS_FILENAME), JSON.stringify(next, null, 2));
  } catch { /* */ }
}

// Record a BLOCK event in the status cache. Called by
// check-guard-removal (and any other guard-integrity refusal path)
// before exiting non-zero, so the statusline shows
// "Pinned · BLOCK · <evidence>" for ~2 min — visible AHA moment
// per [[tier-model-final-2026-05-23]].
export function recordGuardBlocked(
  dir: string,
  block: { summary: string }
): void {
  if (!existsSync(dir)) return;
  const existing = readLastStatus(dir) ?? {
    status: "green" as const,
    failingCount: 0,
    failingClaimIds: [],
    totalPins: 0,
    updatedAt: new Date().toISOString(),
  };
  const next: LastStatus = {
    ...existing,
    lastBlockAt: new Date().toISOString(),
    lastBlockSummary: block.summary,
    blocksLifetime: (existing.blocksLifetime ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  };
  try {
    writeFileSync(join(dir, STATUS_FILENAME), JSON.stringify(next, null, 2));
  } catch {
    /* best-effort */
  }
}

// Record a LEARNED event in the status cache. Called by the AI
// Lessons writer (aiLessons.appendLesson) after a successful append,
// so the statusline shows "Pinned · LEARNED · <summary>" for the
// next LEARNED_WINDOW_MS. Also bumps the lifetime count used by the
// calm-green baseline display.
//
// Per [[tier-model-final-2026-05-23]]: the plain-English summary is
// the load-bearing UX — don't show "1 new lesson", show what was
// actually learned.
export function recordLessonLearned(
  dir: string,
  lesson: { plainEnglish: string; totalCount?: number }
): void {
  if (!existsSync(dir)) return;
  const existing = readLastStatus(dir) ?? {
    status: "green" as const,
    failingCount: 0,
    failingClaimIds: [],
    totalPins: 0,
    updatedAt: new Date().toISOString(),
  };
  const next: LastStatus = {
    ...existing,
    lastLessonAt: new Date().toISOString(),
    lastLessonSummary: lesson.plainEnglish,
    lessonsLifetime: lesson.totalCount ?? (existing.lessonsLifetime ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  };
  try {
    writeFileSync(join(dir, STATUS_FILENAME), JSON.stringify(next, null, 2));
  } catch {
    /* best-effort — don't break the lesson append on cache write failure */
  }
}

export function recordBenchmarkCatches(
  dir: string,
  catches: BenchmarkCatchInput[]
): { recorded: number; skipped: number } {
  if (catches.length === 0) return { recorded: 0, skipped: 0 };
  if (!existsSync(dir)) return { recorded: 0, skipped: 0 };
  const existing = readLastStatus(dir) ?? {
    status: "green" as const,
    failingCount: 0,
    failingClaimIds: [],
    totalPins: 0,
    updatedAt: new Date().toISOString(),
  };
  const now = new Date().toISOString();
  const history = existing.catchHistory ?? [];
  const knownIds = new Set(history.map((r) => r.claimId));
  let recorded = 0;
  let skipped = 0;
  for (const c of catches) {
    if (knownIds.has(c.claimId)) {
      skipped += 1;
      continue;
    }
    history.unshift({
      caughtAt: now,
      claimId: c.claimId,
      claimText: c.claimText,
      template: c.template,
      route: c.route,
      badCase: c.badCase,
      originPr: c.fixSha ? `commit:${c.fixSha.slice(0, 8)}` : undefined,
      bugFixOrigin: true,
      severity: c.severity,
      laymanHeadline: c.laymanHeadline,
      userImpact: c.userImpact,
    });
    knownIds.add(c.claimId);
    recorded += 1;
  }
  // Cap history. Newest first.
  const trimmed = history.slice(0, CATCH_HISTORY_LIMIT);
  const updated: LastStatus = {
    ...existing,
    catchHistory: trimmed,
    breaksCaught: (existing.breaksCaught ?? 0) + recorded,
    lastCatchAt: recorded > 0 ? now : existing.lastCatchAt,
    lastCatchClaimId: recorded > 0 ? catches[0].claimId : existing.lastCatchClaimId,
    updatedAt: now,
  };
  writeLastStatus(dir, updated);
  return { recorded, skipped };
}

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
    // Even with no active pins, recent catches (from a bug-fix
    // benchmark recording, or from a guard run that hasn't created
    // pins yet) deserve surfacing — that's the "Pinned just caught
    // something" event the statusline exists to celebrate. Falls
    // through to the catch-tier branch logic below.
    if (lastStatus?.lastCatchAt) {
      const age = (opts.now ?? Date.now()) - new Date(lastStatus.lastCatchAt).getTime();
      if (Number.isFinite(age) && age >= 0 && age < CATCH_PROMINENT_WINDOW_MS) {
        const cutoff = (opts.now ?? Date.now()) - CATCH_PROMINENT_WINDOW_MS;
        const recentCount = (lastStatus.catchHistory ?? []).filter((r) => {
          const t = new Date(r.caughtAt).getTime();
          return Number.isFinite(t) && t >= cutoff;
        }).length || 1;
        const noun = recentCount === 1 ? "catch" : "catches";
        return `${prefix} · ${c.green}★ ${recentCount} ${noun} today${c.reset}`;
      }
    }
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
  // 2. "Caught N break" — tiered celebration:
  //    0-24h:  ★ caught N today (prominent green)
  //    24-72h: last catch Nd ago (subtle, falls through to calm-green
  //            with appended footer rather than being the headline)
  //    >72h:   hidden — calm-green baseline only ("PASS · N guards")
  //
  // The 24h window counts catches from catchHistory (deduped by
  // claim/time) so multiple recent catches show "★ caught 3 today"
  // instead of "caught 1 break" which buried the magnitude.
  // 1.4. Fresh BLOCK — transient line for 2 min after Guard Integrity
  // refused a commit. Most urgent value event after broken pins.
  // Per [[strategic-pivot-guard-integrity]] this is the headline catch.
  if (lastStatus.lastBlockAt && lastStatus.lastBlockSummary) {
    const blockAge = now - new Date(lastStatus.lastBlockAt).getTime();
    if (Number.isFinite(blockAge) && blockAge >= 0 && blockAge < BLOCK_WINDOW_MS) {
      const truncated = lastStatus.lastBlockSummary.length > 50
        ? lastStatus.lastBlockSummary.slice(0, 47) + "..."
        : lastStatus.lastBlockSummary;
      return `${prefix} · ${totalPins} pins · ${c.red}⛔ blocked: ${truncated}${c.reset}`;
    }
  }
  // 1.45. SAVED — auto-protect just added pins. Transient celebration.
  if (lastStatus.lastSavedAt && typeof lastStatus.lastSavedCount === "number" && lastStatus.lastSavedCount > 0) {
    const age = now - new Date(lastStatus.lastSavedAt).getTime();
    if (Number.isFinite(age) && age >= 0 && age < SAVED_WINDOW_MS) {
      const n = lastStatus.lastSavedCount;
      return `${prefix} · ${totalPins} pins · ${c.green}+${n} new guard${n === 1 ? "" : "s"}${c.reset}`;
    }
  }
  // 1.47. AUDIT — `pinned audit --learned` just ran. Transient.
  if (lastStatus.lastAuditAt && typeof lastStatus.lastAuditCount === "number") {
    const age = now - new Date(lastStatus.lastAuditAt).getTime();
    if (Number.isFinite(age) && age >= 0 && age < AUDIT_WINDOW_MS) {
      const n = lastStatus.lastAuditCount;
      return `${prefix} · ${totalPins} pins · ${c.cyan}checked ${n} similar code path${n === 1 ? "" : "s"}${c.reset}`;
    }
  }
  // 1.48. COVERED — vitest pin suite passed. Brief celebration.
  if (lastStatus.lastCoveredAt && typeof lastStatus.lastCoveredCount === "number") {
    const age = now - new Date(lastStatus.lastCoveredAt).getTime();
    if (Number.isFinite(age) && age >= 0 && age < COVERED_WINDOW_MS) {
      const n = lastStatus.lastCoveredCount;
      return `${prefix} · ${totalPins} pins · ${c.green}${n} guard${n === 1 ? "" : "s"} passed${c.reset}`;
    }
  }
  // 1.5. Fresh AI Lesson — transient LEARNED line for 2 min after
  // a lesson lands. Shows the plain-English summary so the user sees
  // WHAT was learned, not just "1 new lesson". See [[tier-model-final-2026-05-23]].
  if (lastStatus.lastLessonAt && lastStatus.lastLessonSummary) {
    const lessonAge = now - new Date(lastStatus.lastLessonAt).getTime();
    if (Number.isFinite(lessonAge) && lessonAge >= 0 && lessonAge < LEARNED_WINDOW_MS) {
      return `${prefix} · ${totalPins} pins · ${c.cyan}learned: ${lastStatus.lastLessonSummary}${c.reset}`;
    }
  }
  if (lastStatus.lastCatchAt) {
    const age = now - new Date(lastStatus.lastCatchAt).getTime();
    if (Number.isFinite(age) && age >= 0 && age < CATCH_PROMINENT_WINDOW_MS) {
      // Count catches within the prominent window
      const cutoff = now - CATCH_PROMINENT_WINDOW_MS;
      const recentCount = (lastStatus.catchHistory ?? []).filter((r) => {
        const t = new Date(r.caughtAt).getTime();
        return Number.isFinite(t) && t >= cutoff;
      }).length || 1; // at least 1 since lastCatchAt itself is within window
      const noun = recentCount === 1 ? "catch" : "catches";
      return `${prefix} · ${totalPins} pins · ${c.green}★ ${recentCount} ${noun} today${c.reset}`;
    }
    // 24-72h: subtle footer, falls through to calm-green below.
    // We compute a label here and tack it on later in the calm branch.
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
      // Plain-English form. "REVIEW · N touched" was jargon — the user
      // didn't intuit it means "your edits touch N guarded files."
      // "in this commit" matches AI-coder mental model better. Updated
      // 2026-05-23 per UX feedback.
      const label = n === 1 ? "1 protected file in this commit" : `${n} protected files in this commit`;
      return `${prefix} · ${totalPins} pins · ${c.yellow}⚠ ${label}${c.reset}`;
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
  // 3. Unpinned risks — patterns Pinned recognized as guardable but
  // hasn't pinned yet. Plain-English: "risk" → "could be guarded".
  if (typeof lastStatus.unpinnedRisks === "number" && lastStatus.unpinnedRisks > 0) {
    const n = lastStatus.unpinnedRisks;
    return `${prefix} · ${totalPins} pins · ${c.yellow}⚠ ${n} thing${n === 1 ? "" : "s"} could be guarded${c.reset}`;
  }
  // 4. Safety notes — load-bearing config / public-exposure
  // findings (env in repo, large bundle, etc.). Plain-English:
  // "note" → "safety warning".
  if (typeof lastStatus.safetyNotes === "number" && lastStatus.safetyNotes > 0) {
    const n = lastStatus.safetyNotes;
    return `${prefix} · ${totalPins} pins · ${c.yellow}⚠ ${n} safety warning${n === 1 ? "" : "s"}${c.reset}`;
  }
  // 5. Recently added — transient celebration of auto-protect work.
  // Emit a multi-line banner during the celebration window so users
  // SEE what was added, not just an abstract count. Claude Code
  // renders multi-line statusline output across multiple lines; VS
  // Code's status bar truncates to the first line (acceptable
  // fallback — the first line still names a pin).
  if (
    typeof lastStatus.recentlyAddedCount === "number" &&
    lastStatus.recentlyAddedCount > 0 &&
    lastStatus.recentlyAddedAt
  ) {
    const age = now - new Date(lastStatus.recentlyAddedAt).getTime();
    if (Number.isFinite(age) && age >= 0 && age < RECENTLY_ADDED_TTL_MS) {
      const n = lastStatus.recentlyAddedCount;
      const summaries = lastStatus.recentlyAddedSummaries ?? [];
      if (summaries.length > 0) {
        // Multi-line transient celebration. Per GPT's "multi-line for
        // celebration, never for steady state" rule:
        //   - Line 1 alone is still useful if a single-line surface
        //     (VS Code status bar) truncates it.
        //   - Bullets cap at 3 (GPT-recommended balance: enough to
        //     show value, not enough to dominate the chat surface).
        //   - No footer here — the chat hook + init banner carry the
        //     explanatory text. Statusline stays terse.
        const lines: string[] = [
          `${prefix} · ${c.green}★ Pinned added ${n} protection${n === 1 ? "" : "s"}${c.reset}`,
        ];
        const MAX_BULLETS = 3;
        const visible = summaries.slice(0, MAX_BULLETS);
        const rest = summaries.length - visible.length;
        for (const s of visible) {
          lines.push(`   ${c.green}+${c.reset} ${s}`);
        }
        if (rest > 0) {
          lines.push(`   ${c.green}+${c.reset} …and ${rest} more`);
        }
        return lines.join("\n");
      }
      // No summaries available (older cache) — fall back to count.
      return `${prefix} · ${c.green}★ Pinned added ${n} protection${n === 1 ? "" : "s"}${c.reset}`;
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
  // Compute optional "last catch Nd ago" subtle tail — appended ONLY
  // when a catch landed in the 24-72h window. Permanent value signal
  // (coverage) leads; catch becomes context, not headline.
  let subtleCatchTail = "";
  if (lastStatus.lastCatchAt) {
    const age = now - new Date(lastStatus.lastCatchAt).getTime();
    if (
      Number.isFinite(age) &&
      age >= CATCH_PROMINENT_WINDOW_MS &&
      age < CATCH_SUBTLE_WINDOW_MS
    ) {
      const days = Math.max(1, Math.floor(age / (24 * 60 * 60 * 1000)));
      subtleCatchTail = ` · ${c.dim}last catch ${days}d ago${c.reset}`;
    }
  }
  const streak = lastStatus.verifiedStreak ?? 0;
  if (streak > 0) {
    const lessonsTail =
      typeof lastStatus.lessonsLifetime === "number" && lastStatus.lessonsLifetime > 0
        ? ` · ${lastStatus.lessonsLifetime} lessons`
        : "";
    return `${prefix} · ${totalPins} pins${lessonsTail} · ${c.green}✓ ${streak} verified${c.reset}${subtleCatchTail}`;
  }
  const lessonsTail =
    typeof lastStatus.lessonsLifetime === "number" && lastStatus.lessonsLifetime > 0
      ? ` · ${lastStatus.lessonsLifetime} lessons`
      : "";
  return `${prefix} · ${totalPins} pins${lessonsTail} · ${c.green}✓${c.reset}${subtleCatchTail}`;
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
        text: addCelebrationMessage(
          lastStatus.recentlyAddedCount,
          lastStatus.recentlyAddedSummaries ?? []
        ),
        stampAddNotifiedAt: lastStatus.recentlyAddedAt,
      };
    }
  }
  // 3. Recent catches mention — informational injection so the AI
  // can answer "what did Pinned catch?" without reading raw JSON.
  // Fires when there are catches within the prominent window (24h)
  // that the AI hasn't been notified about. Brief by design: just
  // names the most severe catch + count + how to dig deeper. Never
  // blocks; never repeats (gated by lastAddNotifiedAt, repurposed
  // since add and catch notifications can share the throttle stamp).
  if (lastStatus?.lastCatchAt) {
    const catchAge = now - new Date(lastStatus.lastCatchAt).getTime();
    if (Number.isFinite(catchAge) && catchAge >= 0 && catchAge < CATCH_PROMINENT_WINDOW_MS) {
      const cutoff = now - CATCH_PROMINENT_WINDOW_MS;
      const recent = (lastStatus.catchHistory ?? []).filter((r) => {
        const t = new Date(r.caughtAt).getTime();
        return Number.isFinite(t) && t >= cutoff;
      });
      // Dedupe by claimId — the catchHistory legitimately records every
      // run's catch (so re-running `pinned test` against an unfixed
      // breakage doesn't lose the audit trail), but the user-facing
      // "N regressions caught in the last 24h" must count UNIQUE pins,
      // not unique records. Without this dedupe, 3 broken pins × 2
      // recorded runs = "6 regressions caught" — inflated stale data
      // that re-announces the same issues every prompt. Caught on
      // socialideagen dogfood 2026-06-02 as a HIGH-severity TRUST bug.
      const byClaim = new Map<string, CatchRecord>();
      for (const r of recent) {
        const existing = byClaim.get(r.claimId);
        if (!existing) {
          byClaim.set(r.claimId, r);
          continue;
        }
        // Keep the most-recent record per claim so timestamps reflect
        // when the issue last fired, not the first time.
        const a = new Date(existing.caughtAt).getTime();
        const b = new Date(r.caughtAt).getTime();
        if (b > a) byClaim.set(r.claimId, r);
      }
      const deduped = Array.from(byClaim.values());
      if (deduped.length > 0) {
        // Sort by severity (highest first) so the headline picks the
        // most-serious catch as the lede.
        const rankOf: Record<string, number> = {
          critical: 4, high: 3, medium: 2, low: 1, info: 0,
        };
        const ranked = [...deduped].sort(
          (a, b) => (rankOf[b.severity ?? "info"] ?? 0) - (rankOf[a.severity ?? "info"] ?? 0)
        );
        return {
          text: recentCatchesMessage(ranked),
          stampAddNotifiedAt: null,
        };
      }
    }
  }
  // 4. Nothing to say.
  return { text: "", stampAddNotifiedAt: null };
}

// Brief chat-hook injection that tells the AI about catches in the
// last 24h. Goal: enough context so "what did Pinned catch?" can be
// answered conversationally; brief enough that the AI's main task
// isn't disrupted. Bullets cap at 3 by severity rank.
function recentCatchesMessage(ranked: CatchRecord[]): string {
  const n = ranked.length;
  const lines: string[] = [
    `ℹ Pinned context: ${n} regression${n === 1 ? "" : "s"} caught in the last 24h${ranked[0]?.severity === "critical" ? " (includes 1 CRITICAL)" : ""}:`,
  ];
  const MAX = 3;
  for (const c of ranked.slice(0, MAX)) {
    const sev = c.severity ? `[${c.severity.toUpperCase()}] ` : "";
    const headline = c.laymanHeadline ?? c.claimText ?? c.claimId;
    lines.push(`   • ${sev}${headline}`);
    if (c.userImpact) {
      lines.push(`     What this prevents: ${c.userImpact}`);
    }
  }
  if (n > MAX) {
    lines.push(`   • …and ${n - MAX} more`);
  }
  lines.push("");
  lines.push(
    "If the user asks about these, run `pinned catches` for the full list."
  );
  return lines.join("\n");
}

// Back-compat — the existing CLI command uses formatFailureHook and the
// downstream `.claude/settings.json` references hook-failure. We keep
// the function name + behavior but expand the content path.
export function formatFailureHook(lastStatus: LastStatus | null): string {
  return formatChatHook(lastStatus).text;
}

function addCelebrationMessage(n: number, summaries: string[]): string {
  // Same shape as init's terminal banner — header naming what
  // happened, bullets naming the subjects protected, footer naming
  // the consequence. The chat hook is "terminal-class" output (per
  // user feedback distinguishing it from the more compact statusline
  // surface), so the explanatory footer DOES belong here — it's not
  // the cramped status bar.
  //
  // Caps the visible list at MAX_VISIBLE so a 10-pin batch doesn't
  // dominate the chat turn. AI agents read this output and weave it
  // into their response; keep wording calm and factual.
  const MAX_VISIBLE = 5;
  const lines: string[] = [
    `★ Pinned added ${n} new protection${n === 1 ? "" : "s"}:`,
  ];
  if (summaries.length > 0) {
    const visible = summaries.slice(0, MAX_VISIBLE);
    const rest = summaries.length - visible.length;
    for (const s of visible) {
      lines.push(`   + ${s}`);
    }
    if (rest > 0) {
      lines.push(`   + …and ${rest} more`);
    }
  }
  lines.push("");
  lines.push(
    `   If AI changes break any of these, your tests will fail and Pinned will tell you.`
  );
  return lines.join("\n");
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
  lines.push(`  Run \`npx pinnedai test\` to re-verify after fixing.`);
  return lines.join("\n");
}

