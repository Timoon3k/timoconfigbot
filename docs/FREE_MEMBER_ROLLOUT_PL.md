# Free Member — audyt i bezpieczne wdrożenie

Gałąź: `feature/free-member-rollout`, baza: `fix/worker-error-diagnostics`
(`6be8c967801e410a85de5deb8b7e561c24f260b3`). Nie wykonano wdrożenia,
połączenia z produkcyjnym Discordem ani Supabase. Zgłoszona gotowość `/ready`
nie była sprawdzana z tego środowiska.

## Wynik audytu

- **Znaleziony i naprawiony defekt:** adapter REST nie wykluczał botów przy
  końcowej kontroli przed dodaniem Free Member. Worker już je wykluczał,
  ale sam adapter pozwalał na taki zapis. Dwa nowe testy odtworzyły problem
  przed poprawką. REST teraz odrzuca `user.bot=true` oraz własne ID bota,
  również gdy `pending=false`, kodem `MEMBER_BOT_NOT_ALLOWED`.
- Worker wymaga dokładnie `pending === false` w aktualnej odpowiedzi REST.
  `true` i brak pola blokują nadanie; dane Gateway same nie upoważniają
  do zapisu. Adapter powtarza tę kontrolę bezpośrednio przed PUT.
  Brak `user.bot` jest zgodny z opcjonalnym polem Discorda dla ludzi;
  nie zastępuje wymaganego `pending=false`.
- Unikalność zdarzeń `(guild_id, session_id, sequence)`, trwałe zadania,
  dzierżawy i blokady członka serializują pracę. Powtórzone zdarzenie nie
  tworzy nowego zadania. Rola już obecna powoduje brak kolejnego zapisu.
  Test obejmuje również utratę potwierdzenia PUT i restart: jedna mutacja,
  zadanie zakończone po odczycie aktualnego stanu. Niepewny wpis operacji
  pozostaje dowodem niepewności, nie jest fałszywie oznaczany jako potwierdzony.
- Free Member nie wchodzi do listy usuwanych ról VIP. Usuwanie tej roli
  blokują niezależnie `RoleOperations` i REST. Zmiana `pending` na `true`
  nie usuwa roli już istniejącej.
- Founder i Staff są poza listą dozwolonych zapisów i muszą być wyżej
  od bota. Produkcyjna bramka REST blokuje także oba VIP dla dodawania
  i usuwania. Dodanie Free Member nie zastępuje pozostałych ról członka.
- Domyślne `DISCORD_DRY_RUN=true` i `DISCORD_WRITES_ENABLED=false`
  pozostały bez zmian. Nie zmieniono konfiguracji, Gateway, workera,
  płatności, OAuth ani hostingu.

## Zmienione pliki i wykonane testy

- `src/discord/rest.ts`: końcowa blokada nadania Free Member botom.
- `tests/unit/free-member-rollout.test.ts`: 19 nowych przypadków dla REST,
  ochrony ról, zakazu usuwania i kompletu zgód.
- `tests/integration/discord-completion.test.ts`: 5 nowych przypadków dla
  workera, deduplikacji, restartu i utraty potwierdzenia; transport testowy
  przekazuje teraz również `user.bot` i obsługuje syntetyczną konfigurację
  produkcyjną. Nie łączy się z Discordem.
- Ten dokument: instrukcja wdrożenia, walidacji i wycofania.

Wykonano z powodzeniem:

| Polecenie | Wynik |
| --- | --- |
| `npm run typecheck` | kod wyjścia 0 |
| `npm run build` | kod wyjścia 0 |
| `npm run test:unit` | 68/68, 6 plików |
| lokalny Vitest dla `tests/integration/discord-completion.test.ts` | 23/23, 1 plik |

Integracje wykonały migracje na nowym kontenerze PostgreSQL 16,
`timonconfigs-free-member-rollout-test`, baza `free_member_rollout_test`,
port lokalny `127.0.0.1:55434`. Proces uruchomiono przez `env -i` z
jawnym `TEST_DATABASE_URL` wyłącznie do tej bazy, `NODE_ENV=test`,
`DB_CONNECTION_MODE=direct`, `DB_SSL_MODE=disable`. Dane logowania były
fikcyjne, lokalne. Pozostałych zestawów integracyjnych nie uruchamiano.
Nie podstawiać `DATABASE_URL` produkcji do `TEST_DATABASE_URL`: te testy
wykonują TRUNCATE. Kontener testowy zatrzymano po weryfikacji.

## Dokładne istniejące bramki produkcyjne

Weryfikacja wynika z `config.ts`, `rest.ts`, `operations.ts` oraz istniejącej
polityki hierarchii. Nie dodano nowego mechanizmu zgód.

| Warunek | Wymagana wartość / kontrola |
| --- | --- |
| `NODE_ENV`, `DISCORD_ENVIRONMENT` | oba `production` |
| `DISCORD_ADAPTER`, `DISCORD_NETWORK_ENABLED` | `rest`, `true` |
| `DISCORD_GUILD_ID`, `DISCORD_PRODUCTION_GUILD_ID` | identyczne, rzeczywiste ID zatwierdzonego serwera, inne niż domyślny identyfikator testowy |
| `DISCORD_TEST_GUILD_ID` | nieustawione lub pusty tekst |
| `DISCORD_GUILD_OWNER_ID` | ID właściciela zgodne z odczytem REST |
| `DISCORD_OWNER_APPROVED` | `true` po rzeczywistej zgodzie właściciela |
| `DISCORD_APPROVAL_REFERENCE` | rzeczywisty zapis zgody na połączenie; 8–200 znaków |
| `DISCORD_VIP_SYNC_ENABLED` | `false` |
| `DISCORD_PRODUCTION_VIP_WRITES_ENABLED` | `false` |
| `DISCORD_COMMANDS_ENABLED` | `false` |
| `DISCORD_OAUTH_REDIRECT_URI` | istniejące `https://bot.timonconfigs.com/api/discord/callback`; nie zmieniać w tym wdrożeniu |
| `DISCORD_INTERACTIONS_PUBLIC_KEY` | istniejący klucz publiczny, 64 cyfry szesnastkowe; nie zmieniać |
| wszystkie skonfigurowane ID serwera/bota/ról | poprawne snowflake i wzajemnie różne |
| tożsamość bota i serwera | zgodna z konfiguracją, sprawdzana ponownie przez REST |
| uprawnienia bota | Manage Roles, bez Administrator; bot nie może być właścicielem |
| hierarchia | Founder i Staff nad botem; obie role VIP i Free Member pod botem |
| role docelowe | istniejące, niezarządzane przez integrację, nie `@everyone`, bez Administrator i Manage Roles; dodatkowe blokady nazw chronionych ról |

Do działania Gateway wymagane są również istniejące
`DISCORD_GATEWAY_ENABLED=true`, `DISCORD_VERIFICATION_ENABLED=true`, token
bota w bezpiecznej konfiguracji oraz włączony Server Members Intent.
Gateway używa tylko Guilds i Guild Members; nie potrzebuje Message Content.
READY sprawdza ID bota i dokładnie jeden zatwierdzony serwer.

## Instrukcja wdrożenia — do wykonania później przez właściciela

1. Przejrzeć różnicę gałęzi względem wskazanej bazy. Zapisać SHA obecnie
   wdrożonej, działającej wersji i bieżące ustawienia flag bez eksportowania
   sekretów. Nie zakładać, że SHA bazy audytu to SHA wdrożonej aplikacji.
2. Po zatwierdzeniu wdrożyć poprawkę dotychczasową procedurą, zachowując
   obecny punkt startowy, konfigurację połączeń, sekrety i schemat DB.
   Ta zmiana nie wymaga nowych migracji. Utrzymać:

   ```dotenv
   DISCORD_DRY_RUN=true
   DISCORD_WRITES_ENABLED=false
   DISCORD_FREE_MEMBER_WRITES_APPROVED=false
   DISCORD_VIP_SYNC_ENABLED=false
   DISCORD_PRODUCTION_VIP_WRITES_ENABLED=false
   DISCORD_COMMANDS_ENABLED=false
   ```

3. Zrestartować aplikację istniejącą procedurą. Sprawdzić `/ready`, heartbeat
   workera oraz logi diagnostyczne bez publikowania sekretów. Dla kont
   walidacyjnych sprawdzić audyty `DISCORD_VERIFICATION_PLANNED`:
   `screening_pending_or_unknown`, następnie `preview` po zakończeniu Rules
   Screening. Dla bota oczekiwane `bot_excluded`. W tym etapie brak zapisów
   na Discordzie jest prawidłowy.
4. Przed aktywacją przejrzeć oczekujące zadania, retry/dead_letter i prognozy
   cyklicznego skanowania. Ustalić, czy inne boty lub ręczne autorole nie
   nadają Free Member przed akceptacją zasad. Takie nadania mogą same ominąć
   screening i unieważnić test; wyjaśnić to operacyjnie z właścicielem.
5. **Osobna, jawna zgoda właściciela na zapisy Free Member jest konieczna.**
   Aktywacja obejmuje wszystkich kwalifikujących się członków, także z
   istniejących zadań i pełnego skanowania serwera. Kod nie ma trybu zapisów
   ograniczonego do dwóch kont. Zgoda musi obejmować cały ten zakres.
6. Dopiero po tej zgodzie ustawić razem, a następnie zrestartować aplikację:

   ```dotenv
   DISCORD_DRY_RUN=false
   DISCORD_WRITES_ENABLED=true
   DISCORD_FREE_MEMBER_WRITES_APPROVED=true
   DISCORD_FREE_MEMBER_APPROVAL_REFERENCE=<actual-separate-owner-approval-reference>
   DISCORD_VERIFICATION_ENABLED=true
   ```

   Referencja musi mieć 8–200 znaków i różnić się od
   `DISCORD_APPROVAL_REFERENCE`; tekst przykładowy nie stanowi zgody.
   Zachować wszystkie pozostałe bramki z tabeli, zwłaszcza trzy flagi VIP
   i commands ustawione na `false`. Nie zmieniać `.env.example` na tryb live.
7. Wykonać poniższą walidację i obserwować błędy/retry oraz dzienniki
   `DISCORD_ROLE_EXECUTION_INTENT` i `DISCORD_ROLE_EXECUTION_CONFIRMED`.
   Każda mutacja powinna dotyczyć tylko dodania skonfigurowanego ID Free
   Member. `/ready=true` samo nie dowodzi poprawnego nadania roli.

## Lista walidacji na dwóch kontach

Przeprowadza ją właściciel po opisanej zgodzie. Konta A i B mają być zwykłymi
kontami ludzi; Administrator, właściciel i uprzednio nadana rola mogą omijać
Rules Screening. Nie używać kont ani VIP uprawnień rzeczywistych klientów.

- [ ] Zapisać ID obu kont, czas testu i role początkowe. Upewnić się, że A
  jest nowym członkiem, bez Free Member i innych ról omijających screening.
- [ ] **A przed akceptacją:** pozostawić zasady niezaakceptowane. Aktualny
  stan musi mieć `pending=true`. Poczekać na pracę workera; brak Free Member,
  audyt `screening_pending_or_unknown`, brak operacji PUT dla A.
- [ ] **A po akceptacji:** zaakceptować zasady, potwierdzić `pending=false`.
  Oczekiwać jednego dodania Free Member i potwierdzonej operacji. Kolejne
  zdarzenia, odczyty i skan nie powodują następnego PUT.
- [ ] **B już zweryfikowane:** potwierdzić `pending=false`, bez Free Member.
  Zapisać role istniejące B. Opcjonalną walidację zachowania ręcznej roli VIP
  wykonywać wyłącznie na zatwierdzonym koncie testowym; nie nadawać Founder,
  Staff ani Administrator tylko w celu testu. Skan albo aktualizacja członka
  ma dodać wyłącznie Free Member i zachować role początkowe.
- [ ] **B z Free Member:** po kolejnym skanie lub zatwierdzonym restarcie
  brak dodatkowej mutacji; Founder, Staff i VIP na całym serwerze bez zmian.
- [ ] **A po ponownym dołączeniu:** opuścić i dołączyć ponownie w ramach
  zatwierdzonego testu. Jeśli Discord ponownie zwróci `pending=true`, brak
  nadania do `false`; jeśli od razu `false`, nadanie jest dozwolone.
- [ ] Przejrzeć istniejące boty bez zmiany ich ról: brak nadania Free Member
  przez tę automatyzację, audyt `bot_excluded` dla przetworzonych zadań.
- [ ] Brak usuwania Free Member, mutacji VIP/Founder/Staff, zmian kanałów,
  wiadomości i uprawnień. Brak błędów uprawnień i narastających retry.

Brak `pending` testowano automatycznie; nie fałszować odpowiedzi produkcyjnego
Discorda. Nie usuwać i nie odtwarzać chronionych ról do testowania blokad.

## Wycofanie

1. W razie nieprawidłowych zapisów zatrzymać instancje aplikacji/workera
   istniejącą procedurą. Zmiana zmiennych nie wpływa na już działający proces;
   żądanie wcześniej wysłane do Discorda może jeszcze się zakończyć.
2. Ustawić razem `DISCORD_DRY_RUN=true`, `DISCORD_WRITES_ENABLED=false`,
   `DISCORD_FREE_MEMBER_WRITES_APPROVED=false`. Zachować VIP sync, produkcyjne
   VIP writes i commands jako `false`. Nie uruchamiać starej instancji z
   flagami live równolegle z nową.
3. Wrócić do SHA zapisanej działającej wersji, jeśli problem dotyczy kodu;
   uruchomić ją w trybie bez zapisów i sprawdzić `/ready`, heartbeat i audyty.
   Nie wykonywać rollbacku migracji, TRUNCATE ani kasowania kolejek/dowodów
   operacji. Niniejsza poprawka nie zmienia schematu.
4. Zidentyfikować konkretne nadania na podstawie audytu i dziennika Discorda.
   Wyłączenie automatyzacji nie cofa ról już nadanych. Nie uruchamiać masowego
   usuwania: bot celowo nie usuwa Free Member. Ewentualną ręczną korektę
   poszczególnych błędnych nadań zatwierdza właściciel.
5. Ponowne włączenie wymaga usunięcia przyczyny, powtórzenia walidacji
   bez zapisów i nowej, udokumentowanej zgody na aktywację.
