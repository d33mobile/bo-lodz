// Shared monocart-coverage-reports options. Used by the e2e spec (to add V8
// coverage gathered from Chromium) and by the global teardown (to generate the
// final report). Both sides MUST pass identical options so MCR reuses the same
// cache directory and merges the per-test entries into one report.
//
// entryFilter keeps ONLY the application's own modules (app.js + logic.js) that
// are served from our static server; the Leaflet CDN bundle and any inline
// scripts are dropped so the percentages describe code we actually ship.

// Enforced branch-coverage floor for the whole shipped JS (app.js + logic.js),
// organically gathered from real Chromium execution. The C4 stage ratchets this
// upward as more branches get covered (monotonically; never lowered). It tracks
// just below the latest measured total so a regression fails CI.
// When the merged total branch % drops below this, onEnd throws and the
// `playwright test` run exits non-zero, failing CI.
export const BRANCH_THRESHOLD = 95;

export const coverageOptions = {
  name: "BO JS coverage",
  outputDir: "coverage-e2e",
  reports: ["v8", "console-summary", "json-summary", "lcov"],
  entryFilter: (entry) => /\/(app|logic)\.js(\?|$)/.test(entry.url),
  sourceFilter: (sourcePath) => /(^|\/)(app|logic)\.js$/.test(sourcePath),
  // Runs after the report is generated (during mcr.generate() in the global
  // teardown). `add()` calls in the spec do NOT trigger it. Throwing here
  // propagates out of generate() and fails the Playwright run.
  onEnd: (coverageResults) => {
    const pct = coverageResults.summary.branches.pct;
    if (pct < BRANCH_THRESHOLD) {
      throw new Error(
        `Branch coverage ${pct}% is below the enforced threshold ${BRANCH_THRESHOLD}%`
      );
    }
    console.log(`Branch coverage ${pct}% >= threshold ${BRANCH_THRESHOLD}%`);
  },
};
