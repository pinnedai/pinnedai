// OpenAI proxy with constrained extraction prompt.
//
// We call gpt-4o-mini in JSON mode and force the model to emit a
// claim shape that matches the regex parser's output. The LLM never
// writes test logic — only fills slots. Architecture pillar #1.
//
// Cost target: ~$0.001 per call at gpt-4o-mini pricing (small input,
// strict JSON output). At 100 calls/repo/mo × 1000 repos = $100/mo
// OpenAI bill at MVP scale. Watch this.

// Claim is a structural type shared with the CLI. We don't bind to the
// CLI package here (would couple this Worker's deploy to the CLI's
// build) — just declare what we need.
type Claim = Record<string, unknown> & { template: string };

const SYSTEM_PROMPT = `You extract structured claims from GitHub pull request descriptions.
A "claim" is a verifiable behavioral promise about a route or webhook.

Return ONLY claims that match one of these three shapes:

1. rate-limit:
   { "template": "rate-limit", "route": "/api/X", "rate": N, "window": "second"|"minute"|"hour" }

2. auth-required:
   { "template": "auth-required", "route": "/api/X" }

3. idempotent:
   { "template": "idempotent", "route": "/webhooks/X", "idField": "event_id" }

If the PR description contains no recognizable claims, return an empty array.

Do NOT invent claims. Only extract what the author explicitly stated.
Do NOT include routes that are merely mentioned — only ones the PR author claims have specific behavior.

Output schema: { "claims": Claim[] }
Output format: JSON, no prose, no markdown fences.`;

export async function extractClaimsLLM(
  apiKey: string,
  prBody: string
): Promise<Claim[]> {
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
    const text = await res.text();
    throw new Error(`openai: ${res.status} ${text.slice(0, 200)}`);
  }

  const body = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  const raw = body.choices[0]?.message?.content;
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  return normalizeClaims(parsed);
}

function normalizeClaims(parsed: unknown): Claim[] {
  if (!parsed || typeof parsed !== "object") return [];
  const arr = (parsed as { claims?: unknown }).claims;
  if (!Array.isArray(arr)) return [];

  const claims: Claim[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const template = o.template;
    const route = o.route;

    if (typeof route !== "string" || !route.startsWith("/")) continue;

    if (template === "rate-limit") {
      const rate = Number(o.rate);
      const window = o.window;
      if (
        Number.isFinite(rate) &&
        rate > 0 &&
        (window === "second" || window === "minute" || window === "hour")
      ) {
        claims.push({
          template: "rate-limit",
          route,
          rate,
          window,
          raw: `[llm] ${route} ${rate}/${window}`,
        });
      }
    } else if (template === "auth-required") {
      claims.push({
        template: "auth-required",
        route,
        raw: `[llm] auth-required ${route}`,
      });
    } else if (template === "idempotent") {
      const idField = o.idField;
      if (typeof idField === "string" && idField.length > 0) {
        claims.push({
          template: "idempotent",
          route,
          idField,
          raw: `[llm] idempotent ${route} on ${idField}`,
        });
      }
    }
  }
  return claims;
}
