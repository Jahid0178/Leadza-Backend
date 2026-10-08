import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 15000,
    // Backend tests share one database — keep files sequential to avoid races.
    fileParallelism: false,
    // Pin env the suite depends on: dotenv never overrides variables that are
    // already set, so an ambient shell PORT (e.g. 0) would fail env.ts at import.
    env: { PORT: "4000", LOG_LEVEL: "fatal" },
  },
});
