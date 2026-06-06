// Framework detection + dev-server boot for `pinned dev`.
//
// Per Cipherwake Gap 3: pins skip locally because the on-demand cadence
// requires SMOKE_RUN=1 / PINNED_SMOKE=1 AND a resolvable base URL.
// `pinned dev` sets both, boots the customer's dev server, waits for
// it to be ready, runs vitest, tears down. Zero env vars needed.
//
// Hard requirement (Cipherwake correction): "set the env var" is NOT
// the same as "a pin ran." After vitest exits, we PARSE the output and
// fail the command non-zero if zero pins actually executed. An auto-
// opt-in that silently still skips is the same trap.
//
// Browser-safety: this module is Node-only (spawns child processes).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

export type Framework = "next" | "vite" | "remix" | "astro" | "sveltekit" | "nuxt" | "unknown";

export type DetectedFramework = {
  framework: Framework;
  devScript: string | null;
  defaultPort: number;
};

export function detectFramework(cwd: string): DetectedFramework {
  const pkgPath = join(cwd, "package.json");
  if (!existsSync(pkgPath)) return { framework: "unknown", devScript: null, defaultPort: 3000 };
  let pkg: any;
  try { pkg = JSON.parse(readFileSync(pkgPath, "utf8")); } catch { return { framework: "unknown", devScript: null, defaultPort: 3000 }; }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const scripts = pkg.scripts ?? {};

  if (deps.next || /\bnext (dev|start)/.test(scripts.dev ?? "")) {
    return { framework: "next", devScript: scripts.dev ?? "next dev", defaultPort: 3000 };
  }
  if (deps.astro) {
    return { framework: "astro", devScript: scripts.dev ?? "astro dev", defaultPort: 4321 };
  }
  if (deps["@sveltejs/kit"]) {
    return { framework: "sveltekit", devScript: scripts.dev ?? "vite dev", defaultPort: 5173 };
  }
  if (deps["@remix-run/dev"] || deps["@remix-run/react"]) {
    return { framework: "remix", devScript: scripts.dev ?? "remix dev", defaultPort: 3000 };
  }
  if (deps.nuxt) {
    return { framework: "nuxt", devScript: scripts.dev ?? "nuxt dev", defaultPort: 3000 };
  }
  if (deps.vite || /\bvite\b/.test(scripts.dev ?? "")) {
    return { framework: "vite", devScript: scripts.dev ?? "vite", defaultPort: 5173 };
  }
  if (scripts.dev) {
    return { framework: "unknown", devScript: scripts.dev, defaultPort: 3000 };
  }
  return { framework: "unknown", devScript: null, defaultPort: 3000 };
}

export async function pickPort(preferred: number): Promise<number> {
  const isFree = await new Promise<boolean>((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(preferred, "127.0.0.1");
  });
  if (isFree) return preferred;
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : preferred;
      srv.close(() => resolve(port));
    });
  });
}

export async function waitForReady(url: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (res.status > 0) return true;
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

export type BootedServer = {
  process: ChildProcess;
  port: number;
  baseUrl: string;
  tearDown: () => Promise<void>;
};

export async function bootDevServer(opts: {
  cwd: string;
  devScript: string;
  port: number;
  env?: NodeJS.ProcessEnv;
}): Promise<BootedServer> {
  const env = { ...process.env, ...(opts.env ?? {}), PORT: String(opts.port) };
  const child = spawn(opts.devScript, { cwd: opts.cwd, env, shell: true, stdio: "pipe" });
  child.stderr?.on("data", (chunk) => process.stderr.write(`[dev] ${chunk}`));
  const baseUrl = `http://localhost:${opts.port}`;
  return {
    process: child,
    port: opts.port,
    baseUrl,
    tearDown: async () => {
      if (child.killed || child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* */ }
          resolve();
        }, 5000);
        child.once("exit", () => { clearTimeout(t); resolve(); });
      });
    },
  };
}

export type PinExecutionStats = {
  executed: number;
  skipped: number;
  total: number;
  passed: number;
  failed: number;
};

// Parses vitest output. Supports the common verbose-reporter shapes.
export function parseVitestExecutionStats(output: string): PinExecutionStats {
  // Strip ANSI escape codes — vitest's reporter colors its output.
  const ansiRe = /\x1B\[[0-9;]*m/g;
  const clean = output.replace(ansiRe, "");
  // Look for individual count phrases anywhere in the output.
  const passedM = /(\d+)\s+passed/.exec(clean);
  const failedM = /(\d+)\s+failed/.exec(clean);
  const skippedM = /(\d+)\s+skipped/.exec(clean);
  const passed = passedM ? Number(passedM[1]) : 0;
  const failed = failedM ? Number(failedM[1]) : 0;
  const skipped = skippedM ? Number(skippedM[1]) : 0;
  return {
    executed: passed + failed,
    skipped,
    total: passed + failed + skipped,
    passed,
    failed,
  };
}
