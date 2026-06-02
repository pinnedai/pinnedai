# v0.2 — Three Workhorse Templates: spec

Status: **DRAFT** — open questions inline, flagged `[Q]`. Not implementation-ready until the user closes the questions.

Source of priority: Claude session feedback on 2026-06-02 — *"Until you cover ~8-10 common contract shapes, the conversation with a paying customer is 'I love this, but my codebase has 40 contracts and you can pin 4.' That's a hard sell."* The three below were chosen as the highest-leverage of the missing 8-10:

1. **`happy-path-with-side-effect`** — *"POST /api/X with valid body returns 200 AND writes a row to table Y"*
2. **`page-renders`** — *"GET /path renders an HTML response without React-error markers"*
3. **`validation-rejects-bad`** — *"POST /api/X with each of {missing required field, bad type, oversized payload} returns 4xx"*

Each section below covers: claim phrasings, test mechanism, required fixtures, false-positive risks, FP-check plan, estimated effort.

---

## 1. `happy-path-with-side-effect`

The single most-requested missing template. Asserts that an endpoint not only returns a successful status, but that **a verifiable downstream side-effect actually happened**. Without this, a stub endpoint that returns `{ok: true}` without doing anything passes a `returns-status` 200 pin — *misleading-green*, the worst-case Pinned failure mode.

### Claim phrasings (parser regex targets)

- `POST /api/X with valid body returns 200 + writes row to Y`
- `POST /api/X creates a Y record` (route + action + table)
- `POST /api/X enqueues a Y job`
- `POST /api/X sends email via Z`
- `POST /api/X stores file in S3 bucket K`

Each maps to a side-effect kind: **db-write**, **queue-enqueue**, **email-send**, **storage-write**. `[Q1]` Should we ship all four kinds in v0.2, or just **db-write** (most common) and defer the rest?

### Test mechanism

`[Q2]` This is the big design question. Three options, each with trade-offs:

**Option A — Polling assertion (no infra cost).**
After the POST, query a status endpoint (`GET /api/X/{id}/status` or similar) until either:
- It returns the side-effect's verifiable state (e.g. `record exists`, `email queued`, `file uploaded`), OR
- A timeout fires (default 10s).

Pin passes if the polling endpoint confirms the side-effect within the window. Pin fails if the timeout hits without confirmation.

Pros: no DB connection needed, runs against PREVIEW_URL like other Pinned tests.
Cons: requires the customer to expose a side-effect-verification endpoint. Many apps don't have one for every action. Polling latency.

**Option B — Direct DB / queue query (high signal, infra-coupled).**
After the POST, the test connects directly to the customer's DB (via `DATABASE_URL` env) and queries for the inserted row. Or connects to their queue / S3 / email provider via similar BYOK envs.

Pros: deterministic side-effect verification, no polling endpoint required.
Cons: needs every customer to expose `DATABASE_URL` to the test environment, which most don't and shouldn't (security). Wires up dozens of provider SDKs (pg, mysql2, sqlite, mongo, redis, bullmq, sqs, ses, sendgrid, postmark, s3, gcs, ...).

**Option C — Side-effect intent header (X-Pinned-Verify) — new convention.**
The customer's API echoes verification metadata in the response when `X-Pinned-Test: 1` is set. e.g. POST /api/signup with X-Pinned-Test responds:
```
HTTP 200
X-Pinned-Side-Effect: db-write
X-Pinned-Side-Effect-Target: users
X-Pinned-Side-Effect-Id: tx-abc123
```
Pin passes if `X-Pinned-Side-Effect` header is present + matches the captured side-effect kind. Pin fails if absent (= stub returning 200 without doing the work).

Pros: no DB connection, no polling endpoint, no per-provider integrations. One header convention covers every side-effect kind.
Cons: requires customer to instrument their endpoints (add one wrapper). Pinned-specific convention — adoption friction.

**Recommendation:** Option C is structurally best but has adoption tax. Option A (polling) is the right v0.2 ship; document Option C as the v0.3 upgrade path for customers who want truly-no-stub guarantees.

`[Q3]` Approve Option A as the v0.2 implementation, OR pick a different option?

### Required fixtures / env

If Option A:
- `PREVIEW_URL` (already required for all live-mode pins)
- `PINNED_TEST_TOKEN_<route>` — token to authenticate the POST + the polling endpoint
- Polling endpoint convention: the test assumes `GET <PREVIEW_URL>/__pinned/verify/<side-effect-id>` returns a structured response. `[Q4]` Or should the polling endpoint be configurable per pin (claim-level field)?

### False-positive risks + mitigation

- **Side-effect ID collision** — two tests running in parallel could query each other's IDs. Mitigation: prefix every side-effect ID with the test's unique pin claim-id.
- **Slow side-effect propagation** — async queue jobs may take >10s. Mitigation: configurable timeout per pin (claim-level field).
- **Polling endpoint itself broken** — pin would fail even if the actual side-effect happened. Mitigation: pin has an explicit `requiredFixtures: ["polling-endpoint"]` that surfaces a CLEAR pre-test "your polling endpoint is unreachable" message instead of silently false-failing.

### FP-check plan

Real codebases to test against (per the new FP-check-everything rule):
- **quantasyte** — has POST /api/signup that writes to a DB
- **back-in-play** — has POST endpoints with DB writes
- **socialideagen** (user's new project) — fresh Next.js, simplest target

Pre-publish: run `pinned generate --description "POST /api/signup with valid email creates a users row."` on each, inspect emitted test for: correct route, correct method, correct side-effect kind, no false-failures when polling endpoint is unimplemented.

### Estimated effort

- Parser + Claim type + regex patterns: 4-6 hrs
- Template generator: 6-8 hrs
- Polling-endpoint client + timeout logic: 4 hrs
- Test fixtures (one per side-effect kind for the test suite): 4 hrs
- FP-check on 3 real codebases: 2 hrs
- **Total: ~3 working days** (24 hrs).

---

## 2. `page-renders`

Asserts a server-rendered HTML page returns 200 + the body contains no React-error / Next.js-error / Vite-error markers + the body is non-trivial in size. The simplest "this page didn't explode" smoke check.

### Claim phrasings

- `GET /path renders without crashing`
- `Page /path renders`
- `/path returns a working page`

### Test mechanism

GET the path with `Accept: text/html`. Pass if:
- Status is 200 OR 304
- Body length > N bytes (`[Q5]` minimum: 200? 500? per-pin override?)
- Body does NOT contain any of: `Application error: a client-side exception`, `Internal Server Error` (Next.js error pages), `Error: ENOENT`, `Cannot read prop` (React render error patterns), `Uncaught (in promise)`, `__NEXT_ERROR_CODE`
- Body DOES contain `<html` somewhere

Fail otherwise.

### Required fixtures / env

- `PREVIEW_URL`
- `[Q6]` Should we require a valid auth cookie / session for pages that need auth? Or is the page-renders pin only for **public** pages?

### False-positive risks

- **Auth-gated pages** rendered behind a login wall return either 200+login-form OR 302+redirect. If the pin doesn't expect this, false-fail. Mitigation: re-use `authResponseIsValid` from the auth-required template — accept "appears to be a login page" as a valid response, and at pin-generation time detect whether the route is auth-gated (look for `requireAuth` / middleware coverage in the source).
- **Hydration mismatch in dev mode** but not prod — false-positive if pin runs against dev. Mitigation: pin assumes PREVIEW_URL is a production-shaped deploy.
- **CDN-cached error page** that's served as 200 with HTML — false-pass. Mitigation: response body must not contain known error markers (already in mechanism).
- **Loading skeletons** that legitimately have low byte count. Mitigation: configurable min-bytes per pin.

### FP-check plan

- pinnedai.dev (Vite SPA — `<html` + minimal body)
- quantasyte (Vite app)
- socialideagen (Next.js app router with SSR)

For each, generate a `page-renders` pin for the homepage + 1-2 inner pages, run with PREVIEW_URL set, confirm pass. Then deliberately introduce a render error (broken import) and confirm pin fails.

### Estimated effort

- Parser: 2 hrs
- Template: 4 hrs
- Error-marker library: 2 hrs (catalog the actual markers from real Next.js / Vite / Remix render errors)
- FP-check on 3 codebases + adversarial render-break test: 3 hrs
- **Total: ~1.5 working days** (11 hrs).

---

## 3. `validation-rejects-bad`

We have partial coverage via `returns-status` (handles `returns 400 on missing X` form). The gap is the **full bad-input matrix**: for a given endpoint, pin asserts that EACH of `{missing required field, wrong type, oversized payload, malformed JSON}` returns the appropriate 4xx — not just one of them.

### Claim phrasings

- `POST /api/X validates body schema Y`
- `POST /api/X requires fields A, B, C`
- `POST /api/X rejects oversized bodies`
- `POST /api/X rejects bodies missing email`

### Test mechanism

Generates ONE pin that runs N sub-tests, one per bad-input case:
- `missing-required-field`: POST with that field removed → expect 4xx
- `wrong-type`: POST with that field set to wrong type (string → number) → expect 4xx
- `oversized`: POST with that field set to 1MB string → expect 4xx (or 413)
- `malformed-json`: POST with non-JSON body → expect 4xx (or 400)

`[Q7]` Should each case be a separate Pinned pin (per the existing 1-pin-1-assertion convention), or one pin with multiple sub-tests? Separate pins = more PINS.md noise. One pin with sub-tests = harder to retire individual cases.

### Required fixtures / env

- `PREVIEW_URL`
- Per-endpoint schema knowledge (which fields are required, what their types are). At pin-generation time, the auto-protect detector reads the endpoint's validation code (zod schema, yup, joi, manual checks) and extracts the field list.

### False-positive risks

- **Endpoint accepts oversized payloads on purpose** (file upload, log ingestion). Mitigation: schema detection should skip the oversized case for routes whose handler has `bodyParser: { sizeLimit: '...' }` set above a threshold.
- **Endpoint coerces types** (number → string accepted). The wrong-type case would false-fail. Mitigation: read schema's `.strict()` flag (zod) or equivalent; only run wrong-type case for strict schemas.
- **Schema detection misses** the actual validation (custom validator outside the schema library). False-pass — pin says "validation works" but doesn't. Mitigation: pin's failure message tells customer to verify the bad-input matrix covered all required fields they expect.

### FP-check plan

- quantasyte's POST endpoints (signup, billing, etc.)
- socialideagen's POST /api/admin/login (existing fixture)

For each, run `pinned generate` with a validation claim, inspect emitted test, run against a real preview deploy, confirm:
- Each bad-input sub-test correctly fails when sent
- A working endpoint passes all sub-tests
- A endpoint with weak validation (no field-missing check) catches the failure

### Estimated effort

- Parser: 2 hrs
- Schema-detector (zod / yup / joi / manual): 8 hrs
- Template with N sub-tests: 6 hrs
- FP-check + adversarial bad-validation test: 4 hrs
- **Total: ~2.5 working days** (20 hrs).

---

## Total effort estimate + sequencing

| Template | Effort | Ship order |
|---|---|---|
| `page-renders` | ~1.5 days | First — smallest, lowest infra-coupling |
| `validation-rejects-bad` | ~2.5 days | Second |
| `happy-path-with-side-effect` | ~3 days | Third — most design risk, most value |

**~7 working days total** for the three templates. Realistic calendar time across other priorities: 2-3 weeks.

---

## Open questions (must close before implementation starts)

- `[Q1]` happy-path side-effect kinds — db-write only, or all four (db-write, queue-enqueue, email-send, storage-write)?
- `[Q2]` happy-path mechanism — Option A polling, Option B direct DB, or Option C X-Pinned-Side-Effect header?
- `[Q3]` Approve Option A as the v0.2 ship?
- `[Q4]` Polling endpoint — fixed convention (`/__pinned/verify/<id>`) or configurable per pin?
- `[Q5]` page-renders min-body bytes default (200? 500? per-pin override?)
- `[Q6]` page-renders auth handling — only for public pages, or also auth-gated with a token?
- `[Q7]` validation-rejects-bad — one pin per bad-input case, or one pin with N sub-tests?

Once these are closed, the spec becomes implementation-ready and we sequence per the table above. Each ships in its own dot-release with its own CHANGELOG + README update + FP-check on at least 3 real codebases per the [fp-check-everything-with-real-tests] rule.
