# Show HN draft

> **Status**: Draft. Proofread before posting.
> **Best time to post**: Tuesday-Thursday, 9-11am ET (highest HN traffic).
> **Avoid**: Friday afternoon, weekend, holidays.

---

## Title (HN allows 80 chars; use ~60)

**Option A** (Recommended — clearest value prop):
> Show HN: Pinnedai – AI writes the code. Pinned makes sure it keeps working.

**Option B** (more technical):
> Show HN: Turn PR claims into permanent CI tests (for the AI-coding era)

**Option C** (more provocative):
> Show HN: AI reviewers leave comments. Pinned leaves tests.

---

## Body

Hey HN,

I built pinnedai because every PR my Cursor / Claude Code workflow opens contains a claim — "rate-limits /api/users to 60/min", "auth required on /api/admin", "makes the webhook idempotent on event_id" — and I had no way to verify those claims kept holding six months later.

Pinned converts PR description claims into permanent CI tests. The pin lives in `tests/pinned/<id>.test.ts` in your repo. When a future commit (probably from another AI tool) silently breaks the contract, CI fails with a back-reference to the original PR and a paste-ready prompt for Cursor / Claude Code to fix it.

**The slot it fills:**

1. Cursor / Claude Code writes the code
2. CodeRabbit / Copilot reviews it
3. **Pinned converts important claims into tests** ← we live here
4. CI enforces them forever

It's not "better CodeRabbit." It's the artifact CodeRabbit doesn't leave behind.

**The architecture decision that matters:** the LLM never writes test logic. It only extracts structured `Claim` objects (route + rate + window, etc.) from PR descriptions and fills slots in deterministic templates. This means the generated tests are predictable, fast, and don't require LLM calls at test time. The Cloudflare Worker only fires during `pinned check`/`generate` — once a pin is committed, it's just Vitest.

**Try it in 60 seconds:**

```bash
npx pinnedai           # zero-config demo
npx pinnedai init      # scaffold the workflow in your repo
npx pinnedai baseline  # find unprotected promises today (typically 8-12 on a real Next.js repo)
```

**What it works on right now:**

- Web routes (rate-limit, auth-required, idempotent)
- CLI tools (output-contains, exits-zero, creates-file, flag-supported)
- Libraries (function-returns)

That covers ~95% of AI-generated code domains. Working on a Bug Scout v0.2 that flags claims about *missing* protections (e.g. "this endpoint takes user input but no input-validation claim is present").

**Pricing:**

- Free: unlimited pins, 500 LLM calls/mo public repos, 100/mo private repos
- Pro $19/mo: 5,000 calls/mo, optional BYOK (Anthropic/OpenAI) for compliance/privacy
- Team/Enterprise: org policies, audit log, SOC 2 evidence export

The free tier exists for the same reason CodeRabbit / Snyk / SSL Labs were generous at launch — we want to win mindshare. There's an aggregate cost cap on the Worker so growth doesn't bankrupt me (I'm solo).

**v0.2 plan to get curious about:** instead of a hard cap when the aggregate free-tier budget hits, overflow routes to a self-hosted Llama on a GPU desktop in my apartment via Ollama + Cloudflare Tunnel. Per-call cost ~$0. Free tier never truly cuts off — quality and latency just degrade. Pro stays on OpenAI premium. Building it post-launch once I see real usage data.

**What I'd love feedback on:**

- The repair-prompt loop (paste failing test into Cursor → AI fixes it → commit → CI passes). Is this actually useful for you, or are you mostly past the "paste into chat" workflow?
- Templates we're missing. We have 8 across web/CLI/library — what's the next one? (Async function returns? Database schema invariants? Performance budgets?)
- The compliance / SOC 2 framing. Is "your PR claims become runnable change-management evidence" a real angle for compliance-driven teams or is that aspirational?

**Code**: https://github.com/pinnedai/pinnedai (Apache 2.0)
**Demo**: https://pinnedai.dev
**npm**: https://www.npmjs.com/package/pinnedai

Built as a solo founder with AI tooling. Happy to dig into any of the architecture pillars — split repo (CLI public, Worker private), OIDC-keyless onboarding, content-hash cache that absorbs PR sync events, the per-bundle GPT review system, etc.

— Michael

---

## After-post checklist

- [ ] Posted at peak time (9-11am ET, Tue-Thu)
- [ ] First 10 minutes: respond to every comment within 5 minutes
- [ ] Don't argue. Listen, acknowledge, build trust.
- [ ] Update README + landing within 24h based on top concerns
- [ ] If it gets front-page traction, prep for spike in `pinned init` traffic — verify Worker scales
