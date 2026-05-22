# dev.to post draft

> **Status**: Draft. Proofread before posting.
> **Platform**: dev.to (technical audience, friendlier than HN)
> **Tone**: tutorial-shaped — show, don't tell

---

## Title

**Recommended**:
> How I made my AI-coded PRs prove their own claims (and saved myself from future regressions)

**Alt**:
> Turn every PR description into a permanent test — a tool I built solo with AI

---

## Tags

`#javascript #ai #testing #devops #github`

---

## Cover image

Screenshot of a PR with a description like:
> "Rate-limits /api/users to 60 req/min."
> "Auth required on /api/admin/export."

And the bot comment showing the generated test files.

---

## Body

Every PR I open with Cursor or Claude Code contains claims. "This rate-limits the users route." "This adds auth to the admin export." "This makes the webhook handler idempotent." They're true at the moment I merge them.

Six months later, when I (or my next AI tool) refactor through that code, those claims silently break. No alarm. No failing test. Just a customer complaint three weeks later.

So I built pinnedai. The PR description IS the test.

## What it does in one paragraph

You write a claim in your PR description. The Action parses it into a structured object (`{template: "auth-required", route: "/api/admin/export"}`), generates a Vitest file that verifies the claim against your preview deployment, and commits that test file to `tests/pinned/<id>.test.ts`. Forever. The next time someone (or some AI) breaks the claim, CI fails with a back-reference to the original PR and a paste-ready repair prompt for Cursor / Claude Code.

## Get value in 60 seconds, not after some future regression

That last sentence used to be Pinned's whole pitch. It was a bad pitch — it sounds like insurance against a problem that hasn't happened yet. Here's the better framing:

```bash
npx pinnedai baseline
```

This walks your repo, finds risky promises that **aren't currently tested**, and suggests pins. On a typical Next.js or Hono app it finds 8-12 candidates immediately:

```
Found 12 candidate pin(s) in your repo:

  • Risk-surface: route /api/admin/export found in app/api/admin/export/route.ts
    Suggestion: "Auth required on /api/admin/export."

  • Risk-surface: webhook /webhooks/stripe found in app/api/webhooks/stripe/route.ts
    Suggestion: "Makes /webhooks/stripe idempotent on event_id."

  • Risk-surface: middleware change detected in middleware.ts
    Suggestion: Pin any auth claims this middleware enforces.

  ... (9 more)
```

That's the immediate value. Future-regression protection is a free bonus.

## The architecture decision that mattered most

**The LLM never writes test logic.** It only extracts structured `Claim` objects from PR descriptions, filling slots in deterministic templates. So the test files are predictable, deterministic, and don't require LLM calls at test time.

Why this matters: most "AI generates tests" tools have you trust an LLM to write code. If it hallucinates, you have a broken test you'll spend hours debugging. Pinned's templates are hand-written; the LLM just figures out which one applies and what the slot values are.

The 8 templates we ship at v0.1.0:

| Domain | Template | Verifies |
|---|---|---|
| Web | `rate-limit` | Bursts N+1 requests, asserts ≥1 returns 429 |
| Web | `auth-required` | Single GET without auth, asserts 401/403 |
| Web | `idempotent` | POSTs same payload twice, asserts byte-identical response |
| CLI | `cli-output-contains` | Spawns command, asserts substring in stdout |
| CLI | `cli-exits-zero` | Spawns command, asserts exit code 0 |
| CLI | `cli-creates-file` | Spawns in tempdir, asserts file exists |
| CLI | `cli-flag-supported` | Runs `<cmd> --help`, asserts flag documented |
| Library | `library-returns` | Imports function, calls, JSON-deep-equals return |

## The slot in the AI-coding stack

There's a real slot to fill:

```
Cursor / Claude Code writes the code
CodeRabbit / Copilot reviews it
Pinned converts important claims into tests   ← we live here
CI enforces them forever
```

AI reviewers leave comments. Pinned leaves tests that protect your current code from future AI errors.

It's complementary to CodeRabbit, not a replacement. They review *this* PR; we test *every future* PR against the claims of *this one*.

## How I built it solo with AI tooling

- **Monorepo**: pnpm workspaces, three apps (CLI / Worker / landing page). Public mirror via a fail-closed sync script.
- **CLI**: TypeScript ESM, Commander, tsup for bundling, vitest for tests.
- **Worker**: Cloudflare Workers + D1 (SQLite at edge), hand-rolled JWT validator against GitHub's JWKS for OIDC-keyless onboarding.
- **Landing**: Vite + React with a `pinnedai` import alias mapping to the actual CLI source — so the live demo on the landing page runs the exact same parser code that ships in the npm package.
- **Code review**: every code bundle goes through GPT review against pre-articulated security specs. Per-bundle version tracking, BLOCKING/NICE-TO-HAVE severity tiers. Catches issues a solo founder can't catch alone.

The Worker is closed-source (the system prompt and detection rules are the IP). Everything that runs in the customer's CI is Apache 2.0 — security teams demand auditability.

## Try it

```bash
npx pinnedai              # zero-config demo
npx pinnedai init         # scaffold workflow in your repo
npx pinnedai baseline     # find unprotected promises NOW
```

- Code: https://github.com/pinnedai/pinnedai
- Live: https://pinnedai.dev

Would love feedback on what templates you'd want next. The architecture is set up so adding a template family (say, "async function returns" or "database schema invariant") is ~200 lines plus tests.

— Michael
