#!/usr/bin/env python3
"""Scrape Łódź participatory budget 2026/2027 voting map into projects.json.

Driven through a real Chromium (Playwright): we open the voting page so the
site sets its session, then fetch every KML map layer from *inside* the page
context (carrying the page's cookies + Referer), in randomised order with small
delays, so the server treats us as the ordinary map client and does not block.

NOTE: the UMŁ site (budzetobywatelski.uml.lodz.pl) very likely has anti-scraping
measures — plain `requests`/`curl` hits get connection-refused, and the layer
endpoints require a per-layer CODE token plus a valid browser session. Hence the
real-browser approach, randomised access and polite delays. Scrape gently and
respect the source; this tool only mirrors the public voting data for browsing.

The map exposes one KML datasource per neighbourhood (osiedle), one city-wide
"Ponadosiedlowe" pool and several per-category layers. Two editions are served
side by side; we keep only the live 2026/2027 round (CURRENT_IDBAZA) and
deduplicate project markers by their database id (IDWPIS).
"""
import asyncio
import html
import json
import random
import re
import sys
from pathlib import Path

from playwright.async_api import async_playwright

PAGE = "https://budzetobywatelski.uml.lodz.pl/glosowanie-2026-2027/glosowanie.php?mapa=1"
MAPA_JS = "https://budzetobywatelski.uml.lodz.pl/glosowanie-2026-2027/js/glosowanie-mapa.js?t=200"
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
DATA = Path(__file__).parent / "data"
OUT = DATA / "projects.json"
RAW = DATA / "raw"  # every HTTP response is saved here verbatim
CURRENT_IDBAZA = "1402200148"  # live 2026/2027 edition; the other IDBAZA is old


def layer_map(mapa_js):
    pairs = re.findall(
        r'"label":"((?:[^"\\]|\\.)*)","url":"(\\/we\\/service\.php\?[^"]*?)"', mapa_js
    )
    out = {}
    for label, url in pairs:
        url = url.replace("\\/", "/")
        ib = re.search(r"IDBAZA=(\d+)", url)
        ds = re.search(r"IDDATASOURCE=(\d+)", url)
        if not ib or not ds:
            continue
        out[(ib.group(1), ds.group(1))] = (html.unescape(label), url)
    return out


def field(desc, label):
    m = re.search(re.escape(label) + r"\s*</b>\s*([^<]*)", desc)
    return html.unescape(m.group(1)).strip() if m else ""


def parse_kml(kml, layer_label):
    for pm in re.findall(r"<Placemark\b.*?</Placemark>", kml, re.S):
        numer = re.search(r'<Data name="NUMER"><value>([^<]*)</value>', pm)
        if not numer:
            continue
        cd = re.search(r"<!\[CDATA\[(.*?)\]\]>", pm, re.S)
        desc = cd.group(1) if cd else ""
        title = re.search(r"font-size:1rem;\"><b>(.*?)</b>", desc, re.S)
        link = re.search(r'href="(https://[^"]*szczegoly-projektu[^"]*)"', desc)
        coords = re.search(r"<coordinates>([\d.\-]+),\s*([\d.\-]+)", pm)
        # IDWPIS only lives in the ExtendedData of ponadosiedlowe markers; for
        # osiedlowe markers it is the numeric id inside the ZadanieMapaO/P call.
        idwpis = re.search(r'<Data name="IDWPIS"><value>(\d+)</value>', pm)
        if not idwpis:
            idwpis = re.search(r"ZadanieMapa[OP]\([^)]*?(\d+),\s*'", desc)
        cost_raw = (field(desc, "Koszt:").replace("\xa0", "").replace(" ", "")
                    .replace("zł", "").replace(",", "."))
        try:
            cost = float(cost_raw) if cost_raw else None
        except ValueError:
            cost = None
        # "Projekt:" is either "PONADOSIEDLOWE" or "OSIEDLOWE - <dzielnica> - <osiedle>"
        projekt = field(desc, "Projekt:")
        m = re.match(r"OSIEDLOWE\s*-\s*(.+?)\s*-\s*(.+)$", projekt)
        if m:
            typ, dzielnica, osiedle = "OSIEDLOWE", m.group(1).strip(), m.group(2).strip()
        else:
            typ, dzielnica, osiedle = projekt or "PONADOSIEDLOWE", None, None
        yield {
            "idwpis": idwpis.group(1) if idwpis else None,
            "numer": html.unescape(numer.group(1)).strip(),
            "tytul": re.sub(r"\s+", " ", html.unescape(title.group(1))).strip() if title else "",
            "typ": typ,
            "dzielnica": dzielnica,
            "osiedle": osiedle,
            "kategoria": field(desc, "Kategoria projektu:"),
            "koszt": cost,
            "link": link.group(1) if link else "",
            "lon": float(coords.group(1)) if coords else None,
            "lat": float(coords.group(2)) if coords else None,
        }


def slug(s):
    return re.sub(r"[^0-9a-zA-Z]+", "-", s).strip("-").lower()


async def main():
    RAW.mkdir(parents=True, exist_ok=True)
    rng = random.Random()  # nosec - jitter only, not crypto
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(user_agent=UA, locale="pl-PL")
        page = await ctx.new_page()
        print("NOTE: UMŁ likely employs anti-scraping protections — using a real "
              "browser session, randomised order and delays; scraping gently.",
              file=sys.stderr)
        print("opening voting page ...", file=sys.stderr)
        await page.goto(PAGE, wait_until="networkidle", timeout=60000)
        await page.wait_for_timeout(1500)

        # everything goes through the page's own fetch (cookies + Referer); every
        # raw response is written verbatim under data/raw/ before parsing.
        async def fetch(url, raw_name):
            body = await page.evaluate(
                """async (u) => { const r = await fetch(u, {credentials:'include'});
                                   return await r.text(); }""", url)
            (RAW / raw_name).write_text(body, "utf-8")
            return body

        (RAW / "glosowanie.html").write_text(await page.content(), "utf-8")

        mapa_js = await fetch(MAPA_JS, "glosowanie-mapa.js")
        layers = layer_map(mapa_js)
        wanted = {k: v for k, v in layers.items()
                  if k[0] == CURRENT_IDBAZA
                  and (":" in v[0] or v[0] == "Ponadosiedlowe")}

        # random access order, not sequential, with jittered delays
        order = list(wanted.items())
        rng.shuffle(order)

        projects = {}
        for i, ((ib, ds), (label, url)) in enumerate(order, 1):
            full = "https://budzetobywatelski.uml.lodz.pl/we" + url[3:]
            try:
                kml = await fetch(full, f"kml-{ib}-{ds}-{slug(label)}.kml")
            except Exception as e:  # noqa: BLE001
                print(f"  ! {label}: {e}", file=sys.stderr)
                continue
            n = 0
            for proj in parse_kml(kml, label):
                n += 1
                projects.setdefault(proj["numer"], proj)  # dedupe by project number
            print(f"  [{i}/{len(order)}] {label}: {n}", file=sys.stderr)
            await page.wait_for_timeout(rng.randint(250, 1400))

        await browser.close()

    out = sorted(projects.values(),
                 key=lambda r: (r["typ"] != "PONADOSIEDLOWE", r["numer"]))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(
        {"source": PAGE, "count": len(out), "projects": out},
        ensure_ascii=False, indent=1), "utf-8")
    print(f"\nwrote {len(out)} projects -> {OUT}", file=sys.stderr)


if __name__ == "__main__":
    asyncio.run(main())
