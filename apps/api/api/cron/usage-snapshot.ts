// Vercel cron endpoint. Configured in vercel.json:
//   { path: "/api/cron/usage-snapshot", schedule: "10 9 * * *" }
//
// Vercel sends `Authorization: Bearer <CRON_SECRET>` (when set in
// project env) on cron invocations. handleCronSnapshot accepts that
// or ADMIN_KEY (so ad-hoc curl re-runs also work).

import { handleCronSnapshot } from "../../lib/handlers.js";
import { getDb } from "../../lib/db.js";
import { logEvent } from "../../lib/usageLog.js";
import { fireAndForgetLog } from "../../lib/response.js";

export const config = { runtime: "edge" };

export default async function handler(request: Request): Promise<Response> {
  const db = getDb();
  const response = await handleCronSnapshot(request, process.env as never, db);
  fireAndForgetLog(async () => {
    try { await logEvent(db, { request, endpoint: "/api/cron/usage-snapshot", statusCode: response.status }); } catch {}
  });
  return response;
}
