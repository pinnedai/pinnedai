// Badge endpoint tests — focused on the PINS.md parser (counting
// active rows) since the rest of the handler is just fetch + SVG.

import { describe, it, expect } from "vitest";

// Re-export the internal parser for tests. We have to inline-import
// the regex matchers since badge.ts doesn't export them. Test via
// the public handleBadge with a mocked fetch.
import { handleBadge } from "./badge.js";

function mockFetch(body: string, status = 200) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(body, { status })) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

describe("badge — SVG output", () => {
  it("renders 'pinned 3 active' for a PINS.md with 3 active rows", async () => {
    const pins = `# Pinned Claims

## Active

| Claim | Test | PR | Pinned by | Pinned |
|---|---|---|---|---|
| rate-limit /api/x | [a.test.ts](a.test.ts) | #1 | @x | 2026-01-01 |
| auth-required /api/y | [b.test.ts](b.test.ts) | #2 | @y | 2026-01-02 |
| idempotent /webhooks/z | [c.test.ts](c.test.ts) | #3 | @z | 2026-01-03 |
`;
    const restore = mockFetch(pins);
    try {
      const res = await handleBadge(
        new Request("https://example/badge/acme/repo.svg")
      );
      const svg = await res.text();
      expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
      expect(svg).toContain("3 active");
    } finally {
      restore();
    }
  });

  it("renders 'pinned —' when PINS.md doesn't exist (404 for all branches)", async () => {
    const restore = mockFetch("not found", 404);
    try {
      const res = await handleBadge(
        new Request("https://example/badge/acme/repo.svg")
      );
      const svg = await res.text();
      expect(svg).toContain("—");
      // Default gray fill (no active pins)
      expect(svg).toContain("#9f9f9f");
    } finally {
      restore();
    }
  });

  it("ignores the table-separator and header rows", async () => {
    // Only counts data rows, not |---| separator or | Claim | ... | header
    const pins = `# Pinned Claims

## Active

| Claim | Test | PR | Pinned by | Pinned |
|---|---|---|---|---|
| rate-limit /api/x | [a.test.ts](a.test.ts) | #1 | @x | 2026-01-01 |
`;
    const restore = mockFetch(pins);
    try {
      const res = await handleBadge(
        new Request("https://example/badge/acme/repo.svg")
      );
      const svg = await res.text();
      expect(svg).toContain("1 active");
    } finally {
      restore();
    }
  });

  it("stops at the next ## heading (doesn't count Retired)", async () => {
    const pins = `## Active

| Claim | Test | PR | Pinned by | Pinned |
|---|---|---|---|---|
| rate-limit /api/x | [a.test.ts](a.test.ts) | #1 | @x | 2026-01-01 |
| rate-limit /api/y | [a.test.ts](a.test.ts) | #1 | @x | 2026-01-01 |

## Retired

| Claim | Test | PR | Retired by | Retired | Reason |
|---|---|---|---|---|---|
| auth-required /api/a | [r.test.ts](r.test.ts) | #5 | @bob | 2026-01-04 | removed |
| auth-required /api/b | [r.test.ts](r.test.ts) | #5 | @bob | 2026-01-04 | removed |
| auth-required /api/c | [r.test.ts](r.test.ts) | #5 | @bob | 2026-01-04 | removed |
`;
    const restore = mockFetch(pins);
    try {
      const res = await handleBadge(
        new Request("https://example/badge/acme/repo.svg")
      );
      const svg = await res.text();
      expect(svg).toContain("2 active");
      expect(svg).not.toContain("5 active");
    } finally {
      restore();
    }
  });
});

describe("badge — JSON variant", () => {
  it(".json suffix returns JSON not SVG", async () => {
    const pins = `## Active

| Claim | Test | PR | Pinned by | Pinned |
|---|---|---|---|---|
| rate-limit /api/x | [a.test.ts](a.test.ts) | #1 | @x | 2026-01-01 |
`;
    const restore = mockFetch(pins);
    try {
      const res = await handleBadge(
        new Request("https://example/badge/acme/repo.json")
      );
      expect(res.headers.get("Content-Type")).toContain("application/json");
      const data = (await res.json()) as { owner: string; repo: string; activePins: number };
      expect(data.owner).toBe("acme");
      expect(data.repo).toBe("repo");
      expect(data.activePins).toBe(1);
    } finally {
      restore();
    }
  });
});

describe("badge — 404 for malformed URLs", () => {
  it("returns 404 for /badge/", async () => {
    const res = await handleBadge(new Request("https://example/badge/"));
    expect(res.status).toBe(404);
  });

  it("returns 404 for /badge/owner-only", async () => {
    const res = await handleBadge(new Request("https://example/badge/owner"));
    expect(res.status).toBe(404);
  });
});
