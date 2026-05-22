import { useMemo, useState } from "react";
import { parseClaims, generateTest, claimSlug, type Claim } from "pinnedai";

const SAMPLE_BODY = `## What this PR does

Web routes:
- Rate-limits /api/users to 60 req/min to stop the scraping abuse from last week.
- Auth required on /api/admin/export.
- Makes /webhooks/stripe idempotent on event_id.

CLI tooling:
- \`pinned doctor\` outputs \`tests/pinned/ directory\`.
- \`pinned init\` creates \`tests/pinned/.registry.json\`.

Library:
- \`parseConfig()\` in \`src/config.ts\` returns \`{"version": 1}\`.

## Risk

Low — every claim is verifiable.
`;

export function Demo() {
  const [body, setBody] = useState(SAMPLE_BODY);
  const [regressionMode, setRegressionMode] = useState(false);

  const claims = useMemo(() => parseClaims(body), [body]);
  const firstClaim = claims[0] as Claim | undefined;
  const generated = useMemo(() => {
    if (!firstClaim) return null;
    return generateTest(firstClaim, { prId: "pr-1247" });
  }, [firstClaim]);

  return (
    <div className="demo">
      <div className="demo-grid">
        <div className="demo-col">
          <label className="demo-label" htmlFor="pr-body">
            PR description
            <span className="demo-tag">edit me</span>
          </label>
          <textarea
            id="pr-body"
            className="demo-textarea"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            spellCheck={false}
          />
          <div className="demo-claims">
            <div className="demo-claims-label">
              Parsed claims ({claims.length})
            </div>
            {claims.length === 0 ? (
              <div className="demo-empty">
                No claims matched. Try a line like{" "}
                <code>"Rate-limits /api/users to 60 req/min."</code> or{" "}
                <code>"Auth required on /api/admin/export."</code>
              </div>
            ) : (
              <ul className="demo-claim-list">
                {claims.map((c, i) => (
                  <li key={i}>
                    <ClaimChip claim={c} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="demo-col">
          <div className="demo-label">
            Generated Vitest file
            {generated ? (
              <span className="demo-tag demo-tag-out">
                tests/pinned/{generated.filename}
              </span>
            ) : null}
          </div>
          <pre className="demo-code">
            {generated ? generated.content : "// (no claim parsed yet — try one of the examples on the left)"}
          </pre>
          <div className="demo-actions">
            <button
              type="button"
              className={
                "demo-btn " + (regressionMode ? "demo-btn-danger" : "")
              }
              onClick={() => setRegressionMode((v) => !v)}
              disabled={!generated}
            >
              {regressionMode
                ? "Show the pinned test"
                : "Simulate a regression 6 months later"}
            </button>
          </div>
          {regressionMode && generated && firstClaim ? (
            <pre className="demo-failure">
              {failureBlock(firstClaim, generated.filename)}
            </pre>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ClaimChip({ claim }: { claim: Claim }) {
  switch (claim.template) {
    case "rate-limit":
      return (
        <span className="chip">
          <span className="chip-tag">rate-limit</span>
          <span className="chip-route">{claim.route}</span>
          <span className="chip-meta">
            {claim.rate}/{claim.window}
          </span>
        </span>
      );
    case "auth-required":
      return (
        <span className="chip">
          <span className="chip-tag">auth-required</span>
          <span className="chip-route">{claim.route}</span>
          <span className="chip-meta">401/403 without auth</span>
        </span>
      );
    case "permission-required":
      return (
        <span className="chip">
          <span className="chip-tag">permission</span>
          <span className="chip-route">{claim.route}</span>
          <span className="chip-meta">{claim.role}-role only</span>
        </span>
      );
    case "tier-cap":
      return (
        <span className="chip">
          <span className="chip-tag">tier-cap</span>
          <span className="chip-route">{claim.route}</span>
          <span className="chip-meta">{claim.tier}: ≤ {claim.cap} {claim.resource}</span>
        </span>
      );
    case "idempotent":
      return (
        <span className="chip">
          <span className="chip-tag">idempotent</span>
          <span className="chip-route">{claim.route}</span>
          <span className="chip-meta">key: {claim.idField}</span>
        </span>
      );
    case "returns-status":
      return (
        <span className="chip">
          <span className="chip-tag">returns-status</span>
          <span className="chip-route">{claim.method} {claim.route}</span>
          <span className="chip-meta">
            → {claim.status}
            {claim.condition ? ` on ${claim.condition}` : ""}
          </span>
        </span>
      );
    case "cli-output-contains":
      return (
        <span className="chip">
          <span className="chip-tag">cli-output</span>
          <span className="chip-route">{claim.route}</span>
          <span className="chip-meta">stdout ⊇ "{claim.text}"</span>
        </span>
      );
    case "cli-exits-zero":
      return (
        <span className="chip">
          <span className="chip-tag">cli-exits</span>
          <span className="chip-route">{claim.route}</span>
          <span className="chip-meta">exits 0</span>
        </span>
      );
    case "cli-creates-file":
      return (
        <span className="chip">
          <span className="chip-tag">cli-creates</span>
          <span className="chip-route">{claim.route}</span>
          <span className="chip-meta">creates {claim.filePath}</span>
        </span>
      );
    case "cli-flag-supported":
      return (
        <span className="chip">
          <span className="chip-tag">cli-flag</span>
          <span className="chip-route">{claim.route}</span>
          <span className="chip-meta">supports {claim.flag}</span>
        </span>
      );
    case "library-returns":
      return (
        <span className="chip">
          <span className="chip-tag">library</span>
          <span className="chip-route">{claim.functionName}</span>
          <span className="chip-meta">in {claim.modulePath}</span>
        </span>
      );
  }
}

function failureBlock(claim: Claim, filename: string): string {
  const slug = claimSlug(claim);
  const retire = `pinned retire pr-1247-${slug} --reason="..."`;
  const head = `FAIL  tests/pinned/${filename}`;
  const back = `> This commit breaks a claim pinned in pr-1247.
  > Original claim: "${claim.raw}"
  > Retire with: ${retire}`;

  switch (claim.template) {
    case "rate-limit":
      return `${head} > pinned: rate-limit on ${claim.route} (${claim.rate}/${claim.window})
  AssertionError: expected at least one 429 across ${claim.rate + 1} parallel requests, got: 200,200,200,200,200,...

  ${back}
`;
    case "auth-required":
      return `${head} > pinned: auth-required on ${claim.route}
  AssertionError: expected 401 or 403 with no auth header, got 200

  ${back}
`;
    case "permission-required":
      return `${head} > pinned: permission-required ${claim.role} on ${claim.route}
  AssertionError: wrong-role token got through with 200 — role check stripped
    direction: wrong-role
    expected:  403
    actual:    returned 200 (the route accepted a non-${claim.role} user)

  ${back}
`;
    case "tier-cap":
      return `${head} > pinned: tier-cap ${claim.tier} ≤ ${claim.cap} ${claim.resource} on ${claim.route}
  AssertionError: ${claim.tier}-user AT the cap got 2xx — billing tier enforcement removed
    direction: at-cap
    expected:  4xx (402/403/429) for ${claim.tier}-user at ${claim.cap}-${claim.resource} cap
    actual:    returned 200 (REVENUE LEAK — ${claim.tier} users can exceed the cap)

  ${back}
`;
    case "idempotent":
      return `${head} > pinned: idempotent on ${claim.route} (key: ${claim.idField})
  AssertionError: expected byte-identical body on retry — got differing responses
    - first:  {"id":"evt_abc","status":"created"}
    - second: {"id":"evt_def","status":"created"}

  ${back}
`;
    case "returns-status":
      return `${head} > pinned: returns-status ${claim.method} ${claim.route} → ${claim.status}${claim.condition ? ` on ${claim.condition}` : ""}
  AssertionError: expected ${claim.status}${claim.condition ? ` on ${claim.condition}` : ""}, got 200

  ${back}
`;
    case "cli-output-contains":
      return `${head} > pinned: cli-output-contains \`${claim.route}\`
  AssertionError: expected stdout to contain "${claim.text}"
    actual stdout was empty (command refactored without preserving output)

  ${back}
`;
    case "cli-exits-zero":
      return `${head} > pinned: cli-exits-zero \`${claim.route}\`
  AssertionError: expected exit code 0, got 1

  ${back}
`;
    case "cli-creates-file":
      return `${head} > pinned: cli-creates-file \`${claim.route}\` -> ${claim.filePath}
  AssertionError: expected file ${claim.filePath} to exist after running command — file not created

  ${back}
`;
    case "cli-flag-supported":
      return `${head} > pinned: cli-flag-supported \`${claim.route}\` ${claim.flag}
  AssertionError: expected --help output to mention "${claim.flag}" — flag removed from CLI

  ${back}
`;
    case "library-returns":
      return `${head} > pinned: library-returns ${claim.functionName} in ${claim.modulePath}
  AssertionError: expected ${JSON.stringify(claim.expected)} — got something different

  ${back}
`;
  }
}
