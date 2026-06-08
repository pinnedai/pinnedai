// Extraction cache — Supabase port of apps/edge/src/cache.ts.
// Keyed by SHA-256(body). 90-day TTL. Cache hits don't bill quota.

import type { SupabaseClient } from "@supabase/supabase-js";

const CACHE_TTL_DAYS = 90;

export async function hashBody(body: string): Promise<string> {
  const enc = new TextEncoder().encode(body);
  const digest = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function getCached(
  db: SupabaseClient,
  contentHash: string,
  now: number = Date.now()
): Promise<unknown[] | null> {
  const { data, error } = await db
    .from("extraction_cache")
    .select("claims, expires_at")
    .eq("content_hash", contentHash)
    .maybeSingle();
  if (error || !data) return null;
  if (data.expires_at <= now) return null;
  return Array.isArray(data.claims) ? data.claims : null;
}

export async function setCached(
  db: SupabaseClient,
  contentHash: string,
  claims: unknown[],
  now: number = Date.now()
): Promise<void> {
  const expiresAt = now + CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
  await db
    .from("extraction_cache")
    .upsert(
      { content_hash: contentHash, claims, cached_at: now, expires_at: expiresAt },
      { onConflict: "content_hash" }
    );
}
