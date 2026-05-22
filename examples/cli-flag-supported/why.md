# Why pin this claim

CLI flags are public-API surface. Once shipped, removing one breaks every script and pipeline that uses it. Common regressions:

- A refactor switches CLI frameworks and forgets to re-register a flag
- A "cleanup" removes an "unused" flag that was actually used by a downstream tool
- A renaming pass changes `--json` to `--format=json` and breaks every existing consumer
- An accidental rebase drops a flag definition

**With this pin**: if `pinned check --help` ever stops documenting `--json`, the test fails. The repair prompt shows the current help output so the next developer can compare.

Generated test spawns `<command> --help` and asserts the flag string appears in stdout or stderr (concatenated, since some CLIs print help to stderr). Doesn't actually exercise the flag's behavior — only that it's documented as supported.
