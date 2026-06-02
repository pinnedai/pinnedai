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
import { scanDiffFull, findUnprotectedSiblings, AUTH_CHECK_PATTERNS, detectAuthChecksInDiff, detectValidationAddedInDiff, detectNewPostEndpointsInDiff, detectNewPagesInDiff, detectNewValidationSchemasInDiff, detectHostConditionalInDiff, type DiffByFile } from "./scanDiff.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Build a synthetic DiffByFile from the current file contents of every
// non-deleted changed file. Treating the WHOLE file as "added lines"
// over-captures slightly (a signature already present in the parent
// also gets captured) — but for staticVerify purposes that's fine: the
// pin still passes when the signature is present and fails only when
// it's later removed. Captures auth in baseline scans where there's no
// diff at all, AND in diff scans where the line-level diff is more
// expensive to compute than just reading the file. See [[launch-bar-walk-forward-catches]].
function buildSyntheticDiffByFile(repoRoot: string, changedFiles: ChangedFile[]): DiffByFile {
  const out: DiffByFile = new Map();
  for (const f of changedFiles) {
    if (f.status === "deleted") continue;
    try {
      const content = readFileSync(join(repoRoot, f.path), "utf8");
      out.set(f.path, content.split("\n"));
    } catch {
      /* file missing or unreadable — skip */
    }
  }
  return out;
}

// Validation patterns matched in backtest.ts collectSiblings(). Kept
// inline here so autoProtect doesn't depend on backtest's internals.
const VALIDATION_SIBLING_PATTERNS: RegExp[] = [
  /\bz\.object\s*\(/,
  /\.parseAsync\s*\(/,
  /\.safeParse(?:Async)?\s*\(/,
  /\byup\.object\s*\(/,
  /\bvalidate\s*\([^)]*req\.body/,
  /\bschema\.parse\s*\(/,
  /\b(?:reply|res)\.(?:code|status)\s*\(\s*400\b/,
];

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
  // Non-pin warnings surfaced to the user. v0.2.7+: host-conditional
  // handlers that read the request host and gate behavior on it. These
  // aren't auto-pinned (the right response varies — install a wrapper,
  // change the gate, accept the divergence) but the customer should
  // know before a happy-path pin's first run false-fails.
  warnings?: {
    hostConditional?: Array<{ filePath: string; route: string | null; expression: string; evidence: string }>;
  };
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

  // staticVerify capture: read current file contents of changed files
  // and run the diff-aware auth/validation detectors against them
  // (treating each file as if all lines were just added). This gives us
  // a static-mode fingerprint so the generated test can verify the pin
  // WITHOUT a live PREVIEW_URL. Before this fix, all auto-generated
  // auth/returns-status pins shipped with no staticVerify and were
  // INERT in CI for any customer not setting PREVIEW_URL. See
  // [[launch-bar-walk-forward-catches]].
  const syntheticDiff = buildSyntheticDiffByFile(input.repoRoot, input.changedFiles);
  const authHitsByRoute = new Map<string, { filePath: string; signature: string }>();
  const validationHitsByRoute = new Map<string, { filePath: string; signature: string }>();
  let middlewareAuth: { filePath: string; signature: string } | null = null;
  try {
    for (const h of detectAuthChecksInDiff(syntheticDiff)) {
      authHitsByRoute.set(h.route, { filePath: h.filePath, signature: h.signature });
      // Global auth middleware detected → upgrade to first-class signal.
      // When present, individual per-route auth-required suggestions
      // from scanDiffFull's path-shape detection become redundant noise
      // (they ship inert because the auth signature lives in middleware,
      // not in each route file). See [[launch-bar-walk-forward-catches]]
      // — discovered via quantapact (Next.js middleware.ts + flat
      // api/admin-*.ts endpoints).
      if (h.route === "* (middleware)" && !middlewareAuth) {
        middlewareAuth = { filePath: h.filePath, signature: h.signature };
      }
    }
    for (const h of detectValidationAddedInDiff(syntheticDiff)) {
      validationHitsByRoute.set(h.route, { filePath: h.filePath, signature: h.signature });
    }
    // happy-path-with-side-effect — fires when a new POST/PUT/PATCH/DELETE
    // endpoint lands. Was the gap that let a 400 regression ship on
    // socialideagen's POST /api/signup in 2026-06-02. Decision is "ask"
    // because the customer needs to add the X-Pinned-Side-Effect wrapper
    // (~5-10 LOC) for the pin to verify side-effects; the pin itself
    // doesn't reach into their DB.
    for (const h of detectNewPostEndpointsInDiff(syntheticDiff)) {
      tryEmit({
        claim: {
          template: "happy-path-with-side-effect",
          route: h.route,
          method: h.method,
          sideEffectKind: "db-write",
          sideEffectTarget: h.targetGuess,
          raw: h.suggestedPin,
        },
        reason: `new ${h.method} endpoint ${h.route} added in this commit — pin asserts it returns 2xx AND actually performs its db-write side-effect (catches stub-returns-200-without-work bugs). Customer's AI agent must add the X-Pinned-Side-Effect wrapper before the pin can verify; see the pin's repairPrompt for the snippet.`,
        triggeredBy: h.filePath,
        decision: "ask",
      });
    }
    // page-renders — fires when a new server-rendered page lands.
    // Catches React/Next/Vite render errors that would otherwise hit
    // prod silently (page returns 200 but body contains an error
    // overlay). Safe to auto-pin: the test only requires PREVIEW_URL
    // + GETs the path. No wrapper required.
    for (const h of detectNewPagesInDiff(syntheticDiff)) {
      tryEmit({
        claim: {
          template: "page-renders",
          route: h.route,
          raw: h.suggestedPin,
        },
        reason: `new page ${h.route} added in this commit — pin asserts it renders without crashing (no React/Next/Vite error markers in the body, > 500 bytes HTML).`,
        triggeredBy: h.filePath,
        decision: "safe",
      });
    }
    // validation-rejects-bad — fires when a new zod/yup/joi schema
    // with required fields lands on a POST/PUT/PATCH/DELETE handler.
    // Each required field becomes a sub-test asserting the endpoint
    // 4xx's when that field is missing. Safe to auto-pin: no wrapper
    // required.
    const validationRoutesAutoPinned = new Set<string>();
    for (const h of detectNewValidationSchemasInDiff(syntheticDiff)) {
      tryEmit({
        claim: {
          template: "validation-rejects-bad",
          route: h.route,
          method: h.method,
          requiredFields: h.requiredFields,
          raw: h.suggestedPin,
        },
        reason: `new validation schema for ${h.method} ${h.route} (${h.requiredFields.length} required field(s)) — pin asserts the endpoint correctly 4xx's on malformed JSON + bodies missing each required field.`,
        triggeredBy: h.filePath,
        decision: "safe",
      });
      validationRoutesAutoPinned.add(`${h.method} ${h.route}`);
    }
    // Complementary happy-path pin — validation-rejects-bad checks the
    // INVERSE direction (bad input → 4xx). It will stay green while a
    // regression in the GOOD-input path (valid request → 4xx, the more
    // common regression class) silently ships. Auto-emit a happy-path-
    // with-side-effect candidate for every route that just got a
    // validation-rejects-bad pin, so both directions are covered.
    // Caught on socialideagen dogfood 2026-06-02: invite endpoint got
    // validation pin, real bug was good-request → 4xx, pin stayed
    // green while every real signup broke.
    for (const h of detectNewValidationSchemasInDiff(syntheticDiff)) {
      const lastSeg = h.route.split("/").filter(Boolean).pop() || "items";
      const targetGuess = lastSeg.endsWith("s")
        ? lastSeg
        : /[aeiou]y$/.test(lastSeg) || !lastSeg.endsWith("y")
          ? lastSeg + (/(?:s|x|z|ch|sh)$/.test(lastSeg) ? "es" : "s")
          : lastSeg.slice(0, -1) + "ies";
      tryEmit({
        claim: {
          template: "happy-path-with-side-effect",
          route: h.route,
          method: h.method,
          sideEffectKind: "db-write",
          sideEffectTarget: targetGuess,
          // Schema-derived body shape from the validation detector
          // (when zod fields were extractable). Lets the emitted test
          // ship a body that satisfies the schema on first run, not
          // a placeholder that 4xx's. Falls through to the placeholder
          // when h.bodyShape is undefined (yup/joi/no-schema cases).
          ...(h.bodyShape ? { bodyShape: h.bodyShape } : {}),
          raw: `${h.method} ${h.route} with valid body returns 2xx + writes to ${targetGuess}`,
        },
        reason: `complement to the validation-rejects-bad pin for ${h.method} ${h.route} — validation pin only checks the bad-input direction (will stay green if real users get 4xx for valid requests). This pin checks the good-input direction. Needs the X-Pinned-Side-Effect wrapper.`,
        triggeredBy: h.filePath,
        decision: "ask",
      });
    }
  } catch {
    /* detector errors must not block pin emission */
  }

  // Emit the middleware pin FIRST (before per-route loop). Its
  // staticVerify gives us a no-PREVIEW_URL catch path on every
  // downstream route via the single middleware file.
  if (middlewareAuth) {
    tryEmit({
      claim: {
        template: "auth-required",
        route: "* (middleware)",
        raw: `auth check in ${middlewareAuth.filePath}`,
        staticVerify: middlewareAuth,
      },
      reason: `global auth middleware in ${middlewareAuth.filePath} protects all downstream routes`,
      triggeredBy: middlewareAuth.filePath,
      decision: "safe",
    });
  }

  for (const s of scan.suggestions) {
    if (s.files.some(isSkipped)) continue;
    const route = s.route ?? "";

    if (s.template === "auth-required" && route && isAdminShape(route)) {
      // Admin / internal routes — SAFE auto-pin. Asserting "401 or 403
      // without an Authorization header" is deterministic.
      const sv = authHitsByRoute.get(route);
      tryEmit({
        claim: sv
          ? { template: "auth-required", route, raw: s.suggestedPin, staticVerify: sv }
          : { template: "auth-required", route, raw: s.suggestedPin },
        reason: `protects ${route} from being publicly accessible`,
        triggeredBy: s.files[0],
        decision: "safe",
      });
      continue;
    }
    if (s.template === "auth-required" && route) {
      // Non-admin route. Could be intentional public surface. ASK.
      const sv = authHitsByRoute.get(route);
      tryEmit({
        claim: sv
          ? { template: "auth-required", route, raw: s.suggestedPin, staticVerify: sv }
          : { template: "auth-required", route, raw: s.suggestedPin },
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
    if (s.template === "returns-status" && route) {
      // Validation-added pin. SAFE auto-add — the assertion is
      // deterministic ("POST <route> with bad body returns 400") and
      // staticVerify (when present) gives a no-preview-URL fallback.
      // Before this fix, scanDiffFull's returns-status suggestions
      // were silently dropped by classifyDiff. See [[launch-bar-walk-forward-catches]].
      const sv = validationHitsByRoute.get(route);
      tryEmit({
        claim: sv
          ? { template: "returns-status", route, method: "POST", status: 400, raw: s.suggestedPin, staticVerify: sv }
          : { template: "returns-status", route, method: "POST", status: 400, raw: s.suggestedPin },
        reason: s.reason,
        triggeredBy: s.files[0],
        decision: "safe",
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

  // Sibling discovery (auto, no user trigger). After classifying the
  // direct catches in the diff, scan the repo for files that LOOK
  // sibling-shaped (same admin/account/internal prefix family) but
  // contain no matching auth/validation signature. Auto-emit as safe
  // candidates so they get pinned on the same commit. Per
  // [[sibling-discovery-confidence-tiered-no-approval]]: high-confidence
  // siblings are auto-pinned; medium are also added here because the
  // user's decision was to bias toward catch-coverage rather than the
  // stricter observe→active lifecycle in this iteration.
  const directSafe = [...safe];
  for (const cand of directSafe) {
    if (cand.claim.template !== "auth-required" && cand.claim.template !== "returns-status") continue;
    const route = (cand.claim as { route?: string }).route;
    if (!route) continue;
    const category: "auth" | "validation" =
      cand.claim.template === "auth-required" ? "auth" : "validation";
    const patterns = category === "auth" ? AUTH_CHECK_PATTERNS : VALIDATION_SIBLING_PATTERNS;
    let siblings: ReturnType<typeof findUnprotectedSiblings>;
    try {
      siblings = findUnprotectedSiblings({
        repoPath: input.repoRoot,
        patterns,
        triggerFilePath: cand.triggeredBy,
        triggerRoute: route,
        category,
      });
    } catch {
      continue;
    }
    for (const s of siblings) {
      if (s.confidence === "low") continue;
      const siblingRoute = s.route ?? "";
      if (!siblingRoute) continue;
      if (cand.claim.template === "auth-required") {
        tryEmit({
          claim: { template: "auth-required", route: siblingRoute, raw: `auth required on ${siblingRoute}` },
          reason: `sibling of ${route} — no auth signature found in ${s.filePath}`,
          triggeredBy: s.filePath,
          decision: "safe",
        });
      } else {
        tryEmit({
          claim: {
            template: "returns-status",
            route: siblingRoute,
            method: (cand.claim as { method?: "POST" | "PUT" | "PATCH" }).method ?? "POST",
            status: 400,
            raw: `${siblingRoute} returns 400 on bad body`,
          },
          reason: `sibling of ${route} — no validation signature found in ${s.filePath}`,
          triggeredBy: s.filePath,
          decision: "safe",
        });
      }
    }
  }

  // Host-conditional warnings (0.2.7+). Not pins themselves — surface
  // these so the customer knows a happy-path / journey pin against
  // PREVIEW_URL might false-fail because the handler takes its
  // non-prod branch. The customer's correct response varies (install
  // a Pinned bypass header, change the gate, accept divergence).
  let warnings: ClassifyResult["warnings"] | undefined;
  try {
    const hostHits = detectHostConditionalInDiff(syntheticDiff);
    if (hostHits.length > 0) {
      warnings = {
        hostConditional: hostHits.map((h) => ({
          filePath: h.filePath,
          route: h.route,
          expression: h.hostExpression,
          evidence: h.evidence,
        })),
      };
    }
  } catch {
    /* detector errors must not block classification */
  }

  return { safe, ask, ...(warnings ? { warnings } : {}) };
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
