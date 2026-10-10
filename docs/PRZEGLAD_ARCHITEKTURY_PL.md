# TimonConfigs — przegląd architektury

## Status audytu

Repozytorium jest spójnym blueprintem i działającym symulatorem offline. Nie jest jeszcze aplikacją produkcyjną. Obecne elementy nadają się do ponownego użycia jako specyfikacja domeny:

- `config/plans.json` poprawnie definiuje trzy produkty, ceny EUR i wspólną rolę `VIP_MONTHLY` dla obu produktów miesięcznych;
- `config/discord.example.json` ma bezpieczne ustawienia początkowe: `dry_run: true`, brak wymagania `Administrator` oraz allowlistę dwóch zarządzanych ról;
- `src/entitlements.mjs` poprawnie demonstruje miesiąc kalendarzowy UTC, priorytet Lifetime, cofnięcie uprawnienia konkretnej płatności i bezpieczny diff ról;
- `db/schema.sql` stanowi użyteczny szkic tabel PostgreSQL;
- istniejące testy potwierdzają sześć podstawowych reguł domenowych;
- płatności produkcyjne i wszystkie adaptery są wyłączone.

## Docelowy podział systemu

System powinien pozostać jednym repozytorium i jednym wdrażalnym produktem, ale z wyraźnymi granicami modułów:

1. **Web application (Next.js + TypeScript)** — interfejs klienta i administratora, sesje, API serwerowe oraz kontrola dostępu do plików.
2. **Membership domain** — czyste reguły produktów, okresów, uprawnień, anulowań, refundów i chargebacków. Moduł nie ufa przeglądarce ani surowemu webhookowi.
3. **Payment adapters** — wspólny interfejs operatora i wyłącznie adapter sandbox na tym etapie. Adapter weryfikuje podpis i tłumaczy zdarzenie na kanoniczny model domenowy.
4. **PostgreSQL** — źródło prawdy dla użytkowników, płatności, subskrypcji, uprawnień, idempotencji, audytu i zadań kolejki.
5. **Discord integration** — OAuth2 `identify` do połączenia konta oraz osobny worker synchronizacji ról. Worker zarządza wyłącznie rolami VIP z allowlisty.
6. **Private file storage** — prywatne obiekty; backend wydaje krótko ważny podpisany URL dopiero po serwerowej kontroli uprawnienia.

## Granice zaufania

- Przeglądarka może żądać operacji, ale nie potwierdza płatności, poziomu członkostwa ani prawa do pobrania.
- Endpoint webhooka przyjmuje niezaufane bajty. Najpierw sprawdza podpis, kontekst sprzedawcy, kwotę, walutę, produkt i powiązanie z zamówieniem.
- Dopiero zweryfikowane zdarzenie zapisane transakcyjnie może utworzyć lub cofnąć uprawnienie.
- Discord OAuth2 służy do potwierdzenia tożsamości Discord. Token bota pozostaje wyłącznie po stronie serwera.
- Worker Discord odczytuje wyliczony stan członkostwa z bazy; nie przyjmuje docelowej roli od klienta.
- Panel administratora wymaga osobnego uprawnienia i audytu każdej mutacji. W produkcji konto administratora powinno wymagać 2FA.

## Model członkostwa

Efektywny poziom dostępu jest wyliczany z niecofniętych uprawnień, których okres obejmuje bieżący czas:

- `VIP_MONTHLY_ONCE`: okres zaczyna się w chwili potwierdzonej płatności i kończy po jednym miesiącu kalendarzowym UTC, z ograniczeniem dnia do końca miesiąca;
- `VIP_MONTHLY_AUTO`: każdy potwierdzony opłacony cykl tworzy własny okres zgodny z autorytatywnymi datami operatora;
- anulowanie subskrypcji zatrzymuje kolejne odnowienia, lecz nie usuwa opłaconego okresu;
- refund lub chargeback cofa tylko uprawnienie pochodzące z danej płatności;
- `VIP_LIFETIME` nie ma daty wygaśnięcia, ale podlega opublikowanym warunkom licencji;
- aktywny Lifetime ma pierwszeństwo przed Monthly;
- oba produkty Monthly zawsze mapują się na tę samą rolę Discord.

Kolejny zakup jednorazowego miesiąca powinien zaczynać się od późniejszej z dwóch wartości: czasu potwierdzenia płatności albo końca aktualnego, kwalifikującego się okresu One-Time. Operację trzeba wykonać w transakcji z blokadą użytkownika, aby dwa równoczesne zdarzenia nie utworzyły nakładających się okresów.

## Zmiany wymagane w bazie

Obecny `db/schema.sql` jest szkicem, nie systemem migracji. Implementacja powinna wprowadzić migracje `up/down` i rozszerzyć model o:

- dane uwierzytelniania i bezpiecznie znormalizowany email;
- role aplikacyjne oraz sesje administratorów;
- jawny plan i status subskrypcji, datę końca okresu, datę anulowania i powiązanie z płatnościami;
- kanoniczne płatności/capture niezależne od zamówień;
- trwały wynik przetwarzania webhooka, hash payloadu i identyfikator korelacyjny bez zapisywania sekretów;
- wersjonowane, niezmienne wpisy audytowe dla działań administracyjnych, płatniczych i Discord;
- zadania Discord z kluczem deduplikacji, typem przyczyny, blokadą kolejki, historią prób i stanem `member_absent`;
- wersje plików i changelogi oraz audyt wydawania linków;
- indeksy i ograniczenia wspierające idempotencję oraz przetwarzanie `FOR UPDATE SKIP LOCKED`.

Ceny i lista produktów nie powinny być zaszyte wyłącznie w ograniczeniach SQL. Aplikacja zapisuje migawkę kodu produktu, kwoty i waluty na zamówieniu, a zweryfikowana konfiguracja pozostaje źródłem bieżącej oferty.

## Synchronizacja Discord

Synchronizacja ma dwa etapy: obliczenie docelowej roli i zastosowanie minimalnego diffu. W trybie domyślnym worker tylko zapisuje planowaną zmianę do audytu.

Zasady bezpieczeństwa:

- modyfikowane mogą być wyłącznie dwa skonfigurowane identyfikatory ról VIP;
- Founder, Staff, Free Member, role integracji, uprawnienia kanałów i wiadomości są poza zakresem;
- bot wymaga `Manage Roles`, nie `Administrator`, i musi znajdować się nad rolami VIP, a pod rolami Staff/Founder;
- odpowiedzi `429` respektują `Retry-After`; błędy `5xx` używają ograniczonego exponential backoff z jitterem;
- `404` członka oznacza `member_absent`, nie utratę członkostwa;
- ponowne dołączenie lub ręczne żądanie synchronizacji tworzy nowe zadanie i przywraca należną rolę;
- przejście z `DRY_RUN=true` na tryb zapisu wymaga osobnej, jawnej decyzji właściciela po testach na dwóch kontrolowanych kontach.

## Płatności

Na obecnym etapie dozwolone są wyłącznie deterministyczne symulacje sandbox. Interfejs adaptera powinien obsługiwać utworzenie testowego zamówienia, odczyt statusu, anulowanie przyszłych odnowień, weryfikację webhooka oraz mapowanie refundu i sporu.

Nie wolno aktywować PayPal, Google Pay, kart ani produkcyjnego checkoutu bez pisemnej akceptacji rzeczywistego katalogu przez wybranego operatora. Nazwy i opisy produktów muszą pozostać zgodne z faktyczną ofertą.

## Główne ryzyka wykryte w blueprintcie

1. Idempotencja symulatora obejmuje tylko `eventId`; produkcja wymaga pary `(provider, provider_event_id)` i ochrony przed równoległym przetwarzaniem.
2. Szkic schematu nie modeluje osobnej płatności/capture ani związku uprawnienia z refundem i subskrypcją wystarczająco precyzyjnie.
3. Brakuje trwałego audytu zmian administracyjnych i Discord oraz historii prób synchronizacji.
4. Brakuje uwierzytelniania, RBAC, CSRF, rate limiting i walidacji HTTP, ponieważ nie istnieje jeszcze serwer aplikacyjny.
5. Brakuje obsługi zdarzeń poza kolejnością i pobrania autorytatywnego statusu operatora.
6. Brakuje testów współbieżności, nieudanej płatności, nieobecnego członka Discord, wygasania podpisanego URL i odmowy pobrania.
7. Kod jest JavaScript ESM, podczas gdy docelowa implementacja wymaga TypeScript i kontrolowanego pliku blokady zależności.

## Kryterium gotowości

Etapy 1–2 można uznać za gotowe do stagingu dopiero po przejściu migracji na czystej bazie, testów domenowych i integracyjnych PostgreSQL, testów adaptera sandbox oraz testów Discord w `DRY_RUN`. Tryb zapisu Discord pozostaje zablokowany do osobnej akceptacji. Produkcyjna sprzedaż pozostaje zablokowana niezależnie od gotowości technicznej, dopóki operator płatności nie zaakceptuje faktycznych produktów i nie zostaną zakończone wymagane prace prawne.
