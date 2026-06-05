// Safety Pass — deterministic, near-zero-cost static scan for AI
// coding mistakes that pinned should warn about. Never calls an LLM.
//
// Designed to feel instant: scans files synchronously, returns
// findings. The CLI (`pinned safety`) caches the result count in
// .last-status.json so the statusline + hook can read it without
// re-scanning.
//
// Five v0.1 checks (all deterministic):
//   1. Env var used in code but missing from .env.example
//   2. NEXT_PUBLIC_* env var name contains SECRET / TOKEN / KEY /
//      PASSWORD — public-by-name + secret-by-shape = leak signal
//   3. Public CORS wildcard ("*") in handler/middleware
//   4. Destructive SQL (DROP TABLE / DROP DATABASE / TRUNCATE) in
//      migration files
//   5. @ts-ignore / @ts-nocheck / eslint-disable in source files
//      (any usage — flagged for human review, not a hard error)
//
// Each finding has a severity (warn | info), a file path, the
// triggering line/snippet, and a one-line suggested next step.

import { readFileSync, existsSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";

export type Severity = "block" | "warn" | "info";

export type SafetyFinding = {
  rule: SafetyRule;
  severity: Severity;
  file: string;
  line?: number;
  snippet?: string;
  message: string;
  suggested: string;
};

export type SafetyRule =
  | "env-var-not-documented"
  | "next-public-secret-shape"
  | "next-public-secret-exposed"
  | "cors-wildcard"
  | "destructive-sql"
  | "lint-escape-hatch";

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "out",
  ".turbo",
  ".cache",
  "coverage",
  "tests/pinned",
  "audit",
]);

const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

export function runSafetyPass(root: string): SafetyFinding[] {
  const sources = walkSources(root);
  const findings: SafetyFinding[] = [];

  // Build env-var inventory from .env.example (if present)
  const envExamplePath = join(root, ".env.example");
  const documentedEnvVars = existsSync(envExamplePath)
    ? readEnvNames(readFileSync(envExamplePath, "utf8"))
    : null; // null = no .env.example, skip the check rather than false-positive

  for (const file of sources) {
    const abs = join(root, file);
    let content: string;
    try {
      content = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n");

    // Rule 1 + 2: env-var checks
    if (documentedEnvVars !== null) {
      const used = collectEnvUsage(content);
      for (const [name, lineNo] of used) {
        if (!documentedEnvVars.has(name)) {
          findings.push({
            rule: "env-var-not-documented",
            severity: "warn",
            file,
            line: lineNo,
            snippet: lines[lineNo - 1]?.trim().slice(0, 120),
            message: `Env var \`${name}\` is used in code but not listed in .env.example.`,
            suggested: `Add ${name}= to .env.example so teammates and CI know it's required.`,
          });
        }
      }
    }
    // Rule 2 fires regardless of .env.example
    //
    // 0.3.2 INVERSION (Cipherwake-dogfood A, upgraded): rather than
    // just suppressing the publishable-key FP, INVERT — recognize
    // explicit publishable signals AS publishable (quiet), and
    // recognize explicit secret signals on NEXT_PUBLIC_* as CRITICAL.
    //
    // Anon and service-role Supabase keys are both JWTs — identical
    // value shape — so we can't discriminate on value. The NAME is the
    // signal. NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY would hand the
    // whole DB (RLS-bypassing) to every visitor — catastrophic and
    // a frequent AI mistake. NEXT_PUBLIC_SUPABASE_ANON_KEY is designed
    // to be public — quiet.
    // NOTE on regex anchors: `\b` does NOT form a boundary between
    // `_` and other word chars in JS, so `\bANON\b` does NOT match
    // inside "NEXT_PUBLIC_SUPABASE_ANON_KEY". We use explicit
    // underscore-or-edge anchors: (?:^|_)TOKEN(?:_|$).
    const PUBLISHABLE_NAME_PATTERNS = [
      /PUBLISHABLE/i,                                              // Stripe-style PUBLISHABLE_KEY
      /(?:^|_)ANON(?:_|$)/i,                                       // Supabase NEXT_PUBLIC_*_ANON_KEY
      /(?:^|_)ANON_KEY(?:_|$)/i,                                   // explicit ANON_KEY token
      /(?:^|_)PUBLIC_KEY(?:_|$)/i,                                 // explicit PUBLIC_KEY label
      /(?:^|_)SITE_KEY(?:_|$)/i,                                   // reCAPTCHA SITE_KEY
      /(?:^|_)CLIENT_KEY(?:_|$)/i,                                 // OAuth CLIENT_KEY
      /(?:^|_)APP_(?:ID|KEY)(?:_|$)/i,                             // Algolia APP_ID, Posthog APP_KEY
    ];
    // CRITICAL: NEXT_PUBLIC_* + one of these tokens = secret shipped
    // to the browser. AI mistake-class, real and frequent.
    const SECRET_NAME_PATTERNS_ON_NEXT_PUBLIC = [
      /(?:^|_)SERVICE_ROLE(?:_|$)/i,        // Supabase service-role JWT (RLS-bypass)
      /(?:^|_)SERVICE_KEY(?:_|$)/i,         // alternate spelling
      /(?:^|_)SECRET(?:_KEY)?(?:_|$)/i,     // explicit SECRET / SECRET_KEY
      /(?:^|_)PRIVATE(?:_KEY)?(?:_|$)/i,    // PRIVATE_KEY
      /(?:^|_)ROOT_KEY(?:_|$)/i,            // root-key shapes
      /(?:^|_)MASTER_KEY(?:_|$)/i,          // explicit master key
      /(?:^|_)ADMIN_KEY(?:_|$)/i,           // admin / superuser key
      /sk_(?:test|live)_/i,                 // Stripe secret key pattern in the name
    ];
    for (const [name, lineNo] of collectEnvUsage(content)) {
      if (!name.startsWith("NEXT_PUBLIC_")) continue;
      if (!/SECRET|TOKEN|KEY|PASSWORD|API_KEY|SERVICE_ROLE|PRIVATE/i.test(name)) continue;

      // CRITICAL path first — name explicitly signals a secret.
      if (SECRET_NAME_PATTERNS_ON_NEXT_PUBLIC.some((re) => re.test(name))) {
        findings.push({
          rule: "next-public-secret-exposed",
          severity: "block",
          file,
          line: lineNo,
          snippet: lines[lineNo - 1]?.trim().slice(0, 120),
          message: `CRITICAL: \`${name}\` ships a SECRET to the browser. The name explicitly signals a privileged key (service-role / secret / private). Anyone visiting the site can read it from window.process.env at runtime.`,
          suggested: `Rename to drop the NEXT_PUBLIC_ prefix (server-only). For Supabase: the service-role key bypasses RLS and must NEVER be NEXT_PUBLIC_; use the ANON key on the client. For Stripe: use the PUBLISHABLE_KEY on the client, not the SECRET_KEY.`,
        });
        continue;
      }

      // Publishable signals — intended-public, no warning.
      if (PUBLISHABLE_NAME_PATTERNS.some((re) => re.test(name))) continue;

      // Old warn path — ambiguous KEY/TOKEN name on NEXT_PUBLIC_*.
      findings.push({
        rule: "next-public-secret-shape",
        severity: "warn",
        file,
        line: lineNo,
        snippet: lines[lineNo - 1]?.trim().slice(0, 120),
        message: `Env var \`${name}\` is exposed to the browser (NEXT_PUBLIC_*) but its name implies a secret.`,
        suggested: `Move secrets to a server-only env var (drop the NEXT_PUBLIC_ prefix). If this is genuinely a publishable key, rename it (e.g. NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY, NEXT_PUBLIC_*_ANON_KEY).`,
      });
    }

    // Rule 3: CORS wildcard
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match: Access-Control-Allow-Origin: * — in headers or fetch
      // configs. We're conservative: look for "*" inside CORS-shaped
      // contexts to avoid false-positives on glob imports.
      if (
        /Access-Control-Allow-Origin["']?\s*[,:]\s*["']\*["']/.test(line) ||
        /origin\s*:\s*["']\*["']/.test(line)
      ) {
        findings.push({
          rule: "cors-wildcard",
          severity: "warn",
          file,
          line: i + 1,
          snippet: line.trim().slice(0, 120),
          message: `Public CORS wildcard ("*") set — any origin can call this route.`,
          suggested: `Restrict CORS to known origins, or document why "*" is intentional. Consider adding an auth-required pin if this is a private API.`,
        });
      }
    }

    // Rule 5: lint escape hatches — TIERED (0.3.2 FIX, Cipherwake-
    // dogfood B).
    //
    // Old behavior flagged every eslint-disable-next-line equally,
    // including commonly-legitimate ones like @next/next/no-img-element
    // (data-URIs, dynamic <img>, places next/image doesn't fit). The
    // dogfood report: "Treating every suppression as dangerous buries
    // the ones that matter."
    //
    // New tiers:
    //   DANGEROUS (warn) → @ts-ignore, @ts-nocheck, no-explicit-any
    //                      disabled, file-scoped eslint-disable, any
    //                      security-related rule (security/, no-eval,
    //                      no-unsafe-*).
    //   COMMONLY-LEGIT (info) → no-img-element, scoped exhaustive-deps,
    //                            jsx-a11y/* (project-specific accessibility
    //                            calls), display-name.
    //
    // The DANGEROUS set is the actual signal; the COMMONLY-LEGIT set is
    // surface noise. Tiering preserves the catch on the bugs that
    // matter without burying them.
    const DANGEROUS_SUPPRESSION_PATTERNS = [
      /\/\/\s*@ts-ignore/,
      /\/\/\s*@ts-nocheck/,
      /\/\*\s*eslint-disable\b/,                                  // file-scoped disable (no -next-line)
      /eslint-disable-(?:next-line|line)\s+(?:[^,]+,\s*)*no-explicit-any/i,
      /eslint-disable-(?:next-line|line)\s+(?:[^,]+,\s*)*@typescript-eslint\/no-explicit-any/i,
      /eslint-disable-(?:next-line|line)\s+(?:[^,]+,\s*)*no-eval/i,
      /eslint-disable-(?:next-line|line)\s+(?:[^,]+,\s*)*no-unsafe-/i,
      /eslint-disable-(?:next-line|line)\s+(?:[^,]+,\s*)*security\//i,
      /eslint-disable-(?:next-line|line)\s+(?:[^,]+,\s*)*no-restricted-imports/i,
    ];
    const COMMONLY_LEGIT_SUPPRESSION_PATTERNS = [
      /eslint-disable-(?:next-line|line)\s+(?:[^,]+,\s*)*@next\/next\/no-img-element/i,
      /eslint-disable-(?:next-line|line)\s+(?:[^,]+,\s*)*react-hooks\/exhaustive-deps/i,
      /eslint-disable-(?:next-line|line)\s+(?:[^,]+,\s*)*jsx-a11y\//i,
      /eslint-disable-(?:next-line|line)\s+(?:[^,]+,\s*)*react\/display-name/i,
    ];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isLintEscape = /\/\/\s*@ts-(?:ignore|nocheck)|\/\*\s*eslint-disable\b|\/\/\s*eslint-disable-(?:next-line|line)/.test(line);
      if (!isLintEscape) continue;
      const isDangerous = DANGEROUS_SUPPRESSION_PATTERNS.some((re) => re.test(line));
      const isCommonlyLegit = COMMONLY_LEGIT_SUPPRESSION_PATTERNS.some((re) => re.test(line));
      // Suppress entirely when ONLY commonly-legit rules are disabled
      // and no dangerous rules ride along.
      if (isCommonlyLegit && !isDangerous) continue;
      findings.push({
        rule: "lint-escape-hatch",
        severity: isDangerous ? "warn" : "info",
        file,
        line: i + 1,
        snippet: line.trim().slice(0, 120),
        message: isDangerous
          ? `DANGEROUS suppression (${line.includes("@ts-") ? "type-check disabled" : "high-risk lint rule disabled"}). These hide real bugs disproportionately often.`
          : `Type or lint suppression. AI-generated suppressions sometimes hide real bugs.`,
        suggested: `Replace with a typed/lint-clean fix, or add a comment explaining why the suppression is necessary.`,
      });
    }
  }

  // Rule 4: destructive SQL in migrations
  const migrationFiles = sources.filter(
    (f) =>
      /migrations?\//i.test(f) || f.endsWith(".sql")
  );
  for (const file of migrationFiles) {
    let content: string;
    try {
      content = readFileSync(join(root, file), "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match dangerous destructive patterns. DROP COLUMN often
      // intentional in migrations — only flag DROP TABLE/DATABASE,
      // TRUNCATE, DELETE without WHERE.
      if (
        /\bDROP\s+TABLE\b/i.test(line) ||
        /\bDROP\s+DATABASE\b/i.test(line) ||
        /\bTRUNCATE\s+(TABLE\s+)?\w+/i.test(line) ||
        /\bDELETE\s+FROM\s+\w+\s*(?:;|--|$)/i.test(line) // DELETE without WHERE
      ) {
        findings.push({
          rule: "destructive-sql",
          severity: "warn",
          file,
          line: i + 1,
          snippet: line.trim().slice(0, 120),
          message: `Destructive SQL detected in migration file.`,
          suggested: `Confirm this is intentional. If preserving data, add a corresponding backup step. Consider an auth-required or idempotent pin for any route that triggers this migration.`,
        });
      }
    }
  }

  return findings;
}

function walkSources(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const abs = join(dir, name);
      const relPath = rel ? join(rel, name) : name;
      if (IGNORE_DIRS.has(name) || IGNORE_DIRS.has(relPath)) continue;
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      // Skip symlinks defensively (avoid loops + escapes)
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        walk(abs, relPath);
        continue;
      }
      if (!st.isFile()) continue;
      const ext = name.slice(name.lastIndexOf("."));
      if (SOURCE_EXT.has(ext) || ext === ".sql") {
        out.push(relPath);
      }
    }
  };
  walk(root, "");
  return out;
}

// Extract env var NAMES from a file's contents. Matches:
//   process.env.FOO
//   process.env["FOO"]
//   process.env['FOO']
// Returns Map<name, firstLineNumber>.
function collectEnvUsage(content: string): Map<string, number> {
  const out = new Map<string, number>();
  const lines = content.split("\n");
  const patterns = [
    /process\.env\.([A-Z][A-Z0-9_]*)/g,
    /process\.env\[["']([A-Z][A-Z0-9_]*)["']\]/g,
  ];
  for (let i = 0; i < lines.length; i++) {
    for (const re of patterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(lines[i])) !== null) {
        if (!out.has(m[1])) out.set(m[1], i + 1);
      }
    }
  }
  return out;
}

// Parse the set of declared variable names from a .env or .env.example
// file. Lines like `FOO=bar` or `FOO=` count as documented.
function readEnvNames(content: string): Set<string> {
  const out = new Set<string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = /^([A-Z][A-Z0-9_]*)\s*=/.exec(trimmed);
    if (m) out.add(m[1]);
  }
  return out;
}

// Human-readable summary for terminal / PR-comment use.
export function renderSafetyHuman(findings: SafetyFinding[]): string {
  if (findings.length === 0) {
    return "✓ Safety Pass: no findings.";
  }
  const lines: string[] = [];
  const warnCount = findings.filter((f) => f.severity === "warn").length;
  const infoCount = findings.length - warnCount;
  lines.push(
    `Safety Pass: ${warnCount} warning${warnCount === 1 ? "" : "s"}` +
      (infoCount ? ` · ${infoCount} info` : "")
  );
  lines.push("");
  for (const f of findings) {
    const icon = f.severity === "warn" ? "⚠" : "·";
    const loc = f.line ? `${f.file}:${f.line}` : f.file;
    lines.push(`  ${icon} ${f.message}`);
    lines.push(`     ${loc}`);
    if (f.snippet) lines.push(`     > ${f.snippet}`);
    lines.push(`     → ${f.suggested}`);
    lines.push("");
  }
  return lines.join("\n");
}

// Compact markdown for the PR-comment surface.
export function renderSafetyMarkdown(findings: SafetyFinding[]): string {
  if (findings.length === 0) return "";
  const lines: string[] = [];
  const warns = findings.filter((f) => f.severity === "warn");
  const infos = findings.filter((f) => f.severity === "info");
  if (warns.length > 0) {
    lines.push("**Safety Pass findings:**");
    for (const f of warns.slice(0, 8)) {
      lines.push(`- ⚠ ${f.message} (\`${f.file}${f.line ? ":" + f.line : ""}\`)`);
    }
    if (warns.length > 8) {
      lines.push(`- …and ${warns.length - 8} more — run \`pinned safety\` locally for the full list.`);
    }
  }
  if (infos.length > 0) {
    lines.push("");
    lines.push(`<details><summary>${infos.length} info-level note${infos.length === 1 ? "" : "s"} ▼</summary>`);
    lines.push("");
    for (const f of infos.slice(0, 10)) {
      lines.push(`- ${f.message} (\`${f.file}${f.line ? ":" + f.line : ""}\`)`);
    }
    lines.push("</details>");
  }
  return lines.join("\n");
}
