// Shared business-logic handlers — Supabase port of the inline
// handlers in apps/edge/src/index.ts. Each is called from a thin
// api/<route>.ts adapter that supplies the env + Supabase client.

import type { SupabaseClient } from "@supabase/supabase-js";
import { validateGithubOidc } from "./jwt.js";
import { extractClaimsLLM } from "./openai.js";
import { checkAndIncrement, extractOrg } from "./quota.js";
import { hashBody, getCached, setCached } from "./cache.js";
import { validateSubscription, createSubscription } from "./subscriptions.js";
import { computeSnapshot, writeSnapshot, readWoW } from "./usageLog.js";
import { json } from "./response.js";

export type ApiEnv = {
  OPENAI_API_KEY?: string;
  ADMIN_KEY?: string;
  GITHUB_JWKS_URL?: string;
  OIDC_AUDIENCE?: string;
  FREE_QUOTA_PUBLIC_PER_MONTH?: string;
  FREE_QUOTA_PRIVATE_PER_MONTH?: string;
  FREE_QUOTA_PER_MONTH?: string;
  FREE_BUDGET_TOTAL_PER_MONTH?: string;
  CRON_SECRET?: string;
};

const DEFAULT_JWKS_URL = "https://token.actions.githubusercontent.com/.well-known/jwks";
const DEFAULT_OIDC_AUDIENCE = "pinnedai";

export async function handleExtract(
  request: Request,
  env: ApiEnv,
  db: SupabaseClient
): Promise<Response> {
  const auth = request.headers.get("Authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return json({ error: "missing bearer token" }, 401);

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > 50_000) {
    return json({ error: "body too large (max 50KB)" }, 413);
  }
  let body: { body?: string };
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  if (!body.body || typeof body.body !== "string") {
    return json({ error: "missing 'body' field" }, 400);
  }

  let oidc: Awaited<ReturnType<typeof validateGithubOidc>>;
  try {
    oidc = await validateGithubOidc(m[1], {
      jwksUrl: env.GITHUB_JWKS_URL ?? DEFAULT_JWKS_URL,
      expectedAudience: env.OIDC_AUDIENCE ?? DEFAULT_OIDC_AUDIENCE,
    });
  } catch (e) {
    return json({ error: "oidc validation failed", detail: String(e) }, 401);
  }
  const repository = oidc.repository ?? "";
  const org = (oidc.repository_owner || extractOrg(repository)).toLowerCase();
  const isPublicRepo = oidc.repository_visibility === "public";

  const subscription = await validateSubscription(db, org);
  const plan = subscription?.plan ?? "free";

  // Cache check (free).
  const hash = await hashBody(body.body);
  const cached = await getCached(db, hash);
  if (cached) {
    return json({
      claims: cached,
      repository,
      org,
      plan,
      visibility: oidc.repository_visibility ?? "unknown",
      cached: true,
    });
  }

  // Quota check + increment.
  const quota = await checkAndIncrement(db, {
    org,
    visibility: isPublicRepo ? "public" : "private",
    fairUseCap: subscription?.fair_use_cap,
    env,
  });
  if (!quota.ok) {
    if (quota.reason === "free-budget-exhausted") {
      return json(
        {
          error: "free tier at monthly capacity",
          message:
            "Pinned's free tier hit its monthly aggregate cap. Upgrade to Pro ($19/mo, 5000 calls), set BYOK, or wait until next month.",
          totalCallsThisMonth: quota.total,
          totalCap: quota.cap,
          upgrade: "https://pinnedai.dev/pricing",
          byok: "https://pinnedai.dev/docs/byok",
        },
        429
      );
    }
    const isPaid = !!subscription;
    return json(
      {
        error: "monthly quota exceeded",
        message: isPaid
          ? `Monthly fair-use cap reached on ${plan} (${quota.calls}/${quota.limit}). Upgrade or wait.`
          : `Free tier cap reached (${quota.calls}/${quota.limit}). Upgrade Pro or set BYOK.`,
        org,
        repository,
        plan,
        calls: quota.calls,
        limit: quota.limit,
        upgrade: "https://pinnedai.dev/pricing",
        byok: "https://pinnedai.dev/docs/byok",
      },
      429
    );
  }

  // LLM call.
  if (!env.OPENAI_API_KEY) {
    return json({ error: "server misconfigured: OPENAI_API_KEY missing" }, 500);
  }
  let extracted: unknown[];
  try {
    extracted = await extractClaimsLLM(env.OPENAI_API_KEY, body.body);
  } catch (e) {
    return json({ error: "llm extraction failed", detail: String(e) }, 502);
  }

  await setCached(db, hash, extracted);

  return json({
    claims: extracted,
    repository,
    org,
    plan,
    visibility: oidc.repository_visibility ?? "unknown",
    cached: false,
    quota: {
      calls: quota.calls,
      limit: quota.limit,
      remaining: quota.remaining,
    },
  });
}

export async function handlePlanCheck(
  request: Request,
  env: ApiEnv,
  db: SupabaseClient
): Promise<Response> {
  const auth = request.headers.get("Authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return json({ error: "missing bearer token" }, 401);

  let oidc: Awaited<ReturnType<typeof validateGithubOidc>>;
  try {
    oidc = await validateGithubOidc(m[1], {
      jwksUrl: env.GITHUB_JWKS_URL ?? DEFAULT_JWKS_URL,
      expectedAudience: env.OIDC_AUDIENCE ?? DEFAULT_OIDC_AUDIENCE,
    });
  } catch (e) {
    return json({ error: "oidc validation failed", detail: String(e) }, 401);
  }
  const repository = oidc.repository ?? "";
  const org = (oidc.repository_owner || extractOrg(repository)).toLowerCase();
  const subscription = await validateSubscription(db, org);
  const plan = subscription?.plan ?? "free";
  return json({ org, repository, plan });
}

export async function handleSummarize(
  request: Request,
  env: ApiEnv,
  db: SupabaseClient
): Promise<Response> {
  const auth = request.headers.get("Authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return json({ error: "missing bearer token" }, 401);

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > 50_000) {
    return json({ error: "body too large (max 50KB)" }, 413);
  }
  type SummarizeBody = {
    findings?: Array<{ rule: string; severity: string; file: string; message: string }>;
    counts?: { warn: number; info: number };
  };
  let body: SummarizeBody;
  try {
    body = JSON.parse(raw) as SummarizeBody;
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  if (!body.findings || !Array.isArray(body.findings)) {
    return json({ error: "missing 'findings' array" }, 400);
  }

  let oidc: Awaited<ReturnType<typeof validateGithubOidc>>;
  try {
    oidc = await validateGithubOidc(m[1], {
      jwksUrl: env.GITHUB_JWKS_URL ?? DEFAULT_JWKS_URL,
      expectedAudience: env.OIDC_AUDIENCE ?? DEFAULT_OIDC_AUDIENCE,
    });
  } catch (e) {
    return json({ error: "oidc validation failed", detail: String(e) }, 401);
  }
  const org = (oidc.repository_owner || extractOrg(oidc.repository ?? "")).toLowerCase();
  const isPublicRepo = oidc.repository_visibility === "public";
  const subscription = await validateSubscription(db, org);
  const plan = subscription?.plan ?? "free";

  // Cache by SHA-256 of raw findings.
  const hash = await hashBody(raw);
  const cached = await getCached(db, hash);
  if (cached) {
    const stashed = cached as unknown as { markdown?: string }[];
    if (stashed[0]?.markdown) {
      return json({ markdown: stashed[0].markdown, org, plan, cached: true });
    }
  }

  const quota = await checkAndIncrement(db, {
    org,
    visibility: isPublicRepo ? "public" : "private",
    fairUseCap: subscription?.fair_use_cap,
    env,
  });
  if (!quota.ok) {
    return json({ error: "monthly quota exceeded", reason: quota.reason }, 429);
  }

  // OpenAI call to summarize.
  if (!env.OPENAI_API_KEY) {
    return json({ error: "server misconfigured: OPENAI_API_KEY missing" }, 500);
  }
  const prompt = [
    "You are a code-quality assistant. Below is a JSON array of findings",
    "from a static Safety Pass. Summarize in <=120 words of plain markdown.",
    "Group by severity. Don't repeat the JSON; describe what each finding implies.",
    "",
    JSON.stringify(body, null, 2),
  ].join("\n");
  let markdown: string;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_tokens: 400,
      }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    markdown = (data.choices?.[0]?.message?.content ?? "").trim();
  } catch (e) {
    return json({ error: "llm summarize failed", detail: String(e) }, 502);
  }
  await setCached(db, hash, [{ markdown } as unknown as Record<string, unknown>]);
  return json({ markdown, org, plan, cached: false });
}

export async function handleAdminUsage(
  request: Request,
  env: ApiEnv,
  db: SupabaseClient
): Promise<Response> {
  const auth = request.headers.get("authorization") ?? "";
  if (!env.ADMIN_KEY || auth !== `Bearer ${env.ADMIN_KEY}`) {
    return json({ error: "unauthorized" }, 401);
  }
  const today = new Date().toISOString().slice(0, 10);
  const wow = await readWoW(db, today);
  const { data: recent } = await db
    .from("usage_snapshots")
    .select("*")
    .order("snapshot_date", { ascending: false })
    .limit(14);
  return json({ today: wow, recent: recent ?? [] });
}

export async function handleAdminSnapshot(
  request: Request,
  env: ApiEnv,
  db: SupabaseClient
): Promise<Response> {
  const auth = request.headers.get("authorization") ?? "";
  if (!env.ADMIN_KEY || auth !== `Bearer ${env.ADMIN_KEY}`) {
    return json({ error: "unauthorized" }, 401);
  }
  const url = new URL(request.url);
  const dateParam = url.searchParams.get("date");
  const endTs = dateParam
    ? new Date(dateParam + "T00:00:00Z").getTime() + 86400_000
    : Date.now();
  const source = dateParam ? "backfill" : "daily-cron";
  const snap = await computeSnapshot(db, endTs);
  await writeSnapshot(db, snap, source, Date.now());
  return json({ ok: true, snapshot: snap });
}

export async function handleCronSnapshot(
  request: Request,
  env: ApiEnv,
  db: SupabaseClient
): Promise<Response> {
  // Vercel cron sends `Authorization: Bearer <CRON_SECRET>` when the
  // env var is set. We honor both that AND the ADMIN_KEY for ad-hoc
  // re-runs.
  const auth = request.headers.get("authorization") ?? "";
  const allowed =
    (env.CRON_SECRET && auth === `Bearer ${env.CRON_SECRET}`) ||
    (env.ADMIN_KEY && auth === `Bearer ${env.ADMIN_KEY}`);
  if (!allowed) return json({ error: "unauthorized" }, 401);
  const now = Date.now();
  const snap = await computeSnapshot(db, now);
  await writeSnapshot(db, snap, "daily-cron", now);
  return json({ ok: true, snapshot: snap });
}

export async function handleAdminSubscription(
  request: Request,
  env: ApiEnv,
  db: SupabaseClient
): Promise<Response> {
  const auth = request.headers.get("authorization") ?? "";
  if (!env.ADMIN_KEY || auth !== `Bearer ${env.ADMIN_KEY}`) {
    return json({ error: "unauthorized" }, 401);
  }
  type CreateBody = {
    githubOrg?: string;
    customerEmail?: string;
    plan?: "pro" | "team" | "enterprise";
    fairUseCap?: number;
    stripeCustomerId?: string;
    stripeSubscriptionId?: string;
    notes?: string;
  };
  let body: CreateBody;
  try {
    body = (await request.json()) as CreateBody;
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  if (!body.githubOrg || !body.customerEmail) {
    return json({ error: "missing githubOrg or customerEmail" }, 400);
  }
  const sub = await createSubscription(db, {
    githubOrg: body.githubOrg,
    customerEmail: body.customerEmail,
    plan: body.plan ?? "pro",
    fairUseCap: body.fairUseCap,
    stripeCustomerId: body.stripeCustomerId,
    stripeSubscriptionId: body.stripeSubscriptionId,
    notes: body.notes,
  });
  return json({ ok: true, subscription: sub });
}

export async function handleAdminStats(
  request: Request,
  env: ApiEnv,
  db: SupabaseClient
): Promise<Response> {
  const auth = request.headers.get("authorization") ?? "";
  if (!env.ADMIN_KEY || auth !== `Bearer ${env.ADMIN_KEY}`) {
    return json({ error: "unauthorized" }, 401);
  }
  const month = new Date().toISOString().slice(0, 7);
  const { data: rows } = await db.from("quota").select("org, calls").eq("month", month);
  const total = (rows ?? []).reduce((acc, r) => acc + (r.calls ?? 0), 0);
  return json({ month, total_calls: total, by_org: rows ?? [] });
}
