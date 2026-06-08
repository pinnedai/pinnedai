import { handleRepoStatsUpload } from "../../lib/repoStatsUpload.js";
import { getDb } from "../../lib/db.js";
import { logEvent } from "../../lib/usageLog.js";
import { fireAndForgetLog } from "../../lib/response.js";

export const config = { runtime: "edge" };

export default async function handler(request: Request): Promise<Response> {
  const db = getDb();
  const response = await handleRepoStatsUpload(request, process.env as never, db);
  fireAndForgetLog(async () => {
    try { await logEvent(db, { request, endpoint: "/v1/repo-stats", statusCode: response.status }); } catch {}
  });
  return response;
}
