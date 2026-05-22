# pinnedai launch checklist

> Everything below requires your account access. Each item is a single command or a few clicks. Total estimated wall-clock time: **2-3 hours**.

Move private (kept in `pinnedai-edge` repo): yes. Public mirror is at `/Users/michaelzon/dyad-apps/pinnedai-public/`.

---

## Order of operations

Do these in order — later items depend on earlier ones.

### 1. Register the domain (~10 min)

- [ ] Buy `pinnedai.dev` at a registrar (Cloudflare Registrar / Namecheap / Porkbun — Cloudflare is the smoothest if you're using Cloudflare Workers anyway, it auto-configures nameservers).
- [ ] Note the registrar — you'll need it for DNS later.

### 2. Create the `pinnedai` GitHub organization (~10 min)

- [ ] Visit https://github.com/account/organizations/new
- [ ] Org name: `pinnedai`
- [ ] Plan: Free
- [ ] Verify the org email
- [ ] (Optional) Add a profile photo + URL pointing at pinnedai.dev

Then create the two repos under that org:

- [ ] `pinnedai/pinnedai` — Public, MIT/Apache-2.0 license, no README (we'll push ours)
- [ ] `pinnedai/pinnedai-edge` — Private, no README

### 3. Push the public mirror (~5 min)

```bash
cd /Users/michaelzon/dyad-apps/pinnedai-public
git remote add origin git@github.com:pinnedai/pinnedai.git
git branch -M main
git push -u origin main
```

### 4. Push the private monorepo (~5 min)

The canonical monorepo at `/Users/michaelzon/dyad-apps/pinnedai/` is the source of truth for everything (CLI + landing + Worker + OPS.md). Push it as the *private* repo so you have a complete backup including the Worker source.

```bash
cd /Users/michaelzon/dyad-apps/pinnedai
git remote add origin git@github.com:pinnedai/pinnedai-edge.git
git push -u origin master
```

Wait — the monorepo's current branch is `master`. Adjust:

```bash
git branch -m master main
git push -u origin main
```

### 5. Cloudflare setup — Worker + D1 (~20 min)

```bash
cd /Users/michaelzon/dyad-apps/pinnedai/apps/edge

# One-time auth (opens a browser)
npx wrangler login

# Create the D1 database — copy the database_id from the output
npx wrangler d1 create pinnedai-quota
# → outputs: database_id = "abc12345-..."
```

Paste the `database_id` into `wrangler.toml` (replace `REPLACE_ME_AFTER_wrangler_d1_create`):

```toml
[[d1_databases]]
binding = "QUOTA"
database_name = "pinnedai-quota"
database_id = "<paste-here>"
```

Apply the schema:

```bash
npx wrangler d1 execute pinnedai-quota --file=./schema.sql --remote
```

Set secrets:

```bash
# OpenAI key from platform.openai.com/api-keys
npx wrangler secret put OPENAI_API_KEY
# Paste your key when prompted

# Admin key — generate a random one and store it in your password manager
# Used to authenticate POST /admin/license and GET /admin/stats
npx wrangler secret put ADMIN_KEY
# Paste: e.g. `openssl rand -hex 32` output
```

Deploy:

```bash
npx wrangler deploy
# → outputs: deployed to https://pinnedai-edge.<your-account>.workers.dev
```

### 6. DNS for `api.pinnedai.dev` → Worker (~10 min)

In Cloudflare dashboard (or wherever DNS is hosted):

- [ ] Add CNAME: `api.pinnedai.dev` → `pinnedai-edge.<your-account>.workers.dev`

OR, simpler, in `apps/edge/wrangler.toml` uncomment and update the `routes` block:

```toml
routes = [{ pattern = "api.pinnedai.dev", custom_domain = true }]
```

Then redeploy: `npx wrangler deploy`. Cloudflare handles SSL + DNS automatically if the domain is on Cloudflare.

### 7. Deploy landing to Vercel (~10 min)

```bash
cd /Users/michaelzon/dyad-apps/pinnedai-public/apps/landing

# One-time auth (opens browser)
npx vercel login

# Deploy
npx vercel deploy --prod
```

Follow prompts: scope to your account, link to a project named `pinnedai-landing`. Vercel auto-detects Vite and builds correctly.

### 8. DNS for `pinnedai.dev` → Vercel (~5 min)

In Cloudflare DNS:

- [ ] Add CNAME: `pinnedai.dev` → `cname.vercel-dns.com`
- [ ] Or A record: `pinnedai.dev` → `76.76.21.21` (Vercel's IPv4)

In Vercel project settings → Domains → Add `pinnedai.dev`. Vercel handles SSL auto-cert.

### 9. Create the Stripe Payment Link (~10 min)

- [ ] Visit https://dashboard.stripe.com/payment-links (create account if needed)
- [ ] Create a Payment Link for "pinnedai Pro" at $19/mo recurring
- [ ] Success URL: `https://pinnedai.dev/?welcome=true`
- [ ] Copy the payment link URL (e.g. `https://buy.stripe.com/abc123...`)

Update the public mirror:

```bash
cd /Users/michaelzon/dyad-apps/pinnedai-public
# Edit apps/landing/src/App.tsx — replace
# https://buy.stripe.com/REPLACE_WITH_REAL_STRIPE_PAYMENT_LINK
# with your actual Payment Link URL
git add -A && git commit -m "Wire actual Stripe payment link"
git push origin main
```

Vercel auto-rebuilds. (For the monorepo source of truth, also update `apps/landing/src/App.tsx` there and re-sync via `scripts/sync-public.sh`.)

### 10. npm publish v0.1.0 (~5 min)

⚠️ **GATE**: do NOT bump version or publish until **every bundle in REVIEW_STATUS.md is ✅ signed off** (see [[gpt-review-before-launch]] memory rule). The placeholder 0.0.1 is reserved on npm — bumping is the last step before announcing.

Once review is clean:

```bash
cd /Users/michaelzon/dyad-apps/pinnedai-public/apps/cli
# Update version in package.json: 0.0.1 → 0.1.0
pnpm version 0.1.0 --no-git-tag-version
pnpm build
npm publish
```

(Run from the public mirror, not the monorepo, so the published package is what's open-source.)

Before running `npm publish`, sanity check with one final pass:

```bash
# From monorepo root
pnpm --filter pinnedai run typecheck     # tsc --noEmit clean
pnpm --filter pinnedai run build         # tsup produces dist/cli.js
pnpm --filter pinnedai exec vitest run   # all 184+ tests green
pnpm run audit:features                   # all 357+ audits green
bash audit/e2e/fake-project-dogfood.sh    # 15 phases — all scripted pass
```

If ANY of those fail, fix before publish. A regression at this point is much cheaper to catch than after the announcement.

### 11. Manual Pro subscription provisioning (workflow until v0.1.1 Stripe webhook ships)

When Stripe checkout completes, the customer is asked to provide their GitHub org name in the checkout form. Once you receive the Stripe email:

```bash
curl -X POST https://api.pinnedai.dev/admin/subscription \
  -H "X-Admin-Key: <your-ADMIN_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "github_org": "acme",
    "customer_email": "ops@acme.dev",
    "plan": "pro",
    "stripe_customer_id": "cus_...",
    "stripe_subscription_id": "sub_..."
  }'
```

Response includes the created `subscription` row. Email the customer:

> Welcome to pinnedai Pro! Your GitHub org **acme** is now on the Pro plan.
> Open a PR with a claim (e.g., "Rate-limits /api/users to 60 req/min.") and
> Pinned will pin without limits — no license key, no API key, no extra config.
> The next PR auto-detects your plan via OIDC.
>
> Optional: if you'd prefer your PR descriptions never transit our infra, set
> the action input `byok: anthropic` (or `openai`) plus the secret
> `PINNEDAI_ANTHROPIC_KEY` / `PINNEDAI_OPENAI_KEY` — we'll skip our Worker and
> call your provider directly.

Set up a Stripe email forward rule so these notifications hit you within a minute of a payment. Until the Stripe webhook lands in v0.1.2, every new sub is hand-provisioned.

### 12. Record the demo GIF (~30-60 min)

The killer pitch is the failure-recovery loop. Record this flow:

1. Open a PR with description: *"Rate-limits /api/users to 60 req/min."*
2. Show the Action posting a comment with the generated test + suggestions
3. Merge the PR — test joins `tests/pinned/`
4. Open a second PR that intentionally breaks the rate limiter
5. Show CI failing with the back-reference + the Cursor/Claude paste-ready repair prompt
6. (Bonus) Show pasting the prompt into Cursor/Claude, getting a fix, committing — CI green

Save as `pinnedai-demo.gif`. Add it to the README hero and embed on the landing page.

### 13. GitHub Marketplace submission (optional, can do post-launch)

- [ ] Create a separate repo `pinnedai/pinnedai-action` containing just `action.yml` (the composite action wrapping `npx pinnedai`)
- [ ] Follow https://docs.github.com/en/actions/creating-actions/publishing-actions-in-github-marketplace
- [ ] Add icon + description
- [ ] Tag v1.0.0

This boosts discoverability but isn't blocking — `npx pinnedai init` writes a workflow that uses `npx` directly, so the Action isn't strictly needed for adoption.

### 13.5. VS Code extension — publish to OpenVSX + VS Code Marketplace (~25 min one-time)

Reaches Cursor (via OpenVSX) + VS Code default-install (via Microsoft marketplace). Full per-marketplace token + publisher setup is documented at `apps/vscode-extension/PUBLISHING.md` — follow it once on launch day.

**Recommended order** per CLAUDE.md decision:

- [ ] **Day 0**: `cd apps/vscode-extension && pnpm run publish:ovsx` (OpenVSX — Cursor users find it via Extensions search immediately)
- [ ] **Day 1-2**: `pnpm run publish:vsce` (VS Code Marketplace — once first soak shows no critical bugs)

Both commands rebuild from source. After publish, sanity-check:
- OpenVSX: https://open-vsx.org/extension/pinnedai/pinnedai-vscode
- VS Code Marketplace: https://marketplace.visualstudio.com/items?itemName=pinnedai.pinnedai-vscode

### 14. Launch posts (~1 hr)

Tagline (locked Guardrail framing): **"Permanent guardrails for AI-coded apps."**

Subhead (use across all launch surfaces): *"Pinned remembers the promises your app must keep — auth, billing, rate limits, webhooks, permissions, and critical flows — and blocks future AI edits from quietly breaking them."*

Targets, in order of fit:

- [ ] **Hacker News (Show HN)** — title: *"Show HN: Pinnedai — permanent guardrails for AI-coded apps"*. Hero line: "Your AI coder forgets. Pinned remembers." Include demo GIF + link to pinnedai.dev. Mention the day-zero verify "catches the bug at pin-creation time" demo.
- [ ] **X/Twitter** — thread of 5-7 tweets walking through the demo. Lead with a screenshot of `🛟 Pinned caught a regression` against a real codebase. End with `pinnedai.dev`.
- [ ] **dev.to** — long-form post titled *"Code review catches the moment. Pins protect the contract."* Compare directly with CodeRabbit / Greptile / Copilot Workspace. Emphasize the moat: permanent artifacts in the customer's repo.
- [ ] **r/devops** + **r/javascript** + **r/devsecops** — short post with demo GIF
- [ ] **Personal X reach** — DM 20 specific names from your Cursor/Claude Code/Devin power-user network. Ask for design partners — emphasize the "Pinned caught a regression in my own code on day 0" demo screenshot.

Coordinate the launch posts within a 2-hour window for maximum signal.

### 15. Day-1 watch (passive)

- [ ] Monitor OpenAI dashboard for cost spikes (set alerts at $5/day, $20/day, $100/day)
- [ ] Check `https://api.pinnedai.dev/admin/stats?key=<ADMIN_KEY>` daily for the first week
- [ ] Watch HN comments + reply to every one within 2 hours during the first 12 hours
- [ ] Triage incoming Stripe payments → issue licenses within 1 hour

---

## Post-launch — v0.1.1 priorities (~3 weeks after launch)

1. Stripe webhook → auto-issue licenses (eliminates manual step in #11)
2. `@pinned fix` auto-repair (the big sticky feature we deferred)
3. Visual admin dashboard reading from `/admin/stats`
4. Real demo customer testimonials → landing page social proof

## Risks during launch — what to watch

- **OpenAI bill spike** if a single repo hammers the quota. Defense: 100 PR parses/org/mo abuse cap is in place. Monitor `topConsumers` in admin stats.
- **OIDC validation failures** — could indicate GitHub cert rotation or a bug. The Worker caches JWKS for 1 hour; if you see >2% failure rate, force-refresh the cache (redeploy).
- **Free tier conversion stalls** if landing page doesn't communicate the wedge. Watch the conversion funnel weekly; if <1% F→P after 30 days, iterate on landing copy before iterating on features.
- **CodeRabbit ships a "test generation" feature** in response. Defense: our moat is *permanent tests in repo*, not test generation. Strengthen the PINS.md positioning if they copy.

---

## File map — what lives where

| Path | Repo |
|---|---|
| `/Users/michaelzon/dyad-apps/pinnedai/` | PRIVATE monorepo — canonical source (CLI + landing + Worker + OPS + memory) |
| `/Users/michaelzon/dyad-apps/pinnedai-public/` | PUBLIC mirror — CLI + landing only, synced via `scripts/sync-public.sh` |
| `apps/edge/` | Worker source — never push to public repo |
| `OPS.md` | Operational targets/triggers — never push to public repo |
| `CLAUDE.md` + `ROADMAP.md` | Internal planning — never push to public repo |
| `~/.claude/projects/.../memory/` | AI session memory — local only, not in any repo |

When you make a change to CLI or landing in the monorepo, run `bash scripts/sync-public.sh` before pushing the public repo. The sync script verifies no private files leak (fails with `FATAL` if `apps/edge/` or `OPS.md` end up in the public dir).
