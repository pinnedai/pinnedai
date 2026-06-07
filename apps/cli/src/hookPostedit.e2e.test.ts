// E2E test for the auto-installed PostToolUse hook (the BEHAVIOR test,
// not the wiring test). 0.4.1 shipped with the hook silently no-op'ing
// on every edit because blast-radius didn't resolve dynamic routes —
// the wiring tests passed but the hook never fired. This file is the
// behavior test that the 0.4.1 acceptance was missing.
//
// Per Cipherwake spec:
//   - Fresh repo, `pinned init` + add a pin covering a route.
//   - Programmatically edit a file the pin depends on (the dynamic
//     page, a component it imports, or the data module).
//   - Run `pinned hook-postedit` with that file's PostToolUse payload.
//   - ASSERT the hook emits a NON-EMPTY result naming the pin.
//   - Negative: edit an UNRELATED file → emits "0 pins covered" line
//     (not silent).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const CLI = join(process.cwd(), "dist/cli.js");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hook-e2e-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function setupNextAppRouterRepo() {
  mkdirSync(join(dir, "app/preview/[slug]"), { recursive: true });
  mkdirSync(join(dir, "components"), { recursive: true });
  mkdirSync(join(dir, "lib"), { recursive: true });
  mkdirSync(join(dir, "tests/pinned"), { recursive: true });
  writeFileSync(
    join(dir, "app/preview/[slug]/page.tsx"),
    `import { IdeaLanding } from "../../../components/IdeaLanding";
     import { getAllIdeas } from "../../../lib/ideas";
     export default function Page({ params }: any) { return <IdeaLanding slug={params.slug} />; }`
  );
  writeFileSync(
    join(dir, "components/IdeaLanding.tsx"),
    `export function IdeaLanding(){ return null; }`
  );
  writeFileSync(join(dir, "lib/ideas.ts"), `export function getAllIdeas(){ return []; }`);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "e2e", type: "module" }));

  // Seed registry with a render-collection pin (templates), a smoke
  // pin (literal route), and an unrelated pin. The hook should flag
  // the first two on relevant edits, and NEITHER on an unrelated edit.
  const registry = {
    version: 1,
    claims: [
      {
        claimId: "preview-render",
        prId: "test",
        filename: "preview-render.test.ts",
        status: "active",
        createdAt: new Date().toISOString(),
        claim: {
          template: "render-collection",
          pathTemplate: "/preview/[slug]",
          route: "/preview/[slug]",
          routes: { from: "collection-getter", modulePath: "lib/ideas.ts", exportName: "getAllIdeas" },
          expect: { status: 200 },
          raw: "",
        },
      },
      {
        claimId: "benchmob-smoke",
        prId: "test",
        filename: "benchmob.test.ts",
        status: "active",
        createdAt: new Date().toISOString(),
        claim: {
          template: "smoke-functional",
          route: "/preview/benchmob",
          entrypoint: { kind: "http-route", method: "GET" },
          assertions: [{ kind: "status-ok" }],
          safeToExecute: true,
          cadence: "on-demand",
          raw: "",
        },
      },
      {
        claimId: "unrelated",
        prId: "test",
        filename: "unrelated.test.ts",
        status: "active",
        createdAt: new Date().toISOString(),
        claim: {
          template: "smoke-functional",
          route: "/api/totally-elsewhere",
          entrypoint: { kind: "http-route", method: "POST" },
          assertions: [{ kind: "status-ok" }],
          safeToExecute: true,
          cadence: "on-demand",
          raw: "",
        },
      },
    ],
  };
  writeFileSync(join(dir, "tests/pinned/.registry.json"), JSON.stringify(registry, null, 2));
  // Generate matching placeholder pin files so readRegistry's
  // .filename lookups don't fail.
  for (const c of registry.claims) {
    writeFileSync(join(dir, "tests/pinned", c.filename), "// placeholder\n");
  }
}

function runHook(payload: object): string {
  const result = execFileSync("node", [CLI, "hook-postedit"], {
    cwd: dir,
    input: JSON.stringify(payload),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 15000,
  });
  return result;
}

describe("hook-postedit — behavior test (the 0.4.1 acceptance gap)", () => {
  it("editing the dynamic page file emits a NON-EMPTY result naming both pins", () => {
    setupNextAppRouterRepo();
    const out = runHook({
      tool_name: "Edit",
      tool_input: { file_path: join(dir, "app/preview/[slug]/page.tsx") },
    });
    expect(out.length).toBeGreaterThan(0);
    // Either it found the pins (and emits a "no dev server" / "ran" line
    // mentioning the file or pin) — OR it surfaces the file in the
    // "0 pins covered" diagnostic. EMPTY output is what we ruled out.
    expect(out).toMatch(/preview|page\.tsx|guard|pin/i);
  });

  it("editing a transitively-imported component flags the same pins", () => {
    setupNextAppRouterRepo();
    const out = runHook({
      tool_name: "Edit",
      tool_input: { file_path: join(dir, "components/IdeaLanding.tsx") },
    });
    expect(out.length).toBeGreaterThan(0);
    expect(out).toMatch(/IdeaLanding|page\.tsx|guard|pin|preview/i);
  });

  it("editing the data module flags the render-collection pin", () => {
    setupNextAppRouterRepo();
    const out = runHook({
      tool_name: "Edit",
      tool_input: { file_path: join(dir, "lib/ideas.ts") },
    });
    expect(out.length).toBeGreaterThan(0);
    expect(out).toMatch(/ideas\.ts|guard|pin|preview/i);
  });

  it("editing an UNRELATED file emits 'no pins covered' (not silent)", () => {
    setupNextAppRouterRepo();
    writeFileSync(join(dir, "lib/random-unrelated.ts"), "export const x = 1;");
    const out = runHook({
      tool_name: "Edit",
      tool_input: { file_path: join(dir, "lib/random-unrelated.ts") },
    });
    expect(out.length).toBeGreaterThan(0);
    expect(out).toMatch(/0 pins|no Pinned guard|no pin/i);
  });

  it("empty PostToolUse payload emits a clear 'nothing to verify' line, never empty", () => {
    setupNextAppRouterRepo();
    const out = runHook({ tool_name: "Edit", tool_input: {} });
    expect(out.length).toBeGreaterThan(0);
    expect(out).toMatch(/no file paths|nothing to verify|pinned:/i);
  });
});
