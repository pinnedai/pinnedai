# Why pin this claim

A rate-limiter is a typical "set once, never look at again" piece of middleware. Six months later, a developer doing an unrelated refactor — say, replacing the middleware stack with a new auth layer — accidentally drops the limiter or moves it past the route handler. The scraping abuse comes back. No one notices for weeks.

**With this pin**: the moment the rate-limit on `/api/users` is regressed, CI fails on the very PR that broke it. The failure message includes a back-reference to the original PR (this one) so the reviewer can see exactly what claim is being violated.

Generated test runs 61 parallel requests against `PREVIEW_URL/api/users` and asserts at least one returns 429. Burst-parallel rather than sequential so the test always exceeds the limiter regardless of token-bucket refill rate.
