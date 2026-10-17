# VIP Orders: audyt uprawnień i automatyczna oferta

## Stan rzeczywisty i zakres

Nie przeprowadzono audytu żywego Discorda: w środowisku chmurowym nie ma
`DISCORD_BOT_TOKEN` ani konektora Discord. Brakujące rzeczywiste uprawnienia
pozostają nieustalone. Nie zastosowano żadnych zmian na serwerze, Hostingerze,
Supabase lub Stripe. Poniższe polecenia są instrukcją dla właściciela do
wykonania później, po zatwierdzeniu wdrożenia.

Gałąź startowa: `feature/ticket-tool-discord-bridge`, SHA
`cf2cec3313dcf9fc253e4649fbc275aa58e82c3f`. Nie zakładać, że to aktualnie
wdrożony SHA. Gałąź robocza: `feature/vip-ticket-permissions`.

**Free Member pozostaje aktywne. Nie zmieniać jego ID, zgód, trybu canary/all,
flagi writes ani DRY_RUN. Nie kopiować całego `.env.example` na produkcję.**
Nowe flagi ticketów są osobne i domyślnie wyłączone. Kod nie tworzy płatności,
checkoutów, subskrypcji ani ról VIP. Ticket Tool nadal tworzy/zamyka tickety;
stary panel Support pozostaje bez zmian.

## Potwierdzone ID — stan panelu Ticket Tool (11 października 2026)

- Guild: `1557854161805115402`.
- Bot Ticket Tool **użytkownik**: `557628352828014614` — poprawna wartość dla `TICKET_TOOL_BOT_ID`.
- Discord category VIP Orders: `1558892807786209360`.
- Discord category Support: `1557857668964687913` (nie uruchamiać zakupów).
- Publiczny kanał `#open-vip-ticket`: `1558927395233468416` — wartość argumentu `--panel-channel`.
- **ID prywatnego ticket channel:** JESZCZE NIEZNANE. Na przesłanym ekranie kanał publiczny jest pusty: Ticket Tool panel nie został jeszcze opublikowany, zatem `--ticket-channel` nie da się poprawnie uzupełnić.

### Co właściciel musi najpierw zrobić (poza Codex Cloud)

1. Dashboard Ticket Tool → edytuj istniejący osobny panel `TimonConfigs | VIP Shop`. Zadbaj o element typu **BUTTON** z kategorią `VIP Purchase` (nie samo przypisanie Discord category; wybór category w panel item jest oddzielnym krokiem).
2. W Discordzie użyj **komendy Ticket Tool** `/setup-panel`; wybierz `TimonConfigs | VIP Shop`, kanał `#open-vip-ticket`. Dashboard zapisuje konfigurację, ale nie publikuje panelu sam. Dokumentacja: https://ticket-tool.app/docs/concepts/panels .
3. Sprawdź, że w publicznym kanale pojawił się embed Ticket Tool z przyciskiem `Open VIP Ticket`. Jeżeli jest pusty, nie próbuj uruchamiać audytu na ślepo.
4. Kliknij przycisk; powinien powstać **prywatny kanał** pod Discord category VIP Orders. Skopiuj jego ID. Jeśli ticket ląduje w Support — napraw przypisanie `VIP Purchase -> VIP Orders` w Ticket Tool; nie zmieniaj systemu Support.
5. Dopiero po sprawdzeniu prywatności można uruchomić read-only CLI z obydwoma istniejącymi ID kanałów. Nie publikuj wyników zawierających potencjalne prywatne nazwy i role klientów.

Przykładowe zmienne przekazywane **tylko do CLI**, bez modyfikowania produkcji:
```sh
export TICKET_TOOL_BOT_ID=557628352828014614
export VIP_PUBLIC_PANEL_ID=1558927395233468416
# VIP_TEST_TICKET_ID: wkleić ID faktycznie utworzonego prywatnego ticketa, nie ID VIP Orders ani panelu.
```

## Wdrożenie na istniejącym Hostingerze

1. Przejrzeć PR/diff. Zapisać SHA działającej wersji i istniejące niesekretne
   ustawienia Free Member; zachować bez zmian sekrety i konfigurację bazy.
2. Po zatwierdzeniu przygotować wersję dotychczasową procedurą:

   ```sh
   npm ci
   npm run typecheck
   npm run build
   npm run lint
   npm run test:unit
   ```

3. Integracje uruchamiać wyłącznie na lokalnej, jednorazowej bazie. Nie
   uruchamiać ich na Hostingerze z produkcyjnym `DATABASE_URL`; testy zawierają
   TRUNCATE. W tej pracy użyto nowego kontenera PostgreSQL 16 na
   `127.0.0.1:55435`, baza końcowej walidacji `vip_ticket_final_test`, fikcyjne
   dane logowania. Wcześniejsze przebiegi używały również `vip_ticket_test`.
4. Przed uruchomieniem nowej wersji po osobnym zatwierdzeniu migracji wykonać
   na istniejącym, zweryfikowanym połączeniu aplikacji:

   ```sh
   npm run db:migrate:built
   ```

   Potrzebne migracje: istniejąca `004_discord_ticket_channels` oraz nowa
   `005_vip_ticket_welcome`. Migrator sprawdza checksum i pomija już wykonane
   wersje. `005` dodaje kolejkę wiadomości i dziennik wyborów produktów oraz
   rozróżnia źródło obserwacji `gateway` i `reconcile`;
   nie modyfikuje uprawnień członkostwa ani płatności. Nie uruchamiano tego
   polecenia na produkcji podczas pracy Codex.
5. Uruchomić nową wersję z dotychczasowym entrypointem. Utrzymać początkowo:

   ```dotenv
   TICKET_TOOL_CHANNEL_OBSERVATION_ENABLED=false
   TICKET_TOOL_WELCOME_WRITES_ENABLED=false
   TICKET_TOOL_SELECTIONS_ENABLED=false
   ```

   Sprawdzić `/ready`, Gateway i zwykłe nadanie Free Member po Rules Screening.
   Istniejące `DISCORD_VIP_SYNC_ENABLED=false` i
   `DISCORD_PRODUCTION_VIP_WRITES_ENABLED=false` zachować. Nie rejestrować
   nowych slash commands: ta implementacja obsługuje przyciski i zachowuje
   istniejące `/help`, `/membership`, `/sync-status`.

## Dokładny audyt odczytowy na Hostingerze

W shellu działającej aplikacji korzystać z istniejącego bezpiecznego
`DISCORD_BOT_TOKEN` i konfiguracji produkcyjnej. Nie wklejać tokenu do
poleceń ani raportu. Bramka wymaga istniejącej zgody na sieć, zgodnego
guild/owner/client ID i adaptera REST. Ustawić tylko dla procesu CLI
poniższe niesekretne wartości; same nie włączają wiadomości ani ról:

```sh
export TICKET_TOOL_SUPPORT_DISCORD_CATEGORY_ID=1557857668964687913
export TICKET_TOOL_DISCORD_CATEGORY_IDS=1558892807786209360
export TICKET_TOOL_BOT_ID='<actual-ticket-tool-user-id>'
export VIP_TEST_TICKET_ID='<actual-private-vip-ticket-channel-id>'
export VIP_PUBLIC_PANEL_ID='<actual-open-vip-ticket-channel-id>'
npm run discord:ticket-audit:built -- \
  --ticket-channel "$VIP_TEST_TICKET_ID" \
  --panel-channel "$VIP_PUBLIC_PANEL_ID" \
  --output /tmp/tc-vip-permissions-before.json
```

ID Ticket Tool to **ID konta bota**, nie ID roli. Pobiera je właściciel z
profilu bota w Discord Developer Mode. ID kanałów należy skopiować z
rzeczywistego prywatnego ticketa pod VIP Orders i publicznego
`#open-vip-ticket`; CLI nie zgaduje ich i nie przenosi panelu.

CLI wykonuje tylko GET, zapisuje raport z prawami `0600`, nie nadpisuje
istniejącego pliku `--output`. Raport obejmuje role/hierarchię, efektywne
uprawnienia botów, rzeczywiste overwrites kategorii/ticketa, brakujące cztery
uprawnienia, widoczność panelu dla `@everyone`/Free Member i dostęp Staff.
Wyliczenia ról dotyczą samych ról; indywidualne wyjątki poszczególnych Staff
lub klientów wymagają dodatkowego sprawdzenia przez właściciela.

`corrections` zawiera **dokładne before/after** tylko dla member overwrite
TimonConfigs (`DISCORD_CLIENT_ID`), na VIP Orders i wskazanym tickecie.
Zmiana dodaje wyłącznie View Channel, Send Messages, Embed Links i Read
Message History, usuwa deny tylko tych bitów, zachowuje wszystkie inne bity.
`needsChange=false` oznacza brak potrzeby zmiany; `canApply=false` oznacza
blokadę prawną/techniczną. Nie zmienia żadnej roli, panelu ani kanału Support.

## Opcjonalne, osobno zatwierdzone zastosowanie korekt

Właściciel musi najpierw przeczytać raport i zatwierdzić konkretne różnice.
Potem może uruchomić:

```sh
npm run discord:ticket-audit:built -- \
  --ticket-channel "$VIP_TEST_TICKET_ID" \
  --panel-channel "$VIP_PUBLIC_PANEL_ID" \
  --apply --plan /tmp/tc-vip-permissions-before.json \
  --approval-reference '<actual-owner-approval-for-these-overwrites>' \
  --audit-log /tmp/tc-vip-permissions-apply.jsonl
```

Referencja zgody: 8–200 znaków, osobna względem zgód sieciowych, Free Member
i panelu. Nie traktować tekstu przykładowego jako zgody. Zapis jest dozwolony
tylko przy identycznym aktualnym planie, prawidłowej prywatności/hierarchii,
dostępie Free Member do panelu, dostępie Staff do ticketa oraz wystarczających
legalnych uprawnieniach bota. Bot nie może mieć Administrator; wymagane są
efektywne Manage Roles w naprawianym kanale i bazowe cztery uprawnienia.
Nie próbuje się samodzielnie zdobywać brakujących uprawnień.

Przed każdym PUT CLI ponownie sprawdza overwrites, zapisuje intencję do pliku,
po PUT wykonuje GET i sprawdza własny overwrite oraz niezmienność pozostałych.
Discord nie zapewnia warunkowego PUT overwrites: podczas apply właściciel
powinien wstrzymać równoległe ręczne edycje. Zmiana kategorii może synchronizować
tickety dziedziczące uprawnienia; jeśli drugi target zmienił się wskutek tego,
CLI zatrzyma się. Wtedy ponowić audyt, przejrzeć i zatwierdzić nowy plan.
Nie wykonuje automatycznego cofania częściowo potwierdzonych korekt.

## Gdy bot nie może wykonać korekty — Discord UI

Nie nadawać Administrator ani nowych uprawnień zarządzania tylko dla naprawy.
Jeśli GET ticketa zwraca 403/404 lub `canApply=false`, właściciel:

1. Discord → `VIP Orders` → Edit Category → Permissions → Add members →
   wybrać **TimonConfigs VIP Bot**. Włączyć tylko View Channel, Send Messages,
   Embed Links i Read Message History. Nie edytować `@everyone`, Owner,
   Staff, Free Member ani kategorii General Support.
2. Otworzyć konkretny prywatny ticket → Edit Channel → Permissions → Add
   members → ten sam bot → te same cztery Allow. Zachować `@everyone`
   View Channel=Denied, indywidualny dostęp otwierającego i dotychczasowe
   nadpisania Staff/Ticket Tool. Nie używać „Sync permissions” bez sprawdzenia
   prywatności: mogłoby usunąć indywidualny dostęp klienta.
3. Ticket Tool dashboard → wyłącznie kategoria `VIP Purchase` → Support
   Roles/Permissions → uwzględnić istniejącą dedykowaną rolę TimonConfigs
   oraz dotychczasowe Staff; zadbać, by nowo tworzone prywatne tickety miały
   wymagane cztery uprawnienia. Nie zmieniać starego Support panelu.
4. Jeśli `staffTicketVisible=false`, właściciel sprawdza konfigurację Staff
   w tej kategorii Ticket Tool. CLI nie zmienia roli Staff ani jej overwrites.
   Jeśli panel jest niewidoczny dla Free Member, właściciel przegląda tylko
   overwrites publicznego panelu; nie zmienia roli Free Member i nie przenosi
   kanału do innej kategorii. Takie zmiany wymagają oddzielnej decyzji.
5. Server Settings → Roles: **sprawdzić** Manage Roles i pozycję istniejącej
   roli TimonConfigs powyżej VIP Monthly/Lifetime, poniżej Founder/Staff.
   Nie przesuwać Owner/Staff i nie naprawiać hierarchii skryptem. Jeśli jest
   nieprawidłowa, zgłosić ją właścicielowi do osobnej zatwierdzonej korekty.
6. Ponowić odczytowy CLI, otworzyć nowy testowy ticket VIP i sprawdzić go
   także z dwóch zwykłych kont: klient A widzi panel i swój ticket; klient B
   widzi panel i swój ticket, lecz nie ticket A. Staff widzi oba.

## Aktywacja automatycznej oferty — dopiero po audycie i zgodzie

Po migracjach i zatwierdzeniu odczytów ustawić w istniejącej aplikacji:

```dotenv
TICKET_TOOL_CHANNEL_OBSERVATION_ENABLED=true
TICKET_TOOL_SUPPORT_DISCORD_CATEGORY_ID=1557857668964687913
TICKET_TOOL_DISCORD_CATEGORY_IDS=1558892807786209360
TICKET_TOOL_BOT_ID=<actual-ticket-tool-user-id>
TICKET_TOOL_WELCOME_WRITES_ENABLED=false
TICKET_TOOL_SELECTIONS_ENABLED=false
```

Najpierw sprawdzić obserwację nowego ticketa i brak obserwacji Support.
Następnie po **osobnej zgodzie na wysyłanie wiadomości i zapisy wyborów**:

```dotenv
TICKET_TOOL_WELCOME_APPROVAL_REFERENCE=<actual-separate-owner-message-approval>
TICKET_TOOL_WELCOME_NOT_BEFORE=<approved-rollout-time-in-ISO-8601-with-timezone>
TICKET_TOOL_WELCOME_WRITES_ENABLED=true
TICKET_TOOL_SELECTIONS_ENABLED=true
```

Timestamp musi być jawny, np. wynik `date -u +%Y-%m-%dT%H:%M:%SZ` zapisany
przy zatwierdzeniu. Kod filtruje czas utworzenia kanału z Discord snowflake;
nie publikuje automatycznie w starszych ticketach. Skan co 5 minut odnajduje
zdarzenia utracone po restarcie. Wyłączenie observation/messages jest niezależne
od flag Free Member. Nigdy nie zmieniać ich przy aktywacji lub rollbacku ticketów.

Oczekiwany embed EN: `TimonConfigs VIP Membership`, Monthly EUR 40/month
auto-renewal, Lifetime EUR 100 one-time. Przyciski `Select Monthly` i
`Select Lifetime`; wybór wymaga podpisu Ed25519, poprawnego application,
guild, channel, wiadomości panelu i aktualnego REST `pending=false` dla
człowieka widzącego prywatny ticket. Identyfikator kupującego pochodzi z
podpisanej interakcji, nie nazwy ticketa. Odpowiedź jest ephemeral;
przy opóźnieniu kontrolny komunikat pojawia się po 1,8 s, a weryfikacja może
dokończyć się w tle. Żadna odpowiedź nie pobiera opłaty ani nie nadaje VIP.

Nie istnieje `/vip-buy` ani Stripe Checkout w tej zmianie. Przyszłe płatności
i VIP sync wymagają osobnej implementacji oraz zgód operatora płatności.

## Monitoring i rollback

- `discord_ticket_welcome_jobs`: `queued`, `processing`, `retry`, `sent`,
  `blocked`. Sprawdzać `last_error_code`, `message_id`, `send_started_at`;
  nie publikować surowych payloadów interakcji ani sekretów.
- `TICKET_SEND_REVIEW_REQUIRED`: wynik dawnego POST nie jest jednoznaczny.
  Bot nie ponowi POST na ślepo. Właściciel sprawdza historię konkretnego
  ticketa; nie kasować automatycznie dowodów i nie resetować intencji.
- Audyty: `VIP_TICKET_OBSERVED`, `VIP_TICKET_MESSAGE_INTENT`,
  `VIP_TICKET_MESSAGE_CONFIRMED`, `VIP_TICKET_MESSAGE_FAILED`,
  `VIP_TICKET_PRODUCT_SELECTED`. Intencja jest zapisana przed wysłaniem.
- Rollback funkcji: ustawić tylko `TICKET_TOOL_WELCOME_WRITES_ENABLED=false`,
  `TICKET_TOOL_SELECTIONS_ENABLED=false`; w razie potrzeby także observation
  `false`. Zrestartować dotychczasową aplikację. **Free Member nie wyłączać.**
  Żądanie wysłane przed restartem może się jeszcze zakończyć.
- Przy regresji kodu wrócić do wcześniej zanotowanego działającego SHA,
  zachowując migracje i dane. Nie uruchamiać destructive db rollback:
  migracja `005.down` odmawia usunięcia dowodów wysyłek/wyborów.
- Nie usuwać automatycznie wiadomości, ticketów ani ról. Cofnięcie konkretnych
  member overwrites tylko ręcznie przez właściciela na podstawie `before`
  i aktualnego stanu, z uwzględnieniem nadal potrzebnego dostępu bota.

## Walidacja tej gałęzi

Wykonano typecheck, build i lint. Początkowy lint wykazał istniejące
`prefer-const` w teście diagnostycznym workera; poprawiono wyłącznie deklarację.
Nowe testy obejmują obliczanie uprawnień, brak prywatności, legalność korekty,
osobną zgodę i odrzucenie zmienionego planu, podpisy przycisków, deadline,
izolację pętli Free Member, duplikaty, restart, utratę potwierdzenia,
rate limit, nieaktualną dzierżawę, wyłączone funkcje i blokadę botów/nieuprawnionych
klientów. Wszystkie odpowiedzi Discorda w testach pochodzą z fixture transportów.

Końcowy wynik: `npm run typecheck`, `npm run build`, `npm run lint` — kod
wyjścia 0; `npm run test:unit` — 112/112, 8 plików. Migracje 001–005 wykonano
na nowej bazie `vip_ticket_final_test`. Wybrane integracje: 18/18 ticketów
i 14/14 Rules Screening/Free Member, łącznie 32 zaliczone; 10 innych testów
Discord pominięto przez jawny filtr. Pozostałych zestawów integracyjnych
nie uruchamiano. Lokalny kontener zatrzymano po walidacji.

## Lista plików

- Nowe moduły: `src/tickets/permissions.ts`, `permission-audit.ts`,
  `permission-audit-cli.ts`, `rest.ts`, `service.ts`.
- Podłączenie do istniejącej aplikacji: `src/discord/runtime.ts`, `worker.ts`,
  `worker-cli.ts`, `cron-cli.ts`, `transport.ts`, `config.ts`, `commands.ts`,
  `http.ts`, `src/http/app.ts`, `src/hostinger.ts`. Zmiana `hostinger.ts`
  dotyczy przekazania kolejki do istniejącego workera, nie konfiguracji hostingu.
- Migracje: `db/migrations/005_vip_ticket_welcome.up.sql` i `.down.sql`;
  migracja 004 pozostała bez zmian.
- Testy: `tests/ticket-fixture.ts`, `tests/unit/ticket-permissions.test.ts`,
  `tests/integration/vip-tickets.test.ts`; drobna korekta istniejącego
  `tests/unit/worker-diagnostics.test.ts` dla lint.
- Konfiguracja rozwoju i dokumentacja: `.env.example`, `package.json`,
  `docs/VIP_TICKET_PERMISSIONS_PL.md`.
