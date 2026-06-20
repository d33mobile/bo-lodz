import { test, expect } from "@playwright/test";
import MCR from "monocart-coverage-reports";
import { coverageOptions } from "./coverage-options.js";

// Single smoke test that drives the real app in Chromium and harvests V8 JS
// coverage organically (no instrumentation of the served files). The coverage
// is handed to monocart-coverage-reports, which the global teardown turns into
// a branch-coverage report covering app.js + logic.js. More behaviour will be
// ported here in later steps; for now this only proves the pipeline produces a
// report for both files.

test.beforeEach(async ({ page }) => {
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
});

test.afterEach(async ({ page }) => {
  const coverage = await page.coverage.stopJSCoverage();
  const mcr = MCR(coverageOptions);
  await mcr.add(coverage);
});

test("app loads the 725 projects from data/projects.json", async ({ page }) => {
  await page.goto("/");
  // The header subtitle switches from "wczytywanie…" to "N projektów" once the
  // dataset is parsed and the first render runs.
  await expect(page.locator("#sub")).toContainText("projektów", { timeout: 15000 });
  const sub = await page.locator("#sub").textContent();
  expect(sub).toMatch(/\d+ projektów/);

  // The full list is rendered as .card elements; the dataset has 725 projects.
  await expect.poll(() => page.locator(".card").count(), { timeout: 15000 }).toBeGreaterThan(700);
});
