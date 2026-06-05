// Fixed state: worker writes the contract-declared terminal value "completed".
import { createServer } from "node:http";

const jobs = new Map();
let nextId = 1;

createServer((req, res) => {
  if (req.method === "POST" && req.url === "/generate") {
    const id = `job_${nextId++}`;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const p = JSON.parse(body || "{}");
      // THE FIX: status is "completed" — matches the spec's terminal
      // vocabulary so the smoke pin's poll loop sees a terminal state.
      jobs.set(id, { id, status: "completed", payload: "<svg width='10'/>" });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id, status: "completed", payload: "<svg width='10'/>" }));
    });
    return;
  }
  if (req.method === "GET" && req.url?.startsWith("/job/")) {
    const id = req.url.slice(5);
    const j = jobs.get(id);
    if (!j) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(j));
    return;
  }
  res.writeHead(404); res.end();
}).listen(Number(process.env.PORT ?? 47900));
