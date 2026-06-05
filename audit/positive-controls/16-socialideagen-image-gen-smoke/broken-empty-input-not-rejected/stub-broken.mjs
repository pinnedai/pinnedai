// Parent (buggy) state: server runs generation on empty prompt — no
// validation. Returns empty payload. The "AI built it but forgot to
// validate" bug shape.
import { createServer } from "node:http";

createServer((req, res) => {
  if (req.method === "POST" && req.url === "/generate") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      // THE BUG: no validation. Empty prompt yields empty payload but
      // 200 OK. The client thinks the request succeeded.
      let p = {};
      try { p = JSON.parse(body || "{}"); } catch {}
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "job_1", status: "completed", payload: "" }));
    });
    return;
  }
  res.writeHead(404); res.end();
}).listen(Number(process.env.PORT ?? 47900));
