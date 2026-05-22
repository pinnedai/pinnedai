// Per-org monthly LLM-call quota counter in D1.
//
// One row per (org, month). Counter increments on every cache-MISS
// LLM call. Cache hits don't bill — see `cache.ts`.
//
// Free tier: 500 calls/mo on public repos, 100/mo on private. Paid
// tiers use subscriptions.fair_use_cap (5K Pro / 50K Team / 1M Ent).
// Bucketing at the org level (not the repo level) prevents the
// spin-up-many-repos-to-multiply-the-quota game.

import type { D1Database } from "@cloudflare/workers-types";

export type QuotaResult =
  | { ok: true; calls: number; limit: number; remaining: number }
  | { ok: false; reason: "monthly-quota"; calls: number; limit: number };

export async function checkAndIncrement(
  db: D1Database,
  opts: { org: string; monthlyLimit: number }
): Promise<QuotaResult> {
  const month = currentMonthUTC();
  const now = Date.now();

  await db
    .prepare(
      `INSERT INTO quota (org, month, calls, last_call_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(org, month)
       DO UPDATE SET calls = calls + 1, last_call_at = ?`
    )
    .bind(opts.org, month, now, now)
    .run();

  const row = await db
    .prepare(`SELECT calls FROM quota WHERE org = ? AND month = ?`)
    .bind(opts.org, month)
    .first<{ calls: number }>();

  const calls = row?.calls ?? 1;
  if (calls > opts.monthlyLimit) {
    return {
      ok: false,
      reason: "monthly-quota",
      calls,
      limit: opts.monthlyLimit,
    };
  }
  return {
    ok: true,
    calls,
    limit: opts.monthlyLimit,
    remaining: opts.monthlyLimit - calls,
  };
}

// Extract the org/owner from a `repository` OIDC claim like
// "mzon7/quantasyte" → "mzon7". GitHub repo names can't contain `/`
// so the first segment is always the owner.
export function extractOrg(repository: string): string {
  const idx = repository.indexOf("/");
  return idx === -1 ? repository : repository.slice(0, idx);
}

// Aggregate free-tier monthly cap check. Sums calls across all free-tier
// orgs (anything NOT in the subscriptions table) for the current UTC
// month and refuses new calls if the total exceeds the configured
// budget. This is the hard cost ceiling — without it, growth in
// org count would scale OpenAI spend without bound.
export async function checkAggregateBudget(
  db: D1Database,
  capCalls: number
): Promise<{ ok: true; total: number } | { ok: false; total: number }> {
  const month = currentMonthUTC();
  // Free orgs = orgs not in subscriptions (or with non-active status).
  // We sum their calls for the current month.
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(q.calls), 0) AS total
       FROM quota q
       WHERE q.month = ?
         AND q.org NOT IN (
           SELECT github_org FROM subscriptions WHERE status = 'active'
         )`
    )
    .bind(month)
    .first<{ total: number }>();
  const total = row?.total ?? 0;
  if (total >= capCalls) {
    return { ok: false, total };
  }
  return { ok: true, total };
}

function currentMonthUTC(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
