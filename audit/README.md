# Feature-audit suite

> Every audit must (1) name the specific observable signal the feature produces
> when healthy, (2) include a positive control known to produce the signal, and
> (3) include a negative control where the signal should be absent.
>
> No "the test passes" / "no error thrown" assertions.

Unit tests prove code paths execute. The audit suite proves **features work as advertised**. The negative control is the load-bearing part — it proves each audit catches real breakage, not just that "the code runs without throwing."

## How to run

```bash
pnpm audit:features          # all audits (~30-60s)
pnpm audit:features:templates   # only the 8 template audits
pnpm audit:features:cli         # only the 9 CLI command audits
pnpm audit:features:worker      # only the 5 Worker audits (via miniflare)
pnpm audit:features:sticky      # only the 4 sticky-feature audits
```

The CI release gate (`.github/workflows/release.yml`) refuses to publish if any audit is red.

## Layout

```
audit/
  README.md                  # this file
  vitest.config.ts           # separate config from unit tests + dogfood pins
  fixtures/                  # shared fixtures (HTTP server, CLI fixture, lib fixture)
    server.ts                # in-process HTTP server with configurable behavior
    cli-fixture.mjs          # configurable CLI binary for cli-* template audits
    lib-fixture.ts           # library module for library-returns audit
  features/                  # CLI command audits (9)
  templates/                 # template behavior audits (8)
  worker/                    # Worker endpoint audits via miniflare (5)
  sticky/                    # value-prop / sticky-feature audits (4)
```

## Anatomy of an audit file

Every audit file follows the same shape:

```ts
import { describe, it, expect } from "vitest";

// FEATURE: <name of the feature being audited>
// SIGNAL: <specific observable thing produced when feature is healthy>
// FALSIFIABILITY: <what kind of regression this audit would catch>

describe("FEATURE-AUDIT: <feature name>", () => {
  it("POSITIVE CONTROL: <signal description>", async () => {
    // Run the feature in a known-healthy scenario.
    // Assert the signal is observed.
  });

  it("NEGATIVE CONTROL: signal absent without the feature", async () => {
    // Run the same code path with the feature broken / disabled.
    // Assert the signal is NOT observed — and that the failure mode
    // is the documented one (not just "any other failure").
  });
});
```

The negative control proves the positive control isn't a tautology. If only the positive control is present, you can't tell whether the audit verifies the feature or just verifies that some code runs.

## When to add an audit

Any time you ship a feature claim — in README, landing page, or marketing — you owe a corresponding audit. The audit is what makes the claim falsifiable.

If you can't write a falsifiable signal for a feature, the marketing claim is too vague and should be sharpened before launch.

### Designing audits for new features

When adding a new feature, paste the feature description into the prompt at [GPT-AUDIT-PROMPT.md](./GPT-AUDIT-PROMPT.md) and let GPT design the audit shape (signal + positive + negative + falsifiability). The prompt is the same one used to review existing audits for gaps.

## Reading audit output

```
FEATURE-AUDIT: rate-limit template
  ✓ POSITIVE CONTROL: generated test PASSES against a rate-limited server
  ✓ NEGATIVE CONTROL: generated test FAILS against a non-rate-limited server
                       (with repair-prompt header present)
```

A green positive + green negative means the audit is functioning. A red positive means the feature is broken. A red negative means the audit is tautological (always passes) and needs strengthening.
