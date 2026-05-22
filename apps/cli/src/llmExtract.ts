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
    return { ok: false, reason: "error", error: `Extract call failed: ${String(e)}` };
  }
}

function isPaid(plan: Plan): boolean {
  return plan === "pro" || plan === "team" || plan === "enterprise";
}

// Backwards-compat alias kept for older imports.
export const llmFallbackIfAvailable = llmExtract;
