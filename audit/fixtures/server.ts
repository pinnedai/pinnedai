// In-process HTTP server for web-template audits.
//
// One server class, three behavior modes (rate-limit / auth-required /
// idempotent). The audit picks the mode that matches the template
// under test. Each mode has a "healthy" and "broken" variant so the
// negative control can fire.

import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";

export type FixtureMode =
  // Rate-limit fixtures
  | { kind: "rate-limit-healthy"; route: string; rate: number; windowMs: number }
  | { kind: "rate-limit-broken"; route: string }
  // Rate-limit too-tight: returns 429 after `tightRate` requests
  // (a value lower than the documented RATE). Catches direction-2
  // "limit lowered" regression. The at-cap test fires RATE requests
  // sequentially and expects ≥90% to succeed — with tightRate < 90%
  // of RATE, the test fails.
  | { kind: "rate-limit-too-tight"; route: string; tightRate: number; windowMs: number }
  // Auth-required fixtures
  | { kind: "auth-healthy"; route: string }
  | { kind: "auth-broken"; route: string }
  // Auth-required over-tightened: returns 401 for unauth (so direction-1
  // PASSES) but returns 403 for authenticated requests (so direction-2
  // FAILS — the with-auth catch fires). Catches: "AI made auth too
  // strict, legit users blocked."
  | { kind: "auth-over-tightened"; route: string; authToken: string }
  // Idempotent fixtures
  | { kind: "idempotent-healthy"; route: string; idField: string }
  | { kind: "idempotent-broken"; route: string }
  // Returns-status fixtures: a route that should return `expectedStatus`
  // on bad input (e.g., 400 on missing email). Healthy = returns the
  // expected status; broken = always returns 200 regardless.
  | { kind: "returns-status-healthy"; route: string; method: string; expectedStatus: number }
  | { kind: "returns-status-broken"; route: string }
  // Permission-required fixtures: 3-direction tested. Healthy = full
  // RBAC (401 for no-auth, 403 for wrong-role, 200 for right-role).
  // Broken = always 200 regardless of headers (role check stripped).
  | { kind: "permission-required-healthy"; route: string; rightRoleToken: string; wrongRoleToken: string }
  | { kind: "permission-required-broken"; route: string }
  // Permission-required wrong-role-accepted: 401 for unauth (direction-1
  // healthy), 200 for wrong-role token (direction-2 catches: role
  // check stripped while auth retained — the most insidious AI regression
  // in this class). Right-role also 200.
  | { kind: "permission-required-wrong-role-accepted"; route: string; rightRoleToken: string; wrongRoleToken: string }
  // Permission-required right-role-rejected: 401 for unauth (direction-1
  // healthy), 403 for wrong-role (direction-2 healthy), 403 for
  // right-role token (direction-3 catches: route over-tightened, legit
  // admins blocked).
  | { kind: "permission-required-right-role-rejected"; route: string; rightRoleToken: string }
  // Tier-cap fixtures: simulates a billing-tier-aware endpoint.
  // Healthy = under-cap token returns 2xx, at-cap token returns 4xx,
  // paid token returns 2xx. Broken = all return 200 regardless.
  | { kind: "tier-cap-healthy"; route: string; underCapToken: string; atCapToken: string; paidToken: string }
  | { kind: "tier-cap-broken"; route: string }
  // Tier-cap paid-rejected: at-cap correctly 4xx (direction-2 healthy),
  // paid token incorrectly 4xx (direction-3 catches: cap over-applied
  // to paying customers — refund risk).
  | { kind: "tier-cap-paid-rejected"; route: string; underCapToken: string; atCapToken: string; paidToken: string };

export type FixtureServer = {
  url: string;
  port: number;
  stop: () => Promise<void>;
};

export async function startFixtureServer(
  mode: FixtureMode
): Promise<FixtureServer> {
  const calls = new Map<string, number>(); // for rate-limit
  const idempotencyCache = new Map<string, string>(); // for idempotent
  let auditId = 0; // for idempotent-broken (changes each call)

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost`);
    const path = url.pathname;

    switch (mode.kind) {
      case "rate-limit-healthy": {
        if (path === mode.route) {
          const now = Date.now();
          const windowStart = Math.floor(now / mode.windowMs) * mode.windowMs;
          const key = `${mode.route}:${windowStart}`;
          const count = (calls.get(key) ?? 0) + 1;
          calls.set(key, count);
          if (count > mode.rate) {
            res.statusCode = 429;
            res.end("rate limited");
            return;
          }
          res.statusCode = 200;
          res.end("ok");
          return;
        }
        break;
      }

      case "rate-limit-broken": {
        if (path === mode.route) {
          res.statusCode = 200;
          res.end("ok");
          return;
        }
        break;
      }

      case "rate-limit-too-tight": {
        // Returns 429 after `tightRate` requests in the current window.
        // Simulates "limit lowered below the documented RATE."
        if (path === mode.route) {
          const now = Date.now();
          const windowStart = Math.floor(now / mode.windowMs) * mode.windowMs;
          const key = `${mode.route}:${windowStart}`;
          const count = (calls.get(key) ?? 0) + 1;
          calls.set(key, count);
          if (count > mode.tightRate) {
            res.statusCode = 429;
            res.end("rate limited (too tight)");
            return;
          }
          res.statusCode = 200;
          res.end("ok");
          return;
        }
        break;
      }

      case "auth-healthy": {
        if (path === mode.route) {
          if (!req.headers.authorization) {
            res.statusCode = 401;
            res.end("unauthorized");
            return;
          }
          res.statusCode = 200;
          res.end("ok");
          return;
        }
        break;
      }

      case "auth-broken": {
        if (path === mode.route) {
          // Always 200 — auth check is "missing"
          res.statusCode = 200;
          res.end("ok");
          return;
        }
        break;
      }

      case "idempotent-healthy": {
        if (path === mode.route && req.method === "POST") {
          let body = "";
          req.on("data", (c) => (body += c));
          req.on("end", () => {
            try {
              const parsed = JSON.parse(body) as Record<string, unknown>;
              const idValue = parsed[mode.idField];
              if (typeof idValue !== "string") {
                res.statusCode = 400;
                res.end("missing idField");
                return;
              }
              if (idempotencyCache.has(idValue)) {
                // Return the cached response byte-for-byte
                res.statusCode = 200;
                res.setHeader("Content-Type", "application/json");
                res.end(idempotencyCache.get(idValue));
                return;
              }
              const response = JSON.stringify({ id: idValue, status: "created" });
              idempotencyCache.set(idValue, response);
              res.statusCode = 200;
              res.setHeader("Content-Type", "application/json");
              res.end(response);
            } catch {
              res.statusCode = 400;
              res.end("invalid json");
            }
          });
          return;
        }
        break;
      }

      case "idempotent-broken": {
        if (path === mode.route && req.method === "POST") {
          req.on("data", () => {});
          req.on("end", () => {
            // Always returns a UNIQUE response — not idempotent.
            auditId += 1;
            const random = randomBytes(8).toString("hex");
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({ id: `evt_${random}`, status: "created", auditId })
            );
          });
          return;
        }
        break;
      }

      case "returns-status-healthy": {
        if (path === mode.route && req.method === mode.method.toUpperCase()) {
          // Healthy: any incoming request matches the validation
          // failure case (the test sends an empty body) → return the
          // expected status. The template's test sends a minimal
          // counter-example so we'll always see a 4xx-worthy request.
          res.statusCode = mode.expectedStatus;
          res.end("validation failed");
          return;
        }
        break;
      }

      case "returns-status-broken": {
        if (path === mode.route) {
          // Broken: always returns 200 regardless of input. Catches
          // the "validation removed" regression class.
          res.statusCode = 200;
          res.end("ok");
          return;
        }
        break;
      }

      case "permission-required-healthy": {
        if (path === mode.route) {
          const auth = req.headers.authorization;
          if (!auth) {
            res.statusCode = 401;
            res.end("unauthorized");
            return;
          }
          // Strip "Bearer " prefix
          const token = auth.replace(/^Bearer\s+/i, "").trim();
          if (token === mode.rightRoleToken) {
            res.statusCode = 200;
            res.end("ok");
            return;
          }
          // Any other token (including wrong-role) → 403
          res.statusCode = 403;
          res.end("forbidden");
          return;
        }
        break;
      }

      case "permission-required-broken": {
        if (path === mode.route) {
          // Broken: always 200 regardless of headers. Catches the
          // "role check stripped" regression — direction 1 (no-auth)
          // fires because no-auth returns 200 instead of 401.
          res.statusCode = 200;
          res.end("ok");
          return;
        }
        break;
      }

      case "tier-cap-healthy": {
        if (path === mode.route) {
          const auth = req.headers.authorization;
          if (!auth) {
            res.statusCode = 401;
            res.end("unauthorized");
            return;
          }
          const token = auth.replace(/^Bearer\s+/i, "").trim();
          if (token === mode.atCapToken) {
            // At-cap user → reject (revenue-leak protection direction)
            res.statusCode = 402;
            res.end("tier cap exceeded");
            return;
          }
          // Under-cap, paid, or any other token → allow
          res.statusCode = 200;
          res.end("ok");
          return;
        }
        break;
      }

      case "tier-cap-broken": {
        if (path === mode.route) {
          // Broken: always 200 regardless of which token / which
          // tier state. Catches the cap-stripped regression — the
          // at-cap direction fires (got 200 instead of 4xx).
          res.statusCode = 200;
          res.end("ok");
          return;
        }
        break;
      }

      case "auth-over-tightened": {
        if (path === mode.route) {
          if (!req.headers.authorization) {
            // Direction-1 (no-auth) still healthy → 401.
            res.statusCode = 401;
            res.end("unauthorized");
            return;
          }
          // Direction-2 (authed) broken → 403 (over-restricted).
          res.statusCode = 403;
          res.end("forbidden");
          return;
        }
        break;
      }

      case "permission-required-wrong-role-accepted": {
        if (path === mode.route) {
          if (!req.headers.authorization) {
            // Direction-1 (no-auth) healthy → 401.
            res.statusCode = 401;
            res.end("unauthorized");
            return;
          }
          // Direction-2 (wrong-role) broken → 200 (should be 403).
          // Direction-3 (right-role) also 200 — coincidentally correct.
          res.statusCode = 200;
          res.end("ok");
          return;
        }
        break;
      }

      case "permission-required-right-role-rejected": {
        if (path === mode.route) {
          const auth = req.headers.authorization;
          if (!auth) {
            res.statusCode = 401;
            res.end("unauthorized");
            return;
          }
          const token = auth.replace(/^Bearer\s+/i, "").trim();
          if (token === mode.rightRoleToken) {
            // Direction-3 broken → over-tightened, blocks legit admin.
            res.statusCode = 403;
            res.end("forbidden");
            return;
          }
          // Direction-2 healthy → wrong-role 403.
          res.statusCode = 403;
          res.end("forbidden");
          return;
        }
        break;
      }

      case "tier-cap-paid-rejected": {
        if (path === mode.route) {
          const auth = req.headers.authorization;
          if (!auth) {
            res.statusCode = 401;
            res.end("unauthorized");
            return;
          }
          const token = auth.replace(/^Bearer\s+/i, "").trim();
          if (token === mode.paidToken) {
            // Direction-3 broken → paid customer blocked (refund risk).
            res.statusCode = 402;
            res.end("tier cap exceeded (incorrectly applied to paid)");
            return;
          }
          if (token === mode.atCapToken) {
            // Direction-2 healthy → at-cap user correctly rejected.
            res.statusCode = 402;
            res.end("tier cap exceeded");
            return;
          }
          // Under-cap correctly allowed.
          res.statusCode = 200;
          res.end("ok");
          return;
        }
        break;
      }
    }

    res.statusCode = 404;
    res.end("not found");
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("failed to bind fixture server"));
        return;
      }
      const port = addr.port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        stop: () =>
          new Promise<void>((res2) => {
            server.close(() => res2());
          }),
      });
    });
  });
}
