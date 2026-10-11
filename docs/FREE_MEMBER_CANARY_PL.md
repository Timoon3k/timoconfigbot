# TimonConfigs — bezpieczny pilot Free Member (Hostinger + Supabase)

Ta gałąź rozszerza `feature/free-member-rollout`. Nie zmienia migracji ani integracji płatności. Domyślnie nie zezwala na produkcyjne nadawanie ról. **Nie oznacza zgody na włączenie zapisów** i nie wykonuje zdalnych zmian w Hostingerze ani Discordzie.

## Dlaczego canary?

Wcześniejszy kod skanuje cały serwer i po aktywowaniu produkcyjnych zapisów mógłby przyznać Free Member wszystkim członkom z `pending=false`, w tym istniejącym. Pilot ogranicza dodawanie Free Member do maksymalnie dwóch wskazanych, zwykłych kont testowych. Inni członkowie mogą być skanowani/odczytywani, ale nie otrzymają Free Member od tej automatyzacji podczas pilota.

## Dodatkowe zmienne (Hostinger, tylko chronione środowisko)

| Zmienna | Domyślnie | Znaczenie |
| --- | --- | --- |
| `DISCORD_FREE_MEMBER_ROLLOUT_MODE` | `disabled` | `disabled`, `canary`, `all` |
| `DISCORD_FREE_MEMBER_CANARY_IDS` | pusta | W `canary`: ID 1–2 kont testowych, po przecinku, np. `123456789012345678,234567890123456789`. Nigdy token ani ID ról |
| `DISCORD_FREE_MEMBER_ALL_APPROVAL_REFERENCE` | pusta | W `all`: odrębny opis jawnej zgody na zapisy obejmujące cały serwer |

Reguły konfiguracji:
- `canary` wymaga 1–2 poprawnych, różnych ID użytkowników, nie ID serwera ani samego bota.
- `disabled` i `all` wymagają pustego `DISCORD_FREE_MEMBER_CANARY_IDS`.
- Produkcyjne zapisy nie startują w `disabled`. Tryb `all` wymaga dodatkowej referencji zgody różnej od poprzednich dwóch zatwierdzeń (`DISCORD_APPROVAL_REFERENCE` i `DISCORD_FREE_MEMBER_APPROVAL_REFERENCE`).
- Istniejące zabezpieczenia nadal wymagają `DISCORD_FREE_MEMBER_WRITES_APPROVED=true`, oddzielnej referencji zatwierdzenia dla Free Member, `DISCORD_DRY_RUN=false`, `DISCORD_WRITES_ENABLED=true`, weryfikacji i poprawnej hierarchii ról. `VIP_SYNC`, produkcyjne zapisy VIP i komendy pozostają wyłączone.
- W `DRY_RUN=true` nadal można otrzymać preview dla wszystkich użytkowników; nikt nie otrzymuje roli.
- W produkcyjnym pilocie bramka działa zarówno w planowaniu workera, jak i przed zapisem w `RoleOperations` oraz w końcowym adapterze REST. Poza pilotem wynik audytu to `rollout_excluded` bez operacji PUT.
- Boty i własne ID aplikacji są wykluczone, `pending=true`/brak `pending` blokuje nadanie, Free Member nie jest automatycznie usuwane. `pending=false` może też oznaczać administracyjne pominięcie weryfikacji.

## Etap 1: wdrożenie bez zapisów (można wykonać po zatwierdzeniu kodu i testów)

1. Zachowaj obecny SHA sprawdzonego wdrożenia oraz flagi (bez ujawniania tokenów).
2. W Hostingerze wybierz gałąź `feature/free-member-canary` i dotychczasowy punkt startowy `dist/hostinger.js`. Nie zmieniaj danych Supabase, TLS ani tokenów.
3. Ustaw `DISCORD_FREE_MEMBER_ROLLOUT_MODE=disabled`, usuń/zostaw pusty `DISCORD_FREE_MEMBER_CANARY_IDS` i `DISCORD_FREE_MEMBER_ALL_APPROVAL_REFERENCE`.
4. Zachowaj `DISCORD_DRY_RUN=true`, `DISCORD_WRITES_ENABLED=false`, `DISCORD_FREE_MEMBER_WRITES_APPROVED=false`. `DISCORD_VERIFICATION_ENABLED=true` i `DISCORD_GATEWAY_ENABLED=true`, pozostałe wymagane flagi produkcyjne bez zmian.
5. Restart; sprawdź `/ready` i brak `discord_worker_tick_failed`. Sprawdź, czy na serwerze są naprawdę aktywne Rules Screening, Server Members Intent oraz właściwe role.
6. Przed próbą na nowych kontach sprawdź **Dyno Autorole** oraz inne boty/ręczne nadawanie: żaden system nie powinien przyznawać Free Member przed ukończeniem Rules Screening. Wstrzymaj tylko konfliktującą regułę autorole, zachowując inne funkcje Dyno. Jeśli tego nie można zrobić bezpiecznie, nie przeprowadzaj prób na serwerze produkcyjnym.

### Kontrola bezpiecznego podglądu w Supabase SQL Editor (tylko SELECT)

```sql
SELECT created_at, metadata->>'memberId' AS member_id,
  metadata->>'outcome' AS outcome, metadata->>'pending' AS pending,
  metadata->>'dryRun' AS dry_run
FROM administrative_audit_logs
WHERE action = 'DISCORD_VERIFICATION_PLANNED'
ORDER BY created_at DESC LIMIT 30;
```

Przed zaakceptowaniem zasad nowego, normalnego konta (bez innych ról) oczekiwane `screening_pending_or_unknown`, po akceptacji `preview`. Bot: `bot_excluded`. Nie publikuj identyfikatorów użytkowników, jeśli niepotrzebne.

## Etap 2: pilot z dwiema osobami — wymaga osobnej, jawnej zgody na zmiany Discord

**Nie wykonywać bez potwierdzenia właściciela całego zakresu pilota.**

1. Wybierz maksymalnie dwa zwykłe, własne konta testowe z dokładnymi **Discord User IDs**. Nie używaj właściciela, administratora, botów ani realnych klientów. Potwierdź, że nie mają ról omijających screening i nie mają już Free Member.
2. Potwierdź brak konfliktującego Dyno Autoroles, rolę bota ponad Free Member, właściwego Guild Owner ID, brak uprawnień Administrator, oraz poprawność wszystkich ID Founder/Staff/VIP.
3. Zachowaj backup ustawień (bez sekretów) oraz odczytaj kolejkę `discord_member_jobs`; nie uruchamiaj `TRUNCATE`, migracji ani zbiorowego retry.
4. Dopiero na podstawie zgody właściciela ustaw **jednocześnie**:
   ```dotenv
   DISCORD_FREE_MEMBER_ROLLOUT_MODE=canary
   DISCORD_FREE_MEMBER_CANARY_IDS=<TEST_USER_ID_A>,<TEST_USER_ID_B>
   DISCORD_FREE_MEMBER_WRITES_APPROVED=true
   DISCORD_FREE_MEMBER_APPROVAL_REFERENCE=<SEPARATE_OWNER_APPROVAL_REFERENCE>
   DISCORD_DRY_RUN=false
   DISCORD_WRITES_ENABLED=true
   DISCORD_VERIFICATION_ENABLED=true
   ```
   Pozostaw `DISCORD_VIP_SYNC_ENABLED=false`, `DISCORD_PRODUCTION_VIP_WRITES_ENABLED=false` i `DISCORD_COMMANDS_ENABLED=false`. Nie ustawiaj obu trybów jako `true` lub `false` jednocześnie.
5. Zrestartuj aplikację bez nakładania się procesów. Wykonaj test:
   - A przed akceptacją zasad: brak Free Member i brak PUT;
   - A po akceptacji: dokładnie jedno dodanie Free Member;
   - B po poprawnej weryfikacji: Free Member przy zachowaniu innych ról;
   - użytkownik spoza listy z `pending=false`: audyt `rollout_excluded`, bez PUT;
   - boty: `bot_excluded`; brak usunięć i brak VIP/Staff/Founder mutations;
   - restart i ponowny skan: brak podwójnego PUT.
6. `/ready: true` potwierdza gotowość procesu, **nie dowodzi nadania roli**. Sprawdź log audytu i faktyczną rolę dwóch użytkowników.

### Odczyt zatwierdzonych operacji

```sql
SELECT created_at, operation, role_id, status, discord_user_id
FROM discord_role_operations
ORDER BY created_at DESC LIMIT 30;
```

Powinny pojawić się wyłącznie `add` dla właściwej roli Free Member i wyłącznie zatwierdzonych kont.

## Etap 3: wdrożenie na wszystkich (osobny projekt decyzji)

Tryb `all` jest celowo zablokowany bez nowej, odrębnej referencji zgody całoserwerowej. Nie wolno traktować udanego pilota jako takiej zgody. Przed zmianą oszacuj zaległe zadania i liczbę kwalifikujących się członków, rozważ rate limits, upewnij się, że reguła Dyno jest wyłączona, i przeglądnij audyt na testach. Dopiero potem użyj `DISCORD_FREE_MEMBER_ROLLOUT_MODE=all`, pustej listy canary i nowej `DISCORD_FREE_MEMBER_ALL_APPROVAL_REFERENCE`. Pozostałe wymagane zgody i kontrole pozostają aktywne.

## Rollback

1. Przy niepożądanym nadaniu natychmiast zatrzymaj bieżącą instancję/workera. Żądania Discord wysłane przed zatrzymaniem mogą się jeszcze zakończyć.
2. Wróć do `DISCORD_DRY_RUN=true`, `DISCORD_WRITES_ENABLED=false`, `DISCORD_FREE_MEMBER_WRITES_APPROVED=false`, `DISCORD_FREE_MEMBER_ROLLOUT_MODE=disabled`, pusta lista canary i pusta referencja all.
3. Uruchom jedną instancję. Zweryfikuj `/ready` i audyt. Nie wykonuj rollbacku SQL, `TRUNCATE` ani masowego usuwania ról; nadane role nie są automatycznie cofane.
4. Ręczne korekty wyłącznie po identyfikacji rzeczywistych operacji i zgodzie właściciela.
5. Jeśli problem jest w kodzie, wróć do zapisanego SHA działającej gałęzi w tym samym trybie bez zapisów.
