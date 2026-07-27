# Slice 03 — zdarzenie kosztowe także dla przebiegów zakończonych niepowodzeniem

> Wykonawca: Cursor. Architekt/recenzent: Claude Code. Pracujesz WYŁĄCZNIE w tym drzewie roboczym.
> Gałąź bazowa: `deploy/upstream-sync-20260727` (to jest stan produkcyjny). Gałąź robocza: `feat/koszt-przebiegow-padlych`.

## Problem (zmierzony na żywej bazie 2026-07-27, nie z dokumentacji)

Tabela `cost_events` dostaje wiersz **tylko dla przebiegów zakończonych powodzeniem**. Dowód z produkcji, doba 27.07:

| stan przebiegu | liczba | ma zdarzenie kosztowe |
|---|---|---|
| `succeeded` | 239 | **wszystkie** |
| `failed` | 329 | **żaden** |
| `cancelled` | 5 | żaden |

Skutek: przebieg, który przepracował kilkanaście tur i dopiero potem uderzył w limit dostawcy, **spalił tokeny i zniknął bez śladu w rozliczeniu**. Zmierzona rozbieżność za tę dobę: licznik platformy pokazuje 5,27 mln tokenów wyjścia, a sumy z dzienników sesji dają 11,08 mln. Czyli **licznik jest ślepy dokładnie na tę część zużycia, która była czystą stratą** — a to ona jest najważniejsza do pilnowania.

To blokuje sensowny hamulec budżetowy: polityka licząca połowę zużycia nie ochroni przed niczym.

## Zakres

Emitować zdarzenie kosztowe również dla przebiegów `failed` i `cancelled`, na podstawie zużycia, które przebieg faktycznie poniósł, zanim padł.

### Co zbadać przed pisaniem

1. `heartbeat_runs.usage_json` — czy zawiera zużycie tokenów przebiegu, w jakim kształcie i czy jest wypełniane także przy niepowodzeniu. **To jest kluczowe pytanie tego zadania.** Jeśli jest puste przy awarii — znajdź, gdzie kończy zapis zużycia, i wciągnij tę wartość, zanim przebieg zostanie oznaczony jako padły.
2. Gdzie dziś powstaje wiersz `cost_events` (szukaj po `cost_events` w `server/src/services`) i dlaczego ścieżka niepowodzenia go omija.
3. Kolumna `cost_events.cost_status` oraz migracja `packages/db/src/migrations/0147_cost_event_status.sql` — **istnieje już pojęcie statusu zdarzenia kosztowego. Użyj go zamiast wymyślać własne.** Sprawdź, jakie wartości dopuszcza i czy któraś pasuje na „przebieg nieudany".

### Kryteria akceptacji

- Przebieg zakończony niepowodzeniem po wykonaniu jakiejkolwiek pracy tworzy wiersz `cost_events` z rzeczywistą liczbą tokenów wejścia, wyjścia i z pamięci podręcznej.
- Wiersz jest **odróżnialny** od zdarzenia z przebiegu udanego (przez `cost_status` albo istniejące pole — nie dokładaj kolumny, jeśli da się bez tego).
- Przebieg, który padł **nie wykonawszy nic** (zero zużycia), nie tworzy pustego wiersza-śmiecia.
- Ścieżka powodzenia **niezmieniona** — te same wartości co dziś, potwierdzone testem.
- Brak podwójnego liczenia: jeden przebieg = najwyżej jedno zdarzenie kosztowe (dziś zachodzi: 241 zdarzeń na 241 różnych identyfikatorów przebiegu).
- Testy pokrywające: przebieg udany, przebieg padły z zużyciem, przebieg padły bez zużycia, przebieg anulowany.

## Ograniczenia (obowiązują bezwzględnie)

- **Nie dotykasz VPS ani produkcji.** Praca wyłącznie w tym drzewie roboczym na Macu.
- **Nie modyfikujesz testów pierwowzoru**, żeby przeszły. Jeśli test pierwowzoru pada — to sygnał, że zmiana jest zła, nie że test jest zły.
- **Przed oceną błędów typów wykonaj `pnpm install`** — po wciągnięciu paczki od twórców zależności bywają nieaktualne i błędy są mylące (kosztowało nas już godzinę).
- Zmiana ma być minimalna i mieścić się w naszej warstwie ponad pierwowzorem; im mniej, tym taniej przy kolejnej synchronizacji.
- Komunikaty commitów: konwencjonalne, po polsku, `feat(costs): ...`.
- Na końcu: `pnpm test` (albo węższy zestaw dotyczący kosztów) **zielony**, wynik wypisz.

## Czego NIE robisz

- Nie zmieniasz metryki polityk budżetowych (osobne zadanie).
- Nie zmieniasz logiki ponawiania (osobne zadanie).
- Nie wdrażasz. Zatrzymujesz się na zacommitowanej gałęzi i raporcie.
