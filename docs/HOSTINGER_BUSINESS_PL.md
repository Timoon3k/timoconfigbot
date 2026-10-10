# Hostinger Business — przygotowanie wdrożenia

## Wykonalność i ograniczenia

Wykorzystujemy istniejący Fastify, PostgreSQL i Discord; WordPress pozostaje osobną stroną. Nowy `dist/hostinger.js` uruchamia API, worker i opcjonalny Gateway w jednym procesie Node, bez VPS, Docker, PM2 ani systemd na hostingu. Koszt dodatkowego hostingu: 0 €, o ile opłacony plan udostępnia tę aplikację, potrzebny runtime i zasoby. Nie dodawaj płatnych rozszerzeń ani Supabase Pro.

Nie wykonano wdrożenia ani połączenia z Discord/Supabase. Próba odczytu oficjalnych stron Hostinger i Supabase zwróciła HTTP 403. Dostępność Node.js i wychodzącego WebSocket przyjęto zgodnie z opisem właściciela; ciągłe działanie Gateway, usypianie procesów, limity RAM/CPU i dostęp cron do plików Node wymagają potwierdzenia w hPanel i rzeczywistego testu. Nie ma potwierdzenia gwarancji always-on ani bieżących limitów planu Free.

Źródła do sprawdzenia w panelu/przeglądarce właściciela: [Hostinger Support](https://www.hostinger.com/support/), [połączenia PostgreSQL Supabase](https://supabase.com/docs/guides/database/connecting-to-postgres), [przygotowanie Supabase do produkcji](https://supabase.com/docs/guides/platform/going-into-prod). Nie traktuj nieodczytanych stron jako zweryfikowanej instrukcji aktualnego interfejsu.

## Konfiguracja — dokładna lista

Kompletny szablon to `.env.hostinger.example`; sekretów nie wpisuj do repozytorium, build command ani cron command.

| Zmienne | Wartości / cel |
| --- | --- |
| NODE_ENV, HOST, PORT | production, 0.0.0.0, port przypisany przez Hostinger; nie nadpisuj automatycznie wstrzykniętego PORT |
| HOSTINGER_BACKGROUND_MODE | continuous; po nieudanym teście trwałości Gateway: cron |
| DATABASE_URL | URI z Supabase Connect, session pooler na 5432; kodowane hasło w bezpiecznym ustawieniu |
| DB_CONNECTION_MODE, DB_SSL_MODE, DB_POOL_MAX | session (lub direct), require, 5 |
| DB_CA_CERT | opcjonalny zaufany CA w formacie PEM; bez wyłączania weryfikacji certyfikatu |
| SESSION_PEPPER, PASSWORD_PEPPER | dwa niezależne losowe sekrety, co najmniej 32 znaki |
| PAYMENT_PROVIDER, PAYMENTS_ENABLED, PROVIDER_APPROVAL_CONFIRMED | mock, false, false; symulacje nie są wykonywane w runtime produkcyjnym |
| DISCORD_ENVIRONMENT | production; nie test-guild |
| DISCORD_GUILD_ID, DISCORD_PRODUCTION_GUILD_ID | to samo prawdziwe ID TimonConfigs |
| DISCORD_GUILD_OWNER_ID, DISCORD_CLIENT_ID | ID właściciela serwera i aplikacji/bota |
| DISCORD_FREE_MEMBER_ROLE_ID, DISCORD_VIP_MONTHLY_ROLE_ID, DISCORD_VIP_LIFETIME_ROLE_ID, DISCORD_FOUNDER_ROLE_ID, DISCORD_STAFF_ROLE_ID | pięć dokładnych ID ról; wszystkie ID w konfiguracji muszą być odrębne |
| DISCORD_BOT_TOKEN, DISCORD_CLIENT_SECRET, DISCORD_INTERACTIONS_PUBLIC_KEY | token i secret wyłącznie w chronionych ustawieniach; public key Ed25519: 64 znaki hex |
| DISCORD_OAUTH_REDIRECT_URI, DISCORD_SUPPORT_URL | https://bot.timonconfigs.com/api/discord/callback, https://timonconfigs.com |
| DISCORD_OWNER_APPROVED, DISCORD_APPROVAL_REFERENCE | po jawnej zgodzie właściciela na odczyt: true i referencja 8–200 znaków |
| DISCORD_ADAPTER | rest — dodaj jawnie w hPanel; szablon zawiera tę wartość |
| DISCORD_NETWORK_ENABLED, DISCORD_DRY_RUN, DISCORD_WRITES_ENABLED | etap odczytu: true, true, false |
| DISCORD_VERIFICATION_ENABLED, DISCORD_GATEWAY_ENABLED | true; Gateway początkowo false, włącz dopiero do zatwierdzonej próby ciągłości |
| DISCORD_FREE_MEMBER_WRITES_APPROVED, DISCORD_FREE_MEMBER_APPROVAL_REFERENCE | początkowo false i puste; osobna zgoda dopiero w etapie 2 |
| DISCORD_PRODUCTION_VIP_WRITES_ENABLED, DISCORD_VIP_SYNC_ENABLED, DISCORD_COMMANDS_ENABLED | zawsze false w tym wydaniu |
| DISCORD_WORKER_POLL_MS, DISCORD_WORKER_BATCH_SIZE | 1000, 5 |
| DISCORD_RECONCILE_SECONDS, DISCORD_RECONCILE_BATCH_SIZE | 300, 25; dopasuj do liczby członków i limitów |
| DISCORD_MIN_REQUEST_MS, DISCORD_LEASE_SECONDS, DISCORD_MAX_ATTEMPTS | 250, 120, 8 |
| CRON_MAX_TICKS, CRON_MAX_DURATION_MS, CRON_EXPECTED_INTERVAL_SECONDS | 3, 45000, 300 — tylko wariant cron |

Nie ustawiaj DISCORD_TEST_GUILD_ID w produkcji. Szablon celowo ma zgody i sieć wyłączone oraz puste ID; aplikacja odmawia niepełnej konfiguracji. Aktualny interfejs płatności obsługuje tylko mock: w produkcji odrzuca zdarzenia, zamówienia i subskrypcje mock, a symulowane entitlements nie dają VIP. Produkcyjne role VIP są zachowywane bez mutacji aż do przyszłej integracji zatwierdzonego operatora i osobnej autoryzacji. Nie przekonwertowano mock płatności w „realne” rekordy.

## Supabase Free

1. Utwórz projekt na planie Free. Zachowaj bazę development/test oddzielnie od produkcyjnej.
2. W Connect skopiuj URI **Session pooler**, port 5432, właściwego użytkownika i host. Host może zależeć od regionu. Nie używaj portu 6543 ani Transaction pooler. Direct jest dopuszczalny tylko jeśli Hostinger ma działającą łączność z jego adresem, w tym wymaganym IPv6.
3. Włącz DB_SSL_MODE=require. Certyfikat i hostname są weryfikowane; opcjonalny CA pochodzi wyłącznie od dostawcy. Pool używa maksymalnie 5 sesji; jedna pozostaje zajęta przez lidera. Nie zakładaj, że zmiana nazwy trybu na session zmienia konfigurację poolera — wybierz właściwy endpoint w Supabase.
4. Po zgodzie na wdrożenie wykonaj kopię bazy i migracje **001–003** przez istniejący runner. Na zaufanym komputerze: `npm ci`, `npm run build`, następnie `node --env-file=/PRIVATE/PATH/.env.hostinger.local dist/db/cli.js up`. Prawdziwy plik env pozostaje poza repozytorium i publicznym katalogiem. Możesz też użyć zatwierdzonej konsoli/release command hostingu, jeśli udostępnia te same chronione zmienne.
5. Runner zachowuje checksums i blokadę sesyjną. Hosted startup nie migruje automatycznie i wymaga przygotowanej tabeli discord_member_jobs. Nie uruchamiaj samego starego db/schema.sql jako zamiennika migracji.
6. Zweryfikuj TLS, `SELECT 1`, trwałość session advisory lock i odtworzenie połączenia na prawdziwym endpointcie. Testy lokalne potwierdzają PostgreSQL 16/TLS i odzyskiwanie; nie potwierdzają konfiguracji rzeczywistego Supabase.
7. Sprawdź aktualne limity połączeń/storage oraz politykę usypiania Free. Uśpiona/nieosiągalna baza zatrzymuje lidera i weryfikację; nie zastępuj tego płatnym planem bez zgody. Potrzebna jest niezależna procedura kopii i przywrócenia.

## Hostinger hPanel — do wykonania dopiero po zgodzie

1. Websites → Add Website → Node.js Web App → Connect GitHub Repository. Podłącz istniejące `Timoon3k/timoconfigbot`, gałąź `deploy/hostinger-business`, katalog główny `/`. Wybierz backend Node/custom zgodnie z dostępnym ekranem; nie generuj nowej aplikacji. Jeśli wymienione pola/komenda startowa nie są dostępne, przerwij i sprawdź ograniczenie planu z Hostinger.
2. Wybierz Node 24 albo Node 22 co najmniej 22.13. Build: `npm ci --include=dev && npm run build`. Start: `npm start` (alias `npm run start:hostinger`); jeśli panel wymaga pliku entry point, podaj `dist/hostinger.js`. Nie wybieraj `start:api` ani osobnego workera. Dev dependencies są potrzebne tylko do kompilacji.
3. Wprowadź chronione zmienne zgodnie z tabelą. Przygotuj migracje przed startem. Nie dodawaj Discord tokenu jako argumentu polecenia ani jawnego pliku w public_html. Nie łącz instalacji z produkcyjnymi symulacjami/demo.
4. Podłącz subdomenę `bot.timonconfigs.com`, ustaw rekordy DNS dokładnie według hPanel i włącz SSL/HTTPS. Nie zmieniaj WordPress ani głównej domeny. HTTPS musi działać przed OAuth i interakcjami.
5. Etap 1: właściciel zatwierdza wyłącznie odczyt; `DISCORD_DRY_RUN=true`, `DISCORD_WRITES_ENABLED=false`. Najpierw sprawdź `/health` (żywotność procesu) i `/ready` (baza + ukończony tick workera + Gateway, jeśli włączony). 503 oznacza brak gotowości, nie powodzenie wdrożenia. Standby procesu jest celowo niegotowe do pracy w tle.
6. Po zgodzie włącz Gateway i przeprowadź próbę ciągłości co najmniej 24 godziny, także bez ruchu HTTP, po restarcie i po kontrolowanej przerwie bazy. Sprawdź /ready, audit i heartbeat; nie używaj sztucznych pingów jako dowodu gwarancji always-on. Runtime odbudowuje lidera i zadania po awarii, lecz nie uruchomi się sam, jeśli hosting zatrzyma całą aplikację.
7. Etap 2, osobno zatwierdzony: usuń ręcznie Dyno Free Member Autoroles, potwierdź screening/hierarchię, ustaw `DISCORD_FREE_MEMBER_WRITES_APPROVED=true` i inną referencję niż zgoda na odczyt, następnie `DISCORD_DRY_RUN=false`, `DISCORD_WRITES_ENABLED=true`. Wyłącznie Free Member może być dodawana; nigdy usuwana. VIP i rejestracja komend nadal zablokowane. Po tej zmianie ponów kontrolowaną próbę dwóch kont.
8. Jeśli ciągły proces nie działa stabilnie, wróć do DRY_RUN i konfiguracji cron. Nie kupuj VPS ani dodatkowej usługi; jeśli plan nie umożliwia także bounded cron, wdrożenie w tym budżecie pozostaje zablokowane.

## Cron: ograniczone pojedyncze uruchomienie

Ustaw HOSTINGER_BACKGROUND_MODE=cron i DISCORD_GATEWAY_ENABLED=false. W hPanel → Cron Jobs (jeśli dostępne dla tego konta) wybierz co 5 minut `*/5 * * * *`. Polecenie po sprawdzeniu rzeczywistej ścieżki Node i katalogu checkoutu:

`/ABSOLUTE/PATH/TO/node --env-file=/PRIVATE/PATH/.env.hostinger.local /ABSOLUTE/APP/PATH/dist/discord/cron-cli.js`

Plik env musi być poza katalogiem publicznym, dostępny tylko właścicielowi procesu (np. 600). Nie zakładaj, że cron dziedziczy zmienne Node Web App. Jeśli cron nie widzi checkoutu, właściwej wersji Node lub nie pozwala bezpiecznie dostarczyć env, ten wariant nie jest jeszcze wykonalny; nie dodawaj publicznego endpointu nadawania ról jako obejścia.

CLI wykonuje maksymalnie 3 ticki i 45 sekund pracy; twardy limit procesu to dodatkowe 10 sekund na zatrzymanie. Używa tej samej blokady co Gateway, więc overlap lub aktywny lider nie uruchamia drugiego reconciliatora. Każdy tick ma ograniczoną liczbę stron i zadań. 429 respektuje Retry-After i wspólny limiter; zadania pozostają w bazie na następną próbę. `/ready` wymaga świeżego znacznika udanego cron (interwał + 120 sekund).

Bez Gateway dodanie Free Member jest opóźnione: do czasu następnego skanu/cron, a przy dużym serwerze o więcej cykli przez stronicowanie, kolejkę i rate limits. Aktualne parametry nie gwarantują obsługi wszystkich członków w 5 minut. Monitoruj backlog, dead-letter i heartbeat; zwiększaj przepustowość tylko w granicach zasobów i limitów Discord. Żaden cron nie jest nieskończonym procesem workera.

## Discord Developer Portal

1. Użyj aplikacji przeznaczonej wyłącznie dla prawdziwego TimonConfigs. W Bot włącz Server Members Intent; wymagane intencje: Guilds + Guild Members (3), bez Message Content.
2. Skopiuj Application ID, publiczny klucz Ed25519, Bot Token i Client Secret do chronionych ustawień. Bot powinien należeć tylko do zadeklarowanego serwera; READY odrzuca inną listę serwerów.
3. OAuth2 → Redirects: dokładnie `https://bot.timonconfigs.com/api/discord/callback`. Scope użytkownika: identify; bez automatycznego zapraszania i wiadomości. Powiązanie wymaga istniejącego zalogowanego konta aplikacji, state/PKCE, CSRF i ponownej autoryzacji.
4. General Information → Interactions Endpoint URL: `https://bot.timonconfigs.com/api/discord/interactions`. Sprawdź HTTPS i podpisany PING. Komendy mają odpowiedzi ephemeral i nie nadają ról. Produkcyjna rejestracja komend nie jest automatyzowana w tym wydaniu; jeśli aplikacja ich jeszcze nie ma, wymaga osobno zatwierdzonej rejestracji przed użyciem.
5. Instalacja aplikacji: bot + applications.commands; do dodawania Free Member tylko Manage Roles (268435456), nigdy Administrator. Founder/Staff nad botem, Free Member/obie VIP poniżej; role docelowe bez Administrator/Manage Roles i bez managed integration role.
6. Włącz natywny Rules Screening. pending=false może oznaczać także administracyjne pominięcie screening; brak pola nie uprawnia do dodania roli. Kanały skonfiguruj ręcznie według DISCORD_COMPLETION_PL.md, zachowując Dyno, Ticket Tool, AutoMod i prywatne tickety.

## Pozostałe bramki

Jawna zgoda na wdrożenie i odczyt prawdziwego serwera, rzeczywiste ID/sekrety, zgodność planu i Node, migracja/backup Supabase, test TLS/session poolera, próba trwałości Gateway lub dostęp bounded cron, konfiguracja DNS/HTTPS/OAuth i ręcznych permissions. Nadanie Free Member wymaga następnej zgody. Produkcyjne VIP wymagają przyszłego zatwierdzonego operatora i wiarygodnej proweniencji płatności; obecne mock dane są całkowicie ignorowane w runtime produkcyjnym. Nie wykonano żadnego kroku produkcyjnego w tej sesji.

## Wyniki tej sesji

Pełna regresja: **126/126** (6 legacy, 47 jednostkowych, 73 integracyjne), bez pominięć; test TLS uruchomiono z lokalnym certyfikatem CA. Po dopracowaniu entry pointu i health ponowiono tylko istotne testy: **25/25**, lint, typecheck, build i oba smoke. Smoke potwierdził wspólny proces HTTP/worker, restart i odzyskanie lease, bounded cron/heartbeat, zachowanie dotychczasowego offline API oraz graceful shutdown. Test rozłączenia rzeczywiście zakończył sesję PostgreSQL; wszystkie operacje Discord pozostały symulowane. Migracje 001–003 zachowano bez zmian.

Główne pliki: src/hostinger.ts, src/discord/supervisor.ts, src/discord/cron-cli.ts, src/db/pool.ts, istniejące config/runtime/Gateway/worker/REST/safety/API, wąska bramka symulacji w src/membership/service.ts, package.json, .env.hostinger.example oraz nowe testy i smoke. Nie zweryfikowano rzeczywistego Supabase ani Hostinger.
