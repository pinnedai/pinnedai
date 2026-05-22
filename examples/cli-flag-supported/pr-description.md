# Add `--json` to `pinned check`

The Action workflow needs structured output to compose claims into the PR-comment generator. Adding `--json` to `pinned check` so it emits a parseable JSON array of claims instead of human-readable text.

`pinned check` supports `--json` flag.

Default output stays human-readable for terminal use; `--json` is opt-in.
