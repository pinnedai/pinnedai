// pinned sync-rules — inline top-N lessons into every agent-rules file.
//
// Per Cipherwake Gap 5: "Inline the lesson, never redirect. Three lines
// of plainEnglish in the always-loaded file beats a pointer to a
// 50-line file that gets skipped." The existing agent-rules block
// already points at tests/pinned/AGENT.md and .pinned/ai-lessons.md
// — but a pointer is one hop, and one hop is what got skipped during
// the socialideagen session that motivated Gap 5.
//
// This module reads .pinned/lessons.json + writes the top-N (default
// 5) into a sub-block within the existing pinnedai marker block. The
// sub-block has its own inner markers so re-runs replace just the
// lessons section without touching customer-written content.
//
// Files updated: every match from AGENT_RULE_FILE_CANDIDATES that
// EXISTS — we don't create new files, just enrich existing ones.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_RULE_FILE_CANDIDATES, AGENT_INSTALL_MARKER_START } from "./agentRules.js";

export const LESSONS_BLOCK_START = "<!-- pinnedai:lessons:start -->";
export const LESSONS_BLOCK_END = "<!-- pinnedai:lessons:end -->";

export type SyncLessonsOpts = {
  cwd: string;
  // Max lessons to inline (default 5). More than this gets too long.
  limit?: number;
  // Per Gap 5: cap the injected block to ~25 lines so it stays cheap
  // for agents to ingest on every Edit/Write.
  maxLines?: number;
};

export type SyncLessonsResult = {
  // Files where the lessons block was added or refreshed.
  updated: string[];
  // Files that already had a current lessons block and didn't need rewrite.
  unchanged: string[];
  // Files where the pinnedai marker block was MISSING (we don't
  // create them — caller can run `pinned ai-rules install` first).
  missingAgentBlock: string[];
};

type LessonForInline = {
  rule: string;
  plainEnglish: string;
  pastMistakes: string[];
  severity?: string;
};

function readLessons(cwd: string): LessonForInline[] {
  const path = join(cwd, ".pinned/lessons.json");
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || !Array.isArray(raw.lessons)) return [];
    return (raw.lessons as any[])
      .filter((l) => typeof l?.rule === "string" && l.rule.length > 0)
      .map((l) => ({
        rule: l.rule,
        plainEnglish: typeof l.plainEnglish === "string" ? l.plainEnglish : l.rule,
        pastMistakes: Array.isArray(l.pastMistakes) ? l.pastMistakes : [],
        severity: typeof l.severity === "string" ? l.severity : undefined,
      }));
  } catch {
    return [];
  }
}

function rankLessons(lessons: LessonForInline[]): LessonForInline[] {
  // Heuristic: block-severity lessons + lessons with more past mistakes
  // surface first. Within ties: alphabetical for determinism.
  const score = (l: LessonForInline): number => {
    let s = 0;
    if (l.severity === "block") s += 100;
    if (l.severity === "warn") s += 10;
    s += Math.min(l.pastMistakes.length, 10);
    return s;
  };
  return [...lessons].sort((a, b) => {
    const sa = score(a), sb = score(b);
    if (sa !== sb) return sb - sa;
    return a.rule.localeCompare(b.rule);
  });
}

function renderLessonsBlock(lessons: LessonForInline[], maxLines: number): string {
  const lines: string[] = [];
  lines.push(LESSONS_BLOCK_START);
  lines.push("<!-- Pinned lessons (auto-synced from .pinned/lessons.json — do not edit) -->");
  lines.push("");
  if (lessons.length === 0) {
    lines.push("_No lessons learned yet. They appear here as Pinned catches real regressions._");
    lines.push("");
    lines.push(LESSONS_BLOCK_END);
    return lines.join("\n");
  }
  lines.push("### Repo-specific lessons (Pinned has caught these here)");
  lines.push("");
  let usedLines = lines.length + 1;
  for (const l of lessons) {
    const lessonLines: string[] = [];
    lessonLines.push(`- **${l.rule}** — ${l.plainEnglish}`);
    if (l.pastMistakes.length > 0) {
      const m = l.pastMistakes[0];
      const truncated = m.length > 90 ? m.slice(0, 87) + "..." : m;
      lessonLines.push(`  _Last catch: ${truncated}_`);
    }
    // Honor max-lines budget.
    if (usedLines + lessonLines.length + 2 > maxLines) break;
    lines.push(...lessonLines);
    usedLines += lessonLines.length;
  }
  lines.push("");
  lines.push(LESSONS_BLOCK_END);
  return lines.join("\n");
}

export function syncLessonsIntoAgentRules(opts: SyncLessonsOpts): SyncLessonsResult {
  const cwd = opts.cwd;
  const limit = opts.limit ?? 5;
  const maxLines = opts.maxLines ?? 25;
  const ranked = rankLessons(readLessons(cwd)).slice(0, limit);
  const blockContent = renderLessonsBlock(ranked, maxLines);

  const updated: string[] = [];
  const unchanged: string[] = [];
  const missingAgentBlock: string[] = [];

  for (const candidate of AGENT_RULE_FILE_CANDIDATES) {
    const path = join(cwd, candidate);
    if (!existsSync(path)) continue;
    const content = readFileSync(path, "utf8");
    // We only inject if the customer has already opted into the
    // pinnedai marker block (via `pinned ai-rules install`).
    // Otherwise the lesson block would be orphan-floating in a file
    // that doesn't have any Pinned context.
    if (!content.includes(AGENT_INSTALL_MARKER_START)) {
      missingAgentBlock.push(candidate);
      continue;
    }
    // Find existing lessons sub-block + replace, or insert after the
    // pinnedai marker start.
    const startIdx = content.indexOf(LESSONS_BLOCK_START);
    const endIdx = content.indexOf(LESSONS_BLOCK_END);
    let next: string;
    if (startIdx >= 0 && endIdx > startIdx) {
      const before = content.slice(0, startIdx);
      const after = content.slice(endIdx + LESSONS_BLOCK_END.length);
      next = before + blockContent + after;
    } else {
      // Insert right after the pinnedai marker start line.
      const markerLineEnd = content.indexOf("\n", content.indexOf(AGENT_INSTALL_MARKER_START));
      if (markerLineEnd < 0) {
        // Malformed file — append at end of pinnedai block (rare).
        next = content + "\n\n" + blockContent;
      } else {
        const before = content.slice(0, markerLineEnd + 1);
        const after = content.slice(markerLineEnd + 1);
        next = before + "\n" + blockContent + "\n" + after;
      }
    }
    if (next === content) {
      unchanged.push(candidate);
    } else {
      writeFileSync(path, next);
      updated.push(candidate);
    }
  }
  return { updated, unchanged, missingAgentBlock };
}
