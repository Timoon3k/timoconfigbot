# TimonConfigs — plan wdrożenia

## Etap A — Discord, bez płatności

1. Na istniejącym serwerze odczytaj ID `guild`, `VIP Monthly` i `VIP Lifetime` (Discord Developer Mode -> Kopiuj ID).
2. W Discord Developer Portal utwórz nową aplikację `TimonConfigs VIP`, utwórz Bot i skonfiguruj OAuth2 redirect URI (nigdy nie przesyłaj tokenu w czacie).
3. Zaproś bota z minimalnymi uprawnieniami, w szczególności Manage Roles; NIE nadaj Administrator.
4. Umieść rolę bota pomiędzy Staff a dwiema rolami VIP, pozostawiając Founder/Staff ponad nią.
5. W `config/discord.example.json` podmień placeholdery na realne ID w lokalnej kopii, zachowaj `dry_run: true`.
6. Zaimplementuj API odczytu członkostwa i tryb preview zmian, zanim pozwolisz botowi cokolwiek modyfikować.
7. Przetestuj na DWÓCH kontach, do których masz uprawniony dostęp: Free i VIP, również po wygaśnięciu i po wyjściu z serwera.

## Etap B — strona i pliki

1. Next.js (responsywny landing, 3 plany, katalog, panel My Account, Downloads, Connect Discord).
2. Auth.js i OAuth2 Discord; tylko scope niezbędne do identyfikacji.
3. PostgreSQL: aplikuj zweryfikowany schemat migracji z `db/schema.sql`.
4. R2 private bucket, signed URLs 60s, sprawdzanie dostępu i limity.
5. Admin: upload plików, nazwy, wersje, zgodność z platformami, publikacja.

## Etap C — testy licencji bez płatności

1. Zaimplementuj domenę uprawnień i testy: jednorazowy miesiąc, auto-renew, Lifetime, refund, retry, duplikat, nakładanie planów, koniec miesiąca.
2. Zaimplementuj testowy generator zdarzeń (tylko środowisko deweloperskie, wymagaj admin login).
3. Sprawdź, że zmiana statusu testowego wpływa zarówno na stronę, jak i rolę Discord.
4. Zablokuj możliwość uruchomienia generatora zdarzeń testowych w środowisku produkcyjnym.

## Etap D — due diligence i bramki płatnicze

1. Przygotuj uczciwy opis RZECZYWISTYCH funkcji skryptów oraz regulamin i warunki Lifetime.
2. Zapytaj operatorów, czy dopuszczają ten katalog, i zachowaj pisemną odpowiedź.
3. Uzyskaj warunki obsługi PayPal, Google Pay i kart; Google Pay wymaga zintegrowanego PSP/acquirera.
4. Sprawdź podatki, VAT dla usług cyfrowych sprzedawanych globalnie, politykę odstąpienia i przetwarzanie danych.
5. Dopiero po zatwierdzeniu włącz adapter płatniczy w staging i wykonaj płatności testowe.
6. Production przełącz dopiero po zatwierdzeniu: webhook signature, idempotency, kwoty EUR, konkurencyjne transakcje, wymuszone zwroty, rate limiting, monitoring.

## Etap E — operacje i rozwój

- Co godzinę — przeliczenie przeterminowanych uprawnień i zaległych zadań ról.
- Codziennie — alerty o niedostarczonych uprawnieniach i braku potwierdzenia płatności.
- Co tydzień — przegląd refundów, logów i zgodności dostępu Discord/WWW.
- Co miesiąc — weryfikacja cennika, wskaźników churn, audyt prawny i kopie zapasowe.

## Niezbędne próby akceptacyjne

- Monthly Once aktywny po zakupie i niedostępny dokładnie po końcu okresu.
- Auto Renew aktywny tylko po rzeczywiście opłaconym cyklu.
- Cancel nie obcina pozostałego opłaconego czasu.
- Lifetime bez daty wygaśnięcia; refund Lifetime usuwa jego uprawnienie.
- Discord nie usuwa ról Staff/Founder/Free Member.
- Nikt bez VIP nie pobiera plików VIP nawet ze znanym adresem URL.
- Brak PayPal/PSP approval oznacza brak możliwości płatności produkcyjnych.
- Brak połączenia z Discordem nie blokuje aktywacji konta WWW; rola czeka na połączenie/dołączenie.
