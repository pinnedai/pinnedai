# Pinned catches

Auto-maintained by [pinnedai](https://pinnedai.dev). Each entry is a regression Pinned caught before it reached production — the actual saves.

**Do not edit by hand** — this file is rewritten on every `pinned test` run that detects a new catch.

**Lifetime catches:** 8 unique pins (showing 8 most recent)

## 2026-06-02 · cli-output-contains on node ./apps/cli/dist/cli.js check --description "Rate-limits /api/users to 60 req/min."

**Original claim:** \`node ./apps/cli/dist/cli.js check --description "Rate-limits /api/users to 60 req/min."\` outputs \`Found 1 claim(s)\`

**Originally pinned in:** `v0-1-1`

**Test that caught it:** [`tests/pinned/v0-1-1-cli-output-contains-node-apps-cli-dist-cli-js-check-description-rate-limits-api-users-to-60-req-min-7llvs2.test.ts`](v0-1-1-cli-output-contains-node-apps-cli-dist-cli-js-check-description-rate-limits-api-users-to-60-req-min-7llvs2.test.ts)

---

## 2026-05-26 · auth-required on /api/admin/export

**Original claim:** /api/admin/export requires admin role

**Originally pinned in:** `v0-1-1`

**Test that caught it:** [`tests/pinned/v0-1-1-auth-required-api-admin-export-rw7ne7.test.ts`](v0-1-1-auth-required-api-admin-export-rw7ne7.test.ts)

---

## 2026-05-26 · returns-status on /api/signup

**Original claim:** POST /api/signup returns 400 on missing email

**Originally pinned in:** `v0-1-1`

**Test that caught it:** [`tests/pinned/v0-1-1-returns-status-api-signup-15x1ys.test.ts`](v0-1-1-returns-status-api-signup-15x1ys.test.ts)

---

## 2026-05-26 · returns-status on /api/users

**Original claim:** /api/users returns 422 on invalid email

**Originally pinned in:** `v0-1-1`

**Test that caught it:** [`tests/pinned/v0-1-1-returns-status-api-users-12hl5q.test.ts`](v0-1-1-returns-status-api-users-12hl5q.test.ts)

---

## 2026-05-26 · returns-status on /api/users

**Original claim:** /api/users returns 401 on missing token

**Originally pinned in:** `v0-1-1`

**Test that caught it:** [`tests/pinned/v0-1-1-returns-status-api-users-um7t93.test.ts`](v0-1-1-returns-status-api-users-um7t93.test.ts)

---

## 2026-05-26 · lockfile-integrity

**Original claim:** lockfile-integrity pnpm-lock.yaml sha256 e7a06ea703b2

**Without Pinned, this would have shipped:** \`pnpm-lock.yaml\` SHA-256 changed (lockfile was regenerated or hand-edited; transitive deps may have shifted)

**Originally pinned in:** `baseline-20260525`

**Test that caught it:** [`tests/pinned/baseline-20260525-lockfile-integrity-lockfile-pnpm-lock-yaml-e7a06ea703b2-tb6mqy.test.ts`](baseline-20260525-lockfile-integrity-lockfile-pnpm-lock-yaml-e7a06ea703b2-tb6mqy.test.ts)

---

## 2026-05-26 · secret-not-public

**Original claim:** no VITE_* env var ever contains a secret (SECRET/TOKEN/PRIVATE_KEY/API_KEY)

**Without Pinned, this would have shipped:** a \`VITE_\` env var with a secret-shaped suffix (SECRET, TOKEN, PRIVATE_KEY, API_KEY) was introduced — would leak a server secret into the client bundle

**Originally pinned in:** `baseline-20260525`

**Test that caught it:** [`tests/pinned/baseline-20260525-secret-not-public-secret-not-public-vite-12jyea.test.ts`](baseline-20260525-secret-not-public-secret-not-public-vite-12jyea.test.ts)

---

## 2026-05-26 · cli-output-contains on node ./apps/cli/dist/cli.js --version

**Original claim:** \`node ./apps/cli/dist/cli.js --version\` outputs \`0.0.1\`

**Originally pinned in:** `v0-1-1`

**Test that caught it:** [`tests/pinned/v0-1-1-cli-output-contains-node-apps-cli-dist-cli-js-version-1o1gxj.test.ts`](v0-1-1-cli-output-contains-node-apps-cli-dist-cli-js-version-1o1gxj.test.ts)

---
