// SEO landing: pinnedai for Cursor users.
// Targets: developers searching "cursor", "cursor review", "cursor testing".

export function ForCursor() {
  return (
    <article className="seo-page">
      <header className="seo-hero">
        <h1>Pinnedai for Cursor</h1>
        <p className="seo-lede">
          Cursor accelerates your code-writing. Pinned makes sure the next
          Cursor session doesn't quietly break the contracts the previous one
          made. Every claim in your PR description becomes a permanent CI test.
        </p>
        <div className="seo-cta">
          <code>npx pinnedai init</code>
        </div>
      </header>

      <section className="seo-section">
        <h2>The Cursor compounding-error problem</h2>
        <p>
          Cursor is fast. But fast means more PRs, more refactors, more "AI
          said this works" diffs landing in main. Three months in, you've
          shipped 200 PRs. How many of those PR descriptions made claims that
          aren't actually tested anywhere?
        </p>
        <p>
          Pinned auto-pins those claims as you ship them. The PR description
          becomes a CI test that lives in your repo permanently. Next time
          Cursor refactors through the rate-limiter or auth middleware, the
          pinned test catches it before it merges.
        </p>
      </section>

      <section className="seo-section">
        <h2>Use Pinned alongside Cursor's built-in review</h2>
        <p>
          Cursor's review surfaces possible bugs at PR time. CodeRabbit /
          Copilot do the same. None of them leave a permanent artifact in
          your repo. Pinned does:
        </p>
        <ol className="seo-stack">
          <li>Cursor writes the code</li>
          <li>Cursor's review / CodeRabbit / Copilot catches obvious bugs</li>
          <li>
            <strong>Pinned converts the claims into Vitest files</strong> in
            <code> tests/pinned/</code>
          </li>
          <li>CI enforces them on every commit forever</li>
        </ol>
      </section>

      <section className="seo-section">
        <h2>The repair-prompt loop closes back into Cursor</h2>
        <p>
          When a pinned test fails six months from now (probably from a Cursor
          refactor), the error message includes a paste-ready prompt for
          Cursor's chat. The whole "Cursor broke it → Cursor fixes it" loop
          stays inside your editor.
        </p>
      </section>

      <section className="seo-cta-section">
        <h2>Try it in one minute</h2>
        <p>
          <code>npx pinnedai</code> shows the demo. <code>npx pinnedai init</code>{" "}
          scaffolds the workflow.{" "}
          <code>npx pinnedai baseline</code> finds promises in your existing
          code that should be pinned today.
        </p>
        <p>
          <a href="https://github.com/pinnedai/pinnedai">github.com/pinnedai/pinnedai</a>
        </p>
      </section>
    </article>
  );
}
