// Tests for the usage-log + snapshot module (0.5.0-beta.8 R94 mirror).
//
// Uses an in-memory D1 mock that supports the SQL shapes the module
// actually issues:
//   - INSERT INTO pin_events ...
//   - SELECT COUNT(*), COUNT(DISTINCT ip_hash) FROM pin_events WHERE ...
//   - GROUP BY ip_hash ORDER BY ... LIMIT 1
//   - INSERT INTO usage_snapshots ... ON CONFLICT
//
// Per the catalog: assert on stored row shape, not just return value.

import { describe, it, expect, beforeEach } from "vitest";
import { classifyRequest, hashIp, logEvent, computeSnapshot, writeSnapshot, readWoW } from "./usageLog.js";

type Row = Record<string, unknown>;

// A minimal in-memory D1 that supports SELECT/INSERT/UPSERT against
// just our two tables.
function createMockD1() {
  const pin_events: Row[] = [];
  const usage_snapshots = new Map<string, Row>();

  const prepare = (sql: string) => {
    const upper = sql.replace(/\s+/g, " ").trim();
    return {
      _sql: upper,
      _binds: [] as unknown[],
      bind(...args: unknown[]) {
        this._binds = args;
        return this;
      },
      async first<T = Row>(): Promise<T | undefined> {
        // COUNT(*) AS c, COUNT(DISTINCT ip_hash) AS u FROM pin_events WHERE created_at >= ? AND created_at < ?
        if (/SELECT COUNT\(\*\) AS c, COUNT\(DISTINCT ip_hash\) AS u FROM pin_events WHERE created_at >= \? AND created_at < \?$/.test(this._sql)) {
          const lo = this._binds[0] as number;
          const hi = this._binds[1] as number;
          const rows = pin_events.filter((e) => (e.created_at as number) >= lo && (e.created_at as number) < hi);
          const u = new Set(rows.map((r) => r.ip_hash));
          return { c: rows.length, u: u.size } as unknown as T;
        }
        // Same as above but with client_class filter.
        if (/WHERE client_class = \? AND created_at >= \? AND created_at < \?$/.test(this._sql) && /COUNT/.test(this._sql)) {
          const cls = this._binds[0] as string;
          const lo = this._binds[1] as number;
          const hi = this._binds[2] as number;
          const rows = pin_events.filter((e) => e.client_class === cls && (e.created_at as number) >= lo && (e.created_at as number) < hi);
          const u = new Set(rows.map((r) => r.ip_hash));
          return { c: rows.length, u: u.size } as unknown as T;
        }
        // SELECT COUNT(*) AS topCount FROM pin_events ... GROUP BY ip_hash ORDER BY topCount DESC LIMIT 1
        if (/GROUP BY ip_hash ORDER BY topCount DESC LIMIT 1$/.test(this._sql)) {
          const cls = this._binds[0] as string;
          const lo = this._binds[1] as number;
          const hi = this._binds[2] as number;
          const rows = pin_events.filter((e) => e.client_class === cls && (e.created_at as number) >= lo && (e.created_at as number) < hi);
          const byIp = new Map<string, number>();
          for (const r of rows) {
            const ip = r.ip_hash as string;
            byIp.set(ip, (byIp.get(ip) ?? 0) + 1);
          }
          const max = Math.max(0, ...Array.from(byIp.values()));
          return max > 0 ? ({ topCount: max } as unknown as T) : undefined;
        }
        // WoW reads
        if (/SELECT period_7d_events, period_7d_unique_ips FROM usage_snapshots WHERE snapshot_date = \?$/.test(this._sql)) {
          const date = this._binds[0] as string;
          return usage_snapshots.get(date) as unknown as T | undefined;
        }
        return undefined;
      },
      async all<T = Row>(): Promise<{ results: T[] }> {
        // Endpoint rollup: SELECT endpoint, COUNT, COUNT DISTINCT FROM pin_events WHERE created_at >= ? AND created_at < ? GROUP BY endpoint ORDER BY c DESC
        if (/GROUP BY endpoint ORDER BY c DESC$/.test(this._sql)) {
          const lo = this._binds[0] as number;
          const hi = this._binds[1] as number;
          const rows = pin_events.filter((e) => (e.created_at as number) >= lo && (e.created_at as number) < hi);
          const byEp = new Map<string, { c: number; ips: Set<string> }>();
          for (const r of rows) {
            const ep = r.endpoint as string;
            const cur = byEp.get(ep) ?? { c: 0, ips: new Set<string>() };
            cur.c++;
            cur.ips.add(r.ip_hash as string);
            byEp.set(ep, cur);
          }
          const out: Row[] = [];
          for (const [endpoint, { c, ips }] of byEp) out.push({ endpoint, c, u: ips.size });
          out.sort((a, b) => (b.c as number) - (a.c as number));
          return { results: out as unknown as T[] };
        }
        return { results: [] };
      },
      async run() {
        if (/^INSERT INTO pin_events \(created_at, ip_hash, client_class, endpoint, repo, cli_version, user_agent, status_code\) VALUES/.test(this._sql)) {
          pin_events.push({
            created_at: this._binds[0],
            ip_hash: this._binds[1],
            client_class: this._binds[2],
            endpoint: this._binds[3],
            repo: this._binds[4],
            cli_version: this._binds[5],
            user_agent: this._binds[6],
            status_code: this._binds[7],
          });
          return;
        }
        if (/^INSERT INTO usage_snapshots/.test(this._sql)) {
          const row: Row = {
            snapshot_date: this._binds[0],
            recorded_at: this._binds[1],
            period_24h_events: this._binds[2],
            period_24h_unique_ips: this._binds[3],
            period_7d_events: this._binds[4],
            period_7d_unique_ips: this._binds[5],
            cli_calls_7d: this._binds[6],
            cli_unique_ips_7d: this._binds[7],
            cli_top_ip_share_pct: this._binds[8],
          };
          usage_snapshots.set(this._binds[0] as string, row);
          return;
        }
      },
    };
  };
  return Object.assign({ prepare }, { _pin_events: pin_events, _usage_snapshots: usage_snapshots });
}

describe("classifyRequest", () => {
  it("X-Pinned-Client header takes precedence over UA", () => {
    const r = new Request("http://x", { headers: { "x-pinned-client": "cli", "user-agent": "Mozilla/5.0" } });
    expect(classifyRequest(r)).toBe("cli");
  });
  it("UA pinnedai/<version> → cli", () => {
    const r = new Request("http://x", { headers: { "user-agent": "pinnedai/0.5.0-beta" } });
    expect(classifyRequest(r)).toBe("cli");
  });
  it("UA Mozilla → web", () => {
    const r = new Request("http://x", { headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel)" } });
    expect(classifyRequest(r)).toBe("web");
  });
  it("UA UptimeRobot → bot", () => {
    const r = new Request("http://x", { headers: { "user-agent": "UptimeRobot/2.0" } });
    expect(classifyRequest(r)).toBe("bot");
  });
  it("no UA → other", () => {
    const r = new Request("http://x");
    expect(classifyRequest(r)).toBe("other");
  });
});

describe("hashIp", () => {
  it("produces a 64-char hex hash", async () => {
    const h = await hashIp("1.2.3.4", "2026-06-08T00:00:00.000Z");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
  it("same IP, same date → same hash", async () => {
    const a = await hashIp("1.2.3.4", "2026-06-08T00:00:00.000Z");
    const b = await hashIp("1.2.3.4", "2026-06-08T12:00:00.000Z");
    expect(a).toBe(b);
  });
  it("different date → different hash (daily salt rotation)", async () => {
    const a = await hashIp("1.2.3.4", "2026-06-08T00:00:00.000Z");
    const b = await hashIp("1.2.3.4", "2026-06-09T00:00:00.000Z");
    expect(a).not.toBe(b);
  });
});

describe("logEvent + computeSnapshot integration", () => {
  let db: ReturnType<typeof createMockD1>;
  beforeEach(() => { db = createMockD1(); });

  it("logEvent writes one row with the classified client_class + status", async () => {
    const r = new Request("http://x", { headers: { "user-agent": "pinnedai/0.5.0-beta" } });
    await logEvent(db as any, { request: r, endpoint: "/v1/extract", statusCode: 200, now: 1_700_000_000_000 });
    expect((db as any)._pin_events).toHaveLength(1);
    const row = (db as any)._pin_events[0];
    expect(row.endpoint).toBe("/v1/extract");
    expect(row.client_class).toBe("cli");
    expect(row.status_code).toBe(200);
    expect(row.cli_version).toBe("0.5.0-beta");
    expect(typeof row.ip_hash).toBe("string");
    expect(row.ip_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("computeSnapshot rolls up 7d events + per-class counts + top-ip-share", async () => {
    const now = 1_700_000_000_000;
    // 5 CLI calls from same IP (= 100% top_ip_share), 3 MCP calls from 3 distinct IPs
    for (let i = 0; i < 5; i++) {
      const r = new Request("http://x", {
        headers: { "user-agent": "pinnedai/0.5", "x-forwarded-for": "1.1.1.1" },
      });
      await logEvent(db as any, { request: r, endpoint: "/v1/extract", statusCode: 200, now: now - i * 1000 });
    }
    for (let i = 0; i < 3; i++) {
      const r = new Request("http://x", {
        headers: { "user-agent": "Cursor/MCP", "x-forwarded-for": `2.${i}.0.0` },
      });
      await logEvent(db as any, { request: r, endpoint: "/v1/extract", statusCode: 200, now: now - i * 1000 });
    }
    const snap = await computeSnapshot(db as any, now + 1000);
    expect(snap.period_7d_events).toBe(8);
    expect(snap.period_7d_unique_ips).toBe(4); // 1 cli ip + 3 mcp ips
    expect(snap.per_class_7d.cli.calls).toBe(5);
    expect(snap.per_class_7d.cli.unique_ips).toBe(1);
    expect(snap.per_class_7d.cli.top_ip_share_pct).toBe(100); // dogfood-dominated
    expect(snap.per_class_7d.mcp.calls).toBe(3);
    expect(snap.per_class_7d.mcp.unique_ips).toBe(3);
    // 1/3 ≈ 33%
    expect(snap.per_class_7d.mcp.top_ip_share_pct).toBe(33);
  });

  it("writeSnapshot + readWoW: delta vs prior-week snapshot", async () => {
    const now = 1_700_000_000_000;
    const today = new Date(now).toISOString().slice(0, 10);
    const priorDate = new Date(now - 7 * 86400_000).toISOString().slice(0, 10);

    // Prior snapshot — 10 ips
    const prior = {
      snapshot_date: priorDate,
      period_24h_events: 0, period_24h_unique_ips: 0,
      period_7d_events: 50, period_7d_unique_ips: 10,
      per_class_7d: {
        cli: { calls: 0, unique_ips: 0, top_ip_share_pct: 0 },
        mcp: { calls: 0, unique_ips: 0, top_ip_share_pct: 0 },
        action: { calls: 0, unique_ips: 0, top_ip_share_pct: 0 },
        web: { calls: 0, unique_ips: 0, top_ip_share_pct: 0 },
        bot: { calls: 0, unique_ips: 0, top_ip_share_pct: 0 },
        other: { calls: 0, unique_ips: 0, top_ip_share_pct: 0 },
      },
      by_endpoint_json: "{}",
    };
    await writeSnapshot(db as any, prior, "backfill", now);

    // Today snapshot — 15 ips
    const todaySnap = { ...prior, snapshot_date: today, period_7d_events: 75, period_7d_unique_ips: 15 };
    await writeSnapshot(db as any, todaySnap, "daily-cron", now);

    const wow = await readWoW(db as any, today);
    expect(wow).not.toBeNull();
    expect(wow!.unique_ips_7d.now).toBe(15);
    expect(wow!.unique_ips_7d.prior).toBe(10);
    expect(wow!.unique_ips_7d.delta).toBe(5);
    expect(wow!.unique_ips_7d.pct).toBe(50);
    expect(wow!.events_7d.now).toBe(75);
    expect(wow!.events_7d.prior).toBe(50);
    expect(wow!.events_7d.pct).toBe(50);
  });
});
