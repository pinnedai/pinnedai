// Shared D1 mock for Worker audits. Same shape as the per-module
// mocks in apps/edge/src/*.test.ts but with all three tables in one
// instance — quota, extraction_cache, subscriptions — so audits can
// exercise cross-table behaviors (e.g. aggregate-budget cap reads
// subscriptions to exclude paid orgs from the free-tier sum).
//
// NOTE: this is in-process. For real-HTTP audits using miniflare +
// mocked JWKS + signed RS256 tokens, see the v0.2 roadmap. This audit
// suite delivers signal/falsifiability/pos+neg without the miniflare
// setup overhead.

import type { D1Database } from "@cloudflare/workers-types";

type QuotaRow = {
  org: string;
  month: string;
  calls: number;
  last_call_at: number;
};
type CacheRow = {
  content_hash: string;
  claims: string;
  cached_at: number;
  expires_at: number;
};
type SubscriptionRow = {
  github_org: string;
  customer_email: string;
  status: string;
  plan: string;
  fair_use_cap: number;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  created_at: number;
  updated_at: number;
  notes: string | null;
};

export type MockDB = D1Database & {
  _quota: Map<string, QuotaRow>;
  _cache: Map<string, CacheRow>;
  _subs: Map<string, SubscriptionRow>;
};

export function createMockD1(): MockDB {
  const quota = new Map<string, QuotaRow>();
  const cache = new Map<string, CacheRow>();
  const subs = new Map<string, SubscriptionRow>();

  const db = {
    prepare(sql: string) {
      const upper = sql.replace(/\s+/g, " ").trim();
      return {
        _binds: [] as unknown[],
        bind(...args: unknown[]) {
          this._binds = args;
          return this;
        },
        async first<T>() {
          // Subscriptions lookup
          if (/SELECT \* FROM subscriptions WHERE github_org = \? AND status = 'active'/i.test(upper)) {
            const k = this._binds[0] as string;
            const row = subs.get(k);
            if (!row || row.status !== "active") return undefined;
            return row as T;
          }
          // Quota read
          if (/SELECT calls FROM quota WHERE org = \? AND month = \?/i.test(upper)) {
            const [org, month] = this._binds as [string, string];
            const row = quota.get(`${org}:${month}`);
            return row ? ({ calls: row.calls } as T) : undefined;
          }
          // Cache read
          if (/SELECT claims FROM extraction_cache WHERE content_hash = \? AND expires_at >/i.test(upper)) {
            const k = this._binds[0] as string;
            const row = cache.get(k);
            if (!row) return undefined;
            if (row.expires_at <= Date.now()) return undefined;
            return { claims: row.claims } as T;
          }
          // Aggregate budget sum
          if (/SUM\(q\.calls\)/i.test(upper) && /quota q/i.test(upper)) {
            const month = this._binds[0] as string;
            let total = 0;
            for (const [, row] of quota) {
              if (row.month !== month) continue;
              const sub = subs.get(row.org);
              if (sub && sub.status === "active") continue; // paid orgs excluded
              total += row.calls;
            }
            return { total } as T;
          }
          // Admin stats — total
          if (/SELECT COUNT\(DISTINCT org\)/i.test(upper)) {
            const month = this._binds[0] as string;
            let orgs = new Set<string>();
            let calls = 0;
            for (const [, row] of quota) {
              if (row.month === month) {
                orgs.add(row.org);
                calls += row.calls;
              }
            }
            return { orgs: orgs.size, calls } as T;
          }
          // Cache stats
          if (/SELECT COUNT\(\*\) as size FROM extraction_cache/i.test(upper)) {
            const now = this._binds[0] as number;
            let size = 0;
            for (const [, r] of cache) if (r.expires_at > now) size += 1;
            return { size } as T;
          }
          return undefined;
        },
        async all<T>() {
          if (/SELECT org, calls FROM quota/i.test(upper)) {
            const month = this._binds[0] as string;
            const rows = [...quota.values()]
              .filter((r) => r.month === month)
              .sort((a, b) => b.calls - a.calls)
              .slice(0, 10)
              .map((r) => ({ org: r.org, calls: r.calls }));
            return { results: rows as T[] };
          }
          if (/SELECT plan, COUNT\(\*\) as count FROM subscriptions/i.test(upper)) {
            const counts = new Map<string, number>();
            for (const [, r] of subs) {
              if (r.status !== "active") continue;
              counts.set(r.plan, (counts.get(r.plan) ?? 0) + 1);
            }
            return {
              results: [...counts.entries()].map(([plan, count]) => ({
                plan,
                count,
              })) as T[],
            };
          }
          return { results: [] };
        },
        async run() {
          // INSERT subscriptions
          if (/^INSERT INTO subscriptions/i.test(upper)) {
            const [
              github_org,
              customer_email,
              status,
              plan,
              fair_use_cap,
              stripe_customer_id,
              stripe_subscription_id,
              created_at,
              updated_at,
              notes,
            ] = this._binds as [
              string,
              string,
              string,
              string,
              number,
              string | null,
              string | null,
              number,
              number,
              string | null,
            ];
            subs.set(github_org, {
              github_org,
              customer_email,
              status,
              plan,
              fair_use_cap,
              stripe_customer_id,
              stripe_subscription_id,
              created_at,
              updated_at,
              notes,
            });
            return { success: true };
          }
          // INSERT quota with UPSERT
          if (/^INSERT INTO quota/i.test(upper)) {
            const [org, month, lastCallAt1, lastCallAt2] = this._binds as [
              string,
              string,
              number,
              number,
            ];
            void lastCallAt2;
            const key = `${org}:${month}`;
            const existing = quota.get(key);
            if (existing) {
              existing.calls += 1;
              existing.last_call_at = lastCallAt1;
            } else {
              quota.set(key, {
                org,
                month,
                calls: 1,
                last_call_at: lastCallAt1,
              });
            }
            return { success: true };
          }
          // INSERT cache
          if (/^INSERT INTO extraction_cache/i.test(upper)) {
            const [content_hash, claims, cached_at, expires_at] = this._binds as [
              string,
              string,
              number,
              number,
            ];
            cache.set(content_hash, {
              content_hash,
              claims,
              cached_at,
              expires_at,
            });
            return { success: true };
          }
          return { success: true };
        },
      };
    },
    _quota: quota,
    _cache: cache,
    _subs: subs,
  } as unknown as MockDB;

  return db;
}

export function currentMonthUTC(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
