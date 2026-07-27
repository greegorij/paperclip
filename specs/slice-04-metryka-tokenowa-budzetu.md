# Slice 04 — metryka tokenowa w politykach budżetowych

> Wykonawca: Cursor. Architekt/recenzent: Claude Code. Pracujesz WYŁĄCZNIE w tym drzewie roboczym.
> Gałąź bazowa: `deploy/upstream-sync-20260727` (stan produkcyjny). Gałąź robocza: `feat/metryka-tokenowa-budzetu`.

## Problem (zmierzony na żywej bazie 2026-07-27)

W instancji istnieje pięć polityk budżetowych. Wszystkie: `is_active = true`, `hard_stop_enabled = true`, ostrzeżenie przy 80%, `amount = 1000`, okno `calendar_month_utc`, zasięg `agent`.

I wszystkie mają `metric = 'billed_cents'` — czyli **liczą pieniądze**.

Instancja pracuje na abonamencie, więc `cost_events.cost_cents` wynosi **zero w każdym wierszu** (sprawdzone: suma za dobę = 0 przy 21,6 mln tokenów wejścia i 5,27 mln wyjścia). W `packages/shared/src/types/budget.ts` typ `BudgetMetric` dopuszcza dokładnie jedną wartość: `billed_cents`.

**Wniosek: hamulec jest zamontowany, włączony, z twardym zatrzymaniem — i podpięty do wskaźnika, który zawsze pokazuje zero. Nigdy się nie zaciśnie.** Zero wierszy w `budget_incidents` to nie dowód, że było dobrze — to dowód, że mechanizm nie ma czym zadziałać. Doba 27.07 spaliła ponad połowę tygodniowego limitu abonamentu przy nietkniętym hamulcu.

## Zakres

Dołożyć metrykę **tokenową** do polityk budżetowych, tak żeby twarde zatrzymanie i ostrzeżenie realnie działały na abonamencie.

### Do rozstrzygnięcia przez Ciebie (i uzasadnij wybór w raporcie)

Jaką dokładnie metrykę wprowadzić. Kandydaci: `total_tokens` (wejście + wyjście + pamięć podręczna), `output_tokens`, albo obie jako osobne wartości. **Rekomendacja architekta:** zacznij od `total_tokens`, bo to ona odpowiada realnemu zużyciu limitu abonamentu — ale sprawdź w danych, czy pamięć podręczna nie zniekształca obrazu (dziś: 350 mln odczytów z pamięci podręcznej przy 21,6 mln wejścia — proporcja jest ekstremalna i może wymagać osobnej wagi albo pominięcia).

### Co trzeba przejść end-to-end

1. Typ `BudgetMetric` i walidator (`packages/shared/src/types/budget.ts`, `packages/shared/src/validators/budget.ts`).
2. Schemat i ewentualne ograniczenie w bazie (`packages/db/src/schema/budget_policies.ts`) + migracja, jeśli metryka jest ograniczona po stronie bazy.
3. **Zapytanie agregujące** — dziś sumuje `cost_cents` z `cost_events`; musi umieć sumować kolumny tokenowe (`input_tokens`, `output_tokens`, `cached_input_tokens`).
4. **Ścieżka egzekucji** — miejsce, w którym `hard_stop_enabled` faktycznie blokuje kolejny przebieg oraz w którym powstaje wiersz `budget_incidents`. To jest najważniejszy punkt: bez niego dostaniemy ładny wskaźnik i dalej zero hamowania.
5. Prezentacja w kokpicie, jeśli metryka jest tam wypisywana (nie rozbudowuj interfejsu ponad to, co konieczne, żeby liczba nie kłamała).

### Kryteria akceptacji

- Da się utworzyć politykę z metryką tokenową, zasięgiem `company` **oraz** `agent`.
- Po przekroczeniu progu przy `hard_stop_enabled = true` **kolejny przebieg nie startuje**, a w `budget_incidents` powstaje wiersz. Pokryte testem, nie tylko deklaracją.
- Ostrzeżenie przy `warn_percent` działa dla metryki tokenowej.
- **Istniejące polityki pieniężne działają bez zmian** — zero regresji, potwierdzone testem.
- Migracja jest idempotentna i nie kasuje istniejących pięciu polityk.

## Ograniczenia (obowiązują bezwzględnie)

- **Nie dotykasz VPS ani produkcji.** Wyłącznie to drzewo robocze na Macu.
- **Nie modyfikujesz testów pierwowzoru**, żeby przeszły.
- **Przed oceną błędów typów: `pnpm install`.**
- Uwaga na numerację migracji: silnik rozpoznaje migracje po nazwie, a gdy brak — po odcisku treści; znacznik czasu nie bierze udziału w decyzji. Nadaj numer **za** wszystkimi migracjami pierwowzoru.
- Komunikaty commitów konwencjonalne, po polsku, `feat(budgets): ...`.
- Na końcu `pnpm test` zielony, wynik wypisz.

## Czego NIE robisz

- Nie zmieniasz emisji zdarzeń kosztowych (osobne zadanie — zakłada, że wkrótce dojdą zdarzenia z przebiegów padłych; Twoje zapytanie agregujące ma to znieść bez przeróbek).
- Nie zmieniasz logiki ponawiania (osobne zadanie).
- Nie wdrażasz. Kończysz na zacommitowanej gałęzi i raporcie.
