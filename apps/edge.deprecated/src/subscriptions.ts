// Subscription lookup by GitHub org (extracted from OIDC). No license
// keys — the org IS the identity. Customer pays via Stripe + provides
// their GitHub org name on checkout; admin (or Stripe webhook in
// v0.1.2) creates a row in the subscriptions table.

import type { D1Database } from "@cloudflare/workers-types";

export type Subscription = {
  github_org: string;
  customer_email: string;
  status: "active" | "cancelled" | "past_due";
  plan: "pro" | "team" | "enterprise";
  fair_use_cap: number;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  created_at: number;
  updated_at: number;
  notes: string | null;
};

// Default fair-use caps per tier — bypass with admin notes.
const FAIR_USE_CAPS: Record<Subscription["plan"], number> = {
  pro: 5000,
  team: 50000,
  enterprise: 1_000_000,
};

export async function validateSubscription(
  db: D1Database,
  github_org: string
): Promise<Subscription | null> {
  if (!github_org || typeof github_org !== "string" || github_org.length === 0) {
    return null;
  }
  const row = await db
    .prepare(
      `SELECT * FROM subscriptions
       WHERE github_org = ? AND status = 'active'`
    )
    .bind(github_org)
    .first<Subscription>();
  return row ?? null;
}

export type CreateSubscriptionInput = {
  github_org: string;
  customer_email: string;
  plan?: Subscription["plan"];
  stripe_customer_id?: string;
  stripe_subscription_id?: string;
  notes?: string;
};

export async function createSubscription(
  db: D1Database,
  input: CreateSubscriptionInput
): Promise<Subscription> {
  // Lowercase the org for case-insensitive lookup — GitHub org names
  // are case-insensitive ("Acme" and "acme" are the same org).
  const github_org = input.github_org.toLowerCase().trim();
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(github_org)) {
    throw new Error(
      `Invalid GitHub org name '${input.github_org}'. Must match GitHub's username rules.`
    );
  }
  const now = Date.now();
  const plan = input.plan ?? "pro";
  const fair_use_cap = FAIR_USE_CAPS[plan];

  const sub: Subscription = {
    github_org,
    customer_email: input.customer_email,
    status: "active",
    plan,
    fair_use_cap,
    stripe_customer_id: input.stripe_customer_id ?? null,
    stripe_subscription_id: input.stripe_subscription_id ?? null,
    created_at: now,
    updated_at: now,
    notes: input.notes ?? null,
  };

  // ON CONFLICT DO UPDATE — re-subscribing an org (cancellation then
  // resubscribe, or plan upgrade) updates the row in place.
  await db
    .prepare(
      `INSERT INTO subscriptions
       (github_org, customer_email, status, plan, fair_use_cap,
        stripe_customer_id, stripe_subscription_id,
        created_at, updated_at, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(github_org) DO UPDATE SET
         customer_email = excluded.customer_email,
         status = excluded.status,
         plan = excluded.plan,
         fair_use_cap = excluded.fair_use_cap,
         stripe_customer_id = excluded.stripe_customer_id,
         stripe_subscription_id = excluded.stripe_subscription_id,
         updated_at = excluded.updated_at,
         notes = excluded.notes`
    )
    .bind(
      sub.github_org,
      sub.customer_email,
      sub.status,
      sub.plan,
      sub.fair_use_cap,
      sub.stripe_customer_id,
      sub.stripe_subscription_id,
      sub.created_at,
      sub.updated_at,
      sub.notes
    )
    .run();

  return sub;
}
