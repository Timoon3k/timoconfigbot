# TimonConfigs — uruchomienie Faz 1–2 na Windows (offline)

## Wymagania

- Windows 10 lub 11;
- Node.js 24 LTS (minimum 22.13 dla aktualnych narzędzi ESLint);
- Docker Desktop z uruchomionym silnikiem Linux containers;
- Git i PowerShell 7 są zalecane.

## Instalacja

W PowerShell przejdź do katalogu repozytorium i wykonaj:

```powershell
npm ci
Copy-Item .env.example .env
docker compose up -d postgres
```

Plik `.env` jest lokalny i ignorowany przez Git. Zmień `SESSION_PEPPER` oraz `PASSWORD_PEPPER` na dwa różne, losowe ciągi mające co najmniej 32 znaki. Możesz wygenerować każdy poleceniem `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` i zapisać lokalnie. Nie wysyłaj ich do czatu. Pozostaw token bota i sekret klienta Discord puste. Identyfikatory z przykładu są fikcyjne; lokalne testy nie wymagają aplikacji Discord.

Załaduj lokalne wartości do bieżącej sesji PowerShell:

```powershell
Get-Content .env | ForEach-Object {
  if ($_ -match '^[^#].*=') {
    $name, $value = $_ -split '=', 2
    Set-Item -Path "Env:$name" -Value $value
  }
}
```

Zastosuj migracje i uruchom backend:

```powershell
npm run db:migrate
npm run dev
```

Endpoint diagnostyczny będzie dostępny pod `http://127.0.0.1:3001/health`. Odpowiedź musi wskazywać `payments: sandbox-only` oraz `discord: dry-run`.

## Testy na osobnej bazie

Utwórz bazę testową w działającym kontenerze:

```powershell
docker compose exec postgres createdb -U timonconfigs timonconfigs_test
$env:TEST_DATABASE_URL = "postgresql://timonconfigs:timonconfigs_dev@localhost:5432/timonconfigs_test"
npm test
npm run lint
npm run typecheck
npm run build
npm run test:smoke
```

Testy same stosują migracje na `TEST_DATABASE_URL`. Są destrukcyjne dla danych testowych (TRUNCATE) i wymagają odrębnej bazy; nie kieruj ich na bazę deweloperską z ważnymi danymi. Smoke tworzy fikcyjne rekordy i sam uruchamia oraz zamyka procesy na wolnym porcie loopback. Nie wymaga ręcznego startu serwera ani workera.

## Migracje i rollback

`npm run db:migrate` stosuje brakujące pliki `*.up.sql` w kolejności wersji i sprawdza ich SHA-256. Zmiana treści zastosowanej migracji powoduje błąd. Poprawki schematu należy dodawać jako nową migrację.

`npm run db:rollback` cofa ostatnią migrację. Polecenie usuwa dane należące do cofanej wersji, dlatego służy do lokalnego developmentu i kontrolowanych procedur wdrożeniowych, a nie do wykonywania bez kopii zapasowej.

## Worker i symulacje Fazy 2

W drugim oknie PowerShell przejdź do tego samego katalogu i ponownie załaduj `.env` powyższym fragmentem. Uruchom:

```powershell
npm run discord:worker
```

W trzecim oknie, po załadowaniu `.env`:

```powershell
npm run discord:demo
```

Demo tworzy unikalne konto testowe, przeprowadza mock OAuth z jednorazowym kodem i PKCE, symuluje zakup Monthly i dodaje zadania do outboxu. Wypisuje identyfikator konta i preview po angielsku. Worker zapisuje `preview` lub `noop` w historii. Nie zmienia nawet fikcyjnej tabeli ról — dry-run pozostaje podglądem. Powtórzenie demo tworzy kolejne, niezależne konto testowe.

Po build można użyć `npm start` i `npm run discord:worker:built`. Zatrzymanie przez Ctrl+C czeka na zakończenie bieżącej ograniczonej czasowo próby. Po awarii niewykonane zadanie jest przejmowane po wygaśnięciu leasingu (domyślnie 120 sekund).

## Odczyt wyników

```powershell
Invoke-RestMethod http://127.0.0.1:3001/health
Invoke-RestMethod http://127.0.0.1:3001/ready
docker compose exec postgres psql -U timonconfigs -d timonconfigs -c "SELECT id,status,attempt_count,last_error_code FROM discord_sync_jobs ORDER BY created_at DESC LIMIT 20"
docker compose exec postgres psql -U timonconfigs -d timonconfigs -c "SELECT id,outcome,error_code,preview FROM discord_sync_history ORDER BY id DESC LIMIT 10"
docker compose exec postgres psql -U timonconfigs -d timonconfigs -c "SELECT action,metadata,created_at FROM administrative_audit_logs WHERE action LIKE 'DISCORD_%' ORDER BY id DESC LIMIT 20"
```

`/ready` zwraca 503, gdy baza lub heartbeat workera są niedostępne. `/health` opisuje tryb procesu; sam kod 200 nie dowodzi synchronizacji. Dowodem dry-run jest rekord historii zawierający konkretny plan ról i `dryRun: true`.

## Lokalny administrator

Możesz zarejestrować konto deweloperskie przez `POST /auth/register`, a następnie lokalnie nadać uprawnienie administratora. To narzędzie wymaga dostępu do bazy i działa tylko w wydaniu offline; nie tworzy publicznego endpointu nadawania uprawnień:

```powershell
$email = Read-Host "Local account email"
$securePassword = Read-Host "Local account password (minimum 12 characters)" -AsSecureString
$password = [System.Net.NetworkCredential]::new('', $securePassword).Password
$body = @{ email = $email; password = $password } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3001/auth/register -ContentType application/json -Body $body
$env:ADMIN_EMAIL = $email
npm run admin:grant-local
$login = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3001/auth/login -ContentType application/json -Body $body -SessionVariable browser
$headers = @{ 'x-csrf-token' = $login.csrfToken }
Invoke-RestMethod http://127.0.0.1:3001/admin/discord/statistics -WebSession $browser
Remove-Variable password, body, securePassword
Remove-Item Env:ADMIN_EMAIL
```

Mutujące endpointy wymagają `-WebSession $browser -Headers $headers`. Lista tras i przykłady payloadów są w raporcie Fazy 2. `/api/discord/connect` w trybie mock nie prowadzi do działającego logowania Discord. Poprawny kod mock może wystawić wyłącznie fixture testu lub CLI demo; klient HTTP nie może wskazać dowolnego Discord ID.

## Diagnostyka

| Objaw | Działanie |
|---|---|
| Brak `DATABASE_URL` lub pepperów | Załaduj `.env` w każdym oknie PowerShell. |
| Port PostgreSQL 5432 zajęty | Zmień lokalny port w Compose i oba URL bazy. |
| Brak relacji `discord_sync_history` | Wykonaj `npm run db:migrate` na właściwej bazie. |
| `member_absent` | Fixture członka nie istnieje; użyj demo. W prawdziwym Discord odpowiada nieobecności na serwerze. |
| `ROLE_OWNERSHIP_UNKNOWN` | Odczytaj preview; nie usuwaj ręcznej roli. Zatwierdź osobno politykę mock ownership przez autoryzowane API. |
| `dead_letter` z błędem hierarchii/permissions | Popraw konfigurację testową i utwórz nowe jawne zadanie; automatyczny retry jest zablokowany. |
| `retry` | Odczytaj `available_at` i kod błędu; Retry-After ma pierwszeństwo przed backoff. |
| Callback nie działa | Używaj tego samego hosta (`localhost` albo `127.0.0.1`) podczas logowania i callbacku; sesja jest związana ze state. |
| Start odrzucony dla produkcji/REST | Ta wersja wymaga osobno zatwierdzonego wydania aktywacyjnego; samo przestawienie flag nie odblokuje sieci. |

## Ograniczenia wydania offline

- adapter `mock` nie łączy się z żadnym operatorem i nie przetwarza pieniędzy;
- `PAYMENTS_ENABLED=true` albo `PROVIDER_APPROVAL_CONFIRMED=true` zatrzymuje start aplikacji;
- `DISCORD_DRY_RUN=false` zatrzymuje start aplikacji;
- outbox Discord jest wykonywany przez worker jako podglądy, bez zapisów ról;
- REST, token exchange OAuth i podpisy komend są sprawdzone kontraktami mock; zgodność z rzeczywistą aplikacją Discord wymaga późniejszych testów;
- `DISCORD_NETWORK_ENABLED=true`, `DISCORD_WRITES_ENABLED=true`, `DISCORD_ADAPTER=rest` i `NODE_ENV=production` są odrzucane;
- panel klienta i prywatna biblioteka plików należą do późniejszych faz; realne uruchomienie OAuth wymaga osobnej zgody na połączenie.
