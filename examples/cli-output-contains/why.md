# Why pin this claim

CLI output is a public-API surface: scripts, dashboards, CI parsers all depend on specific strings appearing. Common refactors that break it:

- "Cleaning up" a verbose check that another script grepped
- Replacing a custom logger with a generic one that drops context
- Adding a translation layer that silently changes English strings to localized output
- Removing a "redundant" line that was actually load-bearing for a different consumer

**With this pin**: if `pinned doctor` ever stops printing "tests/pinned/ directory" in its output, the test fails. The repair prompt tells the next developer what string is missing and why.

Generated test spawns the CLI via `execFileSync` (no shell — argv is tokenized at generation time so the command can't inject), captures stdout, and asserts the expected substring appears.
