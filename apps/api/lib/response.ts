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

// Fire-and-forget log helper. Edge Functions don't have ctx.waitUntil;
// not awaiting the promise is the equivalent — Vercel still lets the
// promise complete (within reason). Errors are swallowed.
export function fireAndForgetLog(
  fn: () => Promise<void>
): void {
  fn().catch(() => { /* never fail the response */ });
}
