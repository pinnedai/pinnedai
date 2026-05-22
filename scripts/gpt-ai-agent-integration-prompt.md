# GPT prompt — AI agent integration failure modes

> Copy-paste into a fresh GPT-5 / Claude Opus session. Goal: find every way Claude Code / Cursor / Copilot / Aider / Zed / other AI agents could behave WRONG when interacting with Pinned, even though our docs explicitly authorize the behavior.

---

## Background

Pinned's pitch hinges on AI coding agents using it correctly on the user's behalf. We invested significantly in agent-friendly affordances:

1. **The `--from-agent="<consent>"` flag** on `pinned init` — captures the user's consent text to `~/.config/pinnedai/install-prefs.json`
2. **Multi-tool rule install** — `pinned init --auto` writes the Pinned rule block to ALL of: `CLAUDE.md`, `.cursorrules`, `.clinerules`, `AGENTS.md`, `.github/copilot-instructions.md` (whichever exist)
3. **AGENT.md** — auto-written to `tests/pinned/AGENT.md`. Contains explicit authorization clause telling the AI it CAN run daily-loop commands (baseline / generate / test / status / show / retire) without re-asking. Also lists destructive operations that DO require fresh consent.
4. **Postinstall message** — printed by `npm install pinnedai`. Explicitly tells AI agents to use `npx pinnedai init --auto --from-agent="<user's exact consent phrase>"` as the authorized non-interactive install path.
5. **Statusline** — bottom-bar indicator. Claude Code reads `.claude/settings.json` to wire it. VS Code extension provides it for Cursor / VS Code / Copilot users.
6. **Chat-hook** — when a pin fails, injects a multi-line message into the next chat prompt naming the bad_case, the test file, and the recommended fix. Tells the AI to "do NOT delete or weaken pinned tests."

We've already audited: idempotent multi-rule-file writes, --from-agent audit-trail write, chat-hook format, statusline state precedence, AGENT.md content.

## What we want from you

Find **specific failure modes** where an AI agent does the wrong thing — either taking action it shouldn't, or refusing to take action it should. For each:

1. **Scenario** — concrete sequence (user prompt → agent behavior → undesired outcome)
2. **Why the agent did the wrong thing** — what in our docs / setup misled it, or what was missing
3. **Severity** — CATASTROPHIC (silent data corruption / deleted pins / weakened tests) / HIGH (loud failure but agent didn't recover) / MEDIUM (annoying friction) / LOW (cosmetic)
4. **Mitigation** — exact wording change in AGENT.md / README / postinstall message / chat-hook

Bias toward **silent agent misbehavior** — actions the user doesn't notice until much later.

### Probe these specific areas

**Agent refusal patterns** (the original problem we tried to fix):
- User asks "set up pinnedai in this repo." Agent reads README, sees the install command, but refuses because it modifies the repo. (We added explicit authorization in 3 places: postinstall, README, AGENT.md. Is it enough?)
- User asks "run pinned baseline." Agent reads AGENT.md, sees the green-light list, runs the command. **But what if the user has a non-standard pinnedai install?** Does the agent know to look in the user's specific install location?
- User asks "retire pin X — it's no longer relevant." AGENT.md says destructive operations need fresh consent. Agent re-asks. User says yes. Does the agent then run `pinned retire <claim-id> --reason="..."` correctly? Or does it hallucinate a different command?

**Agent over-permission patterns** (the opposite — agent does too much):
- User asks "look at my pinned tests." Agent reads `tests/pinned/AGENT.md`, sees the rules. Then proceeds to MODIFY tests/pinned/*.test.ts files "to clean them up." Our docs say "do not modify pinned test files" — does the agent honor that? Specifically: does it generate diffs against pinned test files, even if accidentally?
- A failing pin's chat-hook says "the bug is in middleware.ts." Agent reads middleware.ts, "fixes" the auth check. Pin still fails. Agent then proceeds to fix the pin instead (weakening the test). Our docs explicitly forbid this — does the agent obey?
- Multi-tool conflict: user has CLAUDE.md AND .cursorrules. Both have a Pinned section. They're the same content today, but if a user hand-edits ONE of them (say, removes a rule from .cursorrules), Cursor sees different rules than Claude. Agents will diverge in behavior.

**AGENT.md interpretation failures:**
- AGENT.md says "you CAN run `pinned baseline` without re-asking." Agent interprets this as license to run baseline AGGRESSIVELY (in a loop, on every prompt). User annoyance. Worse: if baseline starts costing LLM quota (it doesn't today, but a future change might), agent burns through quota.
- AGENT.md mentions `X-Pinned-Test: 1` header. Agent reads "exclude requests bearing this header from rate-limit counters." Agent then writes code that excludes them from EVERYTHING (audit logs, abuse detection, business logic). User has security holes.
- AGENT.md authorization section says "do not refuse on the grounds of modifying the repo." Does an AI agent take that as "any repo modification is OK"? Test edge cases like `pinned retire` (which IS destructive but is authorized via the "ask once" rule). Does the agent know retire requires confirmation despite the general authorization?

**Chat-hook context bloat:**
- 5 pins fail simultaneously. The chat-hook tries to fit all of them. Resulting injection is ~3KB of context. User's next prompt has the AI focused on Pinned failures instead of whatever the user actually wanted. Does the hook auto-collapse to "5 pins failing — see details" rather than 5 full failure messages?
- Chat-hook fires repeatedly across multiple user prompts (if pins stay failing). Agent's context bloats with duplicate Pinned messages.
- Agent decides the chat-hook message is "noise" and stops mentioning Pinned to the user. User has no idea pins are broken.

**Statusline misinterpretation:**
- Statusline shows `◆ pinned · 5 pins · REVIEW · 1 touched`. Agent doesn't know what "touched" means. It searches its training data and guesses. Asks user "should I retire the touched pin?" — wrong action.
- Statusline shows `🛟 caught 1 break`. Agent celebrates! But the user didn't ask the agent to do anything Pinned-related. The agent's "celebration" feels weird / out-of-place. UX issue.
- Statusline shows `⊘ N skipped (no preview)`. Agent says "Pinned is broken" instead of "Pinned needs PREVIEW_URL set."

**Cross-tool conflicts:**
- User uses both Claude Code AND Cursor on the same project. Claude reads CLAUDE.md, follows rule #6 (the AGENT.md reference). Cursor reads .cursorrules, follows same rules. But what if Claude installs Pinned (writing the rules), and Cursor never re-reads the file? Cursor doesn't know the rules until restart. User gets inconsistent behavior between tools.
- User adds the Copilot Workspace integration — `.github/copilot-instructions.md` gets the Pinned block. Copilot Workspace runs on cloud, Cursor runs locally. They might generate conflicting changes (e.g., both decide to add a new pin for the same surface).

**Day-zero verify confusion:**
- User runs `pinned generate` with `--from-agent` flag. Day-zero verify runs. Test FAILS (legit catch — the PR's claim doesn't match reality). Agent reads the failure message. Does it correctly tell the user "your code doesn't match your PR claim — fix the code OR retract the claim"? Or does it default to "fix the test"?
- Day-zero verify times out or skips. Agent reports back to user "I added the pin." User assumes it's verified. Three weeks later, the pin fails in CI and the user is confused (because the agent never mentioned the day-zero skip).

**Consent-text spoofing:**
- An adversarial AI agent (or a confused one) passes `--from-agent="user said yes"` even though the user never explicitly consented. The audit trail captures the false consent. Future support / compliance reviewer sees a fake consent record.
- The `--from-agent` value should be the USER's literal words, not paraphrased. Does AGENT.md make this clear?

**LLM cost / quota waste from agents:**
- An AI agent runs `pinned scan-pr <url>` in a loop "to monitor for changes." Each scan hits `gh pr view` (cheap) + scan-diff (free, regex-only). But if scan-pr in the future fans out to a Worker LLM call... agent's loop burns quota.
- Agent calls `pinned generate` redundantly — once for each claim in a PR description, instead of once with the full description. Each call is a separate LLM round-trip. Does AGENT.md make the right pattern clear?

**Multi-instance / parallel agent races:**
- User opens Cursor and Claude Code in the SAME project. Both AIs respond to "set up pinnedai." Both try to run `pinned init --auto` concurrently. Race condition on file writes. Last-writer-wins — but does either AI detect the conflict?
- A Cursor AI and a Copilot Workspace AI both react to a CI failure. Both inject chat-hook messages. Both attempt to fix. Conflicting commits.

## Output format

Numbered list, severity-sorted. For each:

- Concrete user prompt + agent's wrong response
- What in our docs misled the agent (or what was missing)
- Specific docs-or-code change to fix

**Bonus**: identify 3 "highest-confidence agent failure patterns" — scenarios where 9 out of 10 AI agents would fail without our specific docs guiding them. We want to make sure those are bulletproofed.
