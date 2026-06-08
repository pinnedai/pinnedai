// Supabase client for the Edge runtime. Uses the SERVICE_ROLE_KEY to
// bypass RLS — every table has RLS enabled so accidental anon access
// can't read subscription data or quota counts. This module is the
// ONLY place that key is loaded.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type Env = {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
};

let _client: SupabaseClient | null = null;
let _lastEnvKey: string | null = null;

export function getDb(env: Env = process.env as Env): SupabaseClient {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "pinnedai-api: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY env vars required. " +
      "Set both in Vercel project settings (and your local .env for `vercel dev`)."
    );
  }
  // Cache the client across invocations within the same isolate.
  const envKey = `${url}|${key.slice(0, 12)}`;
  if (_client && _lastEnvKey === envKey) return _client;
  _client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  _lastEnvKey = envKey;
  return _client;
}
