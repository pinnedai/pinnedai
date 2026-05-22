// FEATURE: The VS Code extension packages cleanly to a .vsix file.
// SIGNAL:
//   - `apps/vscode-extension/package.json` exists with valid manifest
//   - `apps/vscode-extension/dist/extension.js` is built and < 20KB
//   - The extension's package.json declares: publisher, name, version,
//     activationEvents, main entry, vscode engine, contributed commands
// FALSIFIABILITY: catches a regression where the extension manifest
//   is malformed (Marketplace would reject), the main entry doesn't
//   build, or required contribution points are missing.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const EXT_DIR = resolve(
  new URL(import.meta.url).pathname,
  "..",
  "..",
  "..",
  "apps",
  "vscode-extension"
);

describe("FEATURE-AUDIT: VS Code extension is packageable", () => {
  it("POSITIVE CONTROL: package.json declares all required manifest fields", () => {
    const pkgPath = resolve(EXT_DIR, "package.json");
    expect(existsSync(pkgPath)).toBe(true);
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

    // Marketplace-required fields
    expect(pkg.name).toBe("pinnedai-vscode");
    expect(pkg.publisher).toBe("pinnedai");
    expect(typeof pkg.version).toBe("string");
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(pkg.engines?.vscode).toMatch(/^\^?\d/);
    expect(pkg.license).toBe("Apache-2.0");

    // Activation: extension should activate ONLY in pinned-aware
    // workspaces (not globally on every VS Code startup — wasteful).
    expect(Array.isArray(pkg.activationEvents)).toBe(true);
    const activations = pkg.activationEvents as string[];
    expect(activations.some((a) => a.includes("workspaceContains"))).toBe(true);

    // Main entry must point at the built bundle.
    expect(pkg.main).toMatch(/dist\/extension\.js$/);

    // Contributed commands — minimum set the README promises.
    const cmds = pkg.contributes?.commands as Array<{ command: string }>;
    expect(Array.isArray(cmds)).toBe(true);
    const cmdIds = cmds.map((c) => c.command);
    expect(cmdIds).toContain("pinnedai.review");
    expect(cmdIds).toContain("pinnedai.status");
    expect(cmdIds).toContain("pinnedai.list");
  });

  it("POSITIVE CONTROL: dist/extension.js builds + stays under 20KB", () => {
    const distPath = resolve(EXT_DIR, "dist", "extension.js");
    expect(existsSync(distPath)).toBe(true);
    const sizeKb = statSync(distPath).size / 1024;
    // Extension is intentionally thin — shells out to the CLI for
    // everything. If it bloats past 20KB, something heavy got bundled.
    expect(sizeKb).toBeLessThan(20);
  });

  it("FALSIFIABILITY: extension activates ONLY in pinned-aware workspaces", () => {
    // Catches a regression where someone changes activationEvents to
    // "*" (always-on), which would force every VS Code user with the
    // extension installed to spawn `pinned statusline` shell processes
    // on workspace open, even repos that have nothing to do with Pinned.
    const pkg = JSON.parse(
      readFileSync(resolve(EXT_DIR, "package.json"), "utf8")
    );
    const activations = pkg.activationEvents as string[];
    expect(activations).not.toContain("*");
    expect(activations).not.toContain("onStartupFinished");
    // Must include at least one workspaceContains gate.
    expect(activations.some((a) => a.startsWith("workspaceContains:"))).toBe(true);
  });
});
