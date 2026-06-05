import { describe, it, expect } from "vitest";
import { recordRun, classifyAll, flakyPins, type SmokeHistory } from "./smokeHistory.js";

function h0(): SmokeHistory { return { version: 1, runs: [] }; }

describe("recordRun + bounded history", () => {
  it("prepends new run", () => {
    let h = h0();
    h = recordRun(h, { claimId: "p1", at: "2026-06-05T10:00:00Z", outcome: "green" });
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0].outcome).toBe("green");
  });

  it("bounds to 500 entries", () => {
    let h = h0();
    for (let i = 0; i < 600; i++) {
      h = recordRun(h, { claimId: `p${i}`, at: "2026-06-05T10:00:00Z", outcome: "green" });
    }
    expect(h.runs).toHaveLength(500);
  });
});

describe("classifyAll", () => {
  it("classifies as 'solid' when all green", () => {
    let h = h0();
    for (let i = 0; i < 10; i++) h = recordRun(h, { claimId: "p1", at: "2026-06-05T10:00:00Z", outcome: "green" });
    const c = classifyAll(h);
    expect(c).toHaveLength(1);
    expect(c[0].classification).toBe("solid");
  });

  it("classifies as 'broken' when all red", () => {
    let h = h0();
    for (let i = 0; i < 10; i++) h = recordRun(h, { claimId: "p1", at: "2026-06-05T10:00:00Z", outcome: "red" });
    const c = classifyAll(h);
    expect(c[0].classification).toBe("broken");
  });

  it("classifies as 'flaky' on mix of green and red", () => {
    let h = h0();
    h = recordRun(h, { claimId: "p1", at: "2026-06-05T10:00:00Z", outcome: "green" });
    h = recordRun(h, { claimId: "p1", at: "2026-06-05T10:00:01Z", outcome: "red" });
    h = recordRun(h, { claimId: "p1", at: "2026-06-05T10:00:02Z", outcome: "green" });
    h = recordRun(h, { claimId: "p1", at: "2026-06-05T10:00:03Z", outcome: "green" });
    h = recordRun(h, { claimId: "p1", at: "2026-06-05T10:00:04Z", outcome: "green" });
    const c = classifyAll(h);
    expect(c[0].classification).toBe("flaky");
    expect(c[0].redRate).toBeCloseTo(0.2);
  });

  it("classifies as 'unknown' below minRuns threshold", () => {
    let h = h0();
    h = recordRun(h, { claimId: "p1", at: "2026-06-05T10:00:00Z", outcome: "green" });
    h = recordRun(h, { claimId: "p1", at: "2026-06-05T10:00:01Z", outcome: "green" });
    const c = classifyAll(h);
    expect(c[0].classification).toBe("unknown");
  });

  it("ignores skip outcomes when classifying", () => {
    let h = h0();
    for (let i = 0; i < 20; i++) h = recordRun(h, { claimId: "p1", at: "2026-06-05T10:00:00Z", outcome: "skip" });
    const c = classifyAll(h);
    expect(c[0].classification).toBe("unknown");
    expect(c[0].runsConsidered).toBe(0);
  });

  it("sorts broken > flaky > solid", () => {
    let h = h0();
    for (let i = 0; i < 10; i++) h = recordRun(h, { claimId: "solid-pin", at: "2026-06-05T10:00:00Z", outcome: "green" });
    h = recordRun(h, { claimId: "flaky-pin", at: "2026-06-05T10:00:01Z", outcome: "green" });
    h = recordRun(h, { claimId: "flaky-pin", at: "2026-06-05T10:00:02Z", outcome: "red" });
    h = recordRun(h, { claimId: "flaky-pin", at: "2026-06-05T10:00:03Z", outcome: "green" });
    for (let i = 0; i < 10; i++) h = recordRun(h, { claimId: "broken-pin", at: "2026-06-05T10:00:00Z", outcome: "red" });
    const c = classifyAll(h);
    expect(c.map((x) => x.claimId)).toEqual(["broken-pin", "flaky-pin", "solid-pin"]);
  });
});

describe("flakyPins", () => {
  it("returns only flaky pins", () => {
    let h = h0();
    for (let i = 0; i < 10; i++) h = recordRun(h, { claimId: "solid-pin", at: "2026-06-05T10:00:00Z", outcome: "green" });
    h = recordRun(h, { claimId: "flaky-pin", at: "2026-06-05T10:00:01Z", outcome: "green" });
    h = recordRun(h, { claimId: "flaky-pin", at: "2026-06-05T10:00:02Z", outcome: "red" });
    h = recordRun(h, { claimId: "flaky-pin", at: "2026-06-05T10:00:03Z", outcome: "green" });
    const fp = flakyPins(h);
    expect(fp.map((p) => p.claimId)).toEqual(["flaky-pin"]);
  });
});
