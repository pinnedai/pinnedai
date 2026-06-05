import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadContracts, detectContractDrift, describeContractHit } from "./contracts.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pinned-contracts-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeContract(name: string, body: object) {
  const cdir = join(dir, ".pinned/contracts");
  mkdirSync(cdir, { recursive: true });
  writeFileSync(join(cdir, `${name}.json`), JSON.stringify(body));
}

describe("loadContracts", () => {
  it("returns empty when .pinned/contracts/ is missing", () => {
    expect(loadContracts(dir)).toEqual([]);
  });

  it("loads a valid contract", () => {
    writeContract("job-status", {
      name: "job-status",
      column: "status",
      values: ["pending", "processing", "completed", "failed"],
    });
    const cs = loadContracts(dir);
    expect(cs).toHaveLength(1);
    expect(cs[0].name).toBe("job-status");
    expect(cs[0].column).toBe("status");
    expect(cs[0].values).toEqual(["pending", "processing", "completed", "failed"]);
  });

  it("ignores malformed JSON", () => {
    mkdirSync(join(dir, ".pinned/contracts"), { recursive: true });
    writeFileSync(join(dir, ".pinned/contracts/bad.json"), "{not valid json");
    expect(loadContracts(dir)).toEqual([]);
  });

  it("ignores contracts missing required fields", () => {
    writeContract("incomplete", { name: "x" }); // no values
    writeContract("empty", { name: "y", values: [] }); // empty values
    writeContract("noname", { values: ["a", "b"] }); // no name
    expect(loadContracts(dir)).toEqual([]);
  });
});

describe("detectContractDrift — the socialideagen bug case", () => {
  it("flags consumer comparing against undeclared 'done' literal", () => {
    const contracts = [
      {
        name: "job-status",
        column: "status",
        values: ["pending", "processing", "completed", "failed"],
        sourcePath: ".pinned/contracts/job-status.json",
      },
    ];
    const files = new Map<string, string>([
      [
        "src/client/poll.ts",
        `export function isDone(job: any) {\n  return job.status === "done";\n}`,
      ],
    ]);
    const hits = detectContractDrift(files, contracts);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      kind: "consumer-uses-undeclared",
      value: "done",
      column: "status",
      filePath: "src/client/poll.ts",
      line: 2,
    });
  });

  it("flags producer emitting undeclared value", () => {
    const contracts = [
      {
        name: "job-status",
        column: "status",
        values: ["pending", "processing", "completed", "failed"],
        sourcePath: ".pinned/contracts/job-status.json",
      },
    ];
    const files = new Map<string, string>([
      [
        "worker/run.ts",
        `await db.jobs.update({ status: "limbo" });`,
      ],
    ]);
    const hits = detectContractDrift(files, contracts);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      kind: "producer-emits-undeclared",
      value: "limbo",
      column: "status",
    });
  });

  it("does NOT flag a declared value", () => {
    const contracts = [
      {
        name: "job-status",
        column: "status",
        values: ["pending", "processing", "completed", "failed"],
        sourcePath: ".pinned/contracts/job-status.json",
      },
    ];
    const files = new Map<string, string>([
      ["src/poll.ts", `if (job.status === "completed") { /* ok */ }`],
      ["worker/run.ts", `update({ status: "processing" })`],
    ]);
    expect(detectContractDrift(files, contracts)).toHaveLength(0);
  });

  it("returns empty when no contracts are loaded (opt-in only)", () => {
    const files = new Map<string, string>([
      ["src/poll.ts", `if (job.status === "done") {}`],
    ]);
    expect(detectContractDrift(files, [])).toEqual([]);
  });

  it("skips test files + migration paths", () => {
    const contracts = [
      {
        name: "job-status",
        column: "status",
        values: ["completed"],
        sourcePath: ".pinned/contracts/job-status.json",
      },
    ];
    const files = new Map<string, string>([
      ["tests/x.test.ts", `expect(job.status).toBe("done")`],
      ["migrations/001.ts", `await update({ status: "bogus" })`],
    ]);
    expect(detectContractDrift(files, contracts)).toEqual([]);
  });

  it("supports column-name binding when contract omits explicit `column`", () => {
    // Contract name `verdict` (no column field) should bind to comparisons on .verdict
    const contracts = [
      {
        name: "verdict",
        values: ["pass", "fail"],
        sourcePath: ".pinned/contracts/verdict.json",
      },
    ];
    const files = new Map<string, string>([
      ["src/grader.ts", `if (result.verdict === "tbd") {}`],
    ]);
    const hits = detectContractDrift(files, contracts);
    expect(hits).toHaveLength(1);
    expect(hits[0].value).toBe("tbd");
  });

  it("dedupes the same (file, line, value, contract) hit", () => {
    const contracts = [
      {
        name: "job-status",
        column: "status",
        values: ["completed"],
        sourcePath: ".pinned/contracts/job-status.json",
      },
    ];
    const files = new Map<string, string>([
      // Producer regex AND assign regex would both match on the same line
      ["worker/run.ts", `data = { status: "done" }`],
    ]);
    const hits = detectContractDrift(files, contracts);
    // Only one hit despite two regex paths matching
    expect(hits).toHaveLength(1);
  });
});

describe("describeContractHit", () => {
  it("formats consumer hit", () => {
    const out = describeContractHit({
      kind: "consumer-uses-undeclared",
      contract: {
        name: "job-status",
        values: ["completed", "failed"],
        sourcePath: ".pinned/contracts/job-status.json",
      },
      filePath: "src/poll.ts",
      line: 12,
      value: "done",
      column: "status",
      excerpt: "",
    });
    expect(out).toContain("src/poll.ts:12");
    expect(out).toContain('compares status === "done"');
    expect(out).toContain("completed | failed");
    expect(out).toContain("producer-in-different-repo");
  });
});
