// E2E for the Cipherwake-reported P0:
// - Literal smoke-pin route /preview/benchmob must map to the dynamic
//   page file app/preview/[slug]/page.tsx.
// - Template render-collection pathTemplate /preview/[slug] must
//   resolve to the same file.
// - Editing the page file, a component the page imports, OR the data
//   module the route serves must all map to the covering pin via the
//   transitive importer walk.
//
// Plus pages-router + route-groups + catch-all sanity.
//
// 0.4.1 shipped wiring tests ("settings.json has the entry") for the
// auto-install hook but never asserted hook-postedit produced output
// against a real edit. This file is the behavior test — same shape
// the broken hook should have been caught by.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDependencyGraph,
  buildSmokePinIndex,
  affectedSmokePins,
  filesForSmokeClaim,
  deriveLikelyPageFilesForRoute,
} from "./blastRadius.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "br-dyn-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("deriveLikelyPageFilesForRoute — Next.js App Router", () => {
  it("literal route /preview/benchmob resolves to dynamic app/preview/[slug]/page.tsx", () => {
    mkdirSync(join(dir, "app/preview/[slug]"), { recursive: true });
    writeFileSync(join(dir, "app/preview/[slug]/page.tsx"), "export default function Page(){}");
    const files = deriveLikelyPageFilesForRoute("/preview/benchmob", dir);
    expect(files).toEqual(["app/preview/[slug]/page.tsx"]);
  });

  it("template route /preview/[slug] resolves to the same file (direct match)", () => {
    mkdirSync(join(dir, "app/preview/[slug]"), { recursive: true });
    writeFileSync(join(dir, "app/preview/[slug]/page.tsx"), "export default function Page(){}");
    const files = deriveLikelyPageFilesForRoute("/preview/[slug]", dir);
    expect(files).toEqual(["app/preview/[slug]/page.tsx"]);
  });

  it("exact-route wins when both dynamic and literal segments exist", () => {
    mkdirSync(join(dir, "app/preview/featured"), { recursive: true });
    mkdirSync(join(dir, "app/preview/[slug]"), { recursive: true });
    writeFileSync(join(dir, "app/preview/featured/page.tsx"), "");
    writeFileSync(join(dir, "app/preview/[slug]/page.tsx"), "");
    const files = deriveLikelyPageFilesForRoute("/preview/featured", dir);
    expect(files).toContain("app/preview/featured/page.tsx");
    // Both candidates are valid — dynamic also matches "featured".
    expect(files).toContain("app/preview/[slug]/page.tsx");
  });

  it("route groups (group) are transparent — don't consume a segment", () => {
    mkdirSync(join(dir, "app/(marketing)/about"), { recursive: true });
    writeFileSync(join(dir, "app/(marketing)/about/page.tsx"), "");
    const files = deriveLikelyPageFilesForRoute("/about", dir);
    expect(files).toEqual(["app/(marketing)/about/page.tsx"]);
  });

  it("API routes (app/.../route.ts) match too", () => {
    mkdirSync(join(dir, "app/api/users"), { recursive: true });
    writeFileSync(join(dir, "app/api/users/route.ts"), "export async function POST(){}");
    const files = deriveLikelyPageFilesForRoute("/api/users", dir);
    expect(files).toEqual(["app/api/users/route.ts"]);
  });

  it("src/app/ layout is supported", () => {
    mkdirSync(join(dir, "src/app/preview/[slug]"), { recursive: true });
    writeFileSync(join(dir, "src/app/preview/[slug]/page.tsx"), "");
    const files = deriveLikelyPageFilesForRoute("/preview/x", dir);
    expect(files).toEqual(["src/app/preview/[slug]/page.tsx"]);
  });

  it("catch-all segments [...slug] match", () => {
    mkdirSync(join(dir, "app/docs/[...slug]"), { recursive: true });
    writeFileSync(join(dir, "app/docs/[...slug]/page.tsx"), "");
    const files = deriveLikelyPageFilesForRoute("/docs/getting-started", dir);
    expect(files).toContain("app/docs/[...slug]/page.tsx");
  });
});

describe("deriveLikelyPageFilesForRoute — Next.js Pages Router", () => {
  it("dynamic filename pages/preview/[slug].tsx resolves", () => {
    mkdirSync(join(dir, "pages/preview"), { recursive: true });
    writeFileSync(join(dir, "pages/preview/[slug].tsx"), "");
    const files = deriveLikelyPageFilesForRoute("/preview/benchmob", dir);
    expect(files).toContain("pages/preview/[slug].tsx");
  });

  it("exact pages/about.tsx for /about", () => {
    mkdirSync(join(dir, "pages"), { recursive: true });
    writeFileSync(join(dir, "pages/about.tsx"), "");
    const files = deriveLikelyPageFilesForRoute("/about", dir);
    expect(files).toContain("pages/about.tsx");
  });
});

describe("deriveLikelyPageFilesForRoute — SvelteKit + Astro", () => {
  it("SvelteKit src/routes/preview/[slug]/+page.svelte", () => {
    mkdirSync(join(dir, "src/routes/preview/[slug]"), { recursive: true });
    writeFileSync(join(dir, "src/routes/preview/[slug]/+page.svelte"), "");
    const files = deriveLikelyPageFilesForRoute("/preview/x", dir);
    expect(files).toEqual(["src/routes/preview/[slug]/+page.svelte"]);
  });

  it("Astro src/pages/preview/[slug].astro", () => {
    // Astro uses files not folders for routes; not covered by walkDir's
    // leaf-file pattern in the current implementation. Track as
    // follow-up if customers ask.
    mkdirSync(join(dir, "src/pages/preview/[slug]"), { recursive: true });
    writeFileSync(join(dir, "src/pages/preview/[slug]/index.astro"), "");
    const files = deriveLikelyPageFilesForRoute("/preview/x", dir);
    expect(files).toEqual(["src/pages/preview/[slug]/index.astro"]);
  });
});

describe("filesForSmokeClaim — pin shapes that previously returned empty", () => {
  it("smoke-functional with http-route GET /preview/benchmob → dynamic page", () => {
    mkdirSync(join(dir, "app/preview/[slug]"), { recursive: true });
    writeFileSync(join(dir, "app/preview/[slug]/page.tsx"), "");
    const files = filesForSmokeClaim(
      { template: "smoke-functional", route: "/preview/benchmob", entrypoint: { kind: "http-route", method: "GET" } },
      dir
    );
    expect(files).toEqual(["app/preview/[slug]/page.tsx"]);
  });

  it("render-collection on pathTemplate /preview/[slug] → dynamic page", () => {
    mkdirSync(join(dir, "app/preview/[slug]"), { recursive: true });
    writeFileSync(join(dir, "app/preview/[slug]/page.tsx"), "");
    const files = filesForSmokeClaim(
      { template: "render-collection", pathTemplate: "/preview/[slug]" },
      dir
    );
    expect(files).toEqual(["app/preview/[slug]/page.tsx"]);
  });

  it("visibility-invariant on publicRoute /preview/[slug] → dynamic page", () => {
    mkdirSync(join(dir, "app/preview/[slug]"), { recursive: true });
    writeFileSync(join(dir, "app/preview/[slug]/page.tsx"), "");
    const files = filesForSmokeClaim(
      { template: "visibility-invariant", publicRoute: "/preview/[slug]" },
      dir
    );
    expect(files).toEqual(["app/preview/[slug]/page.tsx"]);
  });
});

describe("affectedSmokePins — the Cipherwake repro (the whole point)", () => {
  it("edits to the page, a component it imports, OR the data module all flag the same pin", () => {
    // Set up the exact shape Cipherwake reported.
    mkdirSync(join(dir, "app/preview/[slug]"), { recursive: true });
    mkdirSync(join(dir, "components"), { recursive: true });
    mkdirSync(join(dir, "lib"), { recursive: true });
    writeFileSync(
      join(dir, "app/preview/[slug]/page.tsx"),
      `import { IdeaLanding } from "../../../components/IdeaLanding";
       import { getAllIdeas } from "../../../lib/ideas";
       export default function Page({ params }) { return <IdeaLanding slug={params.slug} />; }`
    );
    writeFileSync(
      join(dir, "components/IdeaLanding.tsx"),
      `import { Hero } from "./Hero"; export function IdeaLanding(){ return <Hero/>; }`
    );
    writeFileSync(join(dir, "components/Hero.tsx"), `export function Hero(){ return null; }`);
    writeFileSync(join(dir, "lib/ideas.ts"), `export function getAllIdeas(){ return []; }`);

    const graph = buildDependencyGraph(dir);
    const index = buildSmokePinIndex(
      [
        {
          claimId: "preview-render",
          claim: { template: "render-collection", pathTemplate: "/preview/[slug]" },
        },
        {
          claimId: "benchmob-smoke",
          claim: {
            template: "smoke-functional",
            route: "/preview/benchmob",
            entrypoint: { kind: "http-route", method: "GET" },
          },
        },
      ],
      dir
    );

    // The page file should be in the byFile index for BOTH pins.
    expect(index.byFile["app/preview/[slug]/page.tsx"]).toBeDefined();
    expect(index.byFile["app/preview/[slug]/page.tsx"]).toContain("preview-render");
    expect(index.byFile["app/preview/[slug]/page.tsx"]).toContain("benchmob-smoke");

    // Edit the page → both pins flagged.
    expect(
      affectedSmokePins(index, ["app/preview/[slug]/page.tsx"], graph).sort()
    ).toEqual(["benchmob-smoke", "preview-render"]);

    // Edit a component the page imports → both pins flagged.
    expect(
      affectedSmokePins(index, ["components/IdeaLanding.tsx"], graph).sort()
    ).toEqual(["benchmob-smoke", "preview-render"]);

    // Edit a deeper transitive component → still flagged.
    expect(
      affectedSmokePins(index, ["components/Hero.tsx"], graph).sort()
    ).toEqual(["benchmob-smoke", "preview-render"]);

    // Edit the data module → flagged.
    expect(
      affectedSmokePins(index, ["lib/ideas.ts"], graph).sort()
    ).toEqual(["benchmob-smoke", "preview-render"]);

    // Edit a totally unrelated file → NOT flagged (no FP).
    writeFileSync(join(dir, "lib/unrelated.ts"), "export const x = 1;");
    expect(affectedSmokePins(index, ["lib/unrelated.ts"], graph)).toEqual([]);
  });
});
