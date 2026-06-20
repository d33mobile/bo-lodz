import js from "@eslint/js";
import globals from "globals";
import prettier from "eslint-config-prettier";

export default [
  {
    ignores: ["node_modules/", "data/", "coverage/", "coverage-e2e/", "test-results/"],
  },
  js.configs.recommended,
  {
    // Node-side tooling: Playwright config, e2e specs and teardown run under
    // Node, not in the browser, so they get the Node globals (process, etc.).
    files: ["playwright.config.js", "test/**/*.js", "vitest.config.js"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        // Browser environment (window, document, fetch, localStorage,
        // CompressionStream, atob/btoa, addEventListener, scrollY, …).
        ...globals.browser,
        // Leaflet, loaded from CDN as a global.
        L: "readonly",
      },
    },
    rules: {
      // Empty catch blocks are intentional best-effort guards (localStorage and
      // CompressionStream access that must never surface an error to the user).
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  // eslint-config-prettier must stay last so it disables any stylistic rules
  // that would otherwise conflict with Prettier's formatting.
  prettier,
];
