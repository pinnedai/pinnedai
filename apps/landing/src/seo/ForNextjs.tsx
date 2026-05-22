// SEO landing: pinnedai for Next.js apps.
// Targets: developers searching "next.js testing", "next.js route protection",
// "next.js auth regression". Lands them on a Next.js-specific value prop.

export function ForNextjs() {
  return (
    <article className="seo-page">
      <header className="seo-hero">
        <h1>Pinnedai for Next.js</h1>
        <p className="seo-lede">
          Lock down App Router routes, middleware auth, and webhook idempotency
          with permanent CI tests. Pinned reads your PR descriptions, generates
          Vitest files in <code>tests/pinned/</code>, and CI enforces them on
          every commit forever.
        </p>
        <div className="seo-cta">
          <code>npx pinnedai init</code>
        </div>
      </header>

      <section className="seo-section">
        <h2>Why Next.js apps need Pinned</h2>
        <p>
          App Router refactors are the #1 source of silent regressions we see.
          A "small" middleware reorganization moves the auth check past a route
          handler. A new <code>route.ts</code> file copies an old pattern but
          forgets the rate-limiter. Three months later a customer is asking
          why <code>/api/admin/export</code> returned data without a token.
        </p>
        <p>
          Pinned converts the claim "auth required on /api/admin/export" in
          your PR description into a permanent test. The next time a refactor
          accidentally drops the check, CI fails on the very PR that broke it.
        </p>
      </section>

      <section className="seo-section">
        <h2>Templates that fit Next.js patterns</h2>
        <ul className="seo-templates">
          <li>
            <strong>auth-required</strong> — "Auth required on /api/admin/export."
            <br />
            <em>Generated test:</em> single GET without <code>Authorization</code> header,
            asserts 401 or 403. Catches middleware-bypass regressions in App Router and
            Pages Router both.
          </li>
          <li>
            <strong>rate-limit</strong> — "Rate-limits /api/users to 60 req/min."
            <br />
            <em>Generated test:</em> bursts 61 parallel requests, asserts ≥1 returns 429.
            Works with <code>@upstash/ratelimit</code>, Redis-backed limiters,
            or middleware-based throttling.
          </li>
          <li>
            <strong>idempotent</strong> — "Makes /webhooks/stripe idempotent on event_id."
            <br />
            <em>Generated test:</em> POSTs the same payload twice, asserts byte-identical response.
            Catches the common "I refactored the dedup layer and broke webhook retries" bug.
          </li>
        </ul>
      </section>

      <section className="seo-section">
        <h2>Get value in 60 seconds with <code>baseline</code></h2>
        <p>
          <code>npx pinnedai baseline</code> walks your Next.js repo, detects every
          App Router route (<code>app/api/**/route.ts</code>) and Pages Router route
          (<code>pages/api/**</code>), cross-references your existing tests, and
          suggests pins for whatever's unprotected. A typical mid-size Next.js app
          gets 8-12 candidate pins on the first run.
        </p>
      </section>

      <section className="seo-section">
        <h2>How it fits into your existing stack</h2>
        <p>
          Pinned doesn't replace anything you're already using. It's the missing
          layer between code-review bots and CI tests:
        </p>
        <ol className="seo-stack">
          <li>Cursor / Claude Code writes the route</li>
          <li>CodeRabbit / Copilot reviews the PR</li>
          <li>
            <strong>Pinned converts the claim ("rate-limited", "auth required",
            "idempotent") into a Vitest file in your repo</strong>
          </li>
          <li>Your Next.js CI runs the test on every commit forever</li>
        </ol>
      </section>

      <section className="seo-cta-section">
        <h2>Ready to try it?</h2>
        <p>
          <code>npx pinnedai init</code> scaffolds the GitHub Action.
          Open a PR with a claim in the description. The Action does the rest.
        </p>
        <p>
          <a href="https://github.com/pinnedai/pinnedai">github.com/pinnedai/pinnedai</a>
        </p>
      </section>
    </article>
  );
}
