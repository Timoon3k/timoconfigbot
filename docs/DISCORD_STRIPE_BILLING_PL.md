# Stripe Billing przez Discord — implementacja i wdrożenie

Gałąź: `feature/discord-stripe-billing`, baza: `feature/vip-ticket-permissions`
(`52f7e26008f8417a910b68c3d51b8121fb19c8fc`). Kod przygotowany; niczego nie
wdrożono ani nie połączono z produkcyjnymi Discord, Supabase lub Stripe.

## Działające komponenty

- Istniejące przyciski Ticket Tool → podpisana tożsamość Discord → aktualne
  sprawdzenie prywatnego ticketa VIP Orders i człowieka z `pending=false`.
  Support, obcy panel, boty i użytkownicy bez dostępu są odrzucani.
- Odpowiedź początkowa jest ephemeral/deferred; trwała kolejka edytuje wyłącznie
  prywatną odpowiedź oryginalnej interakcji. Token jest szyfrowany AES-GCM,
  ważny maksymalnie 14 minut i usuwany po wykonaniu/wygaśnięciu. Brak DM.
- Osobny principal Discord i Customer Stripe, bez fikcyjnych kont WWW.
  EN disclosure i potwierdzenie warunków poprzedzają Checkout; serwer ustala
  Price ID, ilość 1, EUR, EUR 40 miesięcznie albo EUR 100 jednorazowo.
- Oficjalny SDK `stripe@23.0.0`, API `2026-09-30.endive`, podpisy webhooków
  z surowych bajtów, zgodność konta/trybu, deduplikacja i transakcje.
  Sesja/przekierowanie nie wystarczają do nadania dostępu. Monthly wymaga
  prawdziwego PaymentIntent, obciążenia i faktury; okres pochodzi z Stripe UTC.
- Osobny zapis każdego zakupu/opłaconej faktury. Zwrot, także częściowy,
  zawiesza wyłącznie ten zapis. Otwarty/przegrany spór zawiesza go; wygrany
  przywraca, jeśli nie ma zwrotu. Inny zakup zachowuje ważność.
- Renewal tylko po rzeczywistej zapłacie; błędy i faktury oznaczone ręcznie
  jako opłacone nie przedłużają dostępu. Anulowanie zachowuje opłacony okres.
  Lifetime ma pierwszeństwo i brak stałej daty końcowej.
- Upgrade wymaga osobnego potwierdzenia zatrzymania Monthly renewal przed
  Lifetime Checkout. Opuszczenie Checkout nie wznawia anulowanej subskrypcji.
- Customer Portal wybiera Customer z powiązania kupującego; konfiguracja musi
  anulować na końcu okresu i wyłączać zmiany planów.
- Kolejka odzyskuje osieroconą sesję po restarcie również po wygaśnięciu tokena
  Discord. Odzyskiwanie tylko odczytuje kanoniczne Stripe; nie tworzy nowych
  obciążeń. Faktury odzyskane w ten sposób mają źródło
  `canonical_reconciliation`, osobne od `signed_webhook`.
- Oddzielna polityka VIP: tylko skonfigurowane Monthly/Lifetime, osobna zgoda,
  wyłącznie 1–2 konta canary. Founder, Staff i Free Member chronione. Usuwanie
  tylko ról z potwierdzoną własnością bota. Niejednoznaczny zapis wymaga przeglądu;
  nie jest powtarzany ani automatycznie uznawany za własność.
- Worker sprawdza ważność/rejoin co około minutę na principal; Stripe działa
  jako pojedyncze zadanie w tle i nie blokuje heartbeat ani pętli Free Member.
  `/membership` i `/sync-status` pokazują osobno zweryfikowaną płatność i sync.

Testy używają mocków wszystkich wywołań API Stripe/Discord oraz autentycznych
podpisów testowych SDK. Nie wykonano próby z rzeczywistym kontem Stripe.
Wymagane są wdrożenie, konfiguracja konta i odbiór operatora/właściciela.

## Stripe Dashboard — najpierw Sandbox

1. Otwórz właściwe konto → przełącz na **Sandbox/Test mode**. Zanotuj jego
   prawdziwe `acct_…` w `STRIPE_ACCOUNT_ID`. Test/live mają osobne identyfikatory.
2. **Product catalog → Add product**: nazwa **TimonConfigs VIP Monthly**,
   prawdziwy opis dostępu do cyfrowych produktów/usługi. Cena **EUR 40.00**,
   **Recurring → Every month**, ilość 1, bez trial, kuponów, zmian/proracji planu.
   Skopiuj utworzone `price_…` do `STRIPE_VIP_MONTHLY_PRICE_ID`.
3. Dodaj **TimonConfigs VIP Lifetime**, **EUR 100.00 → One-time**; opisz dostęp
   na okres istnienia usługi objętej licencją. Skopiuj jego `price_…` do
   `STRIPE_VIP_LIFETIME_PRICE_ID`. Nie używaj `prod_…` zamiast Price ID.
4. Sprawdź walutę, całkowite kwoty i rozliczenie podatków. Ta implementacja
   nie dodaje podatków automatycznie ani nie obsługuje zmiennej sumy Checkout.
   Nie archiwizuj Price aktywnych subskrypcji bez planu migracji.
5. **Settings → Business → Public details**: ustaw publiczne angielskie
   Terms of Service i Privacy Policy. **Settings → Payments → Checkout**:
   upewnij się, że wymagane zaakceptowanie Terms działa. Backend wymaga też
   publicznej polityki zwrotów/odstąpienia i Lifetime terms oraz ich wersji.
6. **Settings → Billing → Customer portal → Create configuration**: cancellation
   **At end of billing period**, zmiany subskrypcji/planów wyłączone; aktualizacja
   metody płatności może być włączona. Zapisz `bpc_…` jako
   `STRIPE_PORTAL_CONFIGURATION_ID`. Nie używaj publicznego ogólnego linku Portal.
7. **Developers/Workbench → Webhooks/Event destinations → Add destination**:
   wybierz zdarzenia **Your account**, endpoint
   `PUBLIC_BILLING_BASE_URL/api/payments/stripe/webhook`, API version
   **2026-09-30.endive**. Wybierz:

   ```text
   checkout.session.completed
   checkout.session.async_payment_succeeded
   checkout.session.async_payment_failed
   checkout.session.expired
   invoice.paid
   invoice.payment_succeeded
   invoice.payment_failed
   customer.subscription.created
   customer.subscription.updated
   customer.subscription.deleted
   charge.refunded
   refund.created
   refund.updated
   charge.dispute.created
   charge.dispute.updated
   charge.dispute.closed
   ```

8. Sekret **tego endpointu** zapisz jako `STRIPE_WEBHOOK_SECRET`; klucz Sandbox
   z **Developers → API keys** jako `STRIPE_SECRET_KEY`. Nie zapisuj w Git ani
   nie publikuj w Discordzie/logach. Nie zastępuj go sekretem Stripe CLI.
9. **Settings → Payments → Payment methods**: PayPal pozostaje wyłączony w
   aplikacji. Dopiero po faktycznej dostępności i akceptacji Stripe dla tego
   konta, EUR i odpowiedniego typu płatności włącz go w Dashboard i ustaw
   osobną zgodę w aplikacji. Backend nie wymusza `payment_method_types`;
   metody kwalifikuje Stripe.

Przed live wymagane są KYC, akceptacja prawdziwego katalogu/business model
(w tym Cronus Zen/XIM Matrix, jeśli są oferowane), recurring/PayPal eligibility
oraz zatwierdzone warunki konsumenckie, podatkowe i Lifetime. Nie zmieniaj
opisu produktów w celu obchodzenia zasad operatora. Nie wymyślaj Price IDs.

## Nazwy nowych zmiennych Hostinger

Pełne domyślne wartości są w `.env.example`. Dodaj nowe pola w istniejącym
zarządzanym środowisku aplikacji; **nie zastępuj nim istniejącego środowiska**.

| Grupa | Nazwy |
| --- | --- |
| Tryb/blokady | `STRIPE_MODE`, `STRIPE_CHECKOUT_ENABLED`, `STRIPE_WEBHOOKS_ENABLED`, `STRIPE_PORTAL_ENABLED`, `STRIPE_LIVE_PAYMENTS_ENABLED`, `STRIPE_MERCHANT_APPROVAL_REFERENCE` |
| Konto/sekrety | `STRIPE_ACCOUNT_ID`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |
| Katalog/Portal | `STRIPE_VIP_MONTHLY_PRICE_ID`, `STRIPE_VIP_LIFETIME_PRICE_ID`, `STRIPE_PORTAL_CONFIGURATION_ID` |
| PayPal | `STRIPE_PAYPAL_ENABLED`, `STRIPE_PAYPAL_APPROVAL_REFERENCE` |
| Publiczne HTTPS | `PUBLIC_BILLING_BASE_URL`, `BILLING_ALLOWED_ORIGINS` |
| Prawo/licencja | `BILLING_TERMS_URL`, `BILLING_PRIVACY_URL`, `BILLING_REFUND_POLICY_URL`, `BILLING_LIFETIME_TERMS_URL`, `BILLING_LEGAL_REVISION` |
| Osobny VIP canary | `DISCORD_BILLING_VIP_WRITES_ENABLED`, `DISCORD_BILLING_VIP_APPROVAL_REFERENCE`, `DISCORD_BILLING_VIP_CANARY_IDS` |

`PUBLIC_BILLING_BASE_URL` to zatwierdzony origin HTTPS istniejącego backendu,
bez ścieżki/query. Allowlista obejmuje origin backendu oraz origin każdego
legal URL (oddzielone przecinkami). Endpointy `/billing/return` i `/billing/cancel`
mają neutralną odpowiedź bez cache; nie nadają VIP. WordPress nie uczestniczy.

Pozostają istniejące sekrety `SESSION_PEPPER` (także szyfrowanie kolejki),
`PASSWORD_PEPPER`, `DATABASE_URL`, `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_SECRET`
i konfiguracja TLS/Discord. Nie rotuj `SESSION_PEPPER` z aktywnymi szyfrowanymi
zadaniami bez zaplanowanego opróżnienia kolejki. Nie wyświetlaj sekretów.

## Kolejność bezpiecznego wdrożenia — do wykonania po zatwierdzeniu

1. Zanotuj aktualnie działający SHA i zachowaj bezpiecznie konfigurację.
   Zachowaj **wszystkie** istniejące flagi/ID Free Member, Gateway i Ticket Tool.
   `DISCORD_VIP_SYNC_ENABLED=false` i `DISCORD_PRODUCTION_VIP_WRITES_ENABLED=false`
   pozostają w produkcji. Nie zmieniaj OAuth, paneli Ticket Tool ani WordPress.
2. Wybierz zreviewowany SHA nowej gałęzi w istniejącym procesie wdrażania.
   Node.js 22. Nie zastępuj zarządzanego entrypointu `dist/hostinger.js`.

   ```bash
   npm ci
   npm run typecheck
   npm run build
   npm run lint
   npm run test:unit
   ```

3. Przy wszystkich nowych flagach OFF, wykonaj **po swojej zgodzie**:

   ```bash
   npm run db:migrate:built
   ```

   Runner stosuje brakujące migracje 001–006; nowa to
   `006_discord_stripe_billing.up.sql`. 001–005 nie zmieniono. Wymagany direct
   lub session pool z weryfikowanym TLS. Nowe tabele mają RLS bez polityk dla
   przeglądarki; dostęp ma tylko zaufana backendowa rola DB będąca właścicielem
   tabel lub prawidłowo skonfigurowana przez administratora. Żadnej bazy
   produkcyjnej nie wolno używać jako `TEST_DATABASE_URL`.
4. Restart istniejącej aplikacji. Potwierdź `/ready` i dotychczasowe Free Member.
   W razie braku migracji/konfiguracji cofnij kod; nie włączaj płatności.
5. Po skonfigurowaniu Sandbox i publicznych warunków ustaw `STRIPE_MODE=test`,
   `STRIPE_WEBHOOKS_ENABLED=true`, `STRIPE_CHECKOUT_ENABLED=true`,
   `STRIPE_PORTAL_ENABLED=true`. Live payments i nowe VIP writes nadal OFF.
   Dotychczasowe ticket observation/welcome/selections wymagają własnego
   zatwierdzonego wdrożenia z poprzedniej fazy; nie zastępuj panelu Ticket Tool.
6. Wykonaj odbiór testowy poniżej. Sandbox na produkcyjnym guild **nie nadaje
   ról VIP**, nawet po próbie włączenia VIP gate. Rzeczywiste testowe zapisy VIP
   wymagają osobno zatwierdzonego test guild i 1–2 kont canary.

## Odbiór i aktywacja produkcyjna

- [ ] Konto A: nowy prywatny VIP ticket, poprawny panel bota, `pending=false`.
  Monthly → angielskie warunki → potwierdzenie → prywatny link; bez konta WWW.
- [ ] Konto B: inny ticket, nie widzi ticketa/linku A; nie może potwierdzić
  zamówienia A ani otworzyć jego Portal. Support i boty nie uruchamiają zakupów.
- [ ] Dwuklik/replay/restart nie tworzą kolejnego Customer, Checkout ani okresu.
- [ ] Testowa zapłata: dopiero zweryfikowana faktura/PI/charge zapisują dostęp;
  status roli jest osobny. Ręcznie oznaczona faktura i redirect nie wystarczają.
- [ ] Udane odnowienie, błędne odnowienie, Portal cancellation, wygaśnięcie.
- [ ] Upgrade jawnie zatrzymuje przyszły Monthly renewal; Lifetime bez daty
  końca; zwrot jednej faktury nie odbiera innego opłaconego świadczenia.
- [ ] Refund/dispute, zdarzenie przed checkout, utrata odpowiedzi i restart.
- [ ] W osobnym test guild: hierarchia/Manage Roles bez Administrator; canary,
  screening, rejoin, znane/nieznane wyniki zapisu i ręczne role chronione.
- [ ] Free Member działa nadal; brak zmian Founder/Staff/Free Member i Support.
- [ ] Właściciel zaakceptował kod, legalne warunki, księgowość i zgody Stripe.
- [ ] Dopiero potem osobno ustaw prawdziwe LIVE konto, klucz, Price IDs,
  Portal configuration i LIVE webhook secret; `STRIPE_MODE=live`,
  `STRIPE_LIVE_PAYMENTS_ENABLED=true` i rzeczywisty numer/odnośnik zgody
  w `STRIPE_MERCHANT_APPROVAL_REFERENCE`. Nie mieszaj test/live.
- [ ] Osobna zgoda na VIP: `DISCORD_BILLING_VIP_APPROVAL_REFERENCE` różna od
  zgód Free Member/network/ticket, `DISCORD_BILLING_VIP_CANARY_IDS` dokładnie
  1–2 zatwierdzone ID. Dopiero ręcznie `DISCORD_BILLING_VIP_WRITES_ENABLED=true`.
  Ta wersja nie umożliwia rollout all-member; wymaga nowego przeglądu i zgody.

## Monitoring i rollback

Sprawdzaj `stripe_webhook_events.status/last_error_code`,
`stripe_discord_interactions.state/last_error_code`,
`stripe_vip_sync_state.outcome/error_code`, `discord_role_operations`,
`stripe_verified_payments` i audyty `STRIPE_*`. Błędy podpisu/trybu/API version
nie trafiają do kolejki. Błąd trwałego zapisu daje 503, żeby Stripe ponowił.
Po 25 próbach zdarzenie wymaga przeglądu; kod błędu nie zawiera sekretów.
Po naprawie przyczyny operator może na podstawie konkretnego event ID
ustawić `status='queued',available_at=now(),attempt_count=0`; nie zmieniać
payloadów, powiązań ani zweryfikowanych kwot w celu wymuszenia VIP.

`STRIPE_ROLE_OPERATION_UNCERTAIN` wymaga ręcznego porównania audytu i aktualnego
stanu Discord; nie resetować masowo journal/ownership ani adoptować ról
ręcznych. Sama obecność roli po timeout nie potwierdza jej własności.
Niejednoznaczny Customer/Checkout po 23 godzinach wymaga ręcznego sprawdzenia,
nie automatycznej nowej płatności. Zasady refund/withdrawal powinny jawnie
opisywać zawieszenie świadczenia przypisanego do częściowo zwróconego zakupu.

Awaryjnie wyłącz **tylko** `STRIPE_CHECKOUT_ENABLED` i
`DISCORD_BILLING_VIP_WRITES_ENABLED`, a w razie potrzeby `STRIPE_PORTAL_ENABLED`;
restart/drain aplikacji. Nie zmieniaj Free Member ani Ticket Tool. Istniejące
linki Checkout mogą być nadal ważne; właściciel musi wygasić konkretne otwarte
sesje w Stripe, jeśli także te płatności mają być zatrzymane. Subskrypcji nie
anuluj masowo. Jeżeli istnieją płatności live, zachowaj przyjmowanie webhooków
i ich przetwarzanie z prawidłowymi live approvals, żeby nie zgubić zwrotów i
odnowień. Wyłączenie Checkout nie wyłącza renewal wykonywanego przez Stripe.

Cofnięcie kodu: wróć do zanotowanego poprzedniego SHA, zachowaj schemat 006,
księgę i audyt; zapewnij osobne ciągłe przyjmowanie zdarzeń, jeśli stary kod
nie ma endpointu Stripe. Nie wykonuj `db:rollback`: 006.down celowo odmawia
usuwania dowodów finansowych/ról. Nie usuwaj automatycznie wiadomości/ról.

## Pliki i walidacja

Nowe moduły: `src/billing/{config,secrets,stripe,service,interactions,roles,http}.ts`.
Podłączenie: istniejące runtime, commands, HTTP, worker/CLI i przekazanie workera
w `hostinger.ts`; wspólna walidacja kupującego w `tickets/service.ts`, neutralny
tekst nowego welcome w `tickets/rest.ts`. Konfiguracja: `.env.example`, oficjalny
SDK w `package.json`/lock; migracja 006. Testy: `tests/stripe-fixture.ts`, nowe
unit/integration Stripe oraz małe poprawki starych fixture/założeń migracji.

Wykonano 11.10.2026: `npm run typecheck`, `npm run build`, `npm run lint`
— kod wyjścia 0. `npm run test:unit`: **147/147**, 9 plików.
`npm run test:legacy`: **6/6**. Pełne `npm run test:integration`:
**138 zaliczonych, 1 pominięty**, 6 plików; w tym **42/42 Stripe**, **24/24
Discord completion/Free Member** i **18/18 ticketów**. Opcjonalny test
wczytywania certyfikatu TLS pominięto, bo nie podano `TEST_DB_CA_CERT_FILE`;
nie sprawdzano produkcyjnego TLS/Supabase.

Wszystkie migracje 001–006 zastosowano na nowej bazie `stripe_billing_test`
w lokalnym kontenerze PostgreSQL 16, port 127.0.0.1:55436. Testy uruchamiano
z wyczyszczonym środowiskiem i jawnym lokalnym `TEST_DATABASE_URL`.
Sprawdzono ponowne stosowanie migracji, rollback transakcji, wyścigi,
osierocony Checkout, rejoin i odzyskanie potwierdzonego journal po błędzie DB.
Naprawiono znalezione problemy nowej implementacji: nieaktualny Customer przy
upgrade, odzyskanie ukończonej sesji po utracie odpowiedzi i niepewne własności
ról. Starsze testy dostosowano do nieodwracalnej migracji finansowej i porównania
liczby zamówień przed/po wyborze zamiast założenia pustej całej bazy.
