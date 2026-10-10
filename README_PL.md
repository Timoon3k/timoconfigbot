# TimonConfigs — backend członkostw

**Stan:** backend członkostwa Fazy 1 oraz automatyzacja Discord Fazy 2 w trybie offline/mock i DRY_RUN.

Repozytorium zawiera backend TypeScript/Node.js, wersjonowane migracje PostgreSQL, trwały silnik uprawnień, uwierzytelnianie i RBAC, audit log, adapter płatności mock oraz outbox Discord pracujący wyłącznie w trybie DRY_RUN. To nadal nie jest gotowy sklep ani bot produkcyjny: nie ma aktywnego checkoutu, połączenia z Discordem ani rzeczywistych adapterów płatniczych.

## Trzy plany

| Plan | Cena | Rozliczenie | Dostęp | Discord |
|---|---:|---|---|---|
| VIP Monthly — One-Time | €40 | jednorazowe | jeden miesiąc kalendarzowy | VIP Monthly |
| VIP Monthly — Auto-Renew | €40 | co miesiąc do anulowania | wyłącznie opłacone okresy | VIP Monthly |
| VIP Lifetime | €100 | jednorazowe | bez ustalonej daty wygaśnięcia, w granicach publikowanej licencji i działania usługi | VIP Lifetime |

**Nie tworzymy osobnej roli dla każdego sposobu rozliczenia.** One-Time i Auto-Renew otrzymują tę samą rolę Monthly.

## Uruchomienie backendu

Pełna instrukcja dla Windows znajduje się w `docs/URUCHOMIENIE_WINDOWS_PL.md`. Skrócony przepływ:

1. Zainstaluj Node.js 24 LTS (minimum 22.13) i Docker Desktop.
2. Uruchom `npm ci` oraz `docker compose up -d postgres`.
3. Skopiuj `.env.example` do `.env` i ustaw dwa losowe peppery.
4. Uruchom `npm run db:migrate`, a następnie `npm run dev`.
5. Do odbioru zmian użyj `npm run typecheck`, `npm run build` i `npm test` na osobnej bazie testowej.

Faza 2: po migracjach uruchom `npm run discord:demo` i w drugim terminalu `npm run discord:worker`. Demo zapisuje fikcyjne konto, płatność i zweryfikowane powiązanie mock OAuth; worker zapisuje podglądy do PostgreSQL. `npm run test:smoke` sprawdza skompilowany backend i worker na jednorazowej bazie wskazanej przez `TEST_DATABASE_URL`.

Szczegóły: [raport Fazy 2](docs/RAPORT_IMPLEMENTACJI_FAZA_2_PL.md), [bezpieczeństwo Discord](docs/DISCORD_SYNC_SECURITY_PL.md), [konfiguracja bota](docs/DISCORD_BOT_SETUP_PL.md) i [scenariusze testów](docs/DISCORD_DRY_RUN_TESTS_PL.md).

`npm run demo` nadal uruchamia zachowany symulator offline. Żadna część Fazy 1 nie łączy się z Discordem, PayPal, Google Pay ani operatorem kart.

## Pliki

- `config/plans.json` — trzy produkty i zasady licencji; checkout pozostaje wyłączony.
- `config/discord.example.json` — mapowanie dwóch ról VIP i konfiguracja synchronizacji (domyślnie dry-run).
- `.env.example` — wzór zmiennych; NIE wklejaj prawdziwych sekretów do czatu.
- `db/migrations/` — kanoniczne, wersjonowane migracje PostgreSQL; `db/schema.sql` jest wyłącznie historycznym szkicem.
- `src/membership/service.ts` — transakcyjny silnik uprawnień PostgreSQL.
- `src/payments/` — interfejs operatora i deterministyczny adapter mock.
- `src/auth/` i `src/http/` — uwierzytelnianie, RBAC, CSRF, rate limiting i API.
- `src/entitlements.mjs` — referencyjny silnik uprawnień do symulacji offline.
- `tests/entitlements.test.mjs` — zestaw testów.
- `docs/ARCHITEKTURA_PL.md` — przepływ procesu i API.
- `docs/WDROZENIE_PL.md` — konkretna kolejność wdrażania.
- `docs/BEZPIECZENSTWO_I_ZGODNOSC_PL.md` — ograniczenia prawne i płatnicze.
- `docs/RAPORT_IMPLEMENTACJI_FAZA_1_PL.md` — wykonany zakres i wyniki odbioru Fazy 1.
- `docs/URUCHOMIENIE_WINDOWS_PL.md` — środowisko deweloperskie na Windows.
- `docs/COPY_EN.md` — krótkie gotowe teksty po angielsku na stronę.
- `docs/CLAUDE_CODE_PROMPT_EN.md` — prompt do wdrożenia przez agenta kodującego.

## Nie uruchamiaj sprzedaży bez zatwierdzenia operatora

Funkcje cheat/exploit mogą być niedozwolone przez operatorów płatności i zasady gier. PayPal, Google Pay i karty nie są aktywowane w tej paczce. Przed uruchomieniem musisz uzyskać akceptację operatora na rzeczywiste produkty, a nie opis zastępczy.

## Założenia licencyjne do zatwierdzenia

- Jeden miesiąc = miesiąc kalendarzowy liczony od potwierdzonej płatności w UTC (np. 10.10 12:00 -> 10.11 12:00 UTC). Należy opisać zachowanie końca miesiąca w regulaminie.
- Rezygnacja z Auto-Renew blokuje przyszłe pobrania, ale dostęp trwa do końca opłaconego okresu.
- Nieudana płatność nie przedłuża uprawnienia.
- Lifetime nie ma daty wygaśnięcia w bazie, ale nie oznacza gwarancji działania serwisu przez nieograniczony czas.
- Przy zakupie Lifetime przez abonenta zaoferuj anulowanie odnawialnego abonamentu i nie pozwól na niezamierzone ponowne obciążenia.

## Rozszerzenie Discord: Rules Screening i kontrolowany test-guild

Nowsza implementacja na gałęzi `feature/discord-completion` dodaje trwałą weryfikację członków, Gateway oraz opcjonalne operacje na osobnym, zatwierdzonym serwerze testowym. Domyślne ustawienia pozostają offline/DRY_RUN; produkcja i rzeczywiste płatności są zablokowane. Warunki, ręczna konfiguracja i ograniczenia: [DISCORD_COMPLETION_PL.md](docs/DISCORD_COMPLETION_PL.md). Szablon konfiguracji: `.env.test-guild.example`.
