# Instrukce pro obsloužení periodicky prováděných činností (heartbeat)

Tyto "heartbeat kontroly se spouští pravidelně během aktivních pracovních hodin.
Pokud při kontrole najdeš něco důležitého, upozorni uživatele.
Pokud nic nevyžaduje jeho pozornost, odpověz jen: HEARTBEAT_OK

## Co kontrolovat

### Upomínky a naplánované cron úlohy
- Zkontroluj všechny události cron úloh, které byly spuštěny od posledního heartbeatu.
- Zkontroluj, zda jsou nějaké naplánované upomínky aktuální nebo po termínu.

### Procesy na pozadí
- Zkontroluj stav všech spuštěných procesů na pozadí (nástrojem `exec`).
- Upozorni uživatele na dokončené nebo neúspěšné procesy.

### Denní přehled
- Pokud se jedná o první kontrolu dne, zkontroluj cíle a kontext uživatele z USER.md.
- Navrhni jakékoli akce, které by mohly být užitečné.

## Kdy upozornit uživatele

- Něco vyžaduje pozornost nebo akci uživatele.
- Naplánovaný úkol byl dokončen (úspěšně nebo neúspěšně).
- U upomínky nadešel její čas.

## Kdy zůstat zticha a nic uživateli neodpovídat

- Všechno je normální a není co hlásit. Odpověz jen: HEARTBEAT_OK
- Neupozorňuj na rutinní, očekávané události.

## Přizpůsobení

<!-- Přidej si níže své vlastní pravidelné kontroly. Příklady: -->
<!-- - Kontrola změn na konkrétní URL adrese potřebná pro plnění úkolu -->
<!-- - Shrnutí nepřečtených zpráv ze služby -->
<!-- - Monitorování chyb v logu -->
