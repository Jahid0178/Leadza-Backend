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
    // The Upstash pair is deliberately blanked: tests use the in-memory rate
    // limit store so counters are per-process and no network store is touched.
    env: {
      PORT: "4000",
      LOG_LEVEL: "fatal",
      UPSTASH_REDIS_REST_URL: "",
      UPSTASH_REDIS_REST_TOKEN: "",
    },
  },
});
