# TimonConfigs — VIP Monthly / VIP Lifetime + rzeczywiste płatności

Status: **plan implementacyjny, nie gotowa produkcyjna integracja**. Prace wymagają wskazania operatora płatności i potwierdzenia, że operator akceptuje rzeczywistą ofertę Cronus Zen/XIM Matrix i płatności cykliczne. Nie wolno włączyć flag produkcyjnych bez testów, potwierdzenia właściciela i akceptacji operatora.

## Ustalone produkty w repo

Z `config/plans.json`:
- `VIP_MONTHLY_AUTO`: €40/miesiąc, automatyczne odnowienie, rola VIP Monthly
- `VIP_LIFETIME`: €100 jednorazowo, rola VIP Lifetime, zakres i czas świadczenia wg opublikowanej licencji
- `VIP_MONTHLY_ONCE`: €40 jednorazowo na jeden miesiąc, rola VIP Monthly; trzeci produkt opcjonalny w UI

## Ustalony stan backendu

- `src/payments/types.ts` i `src/payments/mock.ts`: **wyłącznie `provider: 'mock'`**. Nigdy nie traktować ich jako zweryfikowanych zdarzeń realnego operatora.
- `src/membership/service.ts`: `createOrder`, `createSubscription`, `processVerifiedEvent` wymagają mocka i są odrzucane w produkcji przez `assertMockAllowed`.
- `src/config.ts`: `PAYMENT_PROVIDER` przyjmuje tylko `mock`, `PAYMENTS_ENABLED=true` albo `PROVIDER_APPROVAL_CONFIRMED=true` rzuca błąd. Nie przełączać flag bez nowego, przetestowanego adaptera.
- Produkcyjne `DISCORD_VIP_SYNC_ENABLED=true` i `DISCORD_PRODUCTION_VIP_WRITES_ENABLED=true` są obecnie zabronione przez `src/discord/config.ts`. Zmiana wymaga osobnego bezpieczeństwa i zatwierdzenia.
- Produkcyjny Free Member jest już aktywny. Nie ruszać jego flag, roli, hierarchii, Gateway ani Supabase w trakcie developmentu płatności.

## Implementacja po wybraniu operatora i jego akceptacji

1. Provider API: konkretny sandbox + checkout hosted i ewentualny system recurring billing. NIGDY nie przyjmować numerów kart w WordPress/Node.
2. Własne powiązanie zamówienia z zalogowanym `app_users.id`, nie ufać `userId` z webhooka ani parametrom redirect. Ceny i waluta ustalane wyłącznie po stronie serwera.
3. Webhook: surowe body + HMAC/Ed25519 lub weryfikacja po API dostawcy **zgodnie z oficjalną dokumentacją konkretnego operatora**; ochrony replay, duplicate, reorder, event ID, merchant ID, amount, currency, order ID, product ID, user ID.
4. Migracje PostgreSQL 004+: adapter/provider identyfikatory zamówień, zapis płatności i webhooków, stany subscription/chargeback; kompatybilne ze starymi tabelami i danymi. Żadnych fikcyjnych uprawnień produkcyjnych.
5. Funkcja `processVerifiedEvent`: dopuszcza *wyłącznie* bezpiecznie zweryfikowane, wewnętrzne zdarzenia operatora; transakcyjna idempotencja, odnowienia, wygaśnięcia, anulowania, zwroty i dispute. Redirect success **nigdy** nie przydziela VIP.
6. WordPress `timonconfigs.com`: integracja konta (serwerowy OAuth Discord, bez haseł Discorda), checkout + Customer Portal, status VIP i daty, anulowanie Auto-Renew, historia transakcji; zewnętrzny backend Node jako źródło prawdy.
7. Synchronizacja VIP Discord: osobna produkcyjna bramka zgody na role VIP, poprawne pending=false, tylko dwie role VIP, Founder/Staff/Owner nietykalne, własność ról, brak zbiorowego przejmowania ręcznie nadanych VIP; Free Member pozostaje niezależna.
8. Testy: jednostkowe, PostgreSQL integration, wszystkie scenariusze webhooków, source spoofing, double renewals, przerwane płatności, concurrent workers, refund/chargeback, upgrade Monthly -> Lifetime, aktywne Auto-Renew -> Lifetime, cancellation effective paid-through; potem sandbox E2E z kontami kontrolowanymi.
9. Operator: pisemne potwierdzenie dokładnej oferty i okresowych obciążeń, onboarding merchant, regulamin, Lifetime terms, odstąpienie/zwroty, VAT i GDPR. Nigdy nie ukrywać rodzaju skryptów przed dostawcą płatności.
10. Produkcja: po ukończeniu audytu, testów, backup/rollback i zatwierdzeniu operatora, osobno zatwierdzić przełączenie payments oraz VIP role writes. Nie obejmować tych zgód zgodą na Free Member.

## Bezpieczne domyślne zmienne do czasu produkcyjnej akceptacji
```dotenv
PAYMENT_PROVIDER=mock
PAYMENTS_ENABLED=false
PROVIDER_APPROVAL_CONFIRMED=false
DISCORD_VIP_SYNC_ENABLED=false
DISCORD_PRODUCTION_VIP_WRITES_ENABLED=false
```
Aktywnych flag Free Member nie zmieniać.

## Decyzja potrzebna przed wyborem adaptera

Jaki operator płatności będzie obsługiwał rzeczywiste transakcje (€40 miesięcznie auto-renew + €100 lifetime) i czy istnieje pisemne potwierdzenie jego zgody na katalog Cronus/XIM? HotPay może mieć funkcje płatności jednorazowych; nie zakładać, że konkretny typ konta/produktu wspiera automatyczny recurring. Stripe ma rozbudowane API subskrypcji, lecz również weryfikuje kategorie i zastrzega możliwość odrzucenia. Decyzję i dokumentację API potwierdzić przed implementacją.

## Wybrana bramka: Stripe Checkout + Stripe Billing + PayPal w Stripe

**Decyzja właściciela z 11.10.2026:** preferowane Stripe Billing wraz z metodą płatności PayPal, bez osobnego adaptera PayPal. Konto Stripe prawdopodobnie z Polski, ale faktyczny kraj i status firmy należy zweryfikować podczas onboardingu. PayPal through Stripe jest dostępny dla kont Stripe w Polsce; miesięczny recurring PayPal może wymagać akceptacji/aktywacji po stronie Stripe i PayPal.

Źródła:
- https://docs.stripe.com/payments/paypal — PL na liście, Subscriptions wspierane, recurring czasami wymaga approval.
- https://docs.stripe.com/payments/paypal/activate — połączenie PayPal w Stripe Dashboard, settlement mode, status pending.
- https://docs.stripe.com/payments/paypal/set-up-future-payments — reusable authorization / recurring.
- https://stripe.com/legal/restricted-businesses — eligibility dla konkretnych produktów musi zostać rozpatrzona przez Stripe; PayPal ma własną AUP.
- https://docs.stripe.com/billing/subscriptions/overview — model recurring.

### UX i plan Stripe

1. **VIP Monthly Auto-Renew: €40 / miesiąc** — `Stripe Checkout Session(mode='subscription')` i Stripe Price recurring EUR 4000 minor, interval month=1. Do not invent direct PayPal billing permissions: show PayPal in Checkout only if Stripe account/method status permits subscription mode. Alternative card payment can be used only if the catalog is approved.
2. **VIP Lifetime: €100 jednorazowo** — `Checkout Session(mode='payment')`, one-time EUR 10000 minor. Terms must explicitly define the serviced lifetime, included updates, refund/cancellation, scope.
3. **VIP Monthly Once: €40 jednorazowo** — optional `mode='payment'` with one calendar month entitlement; not automatically renewed.
4. User signs into TimonConfigs portal, links Discord OAuth to own app user ID (do not store Discord passwords), selects product. Backend creates Checkout Session for allowlisted Stripe Price ID. WordPress redirects to hosted Checkout. **No unauthenticated public endpoint to mint purchase sessions for arbitrary accounts.**
5. After payment, Stripe sends signed webhook to Node backend `/api/payments/stripe/webhook` using raw request body. WordPress success redirect is informational only and MUST NOT unlock VIP.
6. Durable verified Stripe event -> entitlement -> Discord synchronization queue. For recurring monthly access **paid subscription invoice** is authoritative, not mere subscription creation; never double-count the first invoice because checkout and invoice may both produce events.
7. Customer Portal hosted in Stripe for cancellation/confirmation, returning to timonconfigs.com.
8. User VIP role after successful paid entitlement, accurate expiry date, refund/dispute reversal, cancellation effective at paid-through. Free Member role stays untouched.

### Data boundaries, migration and approvals

- Existing DB `payment_events`, `orders`, `payments`, `billing_subscriptions` use provider='mock' and the service rejects mock in production. Extend with **versioned additive migration** for Stripe, with unique indexes on Stripe event IDs, checkout session/order IDs, invoice IDs, payment intent IDs, subscription/customer IDs; safe idempotent reconciliation.
- Create dedicated Stripe verification/normalization adapter; use official Stripe server SDK and signature verification `stripe.webhooks.constructEvent(rawBody, signature, endpointSecret)`; enforce real merchant account/environment and server-side price/product/customer/amount/currency checks, reject spoofed metadata or mismatched checkout sessions.
- Events: `checkout.session.completed` (mapping, not automatic entitlement for monthly), `checkout.session.async_payment_succeeded` if supported async flow, `invoice.paid` (verify actual paid transaction; exclude out-of-band/zero without explicit approved policy), `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`, `charge.refunded`, and dispute events. Use Stripe canonical docs of API version in code review; snapshot API event payload changes across versions.
- Fail closed for Stripe webhook signature errors and stale or invalid event schema; make callback idempotent and race-safe. A refund or dispute reverses only corresponding entitlements; keep separate invoice/payment mapping, prevent duplicate renewals.
- Existing production `DISCORD_VIP_SYNC_ENABLED=true` is forbidden: requires **separate owner approval and code review** to allow VIP Monthly/Lifetime grants/removals while still protecting Founder, Staff and Free Member, with role ownership ledger and current Rules Screening. Use feature-flag and staged rollout (sandbox before production).
- **Do not enable real payment checkout without confirming Stripe and PayPal acceptance of the precise TimonConfigs Cronus Zen/XIM Matrix scripts/configurations and any recurring access.** Never use misleading product descriptions to circumvent review. Do not assume Stripe accepts unregistered economic activity (działalność nierejestrowana) in Poland; verify account type/KYC and legal/tax responsibilities with Stripe or adviser.
- Stripe test mode does not imply PayPal method can be tested until PayPal integration is enabled; use configured Stripe test methods and account-specific availability. Merchant must connect PayPal in https://dashboard.stripe.com/settings/payment_methods and check recurring approval there. Do not request API keys in public chat; secrets stored only in Hostinger protected env.

### Production readiness gates

- [ ] Stripe account onboarding/KYC and written acceptance of real product catalog (including PayPal acceptance when relevant)
- [ ] Verified Stripe PayPal recurring status (subscription payments, not just one-time)
- [ ] Dedicated `sk_test`, webhook test signing secret, Stripe Price IDs from verified Dashboard (stored in env), verified HTTPS callback
- [ ] End-to-end sandbox tests including same invoice twice, reordering, retries, webhook failure, renewal, cancellation, dispute, refund, upgrade to lifetime and role reconciliation
- [ ] Reviewed terms, auto-renew disclosure, Lifetime terms, GDPR and tax/invoicing
- [ ] Separate production Stripe and Discord VIP-write approvals, backups, monitored rollout and tested rollback

