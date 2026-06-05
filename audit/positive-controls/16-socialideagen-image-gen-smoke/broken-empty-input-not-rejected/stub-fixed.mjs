// Fixed state: server validates the prompt before running.
import { createServer } from "node:http";

createServer((req, res) => {
  if (req.method === "POST" && req.url === "/generate") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let p = {};
      try { p = JSON.parse(body || "{}"); } catch {}
      // THE FIX: explicit validation. Empty prompt is rejected with
      // status 400 + a "validation" message in the body so the smoke
      // pin's `rejects` assertion matches.
      if (!p.prompt || typeof p.prompt !== "string" || p.prompt.length === 0) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "validation failed: prompt required" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "job_1", status: "completed", payload: "<svg/>" }));
    });
    return;
  }
  res.writeHead(404); res.end();
}).listen(Number(process.env.PORT ?? 47900));
