// Worker handler: POST /v1/repo-stats — hosted analytics upload.
//
// Per [[strategic-moat-independent-guardrail]], cross-repo + cross-
// model analytics is the durable paid-tier moat. This endpoint accepts
// .pinned/repo-stats.json snapshots from CLIs that have opted in via
// `pinned analytics enable`, stores them per-org, and updates a rollup
// table the dashboard reads.
//
// Auth: OIDC JWT from the GitHub Action (same model as /v1/extract).
// The `repository` claim is the trust anchor — we attribute the
// upload to that org + repo. No client-side license keys.
//
// Privacy: stats_json carries no source code, no secrets, no file
// contents — repo-stats.ts bounds it to per-detector counts +
// per-model rollup + sample (filePath, line, plain-English summary).
// The CLI side strips any leftover sensitive content before send.
//
// Free tier: 0 uploads. Hosted analytics is Pro+ only.
// Pro tier: 100 uploads/repo/month (one per sweep is fine).
// Team / Enterprise: unlimited.

import type { D1Database } from "@cloudflare/workers-types";
import { validateGithubOidc } from "./jwt.js";
import { validateSubscription } from "./subscriptions.js";

export type RepoStatsEnv = {
  QUOTA: D1Database;
  GITHUB_JWKS_URL: string;
  OIDC_AUDIENCE: string;
};

const MAX_BODY_BYTES = 256 * 1024; // 256 KB cap — generous for stats blobs

type IncomingPayload = {
  cliVersion: string;
  stats: unknown; // RepoStats from the CLI side; we don't import its type to keep edge isolated
};

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export async function handleRepoStatsUpload(
  request: Request,
  env: RepoStatsEnv
): Promise<Response> {
  // 1. Bearer-token presence (OIDC JWT).
  const auth = request.headers.get("authorization") ?? request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) {
    return jsonError(401, "Missing Bearer OIDC token. Run from a GitHub Action with `permissions: id-token: write` OR pass the token via the CLI's `pinned analytics enable` flow.");
  }
  const token = auth.slice(7).trim();

  // 2. Body size cap.
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return jsonError(413, `Payload exceeds ${MAX_BODY_BYTES} bytes. repo-stats.json is structured to fit; trim sample arrays in the CLI before re-sending.`);
  }

  // 3. JSON parse.
  let payload: IncomingPayload;
  try {
    payload = JSON.parse(raw) as IncomingPayload;
  } catch {
    return jsonError(400, "Invalid JSON body.");
  }
  if (!isObject(payload) || typeof payload.cliVersion !== "string" || !isObject(payload.stats)) {
    return jsonError(400, "Body shape: { cliVersion: string, stats: RepoStats }.");
  }

  // 4. OIDC validation.
  const claims = await validateGithubOidc(token, {
    jwksUrl: env.GITHUB_JWKS_URL,
    expectedAudience: env.OIDC_AUDIENCE,
  }).catch(() => null);
  if (!claims) {
    return jsonError(401, "OIDC token validation failed.");
  }
  const repository = claims.repository;
  if (typeof repository !== "string" || !/^[^/]+\/[^/]+$/.test(repository)) {
    return jsonError(401, "OIDC `repository` claim missing or malformed.");
  }
  const [org, repo] = repository.split("/");

  // 5. Subscription gate — hosted analytics is Pro+.
  const sub = await validateSubscription(env.QUOTA, org);
  if (!sub) {
    return jsonError(402, "Hosted analytics is Pro+ only. Free tier ships full local `.pinned/repo-stats.json` + `pinned report`. Upgrade at https://pinnedai.dev/pricing.");
  }

  // 6. Per-repo monthly upload cap (Pro: 100 uploads/repo/mo, fair-use).
  // One sweep typically produces one upload, so 100 = ~3 sweeps/day —
  // plenty. Team/Enterprise: unlimited.
  if (sub.plan === "pro") {
    const monthStart = monthStartMs();
    const countRow = await env.QUOTA.prepare(
      `SELECT COUNT(*) AS c FROM repo_stats_uploads WHERE org = ? AND repo = ? AND uploaded_at >= ?`
    )
      .bind(org, repo, monthStart)
      .first<{ c: number }>();
    if ((countRow?.c ?? 0) >= 100) {
      return jsonError(429, "Pro monthly upload cap reached (100/repo). Upgrade to Team for unlimited.");
    }
  }

  // 7. Insert + update rollup.
  const stats = payload.stats as Record<string, unknown>;
  const byDetector = isObject(stats.byDetector) ? stats.byDetector : {};
  let totalHits = 0;
  const byModelRollup: Record<string, { hits: number; tool?: string }> = {};
  for (const [detector, ds] of Object.entries(byDetector)) {
    if (!isObject(ds)) continue;
    if (typeof ds.totalHits === "number") totalHits += ds.totalHits;
    if (!isObject(ds.byModel)) continue;
    for (const [model, ms] of Object.entries(ds.byModel)) {
      if (!isObject(ms)) continue;
      const key = `${detector}::${model}`;
      byModelRollup[key] = {
        hits: typeof ms.hits === "number" ? ms.hits : 0,
      };
    }
  }
  const now = Date.now();
  await env.QUOTA.prepare(
    `INSERT INTO repo_stats_uploads (org, repo, uploaded_at, cli_version, stats_json, total_hits, by_model_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(org, repo, now, payload.cliVersion, JSON.stringify(stats), totalHits, JSON.stringify(byModelRollup))
    .run();

  // 8. Update per-org detector-by-model rollup. Atomic upsert per row.
  for (const [detector, ds] of Object.entries(byDetector)) {
    if (!isObject(ds) || !isObject(ds.byModel)) continue;
    for (const [model, ms] of Object.entries(ds.byModel)) {
      if (!isObject(ms)) continue;
      const hits = typeof ms.hits === "number" ? ms.hits : 0;
      if (hits <= 0) continue;
      const firstSeen = typeof ms.firstSeen === "string" ? Date.parse(ms.firstSeen) : now;
      const lastSeen = typeof ms.lastSeen === "string" ? Date.parse(ms.lastSeen) : now;
      const tool = typeof ms.tool === "string" ? ms.tool : null;
      await env.QUOTA.prepare(
        `INSERT INTO detector_model_rollup (org, detector, ai_model, ai_tool, hits, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(org, detector, ai_model) DO UPDATE SET
           hits = hits + excluded.hits,
           ai_tool = COALESCE(excluded.ai_tool, ai_tool),
           last_seen = MAX(last_seen, excluded.last_seen)`
      )
        .bind(org, detector, model, tool, hits, firstSeen, lastSeen)
        .run();
    }
  }

  return json({
    ok: true,
    received: { org, repo, totalHits, uniqueModels: Object.keys(byModelRollup).length },
    dashboardUrl: `https://app.pinnedai.dev/dashboard/${encodeURIComponent(org)}`,
  });
}

function monthStartMs(): number {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function jsonError(status: number, message: string): Response {
  return json({ ok: false, error: message }, { status });
}
