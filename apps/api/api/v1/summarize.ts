import { handleSummarize } from "../../lib/handlers.js";
import { getDb } from "../../lib/db.js";
import { logEvent } from "../../lib/usageLog.js";
import { fireAndForgetLog } from "../../lib/response.js";

export const config = { runtime: "edge" };

export default async function handler(request: Request): Promise<Response> {
  const db = getDb();
  const response = await handleSummarize(request, process.env as never, db);
  fireAndForgetLog(async () => {
    try { await logEvent(db, { request, endpoint: "/v1/summarize", statusCode: response.status }); } catch {}
  });
  return response;
}
