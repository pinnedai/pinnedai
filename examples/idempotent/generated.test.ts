// Pinned by pinnedai — claim from ex.
// Original PR claim: "Make /webhooks/stripe idempotent on event_id"
// Pinned to fail if this is ever regressed.
//
// Retire when no longer applicable:
//   pinned retire ex-idempotent-webhooks-stripe-24x2rn --reason="..."
//
// EDIT ME: if your endpoint requires extra fields beyond the
// idempotency key, add them to the `payload` object below.

import { describe, it, expect, beforeAll } from "vitest";

const PREVIEW_URL = process.env.PREVIEW_URL;
const ROUTE = "/webhooks/stripe";
const ID_FIELD = "event_id";
const ORIGINAL_PR = "ex";
const ORIGINAL_CLAIM = "Make /webhooks/stripe idempotent on event_id";
const TEST_FILENAME = "ex-idempotent-webhooks-stripe-24x2rn.test.ts";

function repairPrompt(kind: "status" | "body", first: string, second: string): string {
  return [
    "",
    "═══ PINNED FAILURE — paste this into Claude Code / Cursor ═══",
    "",
    "Fix the failing pinned claim in this test file:",
    "  Claim: " + ORIGINAL_CLAIM,
    "  Original PR: " + ORIGINAL_PR,
    "  Route: " + ROUTE + " (POST)",
    "  Idempotency key: " + ID_FIELD,
    "  Expected: two POSTs with the same " + ID_FIELD + " return byte-identical response",
    "  Actual: differing " + kind + " — first=" + first + " second=" + second,
    "",
    "Restore idempotency on " + ROUTE + ". The handler should detect duplicate",
    ID_FIELD + " values and return the cached response (or 409). Likely candidates:",
    "  - The route handler for " + ROUTE,
    "  - A request-deduplication middleware",
    "  - Database upsert vs insert logic",
    "Preserve all other behavior. Do not modify this pinned test file.",
    "",
    "After fixing, re-run:  npx vitest run tests/pinned/" + TEST_FILENAME,
    "═══════════════════════════════════════════════════════════════",
    "",
  ].join("\n");
}

describe("pinned: idempotent on " + ROUTE + " (key: " + ID_FIELD + ")", () => {
  beforeAll(() => {
    if (!PREVIEW_URL) {
      throw new Error(
        "PREVIEW_URL env var required for pinned idempotent tests. " +
          "See https://pinnedai.dev/docs/preview-url"
      );
    }
  });

  it("returns byte-identical response when called twice with the same " + ID_FIELD, async () => {
    const url = PREVIEW_URL!.replace(/\/$/, "") + ROUTE;
    const payload: Record<string, unknown> = {
      [ID_FIELD]: "pinned-idem-" + Math.random().toString(36).slice(2, 12),
      // EDIT ME: add any other required fields here.
    };

    const fire = () =>
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

    const first = await fire();
    const firstBody = await first.text();
    const second = await fire();
    const secondBody = await second.text();

    // 409 / 410 / 422 with a different body is ALSO valid idempotency
    // — the handler explicitly rejected the duplicate. Accept it as
    // passing without byte-comparison. We accept any 2xx as the "first"
    // status since many create-style endpoints return 201 or 202 first
    // and 409 on the duplicate.
    const DUPLICATE_STATUSES = [409, 410, 422];
    if (
      DUPLICATE_STATUSES.includes(second.status) &&
      first.status >= 200 &&
      first.status < 300
    ) {
      return;
    }

    if (second.status !== first.status) {
      throw new Error(repairPrompt("status", String(first.status), String(second.status)));
    }
    if (secondBody !== firstBody) {
      throw new Error(repairPrompt("body", firstBody.slice(0, 80), secondBody.slice(0, 80)));
    }
    expect(second.status).toBe(first.status);
    expect(secondBody).toBe(firstBody);
  });
});
