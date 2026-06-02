// Git hook installers — `pre-commit` and `pre-push`.
//
// Both hooks are idempotent: identified by a `# pinnedai:<name>` marker
// line in the script body. If the marker is present, the hook is left
// alone; if absent, we either create the hook or append our line to it.
// Removal scans for the marker and rewrites the file without it.
//
// Why both:
//   pre-commit  → runs on `git commit`. Auto-adds safe pins to the
//                 staged set so they ship in the same commit. The
//                 "feel alive" moment for solo AI coders.
//   pre-push    → runs on `git push`. Backstop in case auto-add was
//                 skipped (e.g. commit via `git commit --no-verify`).
//                 Currently used for `pinned scan` suggestions in PRs.
//
// Defense: never overwrite an existing hook without the marker. If
// the user already has a pre-commit hook, we append a marker block at
// the end. If they want clean uninstall, we only remove our block.

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, chmodSync } from "node:fs";
import { join } from "node:path";

const MARKER_START_PREFIX = "# pinnedai:";
const MARKER_END = "# pinnedai:end";

export type HookName = "pre-commit" | "pre-push" | "post-commit";

// Script body for each hook. Kept minimal — calls the installed CLI,
// which decides what to do based on the config. Hook never edits files
// itself (other than what the CLI writes).
const HOOK_BODIES: Record<HookName, string> = {
  "pre-commit": [
    `#!/bin/sh`,
    `# pinnedai:pre-commit`,
    `# Runs the auto-protect classifier against staged files.`,
    `# In safe mode: auto-adds pins for deterministic behaviors.`,
    `# In ask mode: writes suggestion count to the cache.`,
    `# In off mode: no-op.`,
    `# Set PINNEDAI_SKIP_HOOK=1 to bypass for one commit.`,
    `if [ "$PINNEDAI_SKIP_HOOK" = "1" ]; then exit 0; fi`,
    `if ! command -v node >/dev/null 2>&1; then exit 0; fi`,
    `# Resolve the installed CLI. Search order:`,
    `#   1. apps/cli/dist/cli.js (our monorepo dogfood layout)`,
    `#   2. node_modules/pinnedai/dist/cli.js (customer npm install)`,
    `#   3. \`pinned\` on PATH (global install)`,
    `#   4. \`npx --no-install pinnedai\` (npm cache / workspace link)`,
    `# Falls through to silent no-op only if all four fail.`,
    `if [ -f "apps/cli/dist/cli.js" ]; then`,
    `  PINNED_BIN="node ./apps/cli/dist/cli.js"`,
    `elif [ -f "node_modules/pinnedai/dist/cli.js" ]; then`,
    `  PINNED_BIN="node ./node_modules/pinnedai/dist/cli.js"`,
    `elif command -v pinned >/dev/null 2>&1; then`,
    `  PINNED_BIN="pinned"`,
    `elif command -v npx >/dev/null 2>&1 && npx --no-install pinnedai --version >/dev/null 2>&1; then`,
    `  PINNED_BIN="npx --no-install pinnedai"`,
    `else`,
    `  exit 0  # pinned not installed — silent no-op (don't break commits)`,
    `fi`,
    `# --auto-stage tells auto-protect to git-add only the files it`,
    `# itself authored this run (newly-created pin .test.ts + .registry.json`,
    `# + PINS.md). Pre-0.2.7 the shell hook did a blanket`,
    `# \`git add tests/pinned/\` — which silently bundled any unrelated`,
    `# change in tests/pinned/ into the user's commit. Narrowing it to`,
    `# Pinned's own writes + announcing what got staged fixes that.`,
    `$PINNED_BIN auto-protect --base WORKING_TREE --auto-stage --quiet 2>&1 | grep -v "^◆ pinned" || true`,
    `# GUARD: prevent AI agents from silently removing/modifying/weakening`,
    `# pinned tests. Delegates to the TS subcommand which has full logic:`,
    `#   - Allows retire-flow deletions (D paired with retired/<base>.test.ts A)`,
    `#   - Blocks plain deletions, modifications, and content-weakening (.skip,`,
    `#     xit, expect(true).toBe(true), expect.assertions(0), early returns)`,
    `#   - Honors .pinnedai/regenerate-allow.json (5-min TTL) so auto-protect's`,
    `#     own writes to .registry.json + PINS.md don't trip the guard.`,
    `#   - Bypass: PINNEDAI_ALLOW_PIN_EDIT=1 (one commit, no audit)`,
    `# Exits 2 on violations — block the commit.`,
    `$PINNED_BIN check-guard-removal --quiet || exit $?`,
    `${MARKER_END}`,
  ].join("\n"),

  "pre-push": [
    `#!/bin/sh`,
    `# pinnedai:pre-push`,
    `# Runs scan + auto-protect against commits being pushed.`,
    `# Non-blocking: failures here never block a push.`,
    `if [ "$PINNEDAI_SKIP_HOOK" = "1" ]; then exit 0; fi`,
    `if ! command -v node >/dev/null 2>&1; then exit 0; fi`,
    `if [ -f "apps/cli/dist/cli.js" ]; then`,
    `  PINNED_BIN="node ./apps/cli/dist/cli.js"`,
    `elif [ -f "node_modules/pinnedai/dist/cli.js" ]; then`,
    `  PINNED_BIN="node ./node_modules/pinnedai/dist/cli.js"`,
    `elif command -v pinned >/dev/null 2>&1; then`,
    `  PINNED_BIN="pinned"`,
    `elif command -v npx >/dev/null 2>&1 && npx --no-install pinnedai --version >/dev/null 2>&1; then`,
    `  PINNED_BIN="npx --no-install pinnedai"`,
    `else`,
    `  exit 0`,
    `fi`,
    `# --auto-stage: narrow staging to files Pinned itself authored.`,
    `# See pre-commit hook comment for the rationale.`,
    `$PINNED_BIN auto-protect --base WORKING_TREE --auto-stage --quiet 2>&1 | grep -v "^◆ pinned" || true`,
    `# GUARD: backstop in case pre-commit was bypassed with --no-verify.`,
    `# Same logic as the pre-commit guard. Push aborts on violations.`,
    `$PINNED_BIN check-guard-removal --quiet || exit $?`,
    `${MARKER_END}`,
  ].join("\n"),

  // Post-commit — runs `pinned test` in the BACKGROUND after every
  // commit. This is the auto-verification path that makes pins
  // actually catch regressions without the user wiring CI manually.
  //
  // Design:
  //   - Throttled (≥ 2 min between runs) via a marker file
  //     `.pinnedai/.last-auto-test` so rapid-fire commits don't thrash
  //   - Backgrounded (`&`) so commit returns immediately
  //   - Skips silently if no tests/pinned/ directory or no pins yet
  //   - `pinned test` itself handles missing PREVIEW_URL gracefully
  //     by treating affected tests as skipped, not failed
  //   - Stdout/stderr go to /dev/null so background run is invisible
  //   - Cache update reflects new green/failing state for next chat
  //     hook fire to surface
  "post-commit": [
    `#!/bin/sh`,
    `# pinnedai:post-commit`,
    `# Runs \`pinned test\` in the background after every commit so`,
    `# pins are continuously verified without wiring CI manually.`,
    `# Throttled to once per 2 minutes via .pinnedai/.last-auto-test.`,
    `# Set PINNEDAI_SKIP_HOOK=1 to bypass.`,
    `if [ "$PINNEDAI_SKIP_HOOK" = "1" ]; then exit 0; fi`,
    `if [ ! -d "tests/pinned" ]; then exit 0; fi`,
    `if ! command -v node >/dev/null 2>&1; then exit 0; fi`,
    `# Skip during rebase / cherry-pick / merge — each step in those`,
    `# operations fires post-commit, and we'd spawn one test run per step.`,
    `# A 50-commit rebase would queue 50 background runs (throttled, but still`,
    `# wasteful). The user can run pinned test manually when the operation finishes.`,
    `if [ -d ".git/rebase-merge" ] || [ -d ".git/rebase-apply" ] || \\`,
    `   [ -f ".git/CHERRY_PICK_HEAD" ] || [ -f ".git/MERGE_HEAD" ]; then exit 0; fi`,
    `# Throttle — skip if last run was < 120s ago.`,
    `THROTTLE_FILE=".pinnedai/.last-auto-test"`,
    `if [ -f "$THROTTLE_FILE" ]; then`,
    `  LAST=$(cat "$THROTTLE_FILE" 2>/dev/null || echo 0)`,
    `  NOW=$(date +%s)`,
    `  DELTA=$((NOW - LAST))`,
    `  if [ "$DELTA" -lt 120 ]; then exit 0; fi`,
    `fi`,
    `# Resolve the CLI binary (same fallback chain as the other hooks).`,
    `if [ -f "apps/cli/dist/cli.js" ]; then`,
    `  PINNED_BIN="node ./apps/cli/dist/cli.js"`,
    `elif [ -f "node_modules/pinnedai/dist/cli.js" ]; then`,
    `  PINNED_BIN="node ./node_modules/pinnedai/dist/cli.js"`,
    `elif command -v pinned >/dev/null 2>&1; then`,
    `  PINNED_BIN="pinned"`,
    `elif command -v npx >/dev/null 2>&1 && npx --no-install pinnedai --version >/dev/null 2>&1; then`,
    `  PINNED_BIN="npx --no-install pinnedai"`,
    `else`,
    `  exit 0`,
    `fi`,
    `mkdir -p .pinnedai`,
    `date +%s > "$THROTTLE_FILE"`,
    `# Fire in background — disown so commit completes immediately.`,
    `nohup $PINNED_BIN test --quiet >/dev/null 2>&1 &`,
    `${MARKER_END}`,
  ].join("\n"),
};

function hookPath(repoRoot: string, name: HookName): string {
  return join(repoRoot, ".git", "hooks", name);
}

function markerStart(name: HookName): string {
  return `${MARKER_START_PREFIX}${name}`;
}

export type HookInstallResult =
  | { status: "installed"; path: string }
  | { status: "appended"; path: string }
  | { status: "already-installed"; path: string }
  | { status: "no-git"; path: string }
  | { status: "conflict"; path: string; reason: string };

export function installHook(repoRoot: string, name: HookName): HookInstallResult {
  const gitDir = join(repoRoot, ".git");
  if (!existsSync(gitDir)) {
    return { status: "no-git", path: hookPath(repoRoot, name) };
  }
  const hooksDir = join(gitDir, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const path = hookPath(repoRoot, name);
  const body = HOOK_BODIES[name];
  const startMarker = markerStart(name);

  if (!existsSync(path)) {
    writeFileSync(path, body + "\n");
    chmodSync(path, 0o755);
    return { status: "installed", path };
  }

  const existing = readFileSync(path, "utf8");
  if (existing.includes(startMarker)) {
    return { status: "already-installed", path };
  }
  // DEAD-CODE DETECTION: if the existing hook ends with terminal exits
  // (e.g. a Cipherwake / husky / lefthook block whose case-statement
  // exits in every branch), appending our block would make it dead code.
  // Discovered 2026-05-25 when Pinned's pre-push block was appended
  // after a Cipherwake hook that exited unconditionally — Pinned's
  // guard-removal check then never ran.
  const lastLogical = existing
    .split("\n")
    .map((l) => l.replace(/^\s*#.*$/, "").trim())
    .filter((l) => l.length > 0)
    .slice(-10)
    .join("\n");
  const hasTerminalExitPattern =
    /\b(?:exit|return)\s+\d*\s*$/.test(lastLogical) ||
    (/\bcase\b/.test(lastLogical) &&
      /\besac\s*$/.test(lastLogical) &&
      (lastLogical.match(/\bexit\b/g) ?? []).length >= 2);
  if (hasTerminalExitPattern) {
    // Don't silently install dead code. Refuse with clear next-steps.
    return {
      status: "conflict",
      path,
      reason:
        "existing hook ends with terminal exit pattern (case/exit) — appending Pinned's block would make it dead code. " +
        "Manually integrate Pinned's hook content. Run `pinned doctor` for the snippet to splice in, " +
        "or remove the existing hook (rm .git/hooks/" + name + ") and re-run `pinned init` to write a fresh combined hook.",
    };
  }
  // Append our block to the existing hook (don't clobber the user's
  // pre-existing logic). Use a no-#! prefix since the shebang is already
  // declared at the top of the existing file.
  const ourBlock = body
    .split("\n")
    .filter((l) => !l.startsWith("#!"))
    .join("\n");
  const updated = existing.replace(/\s*$/, "") + "\n\n" + ourBlock + "\n";
  writeFileSync(path, updated);
  // Ensure executable bit is set (may have been clobbered).
  try {
    const st = statSync(path);
    if ((st.mode & 0o111) === 0) chmodSync(path, 0o755);
  } catch {}
  return { status: "appended", path };
}

export function uninstallHook(repoRoot: string, name: HookName): "removed" | "absent" {
  const path = hookPath(repoRoot, name);
  if (!existsSync(path)) return "absent";
  const startMarker = markerStart(name);
  const existing = readFileSync(path, "utf8");
  if (!existing.includes(startMarker)) return "absent";

  // Strip everything between our markers. If the file ends up empty
  // (we were the only content), delete it; otherwise keep the user's
  // pre-existing hook body.
  const re = new RegExp(
    `\\n?\\n?${escapeRegExp(startMarker)}[\\s\\S]*?${escapeRegExp(MARKER_END)}\\n?`,
    "g"
  );
  const updated = existing.replace(re, "").replace(/\s+$/, "") + "\n";
  if (updated.trim().startsWith("#!") && updated.trim().split("\n").length === 1) {
    // Only the shebang remains — strip it too. The hook is functionally empty.
    writeFileSync(path, "");
  } else {
    writeFileSync(path, updated);
  }
  return "removed";
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isHookInstalled(repoRoot: string, name: HookName): boolean {
  const path = hookPath(repoRoot, name);
  if (!existsSync(path)) return false;
  try {
    return readFileSync(path, "utf8").includes(markerStart(name));
  } catch {
    return false;
  }
}
