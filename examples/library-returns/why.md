# Why pin this claim

Library/SDK return shapes are the most heavily-relied-upon contracts in any codebase. Every caller of `parseConfig()` assumes a specific shape comes back. Things that silently break it:

- Adding a new field but renaming an existing one
- "Improving" a default value because it seemed wrong
- Refactoring to a different return type without updating callers
- A merge conflict resolution that picks the wrong branch's return value

**With this pin**: if `parseConfig()` ever stops returning `{ version: 1 }`, the test fails. The repair prompt shows the actual return value so the next developer can compare.

Generated test imports the named function from a repo-relative module path, calls it with the args literal embedded in the claim, and deep-equals the return against the expected JSON value. JSON-deep-equal (not reference equality) so order-insensitive object comparison works correctly.

This template is intentionally narrow — it only handles synchronous functions that return JSON-serializable values. Async functions, functions that throw, and functions returning complex types (Dates, Maps, etc.) need custom tests. That's a v0.2+ extension.
