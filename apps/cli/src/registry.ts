// Pinned claim registry — the source of truth for what's pinned in a
// given repo, plus the renderer for `PINS.md`.
//
// PINS.md is the visible "behavioral contract" of the repo. Every dev
// browsing the repo on GitHub sees it. The more pins, the more
// pinnedai compounds in value — that's the moat working.
//
// On-disk layout:
//   tests/pinned/.registry.json   — machine-readable state (we mutate this)
//   tests/pinned/PINS.md          — human-readable rendered view (we regenerate)
//   tests/pinned/<id>.test.ts     — the actual test files
//   tests/pinned/retired/<id>.test.ts        — retired tests
//   tests/pinned/retired/<id>.audit.json     — per-file retire audit (kept for git readability)

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import type { Claim } from "./claimParser.js";
import { badCaseForClaim } from "./claimParser.js";

// Structural shape that renderCatchesMarkdown needs. Duplicated
// here (not imported from statusline.ts) to avoid registry → status
// → scanDiff → registry cycle.
type CatchRenderRecord = {
  caughtAt: string;
  claimId: string;
  claimText?: string;
  template?: string;
  route?: string;
  badCase?: string;
  originPr?: string;
  bugFixOrigin?: boolean;
};

// Pin coverage — what part of the codebase this pin guards.
// Populated at generation time from the parsed Claim. Used by
// scanDiff's findTouchedPins() to detect when a git diff touches
// behavior this pin already protects ("◆ pinned · REVIEW · N
// protected behavior touched"). Both fields optional because some
// claim shapes only know one or the other:
//   - rate-limit / auth-required / idempotent / returns-status →
//     covers.routes (the URL path)
//   - library-returns / cli-creates-file → covers.files (source
//     file the pin reads against)
//   - cli-output-contains / cli-exits-zero / cli-flag-supported →
//     no covers (the test asserts about a binary; we can't infer
//     which source files would change its behavior without user
//     hinting). Future v0.2: accept an explicit `// pinned:covers
//     src/cli.ts` annotation in the generated test header.
export type PinCoverage = {
  routes?: string[];
  files?: string[];
};

export type RegistryEntry = {
  claimId: string;
  prId: string;
  claim: Claim;
  filename: string;
  pinnedAt: string;
  pinnedBy?: string;
  status: "active" | "retired";
  retiredAt?: string;
  retireReason?: string;
  retiredBy?: string;
  // Diff-intersection metadata. Optional for backward compat with
  // pre-v0.1 .registry.json files that don't have it yet.
  covers?: PinCoverage;
  // True when this pin was extracted from a PR description containing
  // bug-fix vocabulary ("fix", "regression", "no longer", "bypass",
  // "race condition", "prevent"). Bug-fix-origin pins are
  // disproportionately likely to catch real regressions later —
  // they encode a specific failure mode that the fix PR documented.
  // Used for: PINS.md ordering (bug-fix pins listed first), CATCHES.md
  // attribution ("originally pinned in PR #X which fixed [phrase]"),
  // catch celebration messaging ("Pinned just re-caught a regression
  // that was already fixed once").
  bugFixOrigin?: boolean;
  // The specific scenario this pin guards against, in plain English.
  // Derived once at add time via badCaseForClaim(claim). Persisted so
  // failure messages, CATCHES.md entries, and AI chat-hook celebrations
  // can speak in human terms ("a Free user with 1 watched domain
  // adds a 2nd") rather than test-name jargon. Optional for backward
  // compat with pre-v0.1 entries.
  badCase?: string;
};

export type Registry = {
  version: 1;
  claims: RegistryEntry[];
};

const REGISTRY_FILENAME = ".registry.json";
const PINS_FILENAME = "PINS.md";

// Active-pin tracking is uncapped on every tier. The moat IS pin
// accumulation — capping pins on Free would cap the very thing that
// makes pinnedai valuable. Pro/Team/Enterprise differentiate on
// features (BYOK, custom templates, priority support), not pin counts.
// The Worker enforces a separate per-month LLM-call cap to bound cost.
// See `[[tier-structure-v01]]` memory.

export function countActivePins(registry: Registry): number {
  return registry.claims.filter((c) => c.status === "active").length;
}

export function readRegistry(dir: string): Registry {
  const path = join(dir, REGISTRY_FILENAME);
  if (!existsSync(path)) {
    return { version: 1, claims: [] };
  }
  // Fail closed on corrupt data — silently dropping claims would let the
  // next generate() wipe the registry. The user must resolve manually.
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(
      `Pinned registry at ${path} is not valid JSON. Fix or delete it manually before generating new pins. Original error: ${String(e)}`
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { version?: unknown }).version !== 1 ||
    !Array.isArray((parsed as { claims?: unknown }).claims)
  ) {
    throw new Error(
      `Pinned registry at ${path} is malformed (wrong shape). Expected { version: 1, claims: [...] }. Fix or delete it manually.`
    );
  }
  return parsed as Registry;
}

// Atomic write: stage to a temp file then rename. Both the registry
// and PINS.md are written transactionally so a crash mid-write can't
// leave them out of sync.
export function writeRegistry(dir: string, registry: Registry): void {
  mkdirSync(dir, { recursive: true });
  atomicWrite(
    join(dir, REGISTRY_FILENAME),
    JSON.stringify(registry, null, 2) + "\n"
  );
  atomicWrite(join(dir, PINS_FILENAME), renderPinsManifest(registry));
}

function atomicWrite(target: string, content: string): void {
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, target);
  } catch (e) {
    // Best-effort cleanup of the temp file on failure.
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw e;
  }
}

export function addEntry(
  registry: Registry,
  entry: {
    claimId: string;
    prId: string;
    claim: Claim;
    filename: string;
    bugFixOrigin?: boolean;
  }
): Registry {
  if (registry.claims.some((c) => c.claimId === entry.claimId)) {
    return registry; // idempotent
  }
  const pinnedBy =
    process.env.GITHUB_ACTOR ?? process.env.USER ?? undefined;
  return {
    ...registry,
    claims: [
      ...registry.claims,
      {
        ...entry,
        pinnedAt: new Date().toISOString(),
        pinnedBy,
        status: "active" as const,
        covers: coverageFromClaim(entry.claim),
        badCase: badCaseForClaim(entry.claim),
      },
    ],
  };
}

// badCaseForClaim and detectBugFixPhrase live in claimParser.ts (the
// browser-safe home for claim-derived helpers — registry.ts imports
// node:fs, so templates and the landing demo can't import from here).
// Re-exported for ergonomics so existing code paths keep working.
export { badCaseForClaim, detectBugFixPhrase } from "./claimParser.js";

// Derive coverage metadata from a Claim. Route-based claims store
// their route; file-based claims store their source file. CLI-output
// templates that depend on opaque binary behavior return empty
// coverage (see PinCoverage comment for the rationale). Pure
// function — browser-safe so the landing demo + tests don't need
// the registry I/O layer.
export function coverageFromClaim(claim: Claim): PinCoverage {
  switch (claim.template) {
    case "rate-limit":
    case "auth-required":
    case "permission-required":
    case "tier-cap":
    case "idempotent":
    case "returns-status":
      return { routes: [claim.route] };
    case "library-returns":
      // modulePath IS the source — direct edits to it should flag
      // the pin as touched.
      return { files: [claim.modulePath] };
    case "lockfile-integrity":
      // Lockfile pin protects exactly one file — its sha hash.
      return { files: [claim.lockfilePath] };
    case "config-invariant":
      return { files: [claim.configPath] };
    case "package-exports-exist":
      return { files: [claim.modulePath] };
    case "secret-not-public":
      // Repo-wide scan — no single file to map to coverage.
      return {};
    case "cli-output-contains":
    case "cli-exits-zero":
    case "cli-creates-file":
    case "cli-json-shape":
    case "cli-flag-supported":
      // CLI templates assert about a binary's externally-observable
      // behavior. We can't reliably infer which source file (out of
      // the entire CLI codebase) would affect that behavior just
      // from the invocation. Pin still runs in CI either way — it
      // just won't surface in findTouchedPins(). v0.2 will accept
      // explicit covers via a generator-emitted header annotation.
      return {};
    case "url-literal-preserved":
      return { files: [claim.filePath] };
    case "tsc-clean":
      // Repo-wide: any TS source change could affect tsc. We don't
      // try to map all .ts files; pin still runs in CI.
      return {};
    case "module-export-stable":
      return { files: [claim.modulePath] };
    case "react-route-registered":
      return { files: [claim.routerFilePath] };
    case "webhook-handler-exists":
      return { files: [claim.filePath] };
    case "import-path-resolves":
      return { files: [claim.sourceFilePath] };
    case "changed-literal-preserved":
      return { files: [claim.filePath] };
    case "form-submit-error-handling":
      return { files: [claim.filePath] };
    case "page-renders":
      return { routes: [claim.route] };
    case "validation-rejects-bad":
      return { routes: [claim.route] };
    case "happy-path-with-side-effect":
      return { routes: [claim.route] };
    case "journey":
      // All routes the journey touches — any edit to any step's
      // handler is reason to re-run the journey.
      return { routes: claim.steps.map((s) => s.route) };
  }
}

export function retireEntry(
  registry: Registry,
  claimId: string,
  reason: string,
  retiredBy: string
): Registry {
  return {
    ...registry,
    claims: registry.claims.map((c) =>
      c.claimId === claimId
        ? {
            ...c,
            status: "retired" as const,
            retiredAt: new Date().toISOString(),
            retireReason: reason,
            retiredBy,
          }
        : c
    ),
  };
}

export function renderPinsManifest(registry: Registry): string {
  const active = registry.claims.filter((c) => c.status === "active");
  const retired = registry.claims.filter((c) => c.status === "retired");

  const lines: string[] = [
    "# Pinned Claims",
    "",
    "Auto-maintained by [pinnedai](https://pinnedai.dev). Each row is a permanent CI test guarding the original PR claim.",
    "",
    "**Do not edit by hand** — use `pinned generate` (after a PR with a claim) and `pinned retire <claim-id> --reason=\"...\"` to mutate this file.",
    "",
  ];

  if (active.length === 0 && retired.length === 0) {
    lines.push(
      "_No pins yet. Open a PR with a claim like `Rate-limits /api/users to 60 req/min.` to add one, then run `pinned generate`._",
      ""
    );
    return lines.join("\n");
  }

  if (active.length > 0) {
    // Bug-fix-origin pins surface first. They encode a specific
    // failure mode the original PR already had to fix, so they're
    // disproportionately likely to catch a future regression — and
    // they make the "Pinned protected the things we already knew
    // were fragile" story land harder when readers scan PINS.md.
    const bugFixActive = active.filter((c) => c.bugFixOrigin);
    const regularActive = active.filter((c) => !c.bugFixOrigin);
    const ordered = [...bugFixActive, ...regularActive];

    lines.push(
      "## Active",
      "",
      "| Claim | Test | PR | Pinned by | Pinned |",
      "|---|---|---|---|---|"
    );
    for (const e of ordered) {
      const label = escapeMarkdownCell(e.filename);
      const href = encodeMarkdownLinkTarget(e.filename);
      // Tag bug-fix-origin pins inline with 🔁 so scanners can see at
      // a glance which pins came from regression-fix PRs — those are
      // the ones most likely to fire a real save.
      const tag = e.bugFixOrigin ? " 🔁" : "";
      lines.push(
        `| ${claimLabel(e.claim)}${tag} | [${label}](${href}) | ${prLabel(e.prId)} | ${actorLabel(e.pinnedBy)} | ${shortDate(e.pinnedAt)} |`
      );
    }
    if (bugFixActive.length > 0) {
      lines.push("");
      lines.push(
        `_🔁 = pin extracted from a bug-fix PR (${bugFixActive.length} of ${active.length})_`
      );
    }
    lines.push("");
  }

  if (retired.length > 0) {
    lines.push(
      "## Retired",
      "",
      "| Claim | Test | PR | Retired by | Retired | Reason |",
      "|---|---|---|---|---|---|"
    );
    for (const e of retired) {
      const reason = escapeMarkdownCell(e.retireReason ?? "");
      const label = escapeMarkdownCell(e.filename);
      const href = encodeMarkdownLinkTarget("retired/" + e.filename);
      lines.push(
        `| ${claimLabel(e.claim)} | [retired/${label}](${href}) | ${prLabel(e.prId)} | ${actorLabel(e.retiredBy)} | ${shortDate(e.retiredAt ?? "")} | ${reason} |`
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

function claimLabel(c: Claim): string {
  switch (c.template) {
    case "rate-limit":
      return `\`rate-limit ${escapeMarkdownCell(c.route)}\` (${c.rate}/${c.window})`;
    case "auth-required":
      return `\`auth-required ${escapeMarkdownCell(c.route)}\``;
    case "permission-required":
      return `\`${escapeMarkdownCell(c.role)}-only ${escapeMarkdownCell(c.route)}\``;
    case "tier-cap":
      return `\`tier-cap ${escapeMarkdownCell(c.route)}\` (${escapeMarkdownCell(c.tier)}: ${c.cap} ${escapeMarkdownCell(c.resource)})`;
    case "idempotent":
      return `\`idempotent ${escapeMarkdownCell(c.route)}\` (key: \`${escapeMarkdownCell(c.idField)}\`)`;
    case "returns-status":
      return `\`${c.method} ${escapeMarkdownCell(c.route)} → ${c.status}\`${c.condition ? ` on ${escapeMarkdownCell(c.condition)}` : ""}`;
    case "cli-output-contains":
      // For CLI templates, `route` is the command, not a URL.
      return `\`cli ${escapeMarkdownCell(c.route)}\` (stdout ⊇ \`${truncateForCell(c.text, 40)}\`)`;
    case "cli-exits-zero":
      return `\`cli ${escapeMarkdownCell(c.route)}\` (exits 0)`;
    case "cli-creates-file":
      return `\`cli ${escapeMarkdownCell(c.route)}\` (creates \`${escapeMarkdownCell(c.filePath)}\`)`;
    case "cli-flag-supported":
      return `\`cli ${escapeMarkdownCell(c.route)}\` (supports \`${escapeMarkdownCell(c.flag)}\`)`;
    case "cli-json-shape":
      return `\`cli ${escapeMarkdownCell(c.route)}\` (JSON keys: ${c.keys.map((k) => `\`${escapeMarkdownCell(k)}\``).join(", ")})`;
    case "library-returns":
      return `\`lib ${escapeMarkdownCell(c.functionName)} in ${escapeMarkdownCell(c.modulePath)}\``;
    case "lockfile-integrity":
      return `\`lockfile ${escapeMarkdownCell(c.lockfilePath)}\` (sha256: \`${c.expectedSha256.slice(0, 12)}…\`)`;
    case "config-invariant":
      return `\`config ${escapeMarkdownCell(c.label)}\` in \`${escapeMarkdownCell(c.configPath)}\``;
    case "package-exports-exist":
      return `\`exports ${escapeMarkdownCell(c.modulePath)}\` (${c.exports.length} symbol${c.exports.length === 1 ? "" : "s"})`;
    case "secret-not-public":
      return `\`no ${escapeMarkdownCell(c.publicPrefix)}*<secret>\` (server secrets stay private)`;
    case "url-literal-preserved":
      return `\`url ${escapeMarkdownCell(c.urlLiteral)}\` in \`${escapeMarkdownCell(c.filePath)}\``;
    case "tsc-clean":
      return `\`tsc --noEmit clean\` (${escapeMarkdownCell(c.tsconfigPath)})`;
    case "module-export-stable":
      return `\`export ${escapeMarkdownCell(c.exportName)}\` from \`${escapeMarkdownCell(c.modulePath)}\``;
    case "react-route-registered":
      return `\`<Route ${escapeMarkdownCell(c.routePath)}>\` in \`${escapeMarkdownCell(c.routerFilePath)}\``;
    case "webhook-handler-exists":
      return `\`${escapeMarkdownCell(c.provider)} webhook\` at \`${escapeMarkdownCell(c.filePath)}\``;
    case "import-path-resolves":
      return `\`import ${escapeMarkdownCell(c.importPath)}\` from \`${escapeMarkdownCell(c.sourceFilePath)}\``;
    case "changed-literal-preserved":
      return `\`${escapeMarkdownCell(c.shape)}: ${escapeMarkdownCell(c.newValue)}\` in \`${escapeMarkdownCell(c.filePath)}\``;
    case "form-submit-error-handling":
      return `\`form error-handling\` in \`${escapeMarkdownCell(c.filePath)}\``;
    case "page-renders":
      return `\`GET ${escapeMarkdownCell(c.route)}\` renders`;
    case "validation-rejects-bad":
      return `\`${escapeMarkdownCell(c.method)} ${escapeMarkdownCell(c.route)}\` rejects bad input`;
    case "happy-path-with-side-effect":
      return `\`${escapeMarkdownCell(c.method)} ${escapeMarkdownCell(c.route)}\` writes to \`${escapeMarkdownCell(c.sideEffectTarget)}\``;
    case "journey": {
      const path = c.steps
        .map((s) => `${s.method} ${escapeMarkdownCell(s.route)}`)
        .join(" → ");
      return `\`journey: ${escapeMarkdownCell(c.label)}\` (${path})`;
    }
  }
}

function truncateForCell(s: string, max: number): string {
  const escaped = escapeMarkdownCell(s);
  return escaped.length > max ? escaped.slice(0, max - 1) + "…" : escaped;
}

function prLabel(prId: string): string {
  const m = /^pr-(\d+)$/.exec(prId);
  return m ? `#${m[1]}` : `\`${escapeMarkdownCell(prId)}\``;
}

function shortDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function actorLabel(actor: string | undefined): string {
  if (!actor) return "—";
  // GitHub username → @-link to their profile (only for clean usernames)
  if (/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(actor)) {
    return `[@${actor}](https://github.com/${actor})`;
  }
  // Fall through: escape for markdown-table safety
  return escapeMarkdownCell(actor);
}

// Markdown table cells break on `|` and on newlines. They also render
// embedded backticks / links / images as live markdown. We escape these
// so a malicious route name (e.g. from an LLM-extracted claim) can't
// corrupt PINS.md or inject phishing links.
export function escapeMarkdownCell(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/`/g, "\\`")
    .replace(/[\r\n]+/g, " ");
}

// Markdown link URLs need different treatment — backticks and pipes
// inside the URL are syntactically allowed but can break out via
// `](javascript:...)` patterns. Encode the whole filename as a path
// component so weird chars don't form valid markdown link syntax.
// Filenames in our codebase are always claimId.test.ts where claimId
// matches SAFE_ID_RE, so this is defense-in-depth.
export function encodeMarkdownLinkTarget(filename: string): string {
  // Strict allowlist for known filename format: alphanumeric + `-_./`
  if (!/^[a-zA-Z0-9_./-]+$/.test(filename)) return "INVALID_FILENAME";
  return filename.replace(/ /g, "%20");
}

// ---------- CATCHES.md ----------
// The customer-visible catch ledger. Lives at tests/pinned/CATCHES.md.
// Written by `pinned test` whenever a previously-passing pin starts
// failing. Each catch entry has:
//   - date (ISO trimmed to day)
//   - the pin claim that fired
//   - "Without Pinned, this would have ___" plain-English impact
//   - which PR originally pinned this (provenance)
//   - whether the pin was extracted from a bug-fix PR (🔁 marker)
//
// Why a separate file (not just PINS.md): PINS.md describes the
// contract surface; CATCHES.md is the evidence ledger. Reading
// CATCHES.md tells a story ("Pinned has caught 3 regressions in
// this repo — here's what each was"). Compounds over time as the
// permanent record of saves.
export function renderCatchesMarkdown(input: {
  catchHistory: CatchRenderRecord[];
  breaksCaught: number;
}): string {
  const { catchHistory, breaksCaught } = input;
  const lines: string[] = [
    "# Pinned catches",
    "",
    "Auto-maintained by [pinnedai](https://pinnedai.dev). Each entry is a regression Pinned caught before it reached production — the actual saves.",
    "",
    "**Do not edit by hand** — this file is rewritten on every `pinned test` run that detects a new catch.",
    "",
  ];

  if (catchHistory.length === 0) {
    lines.push(
      "_No catches yet. Pinned is quietly verifying your pins on every commit; if any future change ever breaks a protected behavior, the catch will show up here._",
      ""
    );
    return lines.join("\n");
  }

  lines.push(
    `**Lifetime catches:** ${breaksCaught} (showing ${Math.min(catchHistory.length, breaksCaught)} most recent)`,
    ""
  );

  for (const c of catchHistory) {
    const date = c.caughtAt ? c.caughtAt.slice(0, 10) : "—";
    const bugFixTag = c.bugFixOrigin ? " 🔁" : "";
    const pinTitle = c.template
      ? `${c.template}${c.route ? " on " + c.route : ""}`
      : "pinned behavior";
    lines.push(`## ${date} · ${escapeMarkdownCell(pinTitle)}${bugFixTag}`);
    lines.push("");
    if (c.claimText) {
      lines.push(`**Original claim:** ${escapeMarkdownCell(c.claimText)}`);
      lines.push("");
    }
    if (c.badCase) {
      lines.push(
        `**Without Pinned, this would have shipped:** ${escapeMarkdownCell(c.badCase)}`
      );
      lines.push("");
    }
    if (c.originPr) {
      const prLabelText = prLabel(c.originPr);
      lines.push(`**Originally pinned in:** ${prLabelText}`);
      lines.push("");
    }
    if (c.claimId) {
      const testFile = `tests/pinned/${c.claimId}.test.ts`;
      lines.push(
        `**Test that caught it:** [\`${escapeMarkdownCell(testFile)}\`](${encodeMarkdownLinkTarget(c.claimId + ".test.ts")})`
      );
      lines.push("");
    }
    lines.push("---");
    lines.push("");
  }

  // Bug-fix-origin catches deserve a callout — they're the strongest
  // narrative ("the same bug Pinned was created to prevent fired
  // again, and Pinned caught it the second time too").
  const bugFixCatches = catchHistory.filter((c) => c.bugFixOrigin).length;
  if (bugFixCatches > 0) {
    lines.push(
      `_🔁 = pin extracted from a bug-fix PR (${bugFixCatches} of ${catchHistory.length} catches). These are the cases where Pinned re-caught a regression that was already fixed once._`
    );
    lines.push("");
  }

  return lines.join("\n");
}
