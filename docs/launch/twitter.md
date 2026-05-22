# Twitter/X launch thread

> **Status**: Draft. Proofread before posting.
> **Best time**: Tuesday-Wednesday 10am-1pm ET (X dev-Twitter peak).
> **Length**: 8 tweets. First 3 carry the pitch, rest are demo+links.

---

## Tweet 1 (hook)

Built a thing.

AI writes the code. Pinned makes sure it keeps working.

PR description = the test. Forever.

🧵👇

---

## Tweet 2 (problem)

Every PR Cursor or Claude Code opens contains a claim:
- "rate-limits /api/users to 60/min"
- "auth required on /api/admin"
- "makes the webhook idempotent"

True at merge. Quietly false 6 months later when the next AI refactor moves the middleware.

No alarms. Just broken contracts.

---

## Tweet 3 (the slot)

The AI-coding stack today:

1. Cursor / Claude Code writes the code
2. CodeRabbit / Copilot reviews it
3. ??? converts important claims into tests
4. CI enforces them forever

Pinned fills slot 3.

It's not "better CodeRabbit." It's the artifact CodeRabbit doesn't leave behind.

---

## Tweet 4 (immediate value, not insurance)

The trap I want to avoid: positioning this as "future regression insurance."

Bad: "Maybe one day this'll catch a bug."

Better:

```
$ npx pinnedai baseline
Found 12 candidate pins in your repo:
  • /api/admin/export — no auth pin
  • /webhooks/stripe — no idempotency pin
  • ... 10 more
```

Immediate value. Today.

---

## Tweet 5 (demo)

```
$ npx pinnedai

> Sample PR claim: "Rate-limits /api/users to 60 req/min."
> Parsed claim: rate-limit /api/users → 60/minute
> Generated: tests/pinned/pr-1247-rate-limit-...test.ts
> Run vitest → asserts ≥1 of 61 burst requests returns 429
```

Zero config. The LLM extracts the slot values, never writes the test.

---

## Tweet 6 (architecture)

Key decision: LLM never writes test logic.

It only fills slots in deterministic templates: route, rate, window, idField.

So the generated tests are:
- Predictable
- Fast (no LLM at test time)
- Auditable (security teams demand this)

8 templates today: web routes + CLI tools + library functions.

---

## Tweet 7 (free tier)

Free tier:
- Unlimited pins
- 500 LLM calls/mo on public repos
- 100/mo on private repos
- Optional BYOK (use your own Anthropic/OpenAI key)
- OIDC-keyless onboarding — no API key, no signup

CodeRabbit got there by being generous at launch. Same playbook.

---

## Tweet 8 (CTA)

Try it:

```bash
npx pinnedai
```

Code: github.com/pinnedai/pinnedai (Apache 2.0)
Live: pinnedai.dev
npm: pinnedai

Built solo. Feedback wanted on what template family to add next — async function returns? DB schema invariants? Perf budgets?

🙏

---

## After-post checklist

- [ ] Pin the thread to profile
- [ ] Cross-post the demo tweet (#5) as a standalone with a video screencap
- [ ] Reply to every "looks interesting" with a specific question to drive engagement
- [ ] Bookmark accounts that engage — those are the design-partner candidates
