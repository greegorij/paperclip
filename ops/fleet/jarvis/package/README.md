# GG

![Org Chart](images/org-chart.png)

## What's Inside

> This is an [Agent Company](https://agentcompanies.io) package from [Paperclip](https://paperclip.ing)

| Content | Count |
|---------|-------|
| Agents | 27 |
| Skills | 37 |

### Agents

| Agent | Role | Reports To |
|-------|------|------------|
| Analityk Biznesowy | pm | jarvis |
| Badacz | researcher | jarvis |
| Czytacz Transkryptow | researcher | badacz |
| Designer UI | designer | senior-programista |
| Inżynier Wdrożeń | devops | senior-programista |
| Jarvis | CEO | — |
| Konfigurator Systemu | Engineer | senior-programista |
| Kronikarz | general | kurator-vaultu |
| Krytyk | qa | jarvis |
| Kurator CRM | general | szef-komercyjny |
| Kurator Vaultu | general | jarvis |
| Mięsień Kodu Codex | Engineer | senior-programista |
| Mięsień Kodu Cursor | Engineer | senior-programista |
| Mięsień Kodu GLM | Engineer | senior-programista |
| Mięsień Recenzji GLM | qa | recenzent |
| Mięsień Vault | general | kurator-vaultu |
| Mięsień Web | researcher | badacz |
| Modelarz Procesow | pm | analityk-biznesowy |
| Obserwator Upstream | researcher | badacz |
| Recenzent | qa | jarvis |
| Senior Programista | Engineer | jarvis |
| Specjalista Decków | pm | szef-komercyjny |
| Specjalista Komunikacji Klienckiej | pm | szef-komercyjny |
| Specjalista Ofert | pm | szef-komercyjny |
| Szef Komercyjny | pm | jarvis |
| Zwiadowca Kodu | researcher | senior-programista |
| Zwiadowca Vaultu | researcher | jarvis |

### Skills

| Skill | Description | Source |
|-------|-------------|--------|
| channel-scoped-claims | Before writing "confirmed/verified/passing/deployed/nothing new" as a stated fact, name the channel checked — never let the claim exceed what was actually run or observed this run. | catalog |
| brief | Scoping nowego projektu/feature — ustrukturyzowany wywiad → brief/PRD. Użyj gdy "brief", "PRD", "spec", "nowy projekt", "zdefiniuj", lub na starcie nowej inicjatywy. | catalog |
| budget-review | Przegląd budżetu — statystyki, niekategoryzowane transakcje, poprawki reguł. Użyj gdy Grzegorz chce przejrzeć budżet domowy. | catalog |
| checkpoint | Zapisz resumowalną migawkę długiego zadania WPROST do trwałego dokumentu (ISA projektu / plan / RAM) — co zrobione, co następne (AUTO), co zablokowane (CZŁOWIEK), instrukcja wznowienia. Tak, żeby świeża sesja (albo nocna rutyna) podjęła dokładnie tam, gdzie stanęliśmy. Użyj gdy: '/checkpoint', 'zapisz stan', 'zrób migawkę', przy limicie kontekstu/przerwie w długim zadaniu. Adoptowany od Łukasza s271 (lekko — nasz RAM już robi scratch sesji; checkpoint to TRWAŁY handoff do wznowienia). | catalog |
| code-quality | Wdrożenie Code Quality — autonomiczne wykonanie zaplanowanych sprintów poprawy jakości kodu i polityk. Prowadzi GG krok po kroku, maksymalna samodzielność Jarvisa. | catalog |
| coding-workflow | Workflow kodowania — plan (vertical slices) → docs-gate → koduj → /review → docs-update. Użyj gdy zadanie dotyczy kodu (nowy moduł, fix, refactor, deploy). | catalog |
| commit | Bezpieczny git commit z pre-commit checks (secrets, scope, debug). Użyj przed commitem lub gdy "zapisz", "commit", "checkpoint". | catalog |
| contract | Włącz na czas sesji tryb ścisłej dyscypliny wykonania — zwłaszcza przy debugowaniu: każda próba raportowana (hipoteza/dowód/wynik/następny krok), po 2 nieudanych próbach STOP i instrumentacja zamiast łatania, zero nowych warstw zabezpieczeń bez udowodnienia przyczyny. Użyj gdy: '/contract', 'tryb ścisły', 'przestań zgadywać', 'debuguj porządnie', albo gdy brniesz w łatanie tego samego błędu. Adoptowany od Łukasza s271 (odchudzony — nasze Hard Rules + /coding-workflow już pokrywają resztę jego kontraktu). | catalog |
| daily-brief | Poranny briefing + Daily Loop — PDCA review + Pilot 1/Routines + queue state + APS plan + maile/kalendarz/sociale + 1 fix. Wtorek-piątek 08:00 (poniedziałek = /weekly-review, zawiera daily). | catalog |
| goal | Ustaw weryfikowalny warunek ukończenia i pracuj autonomicznie tura po turze, aż się spełni — z samooceną po każdej akcji. Jedna akcja na turę, sprawdzaj komendą, stop po 3 turach bez postępu (anty-kręcenie). Użyj gdy: 'rób aż', 'nie kończ dopóki', 'pracuj do skutku', '/goal <warunek>', albo gdy delegujesz bounded autonomiczne zadanie (pasuje do /workos-subagent / nocnych rutyn). Adoptowany od Łukasza s271. | catalog |
| grill-me | Stress-test planu/decyzji — adversarial review 7 wymiarów. Użyj przed dużą decyzją, nowym projektem, strategią. | catalog |
| ingest | Przetwórz repo/artykuł/post do vault — explore, filtruj, adoptuj. Użyj gdy GG daje link do repo, artykułu lub posta. | catalog |
| json-canvas | Twórz i edytuj pliki Obsidian JSON Canvas (.canvas) — wizualne mapy systemu, architektury, procesów, przepływu danych, roadmapy i mapy wiedzy. Natywne dla vaulta (otwierają się w Obsidianie bez zewnętrznych narzędzi). Użyj gdy: GG mówi 'narysuj graf', 'zrób mapę systemu', 'wizualizacja architektury', 'mapa procesu', 'pokaż jak to się łączy', 'diagram', 'canvas', '.canvas', albo gdy projektujesz architekturę/proces i chcesz najpierw zobaczyć kształt całości na jednym ekranie (warstwa 1 /layered-design). Adoptowany od Łukasza s271. | catalog |
| layered-design | Metodyka projektowania kompleksowych projektów software warstwami od ogółu do szczegółu. Synteza /lean-process-modeling + /pm + /grill-me. Użyj gdy: nowy duży projekt software, walidacja istniejącego projektu pod kątem luk architektonicznych, pytanie GG 'zaprojektuj projekt X' / 'czy ten projekt jest dobrze zdefiniowany' / 'idziemy warstwami'. | catalog |
| lean-process-modeling | Modelowanie procesów BPMN/Lean metodą strugania warstwami od ogółu do szczegółu. Zapobiega nurkowaniu w detale i halucynowaniu. Użyj przy: projektowaniu nowego procesu, edycji pliku .bpmn, analizie istniejącego procesu, pytaniu GG 'przeprowadź mnie przez ten proces' / 'jak inżynier procesu Lean' / 'zaprojektuj proces X' / 'cykl życia X' / 'warstwa N'. | catalog |
| meeting-audit | Audyt spotkania — wyciąga z transkryptu ślad odpowiedzialności: kto co zaproponował, kto na co przystał, gdzie pełzł zakres, jak dryfowały priorytety — z DOSŁOWNYMI cytatami i znacznikami czasu. Raport 'dryf priorytetów' przez kilka spotkań. Użyj gdy: 'zaudytuj spotkanie z X', 'kto na co przystał', 'czy pełzł zakres', 'kto to zdecydował', 'sprawdź ustalenia ze spotkania', przed rozmową o zmianie zakresu z klientem. Adoptowany od Łukasza s271 (odbudowany na naszym Fireflies MCP, nie jego narzędziu). Uzupełnia /meeting-followup (ten robi CRM/zadania — audyt robi rozliczalność). | catalog |
| meeting-followup | Follow-up po spotkaniu — CRM, Vikunja, Dziennik, Boot Manifest. Użyj po spotkaniu z klientem/kontaktem. | catalog |
| pm | Meta-PM — pełny cykl PM (9 trybów): diagnostyka, scope, portfolio, defer, offer, roadmap, plan, verify, retrospect. E10 s86. Użyj gdy "to jest projekt?", "portfolio", "defer", "roadmap", "plan sprintów", "verify gate", "retrospective", lub gdy hook pm_trigger sugeruje. | catalog |
| release | Rytuał wydania usługi/biblioteki — podbicie wersji + CHANGELOG z konwencjonalnych commitów + tag git + brama synchronizacji docs + brama świeżości grafu, dostrojone do naszych repo (monorepo jarvis-infra, siblingi semver, <operator-skill-root>). Użyj gdy: '/release {usługa}', 'wydaj', 'zrób release', 'bump wersji', 'wytnij wydanie', po zamknięciu większej zmiany kodu PRZED/PO deployu. Adoptowany od Łukasza s271 (inżynieria wydań), dostrojony do naszej realnej struktury (recon s271). | catalog |
| research-radar | Radar nowości Claude Code — odpal harvester, oceń kandydatów, zwróć top-5 z rekomendacją (wciągnij teraz / obserwuj / pomiń). Użyj gdy "radar", "research radar", "co nowego w claude code", "skan nowości CC", "nowe skille/hooki/triki". | catalog |
| research | Workflow researchu — zbieranie, synteza, zapis do Bazy Wiedzy. Użyj gdy research wieloźródłowy lub GG zleca analizę. | catalog |
| review | Code review — 8 wymiarów (secrets, costs, data, encoding, quality, debug, correctness/security, zgodność z regułami) + ocena pewności i filtr false-positive. Użyj po kodowaniu, przed commitem. | catalog |
| sesja-kontynuacja | Deklaruj że bieżąca sesja KONTYNUUJE temat z poprzedniej sesji w nowym oknie. Dziedziczę kontekst rodzica. Trigger: /sesja-kontynuacja {numer rodzica} {opis}. Etap 4 Audytu Sesji Równoległych. | catalog |
| sesja-niezalezna | "Deklaruj że bieżąca sesja jest NIEZALEŻNA — kompletnie nowy temat, brak związku z innymi sesjami. Trigger: /sesja-niezalezna {opis}, „nowa niezależna sesja". Etap 4 Audytu Sesji Równoległych." | catalog |
| sesja-pomocnicza | Deklaruj że bieżąca sesja jest POMOCNICZA — wykonuje węższe zadanie zlecone przez sesję-rodzica. Trigger: /sesja-pomocnicza {numer rodzica} {opis}. Etap 4 Audytu Sesji Równoległych. | catalog |
| sesja-rownolegla | Deklaruj że bieżąca sesja pracuje SIOSTRZANIE obok już otwartej sesji nad innym fragmentem tego samego dużego tematu. Trigger: /sesja-rownolegla {numer siostry} {opis}. Etap 4 Audytu Sesji Równoległych. | catalog |
| sesje | "Pokaż żywe sesje Jarvisa, osierocone notatniki i zerwane wpisy. Trigger: /sesje, „pokaż sesje", „kto żyje", „jakie sesje". Realizacja Reguły 4 z [[Wizja systemu — Audyt Sesji Równoległych]]." | catalog |
| session-closing | Protokół zamknięcia tematu/sesji — OBOWIĄZKOWY checklist przed powiedzeniem 'gotowe'. Użyj gdy kończysz temat, sprint, lub sesję. | catalog |
| ticket | Zaloguj błąd jako ponumerowany bilet, potem napraw go end-to-end w jednym podejściu — z papierowym śladem i klasyfikacją 'czy dało się uniknąć?'. Każdy zamknięty bilet zasila prewencję (session-closing → pamięć/PDCA). Użyj gdy: 'bug', 'zepsute', 'nie działa', 'napraw to', 'bilet', zgłoszenie defektu w kodzie. Adoptowany od Łukasza s271 (taksonomia unikalności + kompletności to jego perła; protokół naprawy oparty o nasz /coding-workflow). | catalog |
| vault-architect | Reorganizacja folderu projektu w vault: helicopter view → intuicyjna struktura tematyczna → brama akceptacji GG → przenosiny i zmiana nazw link-safe (skryptem, z backupem) → polityka 'gdzie co leży' → walidacja 0 broken wikilinków. Użyj gdy: GG mówi 'folder X jest chaotyczny / nie umiem się połapać', 'uporządkuj vault projektu', 'reorganizacja folderu', lub przy starcie nowego dużego projektu (postaw szkielet). Wzorzec wypracowany s172 (SLK Etap 0). | catalog |
| weekly-review | Weekly Review — poniedziałkowy przegląd systemu. Zastępuje /daily-brief w poniedziałki (zawiera daily w sobie). Użyj w poniedziałek rano lub gdy Grzegorz poprosi o przegląd tygodnia. | catalog |
| workos-subagent | WorkOS Subagent Pipeline — biblioteka 3-tier prompt templates (Haiku worker / Sonnet supervisor / Opus architect) dla nocnych autonomicznych sesji Cloud Routines. Użyj gdy planujesz delegację bounded taska do subagenta lub projektujesz Routine run. | catalog |
| paperclip-board | Manage a Paperclip company as a board member via chat. Use when the user wants onboarding, company or agent management, approvals, task monitoring, cost oversight, or work product review in the Paperclip control plane. | [github](https://github.com/paperclipai/paperclip/tree/master/skills/paperclip-board) |
| paperclip-converting-plans-to-tasks | Convert Paperclip plans into executable issue graphs. Use when asked to plan, scope, or break down Paperclip company work into assigned tasks with specialty fit, dependencies, blockers, and parallelization. | [github](https://github.com/paperclipai/paperclip/tree/master/skills/paperclip-converting-plans-to-tasks) |
| paperclip-create-agent | Create new agents in Paperclip with governance-aware hiring. Use when you need to inspect adapter configuration options, compare existing agent configs, draft a new agent prompt/config, and submit a hire request. | [github](https://github.com/paperclipai/paperclip/tree/master/skills/paperclip-create-agent) |
| paperclip | Interact with the Paperclip control plane API for task coordination and governance. Use when checking assignments, updating issue status, posting comments, delegating work, managing routines, or calling Paperclip API endpoints. | [github](https://github.com/paperclipai/paperclip/tree/master/skills/paperclip) |
| para-memory-files | Use a file-based PARA memory system to store, retrieve, and organize durable knowledge across sessions. Trigger on saving facts, daily notes, entity records, weekly synthesis, recall, tacit user patterns, or plan memory. | [github](https://github.com/paperclipai/paperclip/tree/master/skills/para-memory-files) |

## Getting Started

```bash
pnpm paperclipai company import this-github-url-or-folder
```

See [Paperclip](https://paperclip.ing) for more information.

---
Exported from [Paperclip](https://paperclip.ing) on 2026-07-29
