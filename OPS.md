# pinnedai — operational source of truth

> **Will move to the private `pinnedai-edge` repo on first push.** Lives in the monorepo during local development so quotas/costs are alongside the Worker code.

This document is the canonical reference for operational targets, cost assumptions, conversion goals, abuse triggers, and recovery levers. Update it when business reality diverges from the plan.

Last reviewed: 2026-05-19.

---

## Tier quotas (locked for v0.1)

| Tier | Price | **Active pins** | Auto-commit | BYOK | Repos | Other |
|---|---|---|---|---|---|---|
| Free | $0 | **25 active pins per repo** | ✅ Yes | ❌ | Public + private | Paste-mode + auto-commit, repair prompt on failure |
| Pro | $19/mo | Unlimited | ✅ Yes | ✅ | All | Custom templates, priority LLM, `@pinned fix` (v0.1.1) |
| Team | $199/mo | Unlimited | ✅ Yes | ✅ | All | Org policies, audit log, Slack alerts |
| Enterprise | $20K+/yr | Unlimited | ✅ Yes | ✅ | All | Self-hosted Worker (zero LLM cost), SSO, SOC 2 evidence export |

### The headline metric is pin count, not LLM calls

"25 active pins" is what the customer sees and feels — PINS.md grows visibly with every PR. The CLI enforces this locally by reading `tests/pinned/.registry.json` and refusing `pinned generate` when active count >= 25 unless `PINNEDAI_LICENSE_KEY` is set.

### Quiet abuse defense (NOT marketed)

- **100 PR parses/org/mo** at the Worker (cache hits don't count). Only shown to the customer if hit — they see "monthly quota exceeded" and are nudged to upgrade or BYOK.
- **Per-IP rate limit:** 30 requests/minute (Cloudflare native rules).
- **Body size cap:** 50 KB per `/v1/extract` request.
- **Cache TTL:** 90 days (PR descriptions don't change retroactively after merge).

These exist to prevent runaway cost from a single bad actor; they're not part of the marketing surface. The headline stays "25 active pins."

---

## Cost assumptions

| Item | Assumption | Source |
|---|---|---|
| Per LLM call | $0.001 | gpt-4o-mini @ ~2K input + 500 output tokens |
| Per active Free org/mo | **$0.025 max** (25 PRs × $0.001) | hard ceiling — exactly the monthly cap |
| Per active Free org/mo (typical) | $0.01–$0.02 | most orgs don't hit cap; cache absorbs ~50% of re-extractions |
| Cloudflare Workers | $0–$5/mo | free tier handles MVP scale |
| Cloudflare D1 | $0–$5/mo | free tier 5GB storage, 25B reads/mo |
| Total infra MVP | ~$25–$250/mo | at 1K-10K active Free orgs |

**Burn before profitability at 3% conversion:** ~$0. At $0.025/org and 3% Free→Pro conversion ($19/mo × 30/1K orgs = $570 MRR), gross margin is ~96% from month 4 onward.

**Burn at 1% conversion (worst-case-still-viable):** still profitable. 1K orgs × $0.025 = $25 cost; 10 Pro at $19 = $190 MRR. 87% margin.

**Break-even conversion rate:** ~0.13%. Below industry-average freemium conversion by ~25× — so unless pinnedai is wildly less compelling than the average freemium dev tool, it makes money.

---

## Conversion targets

| Metric | Target | Investigate-if |
|---|---|---|
| Free → Pro conversion | 3% within 90 days | <1% after 90 days = value moment not landing |
| Free → Team conversion | 0.5% | <0.1% = no team workflows surfacing |
| Free → Enterprise | 0.05% (1 in 2,000) | n/a — long sales cycle |
| Pro churn | <5%/mo | >10% = product doesn't compound LTV |
| MRR per 1,000 Free repos | ~$2,500 | <$500 = pricing or conversion broken |

**Cost-per-active-Free-repo:** <$0.10/mo. Drift above $0.15 means cache is broken or someone is abusing the system.

---

## When to panic vs. when it's normal

| Symptom | Normal | Investigate | Panic |
|---|---|---|---|
| OpenAI bill/mo per active Free org | <$0.025 (= 25 cache-miss calls) | n/a (capped) | n/a (capped) |
| Cache hit rate | >40% | 20–40% | <20% (cache logic broken) |
| % of Free orgs hitting monthly cap | <20% | 20–40% | >40% (raise cap or push Pro upgrade) |
| Cloudflare Worker errors | <0.1% | 0.1–1% | >1% |
| OIDC validation failures | <0.5% | 0.5–2% | >2% (cert rotation? bug?) |
| New Free signups/week | growing | flat 4+ wks | declining 4+ wks |
| Free → Pro conversion (90-day rolling) | >2% | 1–2% | <1% (value moment not landing) |

---

## Recovery levers (in escalating order)

If costs spike unexpectedly, here are the levers in order — cheapest first:

1. **Per-IP rate limit tightened** — drop from 30/min to 10/min. Stops obvious automated abuse.
2. **Per-repo daily cap tightened** — drop from 20/day to 10/day. Slows monthly burn.
3. **Free tier monthly quota dropped** — from 100/mo to 75 or 50. Don't broadcast this; just deploy.
4. **Suspend specific high-usage repos** — manually flag in D1, return 429 with "contact us" link.
5. **BYOK required on Free** — emergency only. Kills the wedge. Use only if costs are catastrophic.
6. **Pause new Free signups** — gate behind a waitlist via the OIDC validation step. Keep paid tiers running.

Each lever buys 1-2 weeks of runway. Use the right one for the scale of the problem.

---

## Admin visibility

- **`GET https://api.pinnedai.dev/admin/stats?key=$ADMIN_KEY`** — JSON output with live metrics. v0.1 has this endpoint; v0.1.1 adds a visual dashboard reading from it.
- Daily OpenAI usage email/Slack — set up via OpenAI dashboard billing alerts.
- Cloudflare Workers Analytics — request volume + error rate per route.

---

## Open questions / future tuning

- [ ] What's the actual cache hit rate after first month of real traffic? May tune TTL up or down.
- [ ] Does the 100 calls/repo/mo Free quota bite hobby users? If <1% of Free repos hit cap, may raise to 200. If >20% hit cap, may lower (drives more conversions but risks bounce).
- [ ] Should Team tier have a per-dev seat cap (e.g., $19/dev/mo) instead of flat $199/mo? Depends on whether mid-size teams emerge as the primary buyer.
- [ ] Should Enterprise self-hosted Worker include an org-wide privacy gate ("no PR bodies leave our infrastructure")? Likely yes for SOC 2 buyers.
