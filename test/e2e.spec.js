import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
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

// gzip + base64url encode in Node, matching logic.gzipB64 (the app's gunzipB64
// uses DecompressionStream("gzip"), which accepts a standard gzip stream).
const favzEncode = (str) =>
  gzipSync(Buffer.from(str, "utf-8"))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

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

// ---- targeted coverage tests (C4): exercise the still-uncovered branches ----

// Favourite the first three visible cards under "Wszystkie" and switch to the
// Ulubione preset (manual sort). Returns the ordered numery now in favourites.
async function makeThreeFavs(page) {
  await page.click("text=Wszystkie");
  const numery = [];
  for (let i = 0; i < 3; i++) {
    const card = page.locator(".card").nth(i);
    numery.push(await card.getAttribute("data-numer"));
    await card.locator(".fav").click();
  }
  await page.click(".preset[data-p='fav']");
  await expect.poll(() => page.locator(".card").count()).toBe(3);
  return numery;
}

test("settings panel: open, toggle favMarksSeen off, marker size slider", async ({ page }) => {
  await loadApp(page);
  // Open the gear panel.
  await page.click("#gear");
  await expect(page.locator("#settings")).toBeVisible();
  expect(await page.locator("#setFavSeen").isChecked()).toBe(true);

  // Turn off "♥ marks seen" — favouriting must then NOT mark the project seen.
  await page.uncheck("#setFavSeen");
  const persisted = await page.evaluate(
    () => JSON.parse(localStorage.getItem("bo-lodz-2026-2027-settings")).favMarksSeen
  );
  expect(persisted).toBe(false);
  await page.click("#setClose");
  await expect(page.locator("#settings")).toBeHidden();

  await page.click("text=Wszystkie");
  const before = await seenLen(page);
  await page.locator(".card").first().locator(".fav").click();
  // favMarksSeen off → seen count unchanged.
  expect(await seenLen(page)).toBe(before);

  // Re-open and move the marker-size slider; the readout reflects the new value
  // and it persists to settings.
  await page.click("#gear");
  await page.locator("#setSize").fill("12");
  await page.locator("#setSize").dispatchEvent("input");
  await expect(page.locator("#setSizeVal")).toHaveText("12");
  const sz = await page.evaluate(
    () => JSON.parse(localStorage.getItem("bo-lodz-2026-2027-settings")).markerSize
  );
  expect(sz).toBe(12);
  // Close by clicking the backdrop (the #settings element itself).
  await page.click("#settings", { position: { x: 5, y: 5 } });
  await expect(page.locator("#settings")).toBeHidden();
});

test("settings: marker size re-renders map while map view is active", async ({ page }) => {
  await loadApp(page);
  await page.click("#viewMap");
  await page.waitForTimeout(1500);
  const hasMap = await page.locator(".leaflet-container").count();
  test.skip(!hasMap, "Leaflet CDN unavailable");
  await page.click("#gear");
  await page.locator("#setSize").fill("3");
  await page.locator("#setSize").dispatchEvent("input");
  await page.locator("#setSize").fill("14");
  await page.locator("#setSize").dispatchEvent("input");
  await expect(page.locator("#setSizeVal")).toHaveText("14");
  // Markers should still be present after the live re-render.
  await page.click("#setClose");
  await expect.poll(() => page.locator("path.leaflet-interactive").count()).toBeGreaterThan(0);
});

test("reorder mode: tidy layout, up/down swap, tap-expand", async ({ page }) => {
  await loadApp(page);
  const numery = await makeThreeFavs(page);
  // Enter tidy/reorder mode.
  await page.click("#reorderBtn");
  await expect(page.locator("#list.reorder")).toHaveCount(1);
  await expect(page.locator("#reorderBtn")).toHaveText("✓ Gotowe");
  // ↑/↓ controls are present in tidy mode.
  await expect(page.locator(".card .ord").first()).toBeVisible();

  // Move the 2nd card up — it swaps with the 1st.
  await page.locator(".card").nth(1).locator("button[data-up]").click();
  const orderAfterUp = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("bo-lodz-2026-2027-fav"))
  );
  expect(orderAfterUp[0]).toBe(numery[1]);
  expect(orderAfterUp[1]).toBe(numery[0]);

  // Move the (now) 1st card down — swaps back.
  await page.locator(".card").nth(0).locator("button[data-down]").click();
  const orderAfterDown = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("bo-lodz-2026-2027-fav"))
  );
  expect(orderAfterDown[0]).toBe(numery[0]);

  // Tap-expand on a card body (not on a control) toggles .expanded.
  await page.locator(".card").first().locator(".ttl").click();
  await expect(page.locator(".card.expanded")).toHaveCount(1);
});

test("reorder long-press moves favourite to the extreme", async ({ page }) => {
  await loadApp(page);
  const numery = await makeThreeFavs(page);
  await page.click("#reorderBtn");
  // Long-press the down arrow on the FIRST card → it jumps to the end.
  const downBtn = page.locator(".card").nth(0).locator("button[data-down]");
  await downBtn.dispatchEvent("pointerdown");
  await page.waitForTimeout(650); // exceeds the 450ms long-press threshold
  await downBtn.dispatchEvent("pointerup");
  const order = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("bo-lodz-2026-2027-fav"))
  );
  expect(order[order.length - 1]).toBe(numery[0]);
});

test("drag-and-drop reorder via grip pointer events", async ({ page }) => {
  await loadApp(page);
  const numery = await makeThreeFavs(page);
  await page.click("#reorderBtn");
  const firstGrip = page.locator(".card").nth(0).locator(".grip");
  const thirdCard = page.locator(".card").nth(2);
  const gripBox = await firstGrip.boundingBox();
  const targetBox = await thirdCard.boundingBox();
  // Drag the first card's grip below the third card.
  await firstGrip.dispatchEvent("pointerdown", {
    pointerId: 1,
    clientX: gripBox.x + 2,
    clientY: gripBox.y + 2,
  });
  await page.locator("#list").dispatchEvent("pointermove", {
    clientY: targetBox.y + targetBox.height + 5,
  });
  await page.locator("#list").dispatchEvent("pointerup", {
    clientY: targetBox.y + targetBox.height + 5,
  });
  const order = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("bo-lodz-2026-2027-fav"))
  );
  // The first favourite is no longer at index 0 after the drag.
  expect(order.length).toBe(3);
  expect(order[0]).not.toBe(numery[0]);
});

test("CSV export downloads favourites with header and rows", async ({ page }) => {
  await loadApp(page);
  await makeThreeFavs(page);
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#csv")]);
  expect(download.suggestedFilename()).toBe("bo-lodz-ulubione.csv");
  const stream = await download.createReadStream();
  let content = "";
  for await (const chunk of stream) content += chunk.toString("utf-8");
  expect(content).toContain("Numer");
  expect(content).toContain("Tytuł");
  // BOM + header + 3 data rows = 4 CRLF-separated lines.
  const lines = content
    .replace(/^\uFEFF/, "")
    .trim()
    .split("\r\n");
  expect(lines.length).toBe(4);
});

test("share copies a gzip #favz= link to the clipboard", async ({ page }) => {
  await loadApp(page);
  await makeThreeFavs(page);
  await page.click("#share");
  await expect(page.locator("#toast")).toBeVisible();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain("#favz=");
});

test("share with no favourites shows a toast and copies nothing", async ({ page }) => {
  await loadApp(page);
  // With zero favourites the share handler short-circuits with a toast. The
  // #share button lives in the hidden favtools bar, but the handler is still
  // bound, so invoke it directly and read the toast it raises.
  const toastText = await page.evaluate(async () => {
    document.querySelector("#share").click();
    await new Promise((r) => setTimeout(r, 50));
    return document.querySelector("#toast").textContent;
  });
  expect(toastText).toContain("Brak ulubionych");
});

test("favtools is hidden when there are zero favourites", async ({ page }) => {
  await loadApp(page);
  await expect(page.locator("#favtools")).toBeHidden();
});

test("import via gzip #favz= link opens the shared view", async ({ page }) => {
  // Open a real gzip+base64url payload as the FIRST navigation so boot() runs
  // the #favz= import (it only fires once per page load).
  const favz = favzEncode("L001,L003,L005");
  await loadApp(page, "#favz=" + favz);
  await expect.poll(() => page.locator(".preset.on").textContent()).toContain("Udostępnione");
  await expect.poll(() => page.locator(".card").count()).toBe(3);
});

test("malformed #favz= link is ignored (gunzip catch path)", async ({ page }) => {
  await page.goto("/#favz=not-valid-gzip!!!");
  await expect(page.locator("#sub")).toContainText("projektów", { timeout: 15000 });
  // Falls back to the normal list, no shared tab.
  await expect.poll(() => page.locator(".card").count()).toBeGreaterThan(700);
  expect(await page.locator(".preset.on").textContent()).not.toContain("Udostępnione");
});

test("category / dzielnica / osiedle cascade filters", async ({ page }) => {
  await loadApp(page);
  await page.click("text=Wszystkie");
  await page.click("summary");
  const allN = await page.locator(".card").count();
  // Category filter narrows the list.
  await page.selectOption("#cat", { index: 1 });
  await expect.poll(() => page.locator(".card").count()).toBeLessThan(allN);
  await page.selectOption("#cat", "");

  // Dzielnica filter repopulates the osiedle dropdown and narrows the list.
  await page.selectOption("#dist", "Bałuty");
  const distN = await page.locator(".card").count();
  expect(distN).toBeLessThan(allN);
  const osiOpts = await page.locator("#osi option").count();
  expect(osiOpts).toBeGreaterThan(1);
  // Pick a concrete osiedle.
  await page.selectOption("#osi", "Bałuty Doły");
  await expect.poll(() => page.locator(".card").count()).toBeLessThanOrEqual(distN);
});

test("search query filters by title/number", async ({ page }) => {
  await loadApp(page);
  await page.click("text=Wszystkie");
  const allN = await page.locator(".card").count();
  await page.fill("#q", "L001");
  await expect.poll(() => page.locator(".card").count()).toBeLessThan(allN);
  await page.fill("#q", "");
});

test("sort by cost ascending, descending and manual", async ({ page }) => {
  await loadApp(page);
  await page.click("text=Wszystkie");
  await page.click("summary");
  // Ascending cost.
  await page.selectOption("#sort", "cost");
  await expect.poll(() => page.locator(".card").count()).toBeGreaterThan(0);
  // Descending cost.
  await page.selectOption("#sort", "costd");
  await expect.poll(() => page.locator(".card").count()).toBeGreaterThan(0);
  // Manual sort outside the fav preset resets to num on preset change.
  await page.selectOption("#sort", "manual");
  await page.click(".preset[data-p='pon']");
  expect(await page.locator("#sort").inputValue()).toBe("num");
});

test("incSeen link reveals hidden checked-off projects", async ({ page }) => {
  await loadApp(page);
  await page.click("text=Wszystkie");
  // Check off the first card; with hide-seen on it disappears and the count
  // line offers an "include N seen" link. Use click (not check) — the box
  // vanishes after the re-render so check()'s state-poll would chase ghosts.
  await page.locator(".card .chk input").first().click();
  await expect(page.locator("#incSeen")).toBeVisible();
  await page.click("#incSeen");
  // hide-seen is now off and the checkbox reflects that.
  expect(await page.locator("#hideseen").isChecked()).toBe(false);
});

test("scroll-to-top button appears past the fold and scrolls up", async ({ page }) => {
  await loadApp(page);
  await page.click("text=Wszystkie");
  await page.evaluate(() => {
    window.scrollTo(0, 1200);
    window.dispatchEvent(new Event("scroll"));
  });
  await expect(page.locator("#scrolltop")).toBeVisible();
  await page.click("#scrolltop");
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.scrollY)).toBeLessThan(600);
});

test("map popup add-to-favourites toggles the favourite", async ({ page }) => {
  await loadApp(page);
  await page.click("#viewMap");
  await page.waitForTimeout(2000);
  const hasMap = await page.locator(".leaflet-container").count();
  test.skip(!hasMap, "Leaflet CDN unavailable");
  // Markers overlap, so open the first one's popup with a forced click (do not
  // let Playwright bail on an intercepting neighbour marker).
  await page.locator("path.leaflet-interactive").first().click({ force: true });
  await expect(page.locator(".leaflet-popup .pf")).toBeVisible();
  const before = await favLen(page);
  await page.click(".leaflet-popup .pf", { force: true });
  await expect.poll(() => favLen(page)).toBe(before + 1);
});
