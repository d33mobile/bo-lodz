#!/usr/bin/env python3
"""Second pass: fetch the full detail page of every project (breadth -> depth).

Reads data/projects.json, opens each project's detail page in a real Chromium
(random order, jittered delays), saves the raw HTML under data/raw/detail/ and
extracts the labelled sections (description, address, author, formal-analysis
status, ...). Progress is checkpointed to data/details.json so the run is
resumable: already-scraped projects are skipped.

NOTE: the UMŁ site (budzetobywatelski.uml.lodz.pl) very likely has anti-scraping
measures (plain HTTP clients get refused; pages render via JS). We therefore use
a real browser, randomised access order, jittered delays, a single-batch lock
and a ban heuristic that aborts as soon as a page stops looking like real data.
Be polite: small batches, long pauses — do not hammer the source.
"""
import asyncio
import json
import os
import random
import re
import sys
import time
from pathlib import Path

from playwright.async_api import async_playwright

DATA = Path(__file__).parent / "data"
PROJECTS = DATA / "projects.json"
DETAILS = DATA / "details.json"
RAWDIR = DATA / "raw" / "detail"
LOCK = DATA / ".detail.lock"
BANNED = DATA / ".banned"  # marker dropped when pages stop looking like real data

# Deliberately slow + batched: one run fetches at most BATCH new projects, then
# exits, so the work is split into many gentle stages. A lockfile prevents two
# overlapping runs from hammering the server in parallel.
BATCH = int(os.environ.get("BO_BATCH", "40"))
LOCK_TTL = 900  # seconds; a stale lock older than this is ignored

# Section labels as they render in the page body, in document order. The value
# of a section is the text between its label and the next label that appears.
LABELS = [
    ("nazwa_lokalizacja", "Nazwa i lokalizacja:"),
    ("lokalizacja_dodatkowa", "Dodatkowe informacje o lokalizacji:"),
    ("rodzaj", "Rodzaj zadania / Nazwa osiedla:"),
    ("kategoria", "Kategoria projektu:"),
    ("opis", "Opis projektu:"),
    ("kontakt", "Dane kontaktowe:"),
    ("zalacznik1", "Załącznik 1:"),
    ("opinia_instytucji", "Opinia zarządzającego instytucją:"),
    ("elementy", "Elementy składowe wraz z szacunkowymi kosztami projektu:"),
    ("opinia_rm", "Opinia Rady Miejskiej:"),
    ("decyzja_kk", "Decyzja Komitetu Koordynacyjnego ds. ŁBO:"),
    ("lokalizacja_mapa", "Lokalizacja na mapie:"),
]


def parse(body):
    i = body.find("Font")  # strip the shared accessibility header
    if i >= 0:
        body = body[i + 4:]
    # locate every label occurrence
    marks = []
    for key, lab in LABELS:
        p = body.find(lab)
        if p >= 0:
            marks.append((p, key, len(lab)))
    marks.sort()
    out = {}
    for idx, (pos, key, llen) in enumerate(marks):
        end = marks[idx + 1][0] if idx + 1 < len(marks) else len(body)
        out[key] = re.sub(r"\s+\n", "\n", body[pos + llen:end]).strip()
    af = re.search(r"ANALIZA FORMALNA:\s*([^\n]+)", body)
    if af:
        out["analiza_formalna"] = af.group(1).strip()
    return out


def acquire_lock():
    if LOCK.exists():
        try:
            age = time.time() - LOCK.stat().st_mtime
        except OSError:
            age = 0
        if age < LOCK_TTL:
            print(f"another batch is running (lock age {int(age)}s) — skipping",
                  file=sys.stderr)
            return False
    LOCK.write_text(str(os.getpid()), "utf-8")
    return True


def looks_banned(html, body):
    """Heuristic: a real project page carries these section labels."""
    if not html or len(html) < 2000:
        return True
    return ("Opis projektu" not in body) and ("Nazwa i lokalizacja" not in body)


async def main():
    projects = json.loads(PROJECTS.read_text("utf-8"))["projects"]
    done = json.loads(DETAILS.read_text("utf-8")) if DETAILS.exists() else {}
    RAWDIR.mkdir(parents=True, exist_ok=True)

    todo = [p for p in projects if p["link"] and p["numer"] not in done]
    if not todo:
        print(f"all {len(done)} details already fetched — nothing to do", file=sys.stderr)
        return 0
    if not acquire_lock():
        return 0

    rng = random.Random()
    rng.shuffle(todo)            # random access, not sequential
    batch = todo[:BATCH]         # slow, bounded stage
    print("NOTE: UMŁ likely has anti-scraping protections — real browser, random "
          "order, jittered delays, single-batch lock, ban heuristic. Being polite.",
          file=sys.stderr)
    print(f"{len(done)} done, {len(todo)} remaining; this batch: {len(batch)}",
          file=sys.stderr)

    fetched = 0
    try:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch()
            ctx = await browser.new_context(locale="pl-PL")
            page = await ctx.new_page()
            for n, proj in enumerate(batch, 1):
                numer = proj["numer"]
                try:
                    await page.goto(proj["link"], wait_until="domcontentloaded",
                                    timeout=45000)
                    await page.wait_for_timeout(rng.randint(500, 1100))
                    html = await page.content()
                    body = await page.evaluate("() => document.body.innerText")
                except Exception as e:  # noqa: BLE001
                    print(f"  ! {numer}: {e}", file=sys.stderr)
                    continue
                if looks_banned(html, body):
                    BANNED.write_text(str(int(time.time())), "utf-8")
                    print(f"  !! looks banned/blocked at {numer} — aborting batch",
                          file=sys.stderr)
                    break
                (RAWDIR / f"{numer}.html").write_text(html, "utf-8")
                done[numer] = parse(body)
                fetched += 1
                if BANNED.exists():
                    BANNED.unlink()
                if fetched % 10 == 0:
                    DETAILS.write_text(json.dumps(done, ensure_ascii=False, indent=1), "utf-8")
                    print(f"  [{fetched}/{len(batch)}] checkpoint ({numer})", file=sys.stderr)
                await page.wait_for_timeout(rng.randint(1400, 3000))  # slow & polite
            await browser.close()
    finally:
        DETAILS.write_text(json.dumps(done, ensure_ascii=False, indent=1), "utf-8")
        if LOCK.exists():
            LOCK.unlink()

    print(f"\nbatch done: +{fetched}; total {len(done)}/{len(projects)} -> {DETAILS}",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    asyncio.run(main())
