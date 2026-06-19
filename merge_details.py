#!/usr/bin/env python3
"""E4: merge scraped detail pages (data/details.json) into data/projects.json.

Adds the full description and a few useful fields to every project so the static
site can show them. Idempotent — re-running just refreshes the merged fields.
"""
import json
from pathlib import Path

DATA = Path(__file__).parent / "data"
PROJECTS = DATA / "projects.json"
DETAILS = DATA / "details.json"

# project field  <-  details field
FIELDS = {
    "opis": "opis",
    "adres": "nazwa_lokalizacja",
    "lokalizacja_dodatkowa": "lokalizacja_dodatkowa",
    "kontakt": "kontakt",
    "analiza_formalna": "analiza_formalna",
    "opinia_rm": "opinia_rm",   # Opinia Rady Miejskiej (POZYTYWNA/NEGATYWNA)
}


def main():
    proj = json.loads(PROJECTS.read_text("utf-8"))
    det = json.loads(DETAILS.read_text("utf-8"))
    merged = 0
    for p in proj["projects"]:
        d = det.get(p["numer"])
        if not d:
            continue
        for dst, src in FIELDS.items():
            v = d.get(src)
            if isinstance(v, str):
                v = v.strip()
            if v:
                p[dst] = v
        merged += 1
    proj["count"] = len(proj["projects"])
    PROJECTS.write_text(json.dumps(proj, ensure_ascii=False, indent=1), "utf-8")
    missing = len(proj["projects"]) - merged
    print(f"merged details into {merged}/{len(proj['projects'])} projects"
          + (f" ({missing} without a detail entry)" if missing else ""))


if __name__ == "__main__":
    main()
