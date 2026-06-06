// Template generator for visibility-invariant pins (Cipherwake Gap 4).
//
// The dual of render-collection: assert items meant to be HIDDEN are
// not publicly reachable. Render pins prove "200 + valid HTML" — that's
// the bug when the item is supposed to be a draft.
//
// Reads the UNFILTERED collection (admin getter) + the discriminant
// field + the values that grant public access. Splits items, hits each
// route, fails on items violating either direction.

import type { VisibilityInvariantClaim } from "../claimParser.js";
import { claimSlug } from "../claimParser.js";
import type { GenerateOpts, GeneratedTest } from "./rateLimit.js";

function lit(x: unknown): string {
  return JSON.stringify(x);
}

export function generateVisibilityInvariantTest(
  claim: VisibilityInvariantClaim,
  opts: GenerateOpts
): GeneratedTest {
  const slug = claimSlug(claim);
  const claimId = `${opts.prId}-${slug}`;
  const filename = `${claimId}.test.ts`;

  const cap = claim.cap ?? {};
  const maxRoutes = cap.maxRoutes ?? 30;

  const paramMatch = /\[(\w+)\]/.exec(claim.publicRoute);
  const paramName = paramMatch ? paramMatch[1] : "slug";
  const slugField = claim.collection.slugField ?? "slug";
  const publicStatusAllowed = claim.rule.publicStatusAllowed ?? [200];
  const privateStatusAllowed = claim.rule.privateStatusAllowed ?? [404, 307, 308];

  const header = `// ═══════════════════════════════════════════════════════════════
// ◆ Pinned by pinnedai — https://pinnedai.dev
// generated-by: pinnedai@${opts.pinnedVersion}
// ═══════════════════════════════════════════════════════════════
// Visibility-invariant pin (Cipherwake Gap 4)
// Public route:   ${claim.publicRoute}
// Discriminant:   ${claim.rule.field} ∈ [${claim.rule.publicValues.join(", ")}]
// Collection:     ${claim.collection.modulePath}#${claim.collection.exportName}
//
// To retire: pinned retire ${claimId} --reason="..."
// ═══════════════════════════════════════════════════════════════
//
// What this pin asserts:
//   - Items where ${claim.rule.field} ∈ [${claim.rule.publicValues.join(", ")}]
//     must render with one of [${publicStatusAllowed.join(", ")}]
//   - Items where ${claim.rule.field} NOT in [${claim.rule.publicValues.join(", ")}]
//     must return one of [${privateStatusAllowed.join(", ")}]
//
// Catches the leak class render pins structurally cannot — a draft
// item rendering at 200 with valid HTML looks GREEN to a render pin
// but IS the bug.
//
// WARN-on-missing-env: skips with a loud single line if no base URL
// is resolvable.`;

  const body = `
import { describe, it, expect } from "vitest";

const PUBLIC_ROUTE = ${lit(claim.publicRoute)};
const PARAM_NAME = ${lit(paramName)};
const COLLECTION = ${lit(claim.collection)};
const RULE: any = ${lit(claim.rule)};
const SLUG_FIELD = ${lit(slugField)};
const MAX_ROUTES = ${maxRoutes};
const PUBLIC_OK = ${lit(publicStatusAllowed)};
const PRIVATE_OK = ${lit(privateStatusAllowed)};

function env(name: string): string | undefined {
  return (globalThis as any).process?.env?.[name];
}

function __pinnedNormUrl(s: string | undefined): string | null {
  if (!s) return null;
  const t = /^https?:\\/\\//i.test(s) ? s : "https://" + s;
  return t.replace(/\\/+$/, "");
}
function resolveBaseUrl(): string | null {
  return __pinnedNormUrl(env("PINNED_SMOKE_BASE_URL"))
      || __pinnedNormUrl(env("PINNED_BASE_URL"))
      || __pinnedNormUrl(env("PREVIEW_URL"))
      || __pinnedNormUrl(env("PINNED_CI_BASE_URL"))
      || __pinnedNormUrl(env("VERCEL_BRANCH_URL"))
      || __pinnedNormUrl(env("VERCEL_URL"))
      || __pinnedNormUrl(env("VERCEL_PROJECT_PRODUCTION_URL"))
      || __pinnedNormUrl(env("DEPLOY_PRIME_URL"))
      || (env("NETLIFY") === "true" ? __pinnedNormUrl(env("URL")) : null)
      || __pinnedNormUrl(env("CF_PAGES_URL"))
      || __pinnedNormUrl(env("RENDER_EXTERNAL_URL"))
      || null;
}
function __pinnedLoudSkipMsg(): string {
  return "pinned: no base URL (not on a known CI provider, no local server). Run \\\`pinned dev\\\` or set PINNED_BASE_URL.";
}
function __pinnedHashSort(items: any[], key: (x:any)=>string): any[] {
  function hash(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return h;
  }
  return [...items].sort((a, b) => hash(key(a)) - hash(key(b)));
}

async function __pinnedLoadCollection(): Promise<any[]> {
  const mod: any = await import(/* @vite-ignore */ "/" + COLLECTION.modulePath.replace(/^\\/+/, ""));
  const fn = COLLECTION.exportName === "default" ? mod.default : mod[COLLECTION.exportName];
  if (typeof fn !== "function") {
    throw new Error(\`visibility-invariant: \${COLLECTION.modulePath}#\${COLLECTION.exportName} is not a function\`);
  }
  const items = await fn();
  if (!Array.isArray(items)) {
    throw new Error(\`visibility-invariant: collection getter returned non-array (\${typeof items})\`);
  }
  return items;
}

describe(\`visibility-invariant (\${PUBLIC_ROUTE}, by \${RULE.field})\`, () => {
  const baseUrl = resolveBaseUrl();
  if (!baseUrl) {
    if (typeof console !== "undefined") console.warn(__pinnedLoudSkipMsg());
    it.skip(__pinnedLoudSkipMsg(), () => {});
    return;
  }

  it("public items render and private items are hidden", async () => {
    const items = await __pinnedLoadCollection();
    if (items.length === 0) {
      throw new Error("visibility-invariant: collection getter returned 0 items");
    }
    const publicSet = new Set(RULE.publicValues);
    const sorted = __pinnedHashSort(items, (x: any) => String(x[SLUG_FIELD] ?? ""));
    const sample = sorted.slice(0, MAX_ROUTES);
    if (items.length > MAX_ROUTES) {
      console.log(\`pinned visibility-invariant: sampled \${sample.length}/\${items.length} items (deterministic)\`);
    }
    const publicFailures: string[] = [];
    const privateFailures: string[] = [];
    for (const item of sample) {
      const slug = String(item[SLUG_FIELD] ?? "");
      if (!slug) continue;
      const isPublic = publicSet.has(item[RULE.field]);
      const url = baseUrl + PUBLIC_ROUTE.replace(\`[\${PARAM_NAME}]\`, encodeURIComponent(slug));
      try {
        const r = await fetch(url, { redirect: "manual" });
        if (isPublic) {
          if (!PUBLIC_OK.includes(r.status)) {
            publicFailures.push(\`\${slug} (\${RULE.field}=\${item[RULE.field]}): expected [\${PUBLIC_OK.join(",")}], got \${r.status}\`);
          }
        } else {
          if (!PRIVATE_OK.includes(r.status)) {
            privateFailures.push(\`\${slug} (\${RULE.field}=\${item[RULE.field]}): expected [\${PRIVATE_OK.join(",")}], got \${r.status} — LEAKED publicly\`);
          }
        }
      } catch (e) {
        const bucket = isPublic ? publicFailures : privateFailures;
        bucket.push(\`\${slug}: fetch threw \${(e as Error).message}\`);
      }
    }
    if (publicFailures.length > 0 || privateFailures.length > 0) {
      const parts: string[] = [];
      if (privateFailures.length > 0) {
        parts.push(\`PRIVATE LEAKS (items rendered 2xx that shouldn't be public):\\n\` + privateFailures.map((f) => "  - " + f).join("\\n"));
      }
      if (publicFailures.length > 0) {
        parts.push(\`PUBLIC UNREACHABLE (items that should render):\\n\` + publicFailures.map((f) => "  - " + f).join("\\n"));
      }
      throw new Error(\`Visibility-invariant violated under \${PUBLIC_ROUTE}\\n\${parts.join("\\n\\n")}\`);
    }
    expect(publicFailures.length + privateFailures.length).toBe(0);
  }, 240_000);
});
`;

  return { filename, content: header + body, claimId };
}
