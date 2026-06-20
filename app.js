import * as logic from "./logic.js";

const SKEY = "bo-lodz-2026-2027-seen";
const FKEY = "bo-lodz-2026-2027-fav";
const SETKEY = "bo-lodz-2026-2027-settings";
let settings = { favMarksSeen: true, markerSize: 7 };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem(SETKEY) || "{}"));
} catch {}
function saveSettings() {
  localStorage.setItem(SETKEY, JSON.stringify(settings));
}
let DATA = [];
let seen = new Set();
let favOrder = []; // ordered list of favourite numery (source of truth)
let fav = new Set();
let shared = [],
  sharedSet = new Set(); // a shared list opened from #fav= (view only)
const $ = (s) => document.querySelector(s);

try {
  seen = new Set(JSON.parse(localStorage.getItem(SKEY) || "[]"));
} catch {}
try {
  const a = JSON.parse(localStorage.getItem(FKEY) || "[]");
  if (Array.isArray(a)) favOrder = a;
} catch {}
fav = new Set(favOrder);
function saveSeen() {
  localStorage.setItem(SKEY, JSON.stringify([...seen]));
}
function saveFav() {
  localStorage.setItem(FKEY, JSON.stringify(favOrder));
}

const state = {
  preset: "all",
  q: "",
  cat: "",
  dist: "",
  osiedle: "",
  sort: "num",
  hideseen: true,
  reorder: false,
  view: "list",
  negonly: false,
};
let OSIEDLA = {}; // dzielnica -> sorted [osiedle]

const fmtCost = logic.fmtCost;
const esc = logic.esc;
const csvCell = logic.csvCell;

// thin DOM-side wrappers binding the current state/sets into the pure logic
function passes(p, ignoreSeen) {
  return logic.projectPasses(state, p, { fav, sharedSet, seen }, ignoreSeen);
}
function sortFn(a, b) {
  return logic.compareProjects(state, a, b);
}

function gmaps(p) {
  return `https://www.google.com/maps?q=${p.lat},${p.lon}`;
}

// ---- render (list + status line) ----
function render() {
  const list = $("#list");
  const manual = state.preset === "fav" && state.sort === "manual";
  list.classList.toggle("favview", state.preset === "fav" || state.preset === "shared");
  list.classList.toggle("reorder", state.preset === "fav" && state.reorder);
  $("#reorderBtn").hidden = state.preset !== "fav";
  $("#reorderBtn").textContent = state.reorder ? "✓ Gotowe" : "↕ Porządkuj";
  $("#favtools").hidden = fav.size === 0 || state.preset === "shared";
  // "hide seen" doesn't apply in fav/shared views — reflect that on the control
  const seenNA = state.preset === "fav" || state.preset === "shared";
  const hs = $("#hideseen");
  hs.disabled = seenNA;
  hs.checked = seenNA ? false : state.hideseen;
  hs.closest("label").style.opacity = seenNA ? ".5" : "";
  let items = DATA.filter((p) => passes(p));
  if (state.preset === "shared")
    items.sort((a, b) => shared.indexOf(a.numer) - shared.indexOf(b.numer));
  else if (manual) items.sort((a, b) => favOrder.indexOf(a.numer) - favOrder.indexOf(b.numer));
  else items.sort(sortFn);
  // transparent status: what's shown, which filters are active, what's hidden
  const presetName = {
    all: "wszystkie",
    pon: "ogólnołódzkie",
    fav: "ulubione",
    shared: "udostępnione",
  }[state.preset];
  let status = `Pokazuję ${items.length} z ${DATA.length}`;
  if (state.preset !== "all") status += ` (${presetName})`;
  const fl = [];
  if (state.cat) fl.push(state.cat);
  if (state.dist) fl.push(state.dist);
  if (state.osiedle) fl.push(state.osiedle);
  if (state.q) fl.push(`„${state.q}"`);
  if (fl.length) status += " · filtr: " + fl.join(", ");
  let hiddenSeen = 0;
  if (state.hideseen && state.preset !== "fav" && state.preset !== "shared")
    hiddenSeen = DATA.filter((p) => passes(p, true)).length - items.length;
  $("#count").innerHTML =
    esc(status) +
    (hiddenSeen > 0
      ? ` · <a href="#" id="incSeen">ukryto ${hiddenSeen} odhaczonych — pokaż</a>`
      : "");
  $("#empty").hidden = items.length > 0;
  if (items.length === 0)
    $("#empty").textContent =
      hiddenSeen > 0
        ? "Wszystkie pasujące projekty są odhaczone — użyj linku powyżej, aby je uwzględnić."
        : "Brak projektów dla wybranych filtrów.";
  list.innerHTML = items
    .map((p, idx) => {
      const isSeen = seen.has(p.numer),
        isFav = fav.has(p.numer);
      const seenHi = isSeen && state.preset === "shared"; // highlight already-seen in shared view
      const tidy = state.preset === "fav" && state.reorder; // reorder controls only in tidy mode
      const reorder = tidy
        ? `<button class="ord" data-up="${p.numer}" title="na górę (przytrzymaj: na początek)" aria-label="w górę" ${idx === 0 ? "disabled" : ""}>↑</button>` +
          `<button class="ord" data-down="${p.numer}" title="na dół (przytrzymaj: na koniec)" aria-label="w dół" ${idx === items.length - 1 ? "disabled" : ""}>↓</button>` +
          `<button class="grip" data-grip title="Przeciągnij, aby zmienić kolejność" aria-label="Przeciągnij">≡</button>`
        : "";
      const where =
        p.typ === "PONADOSIEDLOWE"
          ? "Ogólnołódzki"
          : `${p.dzielnica || ""}${p.osiedle ? " — " + p.osiedle : ""}`;
      const addr = p.lokalizacja_dodatkowa ? `<br>${esc(p.lokalizacja_dodatkowa)}` : "";
      const opis = p.opis ? `<div class="opis"><p>${esc(p.opis)}</p></div>` : "";
      return `<div class="card${isSeen ? " seen" : ""}${seenHi ? " seen-hi" : ""}" data-numer="${p.numer}">
      <label class="chk"><input type="checkbox" data-n="${p.numer}" ${isSeen ? "checked" : ""}></label>
      <div class="body">
        <div class="tags">
          <span class="tag num">${p.numer}</span>
          <span class="tag ${p.typ === "PONADOSIEDLOWE" ? "pon" : ""}">${p.typ === "PONADOSIEDLOWE" ? "ogólnołódzki" : "osiedlowy"}</span>
          ${seenHi ? '<span class="tag seenmark">✓ widziane</span>' : ""}
          ${(p.opinia_rm || "").startsWith("NEGATYWNA") ? '<span class="tag neg" title="Rada Miejska zaopiniowała projekt negatywnie">✗ neg. opinia RM</span>' : ""}
          <button class="fav${isFav ? " on" : ""}" data-f="${p.numer}" title="Ulubiony" aria-label="Ulubiony">${isFav ? "♥" : "♡"}</button>
          ${reorder}
        </div>
        <div class="ttl">${esc(p.tytul) || "(bez tytułu)"}${p.opis ? ' <span class="chev">▾</span>' : ""}</div>
        <div class="meta">
          <b>${esc(where)}</b> · ${esc(p.kategoria)}${addr}<br>
          Koszt: <b>${fmtCost(p.koszt)}</b>
        </div>
        ${opis}
        <div class="links">
          ${p.link ? `<a href="${p.link}" target="_blank" rel="noopener">Szczegóły ↗</a>` : ""}
          ${p.lat ? `<a href="${gmaps(p)}" target="_blank" rel="noopener">Mapa ↗</a>` : ""}
        </div>
      </div>
    </div>`;
    })
    .join("");
  if (state.view === "map") updateMap();
}

function updateProgress() {
  const total = DATA.length,
    n = DATA.filter((p) => seen.has(p.numer)).length;
  $("#bar").style.width = total ? (100 * n) / total + "%" : "0";
  $("#progtxt").textContent = `Odhaczone: ${n} / ${total} · ♥ ${fav.size}`;
  $("#favtools").hidden = fav.size === 0 || state.preset === "shared";
  $("#csv").textContent = `⬇ CSV (${fav.size})`;
}

function exportCsv() {
  const cols = [
    ["numer", "Numer"],
    ["tytul", "Tytuł"],
    ["typ", "Typ"],
    ["dzielnica", "Dzielnica"],
    ["osiedle", "Osiedle"],
    ["kategoria", "Kategoria"],
    ["koszt", "Koszt (zł)"],
    ["adres", "Lokalizacja"],
    ["opinia_rm", "Opinia RM"],
    ["opis", "Opis"],
    ["link", "Link"],
  ];
  const rows = favOrder.map((n) => DATA.find((p) => p.numer === n)).filter(Boolean);
  const lines = [cols.map((c) => csvCell(c[1])).join(";")];
  rows.forEach((p) => lines.push(cols.map((c) => csvCell(p[c[0]])).join(";")));
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "bo-lodz-ulubione.csv";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 0);
}

$("#csv").addEventListener("click", exportCsv);

// ---- list interactions (reorder, fav toggle, expand) ----
$("#list").addEventListener("click", (e) => {
  // up/down reorder — short tap swaps with the adjacent visible favourite;
  // a long press (handled below) jumps to the very start/end.
  const o = e.target.closest(".ord");
  if (o) {
    if (ordHeld) {
      ordHeld = false;
      return;
    } // long-press already moved it
    if (!o.disabled) {
      const up = "up" in o.dataset,
        n = up ? o.dataset.up : o.dataset.down;
      const vis = [...$("#list").querySelectorAll(".card")].map((c) => c.dataset.numer);
      const neighbour = vis[vis.indexOf(n) + (up ? -1 : 1)];
      if (neighbour) {
        favOrder = logic.swapAdjacent(favOrder, n, neighbour);
        saveFav();
        render();
      }
    }
    return;
  }
  const f = e.target.closest(".fav");
  if (f) {
    const n = f.dataset.f;
    const adding = toggleFav(n);
    f.classList.toggle("on", adding);
    f.textContent = adding ? "♥" : "♡";
    const card = f.closest(".card");
    if (adding && seen.has(n)) {
      // only if the setting marked it seen
      const cb = card.querySelector(".chk input");
      if (cb) cb.checked = true;
      card.classList.add("seen");
    }
    if ((state.preset === "fav" && !adding) || (state.hideseen && adding && seen.has(n))) render();
    return;
  }
  // a tap anywhere on the card (not on a control/link) expands/collapses it:
  // shows the description (normal mode) or the full content (tidy mode)
  if (e.target.closest("a, button, input, label, .grip")) return;
  const card = e.target.closest(".card");
  if (card) card.classList.toggle("expanded");
});

// long-press on ↑/↓ moves the favourite to the very start/end
let ordHoldTimer = null,
  ordHeld = false;
function moveExtreme(n, toEnd) {
  favOrder = logic.moveExtreme(favOrder, n, toEnd);
  saveFav();
  render();
}
$("#list").addEventListener(
  "pointerdown",
  (e) => {
    const o = e.target.closest(".ord");
    if (!o || o.disabled) return;
    ordHeld = false;
    const up = "up" in o.dataset,
      n = up ? o.dataset.up : o.dataset.down;
    ordHoldTimer = setTimeout(() => {
      ordHeld = true;
      moveExtreme(n, !up);
    }, 450);
  },
  true
);
function clearOrdHold() {
  if (ordHoldTimer) {
    clearTimeout(ordHoldTimer);
    ordHoldTimer = null;
  }
}
$("#list").addEventListener("pointerup", clearOrdHold, true);
$("#list").addEventListener("pointercancel", clearOrdHold, true);

// shared favourite toggle (used by the list hearts and the map popups)
function toggleFav(n) {
  const adding = !fav.has(n);
  if (adding) {
    fav.add(n);
    favOrder.push(n);
    if (settings.favMarksSeen && !seen.has(n)) {
      seen.add(n);
      saveSeen();
    } // optional via settings
  } else {
    fav.delete(n);
    favOrder = favOrder.filter((x) => x !== n);
  }
  saveFav();
  updateProgress();
  return adding;
}

// drag-and-drop reordering of favourites, with a visual drop seam
(function () {
  const list = $("#list");
  let drag = null,
    seam = null;
  function others() {
    return [...list.querySelectorAll(".card")].filter((c) => c !== drag.card);
  }
  function placeSeam(clientY) {
    let ref = null;
    for (const c of others()) {
      const r = c.getBoundingClientRect();
      if (clientY < r.top + r.height / 2) {
        ref = c;
        break;
      }
    }
    drag.anchor = ref ? ref.dataset.numer : null;
    list.insertBefore(seam, ref); // ref===null -> append at end
  }
  list.addEventListener("pointerdown", (e) => {
    const g = e.target.closest(".grip");
    if (!g) return;
    e.preventDefault();
    const card = g.closest(".card");
    drag = { card, numer: card.dataset.numer, anchor: null, moved: false };
    card.classList.add("dragging");
    seam = document.createElement("div");
    seam.className = "seam";
    try {
      g.setPointerCapture(e.pointerId);
    } catch {}
    placeSeam(e.clientY);
  });
  list.addEventListener("pointermove", (e) => {
    if (!drag) return;
    e.preventDefault();
    drag.moved = true;
    placeSeam(e.clientY);
  });
  function finish() {
    if (!drag) return;
    const d = drag;
    drag = null;
    d.card.classList.remove("dragging");
    if (seam && seam.parentNode) seam.remove();
    seam = null;
    if (!d.moved) return; // a plain tap must not reorder
    let arr = favOrder.filter((x) => x !== d.numer);
    const ai = d.anchor ? arr.indexOf(d.anchor) : arr.length;
    arr.splice(ai < 0 ? arr.length : ai, 0, d.numer);
    favOrder = arr;
    saveFav();
    render();
  }
  list.addEventListener("pointerup", finish);
  list.addEventListener("pointercancel", finish);
})();

let toastT;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => {
    t.hidden = true;
  }, 2600);
}

// compact share payload: gzip + base64url (falls back to the plain list)
const gzipB64 = logic.gzipB64;
const gunzipB64 = logic.gunzipB64;
async function shareFav() {
  if (!favOrder.length) {
    toast("Brak ulubionych do udostępnienia");
    return;
  }
  let hash;
  try {
    hash =
      "CompressionStream" in window
        ? "#favz=" + (await gzipB64(favOrder.join(",")))
        : "#fav=" + encodeURIComponent(favOrder.join(","));
  } catch {
    hash = "#fav=" + encodeURIComponent(favOrder.join(","));
  }
  const url = location.origin + location.pathname + hash;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard
      .writeText(url)
      .then(() => toast(`Skopiowano link do ${favOrder.length} ulubionych`))
      .catch(() => prompt("Skopiuj link do ulubionych:", url));
  } else {
    prompt("Skopiuj link do ulubionych:", url);
  }
}
$("#share").addEventListener("click", shareFav);
$("#reorderBtn").addEventListener("click", () => {
  state.reorder = !state.reorder;
  render();
});

$("#list").addEventListener("change", (e) => {
  const n = e.target.dataset.n;
  if (!n) return;
  if (e.target.checked) seen.add(n);
  else seen.delete(n);
  saveSeen();
  updateProgress();
  e.target.closest(".card").classList.toggle("seen", e.target.checked);
  if (state.hideseen && e.target.checked) render();
});

$("#presets").addEventListener("click", (e) => {
  const b = e.target.closest(".preset");
  if (!b) return;
  state.preset = b.dataset.p;
  if (state.preset === "fav") {
    state.sort = "manual";
    $("#sort").value = "manual";
  } else {
    state.reorder = false;
    if (state.sort === "manual") {
      state.sort = "num";
      $("#sort").value = "num";
    }
  }
  [...$("#presets").children].forEach((c) => c.classList.toggle("on", c === b));
  render();
});

function fillOsiedla(dz) {
  const sel = $("#osi");
  const list = dz
    ? OSIEDLA[dz] || []
    : [...new Set(Object.values(OSIEDLA).flat())].sort((a, b) => a.localeCompare(b, "pl"));
  sel.innerHTML = '<option value="">— wszystkie —</option>';
  list.forEach((o) => {
    const op = document.createElement("option");
    op.value = op.textContent = o;
    sel.appendChild(op);
  });
  if (state.osiedle && !list.includes(state.osiedle)) state.osiedle = "";
  sel.value = state.osiedle;
}

// ---- filter controls ----
$("#q").addEventListener("input", (e) => {
  state.q = e.target.value;
  render();
});
$("#cat").addEventListener("change", (e) => {
  state.cat = e.target.value;
  render();
});
$("#dist").addEventListener("change", (e) => {
  state.dist = e.target.value;
  fillOsiedla(state.dist);
  render();
});
$("#osi").addEventListener("change", (e) => {
  state.osiedle = e.target.value;
  render();
});
$("#sort").addEventListener("change", (e) => {
  state.sort = e.target.value;
  render();
});
$("#hideseen").addEventListener("change", (e) => {
  state.hideseen = e.target.checked;
  render();
});
$("#negonly").addEventListener("change", (e) => {
  state.negonly = e.target.checked;
  render();
});
$("#count").addEventListener("click", (e) => {
  if (e.target.id === "incSeen") {
    e.preventDefault();
    state.hideseen = false;
    $("#hideseen").checked = false;
    render();
  }
});

const stbtn = $("#scrolltop");
addEventListener("scroll", () => {
  stbtn.hidden = scrollY < 600;
});
stbtn.addEventListener("click", () => scrollTo({ top: 0, behavior: "smooth" }));

// ---- map view (Leaflet) ----
let lmap = null,
  markerLayer = null;
function ensureMap() {
  if (lmap || !window.L) return lmap;
  lmap = L.map("map", { scrollWheelZoom: true }).setView([51.759, 19.457], 12);
  // OSM tile policy wants an identifying Referer; send the full app URL (not just
  // the bare github.io origin) and use the canonical tile host. See
  // https://wiki.openstreetmap.org/wiki/Referer
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap contributors",
    referrerPolicy: "no-referrer-when-downgrade",
  }).addTo(lmap);
  markerLayer = L.layerGroup().addTo(lmap);
  lmap.on("popupopen", (e) => {
    const el = e.popup.getElement().querySelector(".pf");
    if (el)
      el.addEventListener(
        "click",
        () => {
          toggleFav(el.dataset.pf);
          updateMap();
        },
        { once: true }
      );
  });
  return lmap;
}
function markerColor(p) {
  if (fav.has(p.numer)) return "#e23b5a";
  return p.typ === "PONADOSIEDLOWE" ? "#0a5f97" : "#0b6e4f";
}
function updateMap() {
  if (!ensureMap()) {
    toast("Mapa się wczytuje — spróbuj ponownie");
    return;
  }
  markerLayer.clearLayers();
  const pts = [];
  DATA.filter((p) => passes(p)).forEach((p) => {
    if (p.lat == null || p.lon == null) return;
    const col = markerColor(p);
    const m = L.circleMarker([p.lat, p.lon], {
      radius: settings.markerSize,
      weight: 2,
      color: col,
      fillColor: col,
      fillOpacity: 0.55,
    });
    m.bindPopup(
      `<div><span class="pn">${esc(p.numer)}</span> · ${fmtCost(p.koszt)}<br>` +
        `<b>${esc(p.tytul)}</b><br>${esc(p.kategoria)}` +
        (p.link ? `<br><a href="${p.link}" target="_blank" rel="noopener">Szczegóły ↗</a>` : "") +
        `<br><span class="pf" data-pf="${esc(p.numer)}">` +
        `${fav.has(p.numer) ? "♥ w ulubionych" : "♡ dodaj do ulubionych"}</span></div>`
    );
    m.addTo(markerLayer);
    pts.push([p.lat, p.lon]);
  });
  if (pts.length) lmap.fitBounds(pts, { padding: [30, 30], maxZoom: 15 });
  setTimeout(() => lmap.invalidateSize(), 80);
}
function setView(v) {
  state.view = v;
  $("#viewList").classList.toggle("on", v === "list");
  $("#viewMap").classList.toggle("on", v === "map");
  $("#list").style.display = v === "list" ? "" : "none";
  $("#map").style.display = v === "map" ? "block" : "none";
  if (v === "map") updateMap();
}
$("#viewList").addEventListener("click", () => setView("list"));
$("#viewMap").addEventListener("click", () => setView("map"));

// ---- settings (gear) ----
function openSettings() {
  $("#setFavSeen").checked = settings.favMarksSeen;
  $("#setSize").value = settings.markerSize;
  $("#setSizeVal").textContent = settings.markerSize;
  $("#settings").hidden = false;
}
$("#gear").addEventListener("click", openSettings);
$("#setClose").addEventListener("click", () => ($("#settings").hidden = true));
$("#settings").addEventListener("click", (e) => {
  if (e.target.id === "settings") $("#settings").hidden = true;
});
$("#setFavSeen").addEventListener("change", (e) => {
  settings.favMarksSeen = e.target.checked;
  saveSettings();
});
$("#setSize").addEventListener("input", (e) => {
  settings.markerSize = +e.target.value;
  $("#setSizeVal").textContent = settings.markerSize;
  saveSettings();
  if (state.view === "map") updateMap();
});
$("#wipe").addEventListener("click", () => {
  const w = $("#wipe");
  if (w.dataset.armed) {
    // second click confirms
    Object.keys(localStorage)
      .filter((k) => k.startsWith("bo-lodz-2026-2027-"))
      .forEach((k) => localStorage.removeItem(k));
    location.reload();
  } else {
    // first click arms the confirm
    w.dataset.armed = "1";
    w.classList.add("armed");
    w.textContent = "Na pewno? Kliknij ponownie, aby usunąć";
    setTimeout(() => {
      if (w.dataset.armed) {
        delete w.dataset.armed;
        w.classList.remove("armed");
        w.textContent = "Usuń wszystkie ustawienia";
      }
    }, 4000);
  }
});

// ---- data loading, boot & cache ----
async function loadData(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const total = +res.headers.get("Content-Length") || 0;
  const track = $("#loadtrack"),
    bar = $("#loadbar"),
    txt = $("#loadtxt");
  if (!total) track.classList.add("indet");
  if (!res.body || !res.body.getReader) return res.json();
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (total) {
      bar.style.width = (Math.min(got / total, 1) * 100).toFixed(0) + "%";
      txt.textContent = `Wczytywanie projektów… ${(got / 1048576).toFixed(1)} MB`;
    }
  }
  const buf = new Uint8Array(got);
  let pos = 0;
  for (const c of chunks) {
    buf.set(c, pos);
    pos += c.length;
  }
  bar.style.width = "100%";
  return JSON.parse(new TextDecoder("utf-8").decode(buf));
}

function hideLoading() {
  const el = $("#loading");
  el.classList.add("hide");
  setTimeout(() => {
    el.style.display = "none";
  }, 350);
}

async function boot(d) {
  DATA = d.projects;
  $("#sub").textContent = `${DATA.length} projektów`;
  $("#cat").innerHTML = '<option value="">— wszystkie —</option>';
  [...new Set(DATA.map((p) => p.kategoria).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "pl"))
    .forEach((c) => {
      const o = document.createElement("option");
      o.value = o.textContent = c;
      $("#cat").appendChild(o);
    });
  $("#cat").value = state.cat;
  $("#dist").innerHTML = '<option value="">— wszystkie —</option>';
  [...new Set(DATA.map((p) => p.dzielnica).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "pl"))
    .forEach((c) => {
      const o = document.createElement("option");
      o.value = o.textContent = c;
      $("#dist").appendChild(o);
    });
  $("#dist").value = state.dist;
  OSIEDLA = logic.osiedlaMap(DATA);
  fillOsiedla(state.dist);
  $("#negcount").textContent =
    "(" + DATA.filter((p) => (p.opinia_rm || "").startsWith("NEGATYWNA")).length + ")";
  if (!boot.hashDone) {
    // a #favz=/#fav= link opens a view-only "Udostępnione" tab, once
    boot.hashDone = true;
    const mz = location.hash.match(/^#favz=(.+)$/); // gzip+base64url (new, compact)
    const m = location.hash.match(/^#fav=(.+)$/); // plain comma list (old, still supported)
    let listStr = null;
    if (mz) {
      try {
        listStr = await gunzipB64(mz[1]);
      } catch (e) {
        console.error(e);
      }
    } else if (m) {
      listStr = decodeURIComponent(m[1]);
    }
    if (listStr) {
      const valid = new Set(DATA.map((p) => p.numer));
      shared = listStr
        .split(",")
        .map((s) => s.trim())
        .filter((n) => valid.has(n));
      sharedSet = new Set(shared);
      if (shared.length) {
        $("#presetShared").hidden = false;
        state.preset = "shared";
        setTimeout(() => toast(`Udostępniona lista: ${shared.length} projektów (podgląd)`), 400);
      }
    }
  }
  [...$("#presets").children].forEach((c) =>
    c.classList.toggle("on", c.dataset.p === state.preset)
  );
  updateProgress();
  render();
  hideLoading();
}

// Cache the dataset in localStorage and serve it instantly (offline-capable),
// then revalidate in the background and re-render only if it actually changed.
// The network fetch itself rides the browser HTTP cache (ETag → cheap 304s),
// so the 1.2 MB payload is not re-downloaded on every visit.
const CACHE_KEY = "bo-lodz-2026-2027-data-v2";
// content-sensitive signature: the serialized length changes whenever any field
// is added/edited, so adding e.g. opinia_rm correctly invalidates the cache.
const dataSig = logic.dataSig;
let shownSig = null;

(async function init() {
  try {
    localStorage.removeItem("bo-lodz-2026-2027-data-v1");
  } catch {}
  let cached = null;
  try {
    cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
  } catch {}
  if (cached && cached.data && cached.data.projects) {
    shownSig = cached.sig;
    await boot(cached.data);
  }
  try {
    const fresh = await loadData("data/projects.json");
    const sig = dataSig(fresh);
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ sig, data: fresh }));
    } catch {}
    if (sig !== shownSig) {
      shownSig = sig;
      await boot(fresh);
    }
  } catch (e) {
    console.error(e);
    if (!cached) {
      $("#sub").textContent = "Błąd wczytywania danych (data/projects.json).";
      $("#loadtxt").textContent = "Błąd wczytywania danych.";
      $("#loadtrack").style.display = "none";
    }
  }
})();
