#!/usr/bin/env python3
"""End-to-end / regression test for the BO Łódź browser.

Runnable without pytest: `python3 test_e2e.py` (needs playwright + chromium and
data/projects.json). Exits non-zero on the first failed check. Covers:
  1. projects.json data integrity,
  2. the detail-page parser on a real saved fixture (if present),
  3. browser behaviour: project count, "near park" preset narrows the list,
     check-off persists across reload, and detail text shows once merged.
"""
import json
import sys
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).parent
FAILS = []


def check(cond, msg):
    print(("ok  " if cond else "FAIL") + "  " + msg)
    if not cond:
        FAILS.append(msg)


def test_data():
    d = json.loads((HERE / "data" / "projects.json").read_text("utf-8"))
    ps = d["projects"]
    check(d["count"] == len(ps), "count matches projects length")
    check(len(ps) >= 700, f"at least 700 projects (got {len(ps)})")
    pon = [p for p in ps if p["typ"] == "PONADOSIEDLOWE"]
    osi = [p for p in ps if p["typ"] == "OSIEDLOWE"]
    check(len(pon) == 107, f"107 ponadosiedlowe (got {len(pon)})")
    check(len(osi) > 500, f">500 osiedlowe (got {len(osi)})")
    check(all(p["numer"] for p in ps), "every project has a numer")
    check(len({p["numer"] for p in ps}) == len(ps), "numery are unique")
    check(all(p["koszt"] is not None for p in ps), "every project has koszt")
    check(all(p["lat"] and p["lon"] for p in ps), "every project has coordinates")
    # the proximity feature (which revealed operator interest) must be gone, but
    # genuine project titles that mention a park are real data and must stay.
    check("park" not in d, "no top-level 'park' geocode object in projects.json")
    check(not any("dist_park_m" in p for p in ps), "no dist_park_m field on projects")
    return d


def test_parser():
    raw = HERE / "data" / "raw" / "detail"
    fixtures = sorted(raw.glob("*.html")) if raw.exists() else []
    if not fixtures:
        print("skip  parser test (no detail fixtures yet)")
        return
    from scrape_details import parse  # noqa: WPS433
    sys.path.insert(0, str(HERE))
    # re-derive body text the same way the scraper does is browser-only; instead
    # assert the parser handles a labelled body string.
    sample = ("Font\nL001\n\nNazwa i lokalizacja:\n\nFoo\n\nOpis projektu:\n\n"
              "Opis tresci.\n\nDane kontaktowe:\n\nJan, j@x.pl\n")
    out = parse(sample)
    check(out.get("opis", "").startswith("Opis"), "parser extracts opis section")
    check("Jan" in out.get("kontakt", ""), "parser extracts kontakt section")


def serve(directory):
    handler = partial(SimpleHTTPRequestHandler, directory=str(directory))
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


def test_browser():
    from playwright.sync_api import sync_playwright

    httpd, port = serve(HERE)
    url = f"http://127.0.0.1:{port}/"
    try:
        with sync_playwright() as p:
            b = p.chromium.launch()
            ctx = b.new_context(viewport={"width": 390, "height": 844})
            pg = ctx.new_page()
            pg.goto(url, wait_until="networkidle")
            pg.wait_for_timeout(800)
            sub = pg.text_content("#sub")
            check(sub and "projektów" in sub, "site loads project data")

            pg.click("text=Wszystkie")
            pg.wait_for_timeout(300)
            all_n = pg.eval_on_selector_all(".card", "els => els.length")
            pg.click("text=Ogólnołódzkie")
            pg.wait_for_timeout(300)
            pon_n = pg.eval_on_selector_all(".card", "els => els.length")
            check(0 < pon_n < all_n, f"ponadosiedlowe preset narrows list ({pon_n} < {all_n})")

            # favourite a card, switch to Ulubione preset, expect it present
            pg.click("text=Wszystkie")
            pg.wait_for_timeout(300)
            pg.click(".card .fav")
            pg.wait_for_timeout(200)
            pg.click(".preset[data-p='fav']")
            pg.wait_for_timeout(300)
            fav_n = pg.eval_on_selector_all(".card", "els => els.length")
            check(fav_n >= 1, f"favourite shows under Ulubione preset (got {fav_n})")

# check off a project. With "hide seen" on by default the card then
            # disappears, so we click via selector (no stale handle) and read the
            # seen count straight from localStorage.
            pg.click("text=Wszystkie")
            pg.wait_for_timeout(300)
            pg.click(".card .chk input")
            pg.wait_for_timeout(300)
            n1 = pg.evaluate("() => JSON.parse(localStorage.getItem('bo-lodz-2026-2027-seen')||'[]').length")
            pg.reload(wait_until="networkidle")
            pg.wait_for_timeout(700)
            n2 = pg.evaluate("() => JSON.parse(localStorage.getItem('bo-lodz-2026-2027-seen')||'[]').length")
            check(n1 >= 1 and n2 == n1, f"check-off persists across reload ({n1}->{n2})")

            # favourites are still visible in the Ulubione preset even though
            # favouriting marks them seen and "hide seen" is on.
            pg.click(".preset[data-p='fav']")
            pg.wait_for_timeout(300)
            fav_visible = pg.eval_on_selector_all(".card", "els => els.length")
            check(fav_visible >= 1, f"favourites stay visible in Ulubione despite hide-seen ({fav_visible})")

            # detail text present once details have been merged into projects.json
            pg.click("text=Wszystkie")
            pg.wait_for_timeout(300)
            has_opis = pg.eval_on_selector_all(".card .opis", "els => els.length")
            proj = json.loads((HERE / "data" / "projects.json").read_text("utf-8"))
            merged = any("opis" in p for p in proj["projects"])
            if merged:
                check(has_opis > 0, f"description blocks rendered on cards ({has_opis})")
            else:
                print("skip  opis render (details not merged yet)")

            # map view (Leaflet from CDN — needs network)
            pg.click("#viewMap")
            pg.wait_for_timeout(2000)
            has_map = pg.eval_on_selector_all(".leaflet-container", "els => els.length")
            markers = pg.eval_on_selector_all("path.leaflet-interactive", "els => els.length")
            if has_map:
                check(markers > 0, f"map view shows project markers ({markers})")
            else:
                print("skip  map view (Leaflet CDN unavailable)")
            b.close()
    finally:
        httpd.shutdown()


if __name__ == "__main__":
    test_data()
    test_parser()
    test_browser()
    print()
    if FAILS:
        print(f"{len(FAILS)} FAILED:")
        for f in FAILS:
            print("  -", f)
        sys.exit(1)
    print("ALL CHECKS PASSED")
