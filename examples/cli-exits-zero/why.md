# Why pin this claim

Exit codes are how shell scripts, CI jobs, and orchestration tools decide what to do next. A regression to non-zero exit can break:

- Onboarding scripts that run `pinned init` as one step in a chain
- `make` targets that depend on `pinned doctor` succeeding
- Pre-commit hooks
- Composite CI pipelines

**With this pin**: any future change that makes `pinned init` exit non-zero on a healthy repo fails the test. The repair prompt shows the actual exit code + captured stderr so the next developer can diagnose without running it themselves.

Generated test uses `spawnSync` (no shell), runs the command, and asserts `result.status === 0`. Captured stderr is included in the failure message so debugging doesn't require re-running.
