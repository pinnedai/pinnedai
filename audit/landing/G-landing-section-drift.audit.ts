// FEATURE: landing page contains every section from the locked v0.1
//   plan. Catches drift if a section silently gets removed or renamed.
// SIGNAL: each of the 10 section headings appears in the built
//   landing JS bundle.
// FALSIFIABILITY: if someone deletes the FAQ or Install section
//   without intending to, this audit fires before the regression
//   reaches users.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(
  new URL(import.meta.url).pathname,
  "..",
  "..",
  ".."
);
const LANDING = resolve(REPO_ROOT, "apps/landing");

// The 11 sections every landing page must include, identified by a
// load-bearing heading string. If marketing decides to rename a
// section, update this list intentionally.
const REQUIRED_SECTIONS: ReadonlyArray<{ id: string; heading: string }> = [
  { id: "hero", heading: "Permanent guardrails for AI-coded apps." },
  { id: "quick-start", heading: "Get started in 2 steps" },
  { id: "demo", heading: "Try it right here" },
  { id: "how-it-works", heading: "How it works" },
  { id: "examples", heading: "What Pinned protects" },
  { id: "catches", heading: "The bugs Pinned catches (the ones that hurt most)" },
  { id: "safety-pass", heading: "Safety Pass — finds risky AI mistakes before they ship" },
  { id: "why", heading: "The missing layer in the AI-coding stack" },
  { id: "surfaces", heading: "Where Pinned shows up" },
  { id: "install", heading: "Install" },
  { id: "pricing", heading: "Pricing" },
  { id: "faq", heading: "FAQ" },
];

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

describe("FEATURE-AUDIT: landing page contains every required section", () => {
  it("POSITIVE CONTROL: built JS contains all 10 required section headings", () => {
    const js = readBuiltJs();
    const missing = REQUIRED_SECTIONS.filter(
      (s) => !js.includes(s.heading)
    );
    expect(missing).toEqual([]);
  });

  it("POSITIVE CONTROL: pricing tier numbers stay in sync with Worker config", () => {
    const js = readBuiltJs();
    const wrangler = readFileSync(
      resolve(REPO_ROOT, "apps/edge/wrangler.toml"),
      "utf8"
    );
    // Free tier should advertise the configured caps verbatim
    const pub = wrangler.match(/FREE_QUOTA_PUBLIC_PER_MONTH\s*=\s*"(\d+)"/);
    const priv = wrangler.match(/FREE_QUOTA_PRIVATE_PER_MONTH\s*=\s*"(\d+)"/);
    expect(pub).not.toBeNull();
    expect(priv).not.toBeNull();
    expect(js).toContain(pub![1]);
    expect(js).toContain(priv![1]);
  });

  it("FALSIFIABILITY: the required-sections list has exactly 12 entries (matches the locked v0.1 plan + quick-start + catches)", () => {
    expect(REQUIRED_SECTIONS).toHaveLength(12);
  });

  it("NEGATIVE CONTROL: built JS does NOT contain pre-launch placeholder copy", () => {
    const js = readBuiltJs();
    // Catches accidental deploys of in-progress content
    expect(js).not.toContain("REPLACE_WITH");
    expect(js).not.toContain("TODO: ");
    expect(js).not.toContain("lorem ipsum");
  });
});
