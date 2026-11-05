import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "sdk",
    environment: "jsdom",
    globals: true,
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/support/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text-summary", "json-summary", "lcov"],
      thresholds: { lines: 100, statements: 100, functions: 100, branches: 100 },
    },
  },
});
