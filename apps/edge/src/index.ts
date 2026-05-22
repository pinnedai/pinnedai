// pinnedai-edge — hosted Worker for keyless LLM claim extraction.
//
// Free-tier request flow (POST /v1/extract):
//   1. Cheap reject: missing Bearer header
//   2. Read raw body, enforce byte-length cap
//   3. Parse JSON
//   4. Validate OIDC JWT, extract github_org from repository_owner
//   5. Subscription lookup by github_org — Pro orgs get higher cap
//   6. SHA-256(body) → cache check; cache hit returns instantly
//   7. Cache miss → quota check (per-org monthly counter)
//   8. Call OpenAI gpt-4o-mini with constrained-extraction prompt
//   9. Store in cache; return { claims, plan, quota }
//
// Identity = GitHub org via OIDC. No license keys, no API keys.

import type { D1Database } from "@cloudflare/workers-types";
import { validateGithubOidc } from "./jwt.js";
import { checkAndIncrement, checkAggregateBudget, extractOrg } from "./quota.js";
import { extractClaimsLLM } from "./openai.js";
import { hashBody, getCached, setCached } from "./cache.js";
import { validateSubscription, createSubscription } from "./subscriptions.js";
import { handleBadge } from "./badge.js";

export type Env = {
  QUOTA: D1Database;
  OPENAI_API_KEY: string;
  ADMIN_KEY: string;
  FREE_QUOTA_PER_MONTH: string;
  FREE_QUOTA_PUBLIC_PER_MONTH?: string;
  FREE_QUOTA_PRIVATE_PER_MONTH?: string;
  // Aggregate hard cap across all free-tier orgs combined. Bounds
  // monthly OpenAI spend regardless of growth.
  FREE_BUDGET_TOTAL_PER_MONTH?: string;
  GITHUB_JWKS_URL: string;
  OIDC_AUDIENCE: string;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/healthz") {
      return json({ ok: true, service: "pinnedai-edge" });
    }

    if (request.method === "GET" && url.pathname.startsWith("/badge/")) {
      return handleBadge(request);
    }

    if (request.method === "GET" && url.pathname === "/admin/stats") {
      return handleAdminStats(request, env);
    }

    if (request.method === "POST" && url.pathname === "/admin/subscription") {
      return handleAdminCreateSubscription(request, env);
    }

    if (request.method === "POST" && url.pathname === "/v1/extract") {
      return handleExtract(request, env);
    }

    if (request.method === "POST" && url.pathname === "/v1/plan") {
      return handlePlanCheck(request, env);
    }

    if (request.method === "POST" && url.pathname === "/v1/summarize") {
      return handleSummarize(request, env);
    }

    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;

async function handleExtract(request: Request, env: Env): Promise<Response> {
  // Cheapest reject first — auth header presence + format.
  const auth = request.headers.get("Authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return json({ error: "missing bearer token" }, 401);

  // Read raw body BEFORE any expensive op. Enforce 50KB byte cap on
  // raw text so a multibyte payload can't sneak past UTF-16 length.
  const raw = await request.text();
  const byteLen = new TextEncoder().encode(raw).byteLength;
  if (byteLen > 50_000) {
    return json({ error: "body too large (max 50KB)" }, 413);
  }
  let body: { body?: string };
  try {
    body = JSON.parse(raw) as { body?: string };
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  if (!body.body || typeof body.body !== "string") {
    return json({ error: "missing 'body' field" }, 400);
  }

  // OIDC validation
  let oidc;
  try {
    oidc = await validateGithubOidc(m[1], {
      jwksUrl: env.GITHUB_JWKS_URL,
      expectedAudience: env.OIDC_AUDIENCE,
    });
  } catch (e) {
    return json({ error: "oidc validation failed", detail: String(e) }, 401);
  }
  const repository = oidc.repository;
  const org = (oidc.repository_owner || extractOrg(repository)).toLowerCase();
  const isPublicRepo = oidc.repository_visibility === "public";

  // Subscription lookup by GitHub org (no license header anymore).
  const subscription = await validateSubscription(env.QUOTA, org);
  const plan = subscription?.plan ?? "free";
  const isPaid = !!subscription;

  // Cache check — hit = free, doesn't bill quota (any plan)
  const hash = await hashBody(body.body);
  const cached = await getCached(env.QUOTA, hash);
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

  // Cache miss → quota check (two-stage for free tier):
  //   1. Per-org cap (generous, rarely hit by real users)
  //   2. Aggregate Worker cap (hard cost ceiling — protects solo
  //      founder's OpenAI budget from runaway growth)
  // Paid tier bypasses both — subscription.fair_use_cap is the single
  // gate, and paid customers' usage doesn't count against the free
  // aggregate budget.
  const freePublicLimit = Number(env.FREE_QUOTA_PUBLIC_PER_MONTH) || 500;
  const freePrivateLimit =
    Number(env.FREE_QUOTA_PRIVATE_PER_MONTH) ||
    Number(env.FREE_QUOTA_PER_MONTH) ||
    100;
  const monthlyLimit = isPaid
    ? subscription.fair_use_cap
    : isPublicRepo
      ? freePublicLimit
      : freePrivateLimit;

  // Aggregate-budget check (only for free tier). One D1 read per call.
  if (!isPaid) {
    const aggCap = Number(env.FREE_BUDGET_TOTAL_PER_MONTH) || 100_000;
    const aggCheck = await checkAggregateBudget(env.QUOTA, aggCap);
    if (!aggCheck.ok) {
      // Solo-founder-authentic message. Authenticity in error messages
      // is rare and memorable — this is a marketing surface too, not
      // just a 429.
      const honestMessage = [
        "Pinned's free tier hit its monthly cap.",
        "",
        "I'm a solo dev growing this in public, so the cap is conservative right now.",
        `Free tier used: ${aggCheck.total.toLocaleString()} / ${aggCap.toLocaleString()} LLM calls.`,
        "",
        "Three ways to keep going this month:",
        "  1. Upgrade to Pro ($19/mo, 5,000 calls, supports the project directly)",
        "  2. Set BYOK — use your own Anthropic/OpenAI key (you pay your provider, no Pinned-side cap)",
        "  3. Wait until the 1st of next month",
        "",
        "I'd rather shut off the free tier mid-month than push myself into a budget I can't sustain.",
        "Free cap goes up as the project grows. Thanks for understanding.",
        "",
        "— Michael",
      ].join("\n");
      return json(
        {
          error: "free tier at monthly capacity",
          message: honestMessage,
          totalCallsThisMonth: aggCheck.total,
          totalCap: aggCap,
          upgrade: "https://pinnedai.dev/pricing",
          byok: "https://pinnedai.dev/docs/byok",
        },
        429
      );
    }
  }
  const quota = await checkAndIncrement(env.QUOTA, {
    org,
    monthlyLimit,
  });
  if (!quota.ok) {
    // Free tier exhausted → two paths to keep using Pinned:
    //   1. Upgrade to Pro ($19/mo) — 5,000 calls + features
    //   2. Set BYOK (your own Anthropic/OpenAI key) — your provider,
    //      your cost, no Pinned-side cap
    // Pro/Team/Enterprise exhausted → upgrade to next tier
    const message = isPaid
      ? `Monthly fair-use cap reached on ${plan} (${quota.calls}/${quota.limit}). Upgrade to the next tier or wait until next month.`
      : `Free tier cap reached (${quota.calls}/${quota.limit} for ${isPublicRepo ? "public" : "private"} repos this month). To keep going: upgrade to Pro ($19/mo, 5,000 calls) OR set BYOK (your own provider key, no Pinned-side cap). Free quota resets on the 1st.`;
    return json(
      {
        error: "monthly quota exceeded",
        message,
        org,
        repository,
        plan,
        visibility: oidc.repository_visibility ?? "unknown",
        calls: quota.calls,
        limit: quota.limit,
        upgrade: isPaid
          ? "https://pinnedai.dev/pricing#team"
          : "https://pinnedai.dev/pricing",
        byok: isPaid
          ? undefined
          : "https://pinnedai.dev/docs/byok",
      },
      429
    );
  }

  // LLM extraction
  let extracted;
  try {
    extracted = await extractClaimsLLM(env.OPENAI_API_KEY, body.body);
  } catch (e) {
    return json({ error: "llm extraction failed", detail: String(e) }, 502);
  }

  // Store in cache
  await setCached(env.QUOTA, hash, extracted);

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

// Cheap plan-check endpoint for BYOK customers. OIDC validates → org
// → subscription lookup → return plan. No LLM call, no quota burn, no
// body parsing. Lets the CLI ask "am I paid?" before deciding whether
// to route the PR body through us or call the provider directly.
async function handlePlanCheck(
  request: Request,
  env: Env
): Promise<Response> {
  const auth = request.headers.get("Authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return json({ error: "missing bearer token" }, 401);

  let oidc;
  try {
    oidc = await validateGithubOidc(m[1], {
      jwksUrl: env.GITHUB_JWKS_URL,
      expectedAudience: env.OIDC_AUDIENCE,
    });
  } catch (e) {
    return json({ error: "oidc validation failed", detail: String(e) }, 401);
  }
  const repository = oidc.repository;
  const org = (oidc.repository_owner || extractOrg(repository)).toLowerCase();
  const subscription = await validateSubscription(env.QUOTA, org);
  const plan = subscription?.plan ?? "free";
  return json({ org, repository, plan });
}

// Tiny LLM summary of deterministic Safety Pass findings. Input is a
// COMPACT JSON of findings (no diff, no source). Output is a short
// markdown summary suitable for terminal / PR-comment display.
//
// Counts against the org's monthly LLM quota (same as /v1/extract),
// uses the cache to deduplicate identical findings JSONs.
async function handleSummarize(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get("Authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return json({ error: "missing bearer token" }, 401);

  const raw = await request.text();
  const byteLen = new TextEncoder().encode(raw).byteLength;
  if (byteLen > 50_000) {
    return json({ error: "body too large (max 50KB)" }, 413);
  }
  let body: { findings?: Array<{ rule: string; severity: string; file: string; message: string }>; counts?: { warn: number; info: number } };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  if (!body.findings || !Array.isArray(body.findings)) {
    return json({ error: "missing 'findings' array" }, 400);
  }

  let oidc;
  try {
    oidc = await validateGithubOidc(m[1], {
      jwksUrl: env.GITHUB_JWKS_URL,
      expectedAudience: env.OIDC_AUDIENCE,
    });
  } catch (e) {
    return json({ error: "oidc validation failed", detail: String(e) }, 401);
  }
  const org = (oidc.repository_owner || extractOrg(oidc.repository)).toLowerCase();
  const isPublicRepo = oidc.repository_visibility === "public";
  const subscription = await validateSubscription(env.QUOTA, org);
  const plan = subscription?.plan ?? "free";
  const isPaid = !!subscription;

  // Cache by SHA-256 of the compact findings — identical findings
  // produce identical summaries, no need to re-call OpenAI.
  const hash = await hashBody(raw);
  const cached = await getCached(env.QUOTA, hash);
  if (cached) {
    // We store the previous summary in the same cache table. The
    // value shape differs from /v1/extract claims, so we detect by
    // presence of a string field at index 0 keyed "markdown".
    const stashed = cached as unknown as { markdown?: string }[];
    if (stashed[0]?.markdown) {
      return json({
        markdown: stashed[0].markdown,
        org,
        plan,
        cached: true,
      });
    }
  }

  // Aggregate cap + per-org cap (same logic as /v1/extract)
  if (!isPaid) {
    const aggCap = Number(env.FREE_BUDGET_TOTAL_PER_MONTH) || 100_000;
    const aggCheck = await checkAggregateBudget(env.QUOTA, aggCap);
    if (!aggCheck.ok) {
      return json(
        {
          error: "free tier at monthly capacity",
          message: `Pinned's free tier reached its monthly aggregate cap. Upgrade or wait until next month.`,
          totalCallsThisMonth: aggCheck.total,
          totalCap: aggCap,
        },
        429
      );
    }
  }
  const freePublicLimit = Number(env.FREE_QUOTA_PUBLIC_PER_MONTH) || 500;
  const freePrivateLimit =
    Number(env.FREE_QUOTA_PRIVATE_PER_MONTH) ||
    Number(env.FREE_QUOTA_PER_MONTH) ||
    100;
  const monthlyLimit = isPaid
    ? subscription.fair_use_cap
    : isPublicRepo
      ? freePublicLimit
      : freePrivateLimit;
  const quota = await checkAndIncrement(env.QUOTA, { org, monthlyLimit });
  if (!quota.ok) {
    return json(
      { error: "monthly quota exceeded", calls: quota.calls, limit: quota.limit },
      429
    );
  }

  // Call OpenAI with the COMPACT findings JSON — never source/diff.
  const systemPrompt = `You are summarizing the results of a pinnedai Safety Pass. The input is a JSON array of findings produced by a deterministic static scan. Produce a TIGHT 3-bullet markdown summary:

- bullet 1: what category of issue dominates (env vars / secrets / SQL / CORS / etc.)
- bullet 2: the single most important finding to look at first
- bullet 3: a one-sentence suggestion for the developer's next action

Do not invent findings. Do not give style or architecture opinions. Do not list every finding. Maximum 3 bullets, under 60 words total.`;
  const userPrompt = `Findings: ${JSON.stringify(body.findings.slice(0, 30))}\nCounts: ${JSON.stringify(body.counts ?? {})}`;

  let markdown: string;
  try {
    const llmRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0,
        max_tokens: 200,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    if (!llmRes.ok) {
      const detail = await llmRes.text().catch(() => "");
      return json(
        { error: "llm summarize failed", detail: detail.slice(0, 200) },
        502
      );
    }
    const data = (await llmRes.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    markdown = data.choices?.[0]?.message?.content?.trim() ?? "";
    if (!markdown) {
      return json({ error: "llm returned empty content" }, 502);
    }
  } catch (e) {
    return json({ error: "llm call exception", detail: String(e) }, 502);
  }

  // Cache the summary under the same content_hash key. We store it
  // shaped like a Claim array with a single object so getCached's
  // existing type can deserialize it. Consumers detect via the
  // markdown field.
  await setCached(env.QUOTA, hash, [
    { markdown } as unknown as Parameters<typeof setCached>[2][number],
  ]);

  return json({
    markdown,
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

async function handleAdminStats(
  request: Request,
  env: Env
): Promise<Response> {
  if (!checkAdminAuth(request, env)) {
    return json({ error: "unauthorized" }, 401);
  }

  const month = `${new Date().getUTCFullYear()}-${String(
    new Date().getUTCMonth() + 1
  ).padStart(2, "0")}`;

  const total = await env.QUOTA.prepare(
    `SELECT COUNT(DISTINCT org) as orgs, COALESCE(SUM(calls), 0) as calls
     FROM quota WHERE month = ?`
  )
    .bind(month)
    .first<{ orgs: number; calls: number }>();

  const top = await env.QUOTA.prepare(
    `SELECT org, calls FROM quota WHERE month = ? ORDER BY calls DESC LIMIT 10`
  )
    .bind(month)
    .all<{ org: string; calls: number }>();

  const cacheStats = await env.QUOTA.prepare(
    `SELECT COUNT(*) as size FROM extraction_cache WHERE expires_at > ?`
  )
    .bind(Date.now())
    .first<{ size: number }>();

  const subStats = await env.QUOTA.prepare(
    `SELECT plan, COUNT(*) as count
     FROM subscriptions
     WHERE status = 'active'
     GROUP BY plan`
  ).all<{ plan: string; count: number }>();

  const totalCalls = total?.calls ?? 0;
  const estimatedCost = (totalCalls * 0.001).toFixed(2);
  const limit = Number(env.FREE_QUOTA_PER_MONTH) || 100;

  return json({
    month,
    activeOrgs: total?.orgs ?? 0,
    totalCalls,
    estimatedOpenAICost: `$${estimatedCost}`,
    freeMonthlyLimit: limit,
    cachedHashes: cacheStats?.size ?? 0,
    topConsumers: top?.results ?? [],
    activeSubscriptions: subStats?.results ?? [],
    timestamp: new Date().toISOString(),
  });
}

async function handleAdminCreateSubscription(
  request: Request,
  env: Env
): Promise<Response> {
  if (!checkAdminAuth(request, env)) {
    return json({ error: "unauthorized" }, 401);
  }
  let body: {
    github_org?: string;
    customer_email?: string;
    plan?: "pro" | "team" | "enterprise";
    stripe_customer_id?: string;
    stripe_subscription_id?: string;
    notes?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  if (!body.github_org) {
    return json({ error: "github_org required" }, 400);
  }
  if (!body.customer_email) {
    return json({ error: "customer_email required" }, 400);
  }

  let sub;
  try {
    sub = await createSubscription(env.QUOTA, {
      github_org: body.github_org,
      customer_email: body.customer_email,
      plan: body.plan,
      stripe_customer_id: body.stripe_customer_id,
      stripe_subscription_id: body.stripe_subscription_id,
      notes: body.notes,
    });
  } catch (e) {
    return json({ error: String(e) }, 400);
  }

  return json(
    {
      subscription: sub,
      setup: {
        instructions: `${sub.github_org}'s next PR will activate ${sub.plan} features automatically. No customer-side setup required.`,
      },
    },
    201
  );
}

function checkAdminAuth(request: Request, env: Env): boolean {
  // Header-only — query params leak through history/logs/copied URLs.
  const headerKey = request.headers.get("X-Admin-Key");
  if (headerKey && headerKey === env.ADMIN_KEY) return true;

  const auth = request.headers.get("Authorization") ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  if (bearer && bearer[1] === env.ADMIN_KEY) return true;

  return false;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
