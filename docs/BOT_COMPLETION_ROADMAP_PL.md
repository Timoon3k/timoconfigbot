# TimonConfigs VIP Bot — plan ukończenia całej automatyzacji

## Przyjęty sposób pracy

Właściciel chce najpierw dokończyć pełny system, a dopiero później przeprowadzić **jeden kompleksowy odbiór na rzeczywistym Discordzie i stronie**. Nie wymagamy ręcznego wykonywania zapytań SQL po każdej drobnej zmianie. Mimo to każda zmiana kodu wymaga automatycznego `typecheck`, `build`, testów jednostkowych/integracyjnych i przeglądu bezpieczeństwa przed scaleniem. Manualny E2E może odbyć się na końcu.

**Nie wolno aktywować zapisów ról w produkcji tylko dlatego, że implementacja została ukończona.** Do czasu zatwierdzonego E2E zachować:
```dotenv
DISCORD_FREE_MEMBER_ROLLOUT_MODE=disabled
DISCORD_DRY_RUN=true
DISCORD_WRITES_ENABLED=false
DISCORD_FREE_MEMBER_WRITES_APPROVED=false
DISCORD_VIP_SYNC_ENABLED=false
DISCORD_PRODUCTION_VIP_WRITES_ENABLED=false
DISCORD_COMMANDS_ENABLED=false
PAYMENTS_ENABLED=false
```
Nie wyłączać Rules Screening. Dyno Free Member Autoroles jest już wyłączony. Dopóki nowy bot nie będzie aktywny, należy świadomie obsługiwać brak automatycznej roli (np. ręcznie) — nie włączać starej reguły, która może ominąć screening.

## Stan faktyczny (na bazie `fix/canary-invalid-id`)

- Hostinger Business Node.js + Supabase PostgreSQL + aktywne połączenie Discord Gateway.
- Worker, trwałe member jobs, REST, role-policy, OAuth2, podstawowe API kont/membership oraz komendy `/help`, `/membership`, `/sync-status` jako kod, ale bez rejestracji komend produkcyjnych.
- Free Member: istnieje logika aktualnego `pending === false` i wykluczenia botów. Weryfikacja DRY_RUN prawdziwego konta zwróciła `status=succeeded`, `outcome=preview`, `pending=false`.
- `feature/free-member-canary`: ograniczenia zapisów do 1–2 ID, z oddzielną zgodą na cały serwer; `fix/canary-invalid-id`: poprawka obsługi niepoprawnych wartości ID.
- VIP entitlement engine w DB, ale brak autoryzowanych rzeczywistych płatności i pełnego portalu użytkownika.
- Historyczne `dead_letter` po wcześniejszym błędzie identyfikatora właściciela i Staff/hierarchii. Nie usuwać historii.

## Kolejne etapy kodowania

### 1. Operacyjna niezawodność Discord i Free Member

- [x] Gateway, Rules Screening, REST recheck, ochrona chronionych ról, DRY_RUN, canary.
- [x] Na tej gałęzi: bounded requeue `dead_letter` wyłącznie dla `GUILD_IDENTITY_MISMATCH` i `PROTECTED_HIERARCHY_INVALID`, gdy aktualna tożsamość i hierarchia serwera zostały ponownie pozytywnie sprawdzone. Nie dotyka innych błędów; requeue nie nadaje roli.
- [ ] Przetestować migracje, równoległość recovery, rate limits, restart, gateway eventy i nowe konto w laboratorium.
- [ ] Przygotować administratorowi bezpieczny interfejs do statusu kolejki i ręcznego ponowienia innych błędów, zamiast bezpośrednich zapytań SQL.
- [ ] Przygotować runbook przełączenia Dyno -> TimonConfigs, monitoring i rollback.

### 2. Komendy Discord

- [ ] Dopracować i zarejestrować trzy prywatne, wyłącznie odczytowe komendy: `/membership`, `/sync-status`, `/help`.
- [ ] Rozdzielić zatwierdzenie rejestracji definicji komend (Discord PUT, ale bez zmian ról) od zatwierdzenia zmian ról. Istniejąca produkcyjna konfiguracja celowo zabrania `DISCORD_COMMANDS_ENABLED=true`.
- [ ] Kontrole podpisu Ed25519, ephemeral responses, RBAC, brak ujawniania danych oraz sandbox tests.

### 3. Integracja WordPress `timonconfigs.com`

- [ ] Wybrać architekturę wykorzystującą istniejący WordPress i Node backend na Hostingerze, bez konieczności nowego płatnego serwera. Preferowana dedykowana wtyczka WordPress + API Node, nie nowy publiczny system logowania bez zabezpieczeń.
- [ ] Portal klienta EN: rejestracja/logowanie, link Discord OAuth2 (z koniecznym callback URL), status VIP, okres płatności, status synchronizacji, anulowanie, historia zamówień.
- [ ] Bezpieczny prywatny katalog konfiguracji i plików: publiczne metadata, prywatny storage, podpisane krótkie URL, sprawdzenie uprawnienia przy każdym pobraniu.
- [ ] Portal nie nadaje ról bezpośrednio; uprawnienia i synchronizacja tylko z backendu.

### 4. Panel administracyjny

- [ ] Lista klientów, powiązań Discord, aktywnych planów VIP i dat ważności.
- [ ] Audyt zdarzeń, failed jobs, retry/dead-letter, obserwowalność Gateway, read-only readiness oraz alerty.
- [ ] RBAC i CSRF, ograniczenie ekspozycji danych; decyzje administracyjne zapisywane w audycie.

### 5. Płatności i subskrypcje

- [ ] Sandbox implementacja `VIP Monthly One-Time €40`, `VIP Monthly Auto-Renew €40`, `VIP Lifetime €100`; produkcyjne VIP role są wyłączone w obecnym kodzie.
- [ ] Adapter rzeczywistego operatora dopiero po ustaleniu operatora i **pisemnym zatwierdzeniu dokładnego katalogu produktów i modelu subskrypcji** (wymogi operatora i zasady gier mogą ograniczać zastosowanie). Nie zmieniać nazw produktów tak, by ukryć ich przeznaczenie.
- [ ] Webhook: podpis, idempotencja, order/product/user/amount/currency, retry, refund, chargeback, anulowanie, wygaśnięcie i ręczna eskalacja.
- [ ] Weryfikacja regulaminów, polityki zwrotów, kwestii konsumenckich/podatkowych przed produkcją.

### 6. Końcowy odbiór i włączenie produkcyjne

- [ ] Testy automatyczne wszystkich modułów i bezpieczeństwa, kopia bezpieczeństwa Supabase i rollback.
- [ ] Jeden odbiór E2E z rzeczywistymi kontami: dołączenie `pending=true` bez roli, akceptacja `pending=false`, jednorazowe Free Member, bot excluded, retry, restart, VIP i ograniczenia katalogu.
- [ ] Najpierw rzeczywisty Canary 1–2 zwykłe konta, po udanym odbiorze osobna zgoda na `all` i dopiero wtedy pełne przyznawanie Free Member na serwerze. `all` obejmie też kwalifikujących się istniejących członków.
- [ ] Płatności i VIP produkcyjne wyłącznie po formalnej i technicznej akceptacji, w osobnym wydaniu.
- [ ] Domknięcie DNS/SSL `bot.timonconfigs.com`, polityk Discorda, uprawnień, monitoringu i operacyjnych instrukcji.

## Krytyczne ograniczenia

- Żadnych tokenów bota, hasła do Supabase, sekretów ani danych klientów w commicie, logu, zgłoszeniu czy czacie.
- Nie instalować płatnego VPS ani nie przenosić bota bez potrzeby.
- `/ready=true` oznacza sprawne procesy, nie gwarantuje skutecznych operacji roli ani transakcji.
- Nie masowo usuwać `discord_member_jobs`, `discord_role_operations` ani nie wykonywać `TRUNCATE` na produkcji.
- Automatyczne testy można prowadzić podczas implementacji; **testy z prawdziwymi użytkownikami i pieniędzmi dopiero na końcu, na podstawie zatwierdzonego planu**.
