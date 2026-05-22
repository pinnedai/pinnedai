# `parseConfig()` now defaults to version 1

We're introducing forward-compatibility for a v2 config schema, but for now `parseConfig()` with no input must default to v1 so existing callers don't break.

`parseConfig()` in `src/config.ts` returns `{"version": 1}`.

The fixed return shape locks in the v1 default. When we ship v2, the test will fail on purpose (forcing a deliberate migration) instead of silently changing behavior.
