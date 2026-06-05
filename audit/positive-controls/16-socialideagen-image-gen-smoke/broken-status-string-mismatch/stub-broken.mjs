// Parent (buggy) state: worker writes status: "done" — but the smoke pin
// (and the spec) say terminal states are ["completed", "failed"]. Every
// poll returns the same non-terminal-from-the-client's-perspective value.
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
      // THE BUG: status is "done" — but smoke pin polls for
      // ["completed", "failed"] per the spec.
      jobs.set(id, { id, status: "done", payload: "<svg/>" });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id, status: "done", payload: "<svg/>" }));
    });
    return;
  }
  if (req.method === "GET" && req.url?.startsWith("/job/")) {
    const id = req.url.slice(5);
    const j = jobs.get(id);
    if (!j) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(j));
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(Number(process.env.PORT ?? 47900));
