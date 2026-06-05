// Template: env-required (0.2.23+)
//
// Catches the FIRST-TIME bug class: code reads `process.env.X` but
// X isn't declared in any `.env.example` / `.env.local.example` /
// `next.config.js` env block / `vercel.json env` / `wrangler.toml`
// at deploy time. Cloned-repo first-runs silently get `undefined`.
//
// Pin shape: at test time, scan the repo for declaration sources +
// assert each REQUIRED_KEY (captured at pin-creation, the set of
// env reads that were declared then) is still declared somewhere.
// AI silently removes a key from `.env.example` → red on that key.
//
// FIRST-TIME bug catching, not regression — the contract is between
// the code and the example file, both inside the same PR.

import type { EnvRequiredClaim } from "../claimParser.js";
import { claimSlug } from "../claimParser.js";
import type { GenerateOpts, GeneratedTest } from "./rateLimit.js";

export function generateEnvRequiredTest(
  claim: EnvRequiredClaim,
  opts: GenerateOpts
): GeneratedTest {
  const slug = claimSlug(claim);
  const claimId = `${opts.prId}-${slug}`;
  const filename = `${claimId}.test.ts`;

  const sourcesLiteral = JSON.stringify(claim.declarationSources);
  const requiredLiteral = JSON.stringify(claim.requiredKeys);

  const content = `// ═══════════════════════════════════════════════════════════════
// ◆ Pinned by pinnedai — https://pinnedai.dev
// generated-by: pinnedai@${opts.pinnedVersion}
// ═══════════════════════════════════════════════════════════════
// Env-required: ${claim.requiredKeys.length} env key${claim.requiredKeys.length === 1 ? "" : "s"} read by code AND declared
//
// Original claim:  ${JSON.stringify(claim.raw)}
// Source PR:       ${opts.prId}
// Template:        env-required
// Declaration:     ${claim.declarationSources.join(", ")}
//
// What this checks: at test time, scan declaration sources and
// assert each captured required-key is still declared. When AI
// silently removes a key from \`.env.example\` while leaving the
// \`process.env.X\` read in code, the pin fails on that key.
//
// To retire:
//   pinned retire ${claimId} --reason="..."
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const DECLARATION_SOURCES_AT_PIN: string[] = ${sourcesLiteral};
const REQUIRED_KEYS: string[] = ${requiredLiteral};

function parseEnvFile(content: string): string[] {
  const keys: string[] = [];
  for (const rawLine of content.split(/\\r?\\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\\s+)?([A-Z][A-Z0-9_]*)\\s*=/i.exec(line);
    if (m) keys.push(m[1]);
  }
  return keys;
}

function parseNextConfigEnv(content: string): string[] {
  const keys: string[] = [];
  const m = /(?:^|[^\\w])env\\s*:\\s*\\{([^}]*)\\}/.exec(content);
  if (!m) return keys;
  for (const km of m[1].matchAll(/\\b([A-Z][A-Z0-9_]+)\\s*:/g)) keys.push(km[1]);
  return keys;
}

function parseVercelJsonEnv(content: string): string[] {
  try {
    const j = JSON.parse(content);
    const env = j?.env;
    if (env && typeof env === "object" && !Array.isArray(env)) {
      return Object.keys(env).filter((k) => /^[A-Z][A-Z0-9_]*$/.test(k));
    }
  } catch { /* ignore */ }
  return [];
}

function parseWranglerToml(content: string): string[] {
  const keys: string[] = [];
  const blockRe = /\\[vars\\][\\s\\S]*?(?=\\n\\[|$)/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(content)) !== null) {
    for (const lm of m[0].matchAll(/^\\s*([A-Z][A-Z0-9_]*)\\s*=/gm)) keys.push(lm[1]);
  }
  return keys;
}

function isEnvDeclarationFile(p: string): boolean {
  return /(?:^|\\/)\\.env(?:\\.[\\w.-]+)?\\.example$/.test(p) ||
         /(?:^|\\/)\\.env\\.template$/.test(p) ||
         /(?:^|\\/)\\.env\\.sample$/.test(p) ||
         /(?:^|\\/)\\.env\\.dist$/.test(p) ||
         /(?:^|\\/)\\.env\\.local\\.example$/.test(p);
}

function collectDeclaredKeys(): { keys: Set<string>; sources: string[] } {
  const keys = new Set<string>();
  const sources: string[] = [];
  const root = process.cwd();
  // Walk recursive but conservative — only ~200 files for env-y stuff.
  const SKIP = new Set(["node_modules", ".next", "dist", "build", ".git", "out", ".vercel", "coverage"]);
  const stack: string[] = [root];
  let visited = 0;
  while (stack.length > 0 && visited < 3000) {
    const d = stack.pop()!;
    let ents: ReturnType<typeof readdirSync>;
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      visited += 1;
      const full = join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) stack.push(full);
        continue;
      }
      if (!e.isFile()) continue;
      const rel = full.startsWith(root + "/") ? full.slice(root.length + 1) : full;
      const name = e.name;
      try {
        if (isEnvDeclarationFile(rel) || name.startsWith(".env")) {
          if (!isEnvDeclarationFile(rel)) continue;
          const c = readFileSync(full, "utf8");
          for (const k of parseEnvFile(c)) keys.add(k);
          sources.push(rel);
        } else if (name === "next.config.js" || name === "next.config.mjs" || name === "next.config.ts" || name === "next.config.cjs") {
          const c = readFileSync(full, "utf8");
          const nk = parseNextConfigEnv(c);
          if (nk.length > 0) { for (const k of nk) keys.add(k); sources.push(rel); }
        } else if (name === "vercel.json") {
          const c = readFileSync(full, "utf8");
          const vk = parseVercelJsonEnv(c);
          if (vk.length > 0) { for (const k of vk) keys.add(k); sources.push(rel); }
        } else if (name === "wrangler.toml") {
          const c = readFileSync(full, "utf8");
          const wk = parseWranglerToml(c);
          if (wk.length > 0) { for (const k of wk) keys.add(k); sources.push(rel); }
        }
      } catch { /* ignore unreadable */ }
    }
  }
  return { keys, sources };
}

describe("env-required: every key read by code stays declared", () => {
  // Scan once for all sub-tests.
  let declared: { keys: Set<string>; sources: string[] } | null = null;
  function getDeclared() {
    if (declared === null) declared = collectDeclaredKeys();
    return declared;
  }

  it("at least one declaration source exists", () => {
    const { sources } = getDeclared();
    const failMsg =
      "No env declaration source found. At pin-creation, sources were: " +
      DECLARATION_SOURCES_AT_PIN.join(", ") + ". " +
      "If you removed your .env.example / vercel.json env block / etc., declared keys would be silently undefined in deploys. " +
      "If intentional, retire the pin: pinned retire ${claimId} --reason=\\"...\\"";
    expect(sources.length > 0, failMsg).toBe(true);
  });

  for (const key of REQUIRED_KEYS) {
    it("key \\"" + key + "\\" is still declared", () => {
      const { keys, sources } = getDeclared();
      const failMsg =
        "Env key \\"" + key + "\\" is read by code but NOT declared in any of: " +
        (sources.join(", ") || "(no sources found)") + ". " +
        "Cloned-repo first-runs and deploys without this key set will silently fail. " +
        "If the key was intentionally renamed, update the code and the example file together, then retire the pin: " +
        "pinned retire ${claimId} --reason=\\"...\\"";
      expect(keys.has(key), failMsg).toBe(true);
    });
  }
});
`;

  return { filename, content, claimId };
}
