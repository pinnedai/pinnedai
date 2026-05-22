// FEATURE: pin coverage mapping — when the current diff edits a file
//   already guarded by an existing pin, `pinned scan-diff` surfaces
//   "REVIEW · N protected behavior touched" AND identifies the touched
//   pin by its template + route. `pinned statusline` shows a parallel
//   "REVIEW · N touched" state. `.registry.json` persists a `covers`
//   field per pin so the intersection logic has stable input.
// SIGNAL (observable when feature is healthy):
//   1. After `pinned generate`, .registry.json each entry has a
//      `covers: { routes?: [...], files?: [...] }` field.
//   2. With an active pin on /api/admin/export AND a diff that
//      modifies app/api/admin/export/route.ts, `scan-diff` stdout
//      contains "protected behavior touched" AND the pin's template
//      name ("auth-required") AND the pin's route.
//   3. With the same active pin BUT a diff that touches an unrelated
//      file (e.g. README.md), `scan-diff` stdout does NOT contain
//      "protected behavior touched".
//   4. With at least one touched pin in the working tree,
//      `pinned statusline` stdout contains "REVIEW" and "touched".
// FALSIFIABILITY: catches regressions where templates stop persisting
//   covers, where findTouchedPins() stops intersecting route/file
//   names, or where the CLI / statusline renderers stop printing the
//   touched-pins block. Specifically catches: someone refactoring
//   addEntry() and dropping the coverageFromClaim() call; someone
//   changing deriveRouteFromPath()'s output format; someone collapsing
//   the touched-pins precedence rule in formatStatusline back to
//   "N to review" only.

import { describe, it, expect } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runCli, makeTempRepo } from "./runCli.js";

function gitInit(cwd: string) {
  const opts = { cwd, stdio: "ignore" as const };
  spawnSync("git", ["init", "-b", "main"], opts);
  spawnSync("git", ["config", "user.email", "audit@example.com"], opts);
  spawnSync("git", ["config", "user.name", "Audit"], opts);
  spawnSync("git", ["config", "commit.gpgsign", "false"], opts);
}

function gitCommitAll(cwd: string, msg: string) {
  const opts = { cwd, stdio: "ignore" as const };
  spawnSync("git", ["add", "-A"], opts);
  spawnSync("git", ["commit", "--allow-empty", "-m", msg], opts);
}

describe("FEATURE-AUDIT: pin coverage mapping intersects diff with existing pins", () => {
  it("POSITIVE CONTROL: .registry.json persists a `covers` field after `pinned generate`", async () => {
    const cwd = makeTempRepo();
    try {
      // Bare init + generate a single pin from a claim sentence.
      const initRes = await runCli(["init", "--force"], { cwd, cleanup: false });
      expect(initRes.exitCode).toBe(0);

      // Generate writes to tests/pinned/.registry.json. We use the
      // auth-required claim shape since it produces a route-coverage
      // entry (`covers.routes: ["/api/admin/export"]`) — the most
      // common case at runtime.
      const genRes = await runCli(
        [
          "generate",
          "--pr-id",
          "pr-1",
          "--description",
          "Auth required on /api/admin/export.",
        ],
        { cwd, cleanup: false }
      );
      expect(genRes.exitCode).toBe(0);

      const registryPath = join(cwd, "tests", "pinned", ".registry.json");
      expect(existsSync(registryPath)).toBe(true);
      const registry = JSON.parse(readFileSync(registryPath, "utf8"));
      expect(Array.isArray(registry.claims)).toBe(true);
      expect(registry.claims.length).toBeGreaterThan(0);
      const entry = registry.claims[0];
      // The contract this audit guards: every new pin gets a covers
      // field at write time. If a refactor drops the coverageFromClaim
      // call in addEntry, this assertion fails.
      expect(entry).toHaveProperty("covers");
      expect(entry.covers).toEqual({ routes: ["/api/admin/export"] });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("POSITIVE CONTROL: scan-diff surfaces 'protected behavior touched' when diff edits a pinned route", async () => {
    const cwd = makeTempRepo();
    try {
      gitInit(cwd);
      await runCli(["init", "--force"], { cwd, cleanup: false });
      await runCli(
        [
          "generate",
          "--pr-id",
          "pr-1",
          "--description",
          "Auth required on /api/admin/export.",
        ],
        { cwd, cleanup: false }
      );
      gitCommitAll(cwd, "initial scaffold + pin");

      // Now modify the route file the pin guards. Path must match
      // deriveRouteFromPath()'s Next.js App Router pattern.
      mkdirSync(join(cwd, "app/api/admin/export"), { recursive: true });
      writeFileSync(
        join(cwd, "app/api/admin/export/route.ts"),
        "export const GET = () => new Response('ok');\n"
      );
      gitCommitAll(cwd, "add admin export route");

      const result = await runCli(["scan-diff", "--base", "HEAD~1"], {
        cwd,
        cleanup: false,
      });
      expect(result.exitCode).toBe(0);
      // The Guardrail-positioning signal: the touched-pins block
      // names the protected behavior + the pin shape.
      expect(result.stdout).toContain("protected behavior");
      expect(result.stdout).toContain("touched");
      expect(result.stdout).toContain("auth-required");
      expect(result.stdout).toContain("/api/admin/export");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("FALSIFIABILITY: scan-diff does NOT surface 'protected behavior touched' for unrelated edits", async () => {
    const cwd = makeTempRepo();
    try {
      gitInit(cwd);
      await runCli(["init", "--force"], { cwd, cleanup: false });
      await runCli(
        [
          "generate",
          "--pr-id",
          "pr-1",
          "--description",
          "Auth required on /api/admin/export.",
        ],
        { cwd, cleanup: false }
      );
      gitCommitAll(cwd, "initial scaffold + pin");

      // Modify a totally unrelated file (README). Per the spec,
      // findTouchedPins must NOT flag the pin as touched.
      writeFileSync(join(cwd, "README.md"), "# Project\nUnrelated.\n");
      gitCommitAll(cwd, "readme tweak");

      const result = await runCli(["scan-diff", "--base", "HEAD~1"], {
        cwd,
        cleanup: false,
      });
      expect(result.exitCode).toBe(0);
      // The Guardrail amber state must NOT fire on a benign edit —
      // otherwise the signal turns into noise and devs ignore it.
      expect(result.stdout).not.toContain("protected behavior");
      expect(result.stdout).not.toContain("REVIEW · 1 touched");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("POSITIVE CONTROL: `pinned statusline` shows 'REVIEW · N touched' when working tree intersects a pin", async () => {
    const cwd = makeTempRepo();
    try {
      gitInit(cwd);
      await runCli(["init", "--force"], { cwd, cleanup: false });
      await runCli(
        [
          "generate",
          "--pr-id",
          "pr-1",
          "--description",
          "Auth required on /api/admin/export.",
        ],
        { cwd, cleanup: false }
      );
      gitCommitAll(cwd, "initial scaffold + pin");

      // Uncommitted edit on the pinned route — exactly the state
      // statusline is meant to flag.
      mkdirSync(join(cwd, "app/api/admin/export"), { recursive: true });
      writeFileSync(
        join(cwd, "app/api/admin/export/route.ts"),
        "export const GET = () => new Response('ok');\n"
      );
      // No commit — the working tree carries the change.

      const result = await runCli(["statusline"], { cwd, cleanup: false });
      expect(result.exitCode).toBe(0);
      // Statusline output must include the REVIEW + touched tokens
      // so users (and downstream extensions) can detect the state.
      expect(result.stdout).toContain("REVIEW");
      expect(result.stdout).toContain("touched");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("FALSIFIABILITY: CLI-output-contains pins never appear as 'touched' (no source-file inference)", async () => {
    // CLI-output / exits-zero / flag-supported templates can't reliably
    // infer which source file affects the binary's output. So
    // coverageFromClaim() returns empty for them and findTouchedPins
    // skips them. This audit catches a regression where someone tries
    // to be clever and start matching against the command string —
    // which would yield false positives on any cli.ts edit.
    const cwd = makeTempRepo();
    try {
      gitInit(cwd);
      await runCli(["init", "--force"], { cwd, cleanup: false });
      // Pin a CLI-output claim.
      await runCli(
        [
          "generate",
          "--pr-id",
          "pr-1",
          "--description",
          "`pinned doctor` outputs `Pinned status`.",
        ],
        { cwd, cleanup: false }
      );
      gitCommitAll(cwd, "initial scaffold + cli pin");

      // Edit some source file that COULD be the CLI source. The pin
      // must remain silent because we don't infer source-file coverage
      // for CLI binaries.
      mkdirSync(join(cwd, "apps/cli/src"), { recursive: true });
      writeFileSync(join(cwd, "apps/cli/src/cli.ts"), "// edit\n");
      gitCommitAll(cwd, "edit cli source");

      const result = await runCli(["scan-diff", "--base", "HEAD~1"], {
        cwd,
        cleanup: false,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("protected behavior");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
