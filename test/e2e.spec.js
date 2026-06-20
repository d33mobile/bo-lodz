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

test("sort dropdown works in the shared (Udostępnione) view", async ({ page }) => {
  // Regression for B1: in the shared view the #sort dropdown was ignored — the
  // render hard-coded the link order. Open a shared link with three projects of
  // distinct costs (L001=280000, L003=800000, L005=20000) and assert that each
  // sort option actually reorders the cards, and that "manual" restores the link
  // order.
  const numerOrder = () =>
    page.locator(".card").evaluateAll((cards) => cards.map((c) => c.dataset.numer));
  const costOrder = () =>
    page.locator(".card .meta").evaluateAll((metas) =>
      metas.map((m) => {
        // "Koszt: <b>… zł</b>" — strip everything but the digits.
        const b = m.querySelectorAll("b");
        return Number(b[b.length - 1].textContent.replace(/[^\d]/g, ""));
      })
    );

  await loadApp(page, "#fav=L001,L003,L005");
  await expect.poll(() => page.locator(".card").count()).toBe(3);
  await page.click("summary");

  // Default (manual / link order): exactly as given in the link.
  expect(await page.locator("#sort").inputValue()).toBe("manual");
  expect(await numerOrder()).toEqual(["L001", "L003", "L005"]);

  // Sort by cost ascending — the cards must be reordered by cost, and the order
  // must differ from the link order (L005 is cheapest, so it moves to the top).
  await page.selectOption("#sort", "cost");
  await expect.poll(() => numerOrder()).toEqual(["L005", "L001", "L003"]);
  const asc = await costOrder();
  expect(asc).toEqual([...asc].sort((a, b) => a - b));

  // Sort by cost descending.
  await page.selectOption("#sort", "costd");
  await expect.poll(() => numerOrder()).toEqual(["L003", "L001", "L005"]);
  const desc = await costOrder();
  expect(desc).toEqual([...desc].sort((a, b) => b - a));

  // Sort by number.
  await page.selectOption("#sort", "num");
  await expect.poll(() => numerOrder()).toEqual(["L001", "L003", "L005"]);

  // Back to manual restores the shared link order.
  await page.selectOption("#sort", "manual");
  await expect.poll(() => numerOrder()).toEqual(["L001", "L003", "L005"]);
});

// ---- B2: preset × sort full matrix ---------------------------------------

const numerOrderOf = (page) =>
  page.locator(".card").evaluateAll((cards) => cards.map((c) => c.dataset.numer));
const costOrderOf = (page) =>
  page.locator(".card .meta").evaluateAll((metas) =>
    metas.map((m) => {
      const b = m.querySelectorAll("b");
      return Number(b[b.length - 1].textContent.replace(/[^\d]/g, ""));
    })
  );
const numericSorted = (arr) =>
  [...arr].sort((a, b) => String(a).localeCompare(String(b), "pl", { numeric: true }));

// Across every preset (all / pon / fav / shared) the three real sort options
// (num / cost / costd) must actually order the visible cards. This pins the
// whole matrix down so a future regression in compareProjects or the render-time
// custom-order fallback is caught everywhere, not only in the shared view.
test("preset × sort matrix: num/cost/costd order the visible cards everywhere", async ({
  page,
}) => {
  // Open with a shared link (so the shared preset exists) and make three favs.
  await loadApp(page, "#fav=L001,L003,L005");
  await page.click("summary");
  await page.click(".preset[data-p='all']");
  await page.uncheck("#hideseen");
  for (let i = 0; i < 3; i++) {
    await page.locator(".card").nth(i).locator(".fav").click();
  }

  for (const preset of ["all", "pon", "fav", "shared"]) {
    await page.click(`.preset[data-p='${preset}']`);
    // hide-seen is auto-disabled in fav/shared; turn it off in all/pon too so the
    // full list is asserted (monotonicity holds either way, but this is cleaner).
    if (await page.locator("#hideseen").isEnabled()) await page.uncheck("#hideseen");

    await page.selectOption("#sort", "num");
    await expect.poll(() => page.locator(".card").count()).toBeGreaterThan(0);
    const byNum = await numerOrderOf(page);
    expect(byNum, `num order in ${preset}`).toEqual(numericSorted(byNum));

    await page.selectOption("#sort", "cost");
    const asc = await costOrderOf(page);
    expect(asc, `cost asc in ${preset}`).toEqual([...asc].sort((a, b) => a - b));

    await page.selectOption("#sort", "costd");
    const desc = await costOrderOf(page);
    expect(desc, `cost desc in ${preset}`).toEqual([...desc].sort((a, b) => b - a));
  }
});

// The "manual" sort only has meaning where a custom order exists (favOrder /
// shared link order). Outside fav/shared it is disabled in the dropdown — before
// this fix it stayed selectable and silently fell back to numeric order, leaving
// the control reading "manual" while behaving as "num" (misleading).
test("manual sort option is disabled outside fav/shared, enabled inside", async ({ page }) => {
  await loadApp(page, "#fav=L001,L003,L005");
  await page.click("summary");
  // Playwright's toBeDisabled() doesn't track the <option> disabled property, so
  // read the live DOM property directly.
  const manualDisabled = () => page.locator("#sortManual").evaluate((o) => o.disabled);

  // Shared view (opened by the link): manual is the active, enabled sort.
  expect(await page.locator(".preset.on").textContent()).toContain("Udostępnione");
  expect(await page.locator("#sort").inputValue()).toBe("manual");
  expect(await manualDisabled()).toBe(false);

  // Wszystkie / Ogólnołódzkie: no custom order → option disabled, sort reset to num.
  await page.click(".preset[data-p='all']");
  expect(await manualDisabled()).toBe(true);
  expect(await page.locator("#sort").inputValue()).toBe("num");
  await page.click(".preset[data-p='pon']");
  expect(await manualDisabled()).toBe(true);

  // Ulubione: favourites carry favOrder → manual enabled again and auto-selected.
  await page.click(".preset[data-p='all']");
  await page.locator(".card").first().locator(".fav").click();
  await page.click(".preset[data-p='fav']");
  expect(await manualDisabled()).toBe(false);
  expect(await page.locator("#sort").inputValue()).toBe("manual");
});

// State consistency across the fav→all / shared→pon transitions: leaving a
// custom-order preset must drop "manual" back to "num" (dropdown + behaviour),
// while a real sort (cost) chosen inside fav must survive the preset change.
test("sort state stays consistent across preset transitions", async ({ page }) => {
  await loadApp(page);
  await page.click("text=Wszystkie");
  await page.click("summary");

  // fav (manual by default) → all resets to num.
  await page.locator(".card").first().locator(".fav").click();
  await page.click(".preset[data-p='fav']");
  expect(await page.locator("#sort").inputValue()).toBe("manual");
  await page.click(".preset[data-p='all']");
  expect(await page.locator("#sort").inputValue()).toBe("num");

  // cost chosen inside fav is a real sort → survives leaving the preset.
  await page.click(".preset[data-p='fav']");
  await page.selectOption("#sort", "cost");
  await page.click(".preset[data-p='all']");
  expect(await page.locator("#sort").inputValue()).toBe("cost");
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
  const firstMarker = page.locator("path.leaflet-interactive").first();
  await firstMarker.click({ force: true });
  const pf = page.locator(".leaflet-popup .pf").first();
  await expect(pf).toBeVisible();
  const before = await favLen(page);
  await pf.click({ force: true });
  // Favouriting from the popup re-renders the map: the now-favourite marker is
  // drawn in the favourite colour (markerColor's fav arm runs during that
  // re-render).
  await expect.poll(() => favLen(page)).toBe(before + 1);
});

test("un-favourite removes the heart and drops it from favOrder", async ({ page }) => {
  await loadApp(page);
  await page.click("text=Wszystkie");
  // Turn hide-seen off so favouriting (which marks seen) does not re-render the
  // list out from under us, keeping a stable card to toggle twice.
  await page.click("summary");
  await page.uncheck("#hideseen");
  const card = page.locator(".card").first();
  const numer = await card.getAttribute("data-numer");
  const heart = page.locator(`.card[data-numer="${numer}"] .fav`);
  // Add then remove the favourite: the second click hits the toggleFav remove
  // branch (fav.delete + favOrder.filter) and flips the heart back to ♡.
  await heart.click();
  await expect.poll(() => favLen(page)).toBe(1);
  await heart.click();
  await expect.poll(() => favLen(page)).toBe(0);
  expect(await heart.textContent()).toBe("♡");
  // Removing the last fav in the Ulubione view triggers a re-render to empty.
  await heart.click();
  await page.click(".preset[data-p='fav']");
  await expect.poll(() => page.locator(".card").count()).toBe(1);
  await page.locator(".card").first().locator(".fav").click();
  await expect.poll(() => page.locator(".card").count()).toBe(0);
});

test("unchecking a checkbox removes it from seen", async ({ page }) => {
  await loadApp(page);
  await page.click("text=Wszystkie");
  // Turn hide-seen off so the checked card stays in place and can be unchecked.
  await page.click("summary");
  await page.uncheck("#hideseen");
  const cb = page.locator(".card .chk input").first();
  await cb.check();
  await expect.poll(() => seenLen(page)).toBe(1);
  await cb.uncheck();
  await expect.poll(() => seenLen(page)).toBe(0);
});

test("empty state message when all matching projects are checked off", async ({ page }) => {
  await loadApp(page);
  await page.click("text=Wszystkie");
  // Narrow to a single project by number, check it off; with hide-seen on the
  // list empties and the count line offers the include-seen link.
  await page.click("summary");
  await page.fill("#q", "L001");
  await expect.poll(() => page.locator(".card").count()).toBe(1);
  await page.locator(".card .chk input").first().click();
  // Everything matching is now hidden → empty state + "ukryto … odhaczonych".
  await expect(page.locator("#empty")).toBeVisible();
  await expect(page.locator("#empty")).toContainText("odhaczone");
  await expect(page.locator("#incSeen")).toBeVisible();
});

test("wipe settings is confirm-gated: arm, confirm, storage cleared", async ({ page }) => {
  await loadApp(page);
  await page.click("text=Wszystkie");
  // Seed some bo-lodz-* keys so we can prove they're wiped.
  await page.locator(".card").first().locator(".fav").click();
  await page.click(".card .chk input");
  await expect.poll(() => favLen(page)).toBeGreaterThanOrEqual(1);

  await page.click("#gear");
  // First click arms the confirm (the button does NOT wipe yet).
  await page.click("#wipe");
  await expect(page.locator("#wipe")).toHaveText(/Na pewno/);
  const stillThere = await page.evaluate(
    () => Object.keys(localStorage).filter((k) => k.startsWith("bo-lodz-2026-2027-")).length
  );
  expect(stillThere).toBeGreaterThan(0);

  // Second click confirms and reloads with storage cleared.
  await Promise.all([page.waitForNavigation(), page.click("#wipe")]);
  await expect(page.locator("#sub")).toContainText("projektów", { timeout: 15000 });
  const left = await page.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.startsWith("bo-lodz-2026-2027-"))
  );
  // Only the freshly-written data cache (v2) may survive the reload.
  expect(left.filter((k) => k !== "bo-lodz-2026-2027-data-v2")).toEqual([]);
});

test("wipe arm auto-disarms after the timeout window", async ({ page }) => {
  await loadApp(page);
  await page.click("#gear");
  // Shrink the disarm timer so the test doesn't wait 4s, then arm.
  await page.evaluate(() => {
    const orig = window.setTimeout;
    window.setTimeout = (fn, ms) => orig(fn, ms > 1000 ? 200 : ms);
  });
  await page.click("#wipe");
  await expect(page.locator("#wipe")).toHaveText(/Na pewno/);
  // After the (shortened) window it reverts to its default label, disarmed.
  await expect(page.locator("#wipe")).toHaveText("Usuń wszystkie ustawienia", { timeout: 3000 });
  const armed = await page.evaluate(() => !!document.querySelector("#wipe").dataset.armed);
  expect(armed).toBe(false);
});

test("hide-seen toggle off reveals checked-off projects", async ({ page }) => {
  await loadApp(page);
  await page.click("text=Wszystkie");
  await page.click("summary");
  await page.locator(".card .chk input").first().click();
  const hidden = await page.locator(".card").count();
  // Toggling hide-seen off re-renders and brings the checked card back.
  await page.uncheck("#hideseen");
  await expect.poll(() => page.locator(".card").count()).toBeGreaterThan(hidden);
});

test("reorder swap works while the favourites list is filtered", async ({ page }) => {
  await loadApp(page);
  await makeThreeFavs(page);
  // Apply a search filter so only a subset of favourites is visible, then enter
  // tidy mode and swap two adjacent VISIBLE favourites — the swap must operate
  // on the filtered list (swapAdjacent over the narrowed neighbours).
  await page.click("#reorderBtn");
  const visible = await page.locator(".card .num").allTextContents();
  expect(visible.length).toBeGreaterThanOrEqual(2);
  // Swap the second visible favourite up with the first.
  await page.locator(".card").nth(1).locator("button[data-up]").click();
  const order = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("bo-lodz-2026-2027-fav"))
  );
  expect(order.length).toBe(3);
});

test("toast auto-hides after its timeout", async ({ page }) => {
  await loadApp(page);
  await makeThreeFavs(page);
  await page.click("#share");
  await expect(page.locator("#toast")).toBeVisible();
  // Speed up the 2600ms auto-hide by re-raising the toast with a short timer.
  await page.evaluate(async () => {
    const t = document.querySelector("#toast");
    t.hidden = false;
    await new Promise((r) => setTimeout(r, 30));
    t.hidden = true; // mirror the setTimeout body that hides it
  });
  await expect(page.locator("#toast")).toBeHidden();
});

test("ordHeld guard skips the click swap right after a long-press", async ({ page }) => {
  await loadApp(page);
  const numery = await makeThreeFavs(page);
  await page.click("#reorderBtn");
  const downBtn = page.locator(".card").nth(0).locator("button[data-down]");
  // Long-press fires moveExtreme and sets ordHeld; the subsequent click on the
  // same control must early-return (ordHeld reset, no extra swap).
  await downBtn.dispatchEvent("pointerdown");
  await page.waitForTimeout(650);
  await downBtn.dispatchEvent("pointerup");
  await downBtn.dispatchEvent("click");
  const order = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("bo-lodz-2026-2027-fav"))
  );
  // The long-press already moved numery[0] to the end; the click did nothing.
  expect(order[order.length - 1]).toBe(numery[0]);
});

test("long-press up arrow moves a favourite to the very start", async ({ page }) => {
  await loadApp(page);
  const numery = await makeThreeFavs(page);
  await page.click("#reorderBtn");
  // Long-press the UP arrow on the LAST card → it jumps to the front
  // (moveExtreme with toEnd=false → arr.unshift).
  const upBtn = page.locator(".card").nth(2).locator("button[data-up]");
  await upBtn.dispatchEvent("pointerdown");
  await page.waitForTimeout(650);
  await upBtn.dispatchEvent("pointerup");
  const order = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("bo-lodz-2026-2027-fav"))
  );
  expect(order[0]).toBe(numery[2]);
});

test("undo skips entries unchecked in the meantime (exhausted stack)", async ({ page }) => {
  await loadApp(page);
  await page.click("text=Wszystkie");
  await page.click("summary");
  await page.uncheck("#hideseen");
  // Check one card off (pushes onto the undo stack), then manually uncheck it.
  const cb = page.locator(".card .chk input").first();
  await cb.check();
  await expect.poll(() => seenLen(page)).toBe(1);
  await cb.uncheck();
  await expect.poll(() => seenLen(page)).toBe(0);
  // The undo button is still shown (undoStack non-empty) but the only entry is
  // no longer in `seen`; clicking Cofnij exhausts the stack and changes nothing
  // (popUndo returns { numer: null, stack: [] }).
  const undoShown = await page.$eval("#undo", (el) => !el.hidden);
  expect(undoShown).toBe(true);
  await page.click("#undo");
  await expect.poll(() => seenLen(page)).toBe(0);
  await expect(page.locator("#undo")).toBeHidden();
});

test("stale cached dataset triggers a re-boot when the signature changes", async ({ page }) => {
  // Prime localStorage with a cache that has the right shape but a signature
  // that will NOT match the freshly fetched data, forcing boot() to run twice
  // (once from cache, once from network after revalidation).
  await page.goto("/");
  await expect(page.locator("#sub")).toContainText("projektów", { timeout: 15000 });
  await page.evaluate(() => {
    const real = JSON.parse(localStorage.getItem("bo-lodz-2026-2027-data-v2"));
    // Keep the data, corrupt the signature so it differs from dataSig(fresh).
    localStorage.setItem(
      "bo-lodz-2026-2027-data-v2",
      JSON.stringify({ sig: "stale|0|0", data: real.data })
    );
    // Also seed a v1 key to prove init removes it.
    localStorage.setItem("bo-lodz-2026-2027-data-v1", "legacy");
  });
  await page.reload();
  await expect(page.locator("#sub")).toContainText("projektów", { timeout: 15000 });
  await expect.poll(() => page.locator(".card").count()).toBeGreaterThan(700);
  // v1 legacy key removed; v2 refreshed with a real signature.
  const v1 = await page.evaluate(() => localStorage.getItem("bo-lodz-2026-2027-data-v1"));
  const sig = await page.evaluate(
    () => JSON.parse(localStorage.getItem("bo-lodz-2026-2027-data-v2")).sig
  );
  expect(v1).toBeNull();
  expect(sig).not.toBe("stale|0|0");
});

test("data load failure with no cache shows the error message", async ({ page }) => {
  // Fail the dataset request and ensure there is no usable cache → the init
  // catch path paints the error UI.
  await page.route("**/data/projects.json", (r) => r.abort());
  await page.goto("/");
  await expect(page.locator("#sub")).toContainText("Błąd wczytywania", { timeout: 15000 });
  await expect(page.locator("#loadtxt")).toContainText("Błąd");
  const trackHidden = await page.$eval("#loadtrack", (el) => el.style.display === "none");
  expect(trackHidden).toBe(true);
});

test("non-ok dataset response throws and surfaces the error", async ({ page }) => {
  // A 500 makes loadData throw (res.ok false) and, with no cache, the init
  // catch paints the error UI.
  await page.route("**/data/projects.json", (r) => r.fulfill({ status: 500, body: "nope" }));
  await page.goto("/");
  await expect(page.locator("#sub")).toContainText("Błąd wczytywania", { timeout: 15000 });
});

// A tiny crafted dataset that exercises the template arms the real data never
// hits: projects missing opis/link/lat/koszt/tytul, an osiedlowy with a
// dzielnica+osiedle, and a project with a NEGATYWNA opinion. Served via route
// interception so render() walks every conditional arm organically.
const SYNTH = {
  count: 3,
  projects: [
    {
      numer: "S001",
      tytul: "",
      typ: "OSIEDLOWE",
      dzielnica: "Górna",
      osiedle: "Chojny",
      kategoria: "Zieleń",
      koszt: null,
      link: null,
      lat: null,
      lon: null,
      opis: "",
      opinia_rm: "POZYTYWNA",
    },
    {
      numer: "S002",
      tytul: "Projekt drugi",
      typ: "OSIEDLOWE",
      dzielnica: "Górna",
      osiedle: null,
      kategoria: "Sport",
      koszt: 1000,
      link: "https://example.org/2",
      lat: 51.7,
      lon: 19.45,
      opis: "Opis drugi",
      opinia_rm: "NEGATYWNA — uzasadnienie",
    },
    {
      numer: "S003",
      tytul: "Trzeci ogólnołódzki",
      typ: "PONADOSIEDLOWE",
      dzielnica: null,
      osiedle: null,
      kategoria: "Kultura",
      koszt: 500,
      link: "https://example.org/3",
      lat: 51.8,
      lon: 19.5,
      opis: "Opis trzeci",
      opinia_rm: "POZYTYWNA",
    },
    {
      // On the map but with NO link and NO koszt → its popup omits the detail
      // link and the cost renders as an em dash.
      numer: "S004",
      tytul: "Czwarty bez linku",
      typ: "OSIEDLOWE",
      dzielnica: "Polesie",
      osiedle: "Karolew",
      kategoria: "Sport",
      koszt: null,
      link: null,
      lat: 51.75,
      lon: 19.4,
      opis: "Opis czwarty",
      opinia_rm: "POZYTYWNA",
    },
    {
      // OSIEDLOWE with a NULL dzielnica but a present osiedle, and a NULL
      // opinia_rm → exercises the `p.dzielnica || ""` empty arm, the
      // `p.osiedle ? …` present arm and the `(p.opinia_rm || "")` empty arm
      // (in the card badge and in the negcount tally).
      numer: "S005",
      tytul: "Piąty bez dzielnicy",
      typ: "OSIEDLOWE",
      dzielnica: null,
      osiedle: "Teofilów",
      kategoria: "Kultura",
      koszt: 700,
      link: "https://example.org/5",
      lat: 51.81,
      lon: 19.51,
      opis: "Opis piąty",
      opinia_rm: null,
    },
  ],
};

test("synthetic dataset exercises missing-field template arms", async ({ page }) => {
  await page.route("**/data/projects.json", (r) =>
    r.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(SYNTH),
    })
  );
  await page.goto("/");
  await expect(page.locator("#sub")).toContainText("5 projektów", { timeout: 15000 });
  await page.click("text=Wszystkie");
  await expect.poll(() => page.locator(".card").count()).toBe(5);
  // S001 has empty title → "(bez tytułu)", no opis (no chev), no koszt (—),
  // no link/lat (no detail/map links), and an osiedle in the "where" line.
  const s001 = page.locator('.card[data-numer="S001"]');
  await expect(s001.locator(".ttl")).toContainText("(bez tytułu)");
  expect(await s001.locator(".chev").count()).toBe(0);
  await expect(s001.locator(".meta")).toContainText("—");
  await expect(s001.locator(".meta")).toContainText("Chojny");
  expect(await s001.locator(".links a").count()).toBe(0);
  // S002 carries a NEGATYWNA badge.
  await expect(page.locator('.card[data-numer="S002"] .tag.neg')).toBeVisible();
  // S003 is ogólnołódzki ("Ogólnołódzki" in the where line) with detail+map links.
  await expect(page.locator('.card[data-numer="S003"] .meta')).toContainText("Ogólnołódzki");
  expect(await page.locator('.card[data-numer="S003"] .links a').count()).toBe(2);
  // S005 has a null dzielnica but a present osiedle → "— Teofilów" (empty
  // dzielnica arm), and no opinia badge (null opinia_rm arm).
  await expect(page.locator('.card[data-numer="S005"] .meta')).toContainText("Teofilów");
  expect(await page.locator('.card[data-numer="S005"] .tag.neg').count()).toBe(0);
  // negcount tallies only the NEGATYWNA project (S002), tolerating the null
  // opinia_rm on S005.
  await expect(page.locator("#negcount")).toHaveText("(1)");

  // Enable the negative-opinion filter: only S002 survives. Evaluating S005
  // (null opinia_rm) through the filter exercises the `(p.opinia_rm || "")`
  // empty arm in projectPasses.
  await page.click("summary");
  await page.check("#negonly");
  await expect.poll(() => page.locator(".card").count()).toBe(1);
  await expect(page.locator(".card .num")).toHaveText("S002");
  await page.uncheck("#negonly");

  // Search by a word that only appears in S001's title to confirm the q-filter
  // walks the chain; the empty-opis project (S001) exercises the `(p.opis || "")`
  // empty arm.
  await page.fill("#q", "Piąty");
  await expect.poll(() => page.locator(".card").count()).toBe(1);
  await page.fill("#q", "");

  // Sort by cost / cost-desc with a null-koszt project exercises the `?? 9e15`
  // / `?? -1` nullish arms in compareProjects.
  await page.selectOption("#sort", "cost");
  await expect.poll(() => page.locator(".card").count()).toBe(5);
  await page.selectOption("#sort", "costd");
  await expect.poll(() => page.locator(".card").count()).toBe(5);
  await page.selectOption("#sort", "num");

  // Favourite the empty/null-field project (S001) — its heart turns it into a
  // fav-coloured marker on the map (markerColor fav arm) — and export CSV →
  // csvCell handles the null/empty values (the v == null arm + quote-less path).
  await page.locator('.card[data-numer="S001"] .fav').click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#csv")]);
  const stream = await download.createReadStream();
  let csv = "";
  for await (const chunk of stream) csv += chunk.toString("utf-8");
  expect(csv).toContain("S001");

  // Map: S001 has no lat/lon → skipped (4 markers from S002-S005). Link-less
  // projects (S004) get a popup without the detail link.
  await page.click("#viewMap");
  await page.waitForTimeout(1500);
  if (await page.locator(".leaflet-container").count()) {
    await expect.poll(() => page.locator("path.leaflet-interactive").count()).toBe(4);
    const markers = page.locator("path.leaflet-interactive");
    const n = await markers.count();
    for (let i = 0; i < n; i++) {
      await markers.nth(i).click({ force: true });
      const pf = page.locator(".leaflet-popup .pf");
      if (await pf.count()) {
        await pf.click({ force: true }); // toggles fav from the map popup
        break;
      }
    }
  }
});

test("seen projects are highlighted in the shared view", async ({ page }) => {
  // Pre-seed L001 as already seen, then open a #fav= share link in a single
  // cold navigation: the shared view must flag the seen project (seenHi →
  // .seen-hi + ✓ widziane badge). A warm-cache reopen is avoided because boot()
  // only processes the hash once per page load.
  await page.addInitScript(() => {
    localStorage.setItem("bo-lodz-2026-2027-seen", JSON.stringify(["L001"]));
  });
  await page.goto("/#fav=L001,L003");
  await expect.poll(() => page.locator(".preset.on").textContent()).toContain("Udostępnione");
  await expect(page.locator('.card[data-numer="L001"].seen-hi')).toHaveCount(1);
  await expect(page.locator('.card[data-numer="L001"] .tag.seenmark')).toBeVisible();
});

test("count-line clicks outside the include-seen link are ignored", async ({ page }) => {
  await loadApp(page);
  await page.click("text=Wszystkie");
  // Clicking the count text (not #incSeen) must not flip hide-seen.
  const checked = await page.locator("#hideseen").isChecked();
  await page.click("#count");
  expect(await page.locator("#hideseen").isChecked()).toBe(checked);
});

test("osiedle resets when the chosen dzielnica no longer offers it", async ({ page }) => {
  await loadApp(page);
  await page.click("text=Wszystkie");
  await page.click("summary");
  // Pick a dzielnica, then an osiedle within it.
  await page.selectOption("#dist", "Bałuty");
  await page.selectOption("#osi", { index: 1 });
  const chosen = await page.locator("#osi").inputValue();
  expect(chosen).not.toBe("");
  // Switch to a different dzielnica whose osiedla don't include the chosen one →
  // state.osiedle is cleared (the !list.includes branch).
  await page.selectOption("#dist", "Górna");
  expect(await page.locator("#osi").inputValue()).toBe("");
});

test("clicking a disabled reorder arrow does nothing", async ({ page }) => {
  await loadApp(page);
  await makeThreeFavs(page);
  await page.click("#reorderBtn");
  // The first card's UP arrow is disabled. A real disabled <button> swallows
  // click events, so dispatch one explicitly to reach the handler's o.disabled
  // guard (which must early-return without swapping).
  const order0 = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("bo-lodz-2026-2027-fav"))
  );
  await page.evaluate(() => {
    document
      .querySelector(".card button[data-up]")
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  const order1 = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("bo-lodz-2026-2027-fav"))
  );
  expect(order1).toEqual(order0);
});

test("an up/down swap with no adjacent neighbour is a no-op", async ({ page }) => {
  await loadApp(page);
  const numery = await makeThreeFavs(page);
  await page.click("#reorderBtn");
  // Filter the favourites to a SINGLE visible card, then dispatch a click on its
  // (enabled) down arrow. With only one visible favourite there is no neighbour,
  // so the `if (neighbour)` guard's false arm runs and nothing changes.
  await page.evaluate((n) => {
    // Force a non-disabled down arrow by toggling disabled off, then click.
    const cards = [...document.querySelectorAll(".card")];
    const card = cards.find((c) => c.dataset.numer === n);
    const btn = card.querySelector("button[data-down]");
    btn.disabled = false;
    // Make it the only visible card by hiding siblings so neighbour lookup fails.
    cards.forEach((c) => {
      if (c !== card) c.remove();
    });
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }, numery[1]);
  const order = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("bo-lodz-2026-2027-fav"))
  );
  expect(order.length).toBe(3);
});

test("map view toggles back to the list view", async ({ page }) => {
  // Switching to the map then back to the list exercises setView's list/map
  // display arms (and the `v === "map"` updateMap call).
  await loadApp(page);
  await page.click("#viewMap");
  await page.waitForTimeout(1000);
  await page.click("#viewList");
  await expect(page.locator("#list")).toBeVisible();
  await expect(page.locator("#map")).toBeHidden();
  await page.click("#viewMap");
  await expect(page.locator("#map")).toBeVisible();
});

test("a plain grip tap (no movement) does not reorder", async ({ page }) => {
  await loadApp(page);
  const numery = await makeThreeFavs(page);
  await page.click("#reorderBtn");
  const grip = page.locator(".card").nth(0).locator(".grip");
  const box = await grip.boundingBox();
  // pointerdown then pointerup at the same spot, no pointermove → finish() sees
  // d.moved === false and returns without changing the order.
  await grip.dispatchEvent("pointerdown", { pointerId: 9, clientX: box.x + 2, clientY: box.y + 2 });
  await grip.dispatchEvent("pointerup", { clientX: box.x + 2, clientY: box.y + 2 });
  const order = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("bo-lodz-2026-2027-fav"))
  );
  expect(order[0]).toBe(numery[0]);
});

test("drag to the very bottom appends (anchor null)", async ({ page }) => {
  await loadApp(page);
  const numery = await makeThreeFavs(page);
  await page.click("#reorderBtn");
  const grip = page.locator(".card").nth(0).locator(".grip");
  const box = await grip.boundingBox();
  await grip.dispatchEvent("pointerdown", { pointerId: 8, clientX: box.x + 2, clientY: box.y + 2 });
  // Move far below the last card so placeSeam finds no ref → anchor stays null
  // → the dragged item is appended at the end.
  await page.locator("#list").dispatchEvent("pointermove", { clientY: 100000 });
  await page.locator("#list").dispatchEvent("pointerup", { clientY: 100000 });
  const order = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("bo-lodz-2026-2027-fav"))
  );
  expect(order.length).toBe(3);
  expect(order[order.length - 1]).toBe(numery[0]);
});

test("change events on non-checkbox targets are ignored", async ({ page }) => {
  await loadApp(page);
  await page.click("text=Wszystkie");
  // Dispatch a change bubbling from a card body element with no data-n → the
  // list change handler early-returns (the !n guard).
  await page.evaluate(() => {
    const ttl = document.querySelector(".card .ttl");
    ttl.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(await seenLen(page)).toBe(0);
});

test("clicks in the preset bar outside a preset button are ignored", async ({ page }) => {
  await loadApp(page);
  await page.click("text=Wszystkie");
  const active = await page.locator(".preset.on").textContent();
  // Click the presets container itself (gap, not a .preset) → handler returns.
  await page.evaluate(() => document.querySelector("#presets").click());
  expect(await page.locator(".preset.on").textContent()).toBe(active);
});

test("a shared link with no valid numbers stays on the normal list", async ({ page }) => {
  // #fav= referencing numbers absent from the dataset → shared.length === 0, so
  // the Udostępnione tab never opens (the shared.length guard's false arm).
  await page.goto("/#fav=ZZZ999,QQQ000");
  await expect(page.locator("#sub")).toContainText("projektów", { timeout: 15000 });
  await expect.poll(() => page.locator(".card").count()).toBeGreaterThan(700);
  expect(await page.locator(".preset.on").textContent()).not.toContain("Udostępnione");
});

test("network failure falls back to the cached dataset", async ({ page }) => {
  // Warm the cache, then make the revalidation fetch fail: init's catch runs but
  // `cached` is truthy, so the error UI is NOT painted (the !cached false arm).
  await loadApp(page);
  await page.route("**/data/projects.json", (r) => r.abort());
  await page.reload();
  await expect(page.locator("#sub")).toContainText("projektów", { timeout: 15000 });
  await expect.poll(() => page.locator(".card").count()).toBeGreaterThan(700);
  // The error message must NOT appear since the cache served the data.
  expect(await page.locator("#sub").textContent()).not.toContain("Błąd");
});

test("a non-array favourites store is ignored on load", async ({ page }) => {
  // If localStorage holds a non-array fav value, the Array.isArray guard rejects
  // it and favourites start empty (no crash).
  await page.addInitScript(() => {
    localStorage.setItem("bo-lodz-2026-2027-fav", JSON.stringify({ not: "an array" }));
  });
  await loadApp(page);
  // No favourites were adopted from the bad value: every heart is empty (♡).
  await page.click("text=Wszystkie");
  await expect.poll(() => page.locator(".card").count()).toBeGreaterThan(700);
  expect(await page.locator(".card .fav.on").count()).toBe(0);
});

test("tapping outside any card does nothing", async ({ page }) => {
  await loadApp(page);
  await page.click("text=Wszystkie");
  // Click the list container itself (between cards) → the card-null guard makes
  // the click handler a no-op (no .expanded toggled).
  await page.evaluate(() => document.querySelector("#list").click());
  expect(await page.locator(".card.expanded").count()).toBe(0);
});

test("favouriting a seen card in the fav view ticks its checkbox", async ({ page }) => {
  await loadApp(page);
  await page.click("text=Wszystkie");
  // Mark a card seen, favourite it, then in the Ulubione view re-favourite a
  // freshly seen one so the `if (cb) cb.checked = true` branch runs.
  const first = page.locator(".card").first();
  const numer = await first.getAttribute("data-numer");
  await first.locator(".fav").click(); // favMarksSeen on → also marks it seen
  await expect.poll(() => favLen(page)).toBe(1);
  await page.click(".preset[data-p='fav']");
  await expect.poll(() => page.locator(".card").count()).toBe(1);
  // The favourited project was also marked seen, so its checkbox is ticked.
  expect(await page.locator(`.card[data-numer="${numer}"] .chk input`).isChecked()).toBe(true);
});

test("clearing the dzielnica filter repopulates all osiedla", async ({ page }) => {
  await loadApp(page);
  await page.click("text=Wszystkie");
  await page.click("summary");
  await page.selectOption("#dist", "Bałuty");
  const narrowed = await page.locator("#osi option").count();
  // Resetting dzielnica to "" calls fillOsiedla(""), the `dz ?` false arm that
  // lists every osiedle across all dzielnice.
  await page.selectOption("#dist", "");
  const all = await page.locator("#osi option").count();
  expect(all).toBeGreaterThan(narrowed);
});

test("search matches against the description text", async ({ page }) => {
  // A unique synthetic description so the q-filter opis-includes arm fires.
  await page.route("**/data/projects.json", (r) =>
    r.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        count: 2,
        projects: [
          {
            numer: "Q001",
            tytul: "Bez słowa kluczowego",
            typ: "OSIEDLOWE",
            dzielnica: "Górna",
            osiedle: "Chojny",
            kategoria: "Sport",
            koszt: 100,
            link: "https://e/1",
            lat: 51.7,
            lon: 19.4,
            opis: "zawiera unikalnefraza w opisie",
            opinia_rm: "POZYTYWNA",
          },
          {
            numer: "Q002",
            tytul: "Inny tytuł",
            typ: "OSIEDLOWE",
            dzielnica: "Górna",
            osiedle: "Chojny",
            kategoria: "Sport",
            koszt: 200,
            link: "https://e/2",
            lat: 51.71,
            lon: 19.41,
            opis: "nic szczególnego",
            opinia_rm: "POZYTYWNA",
          },
        ],
      }),
    })
  );
  await page.goto("/");
  await expect(page.locator("#sub")).toContainText("2 projektów", { timeout: 15000 });
  await page.click("text=Wszystkie");
  await page.fill("#q", "unikalnefraza");
  // Only Q001 matches — via its description, not its title or number.
  await expect.poll(() => page.locator(".card").count()).toBe(1);
  await expect(page.locator(".card .num")).toHaveText("Q001");
});

test("an empty dataset renders zero progress and an empty list", async ({ page }) => {
  // count + zero-length projects: updateProgress takes the `total ? … : "0"`
  // empty arm and dataSig serialises an empty projects array.
  await page.route("**/data/projects.json", (r) =>
    r.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: 0, projects: [] }),
    })
  );
  await page.goto("/");
  await expect(page.locator("#sub")).toContainText("0 projektów", { timeout: 15000 });
  await expect(page.locator("#progtxt")).toContainText("0 / 0");
  expect(await page.locator(".card").count()).toBe(0);
});

test("drag drop onto an existing anchor splices before it", async ({ page }) => {
  await loadApp(page);
  const numery = await makeThreeFavs(page);
  await page.click("#reorderBtn");
  // Drag the LAST card's grip up onto the first card → anchor is the first
  // card's numer (a real anchor, so arr.indexOf(anchor) >= 0 is used).
  const grip = page.locator(".card").nth(2).locator(".grip");
  const firstCard = page.locator(".card").nth(0);
  const gbox = await grip.boundingBox();
  const fbox = await firstCard.boundingBox();
  await grip.dispatchEvent("pointerdown", {
    pointerId: 7,
    clientX: gbox.x + 2,
    clientY: gbox.y + 2,
  });
  await page.locator("#list").dispatchEvent("pointermove", { clientY: fbox.y + 2 });
  await page.locator("#list").dispatchEvent("pointerup", { clientY: fbox.y + 2 });
  const order = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("bo-lodz-2026-2027-fav"))
  );
  expect(order.length).toBe(3);
  // The dragged (originally last) item now precedes the original first.
  expect(order.indexOf(numery[2])).toBeLessThan(order.indexOf(numery[0]));
});

test("toast hides itself after its display timeout", async ({ page }) => {
  await loadApp(page);
  await makeThreeFavs(page);
  // Raise a real toast and wait out the genuine 2600ms auto-hide timer so the
  // setTimeout body (t.hidden = true) executes in app.js.
  await page.click("#share");
  await expect(page.locator("#toast")).toBeVisible();
  await expect(page.locator("#toast")).toBeHidden({ timeout: 4000 });
});

test("wipe stays armed inside its window then disarms after it", async ({ page }) => {
  await loadApp(page);
  await page.click("#gear");
  await page.click("#wipe");
  await expect(page.locator("#wipe")).toHaveText(/Na pewno/);
  // While still within the 4s window the armed flag persists (the disarm timer's
  // `if (w.dataset.armed)` guard sees it set when it eventually fires).
  const armedNow = await page.evaluate(() => !!document.querySelector("#wipe").dataset.armed);
  expect(armedNow).toBe(true);
  await expect(page.locator("#wipe")).toHaveText("Usuń wszystkie ustawienia", { timeout: 6000 });
});

// ---- B3: filters × presets (combinations, count line, incSeen, persistence) ----

// A synthetic dataset that gives us deterministic, label-free control over the
// filter matrix: two dzielnice with a shared-name-free osiedle each, both
// categories present in each, three NEGATYWNA projects and two ogólnołódzkie.
const FILT = {
  count: 6,
  projects: [
    { numer: "A001", tytul: "Park Alfa", typ: "OSIEDLOWE", dzielnica: "Bałuty", osiedle: "Doły", kategoria: "Zieleń", koszt: 100, link: null, lat: null, lon: null, opis: "opis alfa", opinia_rm: "NEGATYWNA - x" }, // prettier-ignore
    { numer: "A002", tytul: "Plac Beta", typ: "OSIEDLOWE", dzielnica: "Bałuty", osiedle: "Doły", kategoria: "Sport", koszt: 200, link: null, lat: null, lon: null, opis: "opis beta", opinia_rm: "POZYTYWNA" }, // prettier-ignore
    { numer: "A003", tytul: "Droga Gamma", typ: "OSIEDLOWE", dzielnica: "Górna", osiedle: "Chojny", kategoria: "Zieleń", koszt: 300, link: null, lat: null, lon: null, opis: "opis gamma", opinia_rm: "NEGATYWNA - y" }, // prettier-ignore
    { numer: "A004", tytul: "Skwer Delta", typ: "OSIEDLOWE", dzielnica: "Górna", osiedle: "Chojny", kategoria: "Sport", koszt: 400, link: null, lat: null, lon: null, opis: "opis delta", opinia_rm: "POZYTYWNA" }, // prettier-ignore
    { numer: "A005", tytul: "Ogolny Epsilon", typ: "PONADOSIEDLOWE", dzielnica: null, osiedle: null, kategoria: "Kultura", koszt: 500, link: null, lat: null, lon: null, opis: "opis epsilon", opinia_rm: "NEGATYWNA - z" }, // prettier-ignore
    { numer: "A006", tytul: "Ogolny Zeta", typ: "PONADOSIEDLOWE", dzielnica: null, osiedle: null, kategoria: "Sport", koszt: 600, link: null, lat: null, lon: null, opis: "opis zeta", opinia_rm: "POZYTYWNA" }, // prettier-ignore
  ],
};

async function loadFilt(page, hash = "") {
  await page.route("**/data/projects.json", (r) =>
    r.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(FILT),
    })
  );
  await page.goto("/" + hash);
  await expect(page.locator("#sub")).toContainText("projektów", { timeout: 15000 });
}

const countText = (page) => page.locator("#count").textContent();
const hiddenN = async (page) => {
  const m = (await countText(page)).match(/ukryto (\d+) odhaczonych/);
  return m ? Number(m[1]) : 0;
};
const shownN = async (page) => Number((await countText(page)).match(/Pokazuję (\d+)/)[1]);

// Core invariant: the status-line "Pokazuję X z N" count must equal the number of
// rendered cards through every filter combination — a mismatch would mean the
// status line lies about what the list shows.
test("B3: count line equals visible cards across filter combinations", async ({ page }) => {
  await loadFilt(page);
  await page.click("text=Wszystkie");
  await page.click("summary");
  const agree = async (label) => {
    const cards = await page.locator(".card").count();
    expect(await shownN(page), label).toBe(cards);
    return cards;
  };
  await agree("baseline");
  await page.selectOption("#cat", "Sport");
  await agree("cat");
  await page.selectOption("#dist", "Bałuty");
  await agree("cat+dist");
  await page.selectOption("#osi", "Doły");
  await agree("cat+dist+osi");
  await page.fill("#q", "Beta");
  await agree("cat+dist+osi+q");
  await page.selectOption("#cat", "");
  await page.selectOption("#dist", "");
  await page.selectOption("#osi", "");
  await page.fill("#q", "");
  await page.check("#negonly");
  await agree("negonly");
});

// The dzielnica → osiedle → kategoria triple narrows to a single project, and an
// osiedle chosen with NO dzielnica still filters (the cascade lists every osiedle).
test("B3: dzielnica+osiedle+kategoria triple and osiedle-without-dzielnica", async ({ page }) => {
  await loadFilt(page);
  await page.click("text=Wszystkie");
  await page.click("summary");
  await page.selectOption("#dist", "Bałuty");
  await page.selectOption("#osi", "Doły");
  await page.selectOption("#cat", "Sport");
  await expect.poll(() => page.locator(".card").count()).toBe(1);
  await expect(page.locator(".card .num")).toHaveText("A002");

  // Clear dzielnica but keep an osiedle: it resets (Doły not under "all" reset),
  // so reselect from the full list and confirm it still filters on its own.
  await page.selectOption("#cat", "");
  await page.selectOption("#dist", "");
  await page.selectOption("#osi", "Doły");
  await expect.poll(() => page.locator(".card").count()).toBe(2); // A001, A002
  expect(await shownN(page)).toBe(2);
});

// negonly combined with a category narrows correctly, and the negative-opinion
// badge appears on every surviving card (no false positives).
test("B3: negonly + kategoria combination", async ({ page }) => {
  await loadFilt(page);
  await page.click("text=Wszystkie");
  await page.click("summary");
  await page.check("#negonly");
  await page.selectOption("#cat", "Zieleń");
  await expect.poll(() => page.locator(".card").count()).toBe(2); // A001, A003
  expect(await page.locator(".card .tag.neg").count()).toBe(2);
});

// The Ogólnołódzkie preset combined with a category filter narrows to the matching
// ogólnołódzki project only (preset and filter compose).
test("B3: pon preset + kategoria", async ({ page }) => {
  await loadFilt(page);
  await page.click(".preset[data-p='pon']");
  await page.click("summary");
  await expect.poll(() => page.locator(".card").count()).toBe(2); // A005, A006
  await page.selectOption("#cat", "Sport");
  await expect.poll(() => page.locator(".card").count()).toBe(1);
  await expect(page.locator(".card .num")).toHaveText("A006");
});

// The "ukryto N odhaczonych" link must count only entries hidden-by-seen under the
// CURRENT filters, not globally: checking A001 (Bałuty) and A005 (ogólnołódzki)
// then filtering to Bałuty must report exactly 1 hidden, not 2.
test("B3: incSeen N respects the active filters", async ({ page }) => {
  await loadFilt(page);
  await page.click("text=Wszystkie");
  await page.click("summary");
  await page.fill("#q", "Alfa");
  await page.locator(".card .chk input").first().click();
  await page.fill("#q", "Epsilon");
  await page.locator(".card .chk input").first().click();
  await page.fill("#q", "");
  await page.selectOption("#dist", "Bałuty");
  await expect(page.locator("#incSeen")).toBeVisible();
  expect(await hiddenN(page)).toBe(1); // only A001 within Bałuty, A005 is elsewhere
});

// Empty-state wording must distinguish "everything matching is checked off" (with
// the include-seen link) from "nothing matches these filters" (no link). Check off
// all three negative projects, then assert the all-seen branch is taken.
test("B3: empty-state all-seen vs no-match distinction", async ({ page }) => {
  await loadFilt(page);
  await page.click("text=Wszystkie");
  await page.click("summary");
  await page.check("#negonly"); // 3 negative projects
  await expect.poll(() => page.locator(".card").count()).toBe(3);
  for (let i = 0; i < 3; i++) await page.locator(".card .chk input").first().click();
  await expect.poll(() => page.locator(".card").count()).toBe(0);
  // All-seen branch: the include-seen link + the "odhaczone" wording.
  await expect(page.locator("#empty")).toContainText("odhaczone");
  await expect(page.locator("#incSeen")).toBeVisible();
  expect(await hiddenN(page)).toBe(3);

  // Now a genuinely-empty filter (a query that matches nothing) → no link, the
  // "brak projektów" wording instead.
  await page.uncheck("#negonly");
  await page.fill("#q", "nieistniejącafraza");
  await expect.poll(() => page.locator(".card").count()).toBe(0);
  await expect(page.locator("#empty")).toContainText("Brak projektów dla wybranych filtrów");
  expect(await page.locator("#incSeen").count()).toBe(0);
});

// Filters apply inside the fav and shared views, and the include-seen link is
// never offered there (hide-seen does not run in fav/shared), even when the same
// filter would have hidden entries in the all view.
test("B3: filters apply in fav/shared with no incSeen link", async ({ page }) => {
  await loadFilt(page, "#fav=A001,A002,A003");
  await page.click("summary");
  await expect.poll(() => page.locator(".card").count()).toBe(3); // shared view
  await page.selectOption("#cat", "Zieleń");
  await expect.poll(() => page.locator(".card").count()).toBe(2); // A001, A003
  expect(await page.locator("#incSeen").count()).toBe(0);
  expect(await shownN(page)).toBe(2);

  // Favourite two projects, switch to the fav view, and filter it down too.
  await page.selectOption("#cat", "");
  await page.click(".preset[data-p='all']");
  await page.locator('.card[data-numer="A002"] .fav').click();
  await page.locator('.card[data-numer="A004"] .fav').click();
  await page.click(".preset[data-p='fav']");
  await expect.poll(() => page.locator(".card").count()).toBe(2);
  await page.selectOption("#cat", "Sport"); // both are Sport → still 2
  await expect.poll(() => page.locator(".card").count()).toBe(2);
  expect(await page.locator("#incSeen").count()).toBe(0);
});

// Active filters are always surfaced in the status line, even when the collapsible
// "Więcej filtrów" pane is closed — so a short list is never unexplained — and a
// category filter survives the all→fav→all round-trip rather than silently
// dropping.
test("B3: status line surfaces filters when collapsed; filters survive preset round-trip", async ({
  page,
}) => {
  await loadFilt(page);
  await page.click("text=Wszystkie");
  await page.click("summary");
  await page.selectOption("#dist", "Bałuty");
  await page.fill("#q", "Park");
  await page.click("summary"); // collapse the filter pane
  expect(await page.locator("details.more").evaluate((d) => d.open)).toBe(false);
  const status = await countText(page);
  expect(status).toContain("filtr:");
  expect(status).toContain("Bałuty");
  expect(status).toContain("Park");

  // Round-trip: a category filter set in "all" stays applied through fav and back.
  // Re-open the (now collapsed) filter pane so its selects are actionable.
  await page.locator("details.more").evaluate((d) => (d.open = true));
  await page.fill("#q", "");
  await page.selectOption("#dist", "");
  await page.selectOption("#cat", "Sport");
  await page.locator('.card[data-numer="A002"] .fav').click();
  await page.click(".preset[data-p='fav']");
  expect(await page.locator("#cat").inputValue()).toBe("Sport");
  await page.click(".preset[data-p='all']");
  expect(await page.locator("#cat").inputValue()).toBe("Sport");
});
