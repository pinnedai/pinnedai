// pinnedai VS Code extension.
//
// Brings the Pinned statusline to VS Code, Cursor, and every VS Code-
// family editor. The extension is intentionally thin:
//   - Activates only when the workspace looks like a pinnedai repo
//     (presence of `tests/pinned/.registry.json` or `.pinnedai/config.json`)
//   - Reads the CLI's emitted statusline via shelling out to `pinned statusline`
//   - Refreshes every N seconds + on file save (configurable)
//   - Adds Pinned commands to the command palette
//
// We deliberately don't re-implement statusline rendering in TS here.
// The CLI is the source of truth for state shape, and any future
// statusline state we add to the CLI is automatically picked up by
// this extension.

import * as vscode from "vscode";
import { spawn } from "node:child_process";

const PINNED_BIN_HINTS = [
  // Workspace-installed (`npm install pinnedai`)
  "node_modules/.bin/pinned",
  // Monorepo dogfood location
  "apps/cli/dist/cli.js",
  "node_modules/pinnedai/dist/cli.js",
];

let statusBarItem: vscode.StatusBarItem | undefined;
let refreshTimer: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const cfg = vscode.workspace.getConfiguration("pinnedai");
  if (cfg.get<boolean>("statusBar.enabled", true)) {
    statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    statusBarItem.command = "pinnedai.status";
    context.subscriptions.push(statusBarItem);
    refresh();

    const intervalSec = Math.max(2, cfg.get<number>("statusBar.refreshIntervalSeconds", 10));
    refreshTimer = setInterval(refresh, intervalSec * 1000);
    context.subscriptions.push({ dispose: () => refreshTimer && clearInterval(refreshTimer) });

    // Also refresh on file save — the most likely moment for state to change.
    context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument(refresh)
    );
  }

  // Commands wired into the command palette + status bar click target.
  context.subscriptions.push(
    vscode.commands.registerCommand("pinnedai.review", () => runInTerminal("review")),
    vscode.commands.registerCommand("pinnedai.status", () => runInTerminal("status")),
    vscode.commands.registerCommand("pinnedai.list", () => runInTerminal("list --verbose")),
    vscode.commands.registerCommand("pinnedai.openSite", () => {
      vscode.env.openExternal(vscode.Uri.parse("https://pinnedai.dev"));
    })
  );
}

export function deactivate(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  if (statusBarItem) statusBarItem.dispose();
}

// ---- helpers ----

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

// Resolve a pinned binary command. Searches workspace-relative hints
// first, then falls back to `pinned` on PATH, then `npx --no-install
// pinnedai`. Returns a 2-tuple [executable, prefixArgs] so the caller
// can append the subcommand.
function resolveBin(root: string): { cmd: string; args: string[] } {
  const cfg = vscode.workspace.getConfiguration("pinnedai");
  const explicit = cfg.get<string>("binaryPath", "").trim();
  if (explicit) {
    if (explicit.endsWith(".js")) return { cmd: "node", args: [explicit] };
    return { cmd: explicit, args: [] };
  }
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  for (const hint of PINNED_BIN_HINTS) {
    const abs = path.join(root, hint);
    if (fs.existsSync(abs)) {
      if (hint.endsWith(".js")) return { cmd: "node", args: [abs] };
      return { cmd: abs, args: [] };
    }
  }
  // Fallback: assume `pinned` is on PATH (global install) or use npx.
  return { cmd: "npx", args: ["--no-install", "pinnedai"] };
}

function refresh(): void {
  if (!statusBarItem) return;
  const root = workspaceRoot();
  if (!root) {
    statusBarItem.hide();
    return;
  }
  const { cmd, args } = resolveBin(root);
  const child = spawn(cmd, [...args, "statusline"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout?.on("data", (b: Buffer) => (out += b.toString("utf8")));
  child.on("close", (code) => {
    if (!statusBarItem) return;
    if (code !== 0) {
      // CLI not installed / not pinned-initialized — hide silently.
      statusBarItem.hide();
      return;
    }
    // Strip ANSI codes the CLI emits for terminal coloring; VS Code's
    // status bar uses its own theme tokens.
    const clean = out.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (!clean) {
      statusBarItem.hide();
      return;
    }
    statusBarItem.text = clean;
    statusBarItem.tooltip = "Click to run `pinned status` in a terminal.";
    statusBarItem.show();
  });
  child.on("error", () => {
    if (statusBarItem) statusBarItem.hide();
  });
}

function runInTerminal(subcommand: string): void {
  const root = workspaceRoot();
  if (!root) {
    vscode.window.showWarningMessage("Pinned: no workspace folder open.");
    return;
  }
  const { cmd, args } = resolveBin(root);
  const fullCmd = [cmd, ...args, ...subcommand.split(" ")].join(" ");

  // Reuse an existing Pinned terminal if one is open, otherwise spawn.
  const existing = vscode.window.terminals.find((t) => t.name === "Pinned");
  const terminal = existing ?? vscode.window.createTerminal({ name: "Pinned", cwd: root });
  terminal.show();
  terminal.sendText(fullCmd);
}
