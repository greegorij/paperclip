# Slice 01 — narzędzie MCP do odczytu kart decyzyjnych (interakcji)

## Dlaczego to powstaje (incydent 17.07, GG-132)

Agent CEO wystawił GG kartę decyzyjną. GG odrzucił ją, wpisując **obszerne uzasadnienie z trzema zarzutami**. Agent poszukał odpowiedzi narzędziem `paperclipListIssueApprovals`, dostał **pustą listę** i oznajmił człowiekowi: *„karta odrzucona bez żadnego komentarza"*. Trzeba było dwóch upomnień, żeby trafił.

Nie zawinił agent. Zawiniła **asymetria naszej warstwy forka**:

- karty tworzone przez `paperclipRequestConfirmation` / `paperclipAskUserQuestions` / `paperclipSuggestTasks` / `paperclipRequestCheckboxConfirmation` lądują w tabeli **interakcji** (`GET /issues/{id}/interactions`),
- `paperclipListIssueApprovals` i `paperclipListApprovals` pytają o **inną tabelę** (`/issues/{id}/approvals`, `/companies/{cid}/approvals`) i dla tych kart zwracają `[]`,
- **cztery narzędzia potrafią kartę WYSTAWIĆ, ani jedno jej ODCZYTAĆ.**

Zweryfikowane na żywo (17.07, zadanie GG-132): `/issues/{id}/approvals` → 0 pozycji · `/issues/{id}/interactions` → 1 pozycja z `result.reason` zawierającym pełny komentarz GG.

**Wymaganie nadrzędne:** agent musi mieć narzędzie, które na pytanie „co człowiek odpowiedział na moją kartę?" zwraca odpowiedź — albo jawnie mówi, że jej nie ma. Nigdy pustą listę, którą da się wziąć za „brak uwag".

## Zakres

Plik: `packages/mcp-server/src/tools.ts` (wzorzec: `makeTool(...)` obok istniejących, np. `paperclipListIssueApprovals` ~linia 329).

### 1. `paperclipListIssueInteractions`

- **Opis (widoczny dla agenta — musi ostrzegać przed pomyłką):**
  `"List decision cards (interactions) on an issue — including the human's answer in result.reason when a card was accepted or rejected. USE THIS to read the reply to a card you created with paperclipRequestConfirmation / paperclipAskUserQuestions / paperclipSuggestTasks. NOT paperclipListIssueApprovals — approvals are a different table and return an empty list for these cards."`
- Wejście: `z.object({ issueId: issueIdSchema })`
- Działanie: `client.requestJson("GET", ` + `/issues/${encodeURIComponent(issueId)}/interactions` + `)`

### 2. `paperclipGetInteraction`

- **Opis:** `"Get one decision card (interaction) by id, with the human's decision and their reason."`
- Wejście: `z.object({ issueId: issueIdSchema, interactionId: z.string().min(1) })`
- Działanie: GET na detal interakcji. **Jeśli serwer nie ma takiego endpointu — nie dodawaj tego narzędzia**; pierwsze wystarcza. Sprawdź `server/src/routes/issues.ts` przed implementacją; nie zgaduj.

### 3. Poprawka opisów dwóch istniejących narzędzi (to jest część, nie dodatek)

Do opisu `paperclipListIssueApprovals` **oraz** `paperclipListApprovals` dopisz zdanie:
`"Does NOT include decision cards created via paperclipRequestConfirmation/paperclipAskUserQuestions — those live in interactions; use paperclipListIssueInteractions. An empty list here does NOT mean the human left no feedback."`

Powód: bez tego kolejny agent powtórzy ten sam błąd, nawet mając nowe narzędzie — bo stare nadal wygląda na właściwe.

## Kryteria akceptacji

1. Agent, mając wyłącznie `issueId`, jest w stanie odczytać `result.reason` odrzuconej karty **jednym wywołaniem narzędzia** (bez `paperclipApiRequest`, bez curla).
2. Opis nowego narzędzia zawiera jawne odesłanie od `approvals` — tak, żeby model szukający „gdzie jest odpowiedź na kartę" trafił tu, a nie tam.
3. Opisy obu narzędzi `*Approvals` ostrzegają, że pusta lista nie oznacza braku uwag.
4. Typy zwrotu zgodne z tym, co realnie zwraca `GET /issues/{id}/interactions` — **sprawdź w `server/src/routes/issues.ts`, nie zakładaj**.
5. `pnpm -r typecheck` i `pnpm test:run` zielone.
6. Zero zmian zachowania istniejących narzędzi (tylko teksty opisów).

## Uwagi

- To warstwa forka. Zmiana ma być **addytywna** — nic nie usuwamy, żeby nie zwiększać powierzchni konfliktu przy kolejnej synchronizacji z upstreamem.
- Test ręczny do wykonania po wdrożeniu (orkiestrator): na GG-132 nowe narzędzie musi zwrócić kartę `4593322b…` ze statusem `rejected` i uzasadnieniem GG zaczynającym się od „kierunkowo juz duzo lepiej".
