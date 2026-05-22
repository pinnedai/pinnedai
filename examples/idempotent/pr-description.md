# Make /webhooks/stripe idempotent on event_id

Stripe retries failed webhooks aggressively — we were seeing the same event processed multiple times after timeouts. Switching to idempotency-key based dedup using Stripe's `event_id`.

Makes /webhooks/stripe idempotent on event_id.

Implemented at the handler layer with a 24-hour Redis TTL on `(event_id → cached_response)`. Retries within the TTL return the cached response byte-for-byte.
