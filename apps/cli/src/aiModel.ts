// AI-model detection (0.2.25+) — load-bearing for repo-stats analytics
// and AI-lesson tagging.
//
// Per [[strategic-moat-independent-guardrail]], the provider-analytics
// dimension is the durable moat lever for paid tier — neither
// Anthropic nor Cursor can ship "your Claude bugs vs your GPT bugs"
// analytics for themselves (irreducible conflict of interest).
//
// Detection strategy (in priority order):
//   1. EXPLICIT — env vars set by the user
//   2. HOOK-CONTEXT — env vars set by the Claude Code PostToolUse hook
//   3. BYOK — when PINNEDAI_BYOK=<provider> is set
//   4. HEURISTIC — agent-rule-file presence (CLAUDE.md / .cursorrules /
//      .github/copilot-instructions.md / AGENTS.md / .windsurfrules /
//      .clinerules / .codeium / etc)
//   5. UNSPECIFIED — fallback, no signal found
//
// The "tool" dimension (which CLI / IDE) is separate from the "model"
// dimension (which LLM family + version). A user can run Claude Code
// (tool) routing through Anthropic Sonnet 4 (model). We tag both
// independently when known.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// 0.5.0-beta.6 (Cipherwake 0.6.0 ask #5): recent-edit-context file.
// Persistent attribution from the last PostToolUse hook fire. Used
// as a fallback BETWEEN BYOK and agent-rule-file heuristic so static
// sweeps that run shortly after an agent edit get attributed to the
// agent that produced them. Stale entries (>30 min) are ignored.
const EDIT_CONTEXT_FILENAME = "last-edit-context.json";
const EDIT_CONTEXT_TTL_MS = 30 * 60 * 1000; // 30 min

type EditContext = {
  model: string;
  tool?: string;
  signal: string;
  recordedAt: string; // ISO timestamp
};

function editContextPath(cwd: string): string {
  return join(cwd, ".pinned", EDIT_CONTEXT_FILENAME);
}

export function recordEditContext(cwd: string, ctx: Omit<EditContext, "recordedAt">): void {
  const p = editContextPath(cwd);
  try {
    mkdirSync(join(cwd, ".pinned"), { recursive: true });
    writeFileSync(p, JSON.stringify({ ...ctx, recordedAt: new Date().toISOString() }, null, 2) + "\n");
    // 0.5.0-beta.9 (Cipherwake bug #6): emit a debug-readable stderr
    // line on EVERY write. The dogfood Claude reported the file as
    // absent — there was no signal whether the call fired silently
    // or failed silently. Now both cases are observable in the hook
    // logs / Claude Code's hook output.
    try {
      process.stderr.write(`pinned [edit-context]: wrote ${p} model=${ctx.model} tool=${ctx.tool ?? "none"}\n`);
    } catch { /* stderr unavailable — give up */ }
  } catch (e) {
    // Don't swallow silently — make the failure observable. Caller's
    // try/catch still prevents the hook from crashing on this.
    try {
      process.stderr.write(`pinned [edit-context]: FAILED to write ${p}: ${String(e).slice(0, 200)}\n`);
    } catch { /* stderr unavailable */ }
  }
}

function readRecentEditContext(cwd: string, ttlMs: number): EditContext | null {
  const p = editContextPath(cwd);
  if (!existsSync(p)) return null;
  let parsed: Partial<EditContext> = {};
  try { parsed = JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
  if (!parsed.model || !parsed.recordedAt) return null;
  const age = Date.now() - new Date(parsed.recordedAt).getTime();
  if (!Number.isFinite(age) || age < 0 || age > ttlMs) return null;
  return parsed as EditContext;
}

export type AiModelDetection = {
  // Best-guess model identity. Format: `<provider>:<family>:<version>`
  // when known (e.g. `anthropic:claude:sonnet-4`), or shorter labels
  // for heuristic detection (`anthropic:unknown`, `unspecified-model`).
  model: string;
  // Best-guess tool / agent surface. Format: `<tool>:<version?>`
  // (e.g. `claude-code`, `cursor`, `copilot`, `windsurf`, `cline`).
  // Undefined when no signal.
  tool?: string;
  // Confidence in the detection:
  //   "known"       — directly identifiable (env var / hook context)
  //   "heuristic"   — inferred from agent-rule-file presence
  //   "unspecified" — no signal found, default
  confidence: "known" | "heuristic" | "unspecified";
  // Signal source for debuggability + audit-trail.
  signal: string;
};

// Agent-rule-file conventions, in priority order. The first match
// wins for tool detection. Same set the existing aiLessons module
// already recognizes.
const AGENT_RULE_FILES: Array<{ path: string; tool: string }> = [
  { path: "CLAUDE.md", tool: "claude-code" },
  { path: ".claude/CLAUDE.md", tool: "claude-code" },
  { path: ".cursor/rules", tool: "cursor" },
  { path: ".cursorrules", tool: "cursor" },
  { path: ".github/copilot-instructions.md", tool: "copilot" },
  { path: "AGENTS.md", tool: "agents-md" }, // generic, used by Cursor/Aider/etc
  { path: ".windsurfrules", tool: "windsurf" },
  { path: ".windsurf/rules", tool: "windsurf" },
  { path: ".clinerules", tool: "cline" },
  { path: ".cline/rules", tool: "cline" },
  { path: ".codeiumignore", tool: "codeium" },
];

// BYOK provider → conventional model fallback. When the user has
// explicit BYOK and no version info, this is the most-likely default.
const BYOK_DEFAULT_MODEL: Record<string, string> = {
  anthropic: "anthropic:claude:unknown",
  openai: "openai:gpt:unknown",
  "claude-code": "anthropic:claude:via-claude-code",
  "github-models": "github:models:unknown",
};

export function detectAiModel(opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): AiModelDetection {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;

  // 1. EXPLICIT model override — pretty rare but allowed.
  if (env.PINNED_AI_MODEL) {
    return {
      model: env.PINNED_AI_MODEL,
      tool: env.PINNED_AI_TOOL,
      confidence: "known",
      signal: "PINNED_AI_MODEL env var",
    };
  }

  // 2. HOOK-CONTEXT — Claude Code's PostToolUse hook sets these.
  // The hook can pass the model via PINNED_HOOK_AI_MODEL when wired
  // (0.2.25+ hook update). Tool always claude-code in that path.
  if (env.PINNED_HOOK_AI_MODEL) {
    return {
      model: env.PINNED_HOOK_AI_MODEL,
      tool: "claude-code",
      confidence: "known",
      signal: "Claude Code PostToolUse hook context",
    };
  }

  // 3. BYOK — when PINNEDAI_BYOK is set, the provider is known but
  // the model family isn't necessarily known. Pick a reasonable
  // default; user can override via PINNED_AI_MODEL.
  if (env.PINNEDAI_BYOK) {
    const provider = env.PINNEDAI_BYOK.toLowerCase();
    const model = BYOK_DEFAULT_MODEL[provider] ?? `${provider}:unknown`;
    return {
      model,
      tool: provider === "claude-code" ? "claude-code" : undefined,
      confidence: "known",
      signal: `PINNEDAI_BYOK=${env.PINNEDAI_BYOK}`,
    };
  }

  // 0.5.0-beta.6 (Cipherwake 0.6.0 ask #5): recent edit-context file.
  // hook-postedit writes .pinned/last-edit-context.json each time it
  // fires (with the model passed by Claude Code's PostToolUse). When
  // a static sweep runs SHORTLY AFTER an agent edit (the common case
  // during dogfood) we want the sweep's hits attributed to the model
  // that just produced them, not "unspecified-model". Stale entries
  // (>30 min) fall through to heuristic — the agent loop is fast and
  // a stale file means the user is doing something else.
  try {
    const fresh = readRecentEditContext(cwd, EDIT_CONTEXT_TTL_MS);
    if (fresh) {
      return {
        model: fresh.model,
        tool: fresh.tool,
        confidence: "known",
        signal: `.pinned/last-edit-context.json (${fresh.signal})`,
      };
    }
  } catch { /* file missing or unreadable — fall through */ }

  // 4. HEURISTIC — agent-rule-file presence. Walk the priority list
  // and tag the first hit. This gives tool but not model.
  for (const { path, tool } of AGENT_RULE_FILES) {
    if (existsSync(join(cwd, path))) {
      return {
        model: "unspecified-model",
        tool,
        confidence: "heuristic",
        signal: `agent rule file: ${path}`,
      };
    }
  }

  // 5. UNSPECIFIED — fallback.
  return {
    model: "unspecified-model",
    confidence: "unspecified",
    signal: "no model or tool signal found",
  };
}

// Friendly display label. Used in `pinned report` + sweep output.
export function formatAiModelLabel(d: AiModelDetection): string {
  if (d.confidence === "unspecified") return "unspecified model";
  if (d.confidence === "heuristic") {
    return d.tool ? `${d.tool} (model unknown)` : "unspecified model";
  }
  // known
  if (d.tool && d.model.startsWith("unspecified")) return d.tool;
  return d.tool ? `${d.model} via ${d.tool}` : d.model;
}
