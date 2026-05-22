#!/usr/bin/env bash
# Sync public-safe files from the canonical monorepo (this dir) to
# the pinnedai-public/ mirror. Run before `git push` on the public
# repo so the mirror reflects the latest CLI + landing source.
#
# Public-safe paths (synced):
#   apps/cli/       — the npm package
#   apps/landing/   — pinnedai.dev source
#   README.md, LICENSE, .gitignore, root configs
#
# NEVER synced (stays private):
#   apps/edge/      — the hosted Worker (system prompt lives here)
#   OPS.md          — operational targets, conversion rates, abuse triggers
#   CLAUDE.md       — full project context for AI sessions
#   ROADMAP.md      — week-by-week internal plan
#   .github/        — monorepo's self-CI config (the public repo has its own)
#
# PARTIAL sync (only the public-safe sub-path):
#   action/action.yml — Marketplace action manifest (copied verbatim); the
#                       rest of the action/ directory (CI, helpers) stays
#                       in the canonical monorepo only.
#
# Override the destination via PINNEDAI_PUBLIC_DIR env var.

set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
DST="${PINNEDAI_PUBLIC_DIR:-$SRC/../pinnedai-public}"

if [ ! -d "$DST" ]; then
  echo "ERROR: public dir not found at $DST" >&2
  echo "Either create it or set PINNEDAI_PUBLIC_DIR." >&2
  exit 1
fi

# Refuse to run if DST has uncommitted OR untracked changes — would
# risk overwriting manual edits OR rsync --delete clobbering files the
# user dropped into the public mirror manually.
if [ -d "$DST/.git" ]; then
  pushd "$DST" >/dev/null
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "WARNING: $DST has uncommitted changes. Commit or stash first." >&2
    git status --short
    popd >/dev/null
    exit 1
  fi
  # Also reject untracked files — rsync --delete would remove them.
  UNTRACKED=$(git ls-files --others --exclude-standard)
  if [ -n "$UNTRACKED" ]; then
    echo "WARNING: $DST has untracked files that would be lost to rsync --delete:" >&2
    echo "$UNTRACKED" >&2
    echo "Either commit, ignore via .gitignore, or remove them." >&2
    popd >/dev/null
    exit 1
  fi
  popd >/dev/null
fi

echo "Syncing $SRC -> $DST ..."

rsync -a --delete \
  --exclude='node_modules' --exclude='dist' --exclude='.DS_Store' \
  "$SRC/apps/cli/" "$DST/apps/cli/"

rsync -a --delete \
  --exclude='node_modules' --exclude='dist' --exclude='.DS_Store' \
  "$SRC/apps/landing/" "$DST/apps/landing/"

# Root configs + OSS table-stakes files (overwrite each time).
# NOTE: CLAUDE.md, OPS.md, ROADMAP.md, LAUNCH_CHECKLIST.md, REVIEW_STATUS.md
# stay PRIVATE — they leak strategy, pricing internals, operator details.
for f in pnpm-workspace.yaml tsconfig.json package.json pnpm-lock.yaml LICENSE .gitignore README.md CHANGELOG.md CONTRIBUTING.md vitest.dogfood.config.ts; do
  if [ -f "$SRC/$f" ]; then
    cp "$SRC/$f" "$DST/$f"
  fi
done

# examples/ — working PR descriptions + generated tests per template.
# Mirror in full (no secrets, all educational).
if [ -d "$SRC/examples" ]; then
  rsync -a --delete \
    --exclude='node_modules' --exclude='.DS_Store' \
    "$SRC/examples/" "$DST/examples/"
fi

# audit/ — the signal-audit suite (every advertised feature verified
# with pos+neg controls). Public so customers can use the pattern as a
# reference for their own audits, and so anyone evaluating pinnedai
# can see exactly how we verify features.
if [ -d "$SRC/audit" ]; then
  rsync -a --delete \
    --exclude='node_modules' --exclude='.DS_Store' \
    "$SRC/audit/" "$DST/audit/"
fi

# .github/ — selectively sync. PR template + safe workflows go public;
# operational dogfood-specific bits stay private if they reference
# closed-source paths. The pinned.yml here references node ./apps/cli/dist/cli.js
# which only works in THIS repo (the pinnedai dogfood repo). For
# customers, action/action.yml is what they'd use.
mkdir -p "$DST/.github/workflows"
if [ -f "$SRC/.github/PULL_REQUEST_TEMPLATE.md" ]; then
  cp "$SRC/.github/PULL_REQUEST_TEMPLATE.md" "$DST/.github/PULL_REQUEST_TEMPLATE.md"
fi
for wf in ci.yml release.yml; do
  if [ -f "$SRC/.github/workflows/$wf" ]; then
    cp "$SRC/.github/workflows/$wf" "$DST/.github/workflows/$wf"
  fi
done

# action/action.yml — the GitHub Marketplace action customers consume.
if [ -d "$SRC/action" ]; then
  mkdir -p "$DST/action"
  cp "$SRC/action/action.yml" "$DST/action/action.yml"
fi

# Sanity check: apps/edge must NOT exist in the public mirror.
if [ -d "$DST/apps/edge" ]; then
  echo "FATAL: apps/edge leaked into public mirror at $DST/apps/edge" >&2
  echo "Remove it before committing." >&2
  exit 2
fi

# Sanity check: private docs must NOT have been copied
for forbidden in OPS.md CLAUDE.md ROADMAP.md; do
  if [ -f "$DST/$forbidden" ]; then
    echo "FATAL: $forbidden leaked into public mirror" >&2
    exit 2
  fi
done

echo "Sync OK. Next: cd $DST && git status && git add -A && git commit && git push public main"
