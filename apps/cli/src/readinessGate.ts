// Pre-commit / pre-push / CI readiness gate.
//
// Per task #147 + #155 + the build plan's "Pinned as the CI / AI-loop
// gate" spec:
//
//   The agent isn't allowed to mark a task done (and CI blocks
//   merge/deploy) until the affected smoke pins pass. This is the
//   stickiness wedge — it makes Pinned part of the workflow.
//
// The gate function answers: "given the recently changed files +
// the most recent smoke-pin run history, is this code allowed to
// ship?" Returns the list of unmet conditions; an empty list = pass.
//
// Hard rule (zero network): pure filesystem reads.
//
// Per [[anything-annoying-must-be-opt-in]], the gate is OFF by
// default. Enabled via `pinned init --enable-readiness-gate` (or the
// auto-mode prompt) which wires the hook script.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type GateReason =
  | { kind: "smoke-pin-red"; claimId: string; lastRunAt: string; failureSummary?: string }
  | { kind: "smoke-pin-stale"; claimId: string; lastRunAt: string | null; affectedByFile: string }
  | { kind: "open-catch-event"; eventId: string; detector: string; file: string; ageSeconds: number };

export type GateInput = {
  cwd: string;
  // Files that changed since the last green run — used to compute the
  // blast radius of smoke pins to check. Caller (the hook script)
  // passes `git diff --staged --name-only` output (pre-commit) or
  // `git diff <base>..HEAD --name-only` (CI).
  changedFiles: string[];
  // Max age of a smoke-pin run before we treat it as stale. Default
  // 24h — anything older than that means the pin hasn't actually
  // been confirmed since the affecting code changed.
  staleAfterSeconds?: number;
  // Whether to block on open (unresolved) catch events. Conservative
  // default is false — open events are weak signals (we don't know if
  // they're real or FP), so blocking on them would create noise.
  // Enable via `pinned init --strict-readiness-gate` for teams that
  // want stricter behavior.
  blockOnOpenCatches?: boolean;
  // Max age of an open catch event before we surface it. Default 30d.
  openCatchMaxAgeDays?: number;
};

export type GateResult = {
  pass: boolean;
  reasons: GateReason[];
  // Human-readable summary for hook output / CI logs.
  summary: string;
};

export function evaluateReadinessGate(input: GateInput): GateResult {
  const reasons: GateReason[] = [];
  const staleAfter = input.staleAfterSeconds ?? 24 * 60 * 60;
  const blockOpen = input.blockOnOpenCatches ?? false;
  const openMaxAge = (input.openCatchMaxAgeDays ?? 30) * 24 * 60 * 60;
  const now = Date.now();
  const pinnedDir = join(input.cwd, ".pinned");

  // Phase 1: load smoke history + blast-radius index.
  let smokeHistory: any = null;
  let smokeIndex: any = null;
  try {
    const histPath = join(pinnedDir, "smoke-history.json");
    if (existsSync(histPath)) smokeHistory = JSON.parse(readFileSync(histPath, "utf8"));
  } catch { /* ignore corrupt history — don't block */ }
  try {
    const idxPath = join(pinnedDir, "smoke-pin-index.json");
    if (existsSync(idxPath)) smokeIndex = JSON.parse(readFileSync(idxPath, "utf8"));
  } catch { /* ignore */ }

  // Phase 2: which smoke pins are affected by the changed files?
  // Use the file-level index (best-effort). For full transitive
  // blast-radius the caller can invoke `pinned blast-radius` first.
  const affectedClaimIds = new Set<string>();
  if (smokeIndex?.byFile) {
    for (const f of input.changedFiles) {
      const pins = smokeIndex.byFile[f];
      if (Array.isArray(pins)) for (const id of pins) affectedClaimIds.add(id);
    }
  }

  // Phase 3: for each affected pin, check the latest run.
  for (const claimId of affectedClaimIds) {
    let latestRun: any = null;
    if (smokeHistory?.runs && Array.isArray(smokeHistory.runs)) {
      latestRun = smokeHistory.runs.find((r: any) => r?.claimId === claimId);
    }
    if (!latestRun) {
      reasons.push({
        kind: "smoke-pin-stale",
        claimId,
        lastRunAt: null,
        affectedByFile: input.changedFiles[0] ?? "(unknown)",
      });
      continue;
    }
    if (latestRun.outcome === "red") {
      reasons.push({
        kind: "smoke-pin-red",
        claimId,
        lastRunAt: latestRun.at,
        failureSummary: latestRun.failureSummary,
      });
      continue;
    }
    // Green or skip — check staleness.
    const ageSeconds = (now - Date.parse(latestRun.at)) / 1000;
    if (ageSeconds > staleAfter) {
      reasons.push({
        kind: "smoke-pin-stale",
        claimId,
        lastRunAt: latestRun.at,
        affectedByFile: input.changedFiles[0] ?? "(unknown)",
      });
    }
  }

  // Phase 4: optionally block on open catch events.
  if (blockOpen) {
    try {
      const statsPath = join(pinnedDir, "repo-stats.json");
      if (existsSync(statsPath)) {
        const stats = JSON.parse(readFileSync(statsPath, "utf8"));
        if (stats?.byDetector) {
          for (const [detector, ds] of Object.entries<any>(stats.byDetector)) {
            for (const ev of ds.events ?? []) {
              if (ev.status !== "open") continue;
              const ageSeconds = (now - Date.parse(ev.at)) / 1000;
              if (ageSeconds > openMaxAge) continue; // too old, ignore
              reasons.push({ kind: "open-catch-event", eventId: ev.id, detector, file: ev.file, ageSeconds: Math.round(ageSeconds) });
            }
          }
        }
      }
    } catch { /* ignore */ }
  }

  const pass = reasons.length === 0;
  return {
    pass,
    reasons,
    summary: formatGateSummary(pass, reasons),
  };
}

function formatGateSummary(pass: boolean, reasons: GateReason[]): string {
  if (pass) {
    return "✓ Pinned readiness gate: PASS";
  }
  const lines: string[] = ["✗ Pinned readiness gate: BLOCKED"];
  for (const r of reasons) {
    if (r.kind === "smoke-pin-red") {
      lines.push(`  - Smoke pin RED: ${r.claimId} (last run ${r.lastRunAt})${r.failureSummary ? ` — ${r.failureSummary}` : ""}`);
    } else if (r.kind === "smoke-pin-stale") {
      lines.push(`  - Smoke pin stale: ${r.claimId} (${r.lastRunAt ? `last run ${r.lastRunAt}` : "never run"}) — change touches ${r.affectedByFile}. Re-run before ship.`);
    } else if (r.kind === "open-catch-event") {
      lines.push(`  - Open catch event: ${r.eventId} (${r.detector}) at ${r.file} — confirm or dismiss before ship.`);
    }
  }
  lines.push("");
  lines.push("To bypass once: --no-verify on the git command (use sparingly).");
  lines.push("To disable the gate: pinned init --disable-readiness-gate");
  return lines.join("\n");
}
