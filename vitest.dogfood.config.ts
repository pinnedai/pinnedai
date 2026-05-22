// Root-level vitest config — runs the dogfood pins in tests/pinned/.
// Customer repos use their own vitest config; this one exists only so
// pinnedai dogfoods its own templates against its own CLI binary.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/pinned/**/*.test.ts"],
    // Pin tests spawn the CLI binary, which can take a few hundred ms
    // each. Bump default 5s timeout to be safe on slow CI runners.
    testTimeout: 30_000,
  },
});
