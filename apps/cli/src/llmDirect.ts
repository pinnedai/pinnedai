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
A "claim" is a verifiable behavioral promise about a route, webhook, page, or CLI command.

Return ONLY claims that match one of these seven shapes:

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

5. page-renders:
   { "template": "page-renders", "route": "/path" }
   Use when the author claims a page renders / loads / displays without crashing.
   "route" is the URL path (e.g. "/dashboard", "/about"). Root path is "/".

6. validation-rejects-bad:
   { "template": "validation-rejects-bad", "route": "/api/X", "method": "POST"|"PUT"|"PATCH"|"DELETE", "requiredFields": ["field1", "field2"] }
   Use when the author claims an endpoint validates input + rejects bad input.
   "requiredFields" is the explicit list of required field names if mentioned;
   empty array [] is acceptable when the author says "validates body" generically.

7. happy-path-with-side-effect:
   { "template": "happy-path-with-side-effect", "route": "/api/X", "method": "POST"|"PUT"|"PATCH"|"DELETE", "sideEffectKind": "db-write", "sideEffectTarget": "<table-or-model-name>" }
   Use when the author claims an endpoint returns 2xx AND performs a downstream
   write (database row, queue message, file upload, email). For v0.2.x only
   db-write is supported; other side-effects extend in v0.3+.
   "sideEffectTarget" is the table/model name (e.g. "users", "orders", "invites").

8. journey (multi-step user-flow walker):
   {
     "template": "journey",
     "label": "<short human label>",
     "steps": [
       {
         "method": "POST"|"GET"|"PUT"|"PATCH"|"DELETE",
         "route": "/path",
         "body": { ... },                          // optional JSON body
         "headers": { "Header-Name": "value" },    // optional extra headers
         "followRedirects": false,                  // default false
         "expect": {
           "status": 200 | { "min": 200, "max": 299 },
           "bodyIncludes": ["substring"],          // body must contain
           "bodyForbids": ["expired", "error"],   // body must NOT contain
           "setsCookie": "session_id",             // Set-Cookie required
           "redirectIncludes": "/dashboard"        // Location header required
         }
       }
     ]
   }
   Use when the author claims a multi-step flow works end-to-end — typically
   N requests where later steps depend on session/state set by earlier ones.
   Examples: "signup then /me returns the new email", "login then /dashboard
   renders without warnings", "checkout then /orders/:id shows the order".
   Cookies from each step's response are jar-collected and sent on subsequent
   steps automatically. Use \`bodyForbids\` for "should NOT see expired session"
   / "no error banner" / "no Application error: a client-side exception"
   regressions. Only emit when the author explicitly described a multi-step
   contract — do NOT split a single-route claim into a one-step journey.

If the PR description contains no recognizable claims, return an empty array.

Do NOT invent claims. Only extract what the author explicitly stated.
Do NOT include routes that are merely mentioned — only ones the PR author claims have specific behavior.

Output schema: { "claims": Claim[] }
Output format: JSON, no prose, no markdown fences.`;

export type DirectResult =
  | { ok: true; claims: Claim[]; provider: ByokProvider }
  | { ok: false; reason: "byok-not-activated" }
  | { ok: false; reason: "byok-key-missing"; provider: ByokProvider }
  | { ok: false; reason: "claude-code-not-installed" }
  | { ok: false; reason: "error"; error: string };

// Provider list — adding a value here requires:
//   1. activeByokProvider() to accept the new string
//   2. Either a new call*() function below OR shared dispatch logic
//   3. The same expansion in llmBugFixPropose.ts (mirror provider list)
// "claude-code"   — shells out to the locally-installed `claude` CLI;
//                   no API key, no quota, uses the user's Claude Pro/Max
//                   subscription. See [[llm-access-claude-code-passthrough]].
// "github-models" — Microsoft's free LLM tier; OAuth via GitHub token in
//                   PINNEDAI_GITHUB_TOKEN. OpenAI-compatible API shape.
export type ByokProvider = "anthropic" | "openai" | "claude-code" | "github-models";

/**
 * Hard kill switch for security-paranoid users. When `PINNEDAI_NO_LLM=1`
 * (or any truthy value) is set in the env, NO LLM call ever fires from
 * Pinned regardless of BYOK env vars being present. This is the
 * checkbox CISOs and audit teams want — a single, observable env var
 * that proves the LLM path can't reach over the network from this
 * machine. See [[three-mode-llm-architecture]] memory: local-only is
 * a hard gate.
 */
export function llmDisabled(): boolean {
  const raw = (process.env.PINNEDAI_NO_LLM ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

// Read PINNEDAI_BYOK to determine which provider the customer has
// explicitly chosen. Anything else (empty, "off", typo) = no BYOK.
// Returns null if PINNEDAI_NO_LLM=1 (hard kill switch wins).
export function activeByokProvider(): ByokProvider | null {
  if (llmDisabled()) return null;
  const raw = (process.env.PINNEDAI_BYOK ?? "").trim().toLowerCase();
  if (raw === "anthropic" || raw === "openai") return raw;
  if (raw === "claude-code" || raw === "claudecode") return "claude-code";
  if (raw === "github-models" || raw === "github" || raw === "gh-models") return "github-models";
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
  if (provider === "openai") {
    const key = process.env.PINNEDAI_OPENAI_KEY;
    if (!key) return { ok: false, reason: "byok-key-missing", provider };
    return callOpenAI(key, prBody);
  }
  if (provider === "claude-code") {
    return callClaudeCode(prBody);
  }
  // provider === "github-models"
  const token = process.env.PINNEDAI_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) return { ok: false, reason: "byok-key-missing", provider };
  return callGitHubModels(token, prBody);
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
        model: process.env.PINNEDAI_OPENAI_MODEL || "gpt-4o-mini",
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

// Claude Code passthrough — shells out to the locally-installed `claude`
// CLI. Uses the user's existing Claude Pro/Max subscription quota; no
// API key, no Pinned billing, no Anthropic billing visible to us. The
// trade is: process startup overhead (~300-500ms vs ~100ms API) and
// dependency on a CLI we don't control. Detect-only-on-opt-in keeps
// the surprise factor at zero — user explicitly chooses claude-code.
async function callClaudeCode(prBody: string): Promise<DirectResult> {
  try {
    const { spawn } = await import("node:child_process");
    const claudeBin = process.env.PINNEDAI_CLAUDE_BIN || "claude";
    const combined = `${SYSTEM_PROMPT}\n\n${prBody}`;
    const proc = spawn(claudeBin, ["-p", combined], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const exitCode: number = await new Promise((resolve) => {
      proc.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") resolve(-127);
        else resolve(-1);
      });
      proc.on("exit", (code) => resolve(code ?? -1));
    });
    if (exitCode === -127) {
      return { ok: false, reason: "claude-code-not-installed" };
    }
    if (exitCode !== 0) {
      return {
        ok: false,
        reason: "error",
        error: `claude-code exit ${exitCode}: ${stderr.slice(0, 200)}`,
      };
    }
    return { ok: true, claims: parseClaimsJson(stdout), provider: "claude-code" };
  } catch (e) {
    return { ok: false, reason: "error", error: `claude-code call failed: ${String(e)}` };
  }
}

// GitHub Models — Microsoft's free LLM tier, OpenAI-compatible API at
// models.github.ai. Auth: GitHub token (Pinned reads PINNEDAI_GITHUB_TOKEN
// first, falls back to the standard GITHUB_TOKEN env var). Token can be
// a personal access token or GitHub Actions OIDC-issued token. Free tier
// has per-user rate limits but no $$$ — good fit for the "we supply LLM
// on us" Free tier backend.
async function callGitHubModels(
  token: string,
  prBody: string
): Promise<DirectResult> {
  try {
    const model = process.env.PINNEDAI_GITHUB_MODEL || "gpt-4o-mini";
    const res = await fetch("https://models.github.ai/inference/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
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
        error: `github-models ${res.status}: ${detail.slice(0, 200)}`,
      };
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content ?? "";
    return { ok: true, claims: parseClaimsJson(text), provider: "github-models" };
  } catch (e) {
    return { ok: false, reason: "error", error: `github-models call failed: ${String(e)}` };
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
