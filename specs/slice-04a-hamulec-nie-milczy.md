# Slice 04a — hamulec ma się skarżyć, gdy nie umie zadziałać

> Uzupełnienie do `slice-04-metryka-tokenowa-budzetu.md`. Ta sama gałąź, to samo drzewo robocze. Zmiany ze `slice-04` są w poczekalni — **nie cofaj ich, dokładasz**.

## Znalezisko z przeglądu

W `server/src/services/budgets.ts` polityka z metryką spoza listy wspieranych jest **przeskakiwana bez żadnego śladu** (`if (!isSupportedBudgetMetric(policy.metric) || policy.amount <= 0) continue;`).

Skutek: polityka widnieje w kokpicie jako aktywna, z włączonym twardym zatrzymaniem — i nie robi nic. Nikt się o tym nie dowie.

**Dlaczego to jest poważne akurat u nas, a nie teoretyczne:** cały dzisiejszy dzień poszedł na diagnozę dokładnie tej choroby. Pięć polityk budżetowych stało aktywnych, z twardym zatrzymaniem, przez tygodnie — i nie mogły zadziałać, bo liczyły jednostkę, która na abonamencie zawsze wynosi zero. Zero zapisanych przekroczeń wyglądało jak spokój, a było ciszą martwego mechanizmu. **Nie wolno nam zbudować drugiego takiego cichego pominięcia w tym samym pliku.**

Zastrzeżenie do proporcji: walidator na ścieżce zapisu przez API już ogranicza wartość metryki do listy wspieranych, więc przez interfejs błędnej wartości nie da się wprowadzić. Ale **my sami dopisujemy rekordy wprost do bazy** (dziś tak nadaliśmy uprawnienia do potoków), więc droga wejścia istnieje i jest realna.

## Zakres

Gdy polityka jest aktywna, ale jej metryka jest nierozpoznana — **głośno, nie po cichu**:

1. **Zapis do dziennika usługi na poziomie ostrzeżenia**, zawierający identyfikator polityki, jej zasięg i nierozpoznaną wartość metryki. Ma być odróżnialny w logu i możliwy do wyszukania.
2. **Nie zasypuj dziennika** — jeśli ocena polityk chodzi często, ostrzeżenie ma lecieć raz na cykl oceny, nie raz na zdarzenie kosztowe. Wybierz rozwiązanie i uzasadnij w raporcie.
3. **Polityka nadal nie jest egzekwowana** (nie zgadujemy, co użytkownik miał na myśli) — zmieniamy wyłącznie to, że jej bezsilność przestaje być niewidzialna.
4. To samo dotyczy drugiego warunku w tym samym miejscu — **kwoty mniejszej lub równej zeru**. Polityka z zerowym limitem też dziś znika po cichu.
5. Jeśli w API lub w kokpicie jest miejsce, w którym polityki są wyliczane, i da się **małym kosztem** oznaczyć taką jako nieprawidłową — zrób to. Jeśli wymagałoby to przebudowy ekranu, **odpuść i napisz to w raporcie**; sam zapis do dziennika wystarczy jako minimum.

### Kryteria akceptacji

- Test: polityka aktywna z nierozpoznaną metryką → **ostrzeżenie w dzienniku** i brak egzekucji; ocena pozostałych polityk przebiega normalnie.
- Test: polityka z prawidłową metryką działa dokładnie jak dotąd — zero regresji.
- Testy ze `slice-04` nadal zielone.
- Ostrzeżenie nie leci w pętli przy każdym zdarzeniu kosztowym.

## Ograniczenia

- Nie dotykasz VPS ani produkcji. Wyłącznie to drzewo robocze.
- Nie modyfikujesz testów pierwowzoru, żeby przeszły.
- **Nie commituj, nie wypychaj, nie zakładaj znacznika wydania** — zostaw w poczekalni, commit robi orkiestrator po przeglądzie.
- Na koniec uruchom testy budżetów i **wypisz surowy wynik**, nie streszczenie.
