#!/usr/bin/env bash
# Sweep popular OSS repos + the operator's dyad-apps repos for
# false-positive pin shapes. Two modes:
#
#   --regenerate-fixtures: clones every repo in audit/oss-sweep/repos.txt
#                          shallow (and walks every dyad-apps repo),
#                          extracts pinned-relevant file paths, writes
#                          a JSON fixture per repo to
#                          audit/oss-sweep/fixtures/.
#   (default):              usage instructions.
#
# The vitest audit (audit/oss-sweep/) runs against the fixtures —
# offline, deterministic, fast. Regenerating fixtures requires network
# and ~10GB of clones; meant to be run periodically, NOT in CI.

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SWEEP_ROOT="${ROOT}/audit/oss-sweep"
CLONES="${SWEEP_ROOT}/.clones"
FIXTURES="${SWEEP_ROOT}/fixtures"
REPOS="${SWEEP_ROOT}/repos.txt"
DYAD_ROOT="$(cd "$ROOT/.." && pwd)"
DYAD_DIRS=(Ai-Book ai-concierge AiConcierge_broken aiconciergeairbnb aiconciergeairbnb_prod back-in-play emerald-alpaca-play MediniDyad myhpifinal quantapact quantasyte rachsite researchAi TradingAndArbIB zon-incubator-sdk zon-incubator-template)

extract_paths() {
  # Capture every pinned-relevant file path (relative to repo root)
  # into a JSON array. Used by both the OSS and dyad-apps fixture
  # generators.
  local src_dir="$1"
  cd "$src_dir"
  {
    find . -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o -name "*.py" -o -name "*.rb" -o -name "*.go" \) 2>/dev/null \
      | xargs grep -l -i webhook 2>/dev/null | head -200
    find . -type d -name "node_modules" -prune -o -type f -path "*app/api/*" -name "route.*" -print 2>/dev/null | grep -v node_modules | head -100
    find . -type d -name "node_modules" -prune -o -type f -path "*pages/api/*" -print 2>/dev/null | grep -v node_modules | head -100
    find . -type d -name "node_modules" -prune -o -type f -path "*/routes/*" \( -name "*.ts" -o -name "*.js" \) -print 2>/dev/null | grep -v node_modules | head -50
    find . -type d -name "node_modules" -prune -o -type f -name "middleware.ts" -print 2>/dev/null | grep -v node_modules
    find . -type d -name "node_modules" -prune -o -type f -name ".env*" -print 2>/dev/null | grep -v node_modules | head -10
  } | sort -u | sed 's|^\./||' | head -500 \
    | sed 's/"/\\"/g' | awk 'NR==1{printf "    \"%s\"", $0; next} {printf ",\n    \"%s\"", $0}'
  cd "$ROOT"
}

write_fixture() {
  local repo="$1"; local name="$2"; local src_dir="$3"
  local fixture="$FIXTURES/$name.json"
  {
    echo "{"
    echo "  \"repo\": \"$repo\","
    echo "  \"files\": ["
    extract_paths "$src_dir"
    echo ""
    echo "  ]"
    echo "}"
  } > "$fixture"
  local count=$(grep -c '^    "' "$fixture")
  echo "  $name: $count paths captured"
}

if [ "${1:-}" = "--regenerate-fixtures" ]; then
  mkdir -p "$CLONES" "$FIXTURES"

  # OSS repos — clone shallow if not present
  while IFS= read -r repo; do
    [ -z "$repo" ] && continue
    name=$(echo "$repo" | tr '/' '-')
    dest="$CLONES/$name"
    if [ ! -d "$dest" ]; then
      echo "Cloning $repo..."
      git clone --depth=1 -q "https://github.com/$repo.git" "$dest" 2>/dev/null || {
        echo "  CLONE FAILED — skipping"
        continue
      }
    fi
    write_fixture "$repo" "$name" "$dest"
  done < "$REPOS"

  # Dyad-apps — read directly from the operator's repos (no clone needed)
  for app in "${DYAD_DIRS[@]}"; do
    src="$DYAD_ROOT/$app"
    if [ -d "$src" ]; then
      write_fixture "dyad-apps/$app" "dyad-$app" "$src"
    fi
  done

  echo ""
  echo "Fixtures regenerated in $FIXTURES/"
  ls "$FIXTURES" | wc -l
  exit 0
fi

cat <<'EOF'
Usage: oss-fp-sweep.sh --regenerate-fixtures

  Clones the OSS repos listed in audit/oss-sweep/repos.txt (shallow),
  walks each dyad-apps repo in /Users/michaelzon/dyad-apps, and writes
  a JSON fixture per repo to audit/oss-sweep/fixtures/. The vitest
  audit (audit/oss-sweep/) runs against those fixtures offline.

To run the FP-sweep audit:
  pnpm audit:oss-sweep
EOF
