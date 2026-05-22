# GPT Review Brief — pinnedai v0.1 launch candidate

> **Bundle**: `bundle-1-cli-src-v17` + `bundle-2-cli-tests-v15`
> **Scope**: ~3,500 LOC of new + modified CLI code since the last GPT review (bundle v15/v13).
> **Status before this round**: 195 audits passing.
> **Status after this round**: 131 CLI audits + 56 sticky + 16 templates = 203 audits passing + e2e fake-project test with 7 scripted phases + 3 observational phases all green.

This brief lists what changed at the source-code level. Per `[[gpt-review-before-launch]]` memory rule: **zero CRITICAL or HIGH findings outstanding before npm publish**.

---

## 1. Diff-aware classifier (bundle-1, autoProtect.ts + cli.ts + scanDiff.ts)

**Previous behavior**: `auto-protect` only fired on ADDED files. New `program.command("foo")` lines added to an existing `cli.ts` were invisible to the classifier — pins never grew during normal AI-coding workflows.

**New behavior**:
- `ChangedFile.addedLines?: string` carries the unified-diff `+` lines for modified files
- `readChangedFilesFromGit(base)` runs one `git diff` per invocation, parses sections by `^diff --git a/<path> b/<path>`, populates `addedLines` per modified file
- Classifier scans ADDED files in full; scans MODIFIED files only on their added-lines content
- Existing dedupe (`alreadyPinned` set keyed by `claimKey`) still protects against double-pinning

**What I'd ask GPT to scrutinize**:
- Buffer cap on the diff (currently 64MB). Reasonable for normal repos; a 10K-file refactor diff could be larger.
- The regex that splits diff sections by `^diff --git a/`. Edge case: filenames containing newlines (rare, valid in git). My parser would break. Worth flagging?
- The `attributeOptionToCommand` only works on added files (we need surrounding `.command()` context to attribute) — not on modified files where we only see diff `+` lines. Documented as a known limitation.

## 2. Cache-strip bug (cli.ts — multiple writeLastStatus sites)

**Bug**: Every `writeLastStatus()` call wholesale-replaced the cache. Fields owned by other surfaces (`lastAutoProtectAt`, `lastAddNotifiedAt`, etc.) got silently wiped on every auto-protect / status / test run, which silently bypassed the chat-hook throttle.

**Fix**: Each `writeLastStatus(...)` caller now uses `...prev` spread to preserve every field, then overrides only the fields it owns. Pattern applied to four call sites:
- `pinned auto-protect` writer
- `stampPinAddedToCache` helper (used by `generate` + `protect`)
- `pinned test` writer
- `pinned status --refresh` writer

**What I'd ask GPT to scrutinize**:
- Any new field added to `LastStatus` must be considered for which writer owns it. The `...prev` pattern means orphan fields persist forever. If a field is meant to reset on a specific event (e.g. `failingCount` resets on a green test), the writer must override it.
- Race condition: two writers running concurrently (e.g. background auto-protect from chat hook + foreground `pinned test`) could both read the cache, both modify, both write — last write wins. No file lock. Documented in `apps/cli/src/cli.ts` chat-hook comment; could add a lockfile if it turns out to matter.

## 3. Chat-hook drift-aware kick (cli.ts — hook-failure command)

**New behavior**: `pinned hook-failure` (wired into Claude Code's `UserPromptSubmit` hook, fires on every chat turn) now does CHEAP work every turn (~5ms: read cache + capture git state + check throttle) and only fires background `auto-protect` when ALL THREE gates pass:
1. `auto_protect` mode is not `off`
2. ≥ `CHAT_HOOK_AUTO_PROTECT_TTL_MS` (60s) since last kick
3. Working-tree git state differs from cached `lastCheckedSha` / `lastCheckedDirtyHash`

If any gate fails, the hook just emits its text content (failure or add celebration) and exits. No background process spawned.

When a kick fires: `spawn(node, [cliPath, "auto-protect", "--quiet"], {detached: true, stdio: "ignore"})`. Child unrefed so parent returns immediately.

**What I'd ask GPT to scrutinize**:
- The drift logic handles "neither cache leg present" as a first-time fire (treated as drifted). Is that right? My audit covers it.
- `spawn(process.execPath, [process.argv[1], ...])` — argv[1] is the dist/cli.js bundle path. Confirmed to work locally and in the fake-project e2e. Edge case: if the script is symlinked / aliased, argv[1] might be wrong.
- Detached background process: if pinned crashes mid-run, we have an orphan. No supervisor. Acceptable for v0.1 (no LLM cost, no destructive ops); flag if you disagree.

## 4. Post-commit auto-verify hook (gitHooks.ts)

**New**: third hook type added to `gitHooks.ts`. Fires `pinned test` in the background after every commit, throttled to ≥120s between runs via `.pinnedai/.last-auto-test` timestamp file. This is the "make pins actually catch things" hook — without it, customers who don't wire CI manually would have decoration-only pins.

Hook script: marker-bounded for idempotent install. Same fallback CLI resolution chain as pre-commit / pre-push (apps/cli/dist/cli.js → node_modules/pinnedai/dist/cli.js → `pinned` on PATH → `npx --no-install pinnedai`).

**What I'd ask GPT to scrutinize**:
- Is 120s the right throttle? Too short = CPU thrash on rapid commits. Too long = late catches.
- The hook does `nohup $PINNED_BIN test --quiet >/dev/null 2>&1 &` — does this work cleanly on Windows (Git Bash)? macOS / Linux verified.
- If the throttle file (`.pinnedai/.last-auto-test`) ends up in `.gitignore` for some reason and gets reset on each clone, throttling is broken. Should we recommend adding it to `.gitignore`?

## 5. Vitest as optional peer + init detection (vitestSetup.ts + init wiring + package.json)

**New**: `vitest` is now declared as optional peer dependency in `apps/cli/package.json`. `pinned init` detects whether the customer's `package.json` has vitest (in deps/devDeps/peerDeps) and:
- Already present → log "Detected vitest" and continue
- Missing + auto mode → loudly explain, run `npm install --save-dev vitest@^2` (or pnpm/yarn/bun based on lockfile detection)
- Missing + manual mode → prompt with full what/why/touches/[Y/S/N]
- Missing + non-TTY → print a warning ("Run X to enable verification")

`pinned test` also distinguishes "vitest could not be invoked" (no FAIL or "Test Files" markers in output + exit != 0) from "real test failure." Setup failures leave the cache untouched — don't reset the verification streak.

**What I'd ask GPT to scrutinize**:
- Auto-mode installs vitest silently (no prompt). Is that too invasive? My take: customer explicitly opted into "auto mode = enable everything," so yes it's fine. Worth flagging if you disagree.
- Package manager detection: presence of lockfile (pnpm-lock.yaml > yarn.lock > bun.lockb > default npm). What if the customer has multiple lockfiles (project transitioned between managers)? We pick the first hit; could be wrong.
- `installCommand` returns shell args. We `spawnSync` them with no shell. The version `^2` is fixed in the CLI source. When vitest@3 ships, this becomes stale.

## 6. Verified-streak as primary positive metric (statusline.ts + cli.ts)

**Reframe**: catches will be rare (the product catches *outright contract violations*, not subtle bugs). To prevent the "0 catches looks broken" feeling, we added `verifiedStreak` + `checksRun` + `lastVerifiedAt` to `LastStatus`. `pinned test` increments them on each green run; resets streak to 0 on failure.

`pinned status` now leads with:
```
Protected behaviors:
  ✓ N active, all passing
  +X this week · +Y this month

Verification:
  ✓ N consecutive successful runs · M total · last: 2m ago
```

Catches are no longer a headline metric — only shown when `breaksCaught > 0` in a separate "Recent catches" subsection.

**What I'd ask GPT to scrutinize**:
- Is the streak meaningful when most runs are skipped tests (missing PREVIEW_URL)? My take: yes, "I ran tests and nothing failed" is still a positive signal. Open to disagreement.
- We don't track the *date* the streak started. So a long streak doesn't tell you "since X." Worth adding `streakStartedAt`?

## 7. Postinstall notice + bare-npx init prompt (scripts/postinstall.cjs + cli.ts try command)

**New discoverability path**:
- `scripts/postinstall.cjs` — runs after `npm install pinnedai`, prints a one-time notice ("Run `npx pinnedai init` to set up..."). Skips noise in CI / `npm ci` / `--global`.
- `pinned try` (the default bare-npx command) checks for `.pinnedai/config.json` and shows a discoverability nudge if missing, normal "Next:" hints if present.

**What I'd ask GPT to scrutinize**:
- Postinstall scripts are widely considered an anti-pattern. Ours is read-only (just prints). But security-conscious orgs run with `ignore-scripts: true` — they'd never see the notice. Acceptable per my design.
- The bare-npx prompt is just a text nudge — no interactive prompt to actually run init from `pinned try`. Is that the right line? My take: yes, init is invasive (writes files, hooks), so we shouldn't run it without an explicit invocation.

## 8. Title / Promise / Check structure (claimParser.ts → describeClaimForUser + many surfaces)

**Reframe of every user-facing pin description**:
- `Title` — short noun phrase naming the protected behavior ("/api/admin/export is not publicly accessible")
- `Promise` — sentence stating what the user can rely on ("Unauthenticated requests to /api/admin/export are rejected.")
- `Check` — sentence describing what the test mechanically does ("Sends a request with no Authorization header; expects 401 or 403.")

Surfaces using this: `pinned list` (default = title-only; --verbose = full), `pinned show` (all three), `pinned try`, `pinned status` (failing list shows titles, not cryptic ids), `pinned catches`, PR comment templates.

**What I'd ask GPT to scrutinize**:
- For CLI templates (cli-output-contains, cli-exits-zero, etc.), Title and Promise are nearly the same restatement. Acceptable — we keep the same shape across all templates for predictability.
- `shortCommandLabel()` strips `node ./path/cli.js` and `npx <pkg>` prefixes from CLI command labels. Edge case: command containing a path that *looks* like our prefix pattern. Should be rare; flag if it matters.

## 9. Returns-status template + role-phrasing parser extension (claimParser.ts + templates/returnsStatus.ts)

**New**: 9th template `returns-status` — sends a request with empty / minimally-invalid body, asserts a specific status code. Parser handles `"POST /X returns 400 on missing email"`, `"returns 422 on invalid email"`, `"returns 400 on empty body"`, bare `"returns 400"`.

**Parser extension**: `auth-required` now also matches `"/X requires admin role"` / `"/X is admin-only"` phrasings, mapped to the existing template. Honest disclosure in docs: this protects "not publicly accessible," not full role-fixture testing.

**What I'd ask GPT to scrutinize**:
- The generated returns-status test sends `JSON.stringify({})` for "missing" / "empty" conditions, `{[field]: "INVALID_FOR_PINNED_TEST"}` for "invalid". Is that the right minimal-counter-example shape?
- The role-phrasing extension shares `claimKey` with auth-required — meaning "/X requires admin" and "auth required on /X" dedupe to the same pin. Correct, since the test is identical. Worth flagging if you'd prefer separate semantics.

## 10. Trimmed status display + PREVIEW_URL skipIf in web templates

**Trimmed status**: `Unpinned risks: ✓ none` and `Safety Pass: ✓ no warnings` lines no longer appear in `pinned status` when those sections are clean. Only shown when there's something actionable or unscanned-yet.

**SkipIf in templates**: web templates (rate-limit, auth-required, idempotent, returns-status) use `it.skipIf(previewMissing && !forceRequire)` so background test runs without PREVIEW_URL silently skip rather than throw. Manual runs can force-fail via `PINNED_REQUIRE_PREVIEW_URL=1`.

**What I'd ask GPT to scrutinize**:
- Skipped tests still count as "green" toward the streak. Is that right? My take: yes, "I tried to verify and nothing failed" is positive. A pedantic reading would say "couldn't verify" should be neutral, not green.
- The `forceRequire` env var is new public surface. Documented in template comments but not in README yet.

---

## Specific files changed (for quick navigation)

| File | What changed |
|---|---|
| `apps/cli/src/autoProtect.ts` | Diff-aware classifier — scans `f.addedLines` on modified files |
| `apps/cli/src/cli.ts` | Major: init flow, test command, status display, hook-failure kick, try discoverability, vitest install offer |
| `apps/cli/src/claimParser.ts` | `describeClaimForUser` returning `{title, promise, check}`. `shortCommandLabel`. `returns-status` claim type + parser. Role-phrasing extension to auth-required parser. |
| `apps/cli/src/scanDiff.ts` | `ChangedFile.addedLines` field. Wording: "risk surfaces" → "code paths without protection" |
| `apps/cli/src/statusline.ts` | New fields: `verifiedStreak`, `checksRun`, `lastVerifiedAt`, `lastAutoProtectAt`, `lastAddNotifiedAt`. Drift-aware logic exposed via captureGitState. `formatChatHook` separated from `formatFailureHook`. |
| `apps/cli/src/gitHooks.ts` | Third hook type `post-commit`. CLI resolution adds `npx --no-install pinnedai` fallback. |
| `apps/cli/src/templates/{authRequired,rateLimit,idempotent,returnsStatus}.ts` | `it.skipIf` pattern for missing PREVIEW_URL |
| `apps/cli/src/templates/returnsStatus.ts` | NEW — 9th template |
| `apps/cli/src/vitestSetup.ts` | NEW — vitest detection + package-manager-aware install |
| `apps/cli/src/config.ts` | `show_pending_changes` defaults to `false` |
| `apps/cli/src/prComment.ts` | Lead with bold Title + Promise line; pin id + claim in `<sub>` |
| `apps/cli/src/registry.ts` | `...prev` preservation pattern propagated where it writes status |
| `apps/cli/scripts/postinstall.cjs` | NEW — postinstall discoverability notice |
| `audit/features/30-36-*.audit.ts` | 7 new audit files covering auto-protect, init-auto, statusline states, chat-hook celebration, diff-aware classifier, kick gating, README drift |
| `audit/e2e/fake-project-dogfood.sh` | NEW — 10-phase end-to-end scenario test |

## Severity guidance for the review

- **CRITICAL**: security holes, data loss, code-execution, broken auth.
- **HIGH**: incorrect behavior in a primary flow, install-time crash, broken main workflow.
- **MEDIUM**: confusing UX, broken edge case, missing audit, doc gap.
- **LOW**: polish, minor copy, nice-to-have.

Per `[[gpt-review-before-launch]]` memory rule: **all CRITICAL and HIGH findings must be fixed before `npm publish`**. MEDIUM/LOW can be deferred to v0.1.1.
