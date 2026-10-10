# Plan Fazy 2 i przegląd bezpieczeństwa

## Audyt przed zmianami

Na PostgreSQL 16 wykonano istniejące 24 testy (6 ESM, 4 jednostkowe, 14 integracyjnych), typecheck, build i walidację konfiguracji. Wszystkie przeszły. Zachowujemy migrację 001, reguły uprawnień i płatniczy outbox. Snapshot `desired_tier` w zadaniu może być historyczny: worker zawsze ponownie odczytuje uprawnienia przy wykonaniu.

Zidentyfikowane ograniczenia Fazy 1: brak workerów i OAuth, brak leasingu i historii prób, brak właściciela przypisań ról. Rekoncyliacja FREE nie obejmuje przejścia Lifetime → aktywny Monthly; nowy harmonogram musi sprawdzać wszystkie połączone konta partiami. `trustProxy: true` nie jest właściwym domyślnym ustawieniem lokalnego serwera — wyłączymy zaufanie do arbitralnych nagłówków proxy. Dotychczasowa funkcja przetwarzania płatności nie weryfikuje podpisów operatora; pozostaje interfejsem wewnętrznego mocka, bez nowego publicznego webhooka.

## Migracja 002 (plan przed implementacją)

- Rozszerzenie `discord_sync_jobs`: docelowy Discord ID dla odłączeń, UUID leasingu, data wygaśnięcia, correlation ID. Dotychczasowe rekordy i enumy zostają zachowane; `dry_run=true` nadal wymusza baza.
- `discord_sync_history`: niezmienna historia prób, preview, wynik, kod błędu, środowisko mock/dry-run.
- `discord_role_ownership`: jawny właściciel zarządzania każdą parą guild/member/role. Brak rekordu oznacza historyczne/ręczne przypisanie, którego nie wolno usuwać.
- `discord_identity_reservations`: trwała rezerwacja Discord ID dla właściciela, także po zmianie powiązania; zapobiega przejęciu starej tożsamości w trakcie cleanup.
- `discord_oauth_states`: jednorazowy hash state, powiązanie z sesją, zaszyfrowany verifier PKCE, termin ważności, oczekiwana tożsamość do jawnej zamiany.
- `discord_mock_members`: jawnie symulowany stan ról do powtarzalnej pracy lokalnego backendu i osobnego procesu workera.
- `discord_runtime`: koordynacja rate limitu w bazie, heartbeat i trwały kursor okresowego skanowania kont z PostgreSQL.
- Indeksy dla leasingu, stronicowania historii i kolejki oraz rollback 002 bez usuwania danych Fazy 1.

## Kolejność

1. Migracja i typowane adaptery: mock, dry-run i REST z zablokowanym transportem sieciowym.
2. Bezpieczny plan ról: ID allowlisty, guild, Manage Roles, brak Administrator, hierarchia, ownership. Nie nadajemy żadnych uprawnień kanałów.
3. Outbox: SKIP LOCKED, leasing z tokenem, odzyskiwanie po awarii, blokada użytkownika i ponowne wyliczenie, retry/jitter/Retry-After, historia i audyt.
4. OAuth: identify, state związany z sesją, PKCE, ponowne hasło, jawna zamiana, odłączenie z cleanup poprzedniego ID.
5. API administratora z RBAC/CSRF i stronicowaniem; komendy membership/sync-status/help jako prywatne odpowiedzi bez rejestracji w Discord.
6. Harmonogram ograniczony partiami kont, monitoring i CLI demonstracyjne; testy wszystkich scenariuszy i migracji.
7. Dokumentacja Windows i raport z rzeczywistymi wynikami.

## Bramki operacyjne

Ta wersja uruchamia wyłącznie mock i dry-run. Zmiana samej zmiennej środowiskowej nie może włączyć sieci ani zapisów. Produkcyjny transport wymaga przyszłego, osobno zatwierdzonego wydania, audytu historycznych przypisań oraz konkretnej polityki migracji. Implementacja REST jest testowana wstrzykniętym transportem HTTP. Nie prosimy o produkcyjne sekrety i nie łączymy się z serwerem właściciela. Testy OAuth z prawdziwym Discord i dwoma kontami pozostają bramką późniejszego kontrolowanego rollout.
