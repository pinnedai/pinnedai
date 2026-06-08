// Cipherwake P0 (0.5.0-beta.2): page-renders pins must SKIP — not
// FAIL — when:
//   1. PREVIEW_URL is set but the server is unreachable
//      (ECONNREFUSED / DNS / timeout / 502-503-504-retries-exhausted)
//   2. The route returns ANY 3xx redirect (auth-gated /admin → /login,
//      tenant-redirect, root-redirect, rate-limit shed)
//
// Only a real HTTP 5xx (or 200-with-error-shape) should FAIL.
//
// This test runs the generated page-renders pin file as a real
// vitest subprocess against a real local HTTP server, and asserts
// the EXIT CODE — not the stdout. Per the discipline catalog
// (commandE2ECatalog.test.ts): assert on real state.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";

const CLI = join(process.cwd(), "dist/cli.js");
const VITEST_BIN = join(process.cwd(), "node_modules", ".bin", "vitest");

let dir: string;
let stub: Server | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pagerenders-skip-"));
});

afterEach(() => {
  if (stub) try { stub.close(); } catch {}
  stub = null;
  rmSync(dir, { recursive: true, force: true });
});

function spawnAsync(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }
): Promise<{ stdout: string; stderr: string; exit: number }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, opts.timeoutMs);
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        exit: code ?? 1,
      });
    });
  });
}

function setupFixture(route: string) {
  mkdirSync(join(dir, "tests/pinned"), { recursive: true });
  // Symlink the cli's node_modules so the spawned vitest can resolve.
  const fixtureModules = join(dir, "node_modules");
  try { rmSync(fixtureModules, { force: true }); } catch {}
  execFileSync("ln", ["-s", join(process.cwd(), "node_modules"), fixtureModules]);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "infra-skip", type: "module" }));

  // Generate a page-renders pin via the CLI.
  execFileSync(
    "node",
    [
      CLI, "generate",
      "--pr-id", "test",
      "--description", `GET ${route} renders`,
      "--out-dir", "tests/pinned",
      "--quiet",
    ],
    { cwd: dir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
  );
}

async function runVitest(previewUrl: string | undefined): Promise<{ stdout: string; stderr: string; exit: number }> {
  return await spawnAsync(VITEST_BIN, ["run", "--reporter=verbose", "tests/pinned"], {
    cwd: dir,
    env: {
      ...process.env,
      ...(previewUrl ? { PREVIEW_URL: previewUrl } : {}),
    },
    timeoutMs: 60_000,
  });
}

function startServer(handler: (req: any, res: any) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer(handler);
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      stub = srv;
      resolve(port);
    });
  });
}

describe("page-renders SKIP semantics (Cipherwake P0)", () => {
  it("PREVIEW_URL set but server unreachable (ECONNREFUSED) → NOT a regression catch", async () => {
    setupFixture("/admin");
    // Pick a port that's almost certainly closed.
    const r = await runVitest("http://127.0.0.1:1");
    // The pin's behavior on unreachable: pinnedFetch throws
    // PinnedInfraFailure → pinnedWrapInfra re-throws as a marked
    // "PINNED INFRA FAILURE" message. vitest still reports an exit
    // code, but the message must explicitly say "NOT a catch" so
    // downstream classification (the hook's catch ledger) doesn't
    // surface it as a regression on every prompt.
    expect(r.stdout + r.stderr).toMatch(/PINNED INFRA FAILURE/);
    expect(r.stdout + r.stderr).toMatch(/NOT a catch/i);
  }, 60_000);

  it("route returns 307 to /login → SKIPS (auth-gated)", async () => {
    setupFixture("/admin");
    const port = await startServer((req, res) => {
      if (req.url === "/admin") {
        res.writeHead(307, { location: "/login?from=/admin" });
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    const r = await runVitest(`http://127.0.0.1:${port}`);
    // Auth-gated path → pin skips internally; vitest exit 0.
    expect(r.exit).toBe(0);
    expect(r.stdout + r.stderr).not.toMatch(/PINNED FAILURE/);
  }, 60_000);

  it("route returns 307 to root (NO 'login' in Location) → STILL SKIPS (any 3xx is out of scope)", async () => {
    // This is the case the old detector missed: redirect to / for
    // unauthenticated users where the path doesn't carry "login".
    setupFixture("/admin");
    const port = await startServer((req, res) => {
      if (req.url === "/admin") {
        res.writeHead(307, { location: "/" });
        res.end();
      } else {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><body>" + "x".repeat(600) + "</body></html>");
      }
    });
    const r = await runVitest(`http://127.0.0.1:${port}`);
    expect(r.exit).toBe(0);
    expect(r.stdout + r.stderr).not.toMatch(/PINNED FAILURE/);
  }, 60_000);

  it("route returns real 500 → FAILS (the real case still caught)", async () => {
    setupFixture("/admin");
    const port = await startServer((_req, res) => {
      res.writeHead(500, { "content-type": "text/html" });
      res.end("<html><body>Internal Server Error</body></html>");
    });
    const r = await runVitest(`http://127.0.0.1:${port}`);
    expect(r.exit).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/PINNED FAILURE/);
    // Must NOT be classified as infra
    expect(r.stdout + r.stderr).not.toMatch(/PINNED INFRA FAILURE/);
  }, 60_000);

  it("no PREVIEW_URL set → SKIPS quietly (existing behavior, preserved)", async () => {
    setupFixture("/admin");
    const r = await runVitest(undefined);
    // No PREVIEW_URL → it.skipIf fires → vitest exit 0.
    expect(r.exit).toBe(0);
    expect(r.stdout + r.stderr).not.toMatch(/PINNED FAILURE/);
    expect(r.stdout + r.stderr).not.toMatch(/PINNED INFRA FAILURE/);
  }, 60_000);
});
