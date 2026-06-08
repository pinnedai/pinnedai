// Hosted analytics upload — Supabase port of
// apps/edge/src/repoStatsUpload.ts. Opt-in (Pro+). Privacy posture
// unchanged: no source code, no file contents, no secrets — only
// per-detector counts + bounded summaries.

import type { SupabaseClient } from "@supabase/supabase-js";
import { validateGithubOidc } from "./jwt.js";
import { validateSubscription } from "./subscriptions.js";
import { extractOrg } from "./quota.js";
import { json } from "./response.js";

export type Env = {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  GITHUB_JWKS_URL?: string;
  OIDC_AUDIENCE?: string;
};

type RepoStatsBody = {
  cliVersion?: string;
  stats?: {
    byDetector?: Record<string, {
      totalHits?: number;
      byModel?: Record<string, { hits?: number; firstSeen?: string; lastSeen?: string; tool?: string }>;
    }>;
  };
};

export async function handleRepoStatsUpload(
  request: Request,
  env: Env,
  db: SupabaseClient
): Promise<Response> {
  const auth = request.headers.get("Authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return json({ error: "missing bearer token" }, 401);

  // Body must be <100 KB so we can't be DoS'd by giant uploads.
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > 100_000) {
    return json({ error: "body too large (max 100KB)" }, 413);
  }
  let body: RepoStatsBody;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  // OIDC validation
  let oidc;
  try {
    oidc = await validateGithubOidc(m[1], {
      jwksUrl: env.GITHUB_JWKS_URL ?? "https://token.actions.githubusercontent.com/.well-known/jwks",
      expectedAudience: env.OIDC_AUDIENCE ?? "pinnedai-analytics",
    });
  } catch (e) {
    return json({ error: "oidc validation failed", detail: String(e) }, 401);
  }
  const repository = oidc.repository ?? "";
  const org = (oidc.repository_owner || extractOrg(repository)).toLowerCase();
  if (!org) return json({ error: "missing repository in OIDC claims" }, 400);

  // Pro+ only.
  const sub = await validateSubscription(db, org);
  if (!sub) return json({ error: "analytics upload requires Pro+ subscription" }, 403);

  const now = Date.now();
  const totalHits = Object.values(body.stats?.byDetector ?? {}).reduce(
    (acc, ds) => acc + (ds.totalHits ?? 0),
    0
  );
  const byModel: Record<string, { hits: number; tool?: string }> = {};
  for (const ds of Object.values(body.stats?.byDetector ?? {})) {
    for (const [model, ms] of Object.entries(ds.byModel ?? {})) {
      const cur = byModel[model] ?? { hits: 0, tool: ms.tool };
      cur.hits += ms.hits ?? 0;
      byModel[model] = cur;
    }
  }

  // Insert the upload row.
  const { error } = await db.from("repo_stats_uploads").insert({
    org,
    repo: repository,
    uploaded_at: now,
    cli_version: body.cliVersion ?? "unknown",
    stats_json: body.stats ?? {},
    total_hits: totalHits,
    by_model_json: byModel,
  });
  if (error) return json({ error: "upload failed", detail: error.message }, 500);

  // Update the rollup (cheap dashboard reads).
  for (const [detector, ds] of Object.entries(body.stats?.byDetector ?? {})) {
    for (const [model, ms] of Object.entries(ds.byModel ?? {})) {
      const hits = ms.hits ?? 0;
      if (hits <= 0) continue;
      // We don't ship the upsert_detector_model_rollup RPC by default —
      // the initial migration is plain DDL. Use read-modify-write
      // (cheap enough for opt-in analytics; the volume here is bounded
      // by Pro subscriber count).
      const { data: existing } = await db
        .from("detector_model_rollup")
        .select("hits")
        .eq("org", org)
        .eq("detector", detector)
        .eq("ai_model", model)
        .maybeSingle();
      const nextHits = (existing?.hits ?? 0) + hits;
      await db.from("detector_model_rollup").upsert(
        {
          org,
          detector,
          ai_model: model,
          ai_tool: ms.tool ?? null,
          hits: nextHits,
          first_seen: existing ? undefined : now,
          last_seen: now,
        },
        { onConflict: "org,detector,ai_model" }
      );
    }
  }

  return json({
    ok: true,
    received: {
      org,
      repo: repository,
      total_hits: totalHits,
      detectors: Object.keys(body.stats?.byDetector ?? {}).length,
    },
    dashboardUrl: `https://pinnedai.dev/dashboard/${encodeURIComponent(org)}`,
  });
}
