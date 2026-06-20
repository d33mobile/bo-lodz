# Budżet Obywatelski Łódź 2026/2027 — przeglądarka projektów

Nieoficjalna, mobilna przeglądarka projektów z [oficjalnej mapy głosowania
UMŁ](https://budzetobywatelski.uml.lodz.pl/glosowanie-2026-2027/glosowanie.php?mapa=1).
Pozwala przejrzeć wszystkie projekty i **odhaczać te, które już się obejrzało**
(stan zapisywany lokalnie w przeglądarce, `localStorage`).

**Strona:** https://d33mobile.github.io/bo-lodz/

## Funkcje

- 725 projektów: 107 ogólnołódzkich (ponadosiedlowych) + 618 osiedlowych.
- Presety: **Wszystkie**, **Ogólnołódzkie**, **Ulubione** (♥, zapisywane lokalnie).
- Filtry: kategoria, dzielnica; sortowanie wg numeru / kosztu.
- Odhaczanie obejrzanych + pasek postępu; opcja „ukryj odhaczone".
- Pełne opisy projektów (zwijane) oraz linki do oficjalnych szczegółów i mapy Google.

## Dane

`data/projects.json` powstaje ze scrapera `scraper/scrape.py`. Mapa serwuje markery jako
warstwy KML z `/we/service.php` (jedna na osiedle, jedna ogólnomiejska). Bierzemy
tylko bieżącą edycję (`IDBAZA=1402200148`, linki `…szczegoly-projektu-2026-2027-…`)
i deduplikujemy projekty po numerze. Surowe odpowiedzi HTTP lądują w `data/raw/`.

### Ponowny scrape

```bash
pip install playwright && playwright install chromium
python3 scraper/scrape.py        # → data/projects.json + data/raw/*
```

Scraper steruje prawdziwym Chromium (Playwright): otwiera stronę głosowania, a
warstwy pobiera z kontekstu strony (cookies + Referer), w losowej kolejności z
losowymi odstępami — żeby zachowywać się jak zwykły klient mapy.

> **Uwaga:** serwis UMŁ najprawdopodobniej stosuje zabezpieczenia przeciw
> scrapingowi (zwykłe `curl`/`requests` dostają connection-refused, endpointy
> wymagają tokenu CODE i sesji przeglądarki). Stąd prawdziwa przeglądarka,
> losowa kolejność, opóźnienia i małe batche. Scrapuj delikatnie.

Pełne opisy projektów dociąga `scraper/scrape_details.py` (osobny, batchowany
przebieg po podstronach `szczegoly-projektu-…`), a `scraper/merge_details.py`
scala je z powrotem do `data/projects.json`.

---
Strona pomocnicza, nie jest powiązana z Urzędem Miasta Łodzi.
