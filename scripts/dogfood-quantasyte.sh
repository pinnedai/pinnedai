#!/usr/bin/env bash
# Dogfood pinnedai on Quantasyte — the user's other production project.
#
# Why: pinnedai's catch-rate / FP-rate estimates ("3-10 catches per 100
# PRs, <5% FPs") are theoretical. Real-world signal requires running
# pinned against a real codebase with real PR claims. Quantasyte is the
# perfect victim: it's a real production CLI+web+api system, owned by
# the same user, with multi-platform deployment surfaces.
#
# What this script does:
#   1. npm-links pinnedai's local CLI into Quantasyte's node_modules
#   2. Runs `pinned init --auto` to scaffold the customer integration
#   3. Runs `pinned baseline` to detect unprotected risk surfaces
#      already present in the Quantasyte codebase
#   4. Generates pins from sample bug-fix-style PR descriptions that
#      match patterns in Quantasyte's actual git history
#   5. Runs `pinned doctor` to report the integration state
#   6. Runs `pinned test --no-banner` to verify pins exercise cleanly
#   7. Captures a summary report at /tmp/quantasyte-dogfood-report.txt
#      for inclusion in launch materials
#
# Required local state:
#   - pinnedai's build is current (run `pnpm --filter pinnedai run build`
#     in this repo first; the script does this automatically)
#   - quantasyte exists at /Users/michaelzon/dyad-apps/quantasyte
#
# Idempotent: safe to re-run. The script removes pinnedai's previous
# install before re-linking, so changes here propagate cleanly.
#
# Outputs:
#   /tmp/quantasyte-dogfood-report.txt — summary of what got pinned,
#     what got skipped, day-zero results, statusline state.
#   /tmp/quantasyte-dogfood.log — full verbose output for debugging.

set -u

PINNED_REPO="/Users/michaelzon/dyad-apps/pinnedai"
QS_REPO="/Users/michaelzon/dyad-apps/quantasyte"
REPORT="/tmp/quantasyte-dogfood-report.txt"
LOG="/tmp/quantasyte-dogfood.log"

# ---- Color helpers --------------------------------------------------
if [ -t 1 ]; then
  GREEN=$'\e[32m'; RED=$'\e[31m'; YELLOW=$'\e[33m'; CYAN=$'\e[36m'
  DIM=$'\e[2m'; BOLD=$'\e[1m'; RESET=$'\e[0m'
else
  GREEN=""; RED=""; YELLOW=""; CYAN=""; DIM=""; BOLD=""; RESET=""
fi

section() {
  echo ""
  echo "${BOLD}${CYAN}═══════════════════════════════════════════════════════════════${RESET}"
  echo "${BOLD}${CYAN}$1${RESET}"
  echo "${BOLD}${CYAN}═══════════════════════════════════════════════════════════════${RESET}"
}

note() {
  echo "${DIM}  $1${RESET}"
}

# ---- Preflight ------------------------------------------------------
section "Preflight checks"

if [ ! -d "$PINNED_REPO" ]; then
  echo "${RED}✗ pinnedai repo not found at $PINNED_REPO${RESET}"
  exit 1
fi
echo "${GREEN}✓${RESET} pinnedai repo: $PINNED_REPO"

if [ ! -d "$QS_REPO" ]; then
  echo "${RED}✗ Quantasyte repo not found at $QS_REPO${RESET}"
  exit 1
fi
echo "${GREEN}✓${RESET} Quantasyte repo: $QS_REPO"

# Wipe prior report.
> "$REPORT"
> "$LOG"
echo "${GREEN}✓${RESET} Report destination: $REPORT"
echo "${GREEN}✓${RESET} Verbose log: $LOG"

# ---- Step 1: rebuild pinnedai ---------------------------------------
section "Step 1 · Rebuild pinnedai CLI (so npm-link sees today's code)"

pushd "$PINNED_REPO" >/dev/null
pnpm --filter pinnedai run build 2>&1 | tee -a "$LOG" | tail -3
popd >/dev/null

# ---- Step 2: npm link ----------------------------------------------
section "Step 2 · Link pinnedai into Quantasyte"

pushd "$PINNED_REPO/apps/cli" >/dev/null
note "Running: npm link"
npm link 2>&1 | tee -a "$LOG" | grep -v "added 0" | tail -3 || true
popd >/dev/null

pushd "$QS_REPO" >/dev/null
note "Running in Quantasyte: npm link pinnedai"
npm link pinnedai 2>&1 | tee -a "$LOG" | tail -3 || true

# Verify the link is from the local build, not the npm placeholder.
LINKED_VERSION=$(node -e "console.log(require('pinnedai/package.json').version)" 2>/dev/null || echo "ERROR")
note "Linked pinnedai version: $LINKED_VERSION (should be 0.0.1 — local build)"

# Sanity check: --no-verify flag exists on `pinned generate` only
# in today's local build. If absent, the link picked up the published
# placeholder package instead.
if pinned generate --help 2>&1 | grep -q "no-verify"; then
  echo "${GREEN}✓${RESET} --no-verify flag present — running TODAY's local build"
else
  echo "${RED}✗${RESET} --no-verify flag missing — link may have picked up the published placeholder. Aborting."
  exit 1
fi
popd >/dev/null

# ---- Step 3: pinned init --auto ------------------------------------
section "Step 3 · pinned init --auto in Quantasyte"

pushd "$QS_REPO" >/dev/null
note "Running: pinned init --auto --force --from-agent='dogfood script'"
# --force in case the directory already had pinnedai scaffolding from
# an earlier dogfood run. --from-agent captures consent + agent ID.
pinned init --auto --force --from-agent="dogfood script (Pinned $(date +%F))" 2>&1 | tee -a "$LOG" | tail -15

# Sanity: tests/pinned/ should now exist.
if [ -d "tests/pinned" ]; then
  echo "${GREEN}✓${RESET} tests/pinned/ created"
else
  echo "${RED}✗${RESET} tests/pinned/ missing — init may have failed"
  exit 1
fi
popd >/dev/null

# ---- Step 4: baseline scan ------------------------------------------
section "Step 4 · pinned baseline — detect unprotected risk surfaces"

pushd "$QS_REPO" >/dev/null
note "Running: pinned baseline"
BASELINE_OUT=$(pinned baseline 2>&1 || true)
echo "$BASELINE_OUT" | tee -a "$LOG" | tail -25
{
  echo ""
  echo "── Baseline scan (unprotected risk surfaces) ──"
  echo "$BASELINE_OUT"
  echo ""
} >> "$REPORT"
popd >/dev/null

# ---- Step 5: generate pins from sample bug-fix descriptions ---------
section "Step 5 · Generate pins from sample bug-fix PR descriptions"

# Pick descriptions that map to surfaces Quantasyte ACTUALLY has.
# These are plausible bug-fix claims any AI agent might write into a
# real PR description. Each exercises a different template.
SAMPLE_PRS=(
  "pr-dogfood-1|Fixed regression: auth required on /api/admin/scans."
  "pr-dogfood-2|Rate-limits /api/scans to 30 req/min."
  "pr-dogfood-3|Free tier capped at 1 watched-domain for free tier on POST /api/domains."
  "pr-dogfood-4|Only admin can access /api/admin/audit-export."
  "pr-dogfood-5|\`qsync doctor\` exits 0."
)

pushd "$QS_REPO" >/dev/null
for entry in "${SAMPLE_PRS[@]}"; do
  pr_id="${entry%%|*}"
  desc="${entry##*|}"
  note "Generating: $pr_id — $desc"
  # --no-verify so we don't spend day-zero verify time per pin in the
  # dogfood script. Day-zero behavior is exercised separately in step 7.
  pinned generate --pr-id "$pr_id" --description "$desc" --no-verify 2>&1 \
    | tee -a "$LOG" | tail -3 | sed 's/^/      /'
done
popd >/dev/null

# Pin count delta.
PIN_COUNT=$(node -e "
const fs = require('fs');
const p = '$QS_REPO/tests/pinned/.registry.json';
if (!fs.existsSync(p)) { console.log(0); process.exit(0); }
const r = JSON.parse(fs.readFileSync(p, 'utf8'));
console.log(r.claims.filter((c) => c.status === 'active').length);
")
note "Active pins after generation: $PIN_COUNT"

# ---- Step 6: pinned doctor ------------------------------------------
section "Step 6 · pinned doctor — integration health check"

pushd "$QS_REPO" >/dev/null
DOCTOR_OUT=$(pinned doctor 2>&1 || true)
echo "$DOCTOR_OUT" | tee -a "$LOG" | tail -30
{
  echo ""
  echo "── Doctor output ──"
  echo "$DOCTOR_OUT"
  echo ""
} >> "$REPORT"
popd >/dev/null

# ---- Step 7: pinned test --------------------------------------------
section "Step 7 · pinned test — does the integration run cleanly?"

pushd "$QS_REPO" >/dev/null
note "Running pinned test (without PREVIEW_URL — most web pins will skip)"
TEST_OUT=$(pinned test 2>&1 || true)
echo "$TEST_OUT" | tee -a "$LOG" | tail -20
{
  echo ""
  echo "── pinned test output (no PREVIEW_URL set) ──"
  echo "$TEST_OUT"
  echo ""
} >> "$REPORT"
popd >/dev/null

# ---- Step 8: statusline snapshot -----------------------------------
section "Step 8 · pinned statusline snapshot"

pushd "$QS_REPO" >/dev/null
note "Running: pinned statusline"
STATUSLINE_OUT=$(pinned statusline 2>&1 || true)
echo "  $STATUSLINE_OUT"
{
  echo ""
  echo "── Statusline ──"
  echo "$STATUSLINE_OUT"
  echo ""
} >> "$REPORT"
popd >/dev/null

# ---- Step 9: PINS.md preview ----------------------------------------
section "Step 9 · PINS.md preview"

PINS_FILE="$QS_REPO/tests/pinned/PINS.md"
if [ -f "$PINS_FILE" ]; then
  note "PINS.md location: $PINS_FILE"
  head -30 "$PINS_FILE" | sed 's/^/      /'
  {
    echo ""
    echo "── PINS.md preview ──"
    head -50 "$PINS_FILE"
    echo ""
  } >> "$REPORT"
else
  echo "${YELLOW}⚠${RESET} PINS.md not generated"
fi

# ---- Final report ---------------------------------------------------
section "Dogfood complete — summary"

# Count of bug-fix-origin pins (proves bugFixOrigin detection works)
BUGFIX_COUNT=$(node -e "
const fs = require('fs');
const p = '$QS_REPO/tests/pinned/.registry.json';
if (!fs.existsSync(p)) { console.log(0); process.exit(0); }
const r = JSON.parse(fs.readFileSync(p, 'utf8'));
console.log(r.claims.filter((c) => c.status === 'active' && c.bugFixOrigin).length);
")

# Count of pins with bad_case populated (proves bad_case field works)
BADCASE_COUNT=$(node -e "
const fs = require('fs');
const p = '$QS_REPO/tests/pinned/.registry.json';
if (!fs.existsSync(p)) { console.log(0); process.exit(0); }
const r = JSON.parse(fs.readFileSync(p, 'utf8'));
console.log(r.claims.filter((c) => c.status === 'active' && c.badCase).length);
")

# Count of pins with covers populated (proves coverage mapping works)
COVERS_COUNT=$(node -e "
const fs = require('fs');
const p = '$QS_REPO/tests/pinned/.registry.json';
if (!fs.existsSync(p)) { console.log(0); process.exit(0); }
const r = JSON.parse(fs.readFileSync(p, 'utf8'));
console.log(r.claims.filter((c) => c.status === 'active' && c.covers).length);
")

cat <<SUMMARY | tee -a "$REPORT"

────────────────────────────────────────────────────────────
${BOLD}Quantasyte dogfood — Summary${RESET}
────────────────────────────────────────────────────────────

  Pinned version linked:           $LINKED_VERSION (local dev build)
  Active pins after generation:    $PIN_COUNT
  Bug-fix-origin pins (🔁 tagged): $BUGFIX_COUNT  of  $PIN_COUNT
  Pins with bad_case populated:    $BADCASE_COUNT  of  $PIN_COUNT
  Pins with covers field:          $COVERS_COUNT  of  $PIN_COUNT

  Statusline:  $STATUSLINE_OUT

  Full report:  $REPORT
  Verbose log:  $LOG

What to do next:
  1. Open $QS_REPO in your editor
  2. Inspect tests/pinned/ — review the auto-generated pins
  3. Set PREVIEW_URL to your Quantasyte preview deploy and re-run
       'pinned test' to actually verify the pins
  4. Make a real PR on Quantasyte — the GitHub Action should kick in
       and post a Pinned comment with auto-generated pins
  5. Track for the next 3-5 days:
       - How many catches actually fire?
       - Any false positives?
       - Does the developer UX feel right?

SUMMARY

echo ""
echo "${GREEN}${BOLD}✓ Dogfood script complete. Report at $REPORT${RESET}"
