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
  `"List decision cards (interactions) on an issue, with the human's answer in the result field. USE THIS to read the reply to a card you created with paperclipRequestConfirmation, paperclipRequestCheckboxConfirmation, paperclipAskUserQuestions or paperclipSuggestTasks. NOT paperclipListIssueApprovals / paperclipListApprovals — approvals are a different table and return an EMPTY LIST for these cards; an empty list there does NOT mean the human left no feedback. The answer lives in a DIFFERENT FIELD per card kind: request_confirmation and request_checkbox_confirmation -> result.reason; ask_user_questions -> result.answers (plus result.summaryMarkdown, result.cancellationReason); suggest_tasks -> result.rejectionReason (plus result.createdTasks, result.skippedClientKeys). Do not assume result.reason exists for every kind. issueId MUST be the issue UUID — the identifier form (e.g. GG-132) is NOT supported on this read path."`

🔴 **KOREKTA (recenzja adwersaryjna, 17.07):** pierwsza wersja tego specu kazała obiecać `result.reason` dla wszystkich rodzajów kart. To był **błąd w specu** — `ask_user_questions` i `suggest_tasks` tego pola NIE MAJĄ (dowód: `packages/shared/src/validators/issue.ts:712-720` i `:652-657`). Agent poszedłby po `result.reason`, dostał `undefined` i mógł znowu orzec „człowiek nic nie napisał" — czyli dokładnie ta klasa incydentu, którą ta zmiana ma zabić. Opis MUSI wymieniać pola per rodzaj.

🔴 **Ograniczenie ścieżki odczytu (ustalone recenzją):** trasa `GET /issues/:id/interactions` przekazuje do serwisu **surowy parametr**, a serwis porównuje go z kolumną UUID (`server/src/routes/issues.ts:9018` → `listForIssue(id)`; `services/issue-thread-interactions.ts:1085` → `eq(issueThreadInteractions.issueId, issueId)`). Ścieżka ZAPISU używa poprawnie `issue.id` (`routes/issues.ts:9040`). Skutek: **kartę da się wystawić identyfikatorem, ale nie odczytać**. To błąd upstreamu, nie nasz — świadomie go NIE naprawiamy (dotykałby pliku upstreamu i rósł powierzchnię konfliktu). Zamiast tego opis narzędzia jawnie wymaga UUID. Pada głośno (błąd + status), nie cicho pustą listą — więc nie odtwarza incydentu.
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
