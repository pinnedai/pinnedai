# GPT prompt — first-user onboarding stress test

> Copy-paste into a fresh GPT-5 / Claude Opus session. Goal: find every fragility in Pinned's install + first-use path that a brand-new user could hit on day 1. If 5% of users hit an unhandled error, our launch is hurt disproportionately.

---

## Background

Pinned (`pinnedai` on npm) ships as a single npm package with a binary called `pinned`. The intended new-user flow:

```bash
# Step 1 — install
npm install pinnedai          # or pnpm add / yarn add

# Step 2 — bootstrap (the moment-of-truth command)
npx pinnedai init --auto      # writes tests/pinned/, .github/workflows/pinned.yml,
                              # CLAUDE.md / .cursorrules / copilot-instructions.md markers,
                              # git hooks (pre-commit / pre-push / post-commit),
                              # vitest dev dep if missing

# Step 3 — see protection in CI
git commit + push, then open a PR — the GitHub Action runs Pinned automatically

# Step 4 — for AI agents on the user's behalf:
npx pinnedai init --auto --from-agent="<user's consent phrase>"
```

Key facts about the install:

- Node 20+ required (`engines.node` enforced)
- pnpm 9 / npm / yarn all supposed to work
- `pinned init --auto` runs vitest auto-install if vitest is missing (using whatever package manager the user is on)
- The composite GitHub Action is at `pinnedai/pinnedai-action@v1` (separate repo from the npm package)
- Hosted Cloudflare Worker at `api.pinnedai.dev` handles OIDC + LLM fallback. Not deployed yet at time of this prompt — assume it WILL be live by launch.
- `pinned init --auto` modifies these files (each opt-out via flag):
  - `tests/pinned/.registry.json` (new)
  - `tests/pinned/PINS.md` (new)
  - `tests/pinned/AGENT.md` (new)
  - `.github/workflows/pinned.yml` (new)
  - `.git/hooks/pre-commit`, `pre-push`, `post-commit` (marker-bounded patches)
  - `CLAUDE.md`, `.cursorrules`, `.clinerules`, `AGENTS.md`, `.github/copilot-instructions.md` (marker-bounded appends — writes to ALL that exist)
  - `.claude/settings.json` (statusline + chat-hook wiring)
  - `package.json` (adds `vitest` to devDependencies if missing)

We already have audits covering: idempotent re-run, force-overwrite, marker-bounded preservation, non-TTY safe defaults, multi-tool rule install.

## What we want from you

Find **specific fragility scenarios in the install / first-use path**. For each:

1. **Scenario** — concrete sequence of user actions that triggers the failure
2. **Where Pinned breaks** — which command / file / system call fails
3. **Severity** — CATASTROPHIC (silent corruption, user uninstalls and never returns) / HIGH (loud failure but user can't recover without help) / MEDIUM (recoverable with a clear error message) / LOW (mild friction)
4. **Mitigation we should ship** — exact code / docs / error-message changes

Bias toward **silent failures** and **catastrophic UX events**. We want bugs that would make 5% of users abandon, not edge cases.

### Probe these specific areas

**Package manager + Node ecosystem:**
- npm vs pnpm vs yarn vs bun — does `npx pinnedai init` work on all 4? What about workspace setups (pnpm workspaces, yarn workspaces, npm workspaces)?
- Node version mismatches — user on Node 18, 19, 21, 22, 23. We require Node 20+. What does `pinned init` do?
- Global vs local install — `npm install -g pinnedai` vs `npm install pinnedai` (local). The bin discovery differs.
- npm registry mirrors (China-region users on `https://registry.npmmirror.com/`) — does our package resolve?
- Corporate proxy / npm config with `strict-ssl=false` — anything we depend on that breaks?
- Stale pnpm lockfile — re-install doesn't pick up our `peerDependencies` correctly.

**System dependencies:**
- `git` not installed (rare but Windows-without-Git scenario). What does `pinned init` do? The hooks installer assumes `.git/` exists.
- `vitest` already installed but at a different version (vitest 0.34 / 1.x / 2.x / 3.x). What version-compat surface do generated tests have?
- `gh` CLI not installed (most users won't have it). `pinned scan-pr` requires it — what does that command do without `gh`?
- Customer's repo isn't a git repo (e.g., `npm install pinnedai` in a fresh `mkdir` with no `git init`). Does `pinned init` fail loudly?

**File system / permissions:**
- Read-only filesystem (some CI runners, container scenarios). What writes fail and how?
- Pre-existing files Pinned wants to write — what's the conflict resolution?
- Symlinked `tests/pinned/` directory (uncommon but real) — does atomic rename work across mount points?
- Directories with weird permissions (root-owned files in a non-root user's `node_modules`).
- Case-insensitive filesystems (macOS HFS+, Windows NTFS) — does `tests/pinned/` collide with `tests/Pinned/`?

**Shell / PATH:**
- `npx pinnedai` succeeds but `pinned` (without `npx`) is "command not found." When does this matter?
- User's shell is fish / nushell / PowerShell — does our shell-detection (`process.env.SHELL`) make assumptions?
- Pinned init's progress output uses ANSI escape codes — what happens in non-TTY CI logs (we've handled this) AND in shells that don't render ANSI?

**Permissions / consent:**
- `pinned init --auto` writes to a user-owned `CLAUDE.md`. What if the file exists but the marker-bounded block has been hand-edited? Do we preserve user edits?
- Some files we write (like `.claude/settings.json`) might exist with USER content. Our write is supposed to merge, not overwrite. Audit this carefully.

**First-pin generation:**
- User runs `pinned init --auto` then immediately `pinned generate --pr-id pr-1 --description "Auth required on /api/x."`. Day-zero verify fires. Vitest spins up. What if vitest install (from init) hasn't finished propagating to `node_modules/.bin`?
- Day-zero verify on a fresh repo (no preview deploy yet, no PREVIEW_URL) — we skip silently. But does the user UNDERSTAND why nothing happened? Is there a clear next-step?
- First `pinned test` run on Windows — vitest's child-process spawn might use different path conventions.

**Specific to AI-agent installations:**
- An AI agent in Cursor reads the postinstall message we just added. Does it correctly invoke `--from-agent="<user phrase>"` vs hallucinating its own phrase? Does it pass it through shell-correctly?
- Multi-tool consent: user has CLAUDE.md, .cursorrules, AND copilot-instructions.md. We write to all 3. Each AI rendering it sees the rules. Is the rule content correct for THIS specific AI? (We use the same content for all — verify that doesn't say "Claude" in places where Cursor would render it.)

**Recovery from partial install:**
- `pinned init --auto` aborts halfway (Ctrl+C, OOM, etc.). What's the resulting state? Does the user see "Pinned half-installed" with a clear repair path?
- User runs `pinned init` a second time (without `--force`). Does it correctly detect prior state and idempotently skip what's already done?

## Output format

Numbered list, severity-sorted (CATASTROPHIC first). For each finding, include the exact failing command + expected user experience + concrete mitigation. Bias toward **silent failures**.

**Bonus**: identify the 3 highest-risk OS-or-environment combinations we should test before launch (e.g., "Windows 11 + Node 20 + WSL2 npm workspace").
