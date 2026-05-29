# GPT prompt — launch-day operational catastrophes

> Copy-paste into a fresh GPT-5 / Claude Opus session. Goal: find operational failure modes that happen ONCE (at launch or soon after) and aren't easily testable in CI. We're worried about traffic spikes, partial outages, payment-flow races, and quota-counter edge cases that surface only at scale.

---

## Background

Pinned (`pinnedai`) has these operational dependencies at launch:

- **npm registry** — distribution surface for `pinnedai` package
- **GitHub** — hosts our repo, runs the GitHub Action for every customer's PR
- **Cloudflare Workers** — hosted endpoint at `api.pinnedai.dev` for OIDC validation + LLM extraction
- **Cloudflare D1** — SQLite at the edge, holds per-org monthly quota counters
- **OpenAI** (or hosted Anthropic via BYOK) — actual LLM calls for claim extraction
- **Stripe** — Pro subscription payments. v0.1 uses manual provisioning (admin curl); v0.2 adds webhook.
- **Vercel** — landing page at `pinnedai.dev`
- **VS Code Marketplace + OpenVSX** — extension distribution

Launch-day traffic shape (expected):
- Show HN goes live → spike to landing (1000+ visitors first hour)
- Many landing visitors click "npm install pinnedai" → install spike
- ~20-50 design-partner attempts → real Worker traffic (OIDC + LLM)
- Stripe checkout from early adopters → Pro tier provisioning
- 24-hour soak before serious volume → most failures happen in this window

We've already audited: per-pin verification logic, regex ReDoS, Worker OIDC signature verification, D1 atomic counters, basic GitHub Action wiring.

## What we want from you

Find **specific operational failure modes** that could happen at launch or in the first week. For each:

1. **Scenario** — what triggers it (specific traffic pattern, partial outage, race condition)
2. **Where it breaks** — which system / which endpoint / which counter
3. **User-visible symptom** — what does the affected customer see?
4. **Severity** — CATASTROPHIC (data loss / billing leak / silent service degradation) / HIGH (loud outage but limited blast radius) / MEDIUM (recoverable with admin intervention) / LOW (cosmetic)
5. **Mitigation** — code change / monitor / runbook step

Bias toward **silent service degradation** and **billing/quota leakage** — both could hurt for weeks before we notice.

### Probe these specific areas

**Traffic spike scenarios:**
- 500 simultaneous `npm install pinnedai && npx pinnedai init` requests from HN landing-page visitors. The npm package's postinstall message is cheap, but the GitHub Action they install hits the Worker. Worker concurrency limits at Cloudflare?
- HN top-of-page (~50K visits/hour) → landing page traffic. Vercel handles it fine usually, but does our pricing page's Stripe link sustain? Does the interactive demo (browser-side claim parser) hit any rate limit?
- OpenAI's rate-limit (10K RPM tier as a fresh account) gets exceeded on the FIRST hour. Worker should degrade to regex-only — does it actually?

**Worker partial outage scenarios:**
- Cloudflare regional outage — half the world can reach `api.pinnedai.dev`, half can't. Customers in the broken region get... what? Silent skip? Loud failure? The CLI's fallback path needs to work without distinguishing "Worker hates me specifically" from "Worker is down globally."
- D1 read after write delay — D1 has eventual consistency. A customer's quota increment from request N might not be visible to request N+1 if they happen on different edge nodes. Race window probably small but real.
- JWKS rotation by GitHub — GitHub rotates its OIDC signing keys periodically. Our Worker fetches JWKS with some TTL. If our cache is stale during a rotation, valid tokens get rejected. What's the worst-case window?
- Worker secret rotation (`OPENAI_API_KEY` rotated by us mid-deploy) — running Worker instances pick up the new secret eventually. During the transition window, some requests use old, some new. Is there a request that hits both?

**OpenAI / LLM-provider catastrophes:**
- OpenAI returns a wildly malformed response (HTML error page, JSON-with-different-shape, empty body). Does the Worker's structured-extraction parsing crash? Does the CLI report "0 claims" silently?
- OpenAI's prompt format changes between gpt-4o-mini versions — our prompt encodes assumptions about its output structure. If they roll out a new version that changes formatting, our claims could be subtly wrong (wrong route, wrong rate, etc.). Catastrophic if Pinned starts generating pins for nonexistent routes.
- OpenAI billing capped, gets 429s for the whole month. Worker should serve regex-only — does it?

**Stripe / billing edge cases:**
- Customer pays Stripe but the manual `POST /admin/subscription` curl fails / is delayed. Customer has receipt but Pro features don't work. How does support see this? How long is the typical delay before they email us?
- Customer cancels Stripe subscription. Worker still has them as Pro in D1 until... when? Is there a sweep?
- Stripe webhook (v0.1.1+) double-fires. Pro provisioning happens twice → idempotent? Or do we count it twice in some way?
- Customer's GitHub org name in Stripe checkout has a typo. We provision Pro for `acmecorp` but their PRs run under `acme-corp` (with hyphen). Customer sees "still on Free" and is confused.

**Quota counter edge cases:**
- Cross-month rollover at exactly 00:00:00 UTC. Multiple requests hit simultaneously, half see "month X" remaining, half see "month Y fresh." Counter math: idempotent? double-counted? leaked?
- BYOK customer with an invalid API key. The Worker passes through the request, OpenAI returns 401, what does the customer see? Does our quota counter NOT increment in this case (since their LLM call failed)?
- Quota counter says 99/100 used, 5 simultaneous requests arrive. All 5 see "99" before any increments. All 5 fire LLM calls. We over-spend by 4 in the worst case. Is the math atomic in D1?
- Aggregate `FREE_BUDGET_TOTAL_PER_MONTH` fires. EVERY org gets 429. Is there a 30s grace where requests already in flight complete? Or do they all get rejected mid-call (potentially leaking budget without serving the customer)?

**GitHub Action ecosystem:**
- A customer's GitHub Action runner is on a fork of our action (e.g., `pinnedai/pinnedai-action@some-commit-sha`) that doesn't have v1's bug fix. They report "Pinned is broken" but we ship the latest. How do we detect this?
- GitHub Marketplace listing review pending (or rejected). Our docs say `pinnedai/pinnedai@v0.1.0` but customers can't install it. Fallback documentation path?
- GitHub OIDC outage for ~1 hour. Our Worker rejects ALL JWTs. No customer can install. What's the customer-facing error message and the support path?

**Domain / DNS:**
- `pinnedai.dev` DNS propagates unevenly. Some users see Vercel, some see "site not found" for ~6 hours after launch. The npm package's postinstall message points at `pinnedai.dev` — these users see the URL not loading.
- `api.pinnedai.dev` not yet propagated to a customer's resolver. Worker calls time out. CLI degrades to regex — but does it have a long timeout (6 min) that makes PR checks hang first?

**The first failure people will write about:**
- A customer's pinned test fails in their CI for a reason they don't understand. They tweet about it. The tweet says "Pinned just broke my CI." If the failure was a real catch (great!), we look good. If it was a flake / config issue, we look terrible. What's the worst-case ratio? Where would we set monitoring to catch this trend?

**Cost runaways:**
- An adversarial customer (or a customer's misbehaving AI agent) generates 10,000 pins on a single PR. Each one triggers day-zero verify, each verify spins up vitest. Could DoS the customer's CI runners AND consume our OpenAI quota.
- A customer's GitHub Action loops (some misconfiguration). Each loop calls the Worker. Within minutes, their entire month's quota is consumed. Do we detect circuit-breaker patterns?

**Compliance accidents:**
- A customer's pinned test runs against their PRODUCTION URL (because they set PREVIEW_URL=https://prod...). Pinned's burst of 61 requests for rate-limit test hits production. Customer's prod app rate-limits real users for 30s. Wait — we have `X-Pinned-Test: 1` header but their prod might not honor it. Catastrophic in a regulated industry (healthcare, finance).
- A customer pins a claim that says "user PII is properly redacted." The pinned test sends test data containing actual user PII (because the customer's fixture is broken). Now PII is in CI logs. GDPR breach if a regulator sees it.

## Output format

Numbered list, severity-sorted. For each finding:

- Specific scenario (concrete enough to write a runbook entry)
- Detection path (how would we know this is happening — what monitor / metric / customer report?)
- Mitigation (deploy-blocking fix vs runbook entry vs accepted risk)
- Recommended pre-launch test (synthetic load test, chaos drill, etc.)

**Bonus**: rank the top 3 operational risks by **expected dollar impact** (combining likelihood × cost). We want to know what to monitor on launch day.
