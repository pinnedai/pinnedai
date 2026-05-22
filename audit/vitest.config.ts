// Vitest config for the feature-audit suite. Separate from per-package
// unit-test configs and from the root vitest.dogfood.config.ts so each
// suite has its own scope without cross-contamination.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["audit/**/*.audit.ts"],
    // Audits spawn child processes, run real HTTP servers, and (for
    // Worker audits) bring up miniflare instances. Default 5s timeout
    // is too tight — bump to 30s per test, 60s for the suite.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Audits mutate process.env, spawn servers on random ports, and
    // touch the filesystem in tempdirs. Run sequentially to keep the
    // signal clean.
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
