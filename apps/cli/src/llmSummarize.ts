// Tiny LLM summary layer for `pinned safety --summarize`.
//
// Sends ONLY the compact findings JSON (no diff, no source) to the
// hosted Worker. The Worker calls gpt-4o-mini with a constrained
// prompt and returns a 3-bullet markdown summary.
//
// Cost characteristics:
//   - Input: ~200-500 tokens (just findings array)
//   - Output: ~100-200 tokens (3 bullets)
//   - ~$0.0001-0.0003 per call on gpt-4o-mini
//   - Counts against monthly LLM quota same as /v1/extract

import type { SafetyFinding } from "./safetyPass.js";

const DEFAULT_ENDPOINT = "https://api.pinnedai.dev";

export type SummarizeResult =
  | { ok: true; markdown: string }
  | { ok: false; reason: string };

export async function llmSafetySummarize(
  findings: SafetyFinding[]
): Promise<SummarizeResult> {
  if (process.env.GITHUB_ACTIONS !== "true") {
    return {
      ok: false,
      reason:
        "OIDC unavailable (run inside a GitHub Action with `permissions: id-token: write`).",
    };
  }
  const tokenUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!tokenUrl || !requestToken) {
    return {
      ok: false,
      reason:
        "Missing ACTIONS_ID_TOKEN_REQUEST_URL / ACTIONS_ID_TOKEN_REQUEST_TOKEN — add `permissions: id-token: write` to your workflow.",
    };
  }
  let oidcToken: string;
  try {
    const fullUrl =
      tokenUrl + (tokenUrl.includes("?") ? "&" : "?") + "audience=pinnedai";
    const res = await fetch(fullUrl, {
      headers: { Authorization: `Bearer ${requestToken}` },
    });
    if (!res.ok) {
      return { ok: false, reason: `OIDC token fetch failed: ${res.status}` };
    }
    const data = (await res.json()) as { value?: string };
    if (!data.value) {
      return { ok: false, reason: "OIDC response missing value" };
    }
    oidcToken = data.value;
  } catch (e) {
    return { ok: false, reason: `OIDC fetch error: ${String(e)}` };
  }

  // Send only the COMPACT findings — never the diff, never source files.
  const compact = {
    findings: findings.slice(0, 30).map((f) => ({
      rule: f.rule,
      severity: f.severity,
      file: f.file,
      message: f.message,
    })),
    counts: {
      warn: findings.filter((f) => f.severity === "warn").length,
      info: findings.filter((f) => f.severity === "info").length,
    },
  };
  const endpoint = (
    process.env.PINNEDAI_ENDPOINT ?? DEFAULT_ENDPOINT
  ).replace(/\/+$/, "");

  try {
    const res = await fetch(`${endpoint}/v1/summarize`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${oidcToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(compact),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      // 0.5.0-beta.7 (Cipherwake hardening): surface dead-endpoint
      // case clearly instead of silent fallback. Same warning as
      // llmExtract — shared helper.
      const vercelDown = res.status === 404 && /(DEPLOYMENT_NOT_FOUND|deployment could not be found)/i.test(detail);
      const upstreamDown = vercelDown || res.status === 503 || res.status === 502;
      if (upstreamDown) {
        const { warnDeadEndpoint } = await import("./llmExtract.js");
        warnDeadEndpoint(endpoint, "llmSummarize");
      }
      return {
        ok: false,
        reason: `${endpoint}/v1/summarize returned ${res.status}: ${detail.slice(0, 200)}`,
      };
    }
    const data = (await res.json()) as { markdown?: string };
    if (!data.markdown) {
      return { ok: false, reason: "/v1/summarize response missing 'markdown' field" };
    }
    return { ok: true, markdown: data.markdown };
  } catch (e) {
    const { warnDeadEndpoint } = await import("./llmExtract.js");
    warnDeadEndpoint(endpoint, "llmSummarize");
    return { ok: false, reason: `Summarize call failed: ${String(e)}` };
  }
}
