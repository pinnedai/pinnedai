// Tiny JSON response helper, shared by every handler.
export function json(body: unknown, status: number = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

// Wrap a handler so its endpoint + status code lands in pin_events
// even when the inner handler throws or returns a non-Response.
export async function withUsageLog(
  request: Request,
  endpoint: string,
  inner: () => Promise<Response>,
  // Lazy-loaded logger so handlers that don't need DB (healthz) skip it.
  logger?: (status: number) => Promise<void> | void
): Promise<Response> {
  let response: Response;
  try {
    response = await inner();
  } catch (e) {
    response = new Response(
      JSON.stringify({ error: "internal", detail: String(e).slice(0, 200) }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }
  if (logger) {
    try {
      await logger(response.status);
    } catch { /* logging never fails the request */ }
  }
  return response;
}

// Same shape as withUsageLog but kicks the logger via waitUntil-style
// fire-and-forget — Edge Functions don't have ctx.waitUntil, but
// Vercel auto-awaits any returned promise on the response. For
// non-blocking, we just don't await.
export function fireAndForgetLog(
  fn: () => Promise<void>
): void {
  fn().catch(() => { /* never fail the response */ });
}
