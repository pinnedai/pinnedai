// Auto-protect classifier — decides which behaviors in a diff are
// SAFE enough to auto-pin (deterministic, no business judgment needed)
// vs which should be SUGGESTED (need human confirmation).
//
// Pure function. Reads file content from disk for new files only — the
// caller passes the changed-file list; we read content inline to inspect
// the *shape* of the change (new Commander command? new admin route?).
//
// Architectural rule: never decide based on a single regex match. Each
// safe-classification must point at a *deterministic test* that can be
// asserted reproducibly. If the test would need business context to
// pass, it's an ASK candidate, not a SAFE one.

import type { Claim } from "./claimParser.js";
import { claimKey } from "./claimParser.js";
import type { RegistryEntry } from "./registry.js";
import type { ChangedFile } from "./scanDiff.js";
import { scanDiffFull } from "./scanDiff.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export type AutoProtectMode = "safe" | "ask" | "off";

export type AutoProtectCandidate = {
  // The claim that would be auto-generated. Goes straight into the
  // existing generateTest path so we get the same templates + same
  // browser-safe filenames.
  claim: Claim;
  // Why we suggested this. Surfaces in PR comments + statusline.
  reason: string;
  // Which file in the diff triggered the suggestion.
  triggeredBy: string;
  // The classifier's decision: auto-add or ask-first.
  decision: "safe" | "ask";
};

export type ClassifyInput = {
  repoRoot: string;
  changedFiles: ChangedFile[];
  prBodyClaims: Claim[];
  existingPins: RegistryEntry[];
};

export type ClassifyResult = {
  safe: AutoProtectCandidate[];
  ask: AutoProtectCandidate[];
};

// File patterns that should never trigger auto-protect even if they
// match a rule — pure noise sources that would flood suggestions.
const SKIP_PATTERNS = [
  /^node_modules\//,
  /^dist\//,
  /^build\//,
  /^\.git\//,
  /^tests\/pinned\//, // our own pins; never pin tests-about-tests
  /^audit\//,
  /\.test\.(?:ts|tsx|js|jsx|mjs|cjs)$/,
  /\.spec\.(?:ts|tsx|js|jsx|mjs|cjs)$/,
  /^README\.md$/i,
  /^CHANGELOG\.md$/i,
  /^LICENSE$/,
];

function isSkipped(path: string): boolean {
  return SKIP_PATTERNS.some((re) => re.test(path));
}

// Safe-classification: paths that match this shape are administrative
// or internal endpoints. Auto-pinning auth-required on them is
// deterministic — if a future change makes /api/admin/* return 200
// without auth, that's a real regression.
const ADMIN_ROUTE_SHAPES = [
  /\/api\/admin\//,
  /\/api\/internal\//,
  /\/admin\/api\//,
];

function isAdminShape(route: string): boolean {
  return ADMIN_ROUTE_SHAPES.some((re) => re.test(route));
}

// ----------- CLI detection -----------
// Pattern: Commander's `program.command("<NAME>", ...)` or
// `program.command("<NAME> <arg>", ...)`. We auto-pin a `cli-exits-zero`
// check against `<bin> <NAME> --help` — running --help is safe
// (no side effects, fast, deterministic) and asserts the command
// is registered.
// Note: the placeholder uses uppercase + angle brackets so this very
// comment does not match COMMANDER_COMMAND_RE when the classifier
// scans its own source file.

const COMMANDER_COMMAND_RE = /\b(?:program|cli|cmd)\s*\.\s*command\s*\(\s*["'`]([a-z][a-z0-9-]*)\b/gi;
const COMMANDER_OPTION_RE = /\.option\s*\(\s*["'`](--[a-z][a-z0-9-]*)\b/gi;

// Heuristic for the bin entry point. Most monorepos point at
// apps/cli/dist/cli.js after build; we use that as the auto-pin target.
function detectBinPath(repoRoot: string): string | null {
  const candidates = [
    "apps/cli/dist/cli.js",
    "dist/cli.js",
    "dist/index.js",
    "build/cli.js",
  ];
  for (const c of candidates) {
    if (existsSync(join(repoRoot, c))) return `node ./${c}`;
  }
  return null;
}

// Extract the closest preceding `.command("foo", ...)` name so we can
// attribute new `.option(...)` calls to the right subcommand. Returns
// the parent-command name nearest BEFORE the option's offset, or null
// if the option is at the top level.
function attributeOptionToCommand(src: string, optOffset: number): string | null {
  let lastCmd: string | null = null;
  COMMANDER_COMMAND_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = COMMANDER_COMMAND_RE.exec(src)) !== null) {
    if (m.index >= optOffset) break;
    lastCmd = m[1];
  }
  return lastCmd;
}

// ----------- Main classifier -----------

export function classifyDiff(input: ClassifyInput): ClassifyResult {
  const safe: AutoProtectCandidate[] = [];
  const ask: AutoProtectCandidate[] = [];

  // Track keys we've already emitted so two rules don't double-suggest
  // the same pin. Also dedupe against existing pins + PR body claims.
  const emitted = new Set<string>();
  const alreadyPinned = new Set<string>();
  for (const e of input.existingPins) {
    if (e.status === "active") alreadyPinned.add(claimKey(e.claim));
  }
  for (const c of input.prBodyClaims) {
    alreadyPinned.add(claimKey(c));
  }

  function tryEmit(c: AutoProtectCandidate): void {
    const key = claimKey(c.claim);
    if (alreadyPinned.has(key) || emitted.has(key)) return;
    emitted.add(key);
    if (c.decision === "safe") {
      safe.push(c);
    } else {
      ask.push(c);
    }
  }

  // 1. Reuse scanDiff for web-route detection — same risk surfaces,
  // same dedupe behavior. Translate its Suggestion → AutoProtectCandidate
  // with our safe/ask decision.
  const scan = scanDiffFull({
    changedFiles: input.changedFiles,
    prBodyClaims: input.prBodyClaims,
    existingPins: input.existingPins,
  });
  for (const s of scan.suggestions) {
    if (s.files.some(isSkipped)) continue;
    const route = s.route ?? "";

    if (s.template === "auth-required" && route && isAdminShape(route)) {
      // Admin / internal routes — SAFE auto-pin. Asserting "401 or 403
      // without an Authorization header" is deterministic.
      tryEmit({
        claim: { template: "auth-required", route, raw: s.suggestedPin },
        reason: `protects ${route} from being publicly accessible`,
        triggeredBy: s.files[0],
        decision: "safe",
      });
      continue;
    }
    if (s.template === "auth-required" && route) {
      // Non-admin route. Could be intentional public surface. ASK.
      tryEmit({
        claim: { template: "auth-required", route, raw: s.suggestedPin },
        reason: s.reason,
        triggeredBy: s.files[0],
        decision: "ask",
      });
      continue;
    }
    if (s.template === "idempotent" && route) {
      // Webhook idempotency — needs to know which header/field carries
      // the event id. ASK.
      tryEmit({
        claim: { template: "idempotent", route, idField: "event_id", raw: s.suggestedPin },
        reason: s.reason,
        triggeredBy: s.files[0],
        decision: "ask",
      });
      continue;
    }
    if (s.template === "rate-limit") {
      // Rate limit without an explicit rate is meaningless. ASK.
      tryEmit({
        claim: {
          template: "rate-limit",
          route,
          rate: 60,
          window: "minute",
          raw: s.suggestedPin,
        },
        reason: s.reason,
        triggeredBy: s.files[0],
        decision: "ask",
      });
      continue;
    }
    // env-required template doesn't ship until v0.2. Skip silently.
  }

  // 2. CLI shape detection — scan files for Commander patterns.
  //
  // For ADDED files: scan the entire file content (every command +
  //   every option is newly-introduced).
  // For MODIFIED files: scan ONLY the unified-diff added lines
  //   (f.addedLines), so we don't re-detect every pre-existing
  //   Commander pattern on every commit. This is the key correctness
  //   fix that makes auto-protect "feel alive" during normal AI
  //   coding (where customers add commands to an existing cli.ts).
  //
  // Decisions:
  //   newly-introduced Commander command  → cli-exits-zero  (SAFE)
  //   newly-introduced Commander option   → cli-flag-supported  (ASK)
  // SAFE means auto-added in safe mode. ASK means surfaced as a
  // suggestion for the user to approve via `pinned protect`.
  // (Comments deliberately avoid literal quoted-call syntax so the
  // classifier doesn't match its own documentation as a fresh pattern.)
  const binPath = detectBinPath(input.repoRoot);
  if (binPath) {
    for (const f of input.changedFiles) {
      if (f.status === "deleted") continue;
      if (isSkipped(f.path)) continue;
      if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(f.path)) continue;

      // Decide what content to scan based on file status.
      let src: string;
      if (f.status === "added") {
        const abs = join(input.repoRoot, f.path);
        if (!existsSync(abs)) continue;
        try {
          src = readFileSync(abs, "utf8");
        } catch {
          continue;
        }
      } else {
        // Modified — scan ONLY the added diff lines. If we don't have
        // them (caller didn't compute), conservatively skip the file
        // rather than re-detecting every existing pattern.
        if (typeof f.addedLines !== "string" || f.addedLines.length === 0) {
          continue;
        }
        src = f.addedLines;
      }
      // Cap inspection — refuse to scan very large bodies (likely
      // generated). 256KB is well above hand-written source.
      if (src.length > 256 * 1024) continue;

      // Newly-introduced Commander commands → cli-exits-zero (SAFE)
      COMMANDER_COMMAND_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = COMMANDER_COMMAND_RE.exec(src)) !== null) {
        const cmdName = m[1];
        if (cmdName === "help") continue; // Commander's auto-generated `help`
        tryEmit({
          claim: {
            template: "cli-exits-zero",
            route: `${binPath} ${cmdName} --help`,
            raw: `\`${binPath} ${cmdName} --help\` exits 0`,
          },
          reason: `protects the new \`${cmdName}\` command from accidental removal or breakage`,
          triggeredBy: f.path,
          decision: "safe",
        });
      }

      // Newly-introduced options → cli-flag-supported (ASK)
      // The "which command does this option belong to?" attribution
      // only works on the full file content (we need the surrounding
      // .command() calls to attribute). For added files we have it.
      // For modified files we only see the diff "+" lines, so we
      // don't have the parent .command() context — skip.
      if (f.status !== "added") continue;
      COMMANDER_OPTION_RE.lastIndex = 0;
      let mo: RegExpExecArray | null;
      while ((mo = COMMANDER_OPTION_RE.exec(src)) !== null) {
        const flag = mo[1];
        const cmdName = attributeOptionToCommand(src, mo.index);
        if (!cmdName) continue;
        tryEmit({
          claim: {
            template: "cli-flag-supported",
            route: `${binPath} ${cmdName}`,
            flag,
            raw: `\`${binPath} ${cmdName}\` supports \`${flag}\``,
          },
          reason: `new \`${flag}\` flag on \`${cmdName}\` — assert it's accepted`,
          triggeredBy: f.path,
          decision: "ask",
        });
      }
    }
  }

  return { safe, ask };
}

// Cap the safe list to the safety budget. Returns the kept safe
// candidates + a "deferred" list that should be downgraded to ask
// (so the user can see them via `pinned protect`).
export function applySafetyBudget(
  classified: ClassifyResult,
  budget: number
): { safe: AutoProtectCandidate[]; ask: AutoProtectCandidate[]; deferred: AutoProtectCandidate[] } {
  if (budget < 0 || !Number.isFinite(budget)) {
    return { safe: [], ask: [...classified.ask], deferred: [...classified.safe] };
  }
  if (classified.safe.length <= budget) {
    return { safe: classified.safe, ask: classified.ask, deferred: [] };
  }
  const kept = classified.safe.slice(0, budget);
  const deferred = classified.safe.slice(budget);
  // Deferred safe pins join the ask list so they're surfaced as
  // suggestions rather than silently dropped.
  const ask = [...classified.ask, ...deferred];
  return { safe: kept, ask, deferred };
}

// Apply the user's auto-protect mode to a classify result. This is the
// gate that determines what *actually* gets returned to the caller.
//
//   safe: returns { autoAdd: classified.safe, suggested: classified.ask }
//   ask:  returns { autoAdd: [], suggested: classified.safe + classified.ask }
//   off:  returns { autoAdd: [], suggested: [] }
export function applyMode(
  classified: ClassifyResult,
  mode: AutoProtectMode
): { autoAdd: AutoProtectCandidate[]; suggested: AutoProtectCandidate[] } {
  if (mode === "off") {
    return { autoAdd: [], suggested: [] };
  }
  if (mode === "ask") {
    return {
      autoAdd: [],
      suggested: [...classified.safe, ...classified.ask].map((c) => ({
        ...c,
        decision: "ask" as const,
      })),
    };
  }
  return { autoAdd: classified.safe, suggested: classified.ask };
}
