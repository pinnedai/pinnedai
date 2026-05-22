// pinnedai per-repo config. Lives at `.pinnedai/config.json` at the
// repo root (NOT under tests/pinned/, because the config governs
// behavior across the whole repo, not just the pin registry).
//
// auto_protect mode — three levels of automation:
//
//   "safe":  classifier auto-adds pins for deterministic, low-risk
//            behaviors (CLI exits-zero, CLI flag exists, etc.). Skips
//            anything that needs business-context to test (rate limits,
//            idempotency keys, specific output strings).
//   "ask":   classifier writes a suggestions cache; statusline shows
//            `+N suggested`; user runs `pinned protect` to approve.
//            Never writes test files without explicit user confirmation.
//   "off":   classifier never runs. No suggestions surface. Pin count
//            grows only when the user explicitly runs `pinned generate`
//            or accepts via `pinned protect`.
//
// Default: "safe" for solo AI-coder repos (chosen during `pinned init`).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

export type AutoProtectMode = "safe" | "ask" | "off";

export type PinnedConfig = {
  version: 1;
  auto_protect: AutoProtectMode;
  // Hard cap on how many pins auto-protect may add per invocation.
  // Protects against a runaway diff dumping 50 generated tests.
  // Documented at config write time so the value is visible.
  safety_budget_per_run: number;
  // Whether the statusline should show "changes pending" when the
  // working tree differs from the last-checked snapshot. Without
  // `pinned watch` running, this state persists between commits — so
  // users who find it noisy can set false to fall through to the
  // cached green/red status with age instead.
  show_pending_changes: boolean;
  // Minimum number of Pinned-relevant changed files before the chat
  // hook fires a background auto-protect run. Below this, the queue
  // accumulates ("N to review" in the statusline) without triggering
  // work. High-risk paths (admin routes, webhooks, middleware, env
  // files) bypass this threshold and fire immediately. Default 10 —
  // 3 felt too twitchy in normal AI-coding; 10 is calmer.
  auto_review_threshold: number;
  // Whether the statusline surfaces "N to review" / "active editing"
  // when there are Pinned-relevant uncommitted changes. Default true.
  // Disable if you find the count distracting — the chat hook will
  // still auto-trigger reviews under the threshold, and `pinned review`
  // still works manually. With false, the statusline only shows ✓ in
  // the calm-green state regardless of pending edits.
  show_review_count: boolean;
  // Statusline visibility mode. Controls what shows in the calm states.
  //   "all":     default — always show ✓ / N to review / active editing /
  //              transient celebrations / actionable warnings.
  //   "minimal": ONLY show the line when something is actionable or worth
  //              celebrating — broken pins, caught regressions, risks,
  //              suggestions, newly-added pins. The default green state
  //              and "N to review" / "active editing" return empty
  //              output (which Claude Code + the VS Code extension treat
  //              as "hide the item"). For users who find the always-on
  //              indicator distracting.
  statusline_mode: "all" | "minimal";
};

export const CONFIG_DIRNAME = ".pinnedai";
export const CONFIG_FILENAME = "config.json";

export const DEFAULT_CONFIG: PinnedConfig = {
  version: 1,
  auto_protect: "safe",
  safety_budget_per_run: 5,
  // Default OFF — without `pinned watch` running, "changes pending"
  // would show ~90% of the time, which is noise. Users who want the
  // live drift indicator can flip this to true.
  show_pending_changes: false,
  // 10 is calmer than 3 — Cursor/Claude can touch 3 files in one
  // small change and we don't want Pinned to feel constantly "reviewing."
  auto_review_threshold: 10,
  // Whether the statusline should surface "N to review" when there
  // are Pinned-relevant uncommitted changes. Default true. Set false
  // if you find the count distracting — the chat hook still triggers
  // auto-protect under the threshold, and `pinned review` still works.
  show_review_count: true,
  statusline_mode: "all",
};

export function configPath(repoRoot: string): string {
  return join(repoRoot, CONFIG_DIRNAME, CONFIG_FILENAME);
}

export function readConfig(repoRoot: string): PinnedConfig {
  const path = configPath(repoRoot);
  if (!existsSync(path)) return DEFAULT_CONFIG;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PinnedConfig>;
    const mode = isValidMode(raw.auto_protect) ? raw.auto_protect : DEFAULT_CONFIG.auto_protect;
    const budget =
      typeof raw.safety_budget_per_run === "number" && raw.safety_budget_per_run >= 0
        ? raw.safety_budget_per_run
        : DEFAULT_CONFIG.safety_budget_per_run;
    const showPending =
      typeof raw.show_pending_changes === "boolean"
        ? raw.show_pending_changes
        : DEFAULT_CONFIG.show_pending_changes;
    const threshold =
      typeof raw.auto_review_threshold === "number" &&
      raw.auto_review_threshold >= 1
        ? raw.auto_review_threshold
        : DEFAULT_CONFIG.auto_review_threshold;
    const showReviewCount =
      typeof raw.show_review_count === "boolean"
        ? raw.show_review_count
        : DEFAULT_CONFIG.show_review_count;
    const statuslineMode =
      raw.statusline_mode === "all" || raw.statusline_mode === "minimal"
        ? raw.statusline_mode
        : DEFAULT_CONFIG.statusline_mode;
    return {
      version: 1,
      auto_protect: mode,
      safety_budget_per_run: budget,
      show_pending_changes: showPending,
      auto_review_threshold: threshold,
      show_review_count: showReviewCount,
      statusline_mode: statuslineMode,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function writeConfig(repoRoot: string, config: PinnedConfig): void {
  const path = configPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
}

function isValidMode(m: unknown): m is AutoProtectMode {
  return m === "safe" || m === "ask" || m === "off";
}

// Human-readable label for the mode — used in statusline + prompts.
export function modeLabel(m: AutoProtectMode): string {
  switch (m) {
    case "safe":
      return "auto-protect: safe (recommended)";
    case "ask":
      return "auto-protect: ask before adding";
    case "off":
      return "auto-protect: manual only";
  }
}

// Env-var override — useful for CI ("PINNEDAI_AUTO_PROTECT=off") and for
// users who want to disable auto-protect for one run without editing
// the config file.
export function effectiveMode(repoRoot: string): AutoProtectMode {
  const envOverride = (process.env.PINNEDAI_AUTO_PROTECT ?? "").toLowerCase();
  if (isValidMode(envOverride)) return envOverride;
  return readConfig(repoRoot).auto_protect;
}
