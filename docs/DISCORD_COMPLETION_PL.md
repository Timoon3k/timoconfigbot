# Ukończenie automatyzacji Discord

Kod rozszerza istniejący backend. Domyślnie pozostaje offline i DRY_RUN. Tryb produkcyjny jest odrzucany; dostęp sieciowy obsługuje wyłącznie jawnie zatwierdzony, osobny serwer testowy. Płatności pozostają mock.

## Rules Screening i odzyskiwanie

Gateway obsługuje GUILD_MEMBER_ADD, GUILD_MEMBER_UPDATE i GUILD_MEMBER_REMOVE, heartbeat/ACK, reconnect oraz resume. Wymaga Guilds + Server Members Intent (bitmask 3), bez Message Content. Jeden proces Gateway na serwer zabezpiecza blokada PostgreSQL; inne workery mogą równolegle przetwarzać kolejki. Limit IDENTIFY jest sprawdzany przez /gateway/bot, a identyfikacje są oddzielone co najmniej 5 sekundami.

Zdarzenia są deduplikowane po sesji i numerze sekwencji. Trwałe zadania, leasing i stronicowany skan członków naprawiają restarty i pominięte zdarzenia. Przed dodaniem Free Member bot ponownie pobiera członka przez REST. Tylko jawne pending=false pozwala planować dodanie; brak pola, pending=true i konta botów nie otrzymują tej roli. Free Member nigdy nie jest usuwana przez automat.

pending=false oznacza zakończenie lub administracyjne pominięcie Rules Screening. API nie potwierdza, że użytkownik osobiście przeczytał regulamin. Nadanie roli może obejść screening, dlatego również dodanie VIP wymaga aktualnego pending=false. Żaden timer nie jest dowodem weryfikacji. Discord nie zapewnia atomowego warunku „dodaj rolę tylko jeśli pending=false”; tuż przed PUT wykonywana jest ponowna kontrola, ale właściciel nie powinien równolegle ręcznie zmieniać screening/zarządzanych ról.

## Uprawnienia i awarie

Allowlista obejmuje VIP Monthly, VIP Lifetime oraz Free Member tylko po włączeniu weryfikacji. Founder i Staff muszą być powyżej bota; wszystkie zarządzane role poniżej. Bot wymaga Manage Roles, odrzuca Administrator oraz uprzywilejowane role docelowe. Nie zmienia kanałów, wiadomości ani prywatnych ticketów.

Synchronizacja ponownie oblicza uprawnienia w transakcji, blokując konto i danego członka. Usuwa VIP wyłącznie z potwierdzoną własnością bot_assignment lub approved_migration. Własność z mock_seed nie działa w trybie test-guild. Istniejące ręczne role pozostają zachowane i zgłaszane. Wyjście/ponowne dołączenie oraz zaobserwowane usunięcie roli unieważniają stary zapis własności.

Zamiar operacji i audit są zatwierdzane przed REST. Potwierdzony wynik pozwala odzyskać własność po rollbacku bazy. Wynik niepewny pozostaje uncertain i nie upoważnia do przejęcia/usunięcia roli; wymaga przeglądu właściciela. Nie edytuj ręcznie ról zarządzanych przez bota: niezaobserwowane usunięcie i ponowne ręczne nadanie tej samej roli nie jest rozróżnialne przez sam REST. Retry respektuje 429/Retry-After, wspólny limiter PostgreSQL i limit prób. Nieodwracalne błędy trafiają do dead-letter. Statystyki administratora obejmują także kolejkę weryfikacji; jej ponowienie wymaga RBAC administratora i CSRF.

Migracja 003 jest wersjonowana. Rollback odmawia usunięcia historii rzeczywistych operacji; po testach online zachowaj bazę jako dowód własności i audytu.

## Ręczna konfiguracja serwera

1. Utwórz osobną aplikację i osobny serwer testowy. Bot testowy musi należeć wyłącznie do niego. Włącz natywny Rules Screening w ustawieniach Discord; jego dostępność zależy od konfiguracji Community.
2. W Developer Portal włącz Server Members Intent. Użyj bot + applications.commands i uprawnienia Manage Roles (268435456), bez Administrator. Aplikacje wymagające zatwierdzenia privileged intent muszą je uzyskać.
3. Ustaw Founder/Staff powyżej bota, a Free Member i obie role VIP poniżej. Role docelowe nie mogą mieć Administrator/Manage Roles ani być rolami integracji.
4. Przed aktywacją nowego przepływu usuń ręcznie regułę Dyno Free Member Autoroles. Zachowaj moderację/powitania Dyno, AutoMod i konfigurację Ticket Tool.
5. Dla @everyone ukryj kanały społeczności oraz VIP; Free Member otrzymuje View Channel tylko dla bezpłatnej społeczności. Obie role VIP dostają dostęp do kategorii VIP. Sprawdź nadpisania kategorii i kanałów oraz wyjątki Founder/Staff. Bot nie wykonuje tych zmian.
6. Pozostaw prywatne tickety niewidoczne dla Free Member i VIP. Sprawdź istniejące nadpisania autora ticketu i personelu; nie synchronizuj automatycznie kategorii ticketów.

## Dokładne warunki aktywacji testowej — do wykonania przez właściciela później

- Skopiuj .env.test-guild.example do ignorowanego .env.test-guild.local. Uzupełnij osobną bazę testową, mocne peppery, token/secret aplikacji, publiczny klucz interakcji i wszystkie prawdziwe ID tego serwera. DISCORD_TEST_GUILD_ID musi równać się DISCORD_GUILD_ID, a DISCORD_GUILD_OWNER_ID musi wskazywać jego właściciela. Nie używaj ID ani tokenu produkcyjnego serwera.
- Po przeglądzie kodu zapisz własną jawną zgodę: DISCORD_OWNER_APPROVED=true i niepusty DISCORD_APPROVAL_REFERENCE (8–200 znaków). Tego zadania nie należy interpretować jako udzielonej zgody na połączenie.
- Etap odczytu: DISCORD_ENVIRONMENT=test-guild, DISCORD_ADAPTER=rest, DISCORD_NETWORK_ENABLED=true, DISCORD_DRY_RUN=true, DISCORD_WRITES_ENABLED=false. Włącz DISCORD_VERIFICATION_ENABLED=true oraz DISCORD_GATEWAY_ENABLED=true, a VIP_SYNC dopiero gdy chcesz testować powiązane konta. Realne OAuth w tym trybie wywołuje Discord, lecz nie zmienia ról; wymaga zalogowanego konta, CSRF, ponownej autoryzacji, state/PKCE i zgodnego redirect URI.
- Po osobnej akceptacji zmian ról: DISCORD_DRY_RUN=false, DISCORD_WRITES_ENABLED=true. Produkcja nadal jest zablokowana. Dane produktów i potwierdzenia płatności nadal pochodzą wyłącznie z adaptera mock, na osobnej bazie testowej.
- Załaduj zmienne, wykonaj npm run db:migrate, uruchom API przez npm run dev i worker przez npm run discord:worker. Dla pliku env można użyć Node: node --env-file=.env.test-guild.local --import tsx src/discord/worker-cli.ts (analogicznie src/server.ts i src/db/cli.ts up).
- Ustaw HTTPS Interaction Endpoint URL /api/discord/interactions oraz dokładny redirect OAuth. Komendy są podpisywane Ed25519 i sprawdzają aplikację/serwer; odpowiedzi są ephemeral. Endpoint nie nadaje ról.
- npm run discord:commands domyślnie tylko wyświetla payload. Po zgodzie na rejestrację ustaw także DISCORD_COMMANDS_ENABLED=true i uruchom z konfiguracją testową. Rejestracja zastępuje wyłącznie komendy tej aplikacji na wskazanym serwerze testowym; nie dotyka Dyno/Ticket Tool ani komend globalnych.
- Przetestuj dwa kontrolowane konta: wejście pending=true bez Free Member, zakończenie screening, oba produkty Monthly, Lifetime, wygaśnięcie, anulowanie, nieudane odnowienie, refund/dispute, unlink/relink, leave/rejoin i restart workera. Sprawdź audit, ownership, retry i dead-letter. Testy automatyczne nie zastępują tego testu Discord.

Ticket Tool nie jest traktowany jako publiczne API. Bezpieczna alternatywa: właściciel ręcznie dodaje szablony z SUPPORT_TEMPLATES_EN.md do istniejącej obsługi ticketów. Bot nie odczytuje prywatnych rozmów i nie wysyła automatycznych powitań ani DM.

## Wykonana walidacja

Na izolowanej PostgreSQL 16 uruchomiono migracje 001–003 i pełną regresję: 6 testów legacy, 34 jednostkowe i 68 integracyjnych — 108/108, bez pominięć i błędów. Lint, typecheck, build i walidacja katalogu przeszły. Smoke skompilowanych procesów potwierdził migracje, autoryzację HTTP, readiness, trwałe preview i poprawne zakończenie procesów przy zerowej liczbie zmian Discord. Sprawdzono też odczyt .env.example i komendy w trybie DRY_RUN. Gateway/REST/OAuth testowano wyłącznie z atrapami; rzeczywistego serwera Discord nie podłączono.

Główne zmiany: src/discord/{gateway,verification,operations,register-commands-cli}.ts; istniejące config/runtime/adapters/policy/rest/transport/sync/queue/worker/http/commands; migracja 003; szablony .env; testy Gateway i integracji Discord. Silnik płatności i członkostwa zachowano.
