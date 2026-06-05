// Tier 1 smoke-pin run history + flake classification.
//
// Per task #157 + the build plan's "Flaky-feature detection" spec:
// a feature that goes RED 1-in-5 runs is materially different from
// one that's always green. A single green run hides it. Surface
// flake as a first-class signal.
//
// The double-confirm machinery already exists in the template (re-run
// twice before going RED). What's missing is BOOKKEEPING: track the
// per-pin outcomes over time so `pinned report` can classify each
// pin as solid / flaky / broken.
//
// Storage: .pinned/smoke-history.json. Local-only — zero network per
// the same hard rule as task #158's catch instrumentation.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export type SmokeRunOutcome = "green" | "red" | "skip";

export type SmokeRunRecord = {
  claimId: string;
  at: string;             // ISO timestamp
  outcome: SmokeRunOutcome;
  durationMs?: number;
  // For red runs, the failed-assertion summary so users can see WHAT
  // failed without consulting the original vitest output.
  failureSummary?: string;
};

export type SmokeHistory = {
  version: 1;
  runs: SmokeRunRecord[]; // bounded to last 500 across all pins
};

const HISTORY_FILENAME = "smoke-history.json";
const MAX_RUNS = 500;

export function readHistory(pinnedDir: string): SmokeHistory {
  const p = join(pinnedDir, HISTORY_FILENAME);
  if (!existsSync(p)) return { version: 1, runs: [] };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    if (parsed?.version === 1 && Array.isArray(parsed.runs)) return parsed as SmokeHistory;
  } catch { /* corrupt → start fresh */ }
  return { version: 1, runs: [] };
}

export function writeHistory(pinnedDir: string, h: SmokeHistory): void {
  if (!existsSync(pinnedDir)) mkdirSync(pinnedDir, { recursive: true });
  const target = join(pinnedDir, HISTORY_FILENAME);
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmp, JSON.stringify(h, null, 2) + "\n");
    renameSync(tmp, target);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

export function recordRun(h: SmokeHistory, r: SmokeRunRecord): SmokeHistory {
  return {
    version: 1,
    runs: [r, ...h.runs].slice(0, MAX_RUNS),
  };
}

export type FlakeClassification = "solid" | "flaky" | "broken" | "unknown";

export type PinFlakeStatus = {
  claimId: string;
  classification: FlakeClassification;
  // Trailing N runs the classification is based on. Default window = 10.
  runsConsidered: number;
  greenCount: number;
  redCount: number;
  redRate: number; // 0..1
  lastOutcome: SmokeRunOutcome | "unknown";
};

// Classify each pin based on its last `windowSize` runs (skips ignored).
//   solid   — all green
//   broken  — all red
//   flaky   — mix of green and red
//   unknown — fewer than minRuns non-skip runs
export function classifyAll(
  h: SmokeHistory,
  opts: { windowSize?: number; minRuns?: number } = {}
): PinFlakeStatus[] {
  const window = opts.windowSize ?? 10;
  const minRuns = opts.minRuns ?? 3;
  const byPin = new Map<string, SmokeRunRecord[]>();
  for (const r of h.runs) {
    if (!byPin.has(r.claimId)) byPin.set(r.claimId, []);
    byPin.get(r.claimId)!.push(r);
  }
  const out: PinFlakeStatus[] = [];
  for (const [claimId, runs] of byPin) {
    const nonSkip = runs.filter((r) => r.outcome !== "skip").slice(0, window);
    if (nonSkip.length === 0) {
      out.push({ claimId, classification: "unknown", runsConsidered: 0, greenCount: 0, redCount: 0, redRate: 0, lastOutcome: "unknown" });
      continue;
    }
    const green = nonSkip.filter((r) => r.outcome === "green").length;
    const red = nonSkip.filter((r) => r.outcome === "red").length;
    const redRate = red / nonSkip.length;
    let classification: FlakeClassification;
    if (nonSkip.length < minRuns) classification = "unknown";
    else if (red === 0) classification = "solid";
    else if (green === 0) classification = "broken";
    else classification = "flaky";
    out.push({
      claimId,
      classification,
      runsConsidered: nonSkip.length,
      greenCount: green,
      redCount: red,
      redRate,
      lastOutcome: nonSkip[0].outcome,
    });
  }
  // Sort: broken first, then flaky, then solid.
  const RANK: Record<FlakeClassification, number> = { broken: 3, flaky: 2, solid: 1, unknown: 0 };
  out.sort((a, b) => RANK[b.classification] - RANK[a.classification]);
  return out;
}

export function flakyPins(h: SmokeHistory): PinFlakeStatus[] {
  return classifyAll(h).filter((p) => p.classification === "flaky");
}
