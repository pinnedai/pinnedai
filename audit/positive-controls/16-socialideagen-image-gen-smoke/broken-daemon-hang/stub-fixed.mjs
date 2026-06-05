// Fixed state: worker actually completes the job. Returns terminal status
// synchronously on the POST so the smoke pin's poll loop sees a terminal
// state immediately (representative of the same bug-class — the broken
// version hangs forever, the fixed version completes within bound).
import { createServer } from "node:http";

createServer((req, res) => {
  if (req.method === "POST" && req.url === "/generate") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      // THE FIX: worker completes the job synchronously (or, in real
      // production, the response polls internally until terminal).
      // Either way, the response carries a terminal status when the
      // POST returns.
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "job_1", status: "completed", payload: "<svg width='10'/>" }));
      }, 100);
    });
    return;
  }
  res.writeHead(404); res.end();
}).listen(Number(process.env.PORT ?? 47900));
