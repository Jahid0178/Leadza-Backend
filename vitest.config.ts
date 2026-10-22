import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 15000,
    // Fixture hooks register actors + businesses through the real API against
    // a remote dev DB — comfortably over vitest's 10s hook default on a slow
    // connection (the §50 suite passes its own larger budget per file too).
    hookTimeout: 60000,
    // Backend tests share one database — keep files sequential to avoid races.
    fileParallelism: false,
    // Pin env the suite depends on: dotenv never overrides variables that are
    // already set, so an ambient shell PORT (e.g. 0) would fail env.ts at import.
    env: { PORT: "4000", LOG_LEVEL: "fatal" },
  },
});
