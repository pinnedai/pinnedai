# Why pin this claim

Idempotency is one of those properties that's easy to silently break:

- A refactor renames the dedup key from `event_id` to `eventId` and now keys don't match anymore
- A cache layer change moves the dedup check after side-effects have already fired
- A new endpoint copy-pastes the handler without copying the idempotency wrapper
- A "performance optimization" removes the Redis lookup because "it's slow"

**With this pin**: if a duplicate webhook call ever returns a *different* response, CI fails. The test sends the exact same JSON payload twice and asserts the two responses are byte-identical (status + body).

This is the kind of regression that's nearly invisible in normal testing — you'd need to actually fire the same webhook twice in your test suite to catch it. The pin makes that test permanent.
