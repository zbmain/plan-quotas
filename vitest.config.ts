import { defineConfig } from "vitest/config";

/** Run backend compatibility checks independently from the existing web test suite. */
export default defineConfig({
  test: {
    include: ["server/test/**/*.test.ts"],
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
