// AI-agent-config injection — points Claude / Cursor / Copilot / etc.
// at .pinned/ai-lessons.md so they actually READ the lessons.
//
// Without this, the lessons file is documentation no agent ever sees.
// See [[strategic-pivot-guard-integrity]] for the load-bearing reason.
//
// Operates idempotently: re-running doesn't duplicate the injected
// block. Detection is best-effort — if an agent's config file doesn't
// exist, that agent simply doesn't get wired (we don't create files
// for tools the user isn't using). Exception: if NO config exists,
// `pinned init` creates `CLAUDE.md` by default (most common AI coder).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

// Distinctive marker bracketing the Pinned-managed block so we can
// idempotently update it without disturbing the rest of the file.
const BEGIN_MARK = "<!-- pinned:agent-rules:begin -->";
const END_MARK = "<!-- pinned:agent-rules:end -->";

const PINNED_BLOCK_BODY = `## Pinned AI Lessons

Before making changes, read \`.pinned/ai-lessons.md\` for repo-specific rules
learned from past bug fixes and Guard Integrity violations.

Pinned guards rules (these will fail CI if you break them):

- Do not weaken, skip, or delete any test in \`tests/pinned/\`.
- Do not add \`.skip()\`, \`.only()\`, \`xit()\`, \`.todo()\`, or \`.skipIf(true)\` to pinned tests.
- Do not replace exact-value assertions (e.g. \`toBe(401)\`) with loose ones (\`toBeTruthy()\`, \`toBeDefined()\`, \`expect(true).toBe(true)\`).
- Do not add \`|| true\`, \`?? true\`, or \`.catch(() => true)\` to bypass failing assertions.
- Do not delete or disable \`.github/workflows/pinned.yml\` or modify \`tests/pinned/.registry.json\` by hand.
- To retire a pin legitimately, run \`pinned retire <claim-id> --reason="..."\` — never delete or rename manually.

If a pinned test fails, FIX THE APPLICATION CODE. Do not modify the test.
`;

export type AgentConfigTarget = {
  /** Display label used in CLI output. */
  name: string;
  /** Path relative to repo root. */
  path: string;
  /** What we create the file with if missing (only used in "create-if-absent" mode). */
  defaultContent: string;
};

// The canonical list. Ordered by approximate AI-coder market share —
// when no configs exist, we create CLAUDE.md first (most common).
export const KNOWN_AGENT_TARGETS: AgentConfigTarget[] = [
  {
    name: "Claude Code",
    path: "CLAUDE.md",
    defaultContent: "# CLAUDE.md\n\nProject instructions for Claude Code.\n\n",
  },
  {
    name: "Cursor (legacy)",
    path: ".cursorrules",
    defaultContent: "",
  },
  {
    name: "Cursor (rules dir)",
    path: ".cursor/rules/pinned.mdc",
    defaultContent: "---\ndescription: Pinned guard rules\nalwaysApply: true\n---\n\n",
  },
  {
    name: "GitHub Copilot",
    path: ".github/copilot-instructions.md",
    defaultContent: "# Copilot Instructions\n\n",
  },
  {
    name: "Aider",
    path: "CONVENTIONS.md",
    defaultContent: "# CONVENTIONS.md\n\nProject conventions.\n\n",
  },
  {
    name: "Cline",
    path: ".clinerules",
    defaultContent: "",
  },
  {
    name: "Generic agents",
    path: "AGENTS.md",
    defaultContent: "# AGENTS.md\n\nInstructions for AI coding agents.\n\n",
  },
];

export type WireResult = {
  target: AgentConfigTarget;
  /** "added" — new file created. "updated" — existing block replaced. "appended" — file existed, no block previously. "unchanged" — block already matched. "skipped" — file did not exist and createIfAbsent=false. */
  action: "added" | "updated" | "appended" | "unchanged" | "skipped";
};

export type WireOptions = {
  repoRoot?: string;
  /**
   * MUST be explicitly true for `wireAgents` to touch ANY agent file
   * (CLAUDE.md, .cursorrules, etc.). Default false. Users opt in via
   * `pinned install-agent-rules`. Pinned-owned files in `.pinned/`
   * are written elsewhere (aiLessons.ts) and are NOT gated by this.
   *
   * Per the 2026-05-23 UX principle: Pinned must never silently
   * modify user-owned agent config files. Doing so is more invasive
   * than the value justifies.
   */
  installAgentRules?: boolean;
  /**
   * If true, create the FIRST target file (Claude Code's) when
   * nothing exists. Only honored when installAgentRules is also true.
   */
  createIfAbsent?: boolean;
  /** If true, only operate on this single target path (relative to repoRoot). Still gated by installAgentRules. */
  onlyPath?: string;
};

function buildBlock(): string {
  return `${BEGIN_MARK}\n${PINNED_BLOCK_BODY}${END_MARK}\n`;
}

function applyToFile(absPath: string, defaultContent: string, exists: boolean): WireResult["action"] {
  const block = buildBlock();
  if (!exists) {
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, defaultContent + block);
    return "added";
  }
  const body = readFileSync(absPath, "utf8");
  const beginIdx = body.indexOf(BEGIN_MARK);
  if (beginIdx === -1) {
    // Append the block to the end (preserve a newline gap)
    const sep = body.endsWith("\n\n") ? "" : body.endsWith("\n") ? "\n" : "\n\n";
    writeFileSync(absPath, body + sep + block);
    return "appended";
  }
  const endIdx = body.indexOf(END_MARK, beginIdx);
  if (endIdx === -1) {
    // Malformed (begin without end) — replace from begin to EOF
    writeFileSync(absPath, body.slice(0, beginIdx) + block);
    return "updated";
  }
  const currentBlock = body.slice(beginIdx, endIdx + END_MARK.length);
  const desiredBlock = block.replace(/\n$/, "");
  if (currentBlock === desiredBlock) return "unchanged";
  writeFileSync(absPath, body.slice(0, beginIdx) + desiredBlock + body.slice(endIdx + END_MARK.length));
  return "updated";
}

export function wireAgents(opts: WireOptions = {}): WireResult[] {
  const root = opts.repoRoot ?? process.cwd();
  const results: WireResult[] = [];

  // Hard gate: writes to user-owned agent files require explicit opt-in.
  // No flag = no writes. This is the load-bearing UX rule.
  if (opts.installAgentRules !== true) {
    for (const t of KNOWN_AGENT_TARGETS) results.push({ target: t, action: "skipped" });
    return results;
  }

  // Single-path mode (used by `pinned install-agent-rules --path FOO`)
  if (opts.onlyPath) {
    const target = KNOWN_AGENT_TARGETS.find((t) => t.path === opts.onlyPath) ?? {
      name: "custom",
      path: opts.onlyPath,
      defaultContent: "",
    };
    const abs = join(root, target.path);
    const action = applyToFile(abs, target.defaultContent, existsSync(abs));
    results.push({ target, action });
    return results;
  }

  // Detect what exists. If nothing exists AND createIfAbsent, create the first target (CLAUDE.md).
  const anyExists = KNOWN_AGENT_TARGETS.some((t) => existsSync(join(root, t.path)));
  for (const t of KNOWN_AGENT_TARGETS) {
    const abs = join(root, t.path);
    const exists = existsSync(abs);
    if (!exists) {
      const shouldBootstrap = !anyExists && opts.createIfAbsent === true && t.path === KNOWN_AGENT_TARGETS[0].path;
      if (!shouldBootstrap) {
        results.push({ target: t, action: "skipped" });
        continue;
      }
    }
    const action = applyToFile(abs, t.defaultContent, exists);
    results.push({ target: t, action });
  }
  return results;
}

// Does this agent file currently carry our Pinned-managed block?
// Used by `pinned uninstall` to plan removal AND to verify post-state.
export function hasPinnedAgentBlock(absPath: string): boolean {
  if (!existsSync(absPath)) return false;
  try {
    return readFileSync(absPath, "utf8").includes(BEGIN_MARK);
  } catch {
    return false;
  }
}

// Remove the Pinned-managed block from an agent file. Used by
// `pinned uninstall-agent-rules`. Preserves any other content.
export function unwireAgent(absPath: string): "removed" | "not-found" | "no-block" {
  if (!existsSync(absPath)) return "not-found";
  const body = readFileSync(absPath, "utf8");
  const beginIdx = body.indexOf(BEGIN_MARK);
  if (beginIdx === -1) return "no-block";
  const endIdx = body.indexOf(END_MARK, beginIdx);
  if (endIdx === -1) {
    writeFileSync(absPath, body.slice(0, beginIdx).trimEnd() + "\n");
    return "removed";
  }
  const after = body.slice(endIdx + END_MARK.length);
  writeFileSync(absPath, (body.slice(0, beginIdx).trimEnd() + after).replace(/^\n+/, "") || "");
  return "removed";
}

// Report which agent files currently have the Pinned block. Used by
// `pinned agent-rules status` so users see what's wired.
export type WireStatus = { target: AgentConfigTarget; exists: boolean; hasPinnedBlock: boolean };

export function statusAgents(repoRoot?: string): WireStatus[] {
  const root = repoRoot ?? process.cwd();
  return KNOWN_AGENT_TARGETS.map((target) => {
    const abs = join(root, target.path);
    const exists = existsSync(abs);
    const hasPinnedBlock = exists && readFileSync(abs, "utf8").includes(BEGIN_MARK);
    return { target, exists, hasPinnedBlock };
  });
}
