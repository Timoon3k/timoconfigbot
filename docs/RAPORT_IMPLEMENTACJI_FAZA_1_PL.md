# TimonConfigs — raport implementacji Fazy 1

## Zakres wykonany

Backend został przeniesiony na TypeScript i Node.js z PostgreSQL jako źródłem prawdy. Dotychczasowy symulator ESM i jego testy pozostają w repozytorium jako regresyjna specyfikacja zachowania.

Wersjonowana migracja `001_membership_backend` tworzy:

- użytkowników, bezpieczne skróty haseł, role aplikacyjne i sesje z tokenem CSRF;
- unikalne powiązania użytkownika z Discord ID;
- trwały katalog trzech produktów;
- zamówienia, płatności i subskrypcje odnawialne;
- uprawnienia powiązane jeden-do-jednego z konkretną płatnością;
- idempotentne zdarzenia płatnicze z hashem payloadu, stanem próby i correlation ID;
- outbox przyszłej synchronizacji Discord z wymuszonym `dry_run = true`;
- append-only audit log chroniony triggerem przed aktualizacją i usunięciem.

## Działające reguły członkostwa

- One-Time przyznaje jeden miesiąc kalendarzowy UTC. Koniec miesiąca jest ograniczany do ostatniego istniejącego dnia.
- Równoczesne zakupy One-Time są serializowane blokadą rekordu użytkownika i układane w niepokrywające się okresy.
- Auto-Renew tworzy dostęp wyłącznie dla potwierdzonego okresu `periodStart`–`periodEnd`.
- Nieudane odnowienie zapisuje płatność jako failed i ustawia subskrypcję `past_due`, bez utworzenia uprawnienia.
- Anulowanie ustawia `cancel_at_period_end` i zachowuje już opłacony dostęp.
- Lifetime nie ma `valid_until` i ma pierwszeństwo nad Monthly.
- Refund lub dispute cofa wyłącznie uprawnienie wskazanej płatności. Inne zakupy tego użytkownika pozostają ważne.
- Wygasłe członkostwa są rekoncyliowane do deduplikowanego zadania `FREE` w outboxie Discord.

## Transakcje i odporność

Procesor waliduje kanoniczne zdarzenia przez Zod, blokuje użytkownika `FOR UPDATE`, wykonuje płatność, uprawnienie, audit i outbox w jednej transakcji. Para `(provider, provider_event_id)` gwarantuje idempotencję. Ponowne użycie event ID z innym payloadem jest odrzucane.

Po błędzie domenowym transakcja biznesowa jest wycofywana, a zdarzenie otrzymuje status `failed` poza wycofaną transakcją. Ta sama, identyczna wiadomość może zostać bezpiecznie ponowiona po naprawie brakującego warunku. Test integracyjny potwierdza przejście `failed -> processing -> processed` bez częściowych zapisów.

## Bezpieczeństwo aplikacji

- hasła są przetwarzane przez `scrypt` z osobną losową solą i pepperem środowiskowym;
- tokeny sesji i CSRF są przechowywane wyłącznie jako SHA-256 z pepperem;
- cookies sesyjne są `HttpOnly`, `SameSite=Strict`, a w produkcji `Secure`;
- mutujące trasy administracyjne wymagają poprawnej sesji, roli `admin` oraz CSRF;
- Fastify ogranicza rozmiar body i liczbę żądań, a login/rejestracja mają ostrzejsze limity;
- błędy mają ustrukturyzowany kod i nie ujawniają szczegółów wewnętrznych;
- konfiguracja blokuje live payments oraz `DISCORD_DRY_RUN=false` w Fazie 1;
- brak publicznej trasy przypisującej role Discord.

## Symulacje

`MockPaymentProvider` generuje kanoniczne zdarzenia zakupu, odnowienia, błędu płatności, anulowania, refundu i sporu. Nie wykonuje połączeń sieciowych i nie symuluje akceptacji produktu przez operatora. Produkcyjny checkout pozostaje wyłączony.

Outbox Discord jest w pełni trwały i deduplikowany, lecz żaden worker Discord nie jest uruchamiany. Implementacja OAuth2, pobieranie stanu członka, retry Discord oraz faktyczne modyfikacje ról należą do Fazy 2 i wymagają osobnej zgody.

## Weryfikacja

Implementację sprawdzono na jednorazowym PostgreSQL 16 uruchomionym w Dockerze:

- migracja `up`: wykonana na czystej bazie;
- testy starszego symulatora: 6 zaliczonych;
- testy jednostkowe TypeScript: 4 zaliczone;
- testy integracyjne PostgreSQL/API: 14 zaliczonych;
- łącznie: 24 testy, 0 błędów po poprawieniu wykrytych rzutowań enumów SQL;
- typecheck TypeScript: zaliczony.

Build TypeScript oraz pełny cykl rollback/up migracji także zakończyły się powodzeniem. Testowa instancja PostgreSQL została po odbiorze zatrzymana i usunięta.

## Pozostaje przed wdrożeniem

- przygotowanie zarządzanej instancji PostgreSQL, TLS, backupów, rotacji sekretów i monitoringu;
- skonfigurowanie infrastruktury wdrożeniowej i CI;
- zewnętrzny audyt bezpieczeństwa przed produkcją;
- implementacja kolejnych faz po osobnej decyzji właściciela;
- pisemna akceptacja rzeczywistego katalogu przez operatora oraz prace prawne przed jakimkolwiek checkoutem produkcyjnym.
