-- =============================================================================
-- pinnedai-api initial schema
-- =============================================================================
-- Created 2026-06-08 alongside the Vercel/Supabase port of the Cloudflare
-- Worker (apps/edge.deprecated/). Same shape as the original D1 schema
-- minus the SQLite-specific bits — Postgres equivalents throughout.
--
-- Paste this into Supabase Studio SQL editor for your new pinnedai
-- project (or run `supabase db push` if you've linked the CLI).
--
-- All tables enable RLS but the service-role key the Edge Functions
-- use bypasses RLS — RLS is on so accidental anon access can't read
-- subscription data or quota counts.
--
-- Idempotent — every CREATE is IF NOT EXISTS, every ALTER guarded.
-- =============================================================================

-- ---------- quota ----------
-- Per-org monthly LLM-call counter. Free tier: 500 public / 100 private
-- per month (caps cost so OpenAI bill bounded by FREE_BUDGET_TOTAL_PER_MONTH
-- env var). Paid tiers use subscriptions.fair_use_cap.
CREATE TABLE IF NOT EXISTS quota (
  org           TEXT NOT NULL,
  month         TEXT NOT NULL,                 -- YYYY-MM (UTC)
  calls         BIGINT NOT NULL DEFAULT 0,
  last_call_at  BIGINT NOT NULL,               -- unix ms
  PRIMARY KEY (org, month)
);
CREATE INDEX IF NOT EXISTS idx_quota_month ON quota (month);

ALTER TABLE quota ENABLE ROW LEVEL SECURITY;

-- ---------- extraction_cache ----------
-- SHA-256(body) → cached Claim[]. 90-day TTL. A PR pushed 20× only
-- bills 1 OpenAI call.
CREATE TABLE IF NOT EXISTS extraction_cache (
  content_hash  TEXT PRIMARY KEY,
  claims        JSONB NOT NULL,
  cached_at     BIGINT NOT NULL,
  expires_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_extraction_cache_expires ON extraction_cache (expires_at);

ALTER TABLE extraction_cache ENABLE ROW LEVEL SECURITY;

-- ---------- subscriptions ----------
-- Pro/Team/Enterprise plans keyed by GitHub org. OIDC IS the identity;
-- no client-side license keys. fair_use_cap is the monthly Worker
-- quota for paid orgs (default 5000 / 50000 / 1000000).
CREATE TABLE IF NOT EXISTS subscriptions (
  github_org              TEXT PRIMARY KEY,
  customer_email          TEXT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'cancelled' | 'past_due'
  plan                    TEXT NOT NULL DEFAULT 'pro',     -- 'pro' | 'team' | 'enterprise'
  fair_use_cap            BIGINT NOT NULL DEFAULT 5000,
  stripe_customer_id      TEXT,
  stripe_subscription_id  TEXT,
  created_at              BIGINT NOT NULL,
  updated_at              BIGINT NOT NULL,
  notes                   TEXT
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_email  ON subscriptions (customer_email);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions (status);

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

-- ---------- repo_stats_uploads ----------
-- Opt-in hosted analytics (Pro+). Append-only event log. Privacy
-- posture: NO source code, NO file contents, NO secrets. Only per-
-- detector counts, per-model rollup, sample file paths + line numbers
-- + plain-English summaries (bounded to 10 samples per detector by
-- repoStats.ts before send).
CREATE TABLE IF NOT EXISTS repo_stats_uploads (
  id              BIGSERIAL PRIMARY KEY,
  org             TEXT NOT NULL,
  repo            TEXT NOT NULL,
  uploaded_at     BIGINT NOT NULL,
  cli_version     TEXT NOT NULL,
  stats_json      JSONB NOT NULL,
  total_hits      BIGINT NOT NULL,
  by_model_json   JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_repo_stats_uploads_org_repo ON repo_stats_uploads (org, repo, uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_repo_stats_uploads_org      ON repo_stats_uploads (org, uploaded_at DESC);

ALTER TABLE repo_stats_uploads ENABLE ROW LEVEL SECURITY;

-- ---------- detector_model_rollup ----------
-- Denormalized rollup for cheap dashboard queries. Same Posthog /
-- Mixpanel pattern as repo_stats_uploads: append-only events + this
-- rollup table.
CREATE TABLE IF NOT EXISTS detector_model_rollup (
  org          TEXT NOT NULL,
  detector     TEXT NOT NULL,
  ai_model     TEXT NOT NULL,
  ai_tool      TEXT,
  hits         BIGINT NOT NULL DEFAULT 0,
  first_seen   BIGINT NOT NULL,
  last_seen    BIGINT NOT NULL,
  PRIMARY KEY (org, detector, ai_model)
);
CREATE INDEX IF NOT EXISTS idx_detector_model_rollup_org ON detector_model_rollup (org, detector);

ALTER TABLE detector_model_rollup ENABLE ROW LEVEL SECURITY;

-- ---------- pin_events ----------
-- Append-only event log for adoption analytics (R94 mirror).
-- ip_hash = SHA-256(ip + daily-salt). Never stores raw IPs.
CREATE TABLE IF NOT EXISTS pin_events (
  id            BIGSERIAL PRIMARY KEY,
  created_at    BIGINT NOT NULL,                -- unix ms
  ip_hash       TEXT NOT NULL,                  -- SHA-256(ip + daily salt)
  client_class  TEXT NOT NULL,                  -- 'cli' | 'mcp' | 'action' | 'web' | 'bot' | 'other'
  endpoint      TEXT NOT NULL,                  -- '/v1/extract' | ...
  repo          TEXT,                           -- '<org>/<repo>' when OIDC carries it
  cli_version   TEXT,                           -- from X-Pinned-Version or UA
  user_agent    TEXT,                           -- first 200 chars
  status_code   INTEGER NOT NULL                -- HTTP response code
);
CREATE INDEX IF NOT EXISTS idx_pin_events_created            ON pin_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pin_events_class_created      ON pin_events (client_class, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pin_events_endpoint_created   ON pin_events (endpoint, created_at DESC);

ALTER TABLE pin_events ENABLE ROW LEVEL SECURITY;

-- ---------- usage_snapshots ----------
-- Daily rollup. One row per UTC date. Computed by the daily cron at
-- 09:10 UTC by reading pin_events from the past 24h + 7d windows.
-- Per-class metrics carry raw calls AND unique-IPs AND top-IP-share
-- so dogfood-dominated classes (top_ip_share_pct > 50) are flagged.
CREATE TABLE IF NOT EXISTS usage_snapshots (
  snapshot_date              TEXT PRIMARY KEY,                  -- YYYY-MM-DD, UTC
  recorded_at                BIGINT NOT NULL,                   -- unix ms

  period_24h_events          BIGINT NOT NULL DEFAULT 0,
  period_24h_unique_ips      BIGINT NOT NULL DEFAULT 0,
  period_7d_events           BIGINT NOT NULL DEFAULT 0,
  period_7d_unique_ips       BIGINT NOT NULL DEFAULT 0,

  cli_calls_7d               BIGINT NOT NULL DEFAULT 0,
  cli_unique_ips_7d          BIGINT NOT NULL DEFAULT 0,
  cli_top_ip_share_pct       INTEGER NOT NULL DEFAULT 0,

  mcp_calls_7d               BIGINT NOT NULL DEFAULT 0,
  mcp_unique_ips_7d          BIGINT NOT NULL DEFAULT 0,
  mcp_top_ip_share_pct       INTEGER NOT NULL DEFAULT 0,

  action_calls_7d            BIGINT NOT NULL DEFAULT 0,
  action_unique_ips_7d       BIGINT NOT NULL DEFAULT 0,
  action_top_ip_share_pct    INTEGER NOT NULL DEFAULT 0,

  web_calls_7d               BIGINT NOT NULL DEFAULT 0,
  web_unique_ips_7d          BIGINT NOT NULL DEFAULT 0,
  web_top_ip_share_pct       INTEGER NOT NULL DEFAULT 0,

  bot_calls_7d               BIGINT NOT NULL DEFAULT 0,
  bot_unique_ips_7d          BIGINT NOT NULL DEFAULT 0,

  by_endpoint_json           JSONB NOT NULL DEFAULT '{}'::jsonb,

  source                     TEXT NOT NULL DEFAULT 'daily-cron' -- 'daily-cron' | 'backfill'
);
CREATE INDEX IF NOT EXISTS idx_usage_snapshots_date_desc ON usage_snapshots (snapshot_date DESC);

ALTER TABLE usage_snapshots ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE pin_events       IS 'Append-only event log for adoption analytics. Powers usage_snapshots.';
COMMENT ON TABLE usage_snapshots  IS 'Daily snapshot. Drives /admin/usage trend chart + WoW growth signal.';
