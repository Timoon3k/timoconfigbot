# TimonConfigs VIP Bot + Ticket Tool: zachowujemy istniejący Open Ticket

## Zatwierdzony cel
Użytkownik chce BEZ ZMIANY obecnego bota Ticket Tool i jego panelu `Open Ticket`: Ticket Tool tworzy prywatny ticket, TimonConfigs go wykrywa, automatycznie prezentuje VIP Monthly EUR 40/month albo VIP Lifetime EUR 100 one-time, tworzy INDYWIDUALNY Stripe Checkout, a po PRAWIDŁOWYM potwierdzeniu Stripe nadaje role VIP. Nie wymagamy WordPress w tej fazie. Działające Free Member po Discord Rules Screening pozostaje aktywne.

## Źródła i ograniczenia
- Oficjalne docs Ticket Tool: https://ticket-tool.app/docs/quick-start/first-ticket-panel — Ticket Tool tworzy kanały prywatnych ticketów; ustawienia kategorii mogą dodać Support Roles.
- https://ticket-tool.app/docs/guides/custom-messages — wiadomości powitalne per kategoria `Categories -> Messages`, z variable `{ticket.number}`, `{user.mention}`, `{channel.mention}`. To jest **konfigurowalne bez customowego API**.
- https://ticket-tool.app/docs/api/webhooks — oficjalny signed HMAC-SHA256 webhook, np. `TICKET_CREATED`, `X-TicketTool-Timestamp`, `X-TicketTool-Signature`, raw payload. Przykładowe zdarzenie podaje TYLKO ticketId/ticketNumber, nie właściciela ani ID kanału; nie wolno ich zgadywać!
- https://ticket-tool.app/docs/guides/ai-agent-setup — REST API access wymaga Pro; webhook flow również może wymagać płatnej opcji. Nie uzależniać podstawowego, darmowego wariantu od dostępu do Pro.
- https://github.com/discord/discord-api-docs/blob/main/developers/events/gateway.mdx — Gateway `CHANNEL_CREATE` wymaga tylko GUILDS intent, które TimonConfigs ma już aktywne. Bot może otrzymać event tylko dla widocznych mu kanałów; należy sprawdzić realne nadpisania permissions.

## Dwa kompatybilne warianty

### Wariant podstawowy (bez Ticket Tool API/Pro)
1. W Ticket Tool zachować panel `Open Ticket`. Jeśli są oddzielne kategorie: utworzyć/podłączyć `VIP Orders` przez UI Ticket Tool (nie usuwać istniejących Support/General/Refund).
2. Zanotować **Discord category ID** kanałów VIP ticketów (nie Ticket Tool category object ID). To będzie allowlista. W Discord Developer Mode: prawy przycisk na kategorii tekstowej -> Copy ID.
3. Upewnić się, że rola TimonConfigs VIP Bot ma `View Channel`, `Send Messages`, `Embed Links` oraz `Use Application Commands` tam, gdzie potrzebne; sprawdzić nadpisania tworzone przez Ticket Tool na każdym prywatnym ticket channel. **Nie nadawać Administrator ani Manage Channels.**
4. Serwerowy Gateway wykrywa `CHANNEL_CREATE` tylko przy dokładnym zgodnym guildId + parent_id należącym do allowlisty VIP, typ kanału 0. Po wykryciu, zapisuje idempotentnie channelId jako nowy ticket i publikuje raz kartę wyboru planu, z retry w przypadku opóźnionych permissions/rate limit. Jeśli event zginie podczas restartu, bezpiecznie wykrywa brakujące kanały przez ograniczoną paginację REST; nie przetwarza kanałów innych kategorii.
5. Alternatywa awaryjna: Ticket Tool `Categories -> Messages` w intro podaje `/vip-buy` do użycia wewnątrz ticket channel. Używamy `/vip-buy` także gdy auto-post fails.
6. Nie inferować `buyerId` z nazwy kanału, tematu ticketa ani wiadomości Ticket Tool. Wybór pakietu musi przyjść jako poprawnie podpisany Discord interaction od kupującego i mieć guild/channel ticket allowlist; wymusić że konto kupującego jest rzeczywistym członkiem tego serwera po Rules Screening, nie bota.

### Wariant Pro (opcjonalne wzmocnienie)
- Ticket Tool `TICKET_CREATED` webhook z oficjalnym podpisem; bezpieczna weryfikacja HMAC i 5-min timestamp przed parsowaniem, deduplikacja event ID, trwałe mapowanie ticket ID -> channel ID -> opener ID tylko na podstawie uwiarygodnionego ticket REST API lub niezależnego Discord membership check. Sam webhook payload nie wystarcza do ustalenia właściciela ani kanału.
- `TICKET_CLOSED` informuje TimonConfigs o zamknięciu widoku, ale nie cofa aktywnego VIP. Ponowne otwarcie ticketa nie może rozpocząć naliczenia podwójnej subskrypcji.
- Bez możliwości użycia Pro działamy w wariancie Gateway i nie wyłączamy Ticket Tool.

## Płatności i nadawanie roli
1. Discord button z własnej wiadomości TimonConfigs lub komenda `/vip-buy` -> odpowiedź ephemeral. Plan wybrany z serwerowej allowlisty, EUR, bez cen w danych klienta.
2. Ograniczenie 1 niezakończone checkout per buyer/ticket/plan (TTL) i niedopuszczenie 2 aktywnych auto-renew; identyfikator Discord ze zweryfikowanej interakcji.
3. Stripe Checkout hosted: `mode=subscription` €40/month albo `mode=payment` €100 lifetime. PayPal jeśli zatwierdzony i dostępny w metodach Stripe dla danego trybu.
4. Tworzenie Stripe Checkout dopiero gdy operator zaakceptuje rzeczywisty opis oferty skryptów Cronus Zen/XIM Matrix. W fazie rozwoju sandbox bez prawdziwych opłat.
5. Signed Stripe webhook + trwałe przetwarzanie z idempotencją, poprawną fakturą/płatnością (invoice.paid), powiązany user/Stripe customer/price/currency/payment ID, retry. Redirect/wiadomość z ticketa nigdy nie nadają roli.
6. Supabase entitlement; osobny worker nadaje właściwą rolę VIP; Foundera, Staff i Free Member nie zmienia, odczytuje bieżący pending=false i role; rozróżnia zapłatę od błędu nadania i zgłasza status w prywatnym tickecie.
7. Miesięczna opłata jest odnawiana przez Stripe Billing; cancel zachowuje paid-through, refund/chargeback adekwatnie aktualizuje entitlement, Lifetime pozostaje według warunków licencji.

## Co jest zrobione na gałęzi teraz
- `src/tickets/ticket-tool-bridge.ts`: czysta weryfikacja podpisów webhooków Ticket Tool i ścisłe rozpoznawanie potencjalnych kanałów ticketa po guildId/Discord parent category ID.
- `tests/unit/ticket-tool-bridge.test.ts`: testy podpisu, replay, zmian payloadu, braku event data i category allowlist.
- NIE jest to jeszcze endpoint ani system checkout! Żadna konfiguracja produkcyjna lub istniejący Ticket Tool nie została zmieniona. Nie włączać roli VIP ani płatności.

## Kolejne zadanie implementacyjne Codex
1. Bramka Gateway `CHANNEL_CREATE` i trwały ticket_jobs/outbox; pilot ograniczony do jednej Discord category allowlist. Nie wymaga Pro.
2. Oddzielny, kontrolowany bot message REST pozwalający tylko POST w zweryfikowanych ticket channels (nie powiązany z permisją do zmieniania ról). Bezpieczeństwo podpisanych button interactions i <=3s initial response.
3. Zabezpieczenia duplicate/restart, error retries i permissions. Testy automatyczne z fake Discord Gateway/HTTP; nie wysyłać wiadomości na żywy serwer.
4. Dodać `/vip-buy` jako fallback. Zarejestrować obok istniejących `/help`, `/membership`, `/sync-status` bez usuwania komend i bez omijania zgody read-only registration.
5. W następnej kolejności po wyborze i weryfikacji Stripe: implementacja Checkout + Billing + webhook, dokumentacja w `docs/VIP_PAYMENTS_IMPLEMENTATION_PL.md`.

## Potwierdzona kategoria od właściciela
- Discord guild: `1557854161805115402`.
- Ticket Tool tworzy obecne ogólne kanały `Open Ticket` pod kategorią Discord **Support**: `1557857668964687913`. Zachowujemy je WYŁĄCZNIE do pomocy. Nowa, odrębna kategoria Discord **VIP Orders** musi zostać utworzona przez właściciela i otrzyma nowy ID.
- Konfiguracja rozdziału to `TICKET_TOOL_SUPPORT_DISCORD_CATEGORY_ID=1557857668964687913`, `TICKET_TOOL_DISCORD_CATEGORY_IDS=<NEW_VIP_ORDERS_DISCORD_CATEGORY_ID>`, `TICKET_TOOL_CHANNEL_OBSERVATION_ENABLED=true` (dopiero po wdrożeniu, migracji i testach). Kod odrzuca konfigurację wskazującą Support jako kategorię zakupową. **Obecna wersja tylko zapisuje nowe kanały VIP Orders** do `discord_ticket_channels`; nie publikuje jeszcze pakietów, nie uruchamia Stripe i nie nadaje VIP.
- W Ticket Tool dashboard utworzyć osobną **Ticket Tool Category: VIP Purchase** z Discord target channel category **VIP Orders**, a w **Panels** utworzyć oddzielny `TimonConfigs VIP Shop` panel i opublikować go w `#buy-vip`. Istniejącego Open Ticket/Support nie zmieniać. Nie tworzyć Checkout bez podpisanej interakcji kupującego.
- **Nie zmieniać jeszcze aktywnych zmiennych Hostingera.** Nowy kod wymaga wcześniejszego uruchomienia migracji `004_discord_ticket_channels.up.sql` po testach i zatwierdzeniu.
- Bot musi otrzymywać `CHANNEL_CREATE` i widzieć prywatny kanał; Ticket Tool może zastosować nadpisania uprawnień, które ukryją kanał przed TimonConfigs. Najpierw sprawdzić uprawnienia `View Channel` i dla przyszłych wiadomości `Send Messages` oraz `Embed Links` w ticket channel, bez nadawania Administrator.
- Free Member pozostaje działające na produkcji, nie włączać VIP sync ani realnych płatności przed audytem.
 
## Instrukcja Ticket Tool dla właściciela
1. Discord -> Create Category -> `💎 VIP Orders`, Copy ID kategorii Discord.
2. Ticket Tool dashboard -> Categories -> Create Category `VIP Purchase`, target Discord channel category `💎 VIP Orders`; podpiąć role Staff jako Support Roles.
3. Panels -> Create Panel `TimonConfigs VIP Shop`; w panelu dodać wyłącznie ticket category `VIP Purchase`.
4. Publikacja np. `#buy-vip` poleceniem `/setup-panel` lub opcją Send Panel. Stary `Open Ticket` dalej działa osobno.
5. Przekazać **tylko ID nowej kategorii Discord VIP Orders**; nie przesyłać tokenów ani Stripe API keys.
Dokumentacja: https://ticket-tool.app/docs/quick-start/first-ticket-panel i https://ticket-tool.app/docs/concepts/panels i https://ticket-tool.app/docs/guides/custom-messages.

## Pozostałe informacje do potwierdzenia
- Czy Ticket Tool jest Free/Community/Pro? Nie przeszkadza to Gateway, ale determinuje możliwą alternatywę webhookową.
- Stripe weryfikacja osoby/merchant, odpowiedź Stripe dotycząca akceptacji rzeczywistej oferty i PayPal recurring (bez przesyłania sekretów).
