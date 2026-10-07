import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 15000,
    // Backend tests share one database — keep files sequential to avoid races.
    fileParallelism: false,
  },
});
