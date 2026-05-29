# Setting up `PREVIEW_URL` for Pinned

> **Why this matters**: Pinned's web-template pins (auth-required, rate-limit, idempotent, returns-status, permission-required, tier-cap) verify behavior by hitting a deployed copy of your app. Without `PREVIEW_URL` set, those pins skip silently — the statusline shows `⊘ N pins skipped (no preview)` and they don't catch anything. Once `PREVIEW_URL` is set, the pins immediately start verifying every commit.
>
> CLI / library pins (`cli-output-contains`, `cli-exits-zero`, `cli-creates-file`, `cli-flag-supported`, `library-returns`) **do not need `PREVIEW_URL`** — they run locally against your binary or module.

---

## TL;DR

Pick one path:

| Your situation | Recommended setup | Time |
|---|---|---|
| Already using **Vercel** (Next.js / Nuxt / SvelteKit) | Use the per-PR Vercel preview URL via [`amondnet/vercel-action`](https://github.com/amondnet/vercel-action) | ~10 min |
| Already using **Fly.io** | Create a staging app; pass its URL as `PREVIEW_URL` | ~15 min |
| Already using **Cloudflare Pages / Workers** | Use the per-PR `*.pages.dev` preview URL | ~10 min |
| Already using **Render** | Use Render's `pull_request_preview` URL | ~10 min |
| Already using **Railway** | Use the per-PR ephemeral environment URL | ~10 min |
| **Localhost-only / no preview deploy yet** | Use [Cloudflare Tunnel](#fallback-cloudflare-tunnel-from-ci) — exposes localhost to CI | ~20 min |
| **Will deploy later, want to start using Pinned now** | Skip — CLI and library pins still work without `PREVIEW_URL`. Web pins will start verifying once you set it. | 0 min |

---

## Vercel (most common for Next.js / Nuxt / SvelteKit)

Vercel creates a unique preview URL for every PR. Pass it to Pinned via the Action's env.

In `.github/workflows/pinned.yml` (the workflow `pinned init` writes):

```yaml
jobs:
  pinned:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      id-token: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }

      # Wait for Vercel to finish the preview deploy for this PR
      - name: Wait for Vercel preview
        id: vercel-preview
        uses: patrickedqvist/wait-for-vercel-preview@v1.3.1
        with:
          token: ${{ secrets.VERCEL_TOKEN }}
          max_timeout: 600

      # Run Pinned with the preview URL
      - uses: pinnedai/pinnedai@v0.1.0
        env:
          PREVIEW_URL: ${{ steps.vercel-preview.outputs.url }}
```

Required secret: `VERCEL_TOKEN` (from Vercel → Account → Tokens).

---

## Fly.io

Fly doesn't auto-create per-PR previews. Two options:

### Option A: Single staging app, point all PRs at it

```yaml
- uses: pinnedai/pinnedai@v0.1.0
  env:
    PREVIEW_URL: https://your-staging-app.fly.dev
```

Simple but: pin tests touch the *same* staging app on every PR. If a PR's bug ALSO affects the staging app (e.g., the staging app was deployed from main BEFORE the PR was opened), the tests don't catch it. Adequate for solo devs.

### Option B: Per-PR Fly preview app

Use Fly's [GitHub PR preview](https://fly.io/docs/blueprints/review-apps-guide/) feature. Each PR gets a unique URL.

```yaml
- name: Deploy preview to Fly
  id: fly-deploy
  run: |
    flyctl deploy --app pinnedai-${{ github.event.pull_request.number }} --remote-only
    echo "url=https://pinnedai-${{ github.event.pull_request.number }}.fly.dev" >> $GITHUB_OUTPUT
  env:
    FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}

- uses: pinnedai/pinnedai@v0.1.0
  env:
    PREVIEW_URL: ${{ steps.fly-deploy.outputs.url }}
```

Required secret: `FLY_API_TOKEN`.

---

## Cloudflare Pages / Workers

Cloudflare Pages auto-creates preview URLs at `https://<commit-hash>.your-project.pages.dev`. Workers can do the same via [preview deployments](https://developers.cloudflare.com/workers/configuration/previews/).

```yaml
- name: Deploy Cloudflare Pages preview
  id: cf-preview
  uses: cloudflare/pages-action@v1
  with:
    apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    projectName: your-project
    directory: ./dist

- uses: pinnedai/pinnedai@v0.1.0
  env:
    PREVIEW_URL: ${{ steps.cf-preview.outputs.url }}
```

Required secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

---

## Render

Render's pull-request-preview feature ([docs](https://render.com/docs/pull-request-previews)) creates a unique URL for each PR.

```yaml
- uses: pinnedai/pinnedai@v0.1.0
  env:
    # Render's PR preview URL pattern
    PREVIEW_URL: https://your-service-pr-${{ github.event.pull_request.number }}.onrender.com
```

No secret needed — the URL is deterministic from the PR number.

---

## Railway

Railway's [PR Environments](https://docs.railway.com/guides/pull-request-environments) create ephemeral URLs per PR.

```yaml
- name: Get Railway PR environment URL
  id: railway-url
  run: |
    URL=$(railway environment --name pr-${{ github.event.pull_request.number }} --json | jq -r '.url')
    echo "url=$URL" >> $GITHUB_OUTPUT
  env:
    RAILWAY_TOKEN: ${{ secrets.RAILWAY_TOKEN }}

- uses: pinnedai/pinnedai@v0.1.0
  env:
    PREVIEW_URL: ${{ steps.railway-url.outputs.url }}
```

Required secret: `RAILWAY_TOKEN`.

---

## Fallback: Cloudflare Tunnel from CI

When you don't have a hosted preview yet — typical for a brand-new project or for a side-project that runs locally only — you can have CI:

1. Boot your app inside the GitHub Actions runner
2. Expose it via Cloudflare Tunnel (free, no domain needed)
3. Pass the tunnel URL as `PREVIEW_URL`

```yaml
- name: Boot app in CI
  run: |
    npm ci
    npm run build
    npm start &
    sleep 5  # wait for app to be ready

- name: Open Cloudflare Tunnel
  id: tunnel
  run: |
    curl -L -o cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
    chmod +x cloudflared
    ./cloudflared tunnel --url http://localhost:3000 --no-autoupdate > tunnel.log 2>&1 &
    sleep 5
    TUNNEL_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' tunnel.log | head -1)
    echo "url=$TUNNEL_URL" >> $GITHUB_OUTPUT

- uses: pinnedai/pinnedai@v0.1.0
  env:
    PREVIEW_URL: ${{ steps.tunnel.outputs.url }}
```

No secrets needed — Cloudflare Tunnel's "Try Cloudflare" mode is free and anonymous.

> **Heads up**: Cloudflare's `trycloudflare.com` tunnels are intended for development. For production-level reliability, use a named Cloudflare Tunnel (requires a domain) or one of the per-PR preview options above.

---

## Local development

When running `pinned test` locally (not in CI), set `PREVIEW_URL` to your local dev server:

```bash
PREVIEW_URL=http://localhost:3000 pnpm pinned test
```

Or add it to a `.env.local` that `pinned` reads (Pinned doesn't load .env files itself, but if you use `dotenv-cli` or similar to launch test commands, it'll pass through).

---

## Required: honor the `X-Pinned-Test: 1` header

Every Pinned-generated HTTP request carries `X-Pinned-Test: 1`. Your app should **exclude Pinned traffic** from:

- Rate-limit counters (otherwise a rate-limit pin's burst of 61 requests counts against your real budget)
- Billing-tier counters (otherwise a tier-cap pin silently consumes the customer's real allowance)
- Analytics events (synthetic traffic pollutes dashboards)
- Audit logs (test traffic doesn't belong in compliance logs)
- Abuse detection (avoid IP bans on your own test traffic)

```ts
// Example middleware (Next.js / Express / Hono)
if (req.headers["x-pinned-test"] === "1") {
  // Skip rate-limit / billing-counter / analytics / audit-log work
  return next();
}
```

Without this exclusion, **Pinned tests will use up your real rate-limit budget on every run** — usually fine for development but problematic on a production preview. This is the single highest-impact false-positive prevention the customer's app can implement.

### ⚠️ Critical: `X-Pinned-Test` is NOT a security boundary

The header value `1` is **public and forgeable**. An external attacker can spoof it. **Never** use this header to skip:

- Authentication / authorization
- Audit-log writes
- CSRF / signature checks
- Abuse-detection rules

Only use it for **counter exclusion** (rate-limit counter increments, billing usage counters, analytics events) — places where forgery would matter only operationally, not as a security incident.

For high-stakes exclusions, layer a **per-deploy random secret** that external attackers don't know:

```ts
// preview env: PINNED_TEST_SECRET=<random-hex>
if (
  req.headers["x-pinned-test"] === "1" &&
  req.headers["x-pinned-test-secret"] === process.env.PINNED_TEST_SECRET
) {
  // safe to exclude — secret is preview-only
}
```

v0.2 will add `PREVIEW_TEST_AUTH_SECRET` as a built-in pattern.

See `tests/pinned/AGENT.md` (auto-written by `pinned init`) for the AI-agent-friendly version of this guidance.

---

## Verifying your setup

After configuring `PREVIEW_URL`:

```bash
pnpm pinned test
```

You should see vitest running pins against the preview. The Pinned statusline switches from `⊘ N skipped (no preview)` to `✓ N verified`.

If a pin fails — even on a healthy preview — first check:

1. **Is the preview actually deployed and reachable?** Try `curl $PREVIEW_URL` from your shell.
2. **Cold-start latency**: serverless previews (Vercel, Fly, Cloudflare) may return 502/503 for the first few seconds. Pinned's templates retry transient 5xx automatically, but if cold-start exceeds 5 seconds, set `PINNED_FETCH_TIMEOUT=10000` in CI.
3. **Auth / fixture tokens not honored**: if permission-required or tier-cap pins fail despite tokens being set, confirm your auth middleware actually validates the test tokens.

---

## What if I'll never have a preview deploy?

Pinned is still useful — just less so. Without `PREVIEW_URL`:

| Template family | Works without PREVIEW_URL? |
|---|---|
| CLI templates (`cli-output-contains`, `cli-exits-zero`, `cli-creates-file`, `cli-flag-supported`) | ✅ Yes — run the binary directly |
| Library template (`library-returns`) | ✅ Yes — imports the module directly |
| Safety Pass (deterministic scan: env leaks, CORS, SQL hazards) | ✅ Yes — no HTTP traffic at all |
| Web templates (`auth-required`, `rate-limit`, `idempotent`, `returns-status`, `permission-required`, `tier-cap`) | ❌ Skip with clear reason in statusline |

If your repo is CLI-only or library-only, you're set — Pinned protects what you have. If your repo is a web app and you can't set up a preview deploy yet, the CLI/library pins still work; the web pins wait until preview is available.

---

## Still stuck?

- File an issue at https://github.com/pinnedai/pinnedai/issues with your stack details
- The Pinned action source is at https://github.com/pinnedai/pinnedai — PRs welcome for additional preview-platform examples
