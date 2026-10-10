# TimonConfigs — checklista implementacji

Statusy: `[x]` wykonane i zweryfikowane, `[ ]` do wykonania, `[!]` zewnętrzna bramka wymagająca decyzji lub danych właściciela.

## Audyt bazowy

- [x] Odczytano wszystkie pliki repozytorium, w tym konfigurację produktów, Discord, schemat SQL, silnik uprawnień i testy.
- [x] Potwierdzono trzy produkty i ceny: €40 Once, €40 Auto-Renew, €100 Lifetime.
- [x] Potwierdzono wspólną rolę Discord `VIP_MONTHLY` dla obu produktów miesięcznych.
- [x] Potwierdzono wyłączenie checkoutu i wszystkich adapterów płatniczych.
- [x] Potwierdzono `dry_run: true` i brak wymagania uprawnienia Administrator.
- [x] Uruchomiono walidację konfiguracji i 6 istniejących testów — wszystkie przeszły.

## Faza 1 — backend członkostwa

- [x] Utworzyć workspace TypeScript/Node.js 20+ z kontrolowanym lockfile.
- [x] Dodać wersjonowane migracje PostgreSQL oraz rollback.
- [x] Zaimplementować bezpieczne rekordy użytkowników i normalizację email.
- [x] Zaimplementować zamówienia, płatności, subskrypcje i okresy rozliczeniowe.
- [x] Zaimplementować transakcyjny silnik uprawnień w PostgreSQL.
- [x] Zaimplementować dokładny miesiąc kalendarzowy UTC i sekwencyjne zakupy One-Time.
- [x] Zaimplementować anulowanie na koniec opłaconego okresu.
- [x] Zaimplementować refundy, reversale i chargebacki per płatność.
- [x] Zaimplementować deduplikację i bezpieczne ponowienie nieudanych zdarzeń.
- [x] Dodać strukturalne, niezmienne logi audytowe z correlation ID.
- [x] Dodać walidację wejścia, rate limiting, ochronę CSRF i RBAC.
- [x] Dodać testy jednostkowe, integracyjne PostgreSQL i współbieżności.

## Faza 2 — Discord w trybie DRY_RUN

- [x] Zaimplementować OAuth2 `identify`, state związany z sesją, PKCE i bezpieczny callback; kontrakt dostawcy sprawdzony offline.
- [x] Zaimplementować unikalne powiązanie, reauthentication, potwierdzenie zamiany i odłączenie z trwałym cleanup starego ID.
- [x] Rozszerzyć outbox migracją 002, leasingiem, fencing, SKIP LOCKED i odzyskiwaniem po awarii.
- [x] Obliczać diff wyłącznie dla dwóch ról VIP, odczytując aktualne uprawnienia przy wykonaniu.
- [x] Wymusić worker offline/DRY_RUN; blokować transport sieciowy i produkcyjne mutacje niezależnie od flag.
- [x] Zapisywać plany i historię prób w PostgreSQL bez wykonywania zmian Discord.
- [x] Obsłużyć 429/Retry-After, 5xx, timeout, backoff, jitter i dead-letter; sprawdzić mockami.
- [x] Obsłużyć nieobecnego członka i zdarzenie rejoin; sprawdzić hook offline bez połączenia gateway.
- [x] Przetestować konflikty Monthly/Lifetime, role chronione i historyczne przypisania bez ownership.
- [x] API administratora: stan, preview, kolejka, historia, statystyki, kontrolowane retry oraz polityka przejęcia ról mock.
- [x] Przygotować prywatne komendy i weryfikację podpisów interakcji bez rejestracji bota.
- [x] Dodać lint, testy PostgreSQL, migrację up/down/up i smoke skompilowanych procesów.
- [ ] Przetestować dwa rzeczywiste kontrolowane konta Discord po osobnym zatwierdzeniu połączenia.
- [!] Uzyskać jawną zgodę właściciela przed ustawieniem `DRY_RUN=false` lub pierwszą modyfikacją Discord.

## Faza 3 — panel administratora

- [ ] Zaimplementować bezpieczne logowanie administratora z RBAC i przygotowaniem pod 2FA.
- [ ] Dodać wyszukiwanie członków, statusy, daty ważności i subskrypcje.
- [ ] Dodać jawnie oznaczone testowe zdarzenia uprawnień, niedostępne w produkcji.
- [ ] Dodać historię synchronizacji, retry/dead-letter i monitoring błędów.
- [ ] Dodać niezmienny audit trail wszystkich mutacji.
- [ ] Potwierdzić brak publicznego endpointu nadawania ról.

## Faza 4 — platforma klienta

- [ ] Zbudować responsywną aplikację Next.js/TypeScript z angielskim interfejsem.
- [ ] Dodać rejestrację, logowanie i łączenie Discord.
- [ ] Dodać dashboard członkostwa, rozliczeń i synchronizacji.
- [ ] Dodać prywatny katalog plików, wersje i changelogi.
- [ ] Wymuszać serwerową kontrolę uprawnień dla każdego pobrania.
- [ ] Wydawać krótko ważne podpisane URL do prywatnego storage.
- [ ] Przetestować brak dostępu VIP przy znanym identyfikatorze pliku i wygaśnięcie URL.

## Faza 5 — adapter płatności sandbox

- [ ] Zdefiniować neutralny interfejs operatora płatności.
- [ ] Dodać lokalny adapter sandbox dla purchase, renewal, cancel, refund i dispute.
- [ ] Zaimplementować weryfikację podpisu webhooka na surowym body.
- [ ] Walidować merchant, order, user, product, amount i currency.
- [ ] Potwierdzić, że redirect przeglądarki nigdy nie nadaje członkostwa.
- [ ] Dodać testy duplikatów, zmiany kolejności, retry i równoległych zdarzeń.
- [!] Uzyskać pisemną akceptację wybranego operatora dla dokładnego katalogu produktów.
- [!] Zatwierdzić regulamin, Lifetime terms, refundy, VAT i wymagania konsumenckie.
- [!] Dopiero po obu akceptacjach zaplanować adapter i checkout produkcyjny.

## Bramki wydania

- [ ] CI: lint, typecheck, test, test migracji i skan zależności.
- [ ] Sekrety wyłącznie w bezpiecznych zmiennych środowiskowych.
- [ ] Oddzielne konfiguracje development, staging i production.
- [ ] Backup/restore PostgreSQL sprawdzony na stagingu.
- [ ] Monitoring webhooków, kolejek, odmów pobrań i błędów Discord.
- [ ] Runbook dla refundu, chargebacku, awarii Discord i rotacji tokenu.
- [ ] Testy bezpieczeństwa i przegląd uprawnień przed produkcją.
- [ ] Brak wdrożenia produkcyjnego bez zakończenia właściwych bramek zewnętrznych.
