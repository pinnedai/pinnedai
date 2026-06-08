// Cipherwake CLI hardening (0.5.0-beta.7) — clear warning when the
// hosted endpoint is unreachable, instead of silent regex fallback.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { warnDeadEndpoint } from "./llmExtract.js";

let originalStderrWrite: typeof process.stderr.write;
let captured: string;

beforeEach(() => {
  captured = "";
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as any).write = (chunk: any) => {
    captured += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
});

afterEach(() => {
  (process.stderr as any).write = originalStderrWrite;
});

describe("warnDeadEndpoint", () => {
  it("emits the actionable BYOK + self-host hints to stderr", () => {
    warnDeadEndpoint("https://api.example.invalid", "test-fixture-1");
    expect(captured).toMatch(/hosted endpoint .* is unreachable/i);
    expect(captured).toMatch(/PINNEDAI_BYOK=anthropic/);
    expect(captured).toMatch(/PINNEDAI_BYOK=openai/);
    expect(captured).toMatch(/PINNEDAI_ENDPOINT=https:\/\//);
    expect(captured).toMatch(/PINNEDAI_SUPPRESS_ENDPOINT_WARN/);
  });

  it("throttles to once per (source, endpoint) per process — no spam", () => {
    captured = "";
    warnDeadEndpoint("https://api.example.invalid", "test-fixture-2");
    const firstLen = captured.length;
    expect(firstLen).toBeGreaterThan(0);
    captured = "";
    warnDeadEndpoint("https://api.example.invalid", "test-fixture-2");
    // Second call same (endpoint, source) → no emit.
    expect(captured.length).toBe(0);
  });

  it("emits separately per source, even for the same endpoint", () => {
    captured = "";
    warnDeadEndpoint("https://api.example.invalid", "src-A");
    const after1 = captured.length;
    expect(after1).toBeGreaterThan(0);
    warnDeadEndpoint("https://api.example.invalid", "src-B");
    expect(captured.length).toBeGreaterThan(after1);
  });

  it("respects PINNEDAI_SUPPRESS_ENDPOINT_WARN=1", () => {
    process.env.PINNEDAI_SUPPRESS_ENDPOINT_WARN = "1";
    try {
      captured = "";
      warnDeadEndpoint("https://api.example.invalid", "suppressed-source");
      expect(captured).toBe("");
    } finally {
      delete process.env.PINNEDAI_SUPPRESS_ENDPOINT_WARN;
    }
  });
});
