# Test-data fixtures for journey pins

When a journey pin needs a value that only exists in your database (a
confirmation token, a one-time password, a fresh session ID), the
journey template's `capture` step can pull it from a response — but
only if the response carries it. For values that legitimately stay
server-side in production, expose them to Pinned via a non-prod-only
test-fixture header.

## The pattern

Pinned sends every probe with `X-Pinned-Test: 1`. Your handler can
recognize that header and, when the request also carries a shared
secret you control, include an extra field in the response. In
production (no header, no secret), the response is unchanged.

### Example — confirmation token

```ts
// app/api/signup/route.ts
export async function POST(req: Request) {
  const body = await req.json();
  const { token, signupId } = await createSignup(body);
  // send the real email (production behavior preserved)
  await sendConfirmationEmail(body.email, token);

  const isTest =
    req.headers.get("x-pinned-test") === "1" &&
    req.headers.get("x-pinned-secret") === process.env.PINNED_TEST_SECRET;

  return Response.json({
    ok: true,
    signupId,
    // ONLY surface internal data when both the test header AND the
    // shared secret match. Without both, the response is identical
    // to production.
    ...(isTest ? { _pinned_test_data: { confirmationToken: token } } : {}),
  });
}
```

### Using it from a journey pin

```ts
// In your pin's STEPS array (or the journey claim):
{
  method: "POST",
  route: "/api/signup",
  headers: {
    "X-Pinned-Secret": "set via env: PINNED_TEST_SECRET",
  },
  body: { email: "pinned-test@example.com" },
  capture: {
    name: "confirmationToken",
    from: { kind: "body-json", path: "_pinned_test_data.confirmationToken" },
  },
  expect: { status: { min: 200, max: 299 } },
},
{
  method: "GET",
  route: "/api/confirm/${confirmationToken}",
  expect: {
    status: { min: 200, max: 399 },
    setsCookie: "session",
    redirectIncludes: "confirm=ok",
  },
},
```

`${confirmationToken}` in step 2's `route` is substituted from the
local capture map at runtime.

## Why two pieces, not one

- `X-Pinned-Test: 1` is **public** — anyone hitting your preview can
  set that header. It's a hint, not authentication.
- `X-Pinned-Secret: <value>` is **secret** — keep it in your CI as
  `PINNED_TEST_SECRET`, set the same value on the Pinned probe via
  the journey step's `headers` field.

Together: only requests carrying BOTH the public hint AND the secret
shared between your handler and your pin reveal internal data.

## Where to set the secret

For a typical Vercel + GitHub setup:

```bash
# 1. Generate a random secret
openssl rand -hex 32

# 2. Add it to Vercel:
#    Project → Settings → Environment Variables → PINNED_TEST_SECRET
#    Environment: Preview only (NOT Production — defense in depth)

# 3. Add it to GitHub Actions:
#    Settings → Secrets and variables → Actions → PINNED_TEST_SECRET

# 4. Reference it in your workflow:
#    env:
#      PINNED_TEST_SECRET: ${{ secrets.PINNED_TEST_SECRET }}
#    Pinned reads it and forwards as the X-Pinned-Secret header.
```

## Identity marker — upgrade catches from `review` to `confirmed`

When Pinned probes your dev server, it can only verify the URL matches
the one in your config — it can't tell whether the server at that URL
is actually YOUR project (a stray dev server from another project on
the same port would also match). Without identity verification, any
catches Pinned records get tagged `🔍 review` and excluded from the
lifetime `breaksCaught` metric.

To upgrade catches to `confirmed`, opt in to identity verification.

### 1. Add a marker to your Pinned config

`.pinnedai/config.json`:

```json
{
  "http": {
    "mode": "local",
    "url": "http://localhost:3000",
    "start": "npm run dev",
    "ready_path": "/",
    "timeout_seconds": 60,
    "identity_marker": "socialideagen-prod",
    "identity_path": "/__pinned/identity"
  }
}
```

Pick any unique string for `identity_marker` — a project slug, a
random nanoid, anything that identifies THIS project. `identity_path`
defaults to `/__pinned/identity` if omitted.

### 2. Have your dev server respond at that path

Either approach works:

**Option A — response header (lightest):**

```ts
// app/__pinned/identity/route.ts
import { NextResponse } from "next/server";
export async function GET() {
  return new NextResponse(null, {
    status: 204,
    headers: { "X-Pinned-Project": "socialideagen-prod" },
  });
}
```

**Option B — response body (works without header):**

```ts
// app/__pinned/identity/route.ts
import { NextResponse } from "next/server";
export async function GET() {
  return NextResponse.json({ project: "socialideagen-prod" });
}
```

### 3. Run `pinned test`

Pinned will probe `<your-url>/__pinned/identity`. If the response
header `X-Pinned-Project` contains `socialideagen-prod` OR the body
contains it, identity is verified and any catches recorded during
the test run are tagged `confirmed` — counts toward the lifetime
`breaksCaught` metric.

If identity is missing or wrong, catches stay tagged `🔍 review`
(visible in `pinned catches`, audit-only). Either way Pinned still
runs the test, you just know whether to trust the count.

### Why this is opt-in, not required

Most users don't have name collisions on `localhost:3000` and don't
need the verification step. The `review` quarantine is just a safety
net — if a phantom catch ever does happen (port collision, dev server
moved, etc), the headline metric stays honest. Add the marker when:

- You frequently switch between projects on the same port
- You're running Pinned in CI against a self-hosted preview where
  identity matters
- You want the strongest possible signal in `breaksCaught` for a
  customer demo or audit

## Skip real side effects on Pinned probes

Every Pinned-issued HTTP request carries `X-Pinned-Test: 1`. Your handler
can detect that header and **no-op** the side effects that would otherwise
fire in production:

- Skip sending real emails (resend / sendgrid / SES)
- Skip enqueuing real jobs (bullmq / inngest)
- Skip rate-limit accounting (don't burn the user's quota on a probe)
- Skip billing-event emission
- Skip analytics writes

### Example — signup handler that no-ops the email

```ts
export async function POST(req: Request) {
  const body = await req.json();
  const { row, confirmationToken } = await db.createSignup(body);

  const isPinnedProbe = req.headers.get("x-pinned-test") === "1";
  if (!isPinnedProbe) {
    await sendConfirmationEmail(body.email, confirmationToken);
  }

  return Response.json({ ok: true, signupId: row.id });
}
```

The pin still verifies the **important** behavior (status 2xx, DB row
created, response shape) without your real email provider receiving
hundreds of `pinned-test@example.com` deliveries.

### Why this is safe

- `X-Pinned-Test: 1` is a public header — anyone can set it. That's
  fine: it controls only side-effect SUPPRESSION, not authorization.
  Your real auth checks still run.
- The header carries **no secret** and grants **no privilege**. It just
  tells your handler "this is a Pinned probe; please skip the parts
  that would have real-world consequences."

### What's NOT covered by `X-Pinned-Test` alone

Surfacing internal data (confirmation tokens, etc.) requires the
**X-Pinned-Secret** pattern above — that needs both the public hint
AND a shared secret. `X-Pinned-Test` is fire-and-forget; the
fixture/secret combo is the privileged-data path.

## What NOT to expose

The fixture pattern is for values Pinned needs to walk multi-step
flows — confirmation tokens, password-reset tokens, magic-link
tokens. Don't expose:

- Production user PII
- Real session cookies for real users
- Anything that gives an attacker durable access

If you can't construct the value during the test (i.e. it must come
from a real user's account), use a dedicated test account whose
fixture data is set up via your seed script, not exposed via this
header.

## Alternative: a dedicated test endpoint

If you don't want production handlers to know about Pinned at all,
expose a small `app/api/_pinned/fixture/route.ts` that exists only
when `NODE_ENV !== "production"`:

```ts
// app/api/_pinned/fixture/route.ts
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "not available" }, { status: 404 });
  }
  if (req.headers.get("x-pinned-secret") !== process.env.PINNED_TEST_SECRET) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { kind, email } = await req.json();
  if (kind === "confirmation-token") {
    const token = await getConfirmationTokenFor(email);
    return NextResponse.json({ token });
  }
  return NextResponse.json({ error: "unknown kind" }, { status: 400 });
}
```

Then in your pin:

```ts
{
  method: "POST",
  route: "/api/_pinned/fixture",
  headers: { "X-Pinned-Secret": "..." },
  body: { kind: "confirmation-token", email: "pinned-test@example.com" },
  capture: { name: "token", from: { kind: "body-json", path: "token" } },
  expect: { status: 200 },
}
```

Either pattern works — pick the one that fits your handler discipline.
