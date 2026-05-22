// Content-hash cache for LLM extraction results.
//
// Why: a PR description hashed once. Subsequent `synchronize` events
// (pushed commits with no PR-body change) hit the cache and return
// instantly without billing the quota. This makes the Free LLM-call
// quota (500/mo public, 100/mo private) meaningfully map to "N unique
// PR descriptions parsed" rather than "N workflow runs."
//
// TTL: 90 days (CACHE_TTL_MS below). Tunable in OPS.md based on
// observed hit rate.

import type { D1Database } from "@cloudflare/workers-types";
import type { Claim } from "pinnedai";

const CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export async function hashBody(body: string): Promise<string> {
  const data = new TextEncoder().encode(body);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function getCached(
  db: D1Database,
  hash: string
): Promise<Claim[] | null> {
  const row = await db
    .prepare(
      `SELECT claims FROM extraction_cache
       WHERE content_hash = ? AND expires_at > ?`
    )
    .bind(hash, Date.now())
    .first<{ claims: string }>();
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.claims);
    return Array.isArray(parsed) ? (parsed as Claim[]) : null;
  } catch {
    return null;
  }
}

export async function setCached(
  db: D1Database,
  hash: string,
  claims: Claim[]
): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO extraction_cache (content_hash, claims, cached_at, expires_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(content_hash) DO UPDATE SET
         claims = excluded.claims,
         cached_at = excluded.cached_at,
         expires_at = excluded.expires_at`
    )
    .bind(hash, JSON.stringify(claims), now, now + CACHE_TTL_MS)
    .run();
}
