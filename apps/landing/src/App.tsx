import { useEffect, useState } from "react";
import { Demo } from "./Demo.js";

export function App() {
  const [showWelcome, setShowWelcome] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("welcome") === "true") setShowWelcome(true);
  }, []);

  return (
    <div className="page">
      {showWelcome ? (
        <div className="welcome-banner">
          <strong>🎉 Welcome to pinnedai Pro!</strong>
          <span>
            Pro is now active for your GitHub org. Open a PR with a claim — Pinned
            will detect your subscription via OIDC and pin without limits. No license
            key, no API key, no extra config required.
          </span>
          <button
            type="button"
            onClick={() => setShowWelcome(false)}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      ) : null}
      <header className="hero">
        <div className="container">
          <div className="brand">
            <span className="dot" />
            <span className="brand-name">pinnedai</span>
          </div>
          <h1>Permanent guardrails for AI-coded apps.</h1>
          <p className="tagline-sub">
            <strong>Pinned remembers the promises your app must keep — auth, billing, rate limits, webhooks, permissions, and critical flows — and blocks future AI edits from quietly breaking them.</strong>
          </p>
          <p className="lede">
            Cursor writes the code. CodeRabbit reviews it. <strong>Pinned turns the promises in your PR description — "auth required on /api/admin", "rate-limits /api/users to 60/min", "Stripe webhook idempotent by event_id" — into permanent Vitest tests</strong> that re-run on every commit.
            When a future AI change touches protected behavior, CI fails loudly with a back-reference to the original PR and a paste-ready repair prompt for Cursor or Claude Code.
          </p>
          <div className="install">
            <code>npx pinnedai</code>
            <span className="install-hint">— zero install, instant demo</span>
          </div>
        </div>
      </header>

      <section className="quick-start">
        <div className="container">
          <h2>Get started in 2 steps</h2>
          <div className="quick-steps">
            <div className="quick-step">
              <div className="quick-step-num">1</div>
              <h3>Install the GitHub Action</h3>
              <pre className="quick-step-cmd">npx pinnedai init</pre>
              <p>
                Scaffolds <code>.github/workflows/pinned.yml</code> +{" "}
                <code>tests/pinned/</code>. Offers to wire your Claude Code
                statusline. No API key, no signup.
              </p>
            </div>
            <div className="quick-step">
              <div className="quick-step-num">2</div>
              <h3>Open a PR with a claim</h3>
              <pre className="quick-step-cmd">{`## What this PR does
- Auth required on /api/admin/export.
- Rate-limits /api/users to 60 req/min.`}</pre>
              <p>
                Pinned reads the description, generates the test file, commits it
                to your PR branch, comments to confirm. Done.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="demo-section">
        <div className="container">
          <h2>Try it right here</h2>
          <p className="section-lede">
            Edit the PR description below — watch the generated test update live.
            This is the exact parser and template code <code>npx pinnedai</code> ships.
          </p>
          <Demo />
        </div>
      </section>

      <section className="how-it-works">
        <div className="container">
          <h2>How it works</h2>
          <div className="steps-grid">
            <div className="step">
              <div className="step-num">1</div>
              <h3>AI changes your app</h3>
              <p>
                Your AI coder adds auth, rate limits, a webhook handler, a
                payment flow, booking logic, or any other behavior that
                matters. The PR description (or commit message) says what
                changed.
              </p>
            </div>
            <div className="step">
              <div className="step-num">2</div>
              <h3>Pinned protects the change</h3>
              <p>
                Pinned reads the claim ("auth required on /api/admin/export"),
                generates a Vitest file that verifies it, and commits the file
                to your repo. The test lives in <code>tests/pinned/</code> permanently.
              </p>
            </div>
            <div className="step">
              <div className="step-num">3</div>
              <h3>Pinned verifies the promise — continuously</h3>
              <p>
                Every commit re-runs the pinned tests in the background. Most
                of the time you see <code>✓ 312 consecutive successful runs</code>{" "}
                — uptime, not noise. If a future change ever breaks a
                protected promise, CI fails loudly and points at the
                original PR + a paste-ready repair prompt for Cursor /
                Claude Code.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="examples">
        <div className="container">
          <h2>What Pinned protects</h2>
          <p className="section-lede">
            Examples of claims your AI coder writes in PR descriptions that
            become permanent CI tests:
          </p>
          <ul className="example-list">
            <li><code>/api/admin/export</code> must require auth</li>
            <li><code>/api/users</code> must be rate-limited to 60 req/min</li>
            <li>The Stripe webhook must be idempotent on <code>event_id</code></li>
            <li><code>pinned doctor</code> must exit 0 on a healthy repo</li>
            <li><code>pinned init</code> must create <code>tests/pinned/.registry.json</code></li>
            <li><code>parseConfig()</code> in <code>src/config.ts</code> must return <code>{"{\"version\": 1}"}</code></li>
            <li>Admin routes should not silently become public</li>
            <li>Bookings should create one appointment per request, not two</li>
          </ul>
          <p className="examples-foot">
            Eight templates across three domains: web routes, CLI tools,
            library functions. <a href="/for-nextjs">See the Next.js examples</a> or
            run <code>npx pinnedai baseline</code> to find what your repo already promises.
          </p>
        </div>
      </section>

      <section className="catches">
        <div className="container">
          <h2>The bugs Pinned catches (the ones that hurt most)</h2>
          <p className="section-lede">
            Pinned doesn't catch every AI bug — but it specializes in the
            most expensive class. Below are exact regression patterns Pinned
            guards against, ranked by what they cost when they ship.
          </p>
          <div className="catches-grid">
            <div className="catch-card catch-sev-1">
              <div className="catch-sev">🔴 SECURITY</div>
              <h3>Auth dropped from an admin route</h3>
              <p className="catch-scenario">
                AI refactors <code>middleware.ts</code> to "clean up" the auth
                pattern, accidentally drops the check on{" "}
                <code>/api/admin/users-export</code>.
              </p>
              <p className="catch-without">
                <strong>Without Pinned:</strong> any user can hit admin endpoints —
                potential data leak, GDPR/SOC2 incident.
              </p>
              <p className="catch-how">
                <strong>How Pinned catches it:</strong>{" "}
                <code>auth-required</code> pin sends an unauthenticated GET to
                the route and asserts 401/403.
              </p>
            </div>
            <div className="catch-card catch-sev-1">
              <div className="catch-sev">🔴 MONEY</div>
              <h3>Webhook idempotency broken</h3>
              <p className="catch-scenario">
                New Stripe webhook handler doesn't dedupe by{" "}
                <code>event_id</code>. Stripe retries on transient errors and
                customer gets charged 2-3×.
              </p>
              <p className="catch-without">
                <strong>Without Pinned:</strong> refunds, support tickets,
                customer churn.
              </p>
              <p className="catch-how">
                <strong>How Pinned catches it:</strong>{" "}
                <code>idempotent</code> pin replays the same{" "}
                <code>event_id</code> twice and asserts identical response.
              </p>
            </div>
            <div className="catch-card catch-sev-1">
              <div className="catch-sev">🔴 ACCESS</div>
              <h3>Role check stripped on a paid route</h3>
              <p className="catch-scenario">
                AI refactors RBAC middleware to share a helper. The new helper
                checks <em>that</em> a user is authenticated but not{" "}
                <em>which</em> role. Free users now access admin features.
              </p>
              <p className="catch-without">
                <strong>Without Pinned:</strong> revenue leak +
                privilege-escalation breach.
              </p>
              <p className="catch-how">
                <strong>How Pinned catches it:</strong>{" "}
                <code>permission-required</code> pin sends 3 requests — no
                auth, wrong-role token, right-role token — and asserts
                401/403, 403, and 2xx respectively. The wrong-role direction
                catches exactly this pattern.
              </p>
            </div>
            <div className="catch-card catch-sev-2">
              <div className="catch-sev">🟠 DATA</div>
              <h3>Validation removed</h3>
              <p className="catch-scenario">
                AI "simplifies" the signup flow, drops the email format check
                from <code>/api/signup</code>.
              </p>
              <p className="catch-without">
                <strong>Without Pinned:</strong> junk emails in DB,
                transactional emails bounce, downstream services crash.
              </p>
              <p className="catch-how">
                <strong>How Pinned catches it:</strong>{" "}
                <code>returns-status</code> pin asserts{" "}
                <code>POST /api/signup</code> returns 400 on missing email.
              </p>
            </div>
            <div className="catch-card catch-sev-2">
              <div className="catch-sev">🟠 ABUSE</div>
              <h3>Rate limit removed or weakened</h3>
              <p className="catch-scenario">
                AI implements rate limiting using an in-memory store that
                resets on deploy. Each deploy effectively removes the limit.
              </p>
              <p className="catch-without">
                <strong>Without Pinned:</strong> bot scrapers, brute-force
                attempts, cloud bill spike.
              </p>
              <p className="catch-how">
                <strong>How Pinned catches it:</strong>{" "}
                <code>rate-limit</code> pin fires <code>rate+1</code> parallel
                requests and asserts at least one returns 429.
              </p>
            </div>
            <div className="catch-card catch-sev-3">
              <div className="catch-sev">🟡 BREAKAGE</div>
              <h3>API contract drift</h3>
              <p className="catch-scenario">
                AI renames a response field from <code>created_at</code> to{" "}
                <code>createdAt</code>. Every downstream consumer crashes.
              </p>
              <p className="catch-without">
                <strong>Without Pinned:</strong> all-hands incident, prod
                rollback, hours of debugging.
              </p>
              <p className="catch-how">
                <strong>How Pinned catches it:</strong>{" "}
                <code>library-returns</code> /{" "}
                <code>returns-status</code> pin asserts the expected response
                shape — fails the moment the field is renamed.
              </p>
            </div>
          </div>
          <p className="catches-foot">
            Every catch above is from a real-world AI-coded regression pattern.
            Pinned is built to make these specific kinds of bugs impossible to
            ship silently. See{" "}
            <a href="https://github.com/pinnedai/pinnedai/tree/main/tests/pinned">
              tests/pinned/
            </a>{" "}
            in our own repo for a working example.
          </p>
        </div>
      </section>

      <section className="safety-pass">
        <div className="container">
          <h2>Safety Pass — finds risky AI mistakes before they ship</h2>
          <p className="section-lede">
            Every <code>pinned</code> run includes a deterministic Safety Pass:
            env vars used but not in <code>.env.example</code>, <code>NEXT_PUBLIC_*SECRET</code>{" "}
            leaks, public CORS wildcards, destructive SQL in migrations, and lint
            escape hatches. <strong>Zero LLM cost by default.</strong> Optional{" "}
            <code>--summarize</code> sends only the findings JSON (never your diff)
            to the hosted LLM for a 3-bullet summary.
          </p>
          <pre className="safety-example">
{`$ pinned safety
Safety Pass: 2 warnings · 1 info

  ⚠ Env var \`STRIPE_SECRET_KEY\` is used in code but not listed in .env.example.
     src/billing.ts:14
     → Add STRIPE_SECRET_KEY= to .env.example so teammates know it's required.

  ⚠ \`NEXT_PUBLIC_API_TOKEN\` is exposed to the browser but its name implies a secret.
     src/client.ts:8
     → Move to a server-only env var (drop NEXT_PUBLIC_).

  · @ts-ignore detected
     src/handler.ts:42`}
          </pre>
        </div>
      </section>

      <section className="surfaces">
        <div className="container">
          <h2>Where Pinned shows up</h2>
          <p className="section-lede">
            Pinned lives wherever AI coders work — local terminal, editor,
            CI. It doesn't require a PR-first workflow.
          </p>
          <div className="surfaces-grid">
            <div className="surface">
              <div className="surface-label">Local CLI</div>
              <pre className="surface-example">{`$ pnpm pinned status

◆ Pinned status

Pins:
  ✓ 8 active, all passing

Unpinned risks:
  ⚠ 2 detected — run \`pinned protect\``}</pre>
            </div>
            <div className="surface">
              <div className="surface-label">Claude Code statusline</div>
              <pre className="surface-example">{`◆ pinned · 8 pins · ✓
◆ pinned · 8 pins · ✗ 1 failing
◆ pinned · 8 pins · ⚠ 2 risks`}</pre>
              <p className="surface-hint">
                Persistent bottom-bar indicator. Failure-only chat injection
                — no noise when green.
              </p>
            </div>
            <div className="surface">
              <div className="surface-label">CLAUDE.md / .cursorrules</div>
              <pre className="surface-example">{`## Pinned

Rules:
1. Before marking work complete, run \`pinned test\`.
2. Don't delete tests in tests/pinned/.
3. If a Pinned test fails, fix the app
   code first — don't weaken the test.`}</pre>
              <p className="surface-hint">
                Optional opt-in via <code>pinned ai-rules install</code>. We
                ask, we never auto-write.
              </p>
            </div>
            <div className="surface">
              <div className="surface-label">GitHub Action</div>
              <pre className="surface-example">{`◆ Pinned protected this PR · 2 added · 14 total

What was pinned:
- tests/pinned/pr-42-auth-required-...
  > Auth required on /api/admin/export.`}</pre>
              <p className="surface-hint">
                Short comment on every PR. Auto-commits pin files. Catches
                the @pinned add: trigger from review comments.
              </p>
            </div>
            <div className="surface">
              <div className="surface-label">tests/pinned/ in your repo</div>
              <pre className="surface-example">{`tests/pinned/
├── pr-42-auth-required-...test.ts
├── pr-43-rate-limit-...test.ts
├── PINS.md         (visible registry)
└── .registry.json  (state)`}</pre>
              <p className="surface-hint">
                Cancel Pinned → all your tests stay. The artifact IS the
                product.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="why">
        <div className="container">
          <h2>The missing layer in the AI-coding stack</h2>
          <p className="section-lede">
            <strong>Cursor / Claude Code writes the code → CodeRabbit / Copilot reviews it → Pinned converts important claims into tests → CI enforces them forever.</strong>
            Pinned isn't a CodeRabbit replacement. It's the artifact CodeRabbit doesn't leave behind.
          </p>
          <div className="why-grid">
            <div className="why-card">
              <div className="why-label">CodeRabbit / Greptile / Qodo</div>
              <ul>
                <li>Review comments at PR open</li>
                <li>LLM judgment per PR (fragile + expensive)</li>
                <li>Cancel → nothing carries forward</li>
                <li>Find <em>possible</em> bugs</li>
                <li>Advice disappears after merge</li>
              </ul>
            </div>
            <div className="why-card why-card-us">
              <div className="why-label">Pinned</div>
              <ul>
                <li><strong>Run baseline today</strong> — find 8 unprotected promises in 30 seconds</li>
                <li><strong>Every PR</strong> — risk summary + auto-generated pins for new claims</li>
                <li>Permanent tests in your repo with back-reference to the original PR</li>
                <li>Cancel → thousands of tests stay yours</li>
                <li>Tests that <em>document the contract and verify it continuously</em></li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      <section className="install">
        <div className="container">
          <h2>Install</h2>
          <p className="section-lede">
            One command. No signup. No API key.
          </p>
          <pre className="install-cmd">npx pinnedai init</pre>
          <p className="install-foot">What it adds:</p>
          <ul className="install-list">
            <li>✓ <code>.github/workflows/pinned.yml</code> — GitHub Action wiring</li>
            <li>✓ <code>tests/pinned/</code> directory with auto-maintained <code>PINS.md</code></li>
            <li>✓ <code>tests/pinned/AGENT.md</code> — agent-readable rule reference</li>
            <li>✓ Optional: appends a marked block to <code>CLAUDE.md</code> / <code>.cursorrules</code> (with your consent)</li>
            <li>✓ Optional: <code>.claude/settings.json</code> for statusline + failure hook (with your consent)</li>
          </ul>
          <p className="install-foot">Then:</p>
          <pre className="install-cmd">npx pinnedai baseline   # find unprotected promises today
npx pinnedai status     # full breakdown
npx pinnedai protect    # turn risks into pins</pre>
        </div>
      </section>

      <section className="pricing">
        <div className="container">
          <h2>Pricing</h2>
          <div className="founder-banner">
            <strong>◆ Early users get founder pricing, locked while active</strong>
            <span>$9.99/mo for users who back Pinned before the wider launch. Standard Pro is $19/mo. Founder pricing is locked while your subscription remains active. Fair-use limits apply.</span>
          </div>
          <div className="tiers">
            <div className="tier">
              <div className="tier-name">Free</div>
              <div className="tier-price">$0</div>
              <ul>
                <li><strong>Unlimited pins</strong> on every repo</li>
                <li>All 8 templates (web + CLI + library)</li>
                <li><strong>Safety Pass</strong> (deterministic AI-mistake scan)</li>
                <li>Claude Code statusline + failure-only chat hook</li>
                <li><strong>500 LLM calls/mo</strong> on public · <strong>100/mo</strong> on private</li>
                <li>No API key needed (OIDC keyless)</li>
              </ul>
            </div>
            <div className="tier tier-popular">
              <div className="tier-name">Founder Pro <span className="tier-badge">early access</span></div>
              <div className="tier-price">$9.99<span>/mo</span></div>
              <div className="tier-subtitle">Founder pricing is locked while your subscription remains active. Standard Pro is $19/mo. Fair-use limits apply.</div>
              <ul>
                <li><strong>Unlimited active pins</strong></li>
                <li><strong>5,000 LLM calls / month</strong> (fair use)</li>
                <li>Safety Pass <code>--summarize</code> (LLM-backed)</li>
                <li>Optional BYOK (Anthropic / OpenAI) for privacy</li>
                <li>Custom claim templates</li>
                <li><code>@pinned fix</code> deep review (v0.2)</li>
              </ul>
              {/*
                Pro tier CTA. The real Stripe payment link goes here at
                launch. Until then we expose a clearly-marked placeholder
                URL so visitors aren't sent to the Free install when they
                meant to subscribe. The `data-placeholder` attribute makes
                the placeholder state queryable from launch-readiness
                checks (the K.x distribution audit reads it).
              */}
              <a
                className="tier-cta tier-cta-placeholder"
                href="https://buy.stripe.com/PLACEHOLDER_PINNED_PRO"
                data-placeholder="stripe-link"
                onClick={(e) => {
                  e.preventDefault();
                  alert(
                    "Stripe Pro subscription link not live yet — coming with launch. " +
                    "For now, run `npx pinnedai init` to install Free; Pro upgrade " +
                    "auto-detects your org via OIDC once the subscription is active."
                  );
                }}
              >
                Subscribe — Stripe link launching soon →
              </a>
            </div>
            <div className="tier">
              <div className="tier-name">Team</div>
              <div className="tier-price">$199<span>/mo</span></div>
              <ul>
                <li>Org-wide policies</li>
                <li>Audit log</li>
                <li>Slack alerts</li>
                <li>CODEOWNERS routing</li>
              </ul>
            </div>
            <div className="tier">
              <div className="tier-name">Enterprise</div>
              <div className="tier-price">$20K+<span>/yr</span></div>
              <ul>
                <li>Self-hosted runner</li>
                <li>SSO</li>
                <li>SOC 2 CC8.1 evidence export</li>
                <li>Compliance reporting</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      <section className="faq">
        <div className="container">
          <h2>FAQ</h2>
          <dl className="faq-list">
            <dt>Does Pinned catch every AI bug?</dt>
            <dd>
              No — and we're upfront about that. Pinned catches a specific
              class of bugs: <strong>the outright contract violation</strong>{" "}
              (auth removed from a route, rate limit deleted, validation
              stripped out, CLI command broken, library function returning
              the wrong shape). These are exactly the kinds of mistakes AI
              agents make most often. Pinned does <em>not</em> catch subtle
              semantic regressions, race conditions, or business-logic bugs.
              <br /><br />
              The honest framing: Pinned writes down important behavior as
              tests and verifies them continuously. Most of the time it's
              quiet. When a future change breaks a protected promise, the
              failure is loud, traceable, and tells the AI exactly what to fix.
            </dd>

            <dt>How does Pinned handle false positives?</dt>
            <dd>
              Pinned aims for zero false positives, but isn't there. Generated
              pins are integration tests that run against your preview deploy,
              and <strong>environment issues can occasionally cause a pin to
              fail when nothing's actually broken</strong> — cold-start preview,
              expired test credentials, network blips.
              <br /><br />
              Mitigations we ship: <strong>double-confirm</strong> (every catch
              is re-run twice with a 500ms gap before being reported as a
              failure), <strong>per-pin flakiness tracking</strong> (a pin that
              flaps gets quarantined), <strong>silent skip</strong> when{" "}
              <code>PREVIEW_URL</code> isn't set (no false alarm when there's
              nothing to test against), and an <strong>{" "}
              <code>X-Pinned-Test: 1</code> header</strong> on every request so
              your app can exclude Pinned traffic from rate limits, billing-tier
              counters, and analytics.
              <br /><br />
              If a catch ever looks wrong, re-run{" "}
              <code>npx vitest run &lt;file&gt;</code> manually before changing
              code — and please{" "}
              <a href="https://github.com/pinnedai/pinnedai/issues">file an issue</a>{" "}
              if it's spurious so we can tighten the template.
            </dd>

            <dt>What if I never see a catch?</dt>
            <dd>
              That's the most likely outcome — and it's still valuable.{" "}
              <code>pinned status</code> shows <code>✓ 312 consecutive
              successful runs</code>: silence reads as uptime, not absence.
              TypeScript catches almost no "real" bugs either, but enforces
              discipline that prevents whole classes of mistakes. Pinned
              works the same way: the value is in the contract being written
              down + auto-verified. Catches are the dramatic moment, not the
              core value prop.
            </dd>

            <dt>Does Pinned replace CodeRabbit / Greptile / Qodo?</dt>
            <dd>
              No. AI reviewers comment on PRs. Pinned converts important claims
              into permanent tests that live in your repo. Use them together.
            </dd>

            <dt>Does Pinned commit to my repo?</dt>
            <dd>
              Yes when auto-commit is on (default). Set repo variable{" "}
              <code>PINNEDAI_AUTOCOMMIT=false</code> for paste-mode-only —
              the Action posts the generated test in a PR comment instead.
            </dd>

            <dt>Does Pinned use my code for AI training?</dt>
            <dd>
              No. PR-description text is sent to OpenAI for claim
              extraction (subject to OpenAI's API data policy — not used
              for training by default). Source code is never sent. The Safety
              Pass is fully deterministic; the optional <code>--summarize</code>{" "}
              flag sends only the findings JSON, not source or diff.
            </dd>

            <dt>Does Pinned need an API key?</dt>
            <dd>
              No — Free tier uses OIDC-keyless onboarding via GitHub Actions.
              Pro can optionally set BYOK (Anthropic / OpenAI) for compliance.
            </dd>

            <dt>What happens at the monthly LLM-call cap?</dt>
            <dd>
              The Worker returns a 429 with three options: upgrade to Pro,
              set BYOK (your own provider key, no Pinned-side cap), or wait
              until the 1st. Existing pins keep running locally either way —
              they don't need the Worker.
            </dd>

            <dt>Can I remove a pin?</dt>
            <dd>
              Yes — run <code>pinned retire &lt;claim-id&gt; --reason="..."</code>.
              The test moves to <code>tests/pinned/retired/</code> with a
              per-file <code>&lt;id&gt;.audit.json</code> for the audit trail.
              Don't just delete the file; the audit trail matters for
              compliance and for understanding why a contract was dropped.
            </dd>

            <dt>What if I don't use PRs?</dt>
            <dd>
              Pinned works locally too. <code>npx pinnedai baseline</code>{" "}
              finds risky promises in your current code. <code>pinned
              protect</code> turns them into pins interactively.{" "}
              <code>pinned status</code> reads the cached state. The Claude
              Code statusline keeps you informed without opening GitHub.
            </dd>
          </dl>
        </div>
      </section>

      <footer className="footer">
        <div className="container">
          <span>pinnedai — built solo with Claude</span>
          <span className="sep">·</span>
          <a href="https://github.com/pinnedai/pinnedai">github</a>
          <span className="sep">·</span>
          <a href="https://www.npmjs.com/package/pinnedai">npm</a>
          <span className="sep">·</span>
          <a href="https://github.com/pinnedai/pinnedai/issues">issues</a>
        </div>
      </footer>
    </div>
  );
}
