// GET /badge/<org>/<repo> — public SVG badge. Port of apps/edge/src/badge.ts.

import { handleBadge } from "../../../lib/badge.js";
import { fireAndForgetLog } from "../../../lib/response.js";
import { getDb } from "../../../lib/db.js";
import { logEvent } from "../../../lib/usageLog.js";

export const config = { runtime: "edge" };

export default async function handler(request: Request): Promise<Response> {
  const response = await handleBadge(request);
  fireAndForgetLog(async () => {
    try {
      const db = getDb();
      await logEvent(db, { request, endpoint: "/badge", statusCode: response.status });
    } catch { /* skip */ }
  });
  return response;
}
