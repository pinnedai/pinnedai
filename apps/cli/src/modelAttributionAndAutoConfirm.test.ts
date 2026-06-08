// Cipherwake 0.6.0 asks #5 + #6 (0.5.0-beta.6):
//
//   #5 — model attribution at edit-time. The PostToolUse hook now
//        persists `.pinned/last-edit-context.json` so subsequent
//        static sweeps (no env set) still get attributed to the
//        agent that produced the edits. Without this, `report`'s
//        MODELS column was mostly "unspecified-model".
//
//   #6 — auto-populate REAL/FP. inferEventResolutions() in
//        repoStats.ts already had the logic but nothing called it.
//        Wired into both `pinned sweep` (after merging hits) and
//        `pinned hook-postedit` (after running affected pins), so
//        the catch ledger populates from normal use — no manual
//        `pinned confirm` needed.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectAiModel, recordEditContext } from "./aiModel.js";
import { inferEventResolutions, type RepoStats } from "./repoStats.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ask56-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("[ask #5] model attribution survives across sweep runs via last-edit-context.json", () => {
  it("recordEditContext writes a fresh .pinned/last-edit-context.json", () => {
    recordEditContext(dir, {
      model: "anthropic:claude:sonnet-4",
      tool: "claude-code",
      signal: "test fixture",
    });
    const p = join(dir, ".pinned", "last-edit-context.json");
    expect(existsSync(p)).toBe(true);
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    expect(parsed.model).toBe("anthropic:claude:sonnet-4");
    expect(parsed.tool).toBe("claude-code");
    expect(parsed.recordedAt).toBeTruthy();
  });

  it("detectAiModel prefers a recent edit-context over heuristic fallback", () => {
    // Write an agent rule file so the heuristic would normally fire.
    writeFileSync(join(dir, "CLAUDE.md"), "# claude rules\n");
    // First: without edit-context, we get heuristic → "unspecified-model".
    const before = detectAiModel({ cwd: dir, env: {} });
    expect(before.confidence).toBe("heuristic");
    expect(before.model).toBe("unspecified-model");
    // Now record an edit-context.
    recordEditContext(dir, {
      model: "anthropic:claude:sonnet-4",
      tool: "claude-code",
      signal: "PostToolUse",
    });
    const after = detectAiModel({ cwd: dir, env: {} });
    // Now the model should be attributed correctly.
    expect(after.confidence).toBe("known");
    expect(after.model).toBe("anthropic:claude:sonnet-4");
    expect(after.tool).toBe("claude-code");
  });

  it("detectAiModel IGNORES stale edit-context (>30 min old)", () => {
    writeFileSync(join(dir, "CLAUDE.md"), "# claude rules\n");
    // Manually write a stale context file (32 minutes ago).
    mkdirSync(join(dir, ".pinned"), { recursive: true });
    const stale = {
      model: "anthropic:claude:sonnet-4",
      tool: "claude-code",
      signal: "stale fixture",
      recordedAt: new Date(Date.now() - 32 * 60 * 1000).toISOString(),
    };
    writeFileSync(join(dir, ".pinned", "last-edit-context.json"), JSON.stringify(stale));
    const d = detectAiModel({ cwd: dir, env: {} });
    // Stale context is ignored → falls through to heuristic.
    expect(d.confidence).toBe("heuristic");
    expect(d.model).toBe("unspecified-model");
  });

  it("PINNED_AI_MODEL env still wins over recent edit-context", () => {
    recordEditContext(dir, {
      model: "anthropic:claude:sonnet-4",
      tool: "claude-code",
      signal: "PostToolUse",
    });
    const d = detectAiModel({ cwd: dir, env: { PINNED_AI_MODEL: "openai:gpt-5o" } });
    expect(d.confidence).toBe("known");
    expect(d.model).toBe("openai:gpt-5o");
  });
});

describe("[ask #6] inferEventResolutions auto-populates REAL on file-changed-since", () => {
  function makeStatsWithOpenEvent(filePath: string, eventAt: string): RepoStats {
    return {
      version: 1,
      lastUpdated: eventAt,
      snapshots: [],
      byDetector: {
        "server-action-write": {
          totalHits: 1,
          confirmedReal: 0,
          dismissedFP: 0,
          severity: "high",
          byModel: {},
          sampleHits: [],
          events: [
            {
              id: "ev_1",
              at: eventAt,
              file: filePath,
              fingerprint: "fp_1",
              status: "open",
            },
          ],
          firstSeen: eventAt,
          lastSeen: eventAt,
        },
      },
    };
  }

  it("transitions open → confirmed when file changed AFTER event time", () => {
    const eventAt = new Date(Date.now() - 60_000).toISOString();
    const stats = makeStatsWithOpenEvent("lib/edited.ts", eventAt);
    const next = inferEventResolutions(stats, {
      fileChangedSince: (_filePath, _sinceISO) => true, // pretend git says yes
      isSuppressed: () => false,
    });
    const ds = next.byDetector["server-action-write"];
    expect(ds.confirmedReal).toBe(1);
    expect(ds.dismissedFP).toBe(0);
    expect(ds.events[0].status).toBe("confirmed");
    expect(ds.events[0].resolvedBy).toBe("inferred-code-changed");
  });

  it("transitions open → dismissed when suppression matches", () => {
    const eventAt = new Date(Date.now() - 60_000).toISOString();
    const stats = makeStatsWithOpenEvent("lib/edited.ts", eventAt);
    const next = inferEventResolutions(stats, {
      fileChangedSince: () => false,
      isSuppressed: () => true, // pretend it's suppressed
    });
    const ds = next.byDetector["server-action-write"];
    expect(ds.confirmedReal).toBe(0);
    expect(ds.dismissedFP).toBe(1);
    expect(ds.events[0].status).toBe("dismissed");
    expect(ds.events[0].resolvedBy).toBe("inferred-suppressed");
  });

  it("leaves event open when nothing changed and no suppression", () => {
    const eventAt = new Date().toISOString();
    const stats = makeStatsWithOpenEvent("lib/edited.ts", eventAt);
    const next = inferEventResolutions(stats, {
      fileChangedSince: () => false,
      isSuppressed: () => false,
    });
    const ds = next.byDetector["server-action-write"];
    expect(ds.confirmedReal).toBe(0);
    expect(ds.dismissedFP).toBe(0);
    expect(ds.events[0].status).toBe("open");
  });
});

describe("[ask #6 wiring] CLI calls runInferEventResolutions on sweep + hook-postedit", () => {
  it("the helper is wired into both call sites (catalog-level invariant)", () => {
    // Static-source check: the helper must be referenced AT LEAST
    // twice in cli.ts (sweep + hook-postedit).
    const src = readFileSync(join(process.cwd(), "src/cli.ts"), "utf8");
    const occurrences = (src.match(/runInferEventResolutions\(/g) ?? []).length;
    // Definition + 2 call sites = 3 occurrences minimum.
    expect(occurrences).toBeGreaterThanOrEqual(3);
  });
});
