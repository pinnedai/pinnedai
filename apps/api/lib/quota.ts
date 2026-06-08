// Per-org monthly quota counter — Supabase port of apps/edge/src/quota.ts.
//
// Free tier: 100 calls/private-repo/mo, 500 calls/public-repo/mo,
// FREE_BUDGET_TOTAL_PER_MONTH as the aggregate solo-founder backstop.
// Paid tiers use subscriptions.fair_use_cap.
//
// extractOrg: GitHub OIDC's `repository` claim is "<owner>/<repo>";
// we bucket by owner so a free user can't spin up 5 repos for 5×
// quota.

import type { SupabaseClient } from "@supabase/supabase-js";

export type QuotaEnv = {
  FREE_QUOTA_PUBLIC_PER_MONTH?: string;
  FREE_QUOTA_PRIVATE_PER_MONTH?: string;
  FREE_QUOTA_PER_MONTH?: string;
  FREE_BUDGET_TOTAL_PER_MONTH?: string;
};

export function extractOrg(repository: string | undefined): string {
  if (!repository) return "";
  const slash = repository.indexOf("/");
  return slash > 0 ? repository.slice(0, slash) : repository;
}

function currentMonth(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7); // YYYY-MM
}

function resolveFreeCap(
  visibility: "public" | "private",
  env: QuotaEnv
): number {
  if (visibility === "public") {
    return parseInt(env.FREE_QUOTA_PUBLIC_PER_MONTH ?? "500", 10);
  }
  return parseInt(
    env.FREE_QUOTA_PRIVATE_PER_MONTH ?? env.FREE_QUOTA_PER_MONTH ?? "100",
    10
  );
}

export type QuotaCheckResult =
  | { ok: true; calls: number; limit: number; remaining: number }
  | { ok: false; reason: "over-quota"; calls: number; limit: number }
  | { ok: false; reason: "free-budget-exhausted"; total: number; cap: number };

// Atomically increments the (org, month) counter — UPSERT with
// row-level UPDATE so two concurrent callers don't both undercount.
// Returns { ok: true } when increment succeeded under the cap, or
// { ok: false } when over-cap. The over-cap path does NOT increment
// (so retries don't double-charge against the cap).
export async function checkAndIncrement(
  db: SupabaseClient,
  args: {
    org: string;
    visibility: "public" | "private";
    fairUseCap?: number; // paid plan override
    env: QuotaEnv;
    now?: Date;
  }
): Promise<QuotaCheckResult> {
  const now = args.now ?? new Date();
  const month = currentMonth(now);
  const cap =
    typeof args.fairUseCap === "number" && args.fairUseCap > 0
      ? args.fairUseCap
      : resolveFreeCap(args.visibility, args.env);

  // 1. Read current count.
  const { data: existing } = await db
    .from("quota")
    .select("calls")
    .eq("org", args.org)
    .eq("month", month)
    .maybeSingle();
  const current = existing?.calls ?? 0;

  // 2. Free-tier aggregate budget gate (paid orgs bypass).
  if (typeof args.fairUseCap !== "number") {
    const totalCap = parseInt(
      args.env.FREE_BUDGET_TOTAL_PER_MONTH ?? "100000",
      10
    );
    if (Number.isFinite(totalCap) && totalCap > 0) {
      const { data: totals } = await db
        .from("quota")
        .select("calls")
        .eq("month", month);
      const total = (totals ?? []).reduce(
        (acc, r) => acc + (r.calls ?? 0),
        0
      );
      if (total >= totalCap) {
        return { ok: false, reason: "free-budget-exhausted", total, cap: totalCap };
      }
    }
  }

  // 3. Per-org cap.
  if (current >= cap) {
    return { ok: false, reason: "over-quota", calls: current, limit: cap };
  }

  // 4. Increment (UPSERT). Postgres upsert is idempotent by primary key.
  const nextCalls = current + 1;
  const { error } = await db.from("quota").upsert(
    {
      org: args.org,
      month,
      calls: nextCalls,
      last_call_at: now.getTime(),
    },
    { onConflict: "org,month" }
  );
  if (error) {
    // Treat upsert failure as over-quota — better to fail closed
    // than double-bill OpenAI on a DB blip.
    return { ok: false, reason: "over-quota", calls: current, limit: cap };
  }
  return { ok: true, calls: nextCalls, limit: cap, remaining: cap - nextCalls };
}
