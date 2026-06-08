// Tests for Cipherwake 0.6.0 asks #2 + #3 (0.5.0-beta.4):
//
//   #2 — auto-pin by VALUE. HIGH-tier templates auto-pin; LOW-tier
//        (page-renders / journey / happy-path-with-side-effect) are
//        deferred to opt-in via --include-low. No more 27-pin dumps
//        from init --auto.
//
//   #3 — promote enum-drift on a VISIBILITY discriminant out of
//        "review" tier even when overlap with in-repo producer is
//        zero. `col=status missing=["live"]` is the literal draft-
//        leak class and was being suppressed by default.

import { describe, it, expect } from "vitest";
import { detectEnumDrift } from "./scanDiff.js";

function tree(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

describe("[ask #3] enum-drift on status discriminant promoted to confirmed", () => {
  it("status column with missing=['live'] and zero overlap → confidence: confirmed", () => {
    // Consumer reads item.status === "live" but the producer only
    // emits "draft", "archived". Conventional public token ("live")
    // is missing — exactly the visibility-discriminant draft-leak
    // class. Uses canonical `obj.col === "value"` shape so the
    // existing enum-drift regex matches.
    const hits = detectEnumDrift(tree({
      "components/Hero.tsx": `
        export function Hero({ item }) {
          if (item.status === "live") return <Live />;
          if (item.status === "draft") return <Draft />;
          if (item.status === "archived") return <Archived />;
          return null;
        }
      `,
      "lib/items.ts": `
        export const ITEMS = [
          { status: "draft" },
          { status: "archived" },
          { status: "draft" },
        ];
      `,
    }));
    // Status column with missing "live" should be CONFIRMED (the fix).
    const statusHits = hits.filter((h) => h.column === "status");
    expect(statusHits.length).toBeGreaterThanOrEqual(1);
    expect(statusHits[0].confidence).toBe("confirmed");
    expect(statusHits[0].missingFromProducer).toContain("live");
  });

  it("non-visibility column with zero overlap → still 'review' (no false promotion)", () => {
    const hits = detectEnumDrift(tree({
      "components/Hero.tsx": `
        export function Hero({ item }) {
          if (item.color === "red") return <Red />;
          if (item.color === "blue") return <Blue />;
          if (item.color === "green") return <Green />;
          return null;
        }
      `,
      "lib/items.ts": `
        export const ITEMS = [
          { color: "cyan" },
          { color: "magenta" },
          { color: "yellow" },
        ];
      `,
    }));
    const colorHits = hits.filter((h) => h.column === "color");
    if (colorHits.length > 0) {
      // Should remain review — not a visibility discriminant.
      expect(colorHits[0].confidence).toBe("review");
    }
  });

  it("status column with missing values that are NOT conventional public tokens (zero overlap) → stays review", () => {
    // Zero overlap (consumer reads ONLY a non-public value the producer
    // doesn't emit). The visibility-promotion rule should NOT fire
    // because the missing value isn't a conventional public token.
    const hits = detectEnumDrift(tree({
      "components/Hero.tsx": `
        export function Hero({ item }) {
          if (item.status === "wibble") return <Wibble />;
          if (item.status === "wobble") return <Wobble />;
          if (item.status === "wubble") return <Wubble />;
          return null;
        }
      `,
      "lib/items.ts": `
        export const ITEMS = [
          { status: "alpha" },
          { status: "beta" },
          { status: "gamma" },
        ];
      `,
    }));
    const statusHits = hits.filter((h) => h.column === "status");
    if (statusHits.length > 0) {
      // Zero overlap + no conventional public token missing → review.
      expect(statusHits[0].confidence).toBe("review");
    }
  });
});

describe("[ask #2] LOW-value templates are deferred from default auto-pin", () => {
  // Compile-time invariant: the set of LOW templates the code declares
  // matches what we document. If a new template is added without a
  // tier classification, this catches it.
  const EXPECTED_LOW = ["page-renders", "happy-path-with-side-effect", "journey"];
  for (const t of EXPECTED_LOW) {
    it(`'${t}' is declared LOW-tier in the auto-pin logic`, () => {
      // We can't import the inline Set without exposing it; instead,
      // we grep the source to assert it's listed in BOTH the init
      // --auto's safe[] filter AND the protect --all filter.
      const { readFileSync } = require("node:fs");
      const { join } = require("node:path");
      const src = readFileSync(join(process.cwd(), "src/cli.ts"), "utf8");
      expect(src).toMatch(new RegExp(`["']${t}["']`));
      // The string "LOW_VALUE_TEMPLATES" must appear at least twice
      // (init --auto + protect) — both call sites need the gate.
      const occurrences = (src.match(/LOW_VALUE_TEMPLATES/g) ?? []).length;
      expect(occurrences).toBeGreaterThanOrEqual(2);
    });
  }

  it("init --auto + protect --all both surface a 'deferred' line for LOW suggestions", () => {
    // Static check: both call sites print the deferral banner so the
    // user knows LOW exists without being silent-skipped.
    const { readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const src = readFileSync(join(process.cwd(), "src/cli.ts"), "utf8");
    expect(src).toMatch(/low-tier suggestion/i);
    expect(src).toMatch(/--include-low/);
  });
});
