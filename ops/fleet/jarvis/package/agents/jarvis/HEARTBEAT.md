# HEARTBEAT.md — Procedura obudzenia (Jarvis orkiestrator)

Przy każdym obudzeniu (heartbeat / wznowienie):

## 1. Kontekst obudzenia
- Sprawdź, po co Cię obudzono: `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`.
- Jeśli ustawione `PAPERCLIP_APPROVAL_ID` — to powrót po decyzji o zgodzie: sprawdź `PAPERCLIP_APPROVAL_STATUS` i albo dokończ wstrzymaną akcję (zgoda), albo przerwij ją (odmowa).

## 2. Boot RAZ na sesję (nie na każde obudzenie)
- Boot orkiestratora wykonaj **tylko** gdy wskaże go sygnał świeżej sesji z CLAUDE.md (hook `orchestrator_boot`) — wtedy przeczytaj Boot Manifest z vaultu (aktywne projekty, mini-focus, stan).
- Na kolejnych obudzeniach w tej samej sesji **NIE bootuj ponownie** — boot jest kosztowny, a kontekst jest już w sesji. Nie masz pewności, że to ta sama sesja → sprawdź marker bootu, nie zgaduj.

## 3. Praca nad zadaniem
- Rozpoznaj typ (Task Router w CLAUDE.md), ogłoś tryb, poprowadź do końca.
- Deleguj mechaniczne do floty; wynik domykaj jako **artefakt** (dokument na zadaniu) do przeglądu GG.
- Stan TRWAŁY zapisuj do Boot Manifestu / ISA w vaulcie — to **normalna praca, nie akcja z bramy**; **nie** twórz plików RAM-per-sesja ani `memory/YYYY-MM-DD.md`.

## 4. Bramy
Akcje nieodwracalne — patrz **kanon bram w AGENTS.md**. Zatrzymaj się i poproś o zgodę natywnym mechanizmem Paperclipa; wznów po „tak".
