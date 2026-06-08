# Release discipline

## Two channels

| Channel | npm dist-tag | Pace | Audience |
|---|---|---|---|
| **Beta** | `@beta` | Ship as often as you want | Dogfood, design partners, people who chose risk |
| **Stable** | `@latest` | Cut deliberately, only when the gate is green | Strangers who run `npm i pinnedai` |

`@latest` is what `npm install` resolves by default. Treat it as a
promise: anything pointing at it has passed the failure-mode gate.

## The failure-mode gate

The wall between `@beta` and `@latest` is
`apps/cli/src/failureModes.gate.test.ts`. Every test in that file
asserts a specific user-trust contract that, if broken, would
false-fire on a healthy real app:

1. **Dynamic `[slug]` route** → does NOT auto-generate a literal-bracket page-renders pin
2. **Dead PREVIEW_URL** (ECONNREFUSED) → vitest reports SKIP, not FAIL
3. **307→/login** auth-gated route → SKIPs
4. **Real 500 / error-marker** → STILL FAILS (the real bug must still be caught)
5. **`init --auto`** on a moderate fixture → emits ≤10 pins, zero LOW-tier
6. **`uninstall --yes`** → preserves `.pinned/repo-stats.json`, `ai-lessons.md`, `lessons.json`
7. **`hook-failure`** on a clean pass → silent (no "Pinned caught a regression" prompt)
8. **`recordEditContext`** → writes `.pinned/last-edit-context.json` AND emits an observable stderr trace

If you find a new false-fire class in dogfood, **add it here**. The
file grows; tests never leave.

## Cutting a stable release

```bash
# 1. Confirm the gate is green
cd apps/cli
pnpm exec vitest run src/failureModes.gate.test.ts
# → 8 passed

# 2. Confirm full regression
pnpm test
# → 546 passed

# 3. Confirm dyad-apps sweep
/tmp/dyad-0.4-features.sh
# → PASS=42 FAIL=0

# 4. Drop the beta tag in package.json
#    "version": "0.5.0-beta.N"  →  "version": "0.5.0"

# 5. Update CHANGELOG with the FULL 0.5.0 entry summarizing every beta

# 6. Commit
git commit -m "0.5.0 stable — gate green, promoted to @latest"

# 7. Publish to npm WITHOUT --tag beta. This becomes @latest.
npm publish

# 8. Tag the release
git tag v0.5.0
git push --tags
```

## What blocks stable promotion

- **Any gate test red.** Fix the bug or remove the assertion (rare — usually means the contract changed deliberately).
- **Any regression in `pnpm test` (full suite).** All 546+ existing tests must stay green.
- **Any novel-FP regression in the dyad-apps sweep.** 42/42 must hold.
- **A recent beta has not soaked ≥48h** with no new dogfood-reported bugs.

## What does NOT block stable promotion

- New features sitting in `@beta` waiting for their own dogfood pass. Stable promotes the SAFE subset; the experimental stuff stays on `@beta` until it's ready independently.
- Documentation gaps (ship the code; docs ship continuously on `@latest`).

## What stays auto-installed on stable

These are the load-bearing defaults — the gate exists to ensure they don't false-fire:

- ✅ PostToolUse hook (the "Pinned catches AI mistakes in real time" headline)
- ✅ Pre-commit auto-protect
- ✅ Statusline
- ✅ HIGH-tier detectors auto-pin on `init --auto`
- ✅ AI-coder rules in CLAUDE.md

## What stays opt-in on stable

Genuinely heavyweight or intrusive:

- 🟡 Browser pin (`--browser`) — requires Playwright install
- 🟡 LOW-tier templates (page-renders / journey / happy-path) — `--include-low`
- 🟡 Hosted LLM endpoint — opt-in via OIDC context
- 🟡 Hosted analytics upload — `pinned analytics enable`
- 🟡 BYOK — `PINNEDAI_BYOK=...`

## Why this matters

Every recent version of pinnedai before 0.5.0 false-fires on a
healthy repo (phantom regressions, hook spam, 27-pin dumps,
etc.). That means every organic `npm install pinnedai` between
0.4.0 and 0.5.0-beta.9 was a bad first impression. The gate is
how we stop creating those impressions.

The deliberate framing per Cipherwake's review:

> "Don't promote to @latest until your own gate is green; reserve the
> 'beta' label itself for new opt-in features that fail safe. The
> thing that ends the instability isn't more labels — it's a wall
> between 'where I experiment' and 'what strangers install.'"

That's this file.
