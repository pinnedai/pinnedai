# apps/edge — Deploy Runbook

The Pinned Cloudflare Worker that serves `api.pinnedai.dev`. Currently the production endpoint returns `DEPLOYMENT_NOT_FOUND` because the Vercel DNS pointer was never replaced with the CF Worker route. Use the steps below to bring it up.

## What's in this Worker

- `/v1/extract` — OIDC-authenticated LLM claim extraction (free + paid)
- `/v1/summarize` — OIDC-authenticated PR diff summary (free + paid)
- `/v1/plan` — subscription plan lookup
- `/v1/repo-stats` — opt-in analytics upload (Pro+)
- `/badge/<org>/<repo>` — public SVG badge
- `/admin/*` — bearer-token gated admin endpoints
- **0.5.0-beta.8** `/admin/usage` — WoW growth report
- **0.5.0-beta.8** `/admin/usage/snapshot` — manual snapshot trigger (used by backfill)
- **0.5.0-beta.8** Scheduled cron at `10 9 * * *` UTC — daily snapshot

## First-time deploy

```bash
cd apps/edge

# 1) Authenticate with Cloudflare (one-time)
npx wrangler login

# 2) Create the D1 database
npx wrangler d1 create pinnedai-quota
# → copy the printed `database_id` into wrangler.toml's `database_id` field

# 3) Apply the schema (creates quota, extraction_cache, subscriptions,
#    repo_stats_uploads, detector_model_rollup, pin_events, usage_snapshots)
npx wrangler d1 execute pinnedai-quota --remote --file=./schema.sql

# 4) Set secrets
npx wrangler secret put OPENAI_API_KEY    # used for /v1/extract + /v1/summarize
npx wrangler secret put ADMIN_KEY         # used for /admin/* endpoints

# 5) Uncomment the production route in wrangler.toml:
#    routes = [{ pattern = "api.pinnedai.dev", custom_domain = true }]
#
#    Then ensure pinnedai.dev's DNS is on Cloudflare (the apex zone
#    needs to be there for `custom_domain = true` to work). If it
#    isn't, move DNS to Cloudflare first.

# 6) Deploy
npx wrangler deploy

# 7) Sanity-check
curl -sI https://api.pinnedai.dev/healthz
# → HTTP/2 200; body: {"ok":true,"service":"pinnedai-edge"}
```

## Backfill the usage snapshots (after deploy)

The daily cron only writes one row per day going forward. To get an
immediate WoW growth signal, backfill from existing `pin_events`:

```bash
cd apps/edge

# Set the env vars
export ENDPOINT="https://api.pinnedai.dev"
export ADMIN_KEY="<value-you-set-in-step-4>"

# Backfill 30 days
node scripts/backfill-usage-snapshots.mjs 30

# Read the WoW report
curl -s -H "authorization: Bearer $ADMIN_KEY" $ENDPOINT/admin/usage | jq
```

## Subsequent deploys

```bash
cd apps/edge
npx wrangler deploy
```

Schema migrations: re-running `wrangler d1 execute ... --file=./schema.sql` is safe — every CREATE is `IF NOT EXISTS`.

## What this Worker does NOT do

- It does not collect raw IPs (all stored hashes are `SHA-256(ip + daily-salt)`)
- It does not collect source code from `/v1/repo-stats` uploads — only per-detector counts + bounded summaries
- It does not auto-run anything until DNS + `routes = [...]` are configured. The Worker can exist on Cloudflare without serving public traffic.

## Confirming users aren't silently failing

Once deployed, the CLI's dead-endpoint warning (added in 0.5.0-beta.7) stops firing. You can verify by:

```bash
# In a test repo
PINNEDAI_SUPPRESS_ENDPOINT_WARN=0 npx pinnedai check --description "Rate-limits /api/x to 60/min"
# Should not emit "⚠ pinned: hosted endpoint ... is unreachable"
```
