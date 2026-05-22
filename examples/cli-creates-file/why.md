# Why pin this claim

A CLI's filesystem side-effects are part of its contract. Users build automation around them:

- Onboarding docs that say "after `pinned init`, you'll see `tests/pinned/.registry.json`"
- CI scripts that check for the file's existence to gate downstream steps
- IDE plugins that watch for the file to enable Pinned-specific UI

**With this pin**: if a future change removes or renames `.registry.json`, the test fails. The repair prompt tells the next developer exactly which file is missing.

Generated test runs the command in a fresh tempdir (safely isolated from the customer's actual repo) and asserts the file exists relative to that tempdir afterward. Tempdir is auto-cleaned. Customers can override via `PINNED_CLI_CWD` if the command requires their actual repo state.
