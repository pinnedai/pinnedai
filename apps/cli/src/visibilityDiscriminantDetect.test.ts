// Unit tests for the visibility-discriminant auto-suggest detector
// (Cipherwake Feature 3). Validates the detection logic without
// running the full sweep pipeline.

import { describe, it, expect } from "vitest";
import { detectVisibilityDiscriminant } from "./scanDiff.js";

function tree(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

describe("detectVisibilityDiscriminant (Cipherwake Feature 3)", () => {
  it("flags a collection-getter with status: live/draft/archived consumed by /preview/[slug]", () => {
    const hits = detectVisibilityDiscriminant(tree({
      "lib/ideas.ts": `
        export const IDEAS = [
          { slug: "a", status: "live" },
          { slug: "b", status: "draft" },
          { slug: "c", status: "archived" },
        ];
        export function getAll() { return IDEAS; }
      `,
      "app/preview/[slug]/page.tsx": `
        import { getAll } from "@/lib/ideas";
        export default function Page() { return getAll(); }
      `,
    }));
    expect(hits).toHaveLength(1);
    expect(hits[0].discriminantField).toBe("status");
    expect(hits[0].observedValues).toEqual(["archived", "draft", "live"]);
    expect(hits[0].publicRoute).toBe("/preview/[slug]");
    expect(hits[0].suggestedPin).toMatch(/draft\/private\/archived leaked/);
  });

  it("does NOT flag when the discriminant has only one value (constant, not gate)", () => {
    const hits = detectVisibilityDiscriminant(tree({
      "lib/ideas.ts": `
        export const IDEAS = [
          { slug: "a", status: "live" },
          { slug: "b", status: "live" },
        ];
      `,
      "app/preview/[slug]/page.tsx": `
        import { IDEAS } from "@/lib/ideas";
        export default function Page() { return IDEAS; }
      `,
    }));
    expect(hits).toHaveLength(0);
  });

  it("does NOT flag when the field appears only once (not a discriminant)", () => {
    const hits = detectVisibilityDiscriminant(tree({
      "lib/ideas.ts": `
        export const IDEAS = [{ slug: "a", status: "live" }];
      `,
      "app/preview/[slug]/page.tsx": `import { IDEAS } from "@/lib/ideas";`,
    }));
    expect(hits).toHaveLength(0);
  });

  it("does NOT flag when no dynamic-route page imports the collection (non-public)", () => {
    const hits = detectVisibilityDiscriminant(tree({
      "lib/ideas.ts": `
        export const IDEAS = [
          { slug: "a", status: "live" },
          { slug: "b", status: "draft" },
        ];
      `,
      // Imports it, but no dynamic param — not a public-listing risk.
      "app/admin/list/page.tsx": `import { IDEAS } from "@/lib/ideas";`,
    }));
    expect(hits).toHaveLength(0);
  });

  it("recognizes isPublic / published / draft / archived variants", () => {
    // Note: isPublic-with-booleans doesn't match (we look for string
    // literals). We deliberately don't catch boolean discriminants in
    // 0.5.0-beta because false-positive risk is high (booleans are
    // used for everything). Stringy discriminants only.
    const hits = detectVisibilityDiscriminant(tree({
      "lib/posts.ts": `
        export const POSTS = [
          { slug: "a", published: "yes" },
          { slug: "b", published: "no" },
          { slug: "c", published: "draft" },
        ];
      `,
      "app/post/[slug]/page.tsx": `import { POSTS } from "@/lib/posts";`,
    }));
    expect(hits).toHaveLength(1);
    expect(hits[0].discriminantField).toBe("published");
  });

  it("works for the Pages Router (pages/post/[slug].tsx)", () => {
    const hits = detectVisibilityDiscriminant(tree({
      "lib/items.ts": `
        export const ITEMS = [
          { slug: "a", visibility: "public" },
          { slug: "b", visibility: "private" },
        ];
      `,
      "pages/item/[slug].tsx": `import { ITEMS } from "@/lib/items";`,
    }));
    expect(hits).toHaveLength(1);
    expect(hits[0].publicRoute).toBe("/item/[slug]");
  });

  it("does NOT flag pages-folder modules (no false positive on the page itself)", () => {
    // The detector skips files under components/pages/app/ when
    // looking for collections — pages aren't where collections live.
    const hits = detectVisibilityDiscriminant(tree({
      "app/preview/[slug]/items.ts": `
        export const ITEMS = [
          { slug: "a", status: "live" },
          { slug: "b", status: "draft" },
        ];
      `,
      "app/preview/[slug]/page.tsx": `import { ITEMS } from "./items";`,
    }));
    expect(hits).toHaveLength(0);
  });

  it("skips test files", () => {
    const hits = detectVisibilityDiscriminant(tree({
      "lib/ideas.test.ts": `
        export const IDEAS = [
          { slug: "a", status: "live" },
          { slug: "b", status: "draft" },
        ];
      `,
      "app/preview/[slug]/page.tsx": `import { IDEAS } from "@/lib/ideas.test";`,
    }));
    expect(hits).toHaveLength(0);
  });
});
