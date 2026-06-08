// GET /healthz — liveness probe. No DB. Logged via pin_events
// alongside everything else.
import { json, fireAndForgetLog } from "../lib/response.js";
import { getDb } from "../lib/db.js";
import { logEvent } from "../lib/usageLog.js";

export const config = { runtime: "edge" };

export default async function handler(request: Request): Promise<Response> {
  const response = json({ ok: true, service: "pinnedai-api" });
  fireAndForgetLog(async () => {
    try {
      const db = getDb();
      await logEvent(db, { request, endpoint: "/healthz", statusCode: response.status });
    } catch { /* no DB configured yet — skip */ }
  });
  return response;
}
