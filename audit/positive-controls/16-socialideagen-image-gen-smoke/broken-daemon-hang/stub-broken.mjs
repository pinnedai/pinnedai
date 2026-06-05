// Parent (buggy) state: worker hangs — never reaches a terminal state.
// Rows stay in "processing" forever. The image-gen daemon-hang bug.
import { createServer } from "node:http";

const jobs = new Map();
let nextId = 1;

createServer((req, res) => {
  if (req.method === "POST" && req.url === "/generate") {
    const id = `job_${nextId++}`;
    // THE BUG: the job submission creates a row, but the worker NEVER
    // writes a terminal status. Status stays "processing" forever.
    jobs.set(id, { id, status: "processing", payload: null });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id, status: "processing" }));
    return;
  }
  if (req.method === "GET" && req.url?.startsWith("/job/")) {
    const id = req.url.slice(5);
    const j = jobs.get(id);
    if (!j) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(j)); // forever "processing"
    return;
  }
  res.writeHead(404); res.end();
}).listen(Number(process.env.PORT ?? 47900));
