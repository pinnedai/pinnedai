// Subscription lookup — Supabase port of apps/edge/src/subscriptions.ts.

import type { SupabaseClient } from "@supabase/supabase-js";

export type Plan = "free" | "pro" | "team" | "enterprise";

export type Subscription = {
  github_org: string;
  customer_email: string;
  status: "active" | "cancelled" | "past_due";
  plan: "pro" | "team" | "enterprise";
  fair_use_cap: number;
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
  created_at: number;
  updated_at: number;
  notes?: string | null;
};

export async function validateSubscription(
  db: SupabaseClient,
  githubOrg: string
): Promise<Subscription | null> {
  const { data, error } = await db
    .from("subscriptions")
    .select("*")
    .eq("github_org", githubOrg.toLowerCase())
    .eq("status", "active")
    .maybeSingle();
  if (error || !data) return null;
  return data as Subscription;
}

export async function createSubscription(
  db: SupabaseClient,
  args: {
    githubOrg: string;
    customerEmail: string;
    plan: "pro" | "team" | "enterprise";
    fairUseCap?: number;
    stripeCustomerId?: string;
    stripeSubscriptionId?: string;
    notes?: string;
  }
): Promise<Subscription> {
  const now = Date.now();
  const fairUseCap =
    args.fairUseCap ??
    (args.plan === "team" ? 50_000 : args.plan === "enterprise" ? 1_000_000 : 5_000);
  const row: Subscription = {
    github_org: args.githubOrg.toLowerCase(),
    customer_email: args.customerEmail,
    status: "active",
    plan: args.plan,
    fair_use_cap: fairUseCap,
    stripe_customer_id: args.stripeCustomerId ?? null,
    stripe_subscription_id: args.stripeSubscriptionId ?? null,
    created_at: now,
    updated_at: now,
    notes: args.notes ?? null,
  };
  const { error } = await db
    .from("subscriptions")
    .upsert(row, { onConflict: "github_org" });
  if (error) throw new Error(`createSubscription: ${error.message}`);
  return row;
}
