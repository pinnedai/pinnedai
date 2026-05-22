// FEATURE: Landing page content surfaces (G.1, G.6, G.7) +
//   SEO routes content (G.5) + vite alias to canonical parser (G.3)
// SIGNAL: built landing dist/ contains the hero copy, current pricing
//   numbers, OG meta tags, and SEO sub-page content. The vite config
//   aliases "pinnedai" → ../cli/src/index.ts so the demo runs the
//   exact parser the npm package ships.
// FALSIFIABILITY: catches copy drift between landing and Worker
//   config, removed OG meta tags (social previews break), SEO route
//   content regressions, and demo drift from canonical parser.
//
// NOTE: This audit reads source + built output. For live React state
// updates (demo updates as you type), we ship a unit test of parseClaims
// + manual smoke test. A Playwright audit is v0.1.1.

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";

const REPO_ROOT = resolve(
  new URL(import.meta.url).pathname,
  "..",
  "..",
  ".."
);
const LANDING = resolve(REPO_ROOT, "apps/landing");

// Build the landing once at suite setup.
beforeAll(() => {
  const r = spawnSync("pnpm", ["--filter", "pinnedai-landing", "build"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: "ignore",
  });
  if (r.status !== 0) {
    throw new Error("landing build failed before audit");
  }
}, 60_000);

function readBuiltJs(): string {
  const assets = join(LANDING, "dist", "assets");
  const files = readdirSync(assets).filter((f) => f.endsWith(".js"));
  if (files.length === 0) throw new Error("no built JS asset");
  return readFileSync(join(assets, files[0]), "utf8");
}

function readBuiltHtml(): string {
  return readFileSync(join(LANDING, "dist", "index.html"), "utf8");
}

describe("FEATURE-AUDIT: G.1 — hero copy lands in built output", () => {
  it("POSITIVE CONTROL: built JS contains the Guardrail headline 'Permanent guardrails for AI-coded apps.'", () => {
    const js = readBuiltJs();
    expect(js).toContain("Permanent guardrails for AI-coded apps.");
  });

  it("POSITIVE CONTROL: tagline-sub copy carries the 'remembers the promises' framing", () => {
    const js = readBuiltJs();
    expect(js).toContain(
      "Pinned remembers the promises your app must keep"
    );
    // Spot-check that the concrete list of categories made it through
    // — the subhead's credibility depends on the specifics.
    expect(js).toContain("auth, billing, rate limits, webhooks");
  });

  it("FALSIFIABILITY: stale pre-Guardrail hero copy NOT present (catches stale build/cache)", () => {
    const js = readBuiltJs();
    // Pre-v0.1 hero variants. If a stale build ships these, this
    // assertion catches it. Update this list whenever the hero is
    // intentionally repositioned.
    expect(js).not.toContain("Your PR description is the test. Forever.");
    expect(js).not.toContain("AI writes the code. Pinned writes the tests.");
    expect(js).not.toContain("AI writes the code. Pinned makes sure it keeps working.");
  });
});

describe("FEATURE-AUDIT: G.5 — SEO routes render their content from source", () => {
  it("POSITIVE CONTROL: built JS contains /for-nextjs hero string", () => {
    const js = readBuiltJs();
    expect(js).toContain("Pinnedai for Next.js");
  });
  it("POSITIVE CONTROL: built JS contains /for-claude-code hero string", () => {
    const js = readBuiltJs();
    expect(js).toContain("Pinnedai for Claude Code");
  });
  it("POSITIVE CONTROL: built JS contains /for-cursor hero string", () => {
    const js = readBuiltJs();
    expect(js).toContain("Pinnedai for Cursor");
  });
});

describe("FEATURE-AUDIT: G.6 — pricing card numbers match Worker config", () => {
  it("POSITIVE CONTROL: landing pricing card shows the configured Free caps", () => {
    const js = readBuiltJs();
    // Landing should advertise: 500/mo public, 100/mo private on Free.
    // Worker config (wrangler.toml) has these as FREE_QUOTA_PUBLIC_PER_MONTH
    // and FREE_QUOTA_PRIVATE_PER_MONTH. Match or we lie to customers.
    const wrangler = readFileSync(
      resolve(REPO_ROOT, "apps/edge/wrangler.toml"),
      "utf8"
    );
    const publicMatch = wrangler.match(
      /FREE_QUOTA_PUBLIC_PER_MONTH\s*=\s*"(\d+)"/
    );
    const privateMatch = wrangler.match(
      /FREE_QUOTA_PRIVATE_PER_MONTH\s*=\s*"(\d+)"/
    );
    expect(publicMatch).not.toBeNull();
    expect(privateMatch).not.toBeNull();
    const publicCap = publicMatch![1];
    const privateCap = privateMatch![1];
    // Numbers appear with thousands separator in pricing card.
    // 500 → "500", 100 → "100". Be liberal in matching.
    const publicWithComma = Number(publicCap).toLocaleString();
    const privateWithComma = Number(privateCap).toLocaleString();
    expect(js).toMatch(new RegExp(`${publicCap}|${publicWithComma}`));
    expect(js).toMatch(new RegExp(`${privateCap}|${privateWithComma}`));
  });
});

describe("FEATURE-AUDIT: G.7 — OG meta tags present in index.html", () => {
  it("POSITIVE CONTROL: og:title, og:description, og:image, og:url all present", () => {
    const html = readBuiltHtml();
    expect(html).toMatch(/<meta[^>]+property=["']og:title["']/);
    expect(html).toMatch(/<meta[^>]+property=["']og:description["']/);
    expect(html).toMatch(/<meta[^>]+property=["']og:image["']/);
    expect(html).toMatch(/<meta[^>]+property=["']og:url["']/);
  });
  it("POSITIVE CONTROL: twitter:card meta present", () => {
    const html = readBuiltHtml();
    expect(html).toMatch(/<meta[^>]+name=["']twitter:card["']/);
  });
});

describe("FEATURE-AUDIT: G.3 — vite alias points 'pinnedai' → ../cli/src/index.ts", () => {
  it("POSITIVE CONTROL: vite.config.ts contains the alias mapping", () => {
    const cfg = readFileSync(
      resolve(LANDING, "vite.config.ts"),
      "utf8"
    );
    expect(cfg).toContain("alias");
    expect(cfg).toContain("pinnedai");
    expect(cfg).toMatch(/cli\/src\/index/);
  });
  it("FALSIFIABILITY: Demo.tsx imports from 'pinnedai' (not a relative path)", () => {
    const demo = readFileSync(
      resolve(LANDING, "src/Demo.tsx"),
      "utf8"
    );
    expect(demo).toMatch(/from\s+["']pinnedai["']/);
  });
});

describe("FEATURE-AUDIT: G.8 — built JS gzip size under budget", () => {
  it("POSITIVE CONTROL: gzipped JS ≤ 150 KB (catches order-of-magnitude bloat)", () => {
    const assets = join(LANDING, "dist", "assets");
    const jsFiles = readdirSync(assets).filter((f) => f.endsWith(".js"));
    let total = 0;
    for (const f of jsFiles) {
      const buf = readFileSync(join(assets, f));
      total += gzipSync(buf).length;
    }
    // Generous 150KB budget. Current ~115KB after SEO sub-pages.
    // The point of this audit is catching ACCIDENTAL bloat (a 1MB
    // dependency snuck in), not policing every kb. If we cross 200KB
    // here, the landing experience materially degrades on slow
    // connections and we have a problem.
    expect(total).toBeLessThanOrEqual(150 * 1024);
  });
  it("POSITIVE CONTROL: any single CSS file ≤ 25 KB gzipped (no design system bloat)", () => {
    const assets = join(LANDING, "dist", "assets");
    const cssFiles = readdirSync(assets).filter((f) => f.endsWith(".css"));
    for (const f of cssFiles) {
      const sz = gzipSync(readFileSync(join(assets, f))).length;
      expect(sz).toBeLessThanOrEqual(25 * 1024);
    }
  });
});

describe("FEATURE-AUDIT: G.4 — welcome banner gated by ?welcome=true (source-level)", () => {
  it("POSITIVE CONTROL: App.tsx contains the URLSearchParams check for welcome=true", () => {
    const app = readFileSync(resolve(LANDING, "src/App.tsx"), "utf8");
    expect(app).toMatch(/URLSearchParams|searchParams/);
    expect(app).toContain('"welcome"');
    expect(app).toContain('"true"');
  });
  it("POSITIVE CONTROL: welcome banner uses the v0.1.1 subscription copy (no license-key copy)", () => {
    const app = readFileSync(resolve(LANDING, "src/App.tsx"), "utf8");
    // v0.1.1 banner mentions OIDC + Stripe; v0.0.x mentioned license key.
    // A regression here would re-introduce license-key onboarding text.
    expect(app).toContain("OIDC");
    expect(app).not.toContain("PINNEDAI_LICENSE_KEY");
  });
});
