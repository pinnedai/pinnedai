# apps/api — Deploy Runbook

Vercel Edge Functions + Supabase backend for `api.pinnedai.dev`.
Replaces `apps/edge.deprecated/` (the CF Worker). Same runtime model
(V8 isolate) but on Vercel + Supabase, so it operates next to the
existing `pinnedai-landing` project and Cipherwake's analytics stack.

## What this Worker does

| Endpoint | Purpose |
|---|---|
| `GET /api/healthz` | Liveness probe |
| `GET /api/badge/<org>/<repo>` | Public SVG badge |
| `POST /api/v1/extract` | OIDC-authenticated PR-claim LLM extraction |
| `POST /api/v1/summarize` | OIDC-authenticated PR diff summary |
| `POST /api/v1/plan` | Subscription plan lookup |
| `POST /api/v1/repo-stats` | Opt-in hosted analytics upload (Pro+) |
| `POST /api/admin/subscription` | Create/update a Pro subscription |
| `GET /api/admin/stats` | Per-org call counts for current month |
| `GET /api/admin/usage` | WoW growth report |
| `POST /api/admin/usage/snapshot` | Manual snapshot trigger (used by backfill) |
| `GET /api/cron/usage-snapshot` | Daily cron at 09:10 UTC |

All endpoints run on the `edge` runtime (no 10s function timeout).

## First-time deploy

### 1. Create the Supabase project

1. Go to https://supabase.com/dashboard → New Project → name it
   `pinnedai-prod` (or whatever).
2. Wait for provisioning (~1 min).
3. Open SQL Editor and paste the contents of
   `supabase/migrations/20260608000000_pinnedai_init.sql`. Run.
4. From Settings → API, copy:
   - `Project URL` → becomes `SUPABASE_URL`
   - `service_role` key (under "Project API keys") → becomes
     `SUPABASE_SERVICE_ROLE_KEY`. **Service role bypasses RLS** — keep
     it server-side only; the Edge Functions are the only consumer.

### 2. Create the Vercel project

```bash
cd apps/api
npx vercel link        # creates a new project; pick "pinnedai-api"
                       # (or merge into pinnedai-landing if you prefer
                       #  one project)
```

### 3. Set env vars in Vercel

Either via the dashboard (Project → Settings → Environment Variables)
or via the CLI:

```bash
npx vercel env add SUPABASE_URL                  production
npx vercel env add SUPABASE_SERVICE_ROLE_KEY     production
npx vercel env add OPENAI_API_KEY                production
npx vercel env add ADMIN_KEY                     production
npx vercel env add CRON_SECRET                   production   # Vercel sets this in the cron request
# Optional — defaults are reasonable:
npx vercel env add FREE_QUOTA_PUBLIC_PER_MONTH   production   # default 500
npx vercel env add FREE_QUOTA_PRIVATE_PER_MONTH  production   # default 100
npx vercel env add FREE_BUDGET_TOTAL_PER_MONTH   production   # default 100000
npx vercel env add OIDC_AUDIENCE                 production   # default "pinnedai"
```

### 4. Add the custom domain

In the Vercel dashboard for `pinnedai-api`:

- Settings → Domains → Add `api.pinnedai.dev`
- DNS is already at Vercel (the pinnedai.dev zone) so Vercel handles
  the DNS record automatically.

### 5. Deploy

```bash
cd apps/api
npx vercel deploy --prod
```

Verify:

```bash
curl -sI https://api.pinnedai.dev/api/healthz
# → HTTP/2 200, {"ok":true,"service":"pinnedai-api"}
```

### 6. Backfill 30 days of usage snapshots

```bash
export ENDPOINT="https://api.pinnedai.dev"
export ADMIN_KEY="<the value you set in step 3>"
node scripts/backfill-usage-snapshots.mjs 30

# Read WoW
curl -s -H "authorization: Bearer $ADMIN_KEY" $ENDPOINT/admin/usage | jq
```

## Subsequent deploys

```bash
cd apps/api
npx vercel deploy --prod
```

Schema migrations: paste new SQL into Supabase SQL editor. The
initial migration is idempotent (`CREATE TABLE IF NOT EXISTS`).

## Confirming users aren't silently failing

Once deployed, the CLI's dead-endpoint warning (added in 0.5.0-beta.7)
stops firing. Verify with a test repo:

```bash
PINNEDAI_SUPPRESS_ENDPOINT_WARN=0 npx pinnedai check --description "Rate-limits /api/x to 60/min"
# Should NOT emit "⚠ pinned: hosted endpoint ... is unreachable"
```

## Why Vercel and not Cloudflare

We initially built this for Cloudflare Workers + D1 (see
`apps/edge.deprecated/`). Switched to Vercel + Supabase in 0.5.0
because:

1. DNS for `pinnedai.dev` is already at Vercel — no migration risk
2. Reuses the Cipherwake R94 analytics pattern (also on Vercel/Supabase)
3. One stack to operate, one set of credentials
4. Vercel Edge Functions are the same V8 isolate as CF Workers, so the
   port was straightforward
