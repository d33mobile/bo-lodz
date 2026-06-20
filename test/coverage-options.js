// Shared monocart-coverage-reports options. Used by the e2e spec (to add V8
// coverage gathered from Chromium) and by the global teardown (to generate the
// final report). Both sides MUST pass identical options so MCR reuses the same
// cache directory and merges the per-test entries into one report.
//
// entryFilter keeps ONLY the application's own modules (app.js + logic.js) that
// are served from our static server; the Leaflet CDN bundle and any inline
// scripts are dropped so the percentages describe code we actually ship.
export const coverageOptions = {
  name: "BO JS coverage",
  outputDir: "coverage-e2e",
  reports: ["v8", "console-summary", "json-summary", "lcov"],
  entryFilter: (entry) => /\/(app|logic)\.js(\?|$)/.test(entry.url),
  sourceFilter: (sourcePath) => /(^|\/)(app|logic)\.js$/.test(sourcePath),
};
