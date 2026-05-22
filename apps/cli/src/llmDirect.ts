// BYOK direct-LLM extraction (Pro/Team/Enterprise feature).
//
// BYOK requires EXPLICIT opt-in via two signals:
//   - `byok` action input set to "anthropic" or "openai" (passed
//     through as PINNEDAI_BYOK env var)
//   - A matching PINNEDAI_-prefixed key set:
//       PINNEDAI_ANTHROPIC_KEY=sk-ant-...
//       PINNEDAI_OPENAI_KEY=sk-...
//
// Naked ANTHROPIC_API_KEY / OPENAI_API_KEY are intentionally NOT
// auto-discovered — many repos already have those for unrelated jobs,
// and silently routing PR descriptions through them would be a
// surprise. The PINNEDAI_-prefix forces a deliberate choice.
//
// Paid-tier gate is enforced by the caller (llmExtract) based on the
// plan returned by the Worker — Free orgs ignore BYOK env vars.

import type { Claim } from "./claimParser.js";

const SYSTEM_PROMPT = `You extract structured claims from GitHub pull request descriptions.
A "claim" is a verifiable behavioral promise about a route, webhook, or CLI command.

Return ONLY claims that match one of these four shapes:

1. rate-limit:
   { "template": "rate-limit", "route": "/api/X", "rate": N, "window": "second"|"minute"|"hour" }

2. auth-required:
   { "template": "auth-required", "route": "/api/X" }

3. idempotent:
   { "template": "idempotent", "route": "/webhooks/X", "idField": "event_id" }

4. cli-output-contains:
   { "template": "cli-output-contains", "route": "<cli invocation>", "text": "<expected stdout substring>" }
   Use this when the author claims a CLI command emits specific output.
   "route" is the full command invocation (e.g. "pinned doctor", "npm test").

If the PR description contains no recognizable claims, return an empty array.

Do NOT invent claims. Only extract what the author explicitly stated.
Do NOT include routes that are merely mentioned — only ones the PR author claims have specific behavior.

Output schema: { "claims": Claim[] }
Output format: JSON, no prose, no markdown fences.`;

export type DirectResult =
  | { ok: true; claims: Claim[]; provider: "anthropic" | "openai" }
  | { ok: false; reason: "byok-not-activated" }
  | { ok: false; reason: "byok-key-missing"; provider: "anthropic" | "openai" }
  | { ok: false; reason: "error"; error: string };

export type ByokProvider = "anthropic" | "openai";

// Read PINNEDAI_BYOK to determine which provider the customer has
// explicitly chosen. Anything else (empty, "off", typo) = no BYOK.
export function activeByokProvider(): ByokProvider | null {
  const raw = (process.env.PINNEDAI_BYOK ?? "").trim().toLowerCase();
  if (raw === "anthropic" || raw === "openai") return raw;
  return null;
}

export async function extractDirect(prBody: string): Promise<DirectResult> {
  const provider = activeByokProvider();
  if (!provider) {
    return { ok: false, reason: "byok-not-activated" };
  }
  if (provider === "anthropic") {
    const key = process.env.PINNEDAI_ANTHROPIC_KEY;
    if (!key) return { ok: false, reason: "byok-key-missing", provider };
    return callAnthropic(key, prBody);
  }
  // provider === "openai"
  const key = process.env.PINNEDAI_OPENAI_KEY;
  if (!key) return { ok: false, reason: "byok-key-missing", provider };
  return callOpenAI(key, prBody);
}

async function callAnthropic(
  apiKey: string,
  prBody: string
): Promise<DirectResult> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: prBody }],
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return {
        ok: false,
        reason: "error",
        error: `anthropic ${res.status}: ${detail.slice(0, 200)}`,
      };
    }
    const data = (await res.json()) as {
      content?: Array<{ type: string; text: string }>;
    };
    const text = data.content?.find((c) => c.type === "text")?.text ?? "";
    return { ok: true, claims: parseClaimsJson(text), provider: "anthropic" };
  } catch (e) {
    return { ok: false, reason: "error", error: `anthropic call failed: ${String(e)}` };
  }
}

async function callOpenAI(
  apiKey: string,
  prBody: string
): Promise<DirectResult> {
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prBody },
        ],
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return {
        ok: false,
        reason: "error",
        error: `openai ${res.status}: ${detail.slice(0, 200)}`,
      };
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content ?? "";
    return { ok: true, claims: parseClaimsJson(text), provider: "openai" };
  } catch (e) {
    return { ok: false, reason: "error", error: `openai call failed: ${String(e)}` };
  }
}

function parseClaimsJson(raw: string): Claim[] {
  // Strip markdown fences if the model wrapped JSON (Anthropic sometimes does)
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const arr = (parsed as { claims?: unknown }).claims;
  if (!Array.isArray(arr)) return [];

  const out: Claim[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const tmpl = o.template;
    const route = o.route;
    if (typeof route !== "string" || route.length === 0) continue;
    // Web templates require "/" prefix; CLI template does not.
    const isCliTemplate = tmpl === "cli-output-contains";
    if (!isCliTemplate && !route.startsWith("/")) continue;

    if (tmpl === "rate-limit") {
      const rate = Number(o.rate);
      const w = o.window;
      if (
        Number.isInteger(rate) &&
        rate > 0 &&
        (w === "second" || w === "minute" || w === "hour")
      ) {
        out.push({
          template: "rate-limit",
          route,
          rate,
          window: w,
          raw: `[byok] ${route} ${rate}/${w}`,
        });
      }
    } else if (tmpl === "auth-required") {
      out.push({
        template: "auth-required",
        route,
        raw: `[byok] auth-required ${route}`,
      });
    } else if (tmpl === "idempotent") {
      const idField = o.idField;
      if (typeof idField === "string" && idField.length > 0) {
        out.push({
          template: "idempotent",
          route,
          idField,
          raw: `[byok] idempotent ${route} on ${idField}`,
        });
      }
    } else if (tmpl === "cli-output-contains") {
      const text = o.text;
      // Bound the captured text to the same limit the regex parser
      // enforces (200 chars) so the LLM can't inject a runaway string.
      if (
        typeof text === "string" &&
        text.length > 0 &&
        text.length <= 200 &&
        route.length <= 200
      ) {
        out.push({
          template: "cli-output-contains",
          route,
          text,
          raw: `[byok] cli ${route} outputs ${text}`,
        });
      }
    }
  }
  return out;
}
