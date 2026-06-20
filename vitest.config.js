import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only the pure-logic unit suite runs under vitest. The Playwright e2e
    // spec (test/e2e.spec.js) uses Playwright's own runner and must not be
    // picked up here, or its `test.beforeEach` would fail under vitest.
    include: ["**/logic.test.js"],
    coverage: {
      provider: "v8",
      include: ["logic.js"],
      reporter: ["text", "json-summary"],
      thresholds: {
        branches: 90,
        lines: 90,
        functions: 90,
        statements: 90,
      },
    },
  },
});
