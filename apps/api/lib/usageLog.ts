// Request logging + daily usage snapshots — Supabase port of
// apps/edge/src/usageLog.ts. The algorithms (classify / hashIp /
// computeSnapshot / WoW) are unchanged; only the storage layer
// swaps D1 → Supabase.
//
// Design constraints (locked):
//   1. Never store raw IPs. SHA-256(ip + daily-salt). Salt is
//      deterministic (SHA-256 of date) — we don't need crypto
//      salt rotation, just per-day domain separation.
//   2. Per-class metrics carry raw counts + unique IPs + top-IP-share
//      so dogfood-dominated classes (>50%) are flagged.
//   3. Backfillable from the same pin_events history.

import type { SupabaseClient } from "@supabase/supabase-js";

export type ClientClass = "cli" | "mcp" | "action" | "web" | "bot" | "other";

export function classifyRequest(req: Request): ClientClass {
  const ua = req.headers.get("user-agent") ?? "";
  const explicit = req.headers.get("x-pinned-client")?.toLowerCase() ?? "";
  if (explicit === "cli") return "cli";
  if (explicit === "mcp") return "mcp";
  if (explicit === "action") return "action";
  if (/GitHubActions/i.test(ua)) return "action";
  if (/^pinnedai\//i.test(ua)) return "cli";
  if (/Claude|Cursor|MCP/i.test(ua)) return "mcp";
  if (/Mozilla|Chrome|Safari|Firefox|Edge/i.test(ua)) return "web";
  if (/UptimeRobot|Pingdom|StatusCake|bot|spider/i.test(ua)) return "bot";
  return "other";
}

export function clientIp(req: Request): string {
  // Vercel sets x-real-ip + x-forwarded-for; CF sets cf-connecting-ip.
  // Order: most-specific to least.
  const xri = req.headers.get("x-real-ip");
  if (xri) return xri;
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf;
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return "0.0.0.0";
}

export async function hashIp(ip: string, dateISO: string): Promise<string> {
  const enc = new TextEncoder();
  const saltData = enc.encode(`pinnedai-ip-salt-${dateISO.slice(0, 10)}`);
  const saltHash = await crypto.subtle.digest("SHA-256", saltData);
  const combined = new Uint8Array(saltHash.byteLength + ip.length);
  combined.set(new Uint8Array(saltHash));
  combined.set(enc.encode(ip), saltHash.byteLength);
  const hashBytes = await crypto.subtle.digest("SHA-256", combined);
  return Array.from(new Uint8Array(hashBytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function logEvent(
  db: SupabaseClient,
  args: {
    request: Request;
    endpoint: string;
    statusCode: number;
    repo?: string;
    now?: number;
  }
): Promise<void> {
  const now = args.now ?? Date.now();
  const dateISO = new Date(now).toISOString();
  const ip = clientIp(args.request);
  const ipH = await hashIp(ip, dateISO);
  const cls = classifyRequest(args.request);
  const ua = (args.request.headers.get("user-agent") ?? "").slice(0, 200);
  const cliVersionHdr = args.request.headers.get("x-pinned-version");
  const cliVersion =
    cliVersionHdr ??
    (function deriveFromUA(): string | null {
      const m = /^pinnedai\/([^\s]+)/.exec(ua);
      return m ? m[1] : null;
    })();
  try {
    await db.from("pin_events").insert({
      created_at: now,
      ip_hash: ipH,
      client_class: cls,
      endpoint: args.endpoint,
      repo: args.repo ?? null,
      cli_version: cliVersion,
      user_agent: ua,
      status_code: args.statusCode,
    });
  } catch {
    // Logging MUST NEVER fail a real request. Swallow.
  }
}

export type Snapshot = {
  snapshot_date: string;
  period_24h_events: number;
  period_24h_unique_ips: number;
  period_7d_events: number;
  period_7d_unique_ips: number;
  per_class_7d: Record<ClientClass, { calls: number; unique_ips: number; top_ip_share_pct: number }>;
  by_endpoint_json: string;
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;

// Page through Supabase results. PostgREST DEFAULTS to 1000-row cap
// regardless of ?limit=. We use Range headers + count: 'exact' to walk
// the full set. Same canonical pattern Cipherwake's sb-fetch-all uses.
async function fetchAllRange<T = Record<string, unknown>>(
  db: SupabaseClient,
  table: string,
  filterFn: (q: ReturnType<SupabaseClient["from"]>) => any
): Promise<T[]> {
  const pageSize = 1000;
  const out: T[] = [];
  let from = 0;
  while (true) {
    const q = filterFn(db.from(table)).range(from, from + pageSize - 1);
    const { data, error } = await q;
    if (error) throw error;
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return out;
}

export async function computeSnapshot(
  db: SupabaseClient,
  endTs: number
): Promise<Snapshot> {
  const date = new Date(endTs).toISOString().slice(0, 10);
  const start24 = endTs - ONE_DAY_MS;
  const start7d = endTs - SEVEN_DAYS_MS;

  // 24h window — pull only what we need (ip_hash for uniques).
  const rows24 = await fetchAllRange<{ ip_hash: string }>(db, "pin_events", (q) =>
    q.select("ip_hash").gte("created_at", start24).lt("created_at", endTs)
  );
  const uniq24 = new Set(rows24.map((r) => r.ip_hash));

  // 7d window — pull ip_hash, client_class, endpoint.
  const rows7d = await fetchAllRange<{ ip_hash: string; client_class: string; endpoint: string }>(
    db,
    "pin_events",
    (q) =>
      q
        .select("ip_hash, client_class, endpoint")
        .gte("created_at", start7d)
        .lt("created_at", endTs)
  );
  const uniq7d = new Set(rows7d.map((r) => r.ip_hash));

  const CLASSES: ClientClass[] = ["cli", "mcp", "action", "web", "bot", "other"];
  const per_class_7d: Record<string, { calls: number; unique_ips: number; top_ip_share_pct: number }> = {};
  for (const cls of CLASSES) {
    const filtered = rows7d.filter((r) => r.client_class === cls);
    const uniques = new Set(filtered.map((r) => r.ip_hash));
    const calls = filtered.length;
    const unique_ips = uniques.size;
    let top_ip_share_pct = 0;
    if (calls > 0) {
      const byIp = new Map<string, number>();
      for (const r of filtered) {
        byIp.set(r.ip_hash, (byIp.get(r.ip_hash) ?? 0) + 1);
      }
      const max = Math.max(0, ...Array.from(byIp.values()));
      top_ip_share_pct = Math.round((max / calls) * 100);
    }
    per_class_7d[cls] = { calls, unique_ips, top_ip_share_pct };
  }

  // Endpoint rollup
  const byEp = new Map<string, { count: number; ips: Set<string> }>();
  for (const r of rows7d) {
    const cur = byEp.get(r.endpoint) ?? { count: 0, ips: new Set<string>() };
    cur.count++;
    cur.ips.add(r.ip_hash);
    byEp.set(r.endpoint, cur);
  }
  const by_endpoint: Record<string, { count: number; unique_ips: number }> = {};
  for (const [ep, { count, ips }] of byEp) {
    by_endpoint[ep] = { count, unique_ips: ips.size };
  }

  return {
    snapshot_date: date,
    period_24h_events: rows24.length,
    period_24h_unique_ips: uniq24.size,
    period_7d_events: rows7d.length,
    period_7d_unique_ips: uniq7d.size,
    per_class_7d: per_class_7d as Snapshot["per_class_7d"],
    by_endpoint_json: JSON.stringify(by_endpoint),
  };
}

export async function writeSnapshot(
  db: SupabaseClient,
  snap: Snapshot,
  source: "daily-cron" | "backfill",
  now: number
): Promise<void> {
  const c = snap.per_class_7d;
  const { error } = await db.from("usage_snapshots").upsert(
    {
      snapshot_date: snap.snapshot_date,
      recorded_at: now,
      period_24h_events: snap.period_24h_events,
      period_24h_unique_ips: snap.period_24h_unique_ips,
      period_7d_events: snap.period_7d_events,
      period_7d_unique_ips: snap.period_7d_unique_ips,
      cli_calls_7d: c.cli.calls,
      cli_unique_ips_7d: c.cli.unique_ips,
      cli_top_ip_share_pct: c.cli.top_ip_share_pct,
      mcp_calls_7d: c.mcp.calls,
      mcp_unique_ips_7d: c.mcp.unique_ips,
      mcp_top_ip_share_pct: c.mcp.top_ip_share_pct,
      action_calls_7d: c.action.calls,
      action_unique_ips_7d: c.action.unique_ips,
      action_top_ip_share_pct: c.action.top_ip_share_pct,
      web_calls_7d: c.web.calls,
      web_unique_ips_7d: c.web.unique_ips,
      web_top_ip_share_pct: c.web.top_ip_share_pct,
      bot_calls_7d: c.bot.calls,
      bot_unique_ips_7d: c.bot.unique_ips,
      by_endpoint_json: JSON.parse(snap.by_endpoint_json),
      source,
    },
    { onConflict: "snapshot_date" }
  );
  if (error) throw new Error(`writeSnapshot: ${error.message}`);
}

export type WoWReport = {
  date: string;
  unique_ips_7d: { now: number; prior: number; delta: number; pct: number | null };
  events_7d: { now: number; prior: number; delta: number; pct: number | null };
};

export async function readWoW(db: SupabaseClient, date: string): Promise<WoWReport | null> {
  const { data: today } = await db
    .from("usage_snapshots")
    .select("period_7d_events, period_7d_unique_ips")
    .eq("snapshot_date", date)
    .maybeSingle();
  if (!today) return null;
  const priorDate = new Date(new Date(date).getTime() - SEVEN_DAYS_MS).toISOString().slice(0, 10);
  const { data: prior } = await db
    .from("usage_snapshots")
    .select("period_7d_events, period_7d_unique_ips")
    .eq("snapshot_date", priorDate)
    .maybeSingle();
  const ev = today.period_7d_events;
  const ev_prior = prior?.period_7d_events ?? 0;
  const u = today.period_7d_unique_ips;
  const u_prior = prior?.period_7d_unique_ips ?? 0;
  return {
    date,
    unique_ips_7d: {
      now: u,
      prior: u_prior,
      delta: u - u_prior,
      pct: u_prior > 0 ? Math.round(((u - u_prior) / u_prior) * 100) : null,
    },
    events_7d: {
      now: ev,
      prior: ev_prior,
      delta: ev - ev_prior,
      pct: ev_prior > 0 ? Math.round(((ev - ev_prior) / ev_prior) * 100) : null,
    },
  };
}
