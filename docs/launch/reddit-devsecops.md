# r/devsecops post draft

> **Status**: Draft. Proofread before posting.
> **Subreddit**: r/devsecops (~80K members)
> **Tone**: technical, no-hype, security-aware

---

## Title

**Recommended**:
> Made a tool that converts PR description claims into permanent CI tests (auth, rate-limit, idempotent + more)

---

## Body

Hey folks,

I've been frustrated with how easy it is for AI-assisted refactors to silently regress security boundaries. The classic pattern: someone (or an AI tool) refactors the middleware stack, and three months later a customer reports `/api/admin/X` is returning data without an Authorization header. No alarms, no failing tests — the auth check just quietly moved out of the request path.

So I built pinnedai. It does one thing: converts claims in PR descriptions ("auth required on /api/admin/export", "rate-limits /api/users to 60/min") into permanent Vitest files that live in `tests/pinned/`. When a future commit breaks the claim, CI fails and points back at the original PR.

**What this is NOT:**

- Not a code-review bot (use CodeRabbit / Greptile / Qodo for that — Pinned complements them)
- Not a SAST/SCA scanner (use Snyk / Socket / Trivy for that)
- Not a secrets scanner (use Gitleaks for that)

**What this IS:** a test-artifact registry for the AI-coding era. The PR description is the test. Forever.

**Templates that matter for security:**

- `auth-required` — single GET without auth → must return 401/403
- `rate-limit` — burst N+1 requests → at least one must return 429
- `idempotent` — POST same payload twice → byte-identical response (relevant for webhook handlers, payment flows)

**Plus CLI/library templates** for tooling claims (`pinned doctor` outputs OK, `pinned init` creates the registry, `parseConfig()` returns `{version: 1}`).

**Useful bits for security-conscious teams:**

- **OIDC-keyless onboarding** — the Action validates GitHub's OIDC JWT against JWKS, extracts `repository_owner`, looks up subscription. No API keys ever pass through the customer's repo.
- **Per-bundle GPT-reviewed code** — every code bundle is reviewed by GPT against pre-articulated security specs (path-traversal defense, argv tokenization at gen-time, etc.) before merge. Public review-status doc.
- **Apache 2.0 CLI** — anything that runs in customer CI is fully auditable. Worker is closed-source (system prompt + advanced detection are the IP).
- **No PR description data persists** on our side beyond SHA-256 hashes for cache lookup (90-day TTL).
- **Optional BYOK** — Pro tier can opt to call Anthropic/OpenAI directly with their own key. PR descriptions never transit our infra.

**Pricing**: Free with generous public-repo caps (500 LLM calls/mo), 100/mo on private. Pro $19/mo. The Worker enforces an aggregate cost cap so I'm not exposed to viral-spike risk as a solo founder.

**Code**: https://github.com/pinnedai/pinnedai
**Try it**: `npx pinnedai` (zero config, no signup)

Would love any feedback from the security angle. I'm especially interested in:
- What claim templates are missing for security workflows? (Input validation? CORS? CSP?)
- Is the "PR description becomes change-management evidence" angle real for SOC 2 / ISO 27001 audits or aspirational?
- Anyone willing to be a design partner for the compliance-export feature?

— Michael (mzon7)
