import { useEffect, useState } from "react";
import { Demo } from "./Demo.js";
import { WaitlistForm } from "./WaitlistForm.js";

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
          <strong>🎉 Welcome to pinnedai!</strong>
          <span>
            Thanks for joining the free beta. Run <code>npx pinnedai init --auto</code> in
            your repo to install Pinned's guards, AI lessons, and Guard Integrity
            blocker. No account or API key needed.
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

      {/* ─── Top nav (sticky, subtle blur) ────────────────────────── */}
      <nav className="nav">
        <div className="container nav-inner">
          <a href="/" className="nav-brand">
            <img src="/nav-logo.svg" alt="" className="nav-logo" width="30" height="30" />
            <span className="nav-name">pinnedai</span>
          </a>
          <div className="nav-links">
            <a href="#how">How it works</a>
            <a href="#protects">What it protects</a>
            <a href="#pricing">Pricing</a>
            <a href="/proof">Proof</a>
            <a href="https://github.com/pinnedai/pinnedai/tree/master/docs/integrations">Docs</a>
            <a href="https://github.com/pinnedai/pinnedai">GitHub</a>
          </div>
          <a href="#get-started" className="nav-cta">Try free beta</a>
        </div>
      </nav>

      {/* ─── Hero ─────────────────────────────────────────────────── */}
      <header className="hero">
        <div className="container hero-grid">
          <div className="hero-copy">
            <div className="status-pill">Free beta · Founder Pro waitlist open</div>
            <h1>Stop your AI coder from repeating bugs.</h1>
            <p className="hero-sub">
              Pinned finds AI-prone failure patterns in your repo and turns them
              into regression guards.
            </p>
            <p className="hero-sub hero-sub-2">
              When your AI drops auth headers, weakens error handling, skips a
              test, or breaks an app promise, Pinned captures the pattern,
              audits similar code paths, and keeps future edits from repeating it.
            </p>
            <p className="loop">
              <span className="loop-dot">●</span> Bug found
              <span className="loop-arrow">→</span> guard built
              <span className="loop-arrow">→</span> siblings audited
              <span className="loop-arrow">→</span> future edits checked
              <span className="loop-arrow">→</span> AI lesson saved
            </p>
            <div className="hero-cta-row">
              <a href="#get-started" className="cta cta-primary">Try free beta</a>
              <a href="/proof" className="cta cta-secondary">View proof</a>
            </div>
            <p className="hero-trust">
              Local-first · No signup · Free beta
            </p>
          </div>
          <div className="hero-visual">
            <div className="terminal-card">
              <div className="terminal-bar">
                <span className="dot-red" />
                <span className="dot-yellow" />
                <span className="dot-green" />
                <span className="terminal-title">npx pinnedai init --auto</span>
              </div>
              <pre className="terminal-body"><span className="t-accent">◆ Pinned · BASELINE CREATED</span>

<span className="t-dim">Created 8 guards:</span>
<span className="t-pass">  ✓</span> package exports stay stable
<span className="t-pass">  ✓</span> client API <span className="t-mono">authHeaders()</span> preserved
<span className="t-pass">  ✓</span> no public secrets
<span className="t-pass">  ✓</span> pinned tests cannot be skipped/weakened
<span className="t-dim">  + 4 more…</span>

<span className="t-dim">Created 3 AI lessons:</span>
<span className="t-pass">  ✓</span> Do not remove authHeaders() from API calls
<span className="t-pass">  ✓</span> Do not weaken pinned tests to make CI pass
<span className="t-pass">  ✓</span> Do not expose NEXT_PUBLIC_*SECRET*

<span className="t-dim">Next:</span>
<span className="t-prompt">$</span> npx pinnedai audit <span className="t-mono">--learned</span></pre>
            </div>
          </div>
        </div>
      </header>

      {/* ─── Proof strip ──────────────────────────────────────────── */}
      <section className="proof-strip">
        <div className="container">
          <p className="proof-label">Tested on real JS/TS repos</p>
          <div className="proof-grid">
            <div className="proof-stat">
              <div className="proof-num">6 / 6</div>
              <div className="proof-text">repos created useful guards on install</div>
            </div>
            <div className="proof-stat">
              <div className="proof-num">~11</div>
              <div className="proof-text">guards per repo (average)</div>
            </div>
            <div className="proof-stat">
              <div className="proof-num">2–4</div>
              <div className="proof-text">AI lessons per repo</div>
            </div>
            <div className="proof-stat">
              <div className="proof-num">17 / 17</div>
              <div className="proof-text">guard-bypass mutations blocked</div>
            </div>
          </div>
          <p className="proof-foot">
            <a href="/proof">View the full proof page →</a>
          </p>
        </div>
      </section>

      {/* ─── Get started in 2 steps ───────────────────────────────── */}
      <section className="quick-start" id="get-started">
        <div className="container">
          <h2>Get started in 2 steps</h2>
          <div className="quick-steps">
            <div className="quick-step">
              <div className="quick-step-num">1</div>
              <h3>Run Pinned locally</h3>
              <pre className="quick-step-cmd">npx pinnedai init --auto</pre>
              <p>
                Scans your repo, creates baseline guards, writes AI lessons,
                and optionally wires local hooks/statusline. No signup required.
              </p>
            </div>
            <div className="quick-step">
              <div className="quick-step-num">2</div>
              <h3>Sweep your app for write surfaces</h3>
              <pre className="quick-step-cmd">{`npx pinnedai sweep
npx pinnedai audit --learned`}</pre>
              <p>
                One command finds host-conditional route families, multi-step
                journeys, Server Action mutations (DB writes, file uploads,
                paid-API calls), and unprotected write endpoints — then writes
                guards for each.
              </p>
            </div>
          </div>
          <p className="quick-start-foot">
            <em>PR-claim mode is also available</em> — claims like “/api/users is
            rate-limited” in a PR description become permanent tests
            automatically. <em>Browser interaction pins</em> (BETA, opt-in via{" "}
            <code>pinned add-browser</code>) cover carousel/onClick regressions
            via Playwright.
          </p>
        </div>
      </section>

      {/* ─── Interactive demo (guard builder) ─────────────────────── */}
      <section className="demo-section">
        <div className="container">
          <h2>Try the guard builder</h2>
          <p className="section-lede">
            Edit the PR description. Pinned extracts claims and shows the
            guards it would create.
          </p>
          <Demo />
        </div>
      </section>

      {/* ─── How it works ─────────────────────────────────────────── */}
      <section className="how-it-works" id="how">
        <div className="container">
          <h2>How it works</h2>
          <div className="how-grid">
            <div className="how-card">
              <div className="how-num">1</div>
              <h3>AI changes code</h3>
              <ul>
                <li>PR claim, fix, or risky diff appears</li>
                <li>Pinned detects guardable behavior</li>
              </ul>
            </div>
            <div className="how-card">
              <div className="how-num">2</div>
              <h3>Pinned builds guards</h3>
              <ul>
                <li>Writes tests to <code>tests/pinned/</code></li>
                <li>Stores original evidence + reason</li>
              </ul>
            </div>
            <div className="how-card">
              <div className="how-num">3</div>
              <h3>Pinned learns the pattern</h3>
              <ul>
                <li>Appends to <code>.pinned/ai-lessons.md</code></li>
                <li>Audits sibling code paths</li>
              </ul>
            </div>
            <div className="how-card">
              <div className="how-num">4</div>
              <h3>Future edits are checked</h3>
              <ul>
                <li>Guards run in CI + git hooks</li>
                <li>Skips / deletes / weakened assertions blocked</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* ─── What Pinned protects (category cards) ────────────────── */}
      <section className="protects" id="protects">
        <div className="container">
          <h2>What Pinned protects</h2>
          <p className="section-lede">
            Six categories of AI-prone failure patterns. Pinned detects them
            on install, on every PR, and inside the pre-commit hook.
          </p>
          <div className="protects-grid">
            <div className="protect-card">
              <div className="protect-icon" aria-hidden>🔒</div>
              <h3>Auth &amp; access</h3>
              <ul>
                <li><code>/api/admin/export</code> requires auth</li>
                <li>Role checks not stripped from middleware</li>
                <li>Client API keeps <code>authHeaders()</code></li>
              </ul>
              <p className="protect-why">If AI strips auth, customers data leak.</p>
            </div>
            <div className="protect-card">
              <div className="protect-icon" aria-hidden>⚡</div>
              <h3>API correctness</h3>
              <ul>
                <li><code>/api/users</code> stays rate-limited</li>
                <li>Webhooks remain idempotent on <code>event_id</code></li>
                <li>Response status &amp; error handling intact</li>
              </ul>
              <p className="protect-why">If AI breaks this, double-charges &amp; outages.</p>
            </div>
            <div className="protect-card">
              <div className="protect-icon" aria-hidden>🧱</div>
              <h3>Repo integrity</h3>
              <ul>
                <li>Package exports stay stable</li>
                <li>Imports resolve</li>
                <li>CLI commands still exit 0</li>
              </ul>
              <p className="protect-why">If AI breaks this, downstream consumers crash.</p>
            </div>
            <div className="protect-card">
              <div className="protect-icon" aria-hidden>🛡️</div>
              <h3>AI guard integrity</h3>
              <ul>
                <li>Pinned tests cannot be <code>.skip</code>ped</li>
                <li>Assertions cannot be weakened</li>
                <li>Workflows / registry cannot be removed</li>
              </ul>
              <p className="protect-why">If AI tries to bypass the safety net, Pinned refuses the commit.</p>
            </div>
            <div className="protect-card">
              <div className="protect-icon" aria-hidden>🔑</div>
              <h3>Secrets &amp; public exposure</h3>
              <ul>
                <li>No <code>NEXT_PUBLIC_*SECRET*</code> leaks</li>
                <li>No <code>.env</code> committed</li>
                <li>No debug routes left exposed</li>
              </ul>
              <p className="protect-why">If AI exposes server secrets in the client bundle, your keys leak.</p>
            </div>
            <div className="protect-card">
              <div className="protect-icon" aria-hidden>⚡</div>
              <h3>App-Router mutations</h3>
              <ul>
                <li>Next.js Server Actions (<code>"use server"</code>) — DB writes, file uploads, paid-API calls</li>
                <li>Auth gate + input schema captured per action</li>
                <li>Direct-invoke verifier with recorded fixture</li>
              </ul>
              <p className="protect-why">If AI drops the auth gate on <code>saveIdea</code> / <code>uploadMockup</code> / <code>aiFill</code>, you get data abuse, public file uploads, or a $1k Anthropic bill.</p>
            </div>
            <div className="protect-card protect-card-new">
              <div className="protect-icon" aria-hidden>🆕</div>
              <h3>First-time bugs (no baseline needed)</h3>
              <ul>
                <li>Enum drift — consumer reads <code>status === "done"</code> but producer emits <code>"completed"</code></li>
                <li>Undeclared env vars — code reads <code>process.env.X</code> but <code>.env.example</code> doesn't list it</li>
                <li>Missing Supabase columns — <code>.select("col_a")</code> not in migrations</li>
                <li>Webhook header typos — handler reads <code>x-stripe-signature</code> instead of canonical</li>
                <li>Unguarded <code>.find()</code> in route handlers → 500 on first edge case</li>
                <li>Response-shape mismatches — consumer reads key producer never emits</li>
              </ul>
              <p className="protect-why">Bugs at the moment they're written — no green baseline to regress from. The class regression detectors structurally miss.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ─── Bugs Pinned catches (preserved + polished) ───────────── */}
      <section className="catches">
        <div className="container">
          <h2>Real bugs Pinned catches</h2>
          <p className="section-lede">
            Pinned doesn’t catch every bug. It focuses on expensive,
            repeatable AI-coder failure modes — the ones that cost real money
            when they ship.
          </p>
          <div className="catches-grid">
            <div className="catch-card catch-sev-1">
              <div className="catch-sev">🔴 SECURITY</div>
              <h3>Auth dropped from an admin route</h3>
              <p className="catch-scenario">
                AI refactors <code>middleware.ts</code> to “clean up” the auth pattern,
                accidentally drops the check on <code>/api/admin/users-export</code>.
              </p>
              <p className="catch-how">
                <strong>How Pinned catches it:</strong>{" "}
                <code>auth-required</code> pin sends an unauthenticated request
                and asserts 401/403.
              </p>
            </div>
            <div className="catch-card catch-sev-1">
              <div className="catch-sev">🔴 MONEY</div>
              <h3>Webhook idempotency broken</h3>
              <p className="catch-scenario">
                New Stripe webhook handler doesn’t dedupe by <code>event_id</code>.
                Stripe retries, customer charged 2-3×.
              </p>
              <p className="catch-how">
                <strong>How Pinned catches it:</strong>{" "}
                <code>idempotent</code> pin replays the same <code>event_id</code>{" "}
                twice and asserts identical response.
              </p>
            </div>
            <div className="catch-card catch-sev-1">
              <div className="catch-sev">🔴 ACCESS</div>
              <h3>Role check stripped on a paid route</h3>
              <p className="catch-scenario">
                AI shares an auth helper that checks <em>that</em> a user is
                logged in but not <em>which</em> role. Free users access paid features.
              </p>
              <p className="catch-how">
                <strong>How Pinned catches it:</strong>{" "}
                <code>permission-required</code> pin sends no-auth, wrong-role,
                and right-role requests — asserts 401, 403, and 2xx.
              </p>
            </div>
            <div className="catch-card catch-sev-2">
              <div className="catch-sev">🟠 DATA</div>
              <h3>Validation removed</h3>
              <p className="catch-scenario">
                AI “simplifies” the signup flow, drops the email format check
                from <code>/api/signup</code>.
              </p>
              <p className="catch-how">
                <strong>How Pinned catches it:</strong>{" "}
                <code>returns-status</code> pin asserts <code>POST /api/signup</code>{" "}
                returns 400 on missing email.
              </p>
            </div>
            <div className="catch-card catch-sev-2">
              <div className="catch-sev">🟠 ABUSE</div>
              <h3>Rate limit removed or weakened</h3>
              <p className="catch-scenario">
                AI implements rate limiting with an in-memory store that resets on
                deploy. Each deploy effectively removes the limit.
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
              <p className="catch-how">
                <strong>How Pinned catches it:</strong>{" "}
                <code>library-returns</code> pin asserts the expected response
                shape — fails the moment the field is renamed.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ─── Local-first trust strip ──────────────────────────────── */}
      <section className="local-first">
        <div className="container">
          <h2>Local-first by default</h2>
          <ul className="local-first-list">
            <li>✓ No signup required for free beta</li>
            <li>✓ Guards live in <code>tests/pinned/</code> in your repo</li>
            <li>✓ AI lessons live in <code>.pinned/ai-lessons.md</code></li>
            <li>✓ Agent-file integration (CLAUDE.md, .cursorrules) is opt-in</li>
            <li>✓ LLM mode is optional and BYOK</li>
            <li>✓ Source code never leaves your machine on the free tier</li>
          </ul>
        </div>
      </section>

      {/* ─── Pricing + waitlist ───────────────────────────────────── */}
      <section className="pricing" id="pricing">
        <div className="container">
          <h2 id="founder-pro">Pricing</h2>
          <div id="waitlist" />

          <div className="founder-banner">
            <strong>◆ Free protects your repo locally. Pro improves your AI coding system across repos.</strong>
            <span>Free beta is generous and local-first. Founder Pro is a waitlist for when we open paid (no payment now, no card — we’re gauging interest in the features below). Sign up to be first in line + locked into founder pricing when paid opens.</span>
          </div>
          <div className="tiers">
            <div className="tier">
              <div className="tier-name">Free beta</div>
              <div className="tier-price">$0</div>
              <div className="tier-subtitle">For individual AI coders and early teams.</div>
              <ul>
                <li><strong>Unlimited local guards</strong> — no cap on <code>tests/pinned/</code></li>
                <li><strong>Unlimited local AI Lessons</strong> — Claude/Cursor read them before edits</li>
                <li><strong>Guard Integrity</strong> — blocks AI from delete/skip/weaken</li>
                <li>Replay-verified bug-fix guards</li>
                <li>Learned-pattern audits (high-confidence sibling candidates)</li>
                <li>Pre-commit + pre-push hooks, statusline integration</li>
                <li>Report-only CI (run <code>npx pinned guard</code> in your own CI)</li>
                <li>Optional BYOK AI proposer (limited during beta)</li>
                <li>No API key required; one command setup</li>
              </ul>
            </div>
            <div className="tier tier-popular">
              <div className="tier-name">Founder Pro <span className="tier-badge">waitlist · coming soon</span></div>
              <div className="tier-price">tbd<span> · waitlist</span></div>
              <div className="tier-subtitle">For builders and teams that want Pinned automatic across repos and PRs. Locked founder pricing when paid opens. No payment now.</div>
              <ul>
                <li><strong>Everything in Free, plus:</strong></li>
                <li>PR comments with paste-ready repair prompts</li>
                <li>Cloud proof / history dashboard (90-day rollups)</li>
                <li>Cross-repo AI lessons (rules learned in one repo apply to all)</li>
                <li>Hosted AI analysis (no API key required)</li>
                <li>AI / provider mistake analytics (which agent makes which mistakes)</li>
                <li>Managed CI enforcement policies</li>
                <li>Custom guard templates</li>
                <li>Team policies + audit log</li>
              </ul>
              <WaitlistForm />
            </div>
            <div className="tier">
              <div className="tier-name">Team <span className="tier-badge">gauging interest</span></div>
              <div className="tier-price">tbd<span> · gauging interest</span></div>
              <div className="tier-subtitle">If your team would want this, tell us — we're building toward it but haven't shipped yet.</div>
              <ul>
                <li>Org-wide policies</li>
                <li>Audit log</li>
                <li>Slack alerts</li>
                <li>CODEOWNERS routing</li>
              </ul>
            </div>
            <div className="tier">
              <div className="tier-name">Enterprise <span className="tier-badge">gauging interest</span></div>
              <div className="tier-price">tbd<span> · gauging interest</span></div>
              <div className="tier-subtitle">For compliance-heavy orgs (SOC 2 / ISO / FedRAMP). Reach out if this is on your roadmap.</div>
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

      {/* ─── FAQ (kept) ───────────────────────────────────────────── */}
      <section className="faq">
        <div className="container">
          <h2>FAQ</h2>
          <dl className="faq-list">
            <dt>Does Pinned catch every AI bug?</dt>
            <dd>
              No — and we’re upfront about that. Pinned catches a specific
              class: <strong>outright contract violations</strong> (auth removed,
              rate limit deleted, validation stripped, CLI broken, response
              shape drifted). Exactly the mistakes AI agents make most often.
              Pinned does <em>not</em> catch subtle semantic regressions, race
              conditions, or business-logic bugs.
            </dd>

            <dt>How does Pinned handle false positives?</dt>
            <dd>
              Pinned aims for zero false positives. Mitigations we ship today:
              <strong> double-confirm</strong> (each catch is re-run twice with
              a 500ms gap), <strong>silent skip</strong> when{" "}
              <code>PREVIEW_URL</code> isn’t set, and an{" "}
              <strong><code>X-Pinned-Test: 1</code> header</strong> on every
              request so your app can exclude Pinned traffic from rate limits,
              billing counters, and analytics.
            </dd>

            <dt>What if I never see a catch?</dt>
            <dd>
              Most likely outcome — and it’s still valuable.{" "}
              <code>pinned status</code> shows{" "}
              <code>✓ 312 consecutive successful runs</code>: silence reads as
              uptime, not absence. Same logic as TypeScript: most of the value
              is in the contract being written down + verified, not in dramatic
              catches.
            </dd>

            <dt>Does Pinned replace CodeRabbit / Greptile / Qodo?</dt>
            <dd>
              No. AI reviewers comment on PRs. Pinned converts important claims
              into permanent tests that live in your repo. Use them together.
            </dd>

            <dt>Does Pinned commit to my repo?</dt>
            <dd>
              Yes when auto-commit is on (default). Set{" "}
              <code>PINNEDAI_AUTOCOMMIT=false</code> for paste-mode-only — the
              Action posts the generated test in a PR comment instead.
            </dd>

            <dt>Does Pinned use my code for AI training?</dt>
            <dd>
              No. PR-description text is sent to OpenAI for claim extraction
              (subject to OpenAI’s API data policy — not used for training by
              default). Source code is never sent. Safety Pass is fully
              deterministic; <code>--summarize</code> sends only the findings
              JSON, not source or diff.
            </dd>

            <dt>Can I remove a pin?</dt>
            <dd>
              Yes — <code>pinned retire &lt;claim-id&gt; --reason="..."</code>.
              Test moves to <code>tests/pinned/retired/</code> with a per-file{" "}
              <code>&lt;id&gt;.audit.json</code> for the audit trail.
            </dd>

            <dt>What if I don’t use PRs?</dt>
            <dd>
              Pinned works locally too. <code>npx pinnedai init --auto</code>{" "}
              creates the baseline. <code>pinned audit --learned</code> finds
              similar code paths. <code>pinned status</code> reads the cached
              state. Claude Code statusline keeps you informed without opening
              GitHub.
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
