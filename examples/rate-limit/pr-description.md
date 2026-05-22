# Add rate-limit to /api/users endpoint

We were seeing scraping traffic peak at ~1,000 req/min from a small set of IPs last week. Adding a sliding-window limiter at the middleware layer.

Rate-limits /api/users to 60 req/min.

The implementation uses `@upstash/ratelimit` with a Redis backend. Same pattern we already use on /api/exports.
