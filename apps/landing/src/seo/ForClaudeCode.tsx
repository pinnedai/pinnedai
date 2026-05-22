// SEO landing: pinnedai for Claude Code users.
// Targets: developers searching "claude code", "claude code testing",
// "claude code review". Lands them on a Claude Code-specific value prop.

export function ForClaudeCode() {
  return (
    <article className="seo-page">
      <header className="seo-hero">
        <h1>Pinnedai for Claude Code</h1>
        <p className="seo-lede">
          Claude Code ships impressive PRs — but the claims it makes in those
          PR descriptions aren't tested unless you write the test yourself.
          Pinned converts every Claude-written PR claim into a permanent CI
          test. The next time Claude refactors through the same code, CI
          catches the regression.
        </p>
        <div className="seo-cta">
          <code>npx pinnedai init</code>
        </div>
      </header>

      <section className="seo-section">
        <h2>The Claude Code workflow gap</h2>
        <p>
          Claude Code is great at shipping working code. It's less great at
          remembering, six months later, the constraints it promised in a
          previous PR. The "rate-limit on /api/users" claim it made in PR #42
          doesn't show up in the codebase as a test — it's just text in a
          PR description that no one reads after merge.
        </p>
        <p>
          Pinned fixes this. When Claude opens a PR with "Rate-limits /api/users
          to 60 req/min", the pinnedai Action parses the claim, generates a
          Vitest file that bursts 61 parallel requests, and commits it to
          <code>tests/pinned/</code> in your repo. Forever.
        </p>
      </section>

      <section className="seo-section">
        <h2>The repair-prompt loop</h2>
        <p>
          When a pinned test fails, the error message includes a
          <strong> paste-ready prompt for Claude Code</strong>:
        </p>
        <pre className="seo-code-block">{`═══ PINNED FAILURE — paste this into Claude Code / Cursor ═══

Fix the failing pinned claim in this test file:
  Claim: Rate-limits /api/users to 60 req/min
  Original PR: pr-42
  Route: /api/users
  Expected: 61 parallel requests should yield at least one 429
  Actual: got statuses 200,200,200,...

Find where /api requests are rate-limited and restore enforcement.
Preserve all other behavior. Do not modify this pinned test file.

After fixing, re-run:  npx vitest run tests/pinned/pr-42-rate-limit-...test.ts
═══════════════════════════════════════════════════════════════`}</pre>
        <p>
          Workflow: pin fails → CI shows you the repair prompt → paste into Claude
          Code → Claude proposes the fix → commit → CI passes. The whole loop is
          self-contained.
        </p>
      </section>

      <section className="seo-section">
        <h2>What you can pin from a Claude Code PR</h2>
        <p>Eight templates across three domains:</p>
        <ul className="seo-templates">
          <li><strong>Web routes</strong>: rate-limit, auth-required, idempotent</li>
          <li><strong>CLI tools</strong>: output-contains, exits-zero, creates-file, flag-supported</li>
          <li><strong>Libraries</strong>: function-returns</li>
        </ul>
        <p>
          If Claude's PR claim doesn't fit one of these, it's not pinned (yet) —
          but the parser is open-source and adding a template is ~200 lines.
        </p>
      </section>

      <section className="seo-cta-section">
        <h2>Make Claude prove its claims</h2>
        <p>
          <code>npx pinnedai init</code> in your repo. Next PR with a claim,
          test files appear in <code>tests/pinned/</code>. No signup, no API
          key — Claude Code's PRs run in GitHub Actions, which already provides
          OIDC identity to pinnedai's hosted Worker.
        </p>
        <p>
          <a href="https://github.com/pinnedai/pinnedai">github.com/pinnedai/pinnedai</a>
        </p>
      </section>
    </article>
  );
}
