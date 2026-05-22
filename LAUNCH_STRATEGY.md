# pinnedai launch strategy

> **Distribution playbook for v0.1.** Pair with `LAUNCH_CHECKLIST.md` (the deploy/ops list). This file is the *marketing* layer — channels, sequencing, post copy, budgets.

Last reviewed: 2026-05-19. Update after every channel test produces signal.

---

## The funnel

Forum post / Marketplace / SEO page
↓
Landing at `pinnedai.dev` (demo GIF, install command)
↓
`npx pinnedai init` in customer's repo
↓
First PR with a claim
↓
First pin generated + auto-committed
↓
Upgrade trigger: hit 25-pin cap OR want BYOK OR want priority model

**No individual DMing. No dashboard. No outreach script.** The product sells itself once they see the demo.

## Success metric

**First pin created per install.** If people install but never generate a pin, the docs / parser / templates are unclear — fix that before scaling distribution.

---

## Phase 1: Pre-launch prep (Week 0)

Already in flight via the `LAUNCH_CHECKLIST.md`. Critical artifacts:

- [x] Working `npx pinnedai` demo (10s value moment)
- [x] Working `pinned init` (one-command install)
- [x] Landing page with live interactive demo
- [x] Pricing tier + Stripe payment link button
- [ ] **Demo GIF** — 45 seconds, the killer asset. PR promise → test committed → future regression caught with back-reference.
- [ ] **GitHub Marketplace listing** at `pinnedai/pinnedai-action`
- [ ] **npm publish** as `pinnedai@0.1.0`
- [ ] **SEO landing pages** (see list below) — each at `pinnedai.dev/<slug>` with example claim → generated test

## Phase 2: Organic launch (Week 1)

**Do NOT blast all channels at once.** Stagger to learn what works.

| Day | Channel | Format |
|---|---|---|
| Mon | **Show HN** | "Show HN: Pinnedai — your PR description is the test. Forever." |
| Tue | **r/SideProject** | Same demo GIF + brief post |
| Wed | **r/javascript** + **r/webdev** | Technical framing, focus on the GitHub Action |
| Thu | **r/ClaudeAI** + **r/cursor** | AI-coder-specific framing — "second agent for AI-coded PRs" |
| Fri | **Dev.to** | Long-form post: *"CodeRabbit comments. Pinned leaves tests."* |
| Sat | **Indie Hackers** | Founder story + pricing math |
| Sun | Iterate: update landing headline based on signal from earlier posts |

### The post angle that works

**Don't say:** *"I built an AI PR reviewer."* (Crowded. Lose.)

**Do say:** *"I built a GitHub Action that turns PR promises into tests."*

### Copy/paste launch post (reusable across channels)

```
I built Pinned because AI-generated PRs often say things like:

  • "Auth required on /api/admin/export"
  • "Rate-limits /api/users to 60/min"
  • "Stripe webhook is idempotent"

…but after merge, those claims usually disappear into the PR history.

Pinned turns those PR promises into permanent CI tests.

Example:
  - PR says "Auth required on /api/admin/export"
  - Pinned commits a test into tests/pinned/
  - CI passes
  - If a future commit makes that route public again, CI fails
    and points back at the original PR

It's not another AI code reviewer.
It leaves tests in your repo.

Free tier protects 25 promises.

Demo: https://pinnedai.dev
Install: npx pinnedai init
```

## Phase 3: Paid micro-tests (Week 3, only if organic produced installs)

**Total budget: $300–$500.** Don't go bigger until conversion is proven.

| Channel | Budget | Why |
|---|---|---|
| Reddit Ads (r/ClaudeAI, r/cursor, r/devops) | $150–$250 | Low minimum (~$5/day), good for dev-community targeting |
| Google Search Ads | $100–$200 | High-intent search ("github action ai code review", "ai pr review"). Expect mixed — Google searchers want CodeRabbit. |
| Retargeting (Twitter or Reddit pixel) | $50–$100 | Pull back the people who saw the landing page but didn't install |

### Reddit ad copy

```
AI-generated PRs make claims.
Pinned turns those claims into CI tests.

"Auth required on /api/admin/export"
  → becomes a permanent test in your repo
  → future regressions fail CI with a link to the original PR

Not another AI reviewer. It leaves tests.

Try it free: protect 25 PR promises.
```

### Google Ads keywords (exact/phrase match)

- `"github action ai code review"`
- `"ai pr review"`
- `"cursor code review"`
- `"claude code tests"`
- `"generate tests from pr"`
- `"github action generate tests"`
- `"ai generated code bugs"`
- `"ai coding regression tests"`
- `"pull request testing"`
- `"ci tests github action"`

**Stop anything that doesn't produce installs within $50.**

## Phase 4: Newsletter sponsorship (Week 4+, after conversion proven)

Better than Google Ads for dev tools because newsletter readers are pre-qualified.

Targets in priority order:
1. **JavaScript Weekly** (~150K subs, $1500–$3000)
2. **TLDR Web Dev** (~250K subs, $2000–$4000)
3. **Bytes.dev** (~150K subs, $1000–$2500)
4. **Console.dev** (dev-tool focused, ~50K subs, $500–$1500)
5. **DevOps Weekly** (~80K subs, $800–$1500)

Only sponsor AFTER:
- Landing page is converting at ≥2%
- Demo GIF is finalized and gets engagement
- Conversion tracking is in place (analytics + Stripe metrics)

## Phase 5: Product Hunt + bigger launches (Week 6+)

Reserve Product Hunt for when you've got testimonials, a few public-repo case studies, and a polished hero asset. PH is one-shot — don't burn it early.

---

## SEO long-tail content (build alongside launch)

These pages bring sustained traffic without paid spend. Each should include a concrete example PR claim → generated test, plus the install command. Live at `pinnedai.dev/<slug>`.

| URL | Target query | Use case shown |
|---|---|---|
| `/github-action-ai-pr-tests` | "github action ai pr tests" | The general pitch — claims → tests |
| `/ai-code-review-vs-regression-tests` | "ai code review vs regression tests" | Direct comparison to CodeRabbit/Greptile |
| `/cursor-ai-generated-code-tests` | "cursor ai code tests" | Cursor-specific framing |
| `/claude-code-pr-testing` | "claude code pr testing" | Claude Code-specific framing |
| `/stripe-webhook-idempotency-test` | "stripe webhook idempotency test" | Idempotent template walkthrough |
| `/nextjs-auth-required-test` | "nextjs auth required test" | Auth-required template + Next.js routes |
| `/rate-limit-regression-test` | "rate limit regression test" | Rate-limit template walkthrough |
| `/github-action-pr-claims-to-tests` | "github action pr claims tests" | The wedge spelled out |

Each page should be ~600-1000 words, optimized for the target query, and link prominently to `npx pinnedai init`.

---

## Tracking — the funnel events that matter

Don't obsess over pageviews. Instrument these (via Plausible or PostHog, free tiers):

| Event | Where | Why it matters |
|---|---|---|
| Landing visit | `pinnedai.dev` | Top of funnel |
| GitHub repo click | Footer/CTA | Discovery interest |
| npm package click | Hero CTA | Conversion intent |
| `npx pinnedai` ran | Worker `/v1/extract` first call from that org | Actual install |
| First pin generated | Worker | First value delivered |
| Reaches 10 pins | Worker | Sticky usage |
| Hits 25-pin cap | Worker 429 response | Upgrade trigger fired |
| Stripe checkout click | Pricing card | Upgrade intent |
| Pro license activated | Worker `X-Pinned-License` header seen | Paying customer |

The most important number to watch in the first 30 days: **% of installs that generate their first pin.** If <50%, the parser / docs / templates are confusing. If >80%, scale distribution.

---

## What NOT to do (anti-patterns observed in similar launches)

- **Don't DM individuals.** Solo founders waste weeks on this and it doesn't scale.
- **Don't launch on Product Hunt first.** You only get one. Wait until you have testimonials.
- **Don't compete on "AI code review."** That's CodeRabbit's positioning — they have 18 months of head start. Always position as *adjunct* not replacement.
- **Don't lead with the pricing.** Lead with the demo. Pricing is for after they want it.
- **Don't pay Google Ads at scale before organic landing-page conversion is proven.** The Google searchers who type "AI PR review" want CodeRabbit and will bounce.
- **Don't build a dashboard before launch.** Customers don't need one to feel value — the value is in their repo (PINS.md). Adding a dashboard pre-launch is busywork.

---

## After-launch rhythm (weeks 5+)

- **Weekly**: check `/admin/stats` for active orgs + cost vs. revenue. Flag any single org consuming >20% of total cost.
- **Weekly**: respond to every HN/Reddit/GitHub issue within 24 hours during the first month. Trust compounds at the source.
- **Monthly**: ship one new claim template based on customer requests. Build the conversation.
- **Monthly**: post a "what's new" thread on r/SideProject + Indie Hackers. Distribution decay is real; counter it with recurring presence.

The launch is not a one-day event. It's the start of a 90-day calibration.
