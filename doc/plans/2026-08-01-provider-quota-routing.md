# Dostępność limitów dostawców i pas szybkiego kodowania

## Cel

Paperclip ma podejmować decyzję o uruchomieniu pracy na podstawie dwóch
niezależnych faktów: lokalnego limitu firmy lub agenta oraz aktualnego okna
subskrypcji dostawcy. Wolne okno dostawcy nie może podnieść lokalnego limitu,
a lokalny limit nie może udawać informacji o koncie dostawcy.

## Zakres pierwszego wydania

1. Zbudować wspólną, krótkotrwale buforowaną projekcję dostępności dostawcy na
   bazie już istniejących odczytów okien Anthropic i OpenAI/Codex.
2. Rozróżniać stan `available`, `constrained`, `blocked` oraz `unknown`.
   `blocked` ma zatrzymać wyłącznie nowe wybudzenie wymagające danego
   dostawcy; nie anuluje już działającego przebiegu i nie pauzuje agenta.
   Planowane ponowienie czeka do resetu z niewielkim marginesem, aby nie
   zużyć kolejnej próby na opóźnione odświeżenie telemetrii.
3. Dołączyć ten warunek do rozpoczęcia heartbeatów razem z istniejącą bramą
   budżetową. Nieudany odczyt limitu oznacza stan widoczny jako `unknown`, a
   nie ciche przełączenie modelu lub odblokowanie pracy.
4. Udostępnić operatorowi jedną projekcję: stan dostawców, źródło i świeżość
   odczytu, lokalny stan budżetu firmy/agenta oraz wyjaśnienie blokady.
5. Dodać wersjonowanego kandydata `gpt-5.3-codex-high` do wykonawcy Cursor
   dla zadań programistycznych. Równoległy Mięsień Kodu Codex pozostaje
   osobnym, niezależnym pasem wykorzystującym limit Codexa. Ta wersja nie
   zgaduje nazwy modelu dostępnego bezpośrednio w Codexie ani nie przełącza
   adaptera działającego agenta.

## Reguły bezpieczeństwa

- Nie ma automatycznego podnoszenia limitu firmy, agenta ani projektu.
- Nie ma masowego wznowienia agentów ani przełączenia profilu podczas
  aktywnych przebiegów.
- Gdy podstawowy pas jest zablokowany, użycie zapasu wymaga jawnego,
  wcześniej zatwierdzonego mapowania roli; brak takiego mapowania pozostawia
  zadanie w oczekiwaniu na reset.
- Status `unknown` jest informacją dla operatora. Nie może sam stworzyć
  lawiny ponowień ani stać się pretekstem do zapisu konfiguracji.
- Przejście do innego dostawcy zachowuje klasę danych, ograniczenia narzędzi,
  limit prób i wymóg niezależnej recenzji.
- Wybór między Cursorem a Codexem następuje w zadaniu nadrzędnym przed
  utworzeniem przebiegu. Automatyczna zmiana adaptera w trakcie pracy jest
  poza tym wydaniem, bo mogłaby przerwać kontekst i ominąć bramy akceptacji.

## Weryfikacja

- testy czystej klasyfikacji okien i wygaśnięcia bufora;
- test bramy heartbeat: lokalny budżet, limit dostawcy, stan nieznany i
  działający przebieg;
- test kontraktu API bez ujawnienia poświadczeń;
- test polityki: kandydat GPT Codex w Cursorze jest dostępny wyłącznie w roli
  programistycznej, a odrębny Mięsień Kodu Codex zachowuje własny pas;
- lokalna próba bez wybudzania floty, a następnie pojedyncza kontrolowana
  próba rzeczywistego zadania programistycznego.

## Poza zakresem tego wydania

- automatyczne zmiany progów budżetowych;
- zgadywanie dostępności Cursor bez źródła telemetryki;
- automatyczne przekazywanie jednego przebiegu między Cursorem a Codexem;
- automatyczne przełączanie całej floty między profilami;
- uruchomienie pilota WorkOS/Frappe.
