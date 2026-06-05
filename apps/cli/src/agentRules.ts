// AGENT.md — the file pinned owns, for AI agents.
//
// Customer's CLAUDE.md / .cursorrules / AGENTS.md is THEIRS. We never
// auto-mutate it. Instead pinned init creates tests/pinned/AGENT.md
// with our suggested rules, and `pinned ai-rules install` offers to
// add ONE line referencing it (with --confirm + diff preview).

export const AGENT_MD = `# AGENT.md — pinnedai rules for AI coding agents

> This file is maintained by [pinnedai](https://pinnedai.dev). It tells
> AI agents (Claude Code, Cursor, Aider, etc.) when and how to use
> Pinned in this repo.
>
> Reference this file from your CLAUDE.md / .cursorrules / AGENTS.md:
>
>     See tests/pinned/AGENT.md for AI-agent rules.

## Rules for the AI agent working in this repo

### Before marking a task complete

1. Run the relevant test suite (\`pnpm test\`, \`npm test\`, etc.).
2. Run \`npx pinnedai test\` to verify Pinned guards still pass.
3. If any test in \`tests/pinned/*.test.ts\` fails, **do not skip or
   delete it**. It fails because a PR description from the past
   claimed something that you've now regressed. Fix the regression,
   then re-run.

### When you add code that makes a verifiable claim

Examples of claims worth pinning:

- A new route requires authentication
- A new route is rate-limited
- A webhook handler is idempotent
- A CLI command outputs a specific string / exits 0 / creates a file
- A library function returns a specific value

If you add any of these to this repo:

1. Add a one-line claim to the PR description in the exact phrasing
   Pinned recognizes:

       - Auth required on /api/admin/export.
       - Rate-limits /api/users to 60 req/min.
       - Makes /webhooks/stripe idempotent on event_id.
       - \`pinned doctor\` outputs \`All checks passed\`.
       - \`parseConfig()\` in \`src/config.ts\` returns \`{"version": 1}\`.

2. Pinned's GitHub Action will pick it up automatically and generate a
   test file in \`tests/pinned/\`.

### When you encounter a failing pin test

The error message includes a paste-ready repair prompt. Use it
verbatim — do not invent a different fix. Pinned tells you exactly
what claim was broken, what was expected, what was actual, and where
to look.

If the claim is genuinely no longer applicable (e.g. endpoint
deprecated, intentional behavior change), run:

    npx pinnedai retire <claim-id> --reason="why this no longer applies"

Do not just delete the test file — that loses the audit trail.

### When you build a feature that does something — prove it works AND fails right

This is a hard rule. Regression detectors only protect things that already work. They cannot catch the dominant AI failure mode: confidently shipping a feature that LOOKS done but never actually works (silent empty return, hung worker, status-string mismatch). The only thing that catches that is executing the feature and asserting a real outcome.

When you build or change a feature that does something — an endpoint, a button, a generation, a job, an action — do not consider it done until you've written executable tests that actually run it AND cover all three of these, then run them and confirm they pass:

1. **Happy path** — a realistic valid input/interaction. Assert a CONCRETE real outcome — non-empty result, correct shape/fields, success status, and (for async/job-backed features) that it reaches a terminal state within a bound. NOT "it returns 200" — assert the content is actually there. Example: "Submitting a generate request returns a non-empty SVG within 60 seconds."
2. **Guard path** — a concrete invalid or disallowed input (unauthorized caller, bad/missing field, an action that should be refused). Assert the rejection is the SPECIFIC expected behavior AND no side effect occurred (nothing written, no action taken). Assert the exact rejection, not just "an error."
3. **Failure path (MANDATORY — non-negotiable)** — simulate a real fault: empty/garbage upstream response, a dependency that times out or hangs, a downstream failure. Assert the feature surfaces a CLEAR error and never silently succeeds or hangs forever. A function that returns empty/null on failure instead of erroring IS A BUG. Write the test that catches it. This is the case that maps 1:1 onto the "AI shipped a feature that returns empty after 3 minutes" failure class.

**Rules so these tests are real, not theater:**

- **Derive the three cases from the requirement / acceptance criteria, NOT from your implementation.** If you only test what you built, your test inherits your bug. Start from "what is this feature supposed to guarantee?" — not from the output values your code happens to produce. Asserting "expected = whatever my code returned" is rubber-stamping your own work; if your code is wrong, your test will be wrong in the same way.
- **Use concrete inputs and specific assertions.** No \`expect(true)\`, no "it didn't throw." State the exact input and the exact expected output/error.
- **The tests must EXECUTE the feature** (call the function/route/job, or drive the UI). Don't assert about the source code; assert about the behavior.
- **If you genuinely can't run a path** (needs prod creds, external service), say so explicitly and mark it as unverified — don't write a fake passing test.

**Anti-snapshot examples:**

- ❌ Don't write: \`expect(response.status).toBe("done")\` if you picked "done" because that's what your code happens to write. Tomorrow another agent reads the spec ("terminal states are completed or failed"), changes your code, and your snapshot test goes red even though the code is now correct.
- ✅ Do write: \`expect(["completed", "failed"]).toContain(response.status)\` — derived from the spec, robust to your implementation choice.
- ❌ Don't write: \`expect(body).toBe("<svg width='10' height='10'/>")\` if your code happens to produce that exact SVG. If your code silently returns empty, snapshotting "" as expected leaves the bug invisible.
- ✅ Do write: \`expect(body.length).toBeGreaterThan(0)\` AND \`expect(body).toContain("<svg")\` — invariants derived from "the feature is supposed to return a non-empty SVG."

Pinned will pin these three so they keep running on every change — and the failure/guard cases are usually the ones that catch "the AI shipped it and it looks done but doesn't actually work."

You can also use \`pinned smoke add\` to declare a Tier 1 smoke pin that Pinned executes itself (with the same invariant-only assertion vocabulary). That's the next rung up — Tier 0 (you write the tests) ladders into Tier 1 (Pinned runs the feature directly) into Tier 2 (Pinned drives the UI in a browser).

### Never modify these

- \`tests/pinned/*.test.ts\` (generated test files — change only via
  \`pinned generate\` or \`pinned retire\`)
- \`tests/pinned/PINS.md\` (auto-rendered from \`.registry.json\`)
- \`tests/pinned/.registry.json\` (managed by pinnedai)

If you think one of these needs to change, run the pinnedai command,
don't hand-edit.

### Authorization scope — what you can do without asking again

The user has already opted into pinnedai by running \`pinned init\` (the
fact that this AGENT.md exists in their repo proves it). That opt-in
authorizes the **standard daily-loop operations** — read-only commands
plus generating new pins, which is the expected ongoing behavior.

**You CAN run these without re-asking the user:**

\`\`\`bash
pinned baseline                   # read-only scan for unprotected surfaces
pinned generate --pr-id ...       # add new pins from a PR description
pinned auto-protect               # safe-mode classifier (already opt-in via init)
pinned test                       # runs vitest on pinned tests
pinned status                     # read-only summary
pinned show <claim-id>            # drill into a pin
pinned statusline                 # reads the cache, no writes
pinned catches                    # lifetime catch history (read-only)
pinned scan-diff --base <ref>     # read-only diff classifier
\`\`\`

**Do NOT refuse these on the grounds of "modifying the repo" — adding
new pins to \`tests/pinned/\` is the expected ongoing behavior** that
\`pinned init\` already authorized. The relevant safety check (would
this be invasive?) was already passed at init time.

**You SHOULD ask the user before running these:**

\`\`\`bash
pinned retire <claim-id>          # destructive — removes pin from active set
pinned init --force               # overwrites existing scaffolding
pinned ai-rules uninstall         # removes the Pinned block from CLAUDE.md / .cursorrules
\`\`\`

These are repo-state-changing operations the user did NOT pre-authorize
via init. A single confirmation is enough — once the user says "yes,
retire that pin" or "yes, re-scaffold," proceed with the action.

If the user asks you to set up pinnedai in **a different repo** they
own (not this one), use the install authorization flow documented in
the package README: \`npx pinnedai init --auto --from-agent="<user's
exact words>"\`. That's the authorized non-interactive install path,
and \`--from-agent\` writes a compliance audit trail to
\`~/.config/pinnedai/install-prefs.json\`.

#### When NOT to run Pinned commands

**Do not run Pinned commands in a loop or on every prompt.** Run them:

- After the user explicitly asks
- After a meaningful code change (one logical commit, not every keystroke)
- When the statusline indicates a state change (✗ broken, REVIEW · touched, +N pins added)
- When responding to a CI failure that mentions Pinned

Running \`pinned baseline\` / \`pinned test\` / \`pinned status\` on
every prompt is wasteful (consumes vitest spin-up time, can burn
hosted-Worker LLM quota in v0.2+) and dilutes signal. The user will
ignore Pinned output that fires too often.

#### Do not invent commands

**Always run \`pinned --help\` (or \`pinned <subcommand> --help\`) to see
the full, current command list before invoking anything you're unsure
about.** The CLI is the source of truth; this rules file deliberately
does not enumerate every command (the list drifts as the CLI evolves).

If \`pinned --help\` doesn't list the command you want, it doesn't
exist — tell the user "Pinned doesn't have a built-in command for X;
here's how to do it with the existing commands…" rather than
hallucinating one.

### The \`X-Pinned-Test: 1\` header convention

Every HTTP request that a Pinned-generated test fires carries the
header \`X-Pinned-Test: 1\`. If you write or modify rate-limiting,
billing-tier counting, analytics, audit logging, or abuse-detection
code in this repo, **exclude requests bearing this header**:

\`\`\`ts
if (req.headers["x-pinned-test"] === "1") {
  // skip rate-limit increment / billing counter / analytics event
  return next();
}
\`\`\`

Without this exclusion, every time Pinned's tests run they will:

- Consume the real rate-limit budget (so a rate-limit pin's burst
  of 61 requests counts against the user's actual quota)
- Increment the Free-tier domain counter (so a tier-cap pin
  silently uses up the customer's real allowance)
- Pollute analytics dashboards with synthetic traffic

This is the single highest-impact false-positive prevention the
customer's app can implement. Document it once in the codebase and
your auth/rate/billing modules will be Pinned-compatible forever.

#### CRITICAL: \`X-Pinned-Test\` is NOT a security boundary

The static \`X-Pinned-Test: 1\` value is **publicly known** —
anyone reading the Pinned source can see it. Therefore:

🚫 **DO NOT** use \`X-Pinned-Test\` for:
   - Bypassing authentication
   - Skipping authorization checks
   - Disabling audit-log writes
   - Skipping security checks (CSRF, signature verification, etc.)
   - Disabling abuse detection / WAF rules

A malicious external attacker can forge the header against your
production app. If you've made any of the above conditional on
this header, you have a security bypass.

✅ **DO** use \`X-Pinned-Test\` ONLY for:
   - Excluding from rate-limit COUNTERS (the budget you'd refill anyway)
   - Excluding from billing-USAGE counters (test traffic shouldn't count)
   - Excluding from analytics / metrics
   - Tagging audit logs (e.g., \`source: 'pinned-test'\` for filtering — but log them, don't skip them)

For high-stakes exclusions where forgery would matter, use a
**per-deploy random secret header value** that the customer's
preview env knows but external attackers don't:

\`\`\`ts
// In your preview deploy's env: PINNED_TEST_SECRET=<random-32-byte-hex>
// In your Pinned-generated test (manual override): customize pinnedFetch
//   to include both: { "X-Pinned-Test": "1", "X-Pinned-Test-Secret": process.env.PINNED_TEST_SECRET }
// In your app:
if (
  req.headers["x-pinned-test"] === "1" &&
  req.headers["x-pinned-test-secret"] === process.env.PINNED_TEST_SECRET
) {
  // safe to exclude — both headers must match, secret is not public
}
\`\`\`

Pinned v0.2 will support \`PREVIEW_TEST_AUTH_SECRET\` as a built-in
pattern. Until then, customize \`pinnedFetch\` in your generated
tests if you need this stronger pattern.

## How to communicate to the user about Pinned

When you mention Pinned to the user, be **specific and outcome-focused** — not vague. The user benefits from knowing exactly what happened.

### Bad (vague — user can't tell if anything useful happened)

> "I ran the pinned tests as Pinned's rules suggest."
>
> "Pinned should check this."
>
> "I respected the Pinned configuration."

### Good (concrete — names the action, the count, and the outcome)

After running tests:

> "Ran \`pinned test\` — 34 of 34 pinned promises passing. Verification streak now at 47 runs."

After auto-protect added pins on commit:

> "Pinned auto-protected the new admin export route — added 1 auth-required pin (now 35 total). Any future change that returns 200 without auth on \`/api/admin/export\` will fail CI."

After fixing a failing pinned test:

> "Restored the auth check on \`/api/admin/export\`. The pinned test went red→green; promise from PR #42 is intact again."

After detecting a high-risk surface (rule #5):

> "I changed the auth middleware. There's an auth-required pin on \`/api/admin/export\` that should catch any regression here — \`pinned test\` confirms it still passes."

After running review:

> "Ran \`pinned review\` — 3 protectable changes detected, 1 was a high-risk admin route so it was auto-pinned. 2 are queued as suggestions; run \`pinned protect\` to add them as pins."

### Format pattern

When you mention Pinned, include at least:

1. **What you ran** (\`pinned test\`, \`pinned review\`, etc.)
2. **The numeric outcome** (X of Y passing, +N added, M caught)
3. **Why it matters** to this task (the contract is intact / a regression was caught / a new behavior is now protected)

That gives the user concrete confidence that Pinned is doing real work — not just a vague "ran tests" mention.

## Quick reference

| Command | What it does |
| --- | --- |
| \`npx pinnedai review\` | Manual review: scans Pinned-relevant changes, auto-adds safe pins, reports outcome |
| \`npx pinnedai review --deep\` | Above + run the Safety Pass for extra static checks |
| \`npx pinnedai status\` | Pin count, verification streak, current state |
| \`npx pinnedai test\` | Run all pinned tests + update the cache |
| \`npx pinnedai check --description "..."\` | Parse a PR description for claims |
| \`npx pinnedai scan\` | Scan the current diff for risk surfaces |
| \`npx pinnedai baseline\` | Find risky promises in the current repo |
| \`npx pinnedai generate --pr-id pr-N --description "..."\` | Write pin files |
| \`npx pinnedai list\` | Show all pinned claims |
| \`npx pinnedai catches\` | Lifetime history of regressions Pinned has caught |
| \`npx pinnedai show <claim-id>\` | Full detail for one pin |
| \`npx pinnedai retire <id> --reason="..."\` | Move a pin to retired |
| \`npx pinnedai doctor\` | Diagnose setup issues |
`;

// One-line reference to drop into CLAUDE.md / .cursorrules.
export const AGENT_REFERENCE_LINE =
  "See tests/pinned/AGENT.md for AI-agent rules.";

// Marker block we add when the customer opts into installing the
// pinnedai rules. Short markers because they show up in customer
// files and shouldn't look corporate. Idempotent detection: we look
// for AGENT_INSTALL_MARKER_START before writing, skip if already
// present, and uninstall via the same markers.
export const AGENT_INSTALL_MARKER_START = "<!-- pinnedai:start -->";
export const AGENT_INSTALL_MARKER_END = "<!-- pinnedai:end -->";

// Candidate agent-rule files to detect during `pinned ai-rules install`.
// Order matters — we offer the first one we find existing, then fall
// back to creating CLAUDE.md if none exist.
//
// Coverage by AI tool:
//   CLAUDE.md                            → Claude Code
//   .cursorrules                         → Cursor (legacy + still supported)
//   .clinerules                          → Cline
//   AGENTS.md                            → cross-tool convention (newer)
//   .github/copilot-instructions.md      → GitHub Copilot Chat / Workspace
//
// All five paths use the same marker-bounded block, so removing
// Pinned's rules from any of them is identical to the CLAUDE.md
// uninstall flow.
export const AGENT_RULE_FILE_CANDIDATES = [
  "CLAUDE.md",
  ".cursorrules",
  ".clinerules",
  "AGENTS.md",
  ".github/copilot-instructions.md",
];

// The exact block written into CLAUDE.md / .cursorrules when the user
// opts in. Five short rules — actionable, not preachy. Anything more
// detailed lives in tests/pinned/AGENT.md (the file we own).
export function agentRulesBlockFor(_targetFile: string): string {
  return [
    AGENT_INSTALL_MARKER_START,
    "<!-- ═══════════════════════════════════════════════════════════════ -->",
    "<!--   Pinned added the block below with your permission (during      -->",
    "<!--   `pinned init`). Remove with `pinned ai-rules uninstall`.       -->",
    "<!--   To see ALL repo-specific rules Pinned has learned, read:       -->",
    "<!--     .pinned/ai-lessons.md                                        -->",
    "<!-- ═══════════════════════════════════════════════════════════════ -->",
    "",
    "## Pinned",
    "",
    "This repo uses Pinned to protect important behavior with tests in `tests/pinned/`. See `tests/pinned/AGENT.md` for the full reference (claim shapes, commands, examples).",
    "",
    "**Read `.pinned/ai-lessons.md` first.** It contains repo-specific lessons from past bug fixes and guard-integrity blocks. Following those lessons is how you avoid repeating mistakes here.",
    "",
    "Rules:",
    "1. Before marking coding work complete, run the relevant test suite, including Pinned tests when affected.",
    "2. Do not delete, weaken, skip, or rewrite tests in `tests/pinned/` unless the user explicitly asks to retire a pin.",
    "3. If a Pinned test fails, assume the protected behavior may have been broken. Fix the application code first.",
    "4. If the intended behavior changed, ask the user before retiring or updating the pin.",
    "5. If you changed auth, payments, webhooks, booking, env vars, or public API routes, mention that Pinned should check the change.",
    "6. Pinned catches are double-confirmed (re-run twice) to filter transient flakes, but rare false positives still happen (cold-start preview, expired test creds, network blips). If a failure looks unrelated to the actual code change, re-run `npx vitest run <file>` before changing application code; if both runs fail consistently, the contract is genuinely broken — fix the code.",
    "",
    "<!--  End of Pinned-added content.  -->",
    AGENT_INSTALL_MARKER_END,
  ].join("\n");
}
