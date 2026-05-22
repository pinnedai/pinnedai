# Why pin this claim

Auth checks are the single most common place where refactors silently regress security. Common patterns that break auth:

- Moving middleware order so an auth check runs after a route handler returns
- Replacing the auth library and missing one route
- Adding a new "internal" route handler that bypasses the main middleware
- A reviewer-approved "optimization" that caches responses before auth runs

**With this pin**: any future commit that lets an unauthenticated GET reach `/api/admin/export` (returning 200 instead of 401/403) fails CI. The failure message tells the next developer exactly what they broke and points at this PR.

Generated test sends a single GET without an `Authorization` header and asserts the response is 401 or 403.
