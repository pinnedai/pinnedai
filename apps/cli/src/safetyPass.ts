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

export type Severity = "warn" | "info";

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
    for (const [name, lineNo] of collectEnvUsage(content)) {
      if (
        name.startsWith("NEXT_PUBLIC_") &&
        /SECRET|TOKEN|KEY|PASSWORD|API_KEY/i.test(name) &&
        // Exclude common false-positives (PUBLISHABLE_KEY is meant to be public)
        !/PUBLISHABLE/i.test(name)
      ) {
        findings.push({
          rule: "next-public-secret-shape",
          severity: "warn",
          file,
          line: lineNo,
          snippet: lines[lineNo - 1]?.trim().slice(0, 120),
          message: `Env var \`${name}\` is exposed to the browser (NEXT_PUBLIC_*) but its name implies a secret.`,
          suggested: `Move secrets to a server-only env var (drop the NEXT_PUBLIC_ prefix). If this is genuinely a publishable key, rename it (e.g. NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY).`,
        });
      }
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

    // Rule 5: lint escape hatches
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (
        /\/\/\s*@ts-ignore/.test(line) ||
        /\/\/\s*@ts-nocheck/.test(line) ||
        /\/\*\s*eslint-disable/.test(line) ||
        /\/\/\s*eslint-disable-(next-line|line)/.test(line)
      ) {
        findings.push({
          rule: "lint-escape-hatch",
          severity: "info",
          file,
          line: i + 1,
          snippet: line.trim().slice(0, 120),
          message: `Type or lint suppression. AI-generated suppressions often hide real bugs.`,
          suggested: `Replace with a typed/lint-clean fix, or add a comment explaining why the suppression is necessary.`,
        });
      }
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
