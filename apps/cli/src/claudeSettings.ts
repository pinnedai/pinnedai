// Claude Code settings installer — wires `pinned statusline` into the
// `.claude/settings.json` statusLine config, and `pinned hook-failure`
// into the UserPromptSubmit hook.
//
// Idempotent: if Pinned commands are already present, we leave them
// alone. If the user has their own statusLine command, we DON'T
// override it without consent — return "conflict" instead.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  renameSync,
} from "node:fs";
import { join, dirname } from "node:path";

// Claude Code's settings.json schema. Two corrections vs an earlier
// shape we used to write (and which Claude Code silently ignored):
//
//   1. statusLine requires `type: "command"` alongside the command
//      string — without `type`, Claude Code skips rendering.
//   2. Each hooks.UserPromptSubmit (and PreToolUse / PostToolUse) entry
//      is a wrapper object `{ matcher, hooks: [{ type, command }] }`,
//      NOT a flat `{ command, matcher }`. The wrapper carries one or
//      more inner hooks; only the inner objects have `type` + `command`.
type ClaudeHookCommand = { type: "command"; command: string };
type ClaudeHookEntry = { matcher?: string; hooks: ClaudeHookCommand[] };
type ClaudeSettings = {
  statusLine?: { type?: "command"; command?: string; padding?: number };
  hooks?: {
    UserPromptSubmit?: ClaudeHookEntry[];
    PreToolUse?: ClaudeHookEntry[];
    PostToolUse?: ClaudeHookEntry[];
  };
  [k: string]: unknown;
};

export type ClaudeInstallResult =
  | { status: "installed"; path: string }
  | { status: "already-installed"; path: string }
  | { status: "conflict"; path: string; reason: string };

const STATUSLINE_CMD = "node ./apps/cli/dist/cli.js statusline";
const STATUSLINE_FALLBACK_CMD = "npx pinnedai statusline";
const HOOK_CMD = "node ./apps/cli/dist/cli.js hook-failure";
const HOOK_FALLBACK_CMD = "npx pinnedai hook-failure";

function settingsPath(repoRoot: string): string {
  return join(repoRoot, ".claude", "settings.json");
}

function readSettings(path: string): ClaudeSettings {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ClaudeSettings;
  } catch {
    return {};
  }
}

// Write settings safely. The .bak must always be the user's TRUE
// pre-Pinned state, never a half-installed snapshot from earlier in
// this same process. Constraints:
//
//   (a) If the file did not exist at the start of this process, do NOT
//       write a .bak — Pinned created the file from scratch, there is
//       nothing of the user's to preserve.
//   (b) If a .bak already exists from a prior `pinned init` run, do NOT
//       overwrite it. That .bak is the gold copy of the user's true
//       original; we never want to clobber it with a re-installed state.
//   (c) Use atomic temp+rename so a kill mid-write cannot leave a
//       half-truncated settings.json.
//
// `filesTouchedThisProcess` ensures install steps that share a process
// (statusline + failure hook in the same `pinned init`) cooperate: the
// first install captures the user's original; the second install adds
// to the same target without re-capturing the now-Pinned-touched file.
const filesTouchedThisProcess = new Set<string>();

function writeSettingsAtomic(path: string, settings: ClaudeSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  if (
    !filesTouchedThisProcess.has(path) &&
    existsSync(path) &&
    !existsSync(path + ".bak")
  ) {
    try {
      copyFileSync(path, path + ".bak");
    } catch {
      // best-effort; do not block install on a backup error
    }
  }
  filesTouchedThisProcess.add(path);
  const tmp = path + ".tmp-" + process.pid;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
  renameSync(tmp, path);
}

function detectBinCmd(repoRoot: string, full: string, fallback: string): string {
  // Use the workspace-local CLI if it's been built (dogfood case), else
  // fall back to `npx pinnedai` which works in a customer repo that
  // installed the package.
  return existsSync(join(repoRoot, "apps", "cli", "dist", "cli.js"))
    ? full
    : fallback;
}

// Marker recognizing OUR own compose-wrapper. Lets us re-detect a
// wrapper that we wrote and either leave it alone (idempotent) or
// re-compose it when an upstream tool's command changes.
const COMPOSE_WRAPPER_MARKER = "# pinnedai:statusline-compose";
const COMPOSE_WRAPPER_PATH = ".pinnedai/statusline-combined.sh";

// Write (or refresh) a small shell wrapper that runs BOTH commands
// and joins their outputs with " · ". The wrapper itself is the new
// statusLine.command. Used when something else (e.g. Cipherwake) has
// already written a statusLine command — instead of clobbering or
// returning "conflict", we compose. Idempotent + safe to re-run.
function writeComposeWrapper(repoRoot: string, otherCmd: string, pinnedCmd: string): string {
  const wrapperRel = COMPOSE_WRAPPER_PATH;
  const wrapperFull = join(repoRoot, wrapperRel);
  const wrapperDir = dirname(wrapperFull);
  if (!existsSync(wrapperDir)) {
    mkdirSync(wrapperDir, { recursive: true });
  }
  // Both commands run in their own subshell to isolate exit codes;
  // empty output is OK. Outputs are joined with " · " only when both
  // are non-empty, so a silent tool doesn't leave a dangling separator.
  const content = `#!/bin/sh
${COMPOSE_WRAPPER_MARKER}
# Auto-generated by pinnedai. Runs both statusLine producers and
# joins their outputs with " · ". To restore a single producer, edit
# Claude Code settings (.claude/settings.json) → statusLine.command.
set -u
PINNED_OUT="$(${pinnedCmd} 2>/dev/null || true)"
OTHER_OUT="$(${otherCmd} 2>/dev/null || true)"
if [ -n "$PINNED_OUT" ] && [ -n "$OTHER_OUT" ]; then
  printf "%s · %s" "$PINNED_OUT" "$OTHER_OUT"
elif [ -n "$PINNED_OUT" ]; then
  printf "%s" "$PINNED_OUT"
elif [ -n "$OTHER_OUT" ]; then
  printf "%s" "$OTHER_OUT"
fi
`;
  writeFileSync(wrapperFull, content);
  try {
    // chmod +x so Claude Code can execute it. 0o755 = rwxr-xr-x.
    require("node:fs").chmodSync(wrapperFull, 0o755);
  } catch {
    /* non-fatal */
  }
  return wrapperRel;
}

// Detect whether a given command line points at OUR compose wrapper.
function isComposeWrapper(cmd: string | undefined): boolean {
  if (!cmd) return false;
  return cmd.includes(COMPOSE_WRAPPER_PATH);
}

// Inspect a compose wrapper and extract the "other" command it wraps,
// so we can rebuild the wrapper if either command needs to change.
function readComposeWrapperOtherCmd(repoRoot: string): string | null {
  const wrapperFull = join(repoRoot, COMPOSE_WRAPPER_PATH);
  if (!existsSync(wrapperFull)) return null;
  try {
    const content = readFileSync(wrapperFull, "utf8");
    const m = /OTHER_OUT="\$\(([^)]+) 2>\/dev\/null \|\| true\)"/.exec(content);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export function installClaudeStatusline(repoRoot: string): ClaudeInstallResult {
  const path = settingsPath(repoRoot);
  const settings = readSettings(path);
  const desiredCmd = detectBinCmd(repoRoot, STATUSLINE_CMD, STATUSLINE_FALLBACK_CMD);

  const current = settings.statusLine?.command;

  // Case 1: Pinned's plain command already set — nothing to do.
  if (current && current.includes("pinned") && current.includes("statusline") && !isComposeWrapper(current)) {
    return { status: "already-installed", path };
  }

  // Case 2: Existing compose-wrapper. We're already part of it; verify
  // the wrapper is current (might need re-write if Pinned's bin path
  // changed). Leave the "other" command alone.
  if (isComposeWrapper(current)) {
    const otherCmd = readComposeWrapperOtherCmd(repoRoot);
    if (otherCmd) {
      writeComposeWrapper(repoRoot, otherCmd, desiredCmd);
    }
    return { status: "already-installed", path };
  }

  // Case 3: Third-party statusLine already set (Cipherwake, custom,
  // etc.). Compose instead of clobber. Write a wrapper that runs both,
  // point Claude at the wrapper.
  if (current && !current.includes("pinned")) {
    const wrapperRel = writeComposeWrapper(repoRoot, current, desiredCmd);
    settings.statusLine = {
      type: "command",
      command: `sh ${wrapperRel}`,
      padding: settings.statusLine?.padding,
    };
    writeSettingsAtomic(path, settings);
    return {
      status: "installed",
      path,
    };
  }

  // Case 4: Nothing set — install Pinned's command directly.
  settings.statusLine = { type: "command", command: desiredCmd };
  writeSettingsAtomic(path, settings);
  return { status: "installed", path };
}

// 0.2.12+: counterpart to installClaudeStatusline. Removes the
// Pinned-managed statusline entry from .claude/settings.json. Three
// shapes to handle, mirroring the install logic:
//   1. Plain Pinned command — delete statusLine entirely (Claude
//      reverts to its default).
//   2. Compose wrapper — read the "other" command from the wrapper,
//      restore it as the bare statusLine command, delete the wrapper
//      script file.
//   3. Third-party command (Pinned was never the statusline) — no-op.
//
// Returns "removed" when we actually changed something, "absent" when
// nothing pinned-shaped was present.
export function uninstallClaudeStatusline(repoRoot: string): "removed" | "absent" {
  const path = settingsPath(repoRoot);
  const settings = readSettings(path);
  const current = settings.statusLine?.command;
  if (!current) return "absent";

  // Case 1: plain Pinned command.
  if (current.includes("pinned") && current.includes("statusline") && !isComposeWrapper(current)) {
    delete (settings as { statusLine?: unknown }).statusLine;
    writeSettingsAtomic(path, settings);
    return "removed";
  }

  // Case 2: compose wrapper combining Pinned with another tool.
  if (isComposeWrapper(current)) {
    const otherCmd = readComposeWrapperOtherCmd(repoRoot);
    if (otherCmd) {
      settings.statusLine = { type: "command", command: otherCmd, padding: settings.statusLine?.padding };
    } else {
      delete (settings as { statusLine?: unknown }).statusLine;
    }
    writeSettingsAtomic(path, settings);
    // Best-effort delete of the wrapper script file.
    try {
      const wrapperPath = `${repoRoot}/.pinnedai/statusline-combined.sh`;
      const fs = require("node:fs") as typeof import("node:fs");
      if (fs.existsSync(wrapperPath)) fs.unlinkSync(wrapperPath);
    } catch { /* non-fatal */ }
    return "removed";
  }

  // Case 3: third-party command, never Pinned-managed.
  return "absent";
}

export function installClaudeFailureHook(repoRoot: string): ClaudeInstallResult {
  const path = settingsPath(repoRoot);
  const settings = readSettings(path);
  const desiredCmd = detectBinCmd(repoRoot, HOOK_CMD, HOOK_FALLBACK_CMD);

  const hooks = settings.hooks ?? {};
  const existing = hooks.UserPromptSubmit ?? [];
  // Walk the wrapper-and-inner-hooks shape; an entry counts as Pinned
  // if any inner hook's command references pinned + hook-failure.
  const alreadyHasPinned = existing.some((entry) =>
    (entry?.hooks ?? []).some(
      (h) =>
        typeof h?.command === "string" &&
        h.command.includes("pinned") &&
        h.command.includes("hook-failure")
    )
  );
  if (alreadyHasPinned) {
    return { status: "already-installed", path };
  }
  hooks.UserPromptSubmit = [
    ...existing,
    {
      matcher: "",
      hooks: [{ type: "command", command: desiredCmd }],
    },
  ];
  settings.hooks = hooks;
  writeSettingsAtomic(path, settings);
  return { status: "installed", path };
}

export function isClaudeStatuslineInstalled(repoRoot: string): boolean {
  const path = settingsPath(repoRoot);
  if (!existsSync(path)) return false;
  const settings = readSettings(path);
  const cmd = settings.statusLine?.command ?? "";
  // Direct install OR via the compose-wrapper both count as installed.
  if (cmd.includes("pinned") && cmd.includes("statusline")) return true;
  if (isComposeWrapper(cmd)) {
    // Verify the wrapper file exists and references Pinned's statusline
    // command (defensive — a malformed wrapper shouldn't claim install).
    const wrapperFull = join(repoRoot, COMPOSE_WRAPPER_PATH);
    if (!existsSync(wrapperFull)) return false;
    try {
      const content = readFileSync(wrapperFull, "utf8");
      return content.includes("pinned") && content.includes("statusline");
    } catch {
      return false;
    }
  }
  return false;
}
