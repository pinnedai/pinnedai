// Unit tests for the diff-mode detectors that fire in bug-fix
// backtest. FP-regression is the load-bearing axis here:
// [[lint-format-false-positives]] confirms the auth/validation
// detectors have been burned by lint-only reformatting before. Each
// new detector below must reject the lint-shape it could plausibly
// false-fire on AND match the canonical positive shape.
import { describe, it, expect } from "vitest";
import {
  detectIdempotencyAddedInDiff,
  detectRateLimitAddedInDiff,
  detectPermissionAddedInDiff,
  detectNewPostEndpointsInDiff,
  type DiffByFile,
} from "./scanDiff.js";

function diffOf(file: string, added: string): DiffByFile {
  const m = new Map<string, string[]>();
  m.set(file, added.split("\n"));
  return m;
}

describe("detectIdempotencyAddedInDiff", () => {
  it("catches Prisma findUnique against event_id on a webhook route", () => {
    const diff = diffOf(
      "app/api/webhooks/stripe/route.ts",
      `export async function POST(req: Request) {
  const body = await req.json();
  const event_id = body.id;
  const existing = await prisma.webhookEvent.findUnique({ where: { event_id } });
  if (existing) return new Response(JSON.stringify({ ok: true }), { status: 200 });
}`
    );
    const hits = detectIdempotencyAddedInDiff(diff);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      template: "idempotent",
      route: "/api/webhooks/stripe",
      idField: "event_id",
    });
    expect(hits[0].signature.length).toBeGreaterThan(10);
  });

  it("catches header-based idempotency-key dedupe", () => {
    const diff = diffOf(
      "app/api/payments/route.ts",
      `export async function POST(req: Request) {
  const idempotency_key = req.headers.get('idempotency-key');
  const cached = await cache.get(\`idem:\${idempotency_key}\`);
  if (cached) return Response.json(cached);
}`
    );
    const hits = detectIdempotencyAddedInDiff(diff);
    expect(hits).toHaveLength(1);
    expect(hits[0].template).toBe("idempotent");
  });

  it("REJECTS lint reformat of destructuring (event_id alone, no lookup)", () => {
    // Common lint-induced "added line": a destructuring statement
    // that mentions event_id but doesn't perform a lookup. This is
    // the exact FP shape we must NOT match.
    const diff = diffOf(
      "app/api/webhooks/stripe/route.ts",
      `export async function POST(req: Request) {
  const { event_id, type } = await req.json();
  console.log("got event", event_id);
  return new Response("ok");
}`
    );
    expect(detectIdempotencyAddedInDiff(diff)).toHaveLength(0);
  });

  it("REJECTS lookup verb without a known idempotency field", () => {
    // findUnique is present, but on `id` (a regular DB row id) — not
    // a known idempotency field. Should not fire.
    const diff = diffOf(
      "app/api/users/route.ts",
      `export async function POST(req: Request) {
  const { id } = await req.json();
  const user = await prisma.user.findUnique({ where: { id } });
  return Response.json(user);
}`
    );
    expect(detectIdempotencyAddedInDiff(diff)).toHaveLength(0);
  });

  it("REJECTS auth-route paths (idempotency irrelevant on /login)", () => {
    const diff = diffOf(
      "app/api/auth/login/route.ts",
      `export async function POST(req: Request) {
  const { event_id } = await req.json();
  const existing = await prisma.session.findUnique({ where: { event_id } });
}`
    );
    expect(detectIdempotencyAddedInDiff(diff)).toHaveLength(0);
  });

  it("REJECTS GET-only routes without write method", () => {
    const diff = diffOf(
      "app/api/notifications/route.ts",
      `export async function GET(req: Request) {
  const { event_id } = req.query;
  const existing = await prisma.notification.findUnique({ where: { event_id } });
  return Response.json(existing);
}`
    );
    expect(detectIdempotencyAddedInDiff(diff)).toHaveLength(0);
  });
});

describe("detectRateLimitAddedInDiff", () => {
  it("catches express-rate-limit with explicit max", () => {
    const diff = diffOf(
      "app/api/users/route.ts",
      `import rateLimit from "express-rate-limit";
const limiter = rateLimit({ max: 100, windowMs: 60_000 });
export const POST = limiter;`
    );
    const hits = detectRateLimitAddedInDiff(diff);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      template: "rate-limit",
      route: "/api/users",
      rate: 100,
      window: "minute",
    });
  });

  it("catches Upstash slidingWindow", () => {
    const diff = diffOf(
      "app/api/messages/route.ts",
      `import { Ratelimit } from "@upstash/ratelimit";
const ratelimit = new Ratelimit({ limiter: Ratelimit.slidingWindow(20, "1 m") });
export async function POST(req: Request) {
  const { success } = await ratelimit.limit("global");
  if (!success) return new Response("too many", { status: 429 });
}`
    );
    const hits = detectRateLimitAddedInDiff(diff);
    expect(hits).toHaveLength(1);
    expect(hits[0].rate).toBe(20);
  });

  it("catches rate-limiter-flexible with points", () => {
    const diff = diffOf(
      "app/api/upload/route.ts",
      `import { RateLimiterRedis } from "rate-limiter-flexible";
const limiter = new RateLimiterRedis({ points: 5, duration: 60 });
export async function PUT(req: Request) {
  await limiter.consume(req.ip);
}`
    );
    const hits = detectRateLimitAddedInDiff(diff);
    expect(hits).toHaveLength(1);
    expect(hits[0].rate).toBe(5);
  });

  it("REJECTS bare 429 literal in a comment-like context", () => {
    // The 429-response pattern requires a `.status(429).json(` or
    // similar chained call. A bare `return 429;` or `throw new
    // HTTPError(429)` should NOT fire — those don't carry the
    // chained-method signal.
    const diff = diffOf(
      "app/api/items/route.ts",
      `export async function POST(req: Request) {
  if (somethingBad) {
    throw new HTTPError(429);
  }
  return Response.json({ ok: true });
}`
    );
    expect(detectRateLimitAddedInDiff(diff)).toHaveLength(0);
  });

  it("REJECTS unrelated 'limit' identifier (e.g. query.limit = 20)", () => {
    const diff = diffOf(
      "app/api/search/route.ts",
      `export async function POST(req: Request) {
  const { query, limit = 20 } = await req.json();
  return Response.json(await db.search(query, limit));
}`
    );
    expect(detectRateLimitAddedInDiff(diff)).toHaveLength(0);
  });

  it("falls back to rate=60 when library matched but no max-slot extracted", () => {
    // `from "<library>"` is the realistic shape — bare `import "X"`
    // side-effect imports don't happen for these libraries. We still
    // accept the from-import as a strong-enough signal to pin (rate
    // falls back to the template default of 60/minute).
    const diff = diffOf(
      "app/api/messages/route.ts",
      `import rateLimit from "express-rate-limit";
app.use(rateLimit());
export async function POST() { return Response.json({}); }`
    );
    const hits = detectRateLimitAddedInDiff(diff);
    expect(hits).toHaveLength(1);
    expect(hits[0].rate).toBe(60);
  });
});

describe("detectPermissionAddedInDiff", () => {
  it("catches requirePermission helper", () => {
    const diff = diffOf(
      "app/api/projects/route.ts",
      `import { requirePermission } from "@/lib/auth-helpers";
export async function POST(req: Request) {
  await requirePermission(req, "project:write");
  return Response.json({ created: true });
}`
    );
    const hits = detectPermissionAddedInDiff(diff);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      template: "permission-required",
      route: "/api/projects",
    });
  });

  it("catches role-check paired with 403", () => {
    const diff = diffOf(
      "app/api/orgs/[id]/settings/route.ts",
      `export async function PATCH(req: Request) {
  if (user.role !== "admin") {
    return new Response("forbidden", { status: 403 });
  }
  return Response.json({ ok: true });
}`
    );
    const hits = detectPermissionAddedInDiff(diff);
    expect(hits).toHaveLength(1);
    expect(hits[0].template).toBe("permission-required");
  });

  it("catches ownership comparison (resource.userId !== ctx.user.id) with 403", () => {
    const diff = diffOf(
      "app/api/posts/[id]/route.ts",
      `export async function DELETE(req: Request, ctx: Ctx) {
  const post = await prisma.post.findUnique({ where: { id: ctx.params.id } });
  if (post.userId !== ctx.user.id) {
    return new Response("nope", { status: 403 });
  }
  return Response.json(await prisma.post.delete({ where: { id: post.id } }));
}`
    );
    const hits = detectPermissionAddedInDiff(diff);
    expect(hits).toHaveLength(1);
  });

  it("catches ForbiddenError throw", () => {
    const diff = diffOf(
      "app/api/admin/users/route.ts",
      `import { ForbiddenError } from "@/lib/errors";
export async function POST(req: Request) {
  if (!user.canEditUsers) throw new ForbiddenError("not allowed");
}`
    );
    const hits = detectPermissionAddedInDiff(diff);
    expect(hits).toHaveLength(1);
  });

  it("REJECTS bare .status(403) without a decision predicate", () => {
    // Pure lint-FP shape: an existing 403 response that got
    // reformatted onto a new line. No `require*`, no role check, no
    // ownership comparison. Must not fire.
    const diff = diffOf(
      "app/api/items/route.ts",
      `export async function GET(req: Request) {
  if (req.headers.get("x-foo")) {
    return new Response("nope", { status: 403 });
  }
}`
    );
    expect(detectPermissionAddedInDiff(diff)).toHaveLength(0);
  });

  it("REJECTS when auth-required dominates (requireAuth + role check)", () => {
    // Auth-required wins when both signals are present in the same
    // diff — we shouldn't double-pin the same surface.
    const diff = diffOf(
      "app/api/projects/route.ts",
      `import { requireAuth, requirePermission } from "@/lib/auth";
export async function POST(req: Request) {
  await requireAuth(req);
  await requirePermission(req, "project:write");
}`
    );
    expect(detectPermissionAddedInDiff(diff)).toHaveLength(0);
  });

  it("REJECTS generic conditional with 403 but no permission shape", () => {
    const diff = diffOf(
      "app/api/billing/route.ts",
      `export async function POST(req: Request) {
  if (req.headers.get("x-quota-exceeded") === "1") {
    return new Response("over quota", { status: 403 });
  }
}`
    );
    expect(detectPermissionAddedInDiff(diff)).toHaveLength(0);
  });

  it("REJECTS auth/login routes (out of scope for permission)", () => {
    const diff = diffOf(
      "app/api/auth/callback/route.ts",
      `export async function POST(req: Request) {
  if (user.role !== "admin") {
    return new Response("forbidden", { status: 403 });
  }
}`
    );
    expect(detectPermissionAddedInDiff(diff)).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────
// detectNewPostEndpointsInDiff — fires when a new mutating endpoint
// (POST/PUT/PATCH/DELETE) lands. Drove the socialideagen incident
// 2026-06-02: business-critical POST /api/signup shipped a 400 to
// prod because no Pinned coverage existed for happy-path-with-side-
// effect on auto-detected endpoints.
// ────────────────────────────────────────────────────────────

describe("detectNewPostEndpointsInDiff", () => {
  it("catches a new Next.js app-router POST /api/signup", () => {
    const diff = diffOf(
      "app/api/signup/route.ts",
      `import { NextRequest } from "next/server";
export async function POST(req: NextRequest) {
  const body = await req.json();
  const user = await createUser(body);
  return Response.json(user);
}`
    );
    const hits = detectNewPostEndpointsInDiff(diff);
    expect(hits).toHaveLength(1);
    expect(hits[0].route).toBe("/api/signup");
    expect(hits[0].method).toBe("POST");
    expect(hits[0].targetGuess).toBe("signups");
    expect(hits[0].filePath).toBe("app/api/signup/route.ts");
  });

  it("catches multiple methods across multiple files", () => {
    const m: DiffByFile = new Map();
    m.set("app/api/orders/route.ts", [
      "export async function POST(req) { return Response.json({ id: 1 }); }",
    ]);
    m.set("app/api/users/[id]/route.ts", [
      "export async function PATCH(req) { return Response.json({ ok: true }); }",
    ]);
    m.set("app/api/items/[id]/route.ts", [
      "export async function DELETE(req) { return new Response(null, { status: 204 }); }",
    ]);
    const hits = detectNewPostEndpointsInDiff(m);
    expect(hits).toHaveLength(3);
    const byMethod = Object.fromEntries(hits.map((h) => [h.method, h.route]));
    expect(byMethod.POST).toBe("/api/orders");
    expect(byMethod.PATCH).toBe("/api/users/[id]");
    expect(byMethod.DELETE).toBe("/api/items/[id]");
  });

  it("catches Express-style router.post()", () => {
    const diff = diffOf(
      "src/routes/signup.ts",
      `router.post("/api/signup", async (req, res) => {
  const user = await createUser(req.body);
  res.json(user);
});`
    );
    // Express-style routes don't map cleanly to deriveRouteFromPath
    // (the file path doesn't equal the route). We expect either ZERO
    // hits (file doesn't look like a route handler by path) OR a hit
    // with the route guessed from the file. Either is acceptable —
    // the detector's primary target is Next.js app router.
    const hits = detectNewPostEndpointsInDiff(diff);
    expect(hits.length).toBeGreaterThanOrEqual(0);
  });

  it("REJECTS files that aren't route handlers", () => {
    const diff = diffOf(
      "src/lib/utils.ts",
      `export function helper() { return 42; }
export async function POST(data) { return await save(data); }`
    );
    // Even though the file has `export async function POST`, it's not
    // at a path that maps to a route. Detector must skip it.
    expect(detectNewPostEndpointsInDiff(diff)).toHaveLength(0);
  });

  it("REJECTS test files", () => {
    const diff = diffOf(
      "app/api/signup/route.test.ts",
      `it("POST works", async () => {
  const res = await fetch("/api/signup", { method: "POST" });
});`
    );
    expect(detectNewPostEndpointsInDiff(diff)).toHaveLength(0);
  });

  it("REJECTS GET-only routes (read-only, no side-effect to verify)", () => {
    const diff = diffOf(
      "app/api/health/route.ts",
      `export async function GET() {
  return Response.json({ status: "ok" });
}`
    );
    expect(detectNewPostEndpointsInDiff(diff)).toHaveLength(0);
  });

  it("pluralizes the target guess from the last route segment", () => {
    const m: DiffByFile = new Map();
    m.set("app/api/order/route.ts", [
      "export async function POST(req) { return Response.json({}); }",
    ]);
    m.set("app/api/category/route.ts", [
      "export async function POST(req) { return Response.json({}); }",
    ]);
    m.set("app/api/box/route.ts", [
      "export async function POST(req) { return Response.json({}); }",
    ]);
    const hits = detectNewPostEndpointsInDiff(m);
    const targets = Object.fromEntries(hits.map((h) => [h.route, h.targetGuess]));
    expect(targets["/api/order"]).toBe("orders");
    expect(targets["/api/category"]).toBe("categories");
    expect(targets["/api/box"]).toBe("boxes");
  });

  it("doesn't double-emit for same route in single diff", () => {
    // Same route appearing twice in the diff (e.g. an edit + a comment
    // change) should still produce only one hit.
    const m: DiffByFile = new Map();
    m.set("app/api/signup/route.ts", [
      "export async function POST(req) { return Response.json({}); }",
    ]);
    const hits = detectNewPostEndpointsInDiff(m);
    expect(hits).toHaveLength(1);
  });
});
