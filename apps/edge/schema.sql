-- pinnedai-edge D1 schema.
--
-- Monthly LLM-call quota — one row per (org, month). The CLI imposes
-- NO pin-count cap; the cost gate is monthly LLM calls, metered here.
-- Free tier: 500 calls/mo on public repos, 100 calls/mo on private,
-- with FREE_BUDGET_TOTAL_PER_MONTH as an aggregate solo-founder
-- backstop. Paid tiers use subscriptions.fair_use_cap (5K / 50K / 1M).
-- "Org" is the prefix of the `repository` OIDC claim
-- ("mzon7/quantasyte" → "mzon7"). Bucketing by org prevents the
-- "spin up 5 free repos for 5× quota" game.
CREATE TABLE IF NOT EXISTS quota (
  org TEXT NOT NULL,
  month TEXT NOT NULL,   -- YYYY-MM, UTC
  calls INTEGER NOT NULL DEFAULT 0,
  last_call_at INTEGER NOT NULL,  -- unix ms
  PRIMARY KEY (org, month)
);
CREATE INDEX IF NOT EXISTS idx_quota_month ON quota (month);

-- Extraction cache — SHA-256(body) → cached Claim[]. 90-day TTL.
-- Cache hits return cached claims without billing the quota — so a PR
-- that's pushed 20 times only counts as 1 call. 90 days because PR
-- descriptions don't change retroactively after merge.
CREATE TABLE IF NOT EXISTS extraction_cache (
  content_hash TEXT PRIMARY KEY,  -- hex SHA-256 of the PR body
  claims TEXT NOT NULL,           -- JSON-serialized Claim[]
  cached_at INTEGER NOT NULL,     -- unix ms
  expires_at INTEGER NOT NULL     -- unix ms
);
CREATE INDEX IF NOT EXISTS idx_extraction_cache_expires ON extraction_cache (expires_at);

-- Pro/Team/Enterprise subscriptions, keyed by GitHub org. Customer
-- pays via Stripe + provides their GitHub org name on checkout. Worker
-- extracts the org from the OIDC `repository_owner` claim and looks it
-- up here on every /v1/extract call. No client-side license keys —
-- OIDC IS the identity. fair_use_cap is the per-month Worker quota
-- (default 5000 for Pro; bumped per-tier).
CREATE TABLE IF NOT EXISTS subscriptions (
  github_org TEXT PRIMARY KEY,
  customer_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'cancelled' | 'past_due'
  plan TEXT NOT NULL DEFAULT 'pro',       -- 'pro' | 'team' | 'enterprise'
  fair_use_cap INTEGER NOT NULL DEFAULT 5000,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_email ON subscriptions (customer_email);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions (status);
