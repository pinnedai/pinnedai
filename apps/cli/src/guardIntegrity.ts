// Guard Integrity — Layer 1 of the post-2026-05-23 product pivot.
//
// Detects diff-time attempts to weaken, skip, delete, or otherwise
// bypass the Pinned safety net. Higher catch frequency than bug
// detection (AI agents do these things weekly when they hit failing
// tests). No fixtures, no PREVIEW_URL, no behavioral probes — pure
// file-content diff analysis.
//
// Each detector returns structured violations the caller can:
//   - format into PR comments / chat-hook output
//   - use to fail CI (exit non-zero)
//   - record into a "blocked attempts" log for the proof page
//
// See [[strategic-pivot-guard-integrity]] memory for product framing.

import type { ChangedFile } from "./scanDiff.js";

export type GuardIntegrityViolationType =
  | "pin-deleted"          // file removed from tests/pinned/
  | "skip-added"           // .skip / .only / xit / xtest added in pinned test
  | "assertion-weakened"   // toBe(N) → toBeTruthy / toBeDefined / toBeOk
  | "swallow-added"        // || true / ?? true / catch(() => true) added
  | "workflow-modified"    // .github/workflows/pinned.yml changed
  | "registry-entry-removed" // registry .registry.json entry removed
  | "assertion-commented"  // expect() commented out
  | "assertion-stubbed"    // expect(true).toBe(true) / return true
  | "ai-lessons-tampered"; // .pinned/ai-lessons.md modified or deleted

export type GuardIntegrityViolation = {
  type: GuardIntegrityViolationType;
  severity: "block" | "warn";
  file: string;
  // One-line human-readable summary used in PR comments and CLI output.
  evidence: string;
  // Optional before/after snippets — surfaced when available so the
  // user sees EXACTLY what changed. Especially powerful for the
  // weakening / stubbing cases ("AI changed X to Y").
  before?: string;
  after?: string;
};

export type GuardIntegrityInput = {
  changedFiles: ChangedFile[];
  // 0.3.1+: optional reader for the CLI-edit marker. When the
  // pre-commit guard runs, it can pass a callback that returns the
  // sha256 the CLI stamped into .pinned/.last-cli-edit on its last
  // registry write. If that hash matches the CURRENT registry
  // content's sha256, the registry edit was CLI-driven and should
  // NOT trigger the "registry modified directly" warning. Without
  // this hook, every `pinned smoke add` / `pinned rm` / `pinned
  // retire` lit up the guard on commit — the false-tampering trap
  // Cipherwake reported.
  cliEditMarkerSha?: string;
  // The current registry file content (for marker comparison).
  currentRegistrySha?: string;
};

// Paths Guard Integrity considers "protected" — modifications to
// these get scrutinized. tests/pinned/ is the obvious one; we also
// guard the workflow file because removing it disables enforcement.
const PINNED_TESTS_PREFIX = "tests/pinned/";
const PINNED_WORKFLOW_PATH = ".github/workflows/pinned.yml";
const PINNED_REGISTRY_PATH = "tests/pinned/.registry.json";
const PINNED_AI_LESSONS_PATH = ".pinned/ai-lessons.md";
const PINNED_AI_LESSONS_JSON_PATH = ".pinned/lessons.json";

function isPinnedTestPath(path: string): boolean {
  if (!path.startsWith(PINNED_TESTS_PREFIX)) return false;
  if (path === PINNED_REGISTRY_PATH) return false; // registry has its own detector
  if (path.endsWith(".md")) return false; // PINS.md, AGENT.md, etc. — not tests
  return /\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(path);
}

// Detector #1 — pin file deletion.
// Highest-leverage detector. Almost no legitimate reason to delete a
// pinned test file via a diff (legitimate retirement uses `pinned
// retire`, which keeps the file under tests/pinned/retired/).
function detectPinDeletion(files: ChangedFile[]): GuardIntegrityViolation[] {
  const out: GuardIntegrityViolation[] = [];
  for (const f of files) {
    if (f.status !== "deleted") continue;
    if (!isPinnedTestPath(f.path)) continue;
    out.push({
      type: "pin-deleted",
      severity: "block",
      file: f.path,
      evidence: `Pinned test file deleted. Pins are protected behavior contracts; use \`pinned retire\` to remove them with audit trail.`,
    });
  }
  return out;
}

// Detector #2 — .skip / .only / xit / xtest added to a pinned test.
// Matches Vitest, Jest, and Mocha conventions. Each pattern is anchored
// to its function-call shape so we don't false-fire on identifiers like
// `mySkipHandler` or `xitemList`.
const SKIP_PATTERNS = [
  // Vitest / Jest method chains: it.skip(, describe.skip(, test.skip(
  /\b(?:it|test|describe|context)\.skip\s*\(/,
  // Vitest / Jest standalone .only chains: it.only(, describe.only(
  /\b(?:it|test|describe|context)\.only\s*\(/,
  // Mocha-style: xit(, xtest(, xdescribe(
  /\b(?:xit|xtest|xdescribe|xcontext)\s*\(/,
  // .skipIf with a literal truthy — bypasses runtime gating
  /\b(?:it|test|describe)\.skipIf\s*\(\s*(?:true|1|"[^"]+"|'[^']+')\s*\)/,
  // .todo — Vitest pending. Less severe but still bypasses execution.
  /\b(?:it|test|describe)\.todo\s*\(/,
];

function detectSkipAdded(files: ChangedFile[]): GuardIntegrityViolation[] {
  const out: GuardIntegrityViolation[] = [];
  for (const f of files) {
    if (f.status !== "modified") continue;
    if (!isPinnedTestPath(f.path)) continue;
    const added = f.addedLines ?? "";
    if (!added) continue;
    for (const re of SKIP_PATTERNS) {
      const m = re.exec(added);
      if (!m) continue;
      const matchedLine = extractLine(added, m.index);
      out.push({
        type: "skip-added",
        severity: "block",
        file: f.path,
        evidence: `Test-skip pattern added to pinned guard. AI agents commonly add .skip/.only/xit/.todo to make failing tests pass without fixing the underlying code.`,
        after: matchedLine,
      });
      break; // one violation per file is sufficient for the report
    }
  }
  return out;
}

// Detector #3 — assertion weakening.
// Matches Vitest/Jest assertion patterns that REPLACE a specific-value
// check (`.toBe(N)`, `.toEqual(X)`) with a loose existence check
// (`.toBeTruthy()`, `.toBeDefined()`, `.toBeOk()`, `.not.toBeUndefined()`).
//
// This v1 only detects ADDED loose assertions in pinned files — it
// doesn't compare to what was REMOVED (would need removed-lines context
// which ChangedFile doesn't carry today). A future v2 can be smarter,
// but this catches the most common shape: AI adds .toBeTruthy() to a
// pinned test that previously had .toBe(<num>).
const WEAKENING_PATTERNS = [
  /\.toBeTruthy\s*\(\s*\)/,
  /\.toBeDefined\s*\(\s*\)/,
  /\.toBeOk\s*\(\s*\)/,
  /\.not\.toBeUndefined\s*\(\s*\)/,
  /\.not\.toBeNull\s*\(\s*\)/,
  /\.not\.toBeFalsy\s*\(\s*\)/,
  // Pass-through: expect(true).toBe(true) is a no-op assertion
  /expect\s*\(\s*true\s*\)\.toBe\s*\(\s*true\s*\)/,
  // Pass-through: expect(1).toBe(1) literal
  /expect\s*\(\s*(\d+)\s*\)\.toBe\s*\(\s*\1\s*\)/,
];

function detectAssertionWeakening(files: ChangedFile[]): GuardIntegrityViolation[] {
  const out: GuardIntegrityViolation[] = [];
  for (const f of files) {
    if (f.status !== "modified") continue;
    if (!isPinnedTestPath(f.path)) continue;
    const added = f.addedLines ?? "";
    if (!added) continue;
    for (const re of WEAKENING_PATTERNS) {
      const m = re.exec(added);
      if (!m) continue;
      const matchedLine = extractLine(added, m.index);
      out.push({
        type: "assertion-weakened",
        severity: "block",
        file: f.path,
        evidence: `Loose assertion added to pinned guard. Patterns like .toBeTruthy() / .toBeDefined() / expect(true).toBe(true) are commonly used by AI agents to make a failing guard pass without restoring the protected behavior.`,
        after: matchedLine,
      });
      break;
    }
  }
  return out;
}

// Detector #4 — swallow patterns (|| true, ?? true, catch fallthrough).
// These let an expression that would have thrown / returned falsy turn
// into a guaranteed-truthy value, making any subsequent assertion pass.
const SWALLOW_PATTERNS = [
  /\|\|\s*true\b/,
  /\?\?\s*true\b/,
  /\.catch\s*\(\s*\(\s*\)\s*=>\s*true\s*\)/,
  /\.catch\s*\(\s*\(\s*[^)]*\)\s*=>\s*true\s*\)/,
  // Bare try/catch that returns nothing — common pattern to silence errors
  /\}\s*catch\s*\(\s*[^)]*\)\s*\{\s*\/?\*?\s*\*?\/?\s*\}/,
];

function detectSwallowAdded(files: ChangedFile[]): GuardIntegrityViolation[] {
  const out: GuardIntegrityViolation[] = [];
  for (const f of files) {
    if (f.status !== "modified") continue;
    if (!isPinnedTestPath(f.path)) continue;
    const added = f.addedLines ?? "";
    if (!added) continue;
    for (const re of SWALLOW_PATTERNS) {
      const m = re.exec(added);
      if (!m) continue;
      const matchedLine = extractLine(added, m.index);
      out.push({
        type: "swallow-added",
        severity: "block",
        file: f.path,
        evidence: `Error-swallowing pattern added to pinned guard. || true / ?? true / catch fallthrough make assertions trivially pass and undermine the guard.`,
        after: matchedLine,
      });
      break;
    }
  }
  return out;
}

// Detector #5 — workflow modification.
// The workflow that runs Pinned guards. Removing or disabling it lets
// future PRs land without ANY guard ever running. Includes deletion
// AND modification (because adding `if: false` or removing the step
// has the same effect as deletion).
function detectWorkflowModified(files: ChangedFile[]): GuardIntegrityViolation[] {
  const out: GuardIntegrityViolation[] = [];
  for (const f of files) {
    if (f.path !== PINNED_WORKFLOW_PATH) continue;
    if (f.status === "deleted") {
      out.push({
        type: "workflow-modified",
        severity: "block",
        file: f.path,
        evidence: `Pinned workflow file deleted. Without this workflow, no future PR will run guard tests. Restore the file or contact a maintainer.`,
      });
      continue;
    }
    if (f.status === "modified") {
      // We can't tell from addedLines alone whether the modification
      // is BENIGN (e.g., bumping action versions) or HARMFUL (removing
      // the guard step). Surface as a warning so a human reviews. A
      // future detector could parse the YAML and detect specifically
      // dangerous removals (e.g., absence of `pinned check`).
      out.push({
        type: "workflow-modified",
        severity: "warn",
        file: f.path,
        evidence: `Pinned workflow modified. Review carefully — removing the guard step disables enforcement.`,
      });
    }
  }
  return out;
}

// Detector #6 — registry entry removal.
// The .registry.json file is the source of truth for which pins exist.
// Removing an entry hides a pin from PINS.md / statusline / catch
// surfacing even when the test file remains.
function detectRegistryEntryRemoved(files: ChangedFile[]): GuardIntegrityViolation[] {
  const out: GuardIntegrityViolation[] = [];
  for (const f of files) {
    if (f.path !== PINNED_REGISTRY_PATH) continue;
    if (f.status === "deleted") {
      out.push({
        type: "registry-entry-removed",
        severity: "block",
        file: f.path,
        evidence: `Pinned registry file deleted. The registry tracks every pin and its metadata; deleting it erases the audit trail. Use \`pinned retire\` to retire pins individually.`,
      });
      continue;
    }
    // For modified registry files, we'd need to diff the JSON to
    // detect entry removal. v1 leaves this as a follow-up; modifying
    // .registry.json directly (rather than through the CLI) is
    // already suspicious enough to warn.
    if (f.status === "modified") {
      out.push({
        type: "registry-entry-removed",
        severity: "warn",
        file: f.path,
        evidence: `Pinned registry modified directly. The registry should be updated via \`pinned\` CLI commands, not by hand.`,
      });
    }
  }
  return out;
}

// Detector #7 — assertion commented out.
// Matches lines that look like `// expect(...)` or `/* expect(...) */`
// in pinned test files. Block-level: any commented expect() is
// suspicious because pinned tests don't have casual assertions.
const COMMENTED_ASSERTION_PATTERNS = [
  /^\s*\/\/\s*expect\s*\(/m,
  /\/\*\s*expect\s*\([\s\S]*?\)/,
];

function detectAssertionCommented(files: ChangedFile[]): GuardIntegrityViolation[] {
  const out: GuardIntegrityViolation[] = [];
  for (const f of files) {
    if (f.status !== "modified") continue;
    if (!isPinnedTestPath(f.path)) continue;
    const added = f.addedLines ?? "";
    if (!added) continue;
    for (const re of COMMENTED_ASSERTION_PATTERNS) {
      const m = re.exec(added);
      if (!m) continue;
      out.push({
        type: "assertion-commented",
        severity: "block",
        file: f.path,
        evidence: `Assertion was commented out in pinned guard. Commenting an expect() disables the check; restore the assertion or retire the pin properly.`,
        after: m[0].split("\n")[0],
      });
      break;
    }
  }
  return out;
}

// Detector #8 — AI Lessons file tampering.
// .pinned/ai-lessons.md is Pinned-owned. Users editing it by hand
// (vs through the auto-maintenance path) is suspicious — AI agents
// commonly try to remove rules that block their preferred edits.
// Deletion = block. Modification = block (the lessons file is
// auto-maintained; hand-editing should go through a CLI command).
function detectAiLessonsTampered(files: ChangedFile[]): GuardIntegrityViolation[] {
  const out: GuardIntegrityViolation[] = [];
  for (const f of files) {
    if (f.path !== PINNED_AI_LESSONS_PATH && f.path !== PINNED_AI_LESSONS_JSON_PATH) continue;
    if (f.status === "deleted") {
      out.push({
        type: "ai-lessons-tampered",
        severity: "block",
        file: f.path,
        evidence:
          `Pinned AI Lessons file deleted. This file is auto-maintained by Pinned and tells AI coders the rules learned from past bugs — deleting it removes the safety net those agents read before editing the repo.`,
      });
      continue;
    }
    if (f.status === "modified") {
      // Removal of `<!-- pinned:guard=... -->` markers from added lines
      // is the specific bypass signal. Without that signal we still
      // block on any direct edit (lessons should be added/updated via
      // the CLI), but as warn severity to leave room for legitimate
      // workflow tweaks like reordering sections.
      const added = f.addedLines ?? "";
      const removesMarker = /<!--\s*pinned:guard=/.test(added) === false &&
                            f.path === PINNED_AI_LESSONS_PATH;
      out.push({
        type: "ai-lessons-tampered",
        severity: removesMarker ? "warn" : "block",
        file: f.path,
        evidence: `Pinned AI Lessons file modified directly. This file should be updated via the \`pinned\` CLI; manual edits can erase learned rules and let AI agents repeat past mistakes.`,
      });
    }
  }
  return out;
}

// Helper: given a multi-line string and a character index, return the
// line containing that index. Used for evidence snippets.
function extractLine(text: string, idx: number): string {
  const start = Math.max(0, text.lastIndexOf("\n", idx - 1) + 1);
  const endNl = text.indexOf("\n", idx);
  const end = endNl === -1 ? text.length : endNl;
  return text.slice(start, end).trim();
}

// Top-level entry point. Returns ALL violations across all detectors.
// Callers decide how to render them (PR comment, CLI output, exit code).
export function detectGuardIntegrityViolations(input: GuardIntegrityInput): GuardIntegrityViolation[] {
  const out: GuardIntegrityViolation[] = [];
  out.push(...detectPinDeletion(input.changedFiles));
  out.push(...detectSkipAdded(input.changedFiles));
  out.push(...detectAssertionWeakening(input.changedFiles));
  out.push(...detectSwallowAdded(input.changedFiles));
  out.push(...detectWorkflowModified(input.changedFiles));
  out.push(...detectRegistryEntryRemoved(input.changedFiles));
  out.push(...detectAssertionCommented(input.changedFiles));
  out.push(...detectAiLessonsTampered(input.changedFiles));
  // 0.3.1+ filter: if the CLI-edit marker matches the current
  // registry content, the registry-modified-directly warning was
  // raised by a CLI-driven change. Strip it.
  if (input.cliEditMarkerSha && input.currentRegistrySha && input.cliEditMarkerSha === input.currentRegistrySha) {
    return out.filter((v) => v.type !== "registry-entry-removed" || v.severity !== "warn");
  }
  return out;
}

// Format a violation as a human-readable block ready for stderr / PR
// comment. Keeps the "AI changed X to Y" framing the strategic pivot
// memo described.
export function formatViolation(v: GuardIntegrityViolation): string {
  const lines: string[] = [];
  const severityTag = v.severity === "block" ? "⛔ BLOCK" : "⚠ WARN";
  lines.push(`${severityTag} · ${v.type} · ${v.file}`);
  lines.push("");
  lines.push(v.evidence);
  if (v.before || v.after) {
    lines.push("");
    if (v.before) {
      lines.push("Before:");
      lines.push(`  ${v.before}`);
    }
    if (v.after) {
      lines.push(v.before ? "After:" : "Pattern detected:");
      lines.push(`  ${v.after}`);
    }
  }
  return lines.join("\n");
}
