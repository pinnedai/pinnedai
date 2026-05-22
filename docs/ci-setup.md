# Wiring Pinned into your CI

> Most users don't need this guide — `npx pinnedai init --auto` writes a working `.github/workflows/pinned.yml` that's good for 90% of GitHub-hosted repos. This guide is for **non-GitHub CIs (GitLab, CircleCI, Jenkins)**, **custom setups**, and **debugging existing workflows**.

---

## TL;DR

| Your CI | Recommended setup |
|---|---|
| **GitHub Actions** (default) | `npx pinnedai init --auto` writes the workflow for you. See [GitHub Actions](#github-actions-default) for what it does + opt-outs. |
| **GitLab CI** | Run `pinned test` + `pinned scan` in a stage. See [GitLab CI](#gitlab-ci). |
| **CircleCI** | Same — runs as a single job step. See [CircleCI](#circleci). |
| **Jenkins / Bitbucket / others** | Standard shell-out pattern. See [Other CIs](#other-cis). |
| **Local-only (no CI yet)** | Pinned still works — git hooks run on every commit. See [No CI](#no-ci-local-only). |

---

## GitHub Actions (default)

`pinned init --auto` writes `.github/workflows/pinned.yml`. The workflow:

1. Triggers on `pull_request` events
2. Checks out the repo
3. Runs `pinned check --description "<PR body>"` to extract claims
4. Runs `pinned scan --base <base-ref> --markdown` to find unprotected risk surfaces
5. Posts the result as a PR comment
6. Auto-commits any new pin files (opt-out below)

**Required permissions** (already set in the workflow):
```yaml
permissions:
  contents: write       # for auto-commit of new pin files
  id-token: write       # for OIDC auth to the hosted Worker
  pull-requests: write  # for posting the comment
```

**Opt-outs**:

| Setting | What it does |
|---|---|
| `repo variable PINNEDAI_AUTOCOMMIT=false` | Pinned posts the generated pin file in a PR comment instead of committing it. User pastes it manually. |
| `repo secret PINNEDAI_ANTHROPIC_KEY` / `_OPENAI_KEY` + `byok: anthropic` (or `openai`) action input | BYOK — your own key instead of the hosted Worker's quota. Required Pro. |
| `repo variable PINNEDAI_DISABLE_LLM=1` | Regex-only extraction. Cheaper but ~50% lower claim recall. |

**Re-running for an existing repo**: `pinned init --force` re-writes the workflow + AGENT.md while preserving your pins.

### Adding `pinned test` to your existing CI

If you don't want Pinned to manage its own workflow, just add the test step to whatever you already run:

```yaml
- name: Run Pinned tests
  run: npx pinnedai test
  env:
    PREVIEW_URL: ${{ steps.deploy-preview.outputs.url }}
```

See `docs/preview-url.md` for how to get a preview URL from Vercel / Fly / Cloudflare / Render / Railway.

---

## GitLab CI

```yaml
# .gitlab-ci.yml
stages:
  - test
  - pinned

pinned:check:
  stage: pinned
  image: node:20
  rules:
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
  variables:
    PREVIEW_URL: $CI_ENVIRONMENT_URL  # GitLab auto-provides for review apps
  script:
    - npm ci
    # Pinned tests — verify protected behavior
    - npx pinnedai test
    # Pinned scan — find unprotected risk surfaces in the diff
    - npx pinnedai scan --base $CI_MERGE_REQUEST_TARGET_BRANCH_NAME --markdown > pinned-scan.md
  artifacts:
    paths:
      - pinned-scan.md
    expire_in: 30 days
```

To post the scan result as a merge-request comment, use [GitLab's API](https://docs.gitlab.com/ee/api/notes.html) in a follow-up job:

```yaml
pinned:post-comment:
  stage: pinned
  image: alpine:latest
  needs: ["pinned:check"]
  rules:
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
  before_script:
    - apk add curl jq
  script:
    - |
      BODY=$(jq -Rsa . < pinned-scan.md)
      curl --request POST \
        --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \
        --header "Content-Type: application/json" \
        --data "{\"body\": $BODY}" \
        "$CI_API_V4_URL/projects/$CI_PROJECT_ID/merge_requests/$CI_MERGE_REQUEST_IID/notes"
```

Required: `GITLAB_TOKEN` (project access token with `api` scope).

---

## CircleCI

```yaml
# .circleci/config.yml
version: 2.1
jobs:
  pinned:
    docker:
      - image: cimg/node:20.0
    steps:
      - checkout
      - run:
          name: Install
          command: npm ci
      - run:
          name: Pinned tests
          environment:
            PREVIEW_URL: << pipeline.parameters.preview-url >>
          command: npx pinnedai test
      - run:
          name: Pinned scan
          command: npx pinnedai scan --base origin/$CIRCLE_BRANCH_BASE

workflows:
  on-pr:
    jobs:
      - pinned:
          filters:
            branches:
              ignore: main
```

CircleCI doesn't have a native "post comment to PR" step — use [Probot Settings](https://github.com/probot/settings) or call the GitHub API directly:

```yaml
- run:
    name: Post Pinned scan to PR
    command: |
      npx pinnedai scan --base origin/$CIRCLE_BRANCH_BASE --markdown > /tmp/pinned-scan.md
      gh pr comment $CIRCLE_PULL_REQUEST --body-file /tmp/pinned-scan.md
    environment:
      GH_TOKEN: $GH_TOKEN
```

---

## Other CIs (Jenkins, Bitbucket, Drone, Codefresh, etc.)

The pattern is universal — `npx pinnedai test` + `npx pinnedai scan` in a shell step. No CI-specific magic required.

```bash
#!/bin/bash
# Generic CI snippet — paste into your runner's shell step

# Set PREVIEW_URL to your deploy preview (or leave unset to skip web pins)
export PREVIEW_URL="${PREVIEW_URL:-}"

# Run Pinned tests
npx pinnedai test || exit $?

# Run Pinned scan against the merge base
BASE_REF="${BASE_REF:-origin/main}"
npx pinnedai scan --base "$BASE_REF" --markdown > pinned-scan.md

# Upload pinned-scan.md as a build artifact OR post it via your CI's
# API/webhook to the PR/MR comment thread.
```

---

## No CI (local-only)

If you're not running CI yet, Pinned still works via the **git hooks** that `pinned init --auto` installs:

| Hook | What it does |
|---|---|
| **pre-commit** | Runs `pinned auto-protect` against staged files. Auto-adds new pins for protectable surfaces (admin routes, webhooks, etc.). |
| **pre-push** | Backstop scan in case the pre-commit hook missed something. |
| **post-commit** | Runs `pinned test` in the background (throttled to once per 2 min). Surfaces catches in the next AI chat message. |

These run on every `git commit` regardless of CI presence. Set `PINNEDAI_SKIP_HOOK=1` on any individual commit to bypass.

The hooks don't need `PREVIEW_URL` to function — auto-protect is local-only, and `pinned test` skips web pins gracefully when no preview is available (statusline shows `⊘ N skipped (no preview)`).

---

## OIDC + Worker integration

When the Pinned hosted Worker is deployed (`api.pinnedai.dev`), the GitHub Action uses GitHub's built-in OIDC tokens to authenticate without needing any secrets:

```yaml
permissions:
  id-token: write   # required for OIDC

steps:
  - uses: pinnedai/pinnedai-action@v1
```

The Worker validates the OIDC JWT, extracts the `repository_owner` claim cryptographically, and meters the org's monthly LLM-call quota in D1. **No API key, no signup, no secret to manage.**

If you're not on GitHub Actions, you can still use the hosted endpoint with BYOK:

```bash
PINNEDAI_BYOK=openai PINNEDAI_OPENAI_KEY=sk-... npx pinnedai check --description "..."
```

---

## Troubleshooting

### Pinned tests skip in CI but pass locally

Most likely: `PREVIEW_URL` is set locally but not in CI. Run `pinned doctor` in your CI step to see the diagnostic:

```yaml
- run: npx pinnedai doctor
```

The output explicitly lists `PREVIEW_URL: not set — web-template pins will skip silently. See setup guide at https://pinnedai.dev/docs/preview-url`.

### Auto-commit fails with "fatal: Author identity unknown"

The workflow needs git author config. The default `pinned init --auto` workflow sets this, but custom workflows may need:

```yaml
- name: Configure git for auto-commit
  run: |
    git config user.email "pinnedai-bot@users.noreply.github.com"
    git config user.name "Pinned Bot"
```

### `pinned scan` returns nothing

Common causes:
1. The PR's base branch isn't fetched (`fetch-depth: 0` on `actions/checkout` fixes this)
2. The diff doesn't touch routes / webhooks / middleware / env files (scan-diff only flags those surfaces)
3. PR description already covers the changes (suggestions get suppressed when claims match)

### CI cost concerns

Pinned's Worker calls cost ~$0.001 per claim extraction at scale. A repo with 100 PRs/month using LLM-fallback costs roughly **$0.10/month on the Free tier** (private repos: 100 calls/mo cap; public: 1000 calls/mo).

If you want zero LLM cost, set the repo variable `PINNEDAI_DISABLE_LLM=1`. Claim recall drops from ~85% to ~50% but the regex extraction is free + deterministic.

---

## Still stuck?

- File an issue at https://github.com/pinnedai/pinnedai/issues with your CI provider + a minimal reproduction
- Run `npx pinnedai doctor` and paste the output
- The Pinned action source is at https://github.com/pinnedai/pinnedai-action — PRs welcome for additional CI examples
