// Vitest detection + install offer.
//
// Pins are Vitest tests. Without vitest in the customer's repo,
// `pinned test` fails silently and pin growth never gets verified —
// the worst-of-both failure mode (looks like Pinned is broken).
//
// We don't bundle vitest as a hard dependency (~30-50MB; too heavy
// for a "small devtool" first impression). Instead it's an OPTIONAL
// peer dependency, and `pinned init` detects whether the customer
// already has it and offers to install if not.
//
// Detection: check the customer's package.json deps/devDeps/peerDeps.
// Package manager: detected from the lockfile (pnpm-lock.yaml,
// yarn.lock, bun.lockb, package-lock.json). Default: npm.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

// Walk from `start` toward the filesystem root, returning the first
// ancestor (including `start`) that contains any file in `markers`.
// Used so a customer running `pinned init` from a monorepo child
// package (e.g. packages/foo) still picks up the workspace root's
// lockfile / package.json instead of falsely defaulting to npm.
//
// Stops at: filesystem root, OR a `.git` directory (a repo boundary —
// don't escape the customer's project into their $HOME).
function findUpwards(start: string, markers: string[]): string | null {
  let cur = start;
  while (true) {
    for (const m of markers) {
      if (existsSync(join(cur, m))) return cur;
    }
    if (existsSync(join(cur, ".git"))) {
      // Hit the repo boundary without finding a marker — stop here.
      return null;
    }
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

export function detectPackageManager(repoRoot: string): PackageManager {
  // Walk up so workspace children inherit their root's package manager.
  const lockDir = findUpwards(repoRoot, [
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lockb",
    "package-lock.json",
  ]);
  const dir = lockDir ?? repoRoot;
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  if (existsSync(join(dir, "bun.lockb"))) return "bun";
  return "npm";
}

export function detectVitest(repoRoot: string): boolean {
  // Check the immediate package.json first (the package we'd actually
  // install into). If absent, walk up to find a parent package.json —
  // some workspace setups put devDeps at the root and children inherit.
  const candidates: string[] = [];
  const own = join(repoRoot, "package.json");
  if (existsSync(own)) candidates.push(own);
  const parentDir = findUpwards(dirname(repoRoot), ["package.json"]);
  if (parentDir) candidates.push(join(parentDir, "package.json"));

  for (const pkgPath of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      if (
        pkg.dependencies?.vitest ||
        pkg.devDependencies?.vitest ||
        pkg.peerDependencies?.vitest
      ) {
        return true;
      }
    } catch {
      // fall through to next candidate
    }
  }
  return false;
}

// Detect whether `repoRoot` is the root of a pnpm or yarn-classic
// workspace. pnpm refuses `pnpm add -D` at a workspace root without
// the `-w` / `--workspace-root` flag (ERR_PNPM_ADDING_TO_ROOT), and
// yarn classic similarly insists on `-W` for root installs. Without
// this detection, auto-install fails on every monorepo — exactly the
// shape of repo most Pinned-target users (AI coders shipping fast)
// have. Quantasyte dogfood surfaced this bug.
function isWorkspaceRoot(repoRoot: string): boolean {
  if (existsSync(join(repoRoot, "pnpm-workspace.yaml"))) return true;
  const pkgPath = join(repoRoot, "package.json");
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      workspaces?: string[] | { packages?: string[] };
    };
    if (Array.isArray(pkg.workspaces) && pkg.workspaces.length > 0) return true;
    if (
      pkg.workspaces &&
      typeof pkg.workspaces === "object" &&
      Array.isArray(pkg.workspaces.packages) &&
      pkg.workspaces.packages.length > 0
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function installCommand(
  pm: PackageManager,
  repoRoot?: string
): string[] {
  // Always pin to ^2 — current LTS-equivalent for vitest.
  // The workspace-root flag is added when the customer's repo is the
  // root of a monorepo workspace; otherwise the PM-native command is
  // already correct.
  const atWorkspaceRoot = repoRoot ? isWorkspaceRoot(repoRoot) : false;
  switch (pm) {
    case "pnpm":
      return atWorkspaceRoot
        ? ["pnpm", "add", "-D", "-w", "vitest@^2"]
        : ["pnpm", "add", "-D", "vitest@^2"];
    case "yarn":
      // yarn classic (v1) uses -W; yarn berry (v2+) accepts both forms
      // but doesn't strictly require it. Use -W defensively for both.
      return atWorkspaceRoot
        ? ["yarn", "add", "-D", "-W", "vitest@^2"]
        : ["yarn", "add", "-D", "vitest@^2"];
    case "bun":
      // bun doesn't require an explicit workspace-root flag.
      return ["bun", "add", "-d", "vitest@^2"];
    default:
      // npm auto-detects workspaces and adds to root by default —
      // no flag needed.
      return ["npm", "install", "--save-dev", "vitest@^2"];
  }
}

export type InstallResult =
  | { status: "already-installed" }
  | { status: "installed"; manager: PackageManager; command: string }
  | { status: "skipped" }
  | { status: "no-package-json" }
  | {
      status: "failed";
      manager: PackageManager;
      command: string;
      exitCode: number | null;
      // Captured BOTH streams — pnpm in particular prints user-actionable
      // errors to stdout (workspace lockfile mismatches, peer-dep
      // refusal, registry unreachable), not stderr. Capturing only
      // stderr leaves us reporting "vitest install failed:" with an
      // empty body, which is what bit us in the Quantasyte dogfood.
      stdout: string;
      stderr: string;
    };

export function installVitest(repoRoot: string): InstallResult {
  if (!existsSync(join(repoRoot, "package.json"))) {
    return { status: "no-package-json" };
  }
  if (detectVitest(repoRoot)) {
    return { status: "already-installed" };
  }
  const pm = detectPackageManager(repoRoot);
  const cmd = installCommand(pm, repoRoot);
  // Run synchronously — we want the install to complete before
  // the rest of init runs (so subsequent checks see vitest present).
  const r = spawnSync(cmd[0], cmd.slice(1), {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (r.status === 0) {
    return {
      status: "installed",
      manager: pm,
      command: cmd.join(" "),
    };
  }
  return {
    status: "failed",
    manager: pm,
    command: cmd.join(" "),
    exitCode: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}
