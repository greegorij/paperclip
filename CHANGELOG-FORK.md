# Changelog — warstwa forka Jarvisa

> Historia **naszej warstwy** nad `paperclipai/paperclip`. Upstream ma własne wersjonowanie kalendarzowe (`YYYY.MDD.P`) i publikuje do npm — my **nie publikujemy**, hostujemy własną instancję na VPS. Ten plik dokumentuje wyłącznie to, co dokładamy ponad upstream, oraz nasze cutovery.
>
> Format: [Keep a Changelog](https://keepachangelog.com/pl/). Tagi `fork-vX.Y.Z` są przeznaczone wyłącznie dla prywatnego repozytorium forka.

## [Unreleased]

## [0.2.12] — 2026-07-30

### Naprawione / Wzmocnione
- **Kanoniczna weryfikacja umiejętności po zmianie profilu:** przełącznik odczytuje `desiredSkills` z właściwego punktu `/skills`, zamiast uznawać brak tego pola w szczegółach agenta za pustą listę; błąd odczytu, zły kształt danych i rzeczywisty dryf nadal twardo zatrzymują zmianę i uruchamiają cofanie. Naprawę śledzi i zamyka bilet `T-202607-004`.

## [0.2.11] — 2026-07-30

### Naprawione / Wzmocnione
- **Pełna wymiana konfiguracji przy zmianie adaptera:** pełne `replaceAdapterConfig` przy zmianie adaptera nie zachowuje już pominiętych pól starego adaptera (zwłaszcza `CLAUDE_CONFIG_DIR`); zwykła zmiana bez pełnego zastąpienia zachowuje dotychczasowe pola. Test PATCH→GET pokrywa oba przypadki. Naprawę śledzi i zamyka bilet `T-202607-003`.

## [0.2.10] — 2026-07-30

### Dodane / Wzmocnione
- **Bezpieczny przełącznik profili dostawcy dla floty Jarvis:** nowe `fleet-config profile-switch` (preview/apply/rollback) dla dokładnie 22 ról Anthropic (`20` przenośnych + `summarizer` + `reflection-coach`) z deklaratywnymi profilami `openai-first`/`anthropic-first`, twardą walidacją mapowań, bramą kopii DB, wymogiem świeżej migawki i zerowych aktywnych przebiegów, pełnym `replaceAdapterConfig: true` z zachowaniem wyłącznie pól instrukcji/skill-sync, weryfikacją PATCH→GET oraz automatycznym rollbackiem w odwrotnej kolejności przy pierwszej awarii; backup rollbacku jest prywatny (`0600`) i zachowuje dokładny stan (w tym `secret_ref`) wyłącznie do odtworzenia, podczas gdy raporty/migawki pozostają zredagowane; profile utrwalają limity anty-loop (`maxConcurrentRuns`, heartbeat/wake, `maxDailyRuns`), a `openai-first` wymaga aktualnego źródła instrukcji bossa oraz zgodności wygenerowanego i wersjonowanego artefaktu `AGENTS-CODEX.md`.

## [0.2.9] — 2026-07-30

### Dodane / Wzmocnione
- **Pełna migawka floty:** snapshot pobiera kompletny rekord każdego z 29 agentów i zachowuje z `runtimeConfig` heartbeat równoległość, stan włączenia, budzenie na żądanie oraz limity dzienne; szczegóły z żywej konfiguracji są źródłem prawdy, a błąd odczytu GET zatrzymuje tworzenie migawki. Naprawę śledzi i zamyka bilet `T-202607-002`.
- **Zarządzane profile OpenAI (fail-closed):** Recenzent, Zwiadowca Kodu i awaryjny Mięsień Kodu Codex mają utrwalony dokładny model, wysiłek rozumowania, tryb przestrzeni roboczej (RO/RW), sieć, argumenty, brak omijania zabezpieczeń, jedną równoległą pracę i limity dzienne; pełne zastosowanie floty nadal nie przełącza automatycznie adapterów ani tych pól.
- **Profile wykonawcze:** Zwiadowca Kodu → gpt-5.6-terra medium, przestrzeń robocza tylko do odczytu, maksymalnie 3 uruchomienia dziennie; awaryjny Mięsień Kodu Codex → gpt-5.6-sol high, przestrzeń robocza do zapisu, maksymalnie 1 uruchomienie dziennie; Cursor pozostaje domyślnym wykonawcą.

### Zweryfikowane
- **Produkcyjny pilot Zwiadowcy Kodu:** jeden przebieg, właściwy plik docelowy, zero zmian, podzadań i nieoczekiwanych zadań, czysty workspace, agent wrócił w stanie wstrzymanym.

## [0.2.8] — 2026-07-30

### Dodane / Wzmocnione
- **Zewnętrzny katalog roboczy tylko do odczytu dla Codexa:** lokalna izolacja Bubblewrap obsługuje teraz jawny tryb `ro`/`rw`; w trybie `ro` blokuje także zapisywalne wyjątki i aliasy prowadzące do katalogu roboczego, pozostawiając zapisywalny wyłącznie prywatny katalog wykonawczy Codexa.
- **Kontrolowany kanał koordynacji Recenzenta:** Bubblewrap pozostaje twardą granicą plików i sieci, a wewnętrzny sandbox Codexa nie odcina już dozwolonej komunikacji z Paperclip; niebezpieczne ominięcie zatwierdzeń nadal jest wyłączone.
- **Kontrola dryfu profilu:** walidator floty wymaga dla Recenzenta katalogu tylko do odczytu, zamkniętej listy sieciowej, równoległości 1 oraz dokładnego zestawu argumentów; pełne zastosowanie floty nadal nie nadpisuje automatycznie tych pól.

## [0.2.7] — 2026-07-30

### Naprawione / Wzmocnione
- **Logowanie Codexa w lokalnym sandboxie:** przebieg w Bubblewrap dostaje prywatny, kuratorowany katalog Codexa z rzeczywistą kopią `auth.json`, zamiast zerwanego dowiązania do niewidocznego katalogu hosta; nowsze odświeżone poświadczenie wraca bezpiecznie do właściwego źródła, a katalog tymczasowy jest zawsze usuwany.
- **Izolacja poświadczeń:** cały hostowy katalog `~/.codex` nadal nie jest montowany w sandboxie, a ręcznie wskazany `CODEX_HOME` zachowuje własny cel zapisu zamiast nadpisywać domyślne konto hosta.

## [0.2.6] — 2026-07-30

### Naprawione / Wzmocnione
- **Izolacja lokalnych agentów OpenCode:** każdy agent bez jawnie ustawionego katalogu domowego dostaje własny trwały katalog wykonawczy i widzi wyłącznie przypisane mu umiejętności; synchronizacja jednego agenta nie usuwa już umiejętności pozostałych.
- **Weryfikacja stanu wykonawczego floty:** zapis listy umiejętności jest uznawany za poprawny dopiero wtedy, gdy dokładnie wszystkie żądane pozycje są faktycznie aktywne w stanie właściwym dla danego wykonawcy.

## [0.2.5] — 2026-07-30

### Wzmocnione
- **Bezpieczny profil Recenzenta na Codexie:** manifest floty utrwala model GPT, minimalne umiejętności oraz stan wstrzymany poza pilotem.
- **Kontrola środowiska wykonawczego:** walidator blokuje zmianę adaptera, przestrzeni roboczej, sandboxa tylko do odczytu, ograniczeń sieci, wysiłku rozumowania, limitów czasu i zakazu omijania zabezpieczeń; tych pól nie naprawia automatycznie.

## [0.2.4] — 2026-07-30

### Wzmocnione
- **Bezpieczne zarządzanie instrukcjami floty:** eksportowe `AGENTS.md` nie są już porównywane ani używane do pełnego nadpisania działających agentów; automatyczne zastosowanie zmian odrzuca wszystkie mutacje instrukcji przed pierwszym wywołaniem API.
- **Walidacja rzeczywistej konfiguracji:** reguły sprzeczności są sprawdzane także na instrukcjach i modelach z żywej migawki floty, dzięki czemu różnica między poprawnym pakietem a niepoprawną produkcją blokuje zastosowanie zmian.

## [0.2.3] — 2026-07-30

### Naprawione
- **Sandbox Bubblewrap dla local-process workspace**: wykrywa układ merged-/usr i non-merged-/usr, zachowuje hostowe dowiązania, montuje prawdziwe katalogi tylko do odczytu i nie generuje konfliktujących mountów, dzięki czemu bezpieczny pilot Codex uruchamia się na Ubuntu bez regresji dla starszych dystrybucji.

## [0.2.2] — 2026-07-30

### Wzmocnione
- **Trwałe zatrzymanie jałowych ponowień zadania:** po 3 kolejnych zakończonych przebiegach bez widocznego postępu platforma przestaje automatycznie ponawiać to samo zadanie; po 2 takim przebiegu nadal działa chłodzenie, a odblokowanie następuje wyłącznie po nowym wkładzie człowieka lub jawnym wznowieniu.
- **Transakcyjne limity tworzenia zadań przez agentów:** maksymalnie 6 nowych zadań na przebieg, 12 na agenta w 30 minut, 4 korzenie w 30 minut, głębokość drzewa do 4 i do 12 potomków na korzeń; dodatkowo deduplikacja tytułu, odporność na wyścigi, brak tych limitów dla ludzi oraz prywatny wyjątek wyłącznie dla zatwierdzonego rozkładu planu.

## [0.2.1] — 2026-07-30

### Naprawione
- **Bezpieczne raportowanie limitów OpenAI/Codex**: etykiety okien wynikają z rzeczywistej długości (`windowDurationMins`), a nie z pozycji `primary`/`secondary`; subskrypcja bez dodatkowych kredytów nie pokazuje mylącego salda `$0.00`, przy zachowanej kompatybilności ze starszym RPC bez `hasCredits`; diagnostyka quota-probe nie eksponuje ani nie serializuje tokenów uwierzytelnienia ani identyfikatora konta (zostawia tylko bezpieczne metadane).

## [0.2.0] — 2026-07-29

### Dodane
- **Zarządzanie konfiguracją floty Jarvisa** (`ops/fleet/jarvis/`): przenośny pakiet 27 agentów, overlay 2 built-inów i 5 rutyn, CLI `snapshot|validate|diff|apply|verify` (dry-run offline, brama kopii = plik+SHA bez miękkiego potwierdzenia, snapshot/validate fail-closed, minimalny PATCH modelu, fail-fast + GET write-verify, skill keys tylko z `skillLibrary`). Ticket: `docs/tickets/T-202607-001.md`.
- **Niezależny harness porównania modeli** (`evals/promptfoo/fleet/`): osobna suite Promptfoo poza `evals:smoke`, macierz harnessów (Anthropic API Sonnet 5 / Haiku 4.5, CLI Claude subscription, Codex SDK, Cursor exec, OpenRouter) z opt-in `pnpm evals:fleet:*` — bez przypadkowego kosztu pełnej macierzy przy smoke.
- **Obsługa Claude Opus 5 i Sonnet 5** w adapterze `claude_local` oraz w desired floty (m.in. Jarvis/Szef Komercyjny → `claude-opus-5`, domyślny Claude local → `claude-sonnet-5`).

### Naprawione / Wzmocnione
- **Przegląd i utwardzenie `ops/fleet/jarvis`** (Pass 3): pełne `skillKeys` vs live `desiredSkills` dla wszystkich 27 agentów przenośnych + built-inów w `desired/built-ins.json`; brama `completeness` (29 = 27 + 2, liczniki zgodne z tablicami); weryfikacja built-in model/skills i Summarizera (dokładny `plan.next`/SHA-256); poprawne `partial=true` przy write-ok/verify-fail; brak ścieżek hosta `~/` w pakiecie wersjonowanym.
- **Budżety/koszty i oczekiwanie na limity dostawcy**: telemetryka wydatków (spend) oraz recovery z czekaniem na reset quota zamiast agresywnych powtórek przy limicie — kontynuacja wątku z 0.1.0, wciągnięta dalszym syncem upstreamu.
- **Utwardzenie CI prywatnej production**: Dependabot `open-pull-requests-limit: 0` (wersje idą syncem z upstreamu), pomijanie privileged `commitperclip-review` na prywatnym repo, `pr.yml` na gałęzi `production`, regresie w `scripts/__tests__/production-bootstrap-policy.test.mjs` (checkout base SHA, `contents: read`, agregat `verify`).

### Zsynchronizowane z upstreamem
- Istotna synchronizacja z `paperclipai/paperclip` po cutoverze 0.1.0 — w drzewie m.in. późniejsze wydania kalendarzowe (`v2026.720.0`, `v2026.722.0`: skill studio, attention/decisions, quota-aware recovery, spend telemetry, Connections v3).

## [0.1.0] — 2026-07-17

Pierwsze formalne wydanie warstwy forka. Wcześniejsze zmiany (logowanie Google, adnotacje, karty decyzyjne) istniały bez wersjonowania i historii — to wydanie je obejmuje.

### Dodane
- **Narzędzie odczytu kart decyzyjnych** (`paperclipListIssueInteractions`). Agent miał cztery narzędzia do **wystawiania** kart i ani jednego do **czytania odpowiedzi** człowieka. Opis wymienia pola per rodzaj karty — bo odpowiedź żyje w innym polu dla każdego rodzaju.
- **Ostrzeżenia w opisach** `paperclipListIssueApprovals` i `paperclipListApprovals`: nie zawierają kart decyzyjnych, a pusta lista **nie oznacza braku uwag**. Bez tego kolejny agent powtórzyłby błąd — stare narzędzie nadal wygląda na właściwe.
- Logowanie Google (`better-auth`: `socialProviders`, `accountLinking`) + zmienne konfiguracyjne.
- Narzędzia adnotacji dokumentów + `includeAnnotationComments`.
- Karty decyzyjne w widoku zatwierdzeń i licznik na pulpicie.

### Naprawione
- Osierocone adnotacje dokumentów są pokazywane zamiast ukrywane.

### Zsynchronizowane z upstreamem
- 20 commitów (16–17.07), **6 migracji bazy** (0172–0177) zastosowanych czysto.
- Motyw przewodni: trzy zmiany naprawiające **pętle odzyskiwania po padzie dostawcy modelu** — `#9648` (zapobieganie zduplikowanym zadaniom i pętlom odzyskiwania), `#9635` (czekanie na reset limitów dostawcy), `#9651` (dławienie powtórek). Dokładnie ten problem diagnozowaliśmy 17.07: przebieg czujki padał na przeciążeniu dostawcy, platforma odpalała tryb awaryjny bez prawa zapisu dokumentów, agent tworzył podzadanie → trzy przebiegi zamiast jednego.
- `#9658` — polityki dostępu agentów do archiwizacji skrzynek. **Na obserwacji:** nowy mechanizm uprawnień floty.

### Bezpieczeństwo
- **Rotacja klucza podpisu agentów.** Wartość wyciekła do wyjścia podagenta (`cat` na pliku kopii zapasowej env). Porównanie potwierdziło, że wyciekły klucz był **aktywny**. Po rotacji: zero ostrzeżeń o braku klucza, tożsamość agentów potwierdzona podpisem na zapisanym dokumencie.

### Znane, świadomie nienaprawione
- **Odczyt interakcji wymaga UUID** — identyfikator zadania (np. `GG-132`) nie działa. Trasa `GET /issues/:id/interactions` przekazuje surowy parametr do serwisu porównującego go z kolumną UUID, podczas gdy ścieżka **zapisu** rozwiązuje zadanie poprawnie. Błąd upstreamu; naprawa dotykałaby ich pliku i rosłaby powierzchnię konfliktu przy każdej synchronizacji. Opis narzędzia jawnie wymaga UUID. Pada głośno (błąd + status), nie cicho pustą listą.
- **Brak stronicowania** w liście interakcji — na długim zadaniu może zalać kontekst agenta.
- **`.parse()` zamiast `.safeParse()`** przy hydratacji — jeden felerny wiersz zatruje cały odczyt zadania.
- Trzy testy upstreamu czerwone **przed i po** synchronizacji (dziedziczony dług, nie regresja): adopcja żywej usługi po resecie stanu, rozbieżność gałęzi ×2. Czwarty (`wakes a cross-agent review participant`) to flak równoległości — osobno przechodzi.
- **Warstwa forka nieudokumentowana** w `doc/` — dług do spłaty.

### Odwrót
- Kod: tag `pre-upstream-sync-20260717` → `735f88b`
- Baza: kopia katalogu `/home/ccuser/backups/db-przed-sync-20260717` (119 MB, zrobiona przy zatrzymanej usłudze — `pg_dump` nie istnieje w tej dystrybucji)
- Klucz: `/home/ccuser/.config/paperclip-agent-env.bak-przed-rotacja-20260717`
- 🔴 Migracji **nie da się cofnąć** inaczej niż przywróceniem kopii bazy — `PAPERCLIP_MIGRATION_AUTO_APPLY=true` odpala je automatycznie przy starcie.
