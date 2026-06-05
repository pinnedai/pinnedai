#!/usr/bin/env bash
# Launch-validation runner for Fixture 16 — socialideagen image-gen
# Tier 1 smoke. Per the build plan: "Prove reproduce-red by reverting
# the literal to 'done'. That's the launch proof."
#
# For each of the three variations, runs:
#   1. Start stub-broken.mjs → run the smoke pin → expect RED
#   2. Start stub-fixed.mjs  → run the smoke pin → expect GREEN
# Exits 0 iff all 6 expectations hold.

set -u
FIXTURE_ROOT="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$FIXTURE_ROOT/../../.." && pwd)"
CLI="$REPO_ROOT/apps/cli/dist/cli.js"
VITEST="$REPO_ROOT/node_modules/.bin/vitest"
PORT=47900

if [ ! -f "$CLI" ]; then
  echo "✗ CLI not built. Run pnpm --filter pinnedai build first." >&2
  exit 1
fi

pass=0
fail=0
failures=()

run_variation() {
  local variant="$1"
  local route="$2"
  shift 2
  # remaining args: assertion flags for `pinned smoke add`
  local assert_args=("$@")
  local vdir="$FIXTURE_ROOT/$variant"
  local work="$(mktemp -d)"

  mkdir -p "$work/tests/pinned"
  pushd "$work" > /dev/null

  cat > vitest.config.ts <<EOF
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["tests/pinned/**/*.test.ts"], testTimeout: 30000 } });
EOF

  # Use `pinned smoke add` to create the pin via the user-facing CLI.
  node "$CLI" smoke add \
    --route "$route" \
    --method POST \
    --body '{"prompt":"a cat"}' \
    --header 'content-type:application/json' \
    --base-url "http://localhost:$PORT" \
    --safe-to-execute \
    --cadence pre-commit \
    --pr-id "fixture-$variant" \
    --quiet \
    "${assert_args[@]}" >/dev/null 2>&1

  # ----- Phase 1: BROKEN stub must produce RED -----
  PORT=$PORT node "$vdir/stub-broken.mjs" &
  local stub_pid=$!
  sleep 0.4
  PINNED_SMOKE_BASE_URL="http://localhost:$PORT" PINNED_SMOKE=1 \
    "$VITEST" run --reporter=default > "$work/broken-output.log" 2>&1
  local broken_exit=$?
  kill $stub_pid 2>/dev/null
  wait $stub_pid 2>/dev/null
  if [ $broken_exit -ne 0 ]; then
    echo "  ✓ $variant — broken stub correctly produced RED"
    ((pass++))
  else
    echo "  ✗ $variant — broken stub UNEXPECTEDLY produced GREEN (smoke pin failed to catch the bug)"
    failures+=("$variant: broken stub did not produce RED")
    ((fail++))
  fi

  # ----- Phase 2: FIXED stub must produce GREEN -----
  PORT=$PORT node "$vdir/stub-fixed.mjs" &
  local stub_pid=$!
  sleep 0.4
  PINNED_SMOKE_BASE_URL="http://localhost:$PORT" PINNED_SMOKE=1 \
    "$VITEST" run --reporter=default > "$work/fixed-output.log" 2>&1
  local fixed_exit=$?
  kill $stub_pid 2>/dev/null
  wait $stub_pid 2>/dev/null
  if [ $fixed_exit -eq 0 ]; then
    echo "  ✓ $variant — fixed stub correctly produced GREEN"
    ((pass++))
  else
    echo "  ✗ $variant — fixed stub UNEXPECTEDLY produced RED (smoke pin false-positive on fix)"
    failures+=("$variant: fixed stub did not produce GREEN")
    ((fail++))
    echo "    output: $(tail -3 "$work/fixed-output.log" | head -1)"
  fi

  popd > /dev/null
  rm -rf "$work"
}

echo "════════════════════════════════════════════════════════════════"
echo "Fixture 16 — socialideagen image-gen Tier 1 smoke validation"
echo "════════════════════════════════════════════════════════════════"
echo ""

echo "Variation 1: broken-status-string-mismatch"
echo "  (worker writes 'done' but spec says terminal is ['completed','failed'])"
run_variation "broken-status-string-mismatch" "/generate" \
  --assert-terminal "status|completed,failed|5000"

echo ""
echo "Variation 2: broken-daemon-hang"
echo "  (worker stays 'processing' forever — no terminal write)"
run_variation "broken-daemon-hang" "/generate" \
  --assert-terminal "status|completed,failed|5000"

echo ""
echo "Variation 3: broken-empty-input-not-rejected"
echo "  (no validation — empty prompt yields empty payload + 200 OK)"
run_variation "broken-empty-input-not-rejected" "/generate" \
  --assert-status-ok \
  --assert-contains '<svg'

echo ""
echo "════════════════════════════════════════════════════════════════"
if [ $fail -eq 0 ]; then
  echo "✓ ALL $pass EXPECTATIONS HELD"
  echo "  Tier 1 smoke feature is launch-validated against the real bug."
  exit 0
else
  echo "✗ FAILED: $fail of $((pass+fail)) expectations"
  for f in "${failures[@]}"; do echo "  - $f"; done
  exit 1
fi
