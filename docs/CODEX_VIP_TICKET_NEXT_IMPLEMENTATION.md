# Implementacja następnego etapu: Ticket Tool VIP Orders → automatyczna oferta VIP

Repo: Timoon3k/timoconfigbot
Gałąź startowa: feature/ticket-tool-discord-bridge (nie tworzyć od main, nie nadpisywać produkcji).
Potwierdzone przez właściciela Discord guild ID: `1557854161805115402`; General Support category ID: `1557857668964687913` (BEZ ZMIAN), VIP Orders category ID: `1558892807786209360` (TYLKO ticket zakupowy).
Zewnętrzny Ticket Tool zostaje włączony i zarządza tworzeniem/zamykaniem ticketów. Nowy panel Ticket Tool `VIP Purchase` wskazuje kategorię kanałów VIP Orders, a stary Open Ticket pozostaje Support.

## Zakres implementacji (na osobnej gałęzi i w małych commitach)

1. Audytuj aktualny kod i scal/portuj bez konfliktów poprawki z feature/production-readonly-commands (read-only /help /membership /sync-status). Nie zastępuj aktualnej Free Member policy ani środowiska Hostingera. Dopasuj nową komendę `/vip-buy` do istniejących podpisanych interakcji Discord i jawnego scoping do VIP Orders.
2. Po GUILD CHANNEL_CREATE obserwuj wyłącznie parent_id=1558892807786209360, type=0 i guild_id=1557854161805115402. Nigdy nie wyzwalaj zakupów w Support 1557857668964687913. Dodaj idempotentny durable job/outbox w Supabase dla utworzonych ticketów, aby restart / reconnect / duplicate gateway events nie powodowały wielu kart; reconciling po awarii.
3. Stwórz kontrolowaną osobną bramkę POST /api/v10/channels/{ticketChannelId}/messages dla bota: dozwolona tylko w verified VIP Orders ticket channel; kontrola Uprawnienia View Channel, Send Messages, Embed Links. Nie używaj flag role-write do obejścia tej bramki. Nigdy nie nadaj Administrator.
4. Po otrzymaniu nowego VIP ticketa publikuj JEDEN embed EN 'TimonConfigs VIP Membership' + dwa przyciski: `VIP Monthly €40 / month` (auto-renew) i `VIP Lifetime €100 one-time`. Pozostaw wsparcie manualnej wiadomości przy Ticket Tool, gdy bot chwilowo offline. Nie umieszczaj bezpośredniego Stripe Payment Linku przed identyfikacją kupującego.
5. Button interaction musi mieć ważny Discord Ed25519 signature + timestamp, poprawne application_id, guild_id i channel_id. Z interakcji pobierz rzeczywisty Discord member.user.id kupującego (nigdy z nazwy kanału/ticket title/payload od bota Ticket Tool). Weryfikuj po Discord REST pending=false; bot excluded; sprawdź czy channel jest nadal aktywnym VIP ticketem. Podejmij pierwszą odpowiedź <3 sek. Wstaw followup/ephemeral state + retry. Ogranicz częstotliwość i duplikaty kliknięć.
6. Użyj Price IDs z serwerowej allowlisty i zapisuj tworzony checkout_intent związany z Discord buyer ID + guild/channel ID. Stripe Checkout tworzyć dopiero po implementacji provider adaptera i po otrzymaniu oficjalnych kluczy testowych; nie używać klientem podanych kwot/price IDs. Istniejący backend `src/payments/mock.ts` nie przyjmuje produkcyjnych płatności.
7. Sandbox Stripe: `/vip-buy` / button => checkout.session dla monthly mode=subscription €40/month, lifetime mode=payment €100; karta i PayPal jako metoda przez Stripe gdy dostępna/zaakceptowana. Rzeczywisty Stripe Payment Link ani screenshot 'Paid' NIE potwierdzają zakupu.
8. Webhook: verify raw body and Stripe-Signature via official SDK, track session/customer/price, invoice.paid/payment status, exact amount and currency. Use durable deduplicated event ledger / DB locks. Handle initial invoice, renewals, cancellations, failed invoice, refunds/chargeback, lifetime upgrade. Rola VIP przyznawana tylko po confirmed paid entitlement and separate approved Discord VIP-write scope, never alter Free Member, Owner, Staff.
9. Discord ticket messaging: posted after verified invoice/payment and role confirmation (or clear 'payment verified, role pending'); no financial personal info. No automatic forced closure while payment is pending.

## Obowiązkowe testy (bez produkcji)

- `npm run typecheck`, `npm run build`, `npm run lint`, `npm run test:unit`; integration tests with disposable PostgreSQL only.
- Exact VIP category passes, Support never triggers, missing bot visibility fails safely, user identity not inferred, signatures reject spoofing, default feature disabled, crash/replay idempotent.
- Stripe payment sessions absent until intentionally clicked, no paid role without valid paid webhook, `checkout.session.completed` alone does not grant subscription role, duplicate invoice does not extend twice, wrong Price ID fails, PayPal recurring absence handled as method unavailable.
- Free Member production branch behavior and Discord bot gateway remain unaffected. All payment / VIP sync production flags default OFF.

## Deploy rules

NO CHANGES to live Hostinger env, live Stripe, live Discord channels, real Supabase DB, or Ticket Tool panel from this coding task. Existing bot still assigns Free Member. Do not merge/deploy automatically. Publish resulting SHA, changed files, tests and migration plan. Owner must complete Stripe KYC and obtain Stripe's approval for real Cronus Zen/XIM Matrix digital products and subscription billing before real payments.

## Remaining owner verification

Open one ticket via Ticket Tool `VIP Purchase`, inspect its Discord parent category = `1558892807786209360`. Ensure TimonConfigs VIP Bot can see it. Current code on this branch only *observes*, and even that requires migration 004 + approved feature flag — this work must be completed and tested before any automatic sale.