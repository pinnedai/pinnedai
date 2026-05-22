# Make `pinned init` idempotent

Previously `pinned init` exited with an error if the workflow file already existed. Now it skips existing files with a notice and only writes net-new ones unless `--force` is passed.

`pinned init` exits 0 on a healthy repo.

This means running `pinned init` a second time on a repo that already has it set up is a no-op, not a failure. Makes the action safe to include in onboarding scripts that may run multiple times.
