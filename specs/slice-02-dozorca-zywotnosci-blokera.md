# Slice 02 — dozorca żywotności blokera: obudź zależnych, gdy bloker UMIERA (nie tylko gdy się kończy)

## Problem (deadlock, potwierdzony adwersaryjną recenzją)

Gdy zadanie A jest zablokowane przez zadanie B (`A.blockedBy = [B]`), A budzi się **wyłącznie** gdy B osiąga `done`. To jest w `server/src/routes/issues.ts:8660` (`becameDone` → `listWakeableBlockedDependents` → `addDependencyResolvedWakeup`).

**Dziura:** jest osobny blok `becameTerminal` (`routes/issues.ts:8702`, obejmuje `done` ORAZ `cancelled`), ale on budzi **tylko rodzica** (`getWakeableParentAfterChildCompletion`, 8707) — **nie budzi zablokowanych zależnych.** Więc gdy bloker B kończy inaczej niż `done`:
- B zostaje **`cancelled`** (np. boss anuluje, albo recovery),
- B wpada w **martwe `blocked`** po wyczerpaniu prób (recovery „still has no live execution path. Moving it to blocked so it is visible for intervention" — `server/src/services/recovery/service.ts` ~4058),

…zależny A **nie dostaje żadnego wybudzenia i śpi w nieskończoność.** W autonomicznej flocie 24/7 nikt nie interweniuje. To jest cichy deadlock. Zmaterializował się realnie dziś rano: przebieg padł na przeciążeniu dostawcy modelu.

Backstop periodyczny (`reconcileResolvedDependencyWakeBackstop`, recovery/service.ts ~4956) NIE ratuje — budzi tylko zadania, których **wszystkie** blokery są `done` (`isDependencyReady`, `issues.ts:1130-1134`); martwy bloker daje `isDependencyReady=false` → pominięty. Watchdog też nie — traktuje `scheduled_retry` jako „żywe" (`task-watchdogs.ts:29`).

## Wymaganie

Gdy bloker przechodzi w stan, z którego **nie osiągnie już `done` samodzielnie**, jego zablokowani zależni mają zostać **obudzeni** (wypłynąć do wykonawcy/bossa jako „twój bloker umarł, zdecyduj"), zamiast spać wiecznie. To lustro istniejącego wybudzania „po done" — dla przypadku „bloker umarł".

## Zakres

Plik główny: `server/src/routes/issues.ts`, w tym samym handlerze aktualizacji zadania, obok `becameDone` (8660) i `becameTerminal` (8702).

### 1. Nowy sygnał: „bloker stał się martwy dla zależnych"

Dodaj blok równoległy do `becameDone`, który odpala się, gdy zadanie przechodzi w stan **terminalnie-niepowodzeniowy z punktu widzenia zależnych**:
- `existing.status !== "cancelled" && issue.status === "cancelled"` — bloker anulowany, LUB
- bloker wpadł w **martwe `blocked`** (recovery poddał się — „no live execution path").

🔴 **KLUCZOWY NIUANS — nie budź przy zwykłym `blocked`.** Bloker legalnie bywa `blocked`, bo sam czeka na swój bloker (przechodnio zablokowany, wciąż żywy — rozwiąże się). Budzenie zależnego wtedy = fałszywy alarm i szum. Musisz odróżnić:
- **przechodnio zablokowany** (bloker ma własny aktywny bloker, jego łańcuch żyje) → NIE budź,
- **martwo zablokowany** (recovery wrzucił go w `blocked` bo brak żywej ścieżki wykonania, zero aktywnych blokerów zadaniowych) → BUDŹ.
🔴 ZNAJDŹ W KODZIE właściwy sygnał rozróżniający, NIE zgaduj. Kandydaty do sprawdzenia: dyspozycja/reason ustawiany przez recovery przy escalate-to-blocked (`recovery/service.ts` ~4030-4066), pole na zadaniu typu `blockedReason`/`recoveryDisposition`/`executionState`, albo warunek „status=blocked AND brak aktywnych blokerów zadaniowych AND brak żywego runu". Jeśli nie ma czystego sygnału dla „martwo zablokowany" — zaimplementuj TYLKO gałąź `cancelled` (ona jest jednoznaczna i pokrywa najczęstszy przypadek: boss/recovery anuluje), a przypadek „martwe blocked" wypisz w komentarzu do PR jako świadomie pominięty (lepiej węziej i pewnie niż szeroko i z fałszywymi alarmami).

### 2. Wybudzenie zależnych

Dla znalezionych zależnych (użyj `listWakeableBlockedDependents(issue.id)` — ta sama funkcja co `becameDone`) wyślij wybudzenie z **NOWYM, odrębnym powodem** (nie `issue_blockers_resolved` — bloker się NIE rozwiązał, umarł). Proponowany reason: `issue_blocker_stranded` (albo zgodny z konwencją nazw wake-reasonów w tym repo — sprawdź `heartbeat.ts` ~530-540 i dopisz do właściwej listy stałych, jeśli reasony są enumerowane). Payload ma nieść: `dependentIssueId`, `deadBlockerIssueId`, `blockerFate` (`cancelled`/`stranded`), i jasny komunikat, że bloker nie dojdzie do `done` — zależny ma zdecydować (ponowić eskalację / iść dalej bez / zawołać bossa).

### 3. Rejestracja reason (jeśli wymagana)

Jeśli wake-reasony są w tym repo enumerowane/walidowane (np. lista `ISSUE_*_WAKE_REASONS`, schemat zod), dodaj nowy reason do właściwych zbiorów — inaczej wybudzenie zostanie odrzucone walidacją. Sprawdź `heartbeat.ts` i schematy.

## Kryteria akceptacji

1. Bloker `→ cancelled` → jego zablokowani zależni dostają wybudzenie z reasonem `issue_blocker_stranded` (albo przyjętym). Test jednostkowy to pokrywa.
2. Bloker przechodnio zablokowany (żywy łańcuch) → zależni NIE są budzeni (brak fałszywego alarmu). Test to pokrywa.
3. Zero zmiany zachowania ścieżki `becameDone` (happy path działa jak dotąd).
4. Nowy reason przechodzi walidację (nie jest odrzucany).
5. `pnpm -r typecheck` + `pnpm --filter server test` zielone (poza testami czerwonymi PRZED zmianą — odróżnij).
6. Zmiana minimalna i lustrzana wobec istniejącego `becameDone` — to ma się nadawać na PR do upstreamu (czysta naprawa realnej dziury w ich mechanizmie żywotności).

## Uwagi
- To jest kandydat na PR do upstreamu (naprawia dziurę w THEIR mechanizmie, nie w naszej warstwie forka). Trzymaj zmianę czystą, bez naszych identyfikatorów, gotową do zgłoszenia.
- NIE commituj/pushuj/taguj — orkiestrator.
- Po implementacji wypisz: co dodałeś (ścieżka:linia), jaki sygnał wybrałeś dla „martwo zablokowany" (albo że pominąłeś tę gałąź i dlaczego), wynik typecheck/testów.
