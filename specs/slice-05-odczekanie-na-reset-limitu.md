# Slice 05 — koniec dobijania się do wyczerpanego limitu dostawcy

> Wykonawca: Cursor. Architekt/recenzent: Claude Code. Pracujesz WYŁĄCZNIE w tym drzewie roboczym.
> Gałąź bazowa: `deploy/upstream-sync-20260727` (stan produkcyjny). Gałąź robocza: `feat/odczekanie-na-reset-limitu`.

## Problem (zmierzony na żywej bazie 2026-07-27 — to najdroższy incydent tej doby)

Flota uderzyła w limit sesji dostawcy. Wszystkie 329 nieudanych przebiegów tej doby mają **identyczny** błąd:

```
acpx_turn_failed / kod wyjścia 1
Internal error: You've hit your session limit · resets 11:50am (UTC)
```

Rozkład godzinowy (czas UTC):

| godzina | padło | udane |
|---|---|---|
| 00–08 | **0** | 108 |
| 09 | 109 | 52 |
| 10 | **120** | **0** |
| 11 | 100 | 10 |
| 12–13 | **0** | 69 |

Przez blisko trzy godziny platforma nie robiła nic poza ponawianiem. **298 przebiegów tej doby to ponowienia — 296 z nich padło ponownie.** Skuteczne: dwa.

Kluczowe ustalenie, kto to robił:

| źródło wywołania | przebiegów | padło | ponowień |
|---|---|---|---|
| `automation` | 478 | 311 | **298** |
| `assignment` | 94 | 18 | **0** |
| `timer` | 1 | 0 | 0 |

I ustalenie, które wskazuje przyczynę: **wszystkie 329 padłych przebiegów mają `scheduled_retry_reason = NULL`, `scheduled_retry_attempt = 0`, a `scheduled_retry_at` jest puste dla całej doby.** Czyli mechanizm zaplanowanego ponowienia — ten, do którego istnieje test `server/src/__tests__/heartbeat-retry-scheduling.test.ts` zawierający dokładnie komunikat o wyczerpanej sesji — **nie odezwał się ani razu**. Ponowienia poszły inną ścieżką: automatyzacją, która odpala etap od nowa i nie pyta o limit.

Każdy komunikat błędu zawierał godzinę resetu. Nikt jej nie użył.

## Zakres

Sprawić, żeby wyczerpanie limitu dostawcy przestało być traktowane jak błąd przejściowy nadający się do natychmiastowego ponowienia.

### Co zbadać przed pisaniem (w tej kolejności)

1. **Dlaczego ścieżka zaplanowanego ponowienia się nie uruchomiła.** Zacznij od testu `heartbeat-retry-scheduling.test.ts` — on opisuje zachowanie oczekiwane. Ustal, która funkcja produkcyjna go realizuje i dlaczego ścieżka `automation` do niej nie trafia. **To jest sedno zadania; reszta jest wtórna.**
2. Czy rozpoznanie błędu limitu w ogóle istnieje w kodzie produkcyjnym (poza testem), i czy radzi sobie z naszym formatem komunikatu — nasz brzmi `resets 11:50am (UTC)`, a test używa formy `resets at 4pm (America/Chicago)`: bez słowa „at" i z inną strefą. Jeśli rozpoznanie jest po wzorcu tekstowym, sprawdź obie formy.
3. Podsystem okien limitu: `server/src/services/quota-windows.ts`, punkt odczytu `/companies/:companyId/costs/quota-windows`, typy w `packages/shared/src/types/quota.ts` (`usedPercent`, `resetsAt`). **On już potrafi odczytać pozostały limit i godzinę resetu od dostawcy — użyj go, nie buduj drugiego.**

### Kryteria akceptacji

- Przebieg zakończony błędem wyczerpanego limitu **nie jest ponawiany natychmiast** — niezależnie od tego, czy wywołała go automatyzacja, czy cokolwiek innego.
- Ponowienie zostaje **zaplanowane na moment resetu** (z niewielkim marginesem), zapisane w `scheduled_retry_at` wraz z powodem w `scheduled_retry_reason`.
- Gdy godziny resetu nie da się odczytać z komunikatu — użyj podsystemu okien limitu; a gdy i to zawiedzie, odczekaj rozsądny stały czas. **Fałszywe „spróbuj natychmiast" jest niedopuszczalne w żadnej ze ścieżek.**
- Zachowanie dla **innych** rodzajów awarii bez zmian — nie spowalniaj zwykłych ponowień.
- Test odtwarzający dzisiejszy incydent: przebieg automatyzacji pada z komunikatem o wyczerpanej sesji → **zero natychmiastowych ponowień**, ustawione `scheduled_retry_at`.
- W dzienniku zdarzeń przebiegu widać czytelnie, że system czeka na reset i do kiedy (żeby człowiek patrzący na kokpit rozumiał, czemu stoi).

## Ograniczenia (obowiązują bezwzględnie)

- **Nie dotykasz VPS ani produkcji.** Wyłącznie to drzewo robocze na Macu.
- **Nie modyfikujesz testów pierwowzoru**, żeby przeszły — zwłaszcza nie `heartbeat-retry-scheduling.test.ts`, bo to on opisuje zachowanie, które chcemy uzyskać.
- **Przed oceną błędów typów: `pnpm install`.**
- Zmiana minimalna i w naszej warstwie; jeśli okaże się, że to defekt pierwowzoru nadający się do zgłoszenia — napisz to wprost w raporcie, przygotujemy zgłoszenie.
- Komunikaty commitów konwencjonalne, po polsku, `fix(heartbeat): ...`.
- Na końcu `pnpm test` zielony, wynik wypisz.

## Czego NIE robisz

- Nie zmieniasz emisji zdarzeń kosztowych ani metryk budżetowych (osobne zadania).
- Nie włączasz z powrotem automatyzacji etapów — o tym decyduje właściciel.
- Nie wdrażasz. Kończysz na zacommitowanej gałęzi i raporcie.
