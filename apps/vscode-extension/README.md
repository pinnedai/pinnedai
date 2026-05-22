# pinnedai for VS Code & Cursor

> Status-bar indicator + command-palette integration for the [pinnedai](https://pinnedai.dev) CLI.

Pinned turns claims in your PR descriptions into permanent Vitest tests in your repo. This extension surfaces Pinned's current state in your VS Code (or Cursor) bottom bar — no need to keep a terminal open or run commands to check status.

![pinnedai status bar item showing pin count and verification streak](images/screenshot.png)

## What it does

- **Status bar item** — shows your current Pinned state: `◆ pinned · 34 pins · ✓` (or `N to review`, `+N pins just added`, `✗ N broken`, etc.)
- **Command palette** — `Pinned: Review now`, `Pinned: Show status`, `Pinned: List protected behaviors`
- **Click to act** — clicking the status bar opens a terminal with `pinned status`

The extension is intentionally thin: it shells out to the `pinned` CLI for everything. The CLI is the source of truth for state shape.

## Prerequisites

You need the `pinnedai` CLI installed in your repo (or globally). Run:

```bash
npx pinnedai init --auto
```

This sets up Pinned in your repo (config, hooks, rules file). After that, this extension lights up automatically.

## Works with

- **VS Code** + GitHub Copilot
- **Cursor** (it's a VS Code fork; this extension works natively)
- **VS Code** + Cline / Continue / Codeium
- Any VS Code-family editor

## Configuration

| Setting | Default | What it does |
|---|---|---|
| `pinnedai.statusBar.enabled` | `true` | Show the status bar item |
| `pinnedai.statusBar.refreshIntervalSeconds` | `10` | How often (sec) to refresh |
| `pinnedai.binaryPath` | `""` (auto) | Custom path to the pinned binary |

## Status bar states

| You see | Meaning |
|---|---|
| `◆ pinned · 34 pins · ✓` | Clean working tree, all pins verified |
| `◆ pinned · 34 pins · 3 to review` | 3 Pinned-relevant files uncommitted |
| `◆ pinned · 34 pins · active editing` | Uncommitted edits, none match Pinned's patterns |
| `◆ pinned · +2 pins · 36 total` | Auto-protect just added pins (2-min transient) |
| `◆ pinned · 🛟 caught 1 break` | A regression was just caught (30-min transient) |
| `◆ pinned · ✗ 1 broken` | A pinned test is failing — needs attention |
| `◆ pinned · ⚠ N risks` / `+N suggested` / `⚠ N notes` | Actionable findings — see `pinned status` |

See the [full docs](https://pinnedai.dev) for the complete state model.

## License

Apache-2.0. Source at [github.com/pinnedai/pinnedai](https://github.com/pinnedai/pinnedai).
