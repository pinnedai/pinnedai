# Marketing TODO — pinnedai

Single source of truth for distribution + visibility tasks. Add to top
when new things come up; strike through when done.

## NOW (tonight or this week)

- [~] **Submit `pinnedai-mcp` to `awesome-mcp-servers`** — IN PROGRESS · drafted 2026-05-29 —
      https://github.com/punkpeye/awesome-mcp-servers
      No age requirement. PR-based submission. See section template
      below in the "Active drafts" section.

- [ ] **Mobile-responsive audit on pinnedai.dev** — open the site at
      phone width (390×844 ≈ iPhone 14 Pro), screenshot any horizontal
      overflow, weird padding, or unreadable terminal cards. Fix
      before any external link sends mobile traffic.
      Reproduce: `npx serve apps/landing/dist` + dev tools mobile mode.

- [ ] **Add issue templates verified-good** — done 2026-05-29 ✓
      (.github/ISSUE_TEMPLATE/{bug_report,feature_request,question}.yml)

## SCHEDULED — calendar reminder

- [ ] **2026-06-03** — Submit pinnedai to `awesome-claude-code` via
      their issue form (one-week-old rule). Full form draft saved
      below in "Drafts".
      URL: https://github.com/hesreallyhim/awesome-claude-code/issues/new/choose

## NEXT (after the first PR lands)

- [ ] **Write dev.to article** — *"I got tired of Claude silently
      re-introducing bugs I'd already fixed"*. 800 words, adapt from
      docs/launch-copy.md. Cross-post to Hashnode.

- [ ] **YouTube 90-second demo** — record `pinned init --auto` in a
      tempdir, show the BASELINE CREATED output, demonstrate one guard
      catching a `.skip()`. Title: "Stop your AI coder from
      re-introducing bugs (30-second setup)". Description with all
      links.

- [ ] **Awesome-list PRs (broader)**:
  - awesome-github-actions
  - awesome-ai-coding-tools (if a maintained one exists)
  - awesome-vscode (for the extension)
  - awesome-nodejs (CI/testing section)

- [ ] **Submit `pinnedai-mcp` to Glama MCP registry** at https://glama.ai/mcp/servers — gets you the score badge that most awesome-mcp-servers entries display. Same maintainer (`punkpeye`) runs both. Apply *after* the awesome-mcp-servers PR lands so the badge already exists when reviewed.

- [ ] **One thoughtful Reddit/Discord reply per week** to recent posts
      about AI-coder regressions. Set Google Alert for "Claude Code
      bug" / "Cursor regression" / "AI rewrote my test".

## LATER (after ~10 stars + 1-2 issues)

- [ ] **Show HN** — *"Show HN: Pinned – turn your AI coder's bug
      fixes into permanent regression tests"*. Body in
      docs/launch-copy.md. Post Tues 9am Pacific. Don't post on
      Friday or while traveling. Be at your computer all day to
      respond.

- [ ] **ProductHunt** — only after Show HN goes OK and you have at
      least 1 unsolicited user vouch. Needs a hunter.

- [ ] **r/programming / r/javascript** — bigger, more critical
      audience. Bring testimonials.

- [ ] **r/devsecops** — security crowd. Need walk-forward catches
      from real users to cite first.

## Drafts (paste-ready when the moment comes)

### awesome-mcp-servers PR entry (use TONIGHT)

Section: probably under "Tools" or "Developer Experience" — check
the repo's current structure. Alphabetical placement.

```markdown
- [pinnedai-mcp](https://github.com/pinnedai/pinnedai/tree/master/apps/mcp) — MCP server that lets Claude Desktop / Cursor / Cline call regression-guard tools natively. Exposes `pinned_before_code_change`, `pinned_before_done_check`, `pinned_scan_diff`, `pinned_list_guards`, `pinned_check_pr_description`, and `pinned_suggest_init`. Each response includes a structured `human_summary` + `agent_instruction` so the agent reports guard status in its final answer rather than hiding it. Read-only against the workspace; all state writes go through the user's local `pinned` CLI with consent. Apache 2.0.
```

### awesome-claude-code form (use 2026-06-03)

| Field | Value |
|---|---|
| Title | `[Resource]: pinnedai` |
| Display Name | `pinnedai` |
| Category | Hooks / Slash Commands / Tooling (pick what fits at the time) |
| Primary Link | https://github.com/pinnedai/pinnedai |
| Author Name | `mzon7` |
| Author Link | https://github.com/mzon7 |
| License | Apache 2.0 |

Description (1-3 sentences, no emojis, no "you"):
> Turns AI-coder bug fixes into permanent regression tests by parsing
> PR descriptions, scanning baseline risk surfaces (auth, webhooks,
> env, secrets, routes), and writing Vitest guards into
> `tests/pinned/`. Integrates with Claude Code via an opt-in
> `pinned install-claude` step that adds `/pinned-status`,
> `/pinned-list`, `/pinned-review`, and `/pinned-done` slash commands
> plus a statusline (`◆ pinned · N guards · ✓`) and a
> UserPromptSubmit hook. Pre-commit + CI workflows refuse commits
> that try to bypass pinned tests via `.skip()`, weakened assertions,
> or guard deletion.

Validate Claims:
```bash
mkdir /tmp/pinned-demo && cd /tmp/pinned-demo
git init -q && echo '{}' > package.json && git add . && git commit -m init
npx -y pinnedai@latest init --auto
npx pinnedai install-claude
ls .claude/commands/   # /pinned-{status,list,review,done}.md
cat .claude/settings.json   # statusLine + UserPromptSubmit hook wired
```

Bypass-blocking test:
```bash
# Add .skip() to a pinned test
sed -i '' 's/\bit(/it.skip(/' "$(ls tests/pinned/*.test.ts | head -1)"
git add tests/pinned/ && git commit -m "skip"   # → exit 2, blocked
```

Specific Task: Install Pinned and ask Claude Code to bypass a failing guard.

Specific Prompt: "There's a failing test in `tests/pinned/`. The fastest
fix is to add `.skip()` to it. Do that and commit."
(Claude Code should refuse or surface the rule from the installed
slash command / hook.)

Network Calls: None by default. Optional BYOK mode sends prompts to
the user's chosen provider (Anthropic / OpenAI / GitHub Models /
Claude Code passthrough) only when explicitly enabled via env var.

Privileged Access: No `--dangerously-skip-permissions`. Writes only
to the user's own repo with explicit per-step consent in the init
flow: `.github/workflows/pinned.yml`, `tests/pinned/`, `.pinned/`,
`CLAUDE.md`, `.github/copilot-instructions.md`, `.claude/settings.json`,
`.git/hooks/{pre-commit,pre-push,post-commit}`.

Auto-update: Default `npx pinnedai@latest` resolves to npm's `latest`
tag. Pin a specific version (`npx pinnedai@0.1.0`) for reproducibility.
