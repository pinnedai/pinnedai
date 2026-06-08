// LLM extraction with subscription-aware BYOK.
//
// Decision tree (in order):
//   1. PINNEDAI_BYOK=anthropic|openai set + matching PINNEDAI_*_KEY set
//      → call /v1/plan to verify paid plan via OIDC.
//      • If paid: BYOK direct call to provider. Worker LLM is NOT
//        invoked; PR body never transits our infra.
//      • If free or BYOK key missing: fall through to /v1/extract.
//   2. Default → /v1/extract. Free tier: 100/mo per-org abuse cap.
//      Pro/Team/Enterprise: subscription.fair_use_cap on the Worker.
//   3. No GitHub Actions context → no-op.
//
// Identity is entirely OIDC-derived. No license keys.

import type { Claim } from "./claimParser.js";
import { extractDirect, activeByokProvider } from "./llmDirect.js";

const DEFAULT_ENDPOINT = "https://api.pinnedai.dev";

// Per-call timeout for all Worker / OIDC token fetches. Without this,
// a hung Worker would block `pinned generate` (and therefore the
// GitHub Action) for the full GitHub Actions default of 6 minutes —
// terrible first-use experience. The CLI gracefully degrades to
// regex-only when timeouts fire (the caller already handles {ok: false}).
//
// 15s is generous: GitHub OIDC token mints in <1s, our Worker target
// p99 is <3s, OpenAI call typically <5s. If we exceed 15s, the Worker
// is degraded enough to fall back to regex-only and try again later.
const WORKER_TIMEOUT_MS = 15_000;

function withTimeout(ms: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cleanup: () => clearTimeout(t) };
}

export type Plan = "free" | "pro" | "team" | "enterprise";

export type LLMExtractResult =
  | {
      ok: true;
      claims: Claim[];
      cached: boolean;
      plan: Plan;
      source: "worker" | "byok-anthropic" | "byok-openai";
      quota?: { calls: number; limit: number; remaining: number };
    }
  | { ok: false; reason: "no-oidc-context" }
  | { ok: false; reason: "error"; error: string };

const MAX_BODY_BYTES = 50_000;

export async function llmExtract(
  body: string,
  opts: { endpoint?: string } = {}
): Promise<LLMExtractResult> {
  // Client-side body size cap — fail fast before any network call.
  // Use UTF-8 BYTE length (not String.length / UTF-16 code units) so
  // multibyte / emoji PR bodies can't sneak past the Worker's 50KB cap.
  const byteLen = Buffer.byteLength(body, "utf8");
  if (byteLen > MAX_BODY_BYTES) {
    return {
      ok: false,
      reason: "error",
      error: `PR body too large (${byteLen} bytes UTF-8, max ${MAX_BODY_BYTES}). Worker would reject anyway; skipping.`,
    };
  }

  if (process.env.GITHUB_ACTIONS !== "true") {
    return { ok: false, reason: "no-oidc-context" };
  }
  const oidc = await fetchOidcToken();
  if (!oidc.ok) return oidc;

  const baseUrl = (
    opts.endpoint ??
    process.env.PINNEDAI_ENDPOINT ??
    DEFAULT_ENDPOINT
  ).replace(/\/+$/, "");

  const wantsByok = activeByokProvider();

  // BYOK path: verify the org is paid via /v1/plan (no LLM, no quota
  // burn), then go direct to provider — PR body never hits our infra.
  if (wantsByok) {
    const plan = await fetchPlan(baseUrl, oidc.token);
    if (plan.ok && isPaid(plan.plan)) {
      const direct = await extractDirect(body);
      if (direct.ok) {
        return {
          ok: true,
          claims: direct.claims,
          cached: false,
          plan: plan.plan,
          source:
            direct.provider === "anthropic"
              ? "byok-anthropic"
              : "byok-openai",
        };
      }
      if (direct.reason === "error") {
        return { ok: false, reason: "error", error: direct.error };
      }
      // BYOK declared but key missing → fall through to Worker
    }
    // plan-fetch failed or free tier → fall through to Worker
  }

  return callExtract(baseUrl, oidc.token, body);
}

type OidcOk = { ok: true; token: string };
type OidcErr =
  | { ok: false; reason: "no-oidc-context" }
  | { ok: false; reason: "error"; error: string };

async function fetchOidcToken(): Promise<OidcOk | OidcErr> {
  const tokenUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!tokenUrl || !requestToken) {
    return {
      ok: false,
      reason: "error",
      error:
        "OIDC not available — add `permissions: id-token: write` to your workflow.",
    };
  }
  try {
    const fullUrl =
      tokenUrl + (tokenUrl.includes("?") ? "&" : "?") + "audience=pinnedai";
    const t = withTimeout(WORKER_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(fullUrl, {
        headers: { Authorization: `Bearer ${requestToken}` },
        signal: t.signal,
      });
    } finally {
      t.cleanup();
    }
    if (!res.ok) {
      return {
        ok: false,
        reason: "error",
        error: `OIDC token fetch failed: ${res.status}`,
      };
    }
    const data = (await res.json()) as { value?: string };
    if (!data.value) {
      return {
        ok: false,
        reason: "error",
        error: "OIDC response missing value",
      };
    }
    return { ok: true, token: data.value };
  } catch (e) {
    return {
      ok: false,
      reason: "error",
      error: `OIDC fetch error: ${String(e)}`,
    };
  }
}

async function fetchPlan(
  baseUrl: string,
  oidcToken: string
): Promise<{ ok: true; plan: Plan } | { ok: false }> {
  try {
    const t = withTimeout(WORKER_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/v1/plan`, {
        method: "POST",
        headers: { Authorization: `Bearer ${oidcToken}` },
        signal: t.signal,
      });
    } finally {
      t.cleanup();
    }
    if (!res.ok) return { ok: false };
    const data = (await res.json()) as { plan?: Plan };
    return { ok: true, plan: data.plan ?? "free" };
  } catch {
    return { ok: false };
  }
}

async function callExtract(
  baseUrl: string,
  oidcToken: string,
  body: string
): Promise<LLMExtractResult> {
  try {
    const t = withTimeout(WORKER_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/v1/extract`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${oidcToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body }),
        signal: t.signal,
      });
    } finally {
      t.cleanup();
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      // 0.5.0-beta.7 (Cipherwake hardening): surface dead-endpoint
      // cases clearly instead of silent regex fallback. The Vercel
      // DEPLOYMENT_NOT_FOUND header / 404 / 503 all mean the hosted
      // backend is unreachable. Emit a STDERR warning with the
      // actionable fix so users running in CI know what's happening.
      const vercelDown = res.status === 404 && /(DEPLOYMENT_NOT_FOUND|deployment could not be found)/i.test(detail);
      const upstreamDown = vercelDown || res.status === 503 || res.status === 502;
      if (upstreamDown) {
        warnDeadEndpoint(baseUrl, "llmExtract");
      }
      return {
        ok: false,
        reason: "error",
        error: `${baseUrl}/v1/extract returned ${res.status}: ${detail.slice(0, 200)}`,
      };
    }
    const data = (await res.json()) as {
      claims?: Claim[];
      cached?: boolean;
      plan?: Plan;
      quota?: { calls: number; limit: number; remaining: number };
    };
    return {
      ok: true,
      claims: data.claims ?? [],
      cached: data.cached ?? false,
      plan: data.plan ?? "free",
      source: "worker",
      quota: data.quota,
    };
  } catch (e) {
    // Network-level error — also could be the endpoint being entirely
    // gone. Surface the warning here too.
    warnDeadEndpoint(baseUrl, "llmExtract");
    return { ok: false, reason: "error", error: `Extract call failed: ${String(e)}` };
  }
}

// 0.5.0-beta.7 (Cipherwake hardening): a single shared warning for
// "hosted endpoint unreachable" cases. Throttled to once per process
// so a CI run that re-tries doesn't spam the same line. Writes to
// stderr so it surfaces in GitHub Actions logs but doesn't pollute
// stdout-consumers (e.g. JSON parsers).
const WARNED_DEAD = new Set<string>();
export function warnDeadEndpoint(baseUrl: string, source: string): void {
  const key = `${source}:${baseUrl}`;
  if (WARNED_DEAD.has(key)) return;
  WARNED_DEAD.add(key);
  if (process.env.PINNEDAI_SUPPRESS_ENDPOINT_WARN === "1") return;
  try {
    process.stderr.write(
      `\n⚠  pinned: hosted endpoint ${baseUrl} is unreachable (${source}).\n` +
      `   This is the Pinned-hosted LLM fallback / analytics proxy. With it down:\n` +
      `     - LLM extraction falls back to regex-only (works, but lower recall on natural-language PRs)\n` +
      `     - Hosted analytics upload pauses\n` +
      `   To proceed without the fallback:\n` +
      `     PINNEDAI_BYOK=anthropic   PINNEDAI_ANTHROPIC_API_KEY=...   (or)\n` +
      `     PINNEDAI_BYOK=openai      PINNEDAI_OPENAI_API_KEY=...\n` +
      `   To point at a self-hosted Worker:\n` +
      `     PINNEDAI_ENDPOINT=https://your-worker.dev   (or pass --endpoint)\n` +
      `   To silence this warning:\n` +
      `     PINNEDAI_SUPPRESS_ENDPOINT_WARN=1\n\n`
    );
  } catch { /* stderr write failure — give up silently */ }
}

function isPaid(plan: Plan): boolean {
  return plan === "pro" || plan === "team" || plan === "enterprise";
}

// Backwards-compat alias kept for older imports.
export const llmFallbackIfAvailable = llmExtract;
