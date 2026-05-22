#!/usr/bin/env bash
# Build a "natural English" corpus for the parseClaims FP audit.
# Pulls:
#   1. The last N merged PR descriptions for each OSS repo (via gh api)
#   2. README.md text from each cloned OSS repo
#   3. Recent commit messages from each cloned repo
# Writes one JSON fixture per repo to audit/oss-sweep/text-fixtures/.

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SWEEP_ROOT="${ROOT}/audit/oss-sweep"
CLONES="${SWEEP_ROOT}/.clones"
TEXT_FIX="${SWEEP_ROOT}/text-fixtures"
REPOS="${SWEEP_ROOT}/repos.txt"
PYHELPER="${ROOT}/scripts/parse-fp-sweep-fixture.py"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT
PRS_PER_REPO="${PRS_PER_REPO:-10}"

if [ "${1:-}" != "--regenerate" ]; then
  echo "Usage: $0 --regenerate    (set PRS_PER_REPO=N to override depth, default 10)"
  exit 0
fi

mkdir -p "$TEXT_FIX"

while IFS= read -r repo; do
  [ -z "$repo" ] && continue
  name=$(echo "$repo" | tr '/' '-')
  clone="$CLONES/$name"
  fixture="$TEXT_FIX/$name.json"
  if [ ! -d "$clone" ]; then
    echo "skip $name (no clone)"
    continue
  fi

  # README path
  readme_path=""
  for f in README.md README.MD readme.md Readme.md; do
    if [ -f "$clone/$f" ]; then
      readme_path="$clone/$f"
      break
    fi
  done

  # Recent commit messages — write to tmp file
  commits_path="$TMP_DIR/$name-commits"
  (cd "$clone" && git log --no-merges --pretty=format:"%s%n%n%b%n---COMMIT-DELIM---" -50 > "$commits_path" 2>/dev/null) || : > "$commits_path"

  # PR bodies via gh api — write to tmp file
  prs_path="$TMP_DIR/$name-prs"
  if command -v gh >/dev/null 2>&1; then
    gh api -X GET "repos/$repo/pulls" \
      -f state=closed \
      -f sort=updated \
      -f direction=desc \
      -f per_page="$PRS_PER_REPO" \
      --jq '[.[] | {number: .number, title: .title, body: .body, merged_at: .merged_at}]' \
      > "$prs_path" 2>/dev/null || echo "[]" > "$prs_path"
  else
    echo "[]" > "$prs_path"
  fi

  python3 "$PYHELPER" "$repo" "$readme_path" "$commits_path" "$prs_path" "$fixture"
  prs_count=$(python3 -c "import json; print(len(json.load(open('$fixture')).get('prs',[])))" 2>/dev/null || echo "?")
  echo "  $name: prs=$prs_count"
done < "$REPOS"

echo ""
echo "Text fixtures in $TEXT_FIX/"
ls "$TEXT_FIX" | wc -l
