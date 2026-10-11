# TimonConfigs — wdrożenie prywatnych komend Discord bez przerywania Free Member

## Co jest implementowane?

- `/help` — instrukcja i link do wsparcia.
- `/membership` — stan VIP z bazy oraz data ważności, jeśli konto Discord zostało powiązane.
- `/sync-status` — status powiązania konta i zadania synchronizacji.
- Wyłącznie **ephemeral responses** (flag `64`), dane tylko w kontekście podpisanego Discord interaction i ID użytkownika wywołującego komendę.
- Ed25519 i timestamp weryfikowane przed dispatch, sprawdzane application ID oraz guild ID. PING dla konfiguracji Discord Developer Portal działa bez nadawania ról.
- Komendy nie realizują zakupów, nie nadają ról, nie uruchamiają VIP sync i nie dotykają uprawnień Free Member.
- Rejestracja definicji komend jest osobnym, zatwierdzanym żądaniem Discord `PUT`. Rejestracja z zastąpieniem listy komend aplikacji może usunąć wcześniej zarejestrowane komendy w tym serwerze; sprawdź listę przed wykonaniem.

## Gwarancja oddzielenia od Free Member

**Nie zmieniać** istniejących działających flag `DISCORD_FREE_MEMBER_ROLLOUT_MODE=all`, `DISCORD_FREE_MEMBER_WRITES_APPROVED=true`, `DISCORD_DRY_RUN=false`, `DISCORD_WRITES_ENABLED=true`, ani Discord IDs/sekretów. Nadawanie ról pozostaje na dotychczasowym silniku. **Nie ustawiaj `DISCORD_COMMANDS_ENABLED=true`** — ta flaga jest zabroniona na produkcji.

Dodatkowe zmienne na nowej, PRZEJRZANEJ i PRZETESTOWANEJ gałęzi:

```dotenv
DISCORD_READONLY_COMMANDS_ENABLED=true
DISCORD_READONLY_COMMAND_REGISTRATION_APPROVED=true
DISCORD_READONLY_COMMAND_APPROVAL_REFERENCE=owner-approved-commands-202610
DISCORD_COMMANDS_ENABLED=false
DISCORD_VIP_SYNC_ENABLED=false
DISCORD_PRODUCTION_VIP_WRITES_ENABLED=false
```

Referencja zatwierdzenia ma mieć co najmniej 8 znaków i nie może równać się trzem istniejącym referencjom zgód Discord. Gdy właściciel nie zatwierdzi komend, pozostaw nowe trzy zmienne wyłączone/puste.

**Uwaga:** nie ustawiaj tych zmiennych na obecnie działającej gałęzi przed wdrożeniem nowego kodu; starsza wersja nie zna nowych bramek i komendy nie zostaną poprawnie zarejestrowane.

## Procedura wdrożenia — dopiero po pomyślnym audycie/testach

1. Zapisz działający SHA Hostingera i niepublikowane zmienne (nie kopiuj sekretów do czatu).
2. Zrób code review `feature/production-readonly-commands`. Wykonaj `npm run typecheck`, `npm run build`, `npm run test:unit`; integracje wyłącznie na tymczasowej bazie PostgreSQL.
3. Zmień gałąź Hostingera na zatwierdzoną wersję. Początkowo pozostaw `DISCORD_READONLY_COMMANDS_ENABLED=false`. Sprawdź `/ready`, audyt Free Member i brak niepożądanych zmian.
4. Zarejestruj publiczny Endpoint URL dla Discord interactions w Discord Developer Portal aplikacji TimonConfigs: `https://bot.timonconfigs.com/api/discord/interactions` **dopiero gdy domena, HTTPS i routing rzeczywiście działają**. Przejściowo sprawdzony URL Hostinger może służyć do diagnostyki. Discord musi zweryfikować podpisany PING; nie wyłączaj sprawdzania podpisów.
5. Po odrębnej zgodzie właściciela dodaj *jednocześnie* trzy nowe zmienne, pozostawiając stare zgody Free Member bez zmian. Restart. `/ready` musi pozostać prawidłowe.
6. W zaufanym lokalnym terminalu albo SSH z kodem i chronionym środowiskiem wykonaj podgląd:
   `node dist/discord/register-commands-cli.js`
   Podgląd nie łączy się z Discordem. **Nie wklejaj sekretów w terminal/raport widoczny publicznie.**
7. Gdy lista jest prawidłowa, zarejestruj **raz**:
   `node dist/discord/register-commands-cli.js --apply-commands`
   To wykonuje PUT definicji komend tylko w skonfigurowanym guild. Nigdy nie jest wykonywane automatycznie podczas startu Hostingera.
8. Przetestuj `/help`, `/membership`, `/sync-status` na niepowiązanym i powiązanym koncie; odpowiedzi mają być prywatne, bez danych innych klientów. Jeśli strona nie obsługuje jeszcze OAuth dla klientów, `/membership` może informować o braku powiązanego konta — to oczekiwane.
9. Równolegle sprawdź Free Member nowego członka po Rules Screening oraz audyt `discord_role_operations`; komendy nie mogą wpłynąć na role.

## Rollback

- Jeśli problem dotyczy samych komend, wyłącz `DISCORD_READONLY_COMMANDS_ENABLED=false`, `DISCORD_READONLY_COMMAND_REGISTRATION_APPROVED=false` i usuń referencję. Nie zmieniaj flag Free Member.
- Już zarejestrowane komendy mogą dalej wyświetlać się klientom Discord, choć obsługa zwróci komunikat o niedostępności. Ewentualną zmianę/rejestrację definicji wykonuj oddzielnie, świadomie i po audycie.
- Jeśli aplikacja nie startuje, przywróć zapisany stabilny commit Hostingera ze starą konfiguracją produkcyjną. Nie usuwaj danych Supabase ani ról Discord.
