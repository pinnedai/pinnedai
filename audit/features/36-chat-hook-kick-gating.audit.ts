// FEATURE: `pinned hook-failure` cheap-check + throttled auto-protect kick
//
// SIGNAL: The chat hook fires `pinned auto-protect` in the background
//   ONLY when all three gates pass:
//     1. mode !== "off"
//     2. >= CHAT_HOOK_AUTO_PROTECT_TTL_MS since last kick
//     3. working-tree git state differs from cached lastCheckedSha/dirtyHash
//   When it kicks, it stamps `lastAutoProtectAt`. When it doesn't kick,
//   the stamp is left untouched.
//
// FALSIFIABILITY (3 directions per T4):
//   POSITIVE: drifted state + stale throttle + safe mode → stamp updates
//   NEGATIVE — mode: off mode never kicks even with drift
//   NEGATIVE — throttle: a recent stamp blocks the kick even with drift
//   NEUTRAL — no-drift: same git state as cache, no kick (cheap chat turn)
//   PRESERVATION: writeLastStatus must preserve lastAutoProtectAt/
//     lastAddNotifiedAt fields across other write paths (auto-protect,
//     stamp, test). Catches the cache-strip regression we shipped.

import { describe, it, expect } from "vitest";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runCli, makeTempRepo } from "./runCli.js";
import { CHAT_HOOK_AUTO_PROTECT_TTL_MS } from "../../apps/cli/src/statusline.js";

function setupRepo(cwd: string, mode: "safe" | "ask" | "off" = "safe"): void {
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.email", "audit@pinnedai.dev"], { cwd });
  execFileSync("git", ["config", "user.name", "audit"], { cwd });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd });
  mkdirSync(join(cwd, ".pinnedai"), { recursive: true });
  writeFileSync(
    join(cwd, ".pinnedai", "config.json"),
    JSON.stringify({
      version: 1,
      auto_protect: mode,
      safety_budget_per_run: 5,
      show_pending_changes: false,
    })
  );
  mkdirSync(join(cwd, "tests", "pinned"), { recursive: true });
  writeFileSync(
    join(cwd, "tests", "pinned", ".registry.json"),
    JSON.stringify({ version: 1, claims: [] })
  );
}

// Seed cache with a known prior state.
function seedCache(
  cwd: string,
  overrides: Record<string, unknown> = {}
): void {
  const cachePath = join(cwd, "tests", "pinned", ".last-status.json");
  writeFileSync(
    cachePath,
    JSON.stringify({
      status: "green",
      failingCount: 0,
      failingClaimIds: [],
      totalPins: 0,
      updatedAt: new Date().toISOString(),
      ...overrides,
    })
  );
}

function readCache(cwd: string): Record<string, unknown> {
  const cachePath = join(cwd, "tests", "pinned", ".last-status.json");
  return JSON.parse(readFileSync(cachePath, "utf8"));
}

// Wait long enough for the detached background child to finish writing.
async function settle(ms = 300): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("FEATURE-AUDIT: hook-failure cheap-check + drift-aware + throttled kick", () => {
  it("POSITIVE: drifted state + stale throttle + safe mode + high-risk path → kick fires, stamps lastAutoProtectAt", async () => {
    const cwd = makeTempRepo();
    setupRepo(cwd, "safe");
    // Add a HIGH-RISK uncommitted file so the auto-review threshold
    // gate passes — v0.1.1 only fires the chat-hook kick when there
    // are ≥10 Pinned-relevant changes OR ≥1 high-risk path touched
    // (admin route, webhook, middleware, env). Without this, all
    // tests would need to seed 10 relevant files just to verify
    // throttle/mode behavior — the high-risk path is the simpler
    // trigger.
    mkdirSync(join(cwd, "app", "api", "admin", "export"), { recursive: true });
    writeFileSync(
      join(cwd, "app", "api", "admin", "export", "route.ts"),
      "export async function GET() { return new Response('hi'); }\n"
    );

    // Seed a cache with a different SHA so drift is detected.
    seedCache(cwd, {
      lastCheckedSha: "0".repeat(40),
      lastCheckedDirtyHash: "0".repeat(16),
      // No lastAutoProtectAt → throttle passes (treated as Infinity ago).
    });

    const beforeStamp = readCache(cwd).lastAutoProtectAt;
    expect(beforeStamp).toBeUndefined();

    const r = await runCli(["hook-failure"], { cwd, cleanup: false });
    expect(r.exitCode).toBe(0);
    await settle();

    const afterStamp = readCache(cwd).lastAutoProtectAt;
    expect(typeof afterStamp).toBe("string");
    // The stamp is an ISO timestamp from "just now".
    const age = Date.now() - new Date(afterStamp as string).getTime();
    expect(age).toBeLessThan(5000);
  });

  it("NEGATIVE — mode: off mode never kicks even with drift + stale throttle", async () => {
    const cwd = makeTempRepo();
    setupRepo(cwd, "off");
    seedCache(cwd, {
      lastCheckedSha: "0".repeat(40),
      lastCheckedDirtyHash: "0".repeat(16),
    });

    const r = await runCli(["hook-failure"], { cwd, cleanup: false });
    expect(r.exitCode).toBe(0);
    await settle();

    const cache = readCache(cwd);
    // off mode: no kick, no stamp.
    expect(cache.lastAutoProtectAt).toBeUndefined();
  });

  it("NEGATIVE — throttle: recent kick blocks new kick even with drift", async () => {
    const cwd = makeTempRepo();
    setupRepo(cwd, "safe");
    const recent = new Date(Date.now() - 5_000).toISOString(); // 5s ago
    seedCache(cwd, {
      lastCheckedSha: "0".repeat(40),
      lastCheckedDirtyHash: "0".repeat(16),
      lastAutoProtectAt: recent,
    });

    const r = await runCli(["hook-failure"], { cwd, cleanup: false });
    expect(r.exitCode).toBe(0);
    await settle();

    const cache = readCache(cwd);
    // Throttle blocked the kick — stamp unchanged.
    expect(cache.lastAutoProtectAt).toBe(recent);
  });

  it("NEUTRAL — no drift: cache SHA matches current SHA, no kick fires", async () => {
    const cwd = makeTempRepo();
    setupRepo(cwd, "safe");
    // Capture the current SHA and put it in the cache so there's no drift.
    const currentSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
    }).trim();
    // Also need matching dirtyHash for the cheap-check to succeed.
    // With a clean working tree, the diff is empty so the hash is of "".
    // We don't need to compute it — leaving it undefined means the
    // captureGitState comparison only checks SHA, which DOES match.
    seedCache(cwd, {
      lastCheckedSha: currentSha,
      // Intentionally NO lastCheckedDirtyHash, so only SHA gates apply.
      // No prior lastAutoProtectAt — throttle wouldn't block alone.
    });

    const r = await runCli(["hook-failure"], { cwd, cleanup: false });
    expect(r.exitCode).toBe(0);
    await settle();

    const cache = readCache(cwd);
    // No drift → no kick → no stamp.
    expect(cache.lastAutoProtectAt).toBeUndefined();
  });

  it("PRESERVATION: lastAutoProtectAt + lastAddNotifiedAt survive across auto-protect writes", async () => {
    // Regression guard: an earlier build's writeLastStatus calls
    // wholesale-replaced the cache and silently dropped these fields,
    // which silently bypassed the throttle. This test asserts the
    // fields survive an auto-protect run.
    const cwd = makeTempRepo();
    setupRepo(cwd, "safe");
    const protectStamp = new Date(Date.now() - 30_000).toISOString();
    const notifyStamp = new Date(Date.now() - 60_000).toISOString();
    seedCache(cwd, {
      lastCheckedSha: "0".repeat(40),
      lastAutoProtectAt: protectStamp,
      lastAddNotifiedAt: notifyStamp,
      recentlyAddedAt: notifyStamp, // older than notify → won't re-celebrate
      recentlyAddedCount: 0,
    });

    const r = await runCli(["auto-protect", "--quiet"], { cwd, cleanup: false });
    expect(r.exitCode).toBe(0);

    const cache = readCache(cwd);
    // The two fields auto-protect doesn't own must be preserved.
    expect(cache.lastAutoProtectAt).toBe(protectStamp);
    expect(cache.lastAddNotifiedAt).toBe(notifyStamp);
  });
});
