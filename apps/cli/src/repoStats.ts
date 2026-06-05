// Per-repo bug-class stats tracking (0.2.25+) — the foundation for
// `pinned report` (local) and the hosted provider-analytics moat.
//
// Storage: `.pinned/repo-stats.json` (local-first per the locked
// free-tier definition — never upload without explicit opt-in).
//
// Update path: every `pinned sweep` run merges fresh detections into
// the stored stats with per-detector counts + per-model breakdown +
// trend snapshots.
//
// Per [[strategic-moat-independent-guardrail]]:
//   * Free tier — full local data, all detectors, all model tags.
//   * Paid tier (later, hosted) — cross-repo aggregation, org-wide
//     provider-mistake analytics, anonymized team trends. The local
//     data is already structured for that upload path; no schema
//     migration needed when hosted ships.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { AiModelDetection } from "./aiModel.js";

export type DetectorName =
  | "enum-drift"
  | "env-required"
  | "supabase-column"
  | "expected-header"
  | "nullable-result"
  | "response-shape"
  | "mass-mutation"
  | "server-action-write"
  | "stripe-event-handled"
  | "paid-api-call"
  | "edge-function-write"
  | "cron-handler"
  | "page-accessibility"
  | "interaction-baseline"
  | "happy-path-with-side-effect"
  | "journey"
  | "page-renders"
  | string; // open-ended for future detectors

export type HitSample = {
  filePath: string;
  line?: number;
  // Plain-English summary so the user can see what was caught at a
  // glance — e.g. `"status === 'done' but producer emits 'completed'"`.
  summary: string;
  caughtAt: string; // ISO timestamp
};

export type ModelStats = {
  hits: number;
  firstSeen: string;
  lastSeen: string;
  // Confidence breakdown from AiModelDetection — useful for sanity-
  // checking analytics.
  byConfidence: Partial<Record<"known" | "heuristic" | "unspecified", number>>;
};

export type DetectorStats = {
  totalHits: number;
  // Severity ranking: how seriously to treat catches from this
  // detector. Used in `pinned report` ordering and notification
  // thresholds for paid tier.
  severity: "critical" | "high" | "medium" | "low";
  byModel: Record<string, ModelStats>;
  sampleHits: HitSample[]; // bounded to last 10
  firstSeen: string;
  lastSeen: string;
};

export type RepoStatsSnapshot = {
  at: string; // ISO timestamp
  totalByDetector: Record<DetectorName, number>;
};

export type RepoStats = {
  version: 1;
  byDetector: Record<DetectorName, DetectorStats>;
  // 7-day rolling snapshots (one per day max). Enables `pinned report`
  // trend deltas without storing every commit.
  snapshots: RepoStatsSnapshot[];
  lastUpdated: string;
  // Repo identity (best-effort). Used by paid tier for cross-repo
  // aggregation; harmless in free tier.
  repoIdentity?: { name?: string; gitRemote?: string };
};

const REPO_STATS_FILENAME = "repo-stats.json";

// Severity defaults per detector. Tunable; surfaces in report ordering.
const SEVERITY_DEFAULTS: Record<string, DetectorStats["severity"]> = {
  // Catastrophic mass-mutation = critical
  "mass-mutation": "critical",
  // Money / data integrity = high
  "server-action-write": "high",
  "stripe-event-handled": "high",
  "paid-api-call": "high",
  "edge-function-write": "high",
  // Silent breakage at deploy / first-run = high
  "env-required": "high",
  "supabase-column": "high",
  "expected-header": "high",
  // Functional regressions = medium
  "enum-drift": "medium",
  "response-shape": "medium",
  "nullable-result": "medium",
  "cron-handler": "medium",
  "happy-path-with-side-effect": "medium",
  "journey": "medium",
  // Defensive / surface = low
  "page-renders": "low",
  "page-accessibility": "low",
  "interaction-baseline": "low",
};

function severityFor(detector: DetectorName): DetectorStats["severity"] {
  return SEVERITY_DEFAULTS[detector] ?? "medium";
}

export function readRepoStats(pinnedDir: string): RepoStats {
  const p = join(pinnedDir, REPO_STATS_FILENAME);
  if (!existsSync(p)) return emptyStats();
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    if (parsed?.version === 1 && parsed?.byDetector) return parsed as RepoStats;
  } catch {
    /* fall through */
  }
  return emptyStats();
}

function emptyStats(): RepoStats {
  return {
    version: 1,
    byDetector: {},
    snapshots: [],
    lastUpdated: new Date().toISOString(),
  };
}

// Atomic write — same pattern as registry.ts / .last-status.json.
export function writeRepoStats(pinnedDir: string, stats: RepoStats): void {
  if (!existsSync(pinnedDir)) mkdirSync(pinnedDir, { recursive: true });
  const target = join(pinnedDir, REPO_STATS_FILENAME);
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmp, JSON.stringify(stats, null, 2) + "\n");
    renameSync(tmp, target);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

export type HitInput = {
  detector: DetectorName;
  filePath: string;
  line?: number;
  summary: string;
};

// Merge a batch of detected hits into the stats. Returns the updated
// stats (caller is responsible for persisting).
export function mergeHits(
  prev: RepoStats,
  hits: HitInput[],
  aiModel: AiModelDetection,
  opts: { now?: Date } = {}
): RepoStats {
  const now = (opts.now ?? new Date()).toISOString();
  const stats: RepoStats = {
    ...prev,
    byDetector: { ...prev.byDetector },
    snapshots: [...prev.snapshots],
    lastUpdated: now,
  };

  // Hits with no detector or no summary are skipped.
  for (const h of hits) {
    if (!h.detector || !h.summary) continue;
    const existing = stats.byDetector[h.detector] ?? {
      totalHits: 0,
      severity: severityFor(h.detector),
      byModel: {},
      sampleHits: [],
      firstSeen: now,
      lastSeen: now,
    };
    existing.totalHits += 1;
    existing.lastSeen = now;
    const modelKey = aiModel.model;
    const modelEntry = existing.byModel[modelKey] ?? {
      hits: 0,
      firstSeen: now,
      lastSeen: now,
      byConfidence: {},
    };
    modelEntry.hits += 1;
    modelEntry.lastSeen = now;
    modelEntry.byConfidence[aiModel.confidence] = (modelEntry.byConfidence[aiModel.confidence] ?? 0) + 1;
    existing.byModel[modelKey] = modelEntry;
    existing.sampleHits = [
      { filePath: h.filePath, line: h.line, summary: h.summary, caughtAt: now },
      ...existing.sampleHits,
    ].slice(0, 10); // keep last 10
    stats.byDetector[h.detector] = existing;
  }

  // Snapshot if a day has passed since the last one (or if first).
  const today = now.slice(0, 10);
  const lastSnap = stats.snapshots[stats.snapshots.length - 1];
  if (!lastSnap || lastSnap.at.slice(0, 10) !== today) {
    const totalByDetector: Record<string, number> = {};
    for (const [name, ds] of Object.entries(stats.byDetector)) {
      totalByDetector[name] = ds.totalHits;
    }
    stats.snapshots.push({ at: now, totalByDetector });
    // Trim to 60 days max.
    if (stats.snapshots.length > 60) stats.snapshots = stats.snapshots.slice(-60);
  }

  return stats;
}

// Trend delta for a detector — current total vs N days ago.
export function trendDelta(
  stats: RepoStats,
  detector: DetectorName,
  windowDays: number
): { delta: number; basis: "compared" | "no-history" } {
  const current = stats.byDetector[detector]?.totalHits ?? 0;
  if (stats.snapshots.length < 2) return { delta: 0, basis: "no-history" };
  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  // Find the snapshot closest to but before the cutoff. If no snapshot
  // older than cutoff, fall back to the earliest one.
  let basis: RepoStatsSnapshot | undefined;
  for (const s of stats.snapshots) {
    if (s.at <= cutoff) basis = s;
  }
  if (!basis) basis = stats.snapshots[0];
  const past = basis.totalByDetector[detector] ?? 0;
  return { delta: current - past, basis: "compared" };
}
