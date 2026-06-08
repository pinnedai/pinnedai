// E2E test for the [BETA] browser-mode render pin (Cipherwake
// Features 1+2). Drives the EMIT path through the CLI and runs the
// generated pin against a real HTTP server with known broken vs
// healthy pages — asserts the pin CATCHES the broken case and
// PASSES the healthy case.
//
// Per [[positive-and-negative-tests-required]]: every code change
// runs the four-part matrix. This test covers the positive-catch
// (broken image → FAIL) and negative-skip (healthy page → PASS)
// halves. The "Playwright not installed" path is covered by the
// emit-shape test (renderCollectionBrowser.emit.test.ts).
//
// Playwright requires Chromium to be installed on the test host
// (`npx playwright install chromium`). When the browser binary is
// missing, this test skips with a loud single-line WARN — never
// fails the suite. CI that wants to fully exercise this test must
// run `npx playwright install --with-deps chromium` first.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";

const CLI = join(process.cwd(), "dist/cli.js");

// Detect chromium up-front so the test runner shows a single skip
// rather than 4 mysterious timeouts.
async function hasChromium(): Promise<boolean> {
  try {
    const pw = await import("playwright").catch(() => null);
    if (!pw) return false;
    // Probe whether the executable exists. launch() with an explicit
    // missing-binary error message is reliable; we don't actually
    // start a browser here.
    try {
      const b = await pw.chromium.launch({ headless: true });
      await b.close();
      return true;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.includes("Executable doesn't exist") || msg.includes("not installed")) {
        return false;
      }
      // Any other launch error — assume chromium is fine but
      // something else is wrong; let the test surface it.
      return true;
    }
  } catch {
    return false;
  }
}

let chromiumAvailable = false;
let healthyServer: Server | null = null;
let brokenServer: Server | null = null;
let healthyPort = 0;
let brokenPort = 0;

// A 2×2 PNG (valid, will load).
const PNG_2x2 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000020000000208060000007240388e000000164944415478da636060601800032280080000ffff0006000202bf6a4fb70000000049454e44ae426082",
  "hex"
);

// A deliberately broken SVG: raw `&` breaks XML parsing → image
// renders 0×0 in the browser. Same bug class Cipherwake reported.
const BROKEN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><text x="10" y="50">Fifth & Co</text></svg>`;
const HEALTHY_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><text x="10" y="50">Fifth &amp; Co</text></svg>`;

function startServer(handlers: Record<string, { type: string; body: Buffer | string }>): Promise<{ srv: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const srv = createServer((req, res) => {
      const url = req.url ?? "/";
      const route = url.split("?")[0];
      const h = handlers[route] ?? handlers["*"];
      if (!h) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": h.type });
      res.end(h.body);
    });
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ srv, port });
    });
  });
}

beforeAll(async () => {
  chromiumAvailable = await hasChromium();
  if (!chromiumAvailable) return;

  // Page that EMBEDS the broken SVG via data URI — same shape
  // Cipherwake hit. naturalWidth on this img will be 0.
  const brokenDataUri = "data:image/svg+xml;utf8," + encodeURIComponent(BROKEN_SVG);
  const brokenHtml = `<!doctype html><html><body>
    <h1>broken page</h1>
    <img src="${brokenDataUri}" alt="broken hero" />
    <p>${"x".repeat(600)}</p>
  </body></html>`;

  const healthyDataUri = "data:image/svg+xml;utf8," + encodeURIComponent(HEALTHY_SVG);
  const healthyHtml = `<!doctype html><html><body>
    <h1>healthy page</h1>
    <img src="${healthyDataUri}" alt="healthy hero" />
    <p>${"x".repeat(600)}</p>
  </body></html>`;

  const consoleErrHtml = `<!doctype html><html><body>
    <h1>console error</h1>
    <img src="data:image/png;base64,${PNG_2x2.toString("base64")}" />
    <script>console.error("boom: synthetic console error for pinned [browser] test");</script>
    <p>${"x".repeat(600)}</p>
  </body></html>`;

  const consoleOkHtml = `<!doctype html><html><body>
    <h1>console clean</h1>
    <img src="data:image/png;base64,${PNG_2x2.toString("base64")}" />
    <p>${"x".repeat(600)}</p>
  </body></html>`;

  const broken = await startServer({
    "/preview/broken": { type: "text/html", body: brokenHtml },
    "/preview/console-err": { type: "text/html", body: consoleErrHtml },
  });
  brokenServer = broken.srv;
  brokenPort = broken.port;

  const healthy = await startServer({
    "/preview/healthy": { type: "text/html", body: healthyHtml },
    "/preview/clean": { type: "text/html", body: consoleOkHtml },
  });
  healthyServer = healthy.srv;
  healthyPort = healthy.port;
}, 60_000);

afterAll(() => {
  if (healthyServer) try { healthyServer.close(); } catch {}
  if (brokenServer) try { brokenServer.close(); } catch {}
});

// Helper: run a child as a Promise. execFileSync would block the
// parent event loop — the HTTP server hosted in beforeAll() can't
// respond to incoming requests while sync is in flight, which makes
// page.goto in the spawned Playwright run time out. spawn() keeps
// the parent loop responsive.
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

// Helper: build a tmp project + run the generated pin via vitest.
async function runGeneratedPin(opts: {
  slugs: string[];
  pathTemplate: string;
  baseUrl: string;
  check: ("images" | "console")[];
}): Promise<{ stdout: string; stderr: string; exit: number }> {
  const dir = mkdtempSync(join(tmpdir(), "browser-pin-"));
  try {
    mkdirSync(join(dir, "lib"), { recursive: true });
    mkdirSync(join(dir, "tests/pinned"), { recursive: true });

    // collection-getter source
    writeFileSync(
      join(dir, "lib/slugs.ts"),
      `export function getAllSlugs() { return ${JSON.stringify(opts.slugs.map(s => ({ slug: s })))}; }\n`
    );
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "browser-pin-fixture",
        type: "module",
        version: "0.0.0",
        // Need vitest + playwright resolvable from inside the fixture.
        // The simplest path: alias to the cli/node_modules where both
        // are installed. We achieve this by creating a node_modules
        // symlink before running vitest below.
      })
    );

    // Run `pinned render add --browser` against the fixture. Use
    // --no-network-idle because the static-HTML fixture pages have no
    // network activity and Playwright's networkidle wait would
    // timeout (data URIs don't trigger network requests but Playwright
    // counts the initial HTML doc as "in flight" until something
    // settles it).
    execFileSync(
      "node",
      [
        CLI, "render", "add",
        "--path", opts.pathTemplate,
        "--from", "collection-getter",
        "--module", "lib/slugs.ts",
        "--export", "getAllSlugs",
        "--browser",
        "--browser-check", opts.check.join(","),
        "--no-network-idle",
        "--browser-timeout-ms", "10000",
        "--out-dir", "tests/pinned",
        "--pr-id", "test",
        "--quiet",
      ],
      { cwd: dir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );

    // Run the cli's own vitest binary against the fixture. The .bin
    // shim resolves vitest's modules from cli's node_modules, but the
    // pin file's `await import("playwright")` runs in the fixture's
    // module-resolution context — so the fixture needs Playwright
    // resolvable too. Cheapest path: symlink the cli's node_modules
    // into the fixture. Both vitest and playwright are pnpm-flattened
    // hoisted packages in cli/node_modules, so the symlink works for
    // both.
    const fixtureModules = join(dir, "node_modules");
    try { rmSync(fixtureModules, { force: true }); } catch {}
    execFileSync("ln", ["-s", join(process.cwd(), "node_modules"), fixtureModules]);
    const VITEST_BIN = join(process.cwd(), "node_modules", ".bin", "vitest");

    // MUST await before the finally block rms the dir — `return
    // spawnAsync(...)` would resolve from a deleted cwd.
    return await spawnAsync(VITEST_BIN, ["run", "--reporter=verbose", "tests/pinned"], {
      cwd: dir,
      env: { ...process.env, PINNED_BASE_URL: opts.baseUrl },
      timeoutMs: 90_000,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("[BETA] browser render pin — positive-catch / negative-skip", () => {
  it("FAILS when an enumerated route serves a 0×0 broken SVG image (Cipherwake's exact bug)", async () => {
    if (!chromiumAvailable) {
      console.warn("pinned [browser e2e]: Chromium not installed (`npx playwright install chromium`) — skipping. Non-blocking.");
      return;
    }
    const r = await runGeneratedPin({
      slugs: ["broken"],
      pathTemplate: "/preview/[slug]",
      baseUrl: `http://127.0.0.1:${brokenPort}`,
      check: ["images"],
    });
    expect(r.exit).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/broken images/i);
  }, 120_000);

  it("PASSES when every enumerated route serves healthy images", async () => {
    if (!chromiumAvailable) {
      console.warn("pinned [browser e2e]: Chromium not installed — skipping. Non-blocking.");
      return;
    }
    const r = await runGeneratedPin({
      slugs: ["healthy"],
      pathTemplate: "/preview/[slug]",
      baseUrl: `http://127.0.0.1:${healthyPort}`,
      check: ["images"],
    });
    expect(r.exit).toBe(0);
  }, 120_000);

  it("FAILS when a page emits a console.error (CSP / hydration bug class)", async () => {
    if (!chromiumAvailable) {
      console.warn("pinned [browser e2e]: Chromium not installed — skipping. Non-blocking.");
      return;
    }
    const r = await runGeneratedPin({
      slugs: ["console-err"],
      pathTemplate: "/preview/[slug]",
      baseUrl: `http://127.0.0.1:${brokenPort}`,
      check: ["console"],
    });
    expect(r.exit).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/console errors|uncaught page errors/i);
  }, 120_000);

  it("PASSES when a page has no console errors", async () => {
    if (!chromiumAvailable) {
      console.warn("pinned [browser e2e]: Chromium not installed — skipping. Non-blocking.");
      return;
    }
    const r = await runGeneratedPin({
      slugs: ["clean"],
      pathTemplate: "/preview/[slug]",
      baseUrl: `http://127.0.0.1:${healthyPort}`,
      check: ["console"],
    });
    expect(r.exit).toBe(0);
  }, 120_000);
});
