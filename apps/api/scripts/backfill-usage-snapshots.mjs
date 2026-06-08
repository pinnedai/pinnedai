#!/usr/bin/env node
// scripts/backfill-usage-snapshots.mjs — R94 mirror for pinnedai
//
// Populates usage_snapshots for past N days from existing pin_events.
// Each date upserts on snapshot_date (idempotent — safe to re-run).
//
// Usage:
//   ENDPOINT=https://api.pinnedai.dev \
//   ADMIN_KEY=<your-admin-key> \
//   node scripts/backfill-usage-snapshots.mjs 30

const ENDPOINT = process.env.ENDPOINT || "https://api.pinnedai.dev";
const ADMIN_KEY = process.env.ADMIN_KEY;
const DAYS = parseInt(process.argv[2] || "30", 10);

if (!ADMIN_KEY) {
  console.error("ERROR: ADMIN_KEY env var required (set on the Vercel project as ADMIN_KEY).");
  process.exit(1);
}
if (!Number.isFinite(DAYS) || DAYS < 1 || DAYS > 365) {
  console.error("ERROR: days arg must be a positive integer ≤ 365");
  process.exit(1);
}

console.log(`Backfilling ${DAYS} days into usage_snapshots at ${ENDPOINT}...`);

const today = new Date();
today.setUTCHours(0, 0, 0, 0);

let ok = 0;
let fail = 0;
for (let i = DAYS - 1; i >= 0; i--) {
  const d = new Date(today.getTime() - i * 86400_000);
  const dateStr = d.toISOString().slice(0, 10);
  try {
    const res = await fetch(`${ENDPOINT}/admin/usage/snapshot?date=${dateStr}`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`  ✗ ${dateStr}: HTTP ${res.status} ${detail.slice(0, 100)}`);
      fail++;
      continue;
    }
    const body = await res.json();
    const snap = body.snapshot ?? {};
    console.log(
      `  ✓ ${dateStr}  events_24h=${snap.period_24h_events}  ips_24h=${snap.period_24h_unique_ips}  events_7d=${snap.period_7d_events}  ips_7d=${snap.period_7d_unique_ips}`
    );
    ok++;
  } catch (e) {
    console.error(`  ✗ ${dateStr}: ${(e && e.message) || e}`);
    fail++;
  }
}

console.log("");
console.log(`Backfill done — ok=${ok} fail=${fail}`);
console.log("");
console.log(`To read the WoW growth report:`);
console.log(`  curl -s -H "authorization: Bearer $ADMIN_KEY" ${ENDPOINT}/admin/usage | jq`);
console.log("");
if (fail > 0) process.exit(1);
