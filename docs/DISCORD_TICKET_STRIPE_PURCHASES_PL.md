# TimonConfigs — Discord Ticket → Stripe Checkout → VIP role (bez WordPress)

## Cel i bieżący status
Właściciel chce najpierw zautomatyzować zakup członkostwa WYŁĄCZNIE w Discord: Open Ticket → wybór pakietu → Stripe Checkout z PayPal (gdy Stripe udostępni tę metodę dla danego trybu) → webhook → Supabase entitlement → rola VIP Monthly lub VIP Lifetime. Strona timonconfigs.com zostanie zintegrowana później. Działające Free Member po Rules Screening musi pozostać bez zmian.
Dokument dotyczy architektury; implementacja płatności i ticketów NIE JEST JESZCZE GOTOWA ani aktywowana.

## Ważna decyzja do potwierdzenia
Czy istniejący przycisk Open Ticket jest obsługiwany przez zewnętrznego bota **Ticket Tool**, czy przez inną aplikację? Nie zakładać, że Ticket Tool automatycznie publikuje event/callback dla TimonConfigs. Dwie bezpieczne opcje:

**A. Zachować Ticket Tool (preferowany minimalny zakres):** Ticket Tool tworzy/zarządza kanałem ticketa; w jego wiadomości startowej podać instrukcję `/vip-buy`. TimonConfigs obsługuje podpisaną komendę `/vip-buy` i prywatną wiadomość wyboru planu. Uwierzytelnić Discord user ID z interakcji, guild ID i channel ID, weryfikować kanał/kategorię przez Discord REST (zamiast ufać nazwie kanału lub treści wiadomości). Jeśli Ticket Tool ma potwierdzoną bezpieczną integrację uruchomieniową, można później wysyłać karty automatycznie na starcie ticketa. Nie ufać user ID w tekstach z Ticket Tool jako źródłu autoryzacji.
**B. Własne tickety TimonConfigs:** oddzielny panel z przyciskiem Open Ticket, tworzenie prywatnych ticket channels przez bota, dynamiczny wybór VIP, zamknięcie, audit i permissions, konieczne rozszerzenie uprawnień o Manage Channels/Send Messages, test konfliktów z Ticket Tool. Nie implementować samodzielnie bez zgody właściciela.

## Proces biznesowy
1. Użytkownik kończy Rules Screening; rola Free Member jest nadana przez działający worker (nie zmieniać).
2. Otwiera ticket albo wywołuje `/vip-buy` w autoryzowanym kanale ticketa.
3. Otrzymuje prywatną wiadomość Discord z wyborem VIP Monthly €40/mies. lub VIP Lifetime €100 jednorazowo. Tekst po EN wyjaśnia auto-renew/cancellation/refund, warunki usługi, dostawę cyfrową; brak fałszywych obietnic Lifetime.
4. Po wyborze backend tworzy nowy rekord checkout_intent w Supabase z immutable buyer_discord_id, guild_id, ticket_channel_id, server-side product_code, amount_minor, EUR, idempotency key, expiry. User ID z interaction, a NIE z podanego linku/metadanych/formularza.
5. Backend tworzy Stripe Checkout Session: `mode=subscription` dla VIP Monthly i `mode=payment` dla Lifetime, z serwerowym allowlisted Stripe Price ID, Stripe Customer powiązanym z jednym Discord ID. Link jest efemeryczny dla kupującego lub w prywatnym tickecie. Nie umożliwia zmiany pakietu/ceny w URL.
6. Klient dokonuje płatności wyłącznie na stronie Stripe, metodą dostępną dla sklepu: karta lub PayPal, jeśli Stripe rzeczywiście udostępnia metodę także dla abonamentu.
7. Weryfikowany podpisem Stripe webhook trafia na backend Hostinger. Prawdziwa płatność lub opłacona faktura wyzwala entitlement; `checkout.session.completed` samo w sobie NIE jest dowodem opłaty abonamentu. Weryfikacja customer, checkout, invoice, subscription, amount, currency, product, merchant account, payment status, correct environment; idempotent handling, unique events/invoices.
8. Discord Sync przyznaje właściwą VIP rolę WYŁĄCZNIE po płatności i sprawdzeniu pending=false, chroni Owner/Staff/Founder/Free Member, unika podwójnych operacji. Jeżeli klient nie jest na serwerze lub nie zakończył screening, zachowuje uprawnienie w DB i synchronizuje po legalnym wejściu.
9. Bot publikuje w tickecie status `Payment confirmed. VIP ... activated.` (tylko po potwierdzonej roli lub oddzielnie `Payment confirmed, role pending`). Błąd payment/role prowadzi do bezpiecznego retry i komunikatu kontaktowego; NIE usuwać uprawnień klienta z powodu chwilowej niedostępności Discord.
10. Monthly: Stripe Billing wznawia płatność; opłacona nowa faktura wydłuża membership. Nieudane odnowienie nie przedłuża bez płatności. Anulowanie zachowuje dostęp do końca opłaconego okresu. Lifetime nie ma cyklicznych opłat. Refund/chargeback cofa odpowiednią płatność/uprawnienie zgodnie z polityką.
11. Samo kliknięcie sukcesu po checkout, screen przelewu, wiadomość w tickecie lub ręczna zmiana roli nie nadają uprawnienia do członkostwa.

## Techniczne wymagania: brak strony WordPress w fazie 1
- Stripe Checkout hosted; sukces/anulowanie kierują do prostych stron potwierdzenia na HTTPS Hostinger (`/billing/return?session_id={CHECKOUT_SESSION_ID}` lub analog), bez żadnego przyznawania VIP z tego endpointu; nie potrzeba WordPress. Nie hardcodować obecnej losowej domeny jako docelowej w kodzie. Publiczna domena HTTPS i webhook endpoint są wymagane.
- Aplikacja Discord ma obecnie tylko Member Gateway i podpisane interaction endpoint dla komend read-only. Rozszerzenie `/vip-buy` i button components wymaga edycji parsera typ=3, signature check i osobnego allowlisted writes do Discord (np. deferred responses/followups), limitu 3 s na initial interaction, idempotency click i expiry.
- Rejestracja nowych komend musi zachować `/membership`, `/sync-status`, `/help` i nie może nadpisać istniejącego zestawu. Podczas pracy uwzględnić niezależną gałąź `feature/production-readonly-commands` i jej przegląd, nie wdrażać starszego commitu z pominięciem działającego Free Member.
- Produkcyjne obecnie `src/config.ts` i `src/membership/service.ts` są MOCK ONLY; Stripe adapter nowy, izolowany, zweryfikowane zdarzenia, additive migration, brak włączania flag bez audytu.
- Obecnie `src/discord/config.ts` zabrania produkcyjnego VIP writes. Wprowadzić osobne, jawne approval gates dla dwóch VIP ról. NIE rozwadniać już zatwierdzonych Free Member gates. Manage Roles bot ma tylko dla ról poniżej swojej najwyższej roli.
- Jeśli w tickecie udział bierze moderator, powiązać zakup z rzeczywistym klikającym użytkownikiem, nie z moderatorami i nie z ID z tematu kanału. Blokuj ponowne kupno aktywnego Lifetime, zapobiegaj równoległym subskrypcjom tego samego klienta.
- Nie przechowywać danych kart, kont PayPal i kluczy Stripe w Discordzie, tickecie, repozytorium ani czacie. Powiadomienia bez osobistych danych płatniczych.

## Uprawnienia, abonament i bezpieczeństwo
- Dopóki nie działa integracja, PAYMENTS_ENABLED=false, DISCORD_VIP_SYNC_ENABLED=false i DISCORD_PRODUCTION_VIP_WRITES_ENABLED=false. Aktualne Free Member na produkcji pozostaje aktywne.
- Oddzielne sandbox API keys, endpoint secret i test-mode Stripe Price IDs; nigdy nie wklejać sk_test lub whsec w repo/czat/screenshot.
- PayPal w Stripe wymaga indywidualnej dostępności/aktywacji, w tym akceptacji recurring.
- Stripe musi zaakceptować rzeczywistą ofertę konfiguracji/skryptów Cronus Zen/XIM Matrix oraz status działalności sprzedawcy. Nie maskować opisu jako unrelated goods.
- Sprzedaż: warunki subskrypcji/auto-renew/cancellation, licencja Lifetime, konsumenckie prawo odstąpienia (treść cyfrowa), procedura zwrotów, VAT i RODO.
- Testy: przynajmniej webhook signature/replay, amount mismatch, stale checkout, race double-click, duplicate invoice, unpaid subscription, refund, dispute, late webhook, monthly expiration, VIP role rejoin, Free Member regression, two concurrent workers, integration with ticket tool interaction in sandbox.

## Otwarte zadanie dla właściciela
Potwierdź: czy istniejący panel Open Ticket jest botem Ticket Tool oraz czy chcesz zachować ten system ticketów? Po odpowiedzi implementacja wybierze wariant A lub B. Nie wymuszać wyboru bez potwierdzenia.
Po weryfikacji Stripe użytkownik otrzyma osobną instrukcję tworzenia planów w Stripe test mode (`price` recurring 40 EUR per month + one-time 100 EUR). Bez zatwierdzenia faktycznego katalogu przez operatora brak produkcyjnych opłat.