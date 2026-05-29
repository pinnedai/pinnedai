// /proof — proof page. Spec: docs/proof-page-spec.md.
//
// Numbers come from the 2026-05-25 sweep across 11 of the operator's
// own dyad-apps repos. Real catch counts (parent=fail, fix=pass).
// All numbers cited here are MEASURED; placeholders marked "pending"
// will be replaced as new benchmarks land.

export function Proof(): JSX.Element {
  return (
    <div className="page">
      {/* ─── Top nav (mirrors landing) ───────────────────────── */}
      <nav className="nav">
        <div className="container nav-inner">
          <a href="/" className="nav-brand">
            <span className="nav-dot" />
            <span className="nav-name">pinnedai</span>
          </a>
          <div className="nav-links">
            <a href="/#how">How it works</a>
            <a href="/#protects">What it protects</a>
            <a href="/#pricing">Pricing</a>
            <a href="/proof" aria-current="page" className="nav-active">Proof</a>
            <a href="https://github.com/pinnedai/pinnedai/tree/master/docs/integrations">Docs</a>
            <a href="https://github.com/pinnedai/pinnedai">GitHub</a>
          </div>
          <a href="/#get-started" className="nav-cta">Try free beta</a>
        </div>
      </nav>

      <main>
        {/* ─── Hero with summary stats ───────────────────────── */}
        <header className="proof-hero">
          <div className="container">
            <div className="proof-eyebrow">PROOF</div>
            <h1>Tested on real JS/TS repos.</h1>
            <p className="proof-lede">
              Pinned was tested against the failure modes AI coders
              actually create: weakened tests, deleted guards, missing
              auth/error-handling patterns, broken exports, and repeated
              mistakes across similar code paths.
            </p>
            <div className="proof-summary-grid">
              <div className="proof-stat-big">
                <div className="proof-num">11 / 11</div>
                <div className="proof-text">repos produced ≥2 useful guards on first install</div>
              </div>
              <div className="proof-stat-big">
                <div className="proof-num">17 / 17</div>
                <div className="proof-text">deliberate guard-bypass mutations blocked</div>
              </div>
              <div className="proof-stat-big">
                <div className="proof-num">186 + 46</div>
                <div className="proof-text">replay-verified catches across 684 fix-shaped commits</div>
              </div>
              <div className="proof-stat-big">
                <div className="proof-num">9 / 11</div>
                <div className="proof-text">repos produced ≥1 bug-fix replay catch</div>
              </div>
            </div>
            <p className="proof-trust">Local-first · No signup · All numbers measured, not modeled</p>
          </div>
        </header>

        {/* ─── 1. Install scan ───────────────────────────────── */}
        <section className="proof-card-section">
          <div className="container">
            <div className="proof-card">
              <div className="proof-card-header">
                <div className="proof-card-num">01</div>
                <div>
                  <h2>Install scan — useful guards on first run</h2>
                  <p className="proof-card-lede">
                    When you install Pinned, it scans your repo for high-confidence
                    things worth protecting: package exports, CLI entry points,
                    secret exposure, config invariants, client API patterns,
                    webhook handlers, and guard integrity.
                  </p>
                </div>
              </div>
              <div className="terminal-card">
                <div className="terminal-bar">
                  <span className="dot-red" />
                  <span className="dot-yellow" />
                  <span className="dot-green" />
                  <span className="terminal-title">pinned init --auto</span>
                </div>
                <pre className="terminal-body">{`◆ Pinned · BASELINE CREATED

Protecting your code (8 guards):
  ✓ no \`VITE_*\` env var leaks a secret to the client bundle
  ✓ Lockfile changes can't sneak past package.json bumps
  ✓ \`/api/admin\` requires login (AI can't strip the auth check)
  ✓ Client API in \`src/lib/api.ts\` keeps its Authorization header
  ✓ Route \`/dashboard\` stays registered in \`src/App.tsx\`
  ✓ Form in \`src/pages/Login.tsx\` keeps its submit-handler error handling
  ✓ Stripe webhook signature still verified in \`api/webhook.ts\`
  ✓ Fix preserved: \`/api/v2/agent\` stays in \`src/lib/retell.ts\`

Created 4 AI lessons:
  ✓ Do not expose server secrets with public env prefixes.
  ✓ Do not regenerate the lockfile without a real dep change.
  ✓ Do not weaken pinned tests to make CI pass.
  ✓ Do not break the CLI binary's --help command.`}</pre>
              </div>
              <p className="proof-card-note">
                <strong>Honest caveat.</strong> Not every repo exposes the same
                guardable surface. UI-heavy / static-content repos produce fewer
                pins (2–5 baseline); server-side or contract-shaped repos produce
                more (15–45).
              </p>
            </div>
          </div>
        </section>

        {/* ─── 2. Guard integrity ────────────────────────────── */}
        <section className="proof-card-section">
          <div className="container">
            <div className="proof-card">
              <div className="proof-card-header">
                <div className="proof-card-num">02</div>
                <div>
                  <h2>Guard integrity — blocking AI test-bypass attempts</h2>
                  <p className="proof-card-lede">
                    AI coding agents are often optimized to make tests pass.
                    Pinned treats protected guards as part of the safety boundary
                    and blocks edits that delete, skip, weaken, or bypass them.
                    Defense is two-layered: a pre-commit hook blocks at the local
                    git layer; the CI workflow blocks a second time even if the
                    pre-commit was bypassed with <code>--no-verify</code>.
                  </p>
                </div>
              </div>
              <div className="proof-blocked-grid">
                <div className="proof-blocked-card">
                  <div className="proof-blocked-icon">⛔</div>
                  <strong>Deleted pin file</strong>
                  <span>without retire-with-audit</span>
                </div>
                <div className="proof-blocked-card">
                  <div className="proof-blocked-icon">⛔</div>
                  <strong>.skip() / xit() / .only()</strong>
                  <span>and skipIf(true)</span>
                </div>
                <div className="proof-blocked-card">
                  <div className="proof-blocked-icon">⛔</div>
                  <strong>Weakened assertion</strong>
                  <span>toBe(401) → toBeTruthy()</span>
                </div>
                <div className="proof-blocked-card">
                  <div className="proof-blocked-icon">⛔</div>
                  <strong>|| true / ?? true</strong>
                  <span>catch fallthrough</span>
                </div>
                <div className="proof-blocked-card">
                  <div className="proof-blocked-icon">⛔</div>
                  <strong>Commented assertions</strong>
                  <span>or expect.assertions(0)</span>
                </div>
                <div className="proof-blocked-card">
                  <div className="proof-blocked-icon">⛔</div>
                  <strong>Pinned workflow disabled</strong>
                  <span>or registry tampered</span>
                </div>
              </div>
              <div className="proof-headline-stat">
                <div className="proof-headline-num">17 / 17</div>
                <div className="proof-headline-text">
                  deliberate bypass attempts blocked in the mutation-test harness.
                  <br />
                  <em>This tests deliberate bypass attempts. It doesn't claim every AI agent in every repo will try these.</em>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ─── 3. AI lessons ─────────────────────────────────── */}
        <section className="proof-card-section">
          <div className="container">
            <div className="proof-card">
              <div className="proof-card-header">
                <div className="proof-card-num">03</div>
                <div>
                  <h2>AI lessons — mistakes become repo memory</h2>
                  <p className="proof-card-lede">
                    When Pinned learns a bug pattern, it writes a short
                    repo-specific lesson to <code>.pinned/ai-lessons.md</code>.
                    Agent files are opt-in; Pinned does not silently rewrite
                    CLAUDE.md, Cursor rules, or Copilot instructions.
                  </p>
                </div>
              </div>
              <div className="terminal-card">
                <div className="terminal-bar">
                  <span className="dot-red" />
                  <span className="dot-yellow" />
                  <span className="dot-green" />
                  <span className="terminal-title">.pinned/ai-lessons.md</span>
                </div>
                <pre className="terminal-body">{`## Auth headers in protected API calls

**Past mistake:**
\`getReport()\` failed because the Authorization header was missing.

**Rule:**
Do not remove \`authHeaders()\` from protected API client calls.

**Guard:** \`client-getReport-authHeaders\`

**Plain English:** Don't drop authHeaders() from protected API calls.`}</pre>
              </div>
              <p className="proof-card-note">
                Across the benchmark repos Pinned generated <strong>2–5 lessons per
                repo</strong>, each tied to a real guard. Lessons stay in the repo —
                Pinned is local-first by default.
              </p>
            </div>
          </div>
        </section>

        {/* ─── 4. Learned audits ─────────────────────────────── */}
        <section className="proof-card-section">
          <div className="container">
            <div className="proof-card">
              <div className="proof-card-header">
                <div className="proof-card-num">04</div>
                <div>
                  <h2>Learned audits — checking sibling code paths</h2>
                  <p className="proof-card-lede">
                    After Pinned learns a mistake pattern, it audits similar code
                    paths for the same gap. Goal: find places where the same
                    mistake may already exist or may be repeated later.
                  </p>
                </div>
              </div>
              <div className="terminal-card">
                <div className="terminal-bar">
                  <span className="dot-red" />
                  <span className="dot-yellow" />
                  <span className="dot-green" />
                  <span className="terminal-title">pinned audit --learned</span>
                </div>
                <pre className="terminal-body">{`◆ Pinned · AUDIT

Checked similar code paths based on 4 lessons.
Found 20 places worth a look:

  Worth checking when you have time:
    · /api/billing  —  looks like a route file with no login check
    · /api/admin    —  looks like a route file with no login check
    · /api/contact  —  looks like a write route with no input validation
    ...

Open each file and decide:
  • Add the same protection — then re-run \`pinned init --auto\` to capture.
  • Mark as intentionally public — ignore.`}</pre>
              </div>
              <p className="proof-card-note">
                High-confidence findings are shown by default; medium-confidence is
                verbose-only. <em>Siblings are candidates unless validated by a
                guard, replay, or user confirmation.</em>
              </p>
            </div>
          </div>
        </section>

        {/* ─── 5. Bug-fix replay ─────────────────────────────── */}
        <section className="proof-card-section">
          <div className="container">
            <div className="proof-card">
              <div className="proof-card-header">
                <div className="proof-card-num">05</div>
                <div>
                  <h2>Bug-fix replay — fail before, pass after</h2>
                  <p className="proof-card-lede">
                    Pinned can learn from real fixes. When a fix adds or corrects
                    a guardable behavior, Pinned creates a regression guard and
                    replays it against the parent commit and the fixed commit.
                    <br />
                    <strong>Replay-verified means:</strong> parent commit fails
                    the guard; fixed commit passes.
                  </p>
                </div>
              </div>
              <div className="proof-replay-row">
                <div className="proof-replay-stat">
                  <div className="proof-replay-num">684</div>
                  <div className="proof-replay-text">fix-shaped commits analyzed</div>
                </div>
                <div className="proof-replay-stat">
                  <div className="proof-replay-num">186</div>
                  <div className="proof-replay-text">deterministic catches</div>
                </div>
                <div className="proof-replay-stat">
                  <div className="proof-replay-num">+46</div>
                  <div className="proof-replay-text">via BYOK Claude Code (~50% lift)</div>
                </div>
                <div className="proof-replay-stat">
                  <div className="proof-replay-num">9 / 11</div>
                  <div className="proof-replay-text">repos produced ≥1 catch</div>
                </div>
              </div>
              <p className="proof-card-note">
                <strong>Honest caveat.</strong> Bug-fix replay is one pin source,
                not the whole product. Pinned also creates guards from install
                scans, PR claims, live diffs, user-authored pins, and guard
                integrity rules. Some fixes are not guardable by static templates —
                UI state, visual rendering, business logic. Those need different
                tools.
              </p>
            </div>
          </div>
        </section>

        {/* ─── What this does NOT prove ──────────────────────── */}
        <section className="proof-card-section">
          <div className="container">
            <div className="proof-card proof-card-warn">
              <h2>What this does NOT prove</h2>
              <ul className="proof-not-list">
                <li>Pinned does not catch every bug.</li>
                <li>Pinned is not a generic code reviewer.</li>
                <li>Pinned is not a full SAST scanner.</li>
                <li>Pinned is not a visual regression tool.</li>
                <li>Some app-specific bugs require fixtures or runtime tests.</li>
                <li>
                  AI lessons guide agents but guards enforce the rules — an agent
                  can still ignore lessons; only the guards block its commits.
                </li>
              </ul>
              <p className="proof-card-note">
                <strong>Pinned is a safety layer for AI-coded repos, not a
                replacement for tests, review, or security scanning.</strong>
              </p>
            </div>
          </div>
        </section>

        {/* ─── Try it locally ────────────────────────────────── */}
        <section className="proof-cta">
          <div className="container">
            <h2>Try it on your repo in 30 seconds</h2>
            <p className="proof-cta-sub">No signup. No API key. Runs locally.</p>
            <div className="terminal-card terminal-card-cta">
              <div className="terminal-bar">
                <span className="dot-red" />
                <span className="dot-yellow" />
                <span className="dot-green" />
                <span className="terminal-title">your repo</span>
              </div>
              <pre className="terminal-body">{`$ npx pinnedai init --auto       # baseline guards + AI lessons
$ npx pinnedai status            # see active guards + recent events
$ npx pinnedai audit --learned   # check similar code paths`}</pre>
            </div>
            <div className="hero-cta-row" style={{ justifyContent: "center", marginTop: 24 }}>
              <a href="/#get-started" className="cta cta-primary">Try free beta</a>
              <a href="/" className="cta cta-secondary">← back to home</a>
            </div>
          </div>
        </section>
      </main>

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
