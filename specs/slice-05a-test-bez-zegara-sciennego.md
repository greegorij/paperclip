# Slice 05a — test dowodzący naprawy nie może zależeć od zegara ściennego

> Uzupełnienie do `slice-05-odczekanie-na-reset-limitu.md`. Ta sama gałąź, to samo drzewo robocze. Praca ze `slice-05` jest **już zacommitowana** — dokładasz nowy commit, nie ruszasz tamtego.

## Znalezisko

`server/src/__tests__/heartbeat-provider-quota-session-limit.test.ts` **przechodzi w izolacji i w swojej rodzinie, ale padł raz na dwa przebiegi pełnego zestawu**. Nie jest to zatrucie przez inny test — to zależność od czasu w samym teście:

- ma zaszytą prawdziwą chwilę z incydentu: `Date.parse("2026-07-27T11:50:00.000Z")`;
- **rozgałęzia asercję w zależności od bieżącego czasu**: `if (Date.now() < expectedResetMs) { expect(dueMs).toBe(expectedResetMs) } else { expect(dueMs).toBeGreaterThan(Date.now()) }`;
- gałąź „po resecie" porównuje wyliczony moment ze **świeżo odczytanym** `Date.now()`, przy marginesie po resecie wynoszącym **jedną minutę** (`PROVIDER_QUOTA_RESET_MARGIN_MS`).

Taki test daje inny wynik o poranku niż w nocy i inny pod obciążeniem niż na pusto.

**Dlaczego to jest ważne, a nie kosmetyczne:** to jest JEDYNY test dowodzący, że lawina ponowień z 27.07 się nie powtórzy. Jeśli za tydzień zacznie przechodzić z przypadku albo padać z przypadku, przestanie być gwarancją, a zostanie hałasem, który ktoś wyciszy. Cały ten wieczór poszedł na naprawianie mechanizmów, które wyglądały na sprawne i nie działały — nie zostawiamy po sobie kolejnego.

## Zakres

**Zamroź czas w teście.** Ma być deterministyczny niezależnie od pory doby, obciążenia i daty uruchomienia.

Do rozstrzygnięcia przez Ciebie (i uzasadnij wybór w raporcie): wstrzyknięcie ustalonej chwili do badanego kodu, atrapa zegara (`vi.useFakeTimers` / `vi.setSystemTime`), albo parametr `now` w ścieżce klasyfikacji — jeśli kod produkcyjny już taki przyjmuje, **użyj go, to najczystsza droga i nie wymaga atrap**.

### Kryteria akceptacji

- **Zero odwołań do `Date.now()` w asercjach** i zero rozgałęzień zależnych od bieżącego czasu.
- Test sprawdza **dokładnie jedną, jednoznaczną rzecz**: przy komunikacie o wyczerpanym limicie z podaną godziną resetu, zaplanowany moment ponowienia równa się tej godzinie powiększonej o margines — bez „albo/albo".
- **Dołóż drugi przypadek: komunikat BEZ możliwej do odczytania godziny resetu** → zaplanowany moment to ustalone odczekanie (godzina), liczone od zamrożonej chwili. Dziś ta ścieżka nie ma pokrycia, a jest równie ważna: to ona chroni, gdy dostawca zmieni format komunikatu.
- Test przechodzi **dziesięć razy z rzędu** uruchomiony w pętli oraz razem z całą rodziną testów przebiegu. Wypisz surowy wynik obu.
- Nie osłabiaj asercji, żeby przestała padać — chodzi o determinizm, nie o pobłażliwość.

## Ograniczenia

- Nie dotykasz VPS ani produkcji. Wyłącznie to drzewo robocze.
- **Nie zmieniaj kodu produkcyjnego**, chyba że okaże się, że deterministycznego testu nie da się napisać bez wstrzyknięcia czasu — wtedy zmiana ma być minimalna i opisana w raporcie osobno.
- Nie modyfikujesz testów pierwowzoru.
- Nie commituj — zostaw w poczekalni, commit robi orkiestrator po przeglądzie.
- Na koniec **surowy wynik**, nie streszczenie.
