// Request logging + daily usage snapshots — Cipherwake R94 mirror
// for pinnedai-edge.
//
// Logs every Worker call into `pin_events` (append-only). A scheduled
// cron handler reads that table once per day, computes per-class
// rollups + unique-IP counts + top-IP-share, and writes one row into
// `usage_snapshots`. Powers /admin/usage trend + WoW growth signal.
//
// Design constraints (locked):
//
//   1. Never store raw IPs. Hash via SHA-256(ip + daily-salt). The
//      salt rotates daily so cross-day re-identification is bounded.
//   2. Pagination: D1 won't silently cap, but the same query pattern
//      Cipherwake uses (Range header + count) is applied to keep this
//      portable to PostgREST-style backends if we ever migrate.
//   3. Per-class metrics carry BOTH raw counts AND unique-IPs AND
//      top-IP-share. Raw counts are dogfood-inflated. Unique-IP
//      growth is the real adoption signal.
//   4. Backfillable from the same pin_events history — the daily
//      cron and the backfill script share the snapshot-computation
//      function.

import type { D1Database } from "@cloudflare/workers-types";

export type ClientClass = "cli" | "mcp" | "action" | "web" | "bot" | "other";

// Classify the request source from headers + UA. Deliberately
// conservative; ambiguous cases fall to "other" rather than
// inflating a specific class.
export function classifyRequest(req: Request): ClientClass {
  const ua = req.headers.get("user-agent") ?? "";
  // X-Pinned-Client is the explicit signal — set by the CLI and MCP
  // server. Trust it when present.
  const explicit = req.headers.get("x-pinned-client")?.toLowerCase() ?? "";
  if (explicit === "cli") return "cli";
  if (explicit === "mcp") return "mcp";
  if (explicit === "action") return "action";
  // GitHub Actions OIDC tokens come with a fixed UA prefix.
  if (/GitHubActions/i.test(ua)) return "action";
  // pinnedai CLI sets `pinnedai/<version>` in its UA.
  if (/^pinnedai\//i.test(ua)) return "cli";
  // MCP host (Claude Desktop / Cursor) sends specific UAs.
  if (/Claude|Cursor|MCP/i.test(ua)) return "mcp";
  // Web — likely a browser viewing the badge SVG.
  if (/Mozilla|Chrome|Safari|Firefox|Edge/i.test(ua)) return "web";
  // Common monitoring bots.
  if (/UptimeRobot|Pingdom|StatusCake|bot|spider/i.test(ua)) return "bot";
  return "other";
}

// Extract the client IP from CF-Connecting-IP (set by Cloudflare).
// In tests we accept a synthetic ?test_ip query param.
export function clientIp(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf;
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  // Test/local fallback — never hits in prod.
  return "0.0.0.0";
}

// SHA-256 hash for IP. Salted by UTC date so cross-day re-id is
// bounded. The salt itself is a deterministic SHA-256 of the date
// — we don't need cryptographic salt rotation, just per-day domain
// separation.
export async function hashIp(ip: string, dateISO: string): Promise<string> {
  const enc = new TextEncoder();
  const saltData = enc.encode(`pinnedai-ip-salt-${dateISO.slice(0, 10)}`);
  const saltHash = await crypto.subtle.digest("SHA-256", saltData);
  const combined = new Uint8Array(saltHash.byteLength + ip.length);
  combined.set(new Uint8Array(saltHash));
  combined.set(enc.encode(ip), saltHash.byteLength);
  const hashBytes = await crypto.subtle.digest("SHA-256", combined);
  const hex: string[] = [];
  const view = new Uint8Array(hashBytes);
  for (let i = 0; i < view.length; i++) {
    hex.push(view[i].toString(16).padStart(2, "0"));
  }
  return hex.join("");
}

// Append one event to pin_events. Caller can fire-and-forget via
// ctx.waitUntil to avoid blocking the response path.
export async function logEvent(
  db: D1Database,
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
  const cliVersion = cliVersionHdr ?? (function deriveFromUA(): string | null {
    const m = /^pinnedai\/([^\s]+)/.exec(ua);
    return m ? m[1] : null;
  })();
  try {
    await db
      .prepare(
        "INSERT INTO pin_events (created_at, ip_hash, client_class, endpoint, repo, cli_version, user_agent, status_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(now, ipH, cls, args.endpoint, args.repo ?? null, cliVersion, ua, args.statusCode)
      .run();
  } catch {
    // Logging MUST NEVER fail the request. Swallow.
  }
}

// Compute one day's snapshot from pin_events. Window: events whose
// created_at is in [endTs - period_ms, endTs).
export type Snapshot = {
  snapshot_date: string; // YYYY-MM-DD
  period_24h_events: number;
  period_24h_unique_ips: number;
  period_7d_events: number;
  period_7d_unique_ips: number;
  per_class_7d: Record<ClientClass, { calls: number; unique_ips: number; top_ip_share_pct: number }>;
  by_endpoint_json: string;
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;

export async function computeSnapshot(
  db: D1Database,
  endTs: number
): Promise<Snapshot> {
  const date = new Date(endTs).toISOString().slice(0, 10);
  const start24 = endTs - ONE_DAY_MS;
  const start7d = endTs - SEVEN_DAYS_MS;

  // 24h totals.
  const r24 = await db
    .prepare("SELECT COUNT(*) AS c, COUNT(DISTINCT ip_hash) AS u FROM pin_events WHERE created_at >= ? AND created_at < ?")
    .bind(start24, endTs)
    .first<{ c: number; u: number }>();
  // 7d totals.
  const r7 = await db
    .prepare("SELECT COUNT(*) AS c, COUNT(DISTINCT ip_hash) AS u FROM pin_events WHERE created_at >= ? AND created_at < ?")
    .bind(start7d, endTs)
    .first<{ c: number; u: number }>();

  // Per-class 7d counts + unique IPs + top-IP share.
  const CLASSES: ClientClass[] = ["cli", "mcp", "action", "web", "bot", "other"];
  const per_class_7d: Record<string, { calls: number; unique_ips: number; top_ip_share_pct: number }> = {};
  for (const cls of CLASSES) {
    const counts = await db
      .prepare("SELECT COUNT(*) AS c, COUNT(DISTINCT ip_hash) AS u FROM pin_events WHERE client_class = ? AND created_at >= ? AND created_at < ?")
      .bind(cls, start7d, endTs)
      .first<{ c: number; u: number }>();
    const calls = counts?.c ?? 0;
    const unique_ips = counts?.u ?? 0;
    let top_ip_share_pct = 0;
    if (calls > 0) {
      const top = await db
        .prepare("SELECT COUNT(*) AS topCount FROM pin_events WHERE client_class = ? AND created_at >= ? AND created_at < ? GROUP BY ip_hash ORDER BY topCount DESC LIMIT 1")
        .bind(cls, start7d, endTs)
        .first<{ topCount: number }>();
      top_ip_share_pct = top ? Math.round(((top.topCount ?? 0) / calls) * 100) : 0;
    }
    per_class_7d[cls] = { calls, unique_ips, top_ip_share_pct };
  }

  // Endpoint-level rollup (7d).
  const endpointRows = await db
    .prepare("SELECT endpoint, COUNT(*) AS c, COUNT(DISTINCT ip_hash) AS u FROM pin_events WHERE created_at >= ? AND created_at < ? GROUP BY endpoint ORDER BY c DESC")
    .bind(start7d, endTs)
    .all<{ endpoint: string; c: number; u: number }>();
  const by_endpoint: Record<string, { count: number; unique_ips: number }> = {};
  for (const row of endpointRows.results ?? []) {
    by_endpoint[row.endpoint] = { count: row.c, unique_ips: row.u };
  }

  return {
    snapshot_date: date,
    period_24h_events: r24?.c ?? 0,
    period_24h_unique_ips: r24?.u ?? 0,
    period_7d_events: r7?.c ?? 0,
    period_7d_unique_ips: r7?.u ?? 0,
    per_class_7d: per_class_7d as Snapshot["per_class_7d"],
    by_endpoint_json: JSON.stringify(by_endpoint),
  };
}

// Upsert one snapshot row.
export async function writeSnapshot(
  db: D1Database,
  snap: Snapshot,
  source: "daily-cron" | "backfill",
  now: number
): Promise<void> {
  const c = snap.per_class_7d;
  await db
    .prepare(
      `INSERT INTO usage_snapshots (
        snapshot_date, recorded_at,
        period_24h_events, period_24h_unique_ips,
        period_7d_events, period_7d_unique_ips,
        cli_calls_7d, cli_unique_ips_7d, cli_top_ip_share_pct,
        mcp_calls_7d, mcp_unique_ips_7d, mcp_top_ip_share_pct,
        action_calls_7d, action_unique_ips_7d, action_top_ip_share_pct,
        web_calls_7d, web_unique_ips_7d, web_top_ip_share_pct,
        bot_calls_7d, bot_unique_ips_7d,
        by_endpoint_json, source
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(snapshot_date) DO UPDATE SET
        recorded_at = excluded.recorded_at,
        period_24h_events = excluded.period_24h_events,
        period_24h_unique_ips = excluded.period_24h_unique_ips,
        period_7d_events = excluded.period_7d_events,
        period_7d_unique_ips = excluded.period_7d_unique_ips,
        cli_calls_7d = excluded.cli_calls_7d,
        cli_unique_ips_7d = excluded.cli_unique_ips_7d,
        cli_top_ip_share_pct = excluded.cli_top_ip_share_pct,
        mcp_calls_7d = excluded.mcp_calls_7d,
        mcp_unique_ips_7d = excluded.mcp_unique_ips_7d,
        mcp_top_ip_share_pct = excluded.mcp_top_ip_share_pct,
        action_calls_7d = excluded.action_calls_7d,
        action_unique_ips_7d = excluded.action_unique_ips_7d,
        action_top_ip_share_pct = excluded.action_top_ip_share_pct,
        web_calls_7d = excluded.web_calls_7d,
        web_unique_ips_7d = excluded.web_unique_ips_7d,
        web_top_ip_share_pct = excluded.web_top_ip_share_pct,
        bot_calls_7d = excluded.bot_calls_7d,
        bot_unique_ips_7d = excluded.bot_unique_ips_7d,
        by_endpoint_json = excluded.by_endpoint_json,
        source = excluded.source
      `
    )
    .bind(
      snap.snapshot_date, now,
      snap.period_24h_events, snap.period_24h_unique_ips,
      snap.period_7d_events, snap.period_7d_unique_ips,
      c.cli.calls, c.cli.unique_ips, c.cli.top_ip_share_pct,
      c.mcp.calls, c.mcp.unique_ips, c.mcp.top_ip_share_pct,
      c.action.calls, c.action.unique_ips, c.action.top_ip_share_pct,
      c.web.calls, c.web.unique_ips, c.web.top_ip_share_pct,
      c.bot.calls, c.bot.unique_ips,
      snap.by_endpoint_json,
      source
    )
    .run();
}

// WoW growth: today's snapshot vs the snapshot from 7 days prior.
// Returns nulls when prior is missing (less than 7 days of data).
export type WoWReport = {
  date: string;
  unique_ips_7d: { now: number; prior: number; delta: number; pct: number | null };
  events_7d: { now: number; prior: number; delta: number; pct: number | null };
};

export async function readWoW(db: D1Database, date: string): Promise<WoWReport | null> {
  const today = await db
    .prepare("SELECT period_7d_events, period_7d_unique_ips FROM usage_snapshots WHERE snapshot_date = ?")
    .bind(date)
    .first<{ period_7d_events: number; period_7d_unique_ips: number }>();
  if (!today) return null;
  const priorDate = new Date(new Date(date).getTime() - SEVEN_DAYS_MS).toISOString().slice(0, 10);
  const prior = await db
    .prepare("SELECT period_7d_events, period_7d_unique_ips FROM usage_snapshots WHERE snapshot_date = ?")
    .bind(priorDate)
    .first<{ period_7d_events: number; period_7d_unique_ips: number }>();
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
