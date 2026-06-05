import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readStore,
  writeStore,
  makeSuppressionId,
  isSuppressed,
  addSuppression,
  removeSuppression,
  fingerprintFor,
} from "./suppressions.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pinned-suppress-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readStore", () => {
  it("returns empty store when file is missing", () => {
    expect(readStore(dir)).toEqual({ version: 1, suppressions: [] });
  });

  it("loads existing store", () => {
    mkdirSync(join(dir, ".pinned"), { recursive: true });
    writeFileSync(
      join(dir, ".pinned/suppressions.json"),
      JSON.stringify({
        version: 1,
        suppressions: [
          {
            id: "enum-drift:abc",
            detector: "enum-drift",
            filePath: "src/x.ts",
            fingerprint: "k",
            reason: "ok",
            dismissedAt: "2026-06-05T00:00:00Z",
          },
        ],
      })
    );
    const s = readStore(dir);
    expect(s.suppressions).toHaveLength(1);
    expect(s.suppressions[0].id).toBe("enum-drift:abc");
  });

  it("throws on corrupt JSON (fail closed — never silently overwrite)", () => {
    mkdirSync(join(dir, ".pinned"), { recursive: true });
    writeFileSync(join(dir, ".pinned/suppressions.json"), "{not json");
    expect(() => readStore(dir)).toThrow(/Corrupt/);
  });
});

describe("makeSuppressionId", () => {
  it("is deterministic for same inputs", () => {
    const a = makeSuppressionId("enum-drift", "src/x.ts", "fp");
    const b = makeSuppressionId("enum-drift", "src/x.ts", "fp");
    expect(a).toBe(b);
  });

  it("differs across detectors", () => {
    expect(makeSuppressionId("enum-drift", "src/x.ts", "fp"))
      .not.toBe(makeSuppressionId("env-required", "src/x.ts", "fp"));
  });

  it("differs across file paths", () => {
    expect(makeSuppressionId("enum-drift", "src/x.ts", "fp"))
      .not.toBe(makeSuppressionId("enum-drift", "src/y.ts", "fp"));
  });

  it("prefixes the detector name (browseability)", () => {
    expect(makeSuppressionId("enum-drift", "f", "g")).toMatch(/^enum-drift:/);
  });
});

describe("addSuppression + isSuppressed + removeSuppression", () => {
  it("addSuppression appends a new entry", () => {
    const store0 = readStore(dir);
    const { store: store1, added, entry } = addSuppression(store0, {
      detector: "enum-drift",
      filePath: "src/x.ts",
      fingerprint: "column=status;missing=done",
      reason: "Legacy compat path",
    });
    expect(added).toBe(true);
    expect(store1.suppressions).toHaveLength(1);
    expect(entry.id).toMatch(/^enum-drift:/);
  });

  it("addSuppression is idempotent on identical inputs", () => {
    const s0 = readStore(dir);
    const r1 = addSuppression(s0, {
      detector: "enum-drift",
      filePath: "src/x.ts",
      fingerprint: "k",
      reason: "ok",
    });
    const r2 = addSuppression(r1.store, {
      detector: "enum-drift",
      filePath: "src/x.ts",
      fingerprint: "k",
      reason: "different reason — still same key",
    });
    expect(r2.added).toBe(false);
    expect(r2.store.suppressions).toHaveLength(1);
    // Reason of FIRST add is preserved
    expect(r2.store.suppressions[0].reason).toBe("ok");
  });

  it("isSuppressed returns true after add and false after remove", () => {
    let s = readStore(dir);
    s = addSuppression(s, {
      detector: "enum-drift",
      filePath: "src/x.ts",
      fingerprint: "k",
      reason: "r",
    }).store;
    expect(isSuppressed(s, "enum-drift", "src/x.ts", "k")).toBe(true);
    expect(isSuppressed(s, "enum-drift", "src/x.ts", "different")).toBe(false);

    const id = makeSuppressionId("enum-drift", "src/x.ts", "k");
    const r = removeSuppression(s, id);
    expect(r.removed).toBe(true);
    expect(isSuppressed(r.store, "enum-drift", "src/x.ts", "k")).toBe(false);
  });

  it("writeStore + readStore round-trips correctly", () => {
    const s0 = readStore(dir);
    const s1 = addSuppression(s0, {
      detector: "env-required",
      filePath: ".env.example",
      fingerprint: "keys=DATABASE_URL,STRIPE_SECRET",
      reason: "Intentional — keys live in vault",
    }).store;
    writeStore(dir, s1);
    expect(existsSync(join(dir, ".pinned/suppressions.json"))).toBe(true);
    const s2 = readStore(dir);
    expect(s2.suppressions).toHaveLength(1);
    expect(s2.suppressions[0].reason).toContain("vault");
  });
});

describe("fingerprintFor — refactor robustness (no `line` in any output)", () => {
  it("enum-drift fingerprint = column + sorted missing", () => {
    const f = fingerprintFor("enum-drift", {
      column: "status",
      missingFromProducer: ["done", "stuck"],
      consumerFile: "src/x.ts",
      line: 12,
    });
    expect(f).toContain("column=status");
    expect(f).toContain("missing=done,stuck");
    expect(f).not.toContain("line");
  });

  it("contract-drift fingerprint = kind + column + value", () => {
    expect(fingerprintFor("contract-drift", {
      kind: "consumer-uses-undeclared",
      column: "status",
      value: "done",
      line: 14,
    })).toBe("kind=consumer-uses-undeclared;column=status;value=done");
  });

  it("env-required fingerprint = sorted required keys", () => {
    expect(fingerprintFor("env-required", {
      requiredKeys: ["STRIPE_SECRET", "DATABASE_URL"],
    })).toBe("keys=DATABASE_URL,STRIPE_SECRET");
  });

  it("mass-mutation fingerprint = op + table", () => {
    expect(fingerprintFor("mass-mutation", { operation: "delete", table: "users" }))
      .toBe("op=delete;table=users");
  });

  it("unknown detector falls back to JSON.stringify", () => {
    const f = fingerprintFor("brand-new-detector", { foo: "bar" });
    expect(f).toContain("foo");
    expect(f).toContain("bar");
  });

  it("sorting is stable — same set of keys in different order produces same fp", () => {
    const a = fingerprintFor("env-required", { requiredKeys: ["A", "B", "C"] });
    const b = fingerprintFor("env-required", { requiredKeys: ["C", "A", "B"] });
    expect(a).toBe(b);
  });
});
