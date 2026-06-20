import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import MCR from "monocart-coverage-reports";
import { coverageOptions } from "./coverage-options.js";

// End-to-end behaviour suite. Each test drives the real app in Chromium and
// harvests V8 JS coverage organically (no instrumentation of the served files).
// The per-test coverage is handed to monocart-coverage-reports via `mcr.add`,
// which persists every entry into a shared cache directory so the percentages
// SUM across all tests; the global teardown materialises the final branch
// report for app.js + logic.js.
//
// These assertions are a 1:1 port of the browser part of test_e2e.py
// (test_browser): same selectors, same texts, same semantics. The Python test
// stays in place in parallel until a later step decides its fate.

const dataPath = fileURLToPath(new URL("../data/projects.json", import.meta.url));
const projects = JSON.parse(readFileSync(dataPath, "utf-8")).projects;

const SEEN_KEY = "bo-lodz-2026-2027-seen";
const FAV_KEY = "bo-lodz-2026-2027-fav";

const seenLen = (page) =>
  page.evaluate((k) => JSON.parse(localStorage.getItem(k) || "[]").length, SEEN_KEY);
const favLen = (page) =>
  page.evaluate((k) => JSON.parse(localStorage.getItem(k) || "[]").length, FAV_KEY);

// Wait for the dataset to be parsed and the first render to have produced cards.
async function loadApp(page, hash = "") {
  await page.goto("/" + hash);
  await expect(page.locator("#sub")).toContainText("projektów", { timeout: 15000 });
  await expect.poll(() => page.locator(".card").count(), { timeout: 15000 }).toBeGreaterThan(0);
}

test.beforeEach(async ({ page }) => {
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
});

test.afterEach(async ({ page }) => {
  const coverage = await page.coverage.stopJSCoverage();
  const mcr = MCR(coverageOptions);
  await mcr.add(coverage);
});

test("site loads project data", async ({ page }) => {
  await loadApp(page);
  const sub = await page.locator("#sub").textContent();
  expect(sub).toContain("projektów");
  // The dataset has 725 projects; the full list renders as .card elements.
  await expect.poll(() => page.locator(".card").count()).toBeGreaterThan(700);
});

test("ponadosiedlowe preset narrows the list", async ({ page }) => {
  await loadApp(page);
  await page.click("text=Wszystkie");
  const allN = await page.locator(".card").count();
  await page.click("text=Ogólnołódzkie");
  await expect.poll(() => page.locator(".card").count()).toBeLessThan(allN);
  const ponN = await page.locator(".card").count();
  expect(ponN).toBeGreaterThan(0);
  expect(ponN).toBeLessThan(allN);
});

test("favourite shows under Ulubione preset", async ({ page }) => {
  await loadApp(page);
  await page.click("text=Wszystkie");
  await page.click(".card .fav");
  await page.click(".preset[data-p='fav']");
  await expect.poll(() => page.locator(".card").count()).toBeGreaterThanOrEqual(1);
});

test("check-off persists across reload", async ({ page }) => {
  await loadApp(page);
  // With "hide seen" on by default the card disappears once checked, so we
  // click via selector (no stale handle) and read the seen count from storage.
  await page.click("text=Wszystkie");
  await page.click(".card .chk input");
  await expect.poll(() => seenLen(page)).toBeGreaterThanOrEqual(1);
  const n1 = await seenLen(page);
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator("#sub")).toContainText("projektów", { timeout: 15000 });
  const n2 = await seenLen(page);
  expect(n1).toBeGreaterThanOrEqual(1);
  expect(n2).toBe(n1);
});

test("undo last check-off", async ({ page }) => {
  await loadApp(page);
  // Checking a card off reveals the Cofnij button; clicking it un-checks that
  // entry (seen count drops) and the button hides again. Use "Wszystkie" with
  // hide-seen so the checked card vanishes, then undo restores it.
  await page.click("text=Wszystkie");
  const before = await seenLen(page);
  await page.click(".card .chk input");
  await expect.poll(() => seenLen(page)).toBe(before + 1);
  const undoVisible = await page.$eval("#undo", (el) => !el.hidden);
  const afterCheck = await seenLen(page);
  await page.click("#undo");
  await expect.poll(() => seenLen(page)).toBe(before);
  const afterUndo = await seenLen(page);
  const undoHidden = await page.$eval("#undo", (el) => el.hidden);
  expect(undoVisible).toBe(true);
  expect(afterCheck).toBe(before + 1);
  expect(afterUndo).toBe(before);
  expect(undoHidden).toBe(true);
});

test("favourites stay visible in Ulubione despite hide-seen", async ({ page }) => {
  await loadApp(page);
  // Favouriting marks a project seen and "hide seen" is on, yet favourites must
  // remain visible in the Ulubione preset.
  await page.click("text=Wszystkie");
  await page.click(".card .fav");
  await page.click(".preset[data-p='fav']");
  await expect.poll(() => page.locator(".card").count()).toBeGreaterThanOrEqual(1);
});

test("description blocks rendered on cards", async ({ page }) => {
  const merged = projects.some((p) => "opis" in p);
  test.skip(!merged, "details not merged into projects.json yet");
  await loadApp(page);
  await page.click("text=Wszystkie");
  await expect.poll(() => page.locator(".card .opis").count()).toBeGreaterThan(0);
});

test("negative-opinion filter", async ({ page }) => {
  await loadApp(page);
  await page.click("text=Wszystkie");
  await page.click("summary");
  await page.check("#negonly");
  // Filter narrows to cards whose project carries a NEGATYWNA Rada Miejska
  // opinion, each marked with a .tag.neg badge.
  const negData = projects.filter((p) => (p.opinia_rm || "").startsWith("NEGATYWNA")).length;
  await expect.poll(() => page.locator(".card").count()).toBeGreaterThan(0);
  const negCards = await page.locator(".card").count();
  const negBadges = await page.locator(".card .tag.neg").count();
  expect(negCards).toBeGreaterThan(0);
  expect(negCards).toBeLessThanOrEqual(negData);
  expect(negBadges).toBe(negCards);
  await page.uncheck("#negonly");
});

test("map view shows project markers", async ({ page }) => {
  await loadApp(page);
  // Leaflet is loaded from a CDN — needs network. If it fails to load the map
  // container never appears, mirroring the Python test's skip path.
  await page.click("#viewMap");
  await page.waitForTimeout(2000);
  const hasMap = await page.locator(".leaflet-container").count();
  test.skip(!hasMap, "Leaflet CDN unavailable");
  await expect.poll(() => page.locator("path.leaflet-interactive").count()).toBeGreaterThan(0);
});

test("shared link shows view-only tab and does not import favourites", async ({ page }) => {
  // A #fav= link opens a VIEW-ONLY "Udostępnione" tab listing exactly the
  // shared projects, without importing them into the user's favourites.
  await loadApp(page, "#fav=L001,L003");
  await expect.poll(() => page.locator(".preset.on").count()).toBeGreaterThan(0);
  const sharedActive = await page.locator(".preset.on").textContent();
  await expect.poll(() => page.locator(".card").count()).toBe(2);
  const sharedCards = await page.locator(".card").count();
  const favLs = await favLen(page);
  expect(sharedActive).toContain("Udostępnione");
  expect(sharedCards).toBe(2);
  expect(favLs).toBe(0);
});
