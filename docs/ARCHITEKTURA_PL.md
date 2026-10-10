# Architektura systemu TimonConfigs

## Rozdzielenie odpowiedzialności

```
Browser (Next.js) ───────> API serwerowe ───────> PostgreSQL
     │                         │                      │
     │ Discord OAuth2          │ payment adapter      │ entitlements
     ▼                         ▼                      ▼
Connected Discord ID    PSP webhook endpoint     Discord sync queue
                                 │                      │
                          Verified payment        Discord REST API
                                                        │
                                                 Two existing VIP roles

Private Object Storage (R2) <-- signed URL, issued only after access check
```

## Konta i logowanie

- Konto na stronie ma własny ID i może mieć połączony `discord_user_id` (unikalny).
- OAuth2 `identify` wystarczy do poznania Discord ID użytkownika po jego wyraźnej zgodzie.
- `guilds.join` nie jest wymagane, jeżeli użytkownik sam dołącza przez przycisk zaproszenia. Nie wykonuj automatycznego dołączania do serwera bez wyraźnego działania użytkownika i zgodnego zakresu OAuth.
- Po połączeniu konta aplikacja pokazuje `Sync Discord Access`, który inicjuje zadanie synchronizacji; synchronizacja może też działać po potwierdzeniu płatności i cyklicznie.

## Model dostępu

- `VIP_MONTHLY_ONCE`: €40, potwierdzony capture, przyznaj okres od `captured_at` do +1 miesiąc kalendarzowy UTC.
- `VIP_MONTHLY_AUTO`: €40/cykl, uprawnienie na każdy POTWIERDZONY opłacony okres według danych operatora. Samo `SUBSCRIPTION.ACTIVATED` nie dowodzi jeszcze powodzenia płatności.
- `VIP_LIFETIME`: €100, brak `valid_until`, zakres zgodny z umową.
- W przypadku nakładania się aktywnego Lifetime i Monthly efektywną rolą jest Lifetime.
- Przy anulowaniu automatycznego odnawiania nie skracaj już opłaconego okresu.
- Przy zwrocie cofnij wyłącznie uprawnienie powiązane z konkretną płatnością; przelicz pozostałe.
- Zaległa płatność, duplikat webhooka, niepełna płatność lub błędna waluta nie dają nowego dostępu.
- Przedłużanie dostępu kolejnym jednorazowym zakupem wymaga polityki (rekomendacja: nowy okres zaczyna się od końca aktualnego opłaconego One-Time; nie nakładać dwóch okresów). Referencyjny symulator NIE implementuje tej polityki — musi zostać zaimplementowana w API produkcyjnym.

## API serwerowe — plan tras

| Metoda | Endpoint | Działanie |
|---|---|---|
| GET | `/api/me` | Konto i status VIP |
| GET | `/api/catalog` | Katalog i zgodność plików |
| POST | `/api/discord/connect` | Rozpoczęcie OAuth2, state+PKCE, bez ujawniania sekretów |
| POST | `/api/discord/sync` | Zlecenie synchronizacji ról dla zalogowanego konta |
| POST | `/api/checkout` | Wybór planu — zablokowane do akceptacji PSP |
| POST | `/api/webhooks/payments/{provider}` | Odbiór i podpisana walidacja zdarzeń |
| POST | `/api/billing/cancel` | Żądanie anulowania przyszłych odnowień |
| GET | `/api/download/{fileId}` | Kontrola dostępu, 60-sekundowy podpisany URL |
| GET | `/admin/memberships` | Dostęp wyłącznie dla administratora |

## Bezpieczna kolejka ról Discord

- Discord BOT token tylko na backendzie; nie w localStorage ani w przeglądarce.
- Bot otrzymuje tylko `Manage Roles` i niezbędny odczyt członków, nie `Administrator`.
- Bot niżej niż Staff/Founder, wyżej niż role `VIP Monthly` i `VIP Lifetime`.
- Bot modyfikuje WYŁĄCZNIE identyfikatory dwóch ról z allowlisty.
- Dla wybranych Discord ID wyznacz desired state: `FREE` / `VIP_MONTHLY` / `VIP_LIFETIME`.
- Porównaj ze stanem z Discord; zastosuj wyłącznie różnicę (idempotentne PATCH/PUT/DELETE, retry przy 429/5xx).
- W przypadku nieobecności użytkownika na serwerze ustaw job pending, nie traktuj tego jako porażki płatności.
- Cyklicznie weryfikuj konta płatnych użytkowników i joby błędów, bez niepotrzebnego listowania wszystkich 100 000 członków.

## Prywatne pobieranie

- Wszystkie płatne pliki trzymaj w prywatnym bucket R2.
- Backend sprawdza skuteczny plan i uprawnienie do konkretnego pliku.
- Podpisany link ma krótki TTL; wprowadź limit żądań i logi pobrań.
- Nie publikuj stałych, publicznych linków do VIP plików.
- Discord pliki są kopiowalne po pobraniu, więc role chronią dostęp do kanałów, a nie dalszą dystrybucję fizycznie pobranego pliku.

## Niezawodność

- Unikalny `(provider, provider_event_id)` i `(provider, payment_id)`.
- Obsługuj kolejność i opóźnienia webhooków przez pobranie autorytatywnego statusu z API PSP oraz kolejkę.
- Przechowuj dziennik działań i identyfikatory korelacyjne, bez pełnych danych kart.
- Rozdziel środowiska sandbox/staging i production.
- Monitoruj: liczbę niedostarczonych ról, opóźnione webhooks, konflikty subskrypcji, odmowy pobrań i błędy kolejek.
