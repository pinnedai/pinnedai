# `pinned init` now seeds an empty registry

Before this change, `pinned init` created the workflow and the README in `tests/pinned/` but left the registry creation to the first `pinned generate` call. Now `pinned init` also writes an empty `.registry.json` and a stub `PINS.md` so the registry exists from day one — important for `pinned list` and `pinned doctor` to work immediately after init.

`pinned init` creates `tests/pinned/.registry.json`.
