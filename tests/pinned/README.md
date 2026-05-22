# tests/pinned/

This directory is managed by [pinnedai](https://pinnedai.dev).

Each `*.test.ts` file here was generated from a PR description claim
and is **pinned permanently to your CI**. If a future commit regresses
the claim, the test fails and points back at the original PR.

To retire a claim that no longer applies:

```bash
npx pinnedai retire <claim-id> --reason="<why>"
```

To list everything currently pinned:

```bash
npx pinnedai list
```
