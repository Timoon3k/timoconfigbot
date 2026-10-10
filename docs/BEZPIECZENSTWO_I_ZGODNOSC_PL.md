# Bezpieczeństwo i zgodność

## Operatorzy płatności

- Wspieranie metod PayPal, Google Pay oraz kart jest technicznie możliwe wyłącznie przez właściwego operatora, jeśli zaakceptuje faktycznie oferowane treści.
- Nie traktuj istniejącej integracji PayPal, dostępnego API ani logotypu Google Pay jako zgody na sprzedaż skryptów.
- Whop explicite zabrania game cheats/hacks/exploits i ofert typu lifetime. Nie obchodź tych zakazów przez zmianę nazw produktów.
- EA jasno komunikuje, że wykorzystanie Cronus/XIM do nieuczciwej przewagi w Apex Legends narusza zasady gry.
- Oddziel katalog kompatybilnych, dozwolonych narzędzi edukacyjnych od skryptów, których sposób użycia narusza zasady gry; w razie wątpliwości konsultuj produkt z dostawcą płatności i prawnikiem.

## Konsument i prywatność

- Regulamin sprzedaży, zasady Lifetime, anulowanie abonamentu, polityka zwrotów i odstąpienia zgodna z prawem kraju klienta.
- Informacje o automatycznym odnowieniu i dacie następnej opłaty przed zakupem; aktywne pole wyboru zgody tam, gdzie wymagane.
- Nie gromadź pełnych danych kart ani haseł Discord.
- Minimalizacja danych, podstawa przetwarzania, retencja danych, obsługa żądań RODO, ochrona sekretów.
- Zamknięte transkrypty supportu mogą zawierać dane osobowe; ogranicz dostęp i czas retencji.

## Bezpieczeństwo platformy

- Weryfikuj podpis i kontekst każdego webhooka (merchant ID, order ID, waluta, kwota, plan, użytkownik).
- Zapisz provider_event_id jako unikalne, aby uniknąć podwójnej aktywacji.
- HTTP return page nie nadaje VIP.
- Stosuj podpisane linki z krótką ważnością, rate limiting, audyt pobrań i prywatne magazyny.
- Działania administracyjne loguj i wymagaj 2FA dla administratora.
- Token bota przechowuj wyłącznie w bezpiecznych zmiennych środowiskowych, zmieniaj go po ekspozycji.

## Komunikacja Lifetime

- `Lifetime` to brak planowanego wygaśnięcia członkostwa w trakcie działania usługi objętej umową, nie obietnica istnienia produktu lub nieograniczonego wsparcia przez wieczność.
- Zdefiniuj katalog obejmowany licencją, przyszłe wydania, ograniczenia kompatybilności, refundy i zasady zamknięcia usługi.
