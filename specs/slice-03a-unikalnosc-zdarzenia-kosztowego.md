# Slice 03a — unikalność zdarzenia kosztowego broniona przez bazę, nie przez kod

> Uzupełnienie do `slice-03-koszt-przebiegow-padlych.md`. Ta sama gałąź `feat/koszt-przebiegow-padlych`, to samo drzewo robocze.
> Powód: przegląd adwersaryjny znalazł wyścig. Właściciel zdecydował naprawić teraz, nie później.

## Znalezisko z przeglądu

Ochrona „jeden przebieg = najwyżej jedno zdarzenie kosztowe" jest zaimplementowana jako **sprawdź-potem-wstaw**, w dwóch miejscach (`server/src/services/costs.ts` w `createEvent` oraz w `server/src/services/heartbeat.ts` przy domykaniu przebiegu).

Dwa równoległe domknięcia tego samego przebiegu mogą **oba** przejść sprawdzenie, zanim którekolwiek wstawi wiersz — i wstawić po jednym. Flota jest z definicji równoległa, a przypadki, które ta zmiana obsługuje (anulowanie, utrata procesu, późne domknięcie), to dokładnie te, w których dwie ścieżki domykają ten sam przebieg.

**Dlaczego to jest ważniejsze niż wygląda:** cała ta zmiana istnieje po to, żeby liczby były prawdziwe i żeby dało się na nich oprzeć hamulec budżetowy. Licznik, który potrafi policzyć zużycie dwa razy, jest gorszy niż licznik ślepy — bo ślepemu się nie ufa, a kłamiącemu się ufa.

## Stan faktyczny bazy produkcyjnej (sprawdzony 27.07, nie założony)

- Duplikatów na parze `(company_id, heartbeat_run_id)`: **zero**. Migracja założy się czysto.
- Wierszy w `cost_events`: 869, **wszystkie** mają wypełnione `heartbeat_run_id` (zero pustych).
- **Indeks na tej parze JUŻ ISTNIEJE**: `cost_events_company_heartbeat_run_idx`, zwykły btree na `(company_id, heartbeat_run_id)` — **brakuje mu tylko unikalności**.

## Zakres

1. **Zaostrzyć obronę do poziomu bazy.** Zamień istniejący indeks na unikalny (albo dodaj unikalny i usuń zbędny zwykły — wybierz i uzasadnij). Zrób go **częściowym: `WHERE heartbeat_run_id IS NOT NULL`** — dziś pustych nie ma, ale kolumna na to pozwala i nie chcemy zablokować przyszłych zdarzeń niezwiązanych z przebiegiem.
2. **Uczynić ścieżkę wstawiania odporną na konflikt.** Sprawdzenie wstępne zostaw jako tanią szybką ścieżkę, ale **autorytetem ma być baza**: przy naruszeniu unikalności zdarzenie ma zostać rozpoznane i zwrócone istniejące, a **nie** wypuszczony wyjątek na zewnątrz. Domknięcie przebiegu nie może się wywrócić dlatego, że ktoś je domknął milisekundę wcześniej.
3. **To samo dotyczy sum zbiorczych agenta** — przy przegranym wyścigu nie wolno dopisać zużycia do `agent_runtime_state`. Dziś chroni to wcześniejsze `return`; upewnij się, że po dołożeniu obsługi konfliktu ta własność nadal zachodzi.

### Kryteria akceptacji

- Test **odtwarzający wyścig**: dwa równoległe domknięcia tego samego przebiegu → dokładnie **jeden** wiersz w `cost_events` i **jedno** dopisanie do sum zbiorczych. Bez wyjątku wypuszczonego na zewnątrz.
- Migracja idempotentna, numer **za** wszystkimi migracjami pierwowzoru (silnik rozpoznaje migracje po nazwie, a gdy brak — po odcisku treści; znacznik czasu nie bierze udziału).
- Migracja przechodzi na bazie z istniejącymi danymi (869 wierszy, zero duplikatów) — nie zakładaj pustej tabeli.
- Zdarzenia bez `heartbeat_run_id` nadal można wstawiać wielokrotnie (indeks częściowy).
- Testy z `slice-03` nadal zielone.

## Ograniczenia

- Nie dotykasz VPS ani produkcji. Wyłącznie to drzewo robocze.
- Nie modyfikujesz testów pierwowzoru, żeby przeszły.
- Przed oceną błędów typów: `pnpm install`.
- Nie commituj sam, jeśli Twoja brama to blokuje — zostaw zmiany w poczekalni i napisz to w raporcie. Commit robi orkiestrator po przeglądzie.
- Na koniec uruchom testy i **wypisz surowy wynik**, nie streszczenie.
