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
