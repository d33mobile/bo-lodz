import { defineConfig } from "@playwright/test";

// Static port for the dir-serving web server used by the e2e suite. The same
// port is the baseURL, so tests can `goto("/")`.
const PORT = 8099;

export default defineConfig({
  testDir: "test",
  testMatch: "**/*.spec.js",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  globalTeardown: "./test/global-teardown.js",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 390, height: 844 },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: `python3 -m http.server ${PORT}`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 30000,
  },
});
