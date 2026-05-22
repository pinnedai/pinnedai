// FEATURE: vitest detection + install picks the right package manager
// across npm, pnpm, yarn, bun — including monorepo / workspace setups
// where `pinned init` runs in a workspace child package and the lockfile
// lives at the repo root.
// SIGNAL:
//   (a) detectPackageManager() returns "pnpm" | "yarn" | "bun" | "npm"
//       based on which lockfile sits at the workspace root, regardless
//       of whether init was invoked from the root or a child package.
//   (b) detectVitest() returns true if vitest is in either the child
//       package's deps/devDeps/peerDeps OR the workspace root's.
//   (c) installCommand() emits the correct PM-specific install command.
// FALSIFIABILITY:
//   - POS: per PM, given a lockfile at the workspace root and a child
//     dir at `packages/foo`, calling detectPackageManager(`packages/foo`)
//     returns the correct PM string.
//   - POS: detectVitest(child) returns true when vitest is declared at
//     root devDependencies (common monorepo pattern).
//   - NEG: when no lockfile exists anywhere, detectPackageManager
//     defaults to "npm" (graceful fallback, not a crash).
//   - NEG: when vitest is NOT declared at root or child, detectVitest
//     returns false (no false positive from sibling packages).

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectPackageManager,
  detectVitest,
  installCommand,
} from "../../apps/cli/src/vitestSetup.js";

function setupWorkspace(
  pm: "pnpm" | "yarn" | "bun" | "npm",
  opts: { vitestAtRoot?: boolean; vitestAtChild?: boolean } = {}
): { root: string; child: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pinned-ws-"));
  // Mark as a repo boundary so findUpwards stops at `root` and doesn't
  // wander up into the user's $HOME / system dirs during the test.
  mkdirSync(join(root, ".git"), { recursive: true });

  // Write the PM-appropriate lockfile at the workspace root.
  const lockfile = {
    pnpm: "pnpm-lock.yaml",
    yarn: "yarn.lock",
    bun: "bun.lockb",
    npm: "package-lock.json",
  }[pm];
  writeFileSync(join(root, lockfile), "# audit lockfile\n");

  // Root package.json (with workspaces) — optionally declares vitest.
  const rootPkg: Record<string, unknown> = {
    name: "ws-root",
    private: true,
    workspaces: ["packages/*"],
  };
  if (opts.vitestAtRoot) {
    rootPkg.devDependencies = { vitest: "^2.0.0" };
  }
  writeFileSync(join(root, "package.json"), JSON.stringify(rootPkg, null, 2));

  // Child workspace package.
  const child = join(root, "packages", "foo");
  mkdirSync(child, { recursive: true });
  const childPkg: Record<string, unknown> = { name: "foo", version: "0.0.0" };
  if (opts.vitestAtChild) {
    childPkg.devDependencies = { vitest: "^2.0.0" };
  }
  writeFileSync(join(child, "package.json"), JSON.stringify(childPkg, null, 2));

  return { root, child, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("FEATURE-AUDIT: vitest setup across PMs + workspaces", () => {
  describe("detectPackageManager — direct invocation (lockfile in cwd)", () => {
    for (const pm of ["pnpm", "yarn", "bun", "npm"] as const) {
      it(`POSITIVE: detects ${pm} when ${pm} lockfile is in cwd`, () => {
        const { root, cleanup } = setupWorkspace(pm);
        try {
          expect(detectPackageManager(root)).toBe(pm);
        } finally {
          cleanup();
        }
      });
    }

    it("NEGATIVE: defaults to 'npm' when no lockfile exists", () => {
      const dir = mkdtempSync(join(tmpdir(), "pinned-no-lock-"));
      mkdirSync(join(dir, ".git"), { recursive: true });
      try {
        expect(detectPackageManager(dir)).toBe("npm");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("detectPackageManager — workspace child invocation (lockfile at root)", () => {
    for (const pm of ["pnpm", "yarn", "bun", "npm"] as const) {
      it(`POSITIVE: walks up from packages/foo to find ${pm} lockfile at workspace root`, () => {
        const { child, cleanup } = setupWorkspace(pm);
        try {
          expect(detectPackageManager(child)).toBe(pm);
        } finally {
          cleanup();
        }
      });
    }
  });

  describe("detectVitest — finds vitest at root or child", () => {
    it("POSITIVE: vitest at workspace root → detected from child invocation", () => {
      const { child, cleanup } = setupWorkspace("pnpm", { vitestAtRoot: true });
      try {
        expect(detectVitest(child)).toBe(true);
      } finally {
        cleanup();
      }
    });

    it("POSITIVE: vitest at child package only → detected from child invocation", () => {
      const { child, cleanup } = setupWorkspace("pnpm", { vitestAtChild: true });
      try {
        expect(detectVitest(child)).toBe(true);
      } finally {
        cleanup();
      }
    });

    it("NEGATIVE: vitest absent everywhere → not detected", () => {
      const { child, cleanup } = setupWorkspace("pnpm");
      try {
        expect(detectVitest(child)).toBe(false);
      } finally {
        cleanup();
      }
    });

    it("NEGATIVE: vitest in a SIBLING workspace (packages/bar) → NOT a false positive in packages/foo", () => {
      const { root, child, cleanup } = setupWorkspace("pnpm");
      try {
        // Add a sibling package that declares vitest.
        const sibling = join(root, "packages", "bar");
        mkdirSync(sibling, { recursive: true });
        writeFileSync(
          join(sibling, "package.json"),
          JSON.stringify({ name: "bar", devDependencies: { vitest: "^2.0.0" } })
        );
        // detectVitest in `foo` only walks up to ROOT — does not scan
        // siblings. So vitest in `bar` is invisible to `foo`. This
        // matches install semantics: installing vitest in `foo` would
        // not pick up `bar`'s declaration.
        expect(detectVitest(child)).toBe(false);
      } finally {
        cleanup();
      }
    });
  });

  describe("installCommand — emits PM-correct command", () => {
    it("pnpm uses pnpm add -D", () => {
      expect(installCommand("pnpm")).toEqual(["pnpm", "add", "-D", "vitest@^2"]);
    });
    it("yarn uses yarn add -D", () => {
      expect(installCommand("yarn")).toEqual(["yarn", "add", "-D", "vitest@^2"]);
    });
    it("bun uses bun add -d (lowercase)", () => {
      expect(installCommand("bun")).toEqual(["bun", "add", "-d", "vitest@^2"]);
    });
    it("npm uses npm install --save-dev", () => {
      expect(installCommand("npm")).toEqual([
        "npm",
        "install",
        "--save-dev",
        "vitest@^2",
      ]);
    });
  });
});
