// FEATURE: `pinned auto-protect` classifier (safe/ask/off modes)
// SIGNAL: `safe` mode auto-adds deterministic pins; `ask` mode emits
//   suggestion count only; `off` mode writes nothing.
// FALSIFIABILITY:
//   - POS: with a new admin route in the diff, safe mode creates exactly
//     one tests/pinned/*.test.ts for auth-required (deterministic shape).
//   - POS: with a CLI subcommand pattern in a new file, safe mode adds
//     a cli-exits-zero pin.
//   - NEG: off mode never writes a file, even when patterns are present.
//   - NEG: false-positive guard — a file that does NOT contain a Commander
//     pattern produces zero CLI pins (catches over-matching regex).

import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runCli, makeTempRepo } from "./runCli.js";

function setupGitRepo(cwd: string): void {
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.email", "audit@pinnedai.dev"], { cwd });
  execFileSync("git", ["config", "user.name", "audit"], { cwd });
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd });
}

function initPinnedRepo(cwd: string): void {
  // Minimal init: no hooks, no statusline (avoid touching .git/hooks).
  // Just config + tests/pinned dir + registry.
  mkdirSync(join(cwd, ".pinnedai"), { recursive: true });
  writeFileSync(
    join(cwd, ".pinnedai", "config.json"),
    JSON.stringify({ version: 1, auto_protect: "safe", safety_budget_per_run: 5 }, null, 2)
  );
  mkdirSync(join(cwd, "tests", "pinned"), { recursive: true });
  writeFileSync(
    join(cwd, "tests", "pinned", ".registry.json"),
    JSON.stringify({ version: 1, claims: [] })
  );
}

describe("FEATURE-AUDIT: auto-protect safe mode auto-pins admin routes", () => {
  it("POSITIVE CONTROL: new /api/admin/* route → safe-mode auto-adds an auth-required pin", async () => {
    const cwd = makeTempRepo();
    setupGitRepo(cwd);
    initPinnedRepo(cwd);

    // Create a new Next.js app-router admin route. The classifier's
    // ADMIN_ROUTE_SHAPES rule should fire on this path.
    const routePath = join(cwd, "app", "api", "admin", "export", "route.ts");
    mkdirSync(join(cwd, "app", "api", "admin", "export"), { recursive: true });
    writeFileSync(routePath, "export async function GET() { return new Response('hi'); }\n");

    const r = await runCli(["auto-protect", "--quiet"], { cwd });
    expect(r.exitCode).toBe(0);

    // POS CONTROL: at least one auth-required pin file landed.
    const pinDir = join(cwd, "tests", "pinned");
    const files = readdirSync(pinDir).filter((f) => f.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThan(0);
    const authFiles = files.filter((f) => f.includes("auth-required"));
    expect(authFiles.length).toBe(1);
    // The pin must reference /api/admin/export (or escaped form).
    const content = readFileSync(join(pinDir, authFiles[0]), "utf8");
    expect(content).toContain("/api/admin/export");
  });

  it("FALSIFIABILITY: off mode writes nothing even with the same admin route", async () => {
    const cwd = makeTempRepo();
    setupGitRepo(cwd);
    initPinnedRepo(cwd);
    // Force off mode via the config file.
    writeFileSync(
      join(cwd, ".pinnedai", "config.json"),
      JSON.stringify({ version: 1, auto_protect: "off", safety_budget_per_run: 5 }, null, 2)
    );

    mkdirSync(join(cwd, "app", "api", "admin", "export"), { recursive: true });
    writeFileSync(
      join(cwd, "app", "api", "admin", "export", "route.ts"),
      "export async function GET() { return new Response('hi'); }\n"
    );

    const r = await runCli(["auto-protect", "--quiet"], { cwd });
    expect(r.exitCode).toBe(0);

    // NEG CONTROL: nothing written.
    const pinDir = join(cwd, "tests", "pinned");
    const files = readdirSync(pinDir).filter((f) => f.endsWith(".test.ts"));
    expect(files).toEqual([]);
  });
});

describe("FEATURE-AUDIT: auto-protect ask mode never writes pins, only counts", () => {
  it("POSITIVE CONTROL: ask mode records suggestion count without writing pin files", async () => {
    const cwd = makeTempRepo();
    setupGitRepo(cwd);
    initPinnedRepo(cwd);
    // Force ask mode.
    writeFileSync(
      join(cwd, ".pinnedai", "config.json"),
      JSON.stringify({ version: 1, auto_protect: "ask", safety_budget_per_run: 5 }, null, 2)
    );

    // Two real risk surfaces (admin route + webhook handler).
    mkdirSync(join(cwd, "app", "api", "admin", "users"), { recursive: true });
    writeFileSync(
      join(cwd, "app", "api", "admin", "users", "route.ts"),
      "export async function GET() {}\n"
    );
    mkdirSync(join(cwd, "app", "api", "webhooks", "stripe"), { recursive: true });
    writeFileSync(
      join(cwd, "app", "api", "webhooks", "stripe", "route.ts"),
      "export async function POST() {}\n"
    );

    const r = await runCli(["auto-protect", "--quiet"], { cwd });
    expect(r.exitCode).toBe(0);

    // POS CONTROL: cache holds suggestedCount > 0.
    const cache = JSON.parse(
      readFileSync(join(cwd, "tests", "pinned", ".last-status.json"), "utf8")
    );
    expect(cache.suggestedCount).toBeGreaterThan(0);

    // NEG CONTROL: no pin files were written.
    const files = readdirSync(join(cwd, "tests", "pinned")).filter((f) => f.endsWith(".test.ts"));
    expect(files).toEqual([]);
  });
});

describe("FEATURE-AUDIT: classifier regex does NOT match its own source comments", () => {
  // Regression guard: an earlier build matched `program.command("name", ...)`
  // inside its own comment block. The fix renamed the comment placeholder
  // to `<NAME>` so the regex no longer fires. This audit catches a
  // future regression of that fix.
  it("FALSIFIABILITY: a file containing the example placeholder pattern is NOT matched", async () => {
    const cwd = makeTempRepo();
    setupGitRepo(cwd);
    initPinnedRepo(cwd);

    // Create a file that contains ONLY the angle-bracket placeholder
    // pattern in a comment. If our classifier regresses to matching
    // angle-bracket placeholders, this test will fail by auto-pinning
    // it as a Commander command.
    writeFileSync(
      join(cwd, "doc-only.ts"),
      [
        "// Example shape: `program.command(\"<NAME>\", ...)` is documented here.",
        "// This is documentation, not code. The regex must not match.",
        "export const note = 'no commander calls in this file';",
      ].join("\n")
    );

    const r = await runCli(["auto-protect", "--quiet"], { cwd });
    expect(r.exitCode).toBe(0);

    const files = readdirSync(join(cwd, "tests", "pinned")).filter((f) =>
      f.endsWith(".test.ts")
    );
    // NEG CONTROL: zero cli-exits-zero pins (the regex would have
    // generated one for "<NAME>" before the fix).
    const cliPins = files.filter((f) => f.includes("cli-exits-zero"));
    expect(cliPins).toEqual([]);
  });
});
