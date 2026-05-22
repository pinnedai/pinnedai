# Improve `pinned doctor` output

`pinned doctor` was reporting too tersely — users couldn't tell what was wrong without grepping the source. Now each check prints its full status with context.

`pinned doctor` outputs `tests/pinned/ directory`.

The output now includes:
- Whether `tests/pinned/` exists
- Whether the workflow file has `id-token: write` and `contents: write`
- Active pin count
- BYOK wiring status if configured
