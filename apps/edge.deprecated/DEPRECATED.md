# DEPRECATED — superseded by apps/api/

This directory contains the original Cloudflare Worker implementation
of pinnedai's hosted backend. As of 0.5.0 it has been replaced by
`apps/api/` (Vercel Edge Functions + Supabase).

Why the switch:
- pinnedai.dev DNS was already at Vercel — no migration risk
- Reuses Cipherwake's R94 analytics pattern (also Vercel/Supabase)
- One ops surface instead of three (Vercel + Cloudflare + DNS)

The code here is the reference implementation. The algorithms
(`usageLog.ts` IP hashing + classifyRequest + computeSnapshot,
`jwt.ts` GitHub OIDC validation, `quota.ts` per-org counters) all
ported cleanly to `apps/api/lib/`. This directory exists so the
history is recoverable, not because anything still reads from it.

Will be deleted after 0.5.1.
