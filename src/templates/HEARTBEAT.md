# Instrukce pro obsloužení periodicky prováděných činností (heartbeat)

Tyto kontroly se spouští pravidelně každou celou hodinu během pracovních hodin. Pokud při kontrole najdeš něco důležitého, upozorni uživatele.
Pokud nic nevyžaduje jeho pozornost, odpověz jen: HEARTBEAT_OK
Vždy ale řeš proaktivně své úkoly.

## Co a jak kontrolovat

### Úvodní krok - sync úkolů a dokumentů:
- Na začátku musíš vždy napullovat změny z origin GITu pro tvůj pracovní adresář (`git pull`).
- Zkontroluj tvé poslední vzpomínky v MEMORY.md a memory/* souborech.

### Pravidelně:
- Zkontroluj všechny cron úlohy, které byly spuštěny od posledního heartbeatu. Zkontroluj, zda jsou nějaké upomínky aktuální nebo po termínu.
- Zkontroluj stav spuštěných procesů na pozadí (nástrojem `exec`) a upozorni uživatele na dokončené nebo neúspěšné.
- Zkontroluj evidenci tvých úkolů - jobů na filesystému - zda lze dále řešit aktivní úkoly nebo posunout čekající. Proaktivně je řeš, čti si jejich zadání, eviduj si jejich progress v memory/<job-title>.md souboru odkazovaném ze zadání (odkaz si doplň na konec zadání). Memory soubor si vždy znovu přečti (proaktivně tam eviduj hotové, in-progress, následující dílčí kroky, reviduj je vůči zadání, doplňuj nové). Nečekej na rozhodnutí uživatele a řeš sama cokoliv dalšího je možné, dokud nebude úkol kompletně splněný. Přítomnost aktivního úkolu znamená, že ho máš dále samostatně řešit. Reportuj uživateli kritické chyby/nálezy a potřebná důležitá rozhodnutí blokující další práci - ale ne vícekrát než jednou (ne když už to máš z minula zapsané v memory). Reportuj kompletní dokončení úkolu se všemi kontrolami. I při omezeních pracuj dále na tom, na čem pokračovat lze. Před skončením své session MUSÍŠ do memory souboru zapsat velmi stručné shrnutí, co bylo uděláno a kde a s čím konkrétně pokračovat dále - pro svou další session.

### Finální krok - push změn do GITu:
- Přidání změn do GITu a commit změn s vhodnou commit message, pokud bylo něco v pracovním adresáři změněno (pozor, ať necommituješ žádné secrety nebo klíče!),
- `git pull` z origin GITu, vyřeš případné konflikty (se zachováním slučitelných úprav, pokud je to možné),
- pushni změny do vzdálené větve.

## Kdy upozornit uživatele

- Něco vyžaduje pozornost nebo akci uživatele.
- Naplánovaný úkol byl dokončen (úspěšně nebo neúspěšně), nebo vyvstaly nové závažné komplikace (neopakuj už známé).
- U upomínky nadešel její čas.

## Kdy zůstat zticha a nic uživateli neodpovídat

- Všechno je normální a není co hlásit. Odpověz jen: HEARTBEAT_OK
- Neupozorňuj na rutinní, očekávané události
- Komplikace už jsi jednou reportovala

## Přizpůsobení

<!-- Přidej si níže své vlastní pravidelné kontroly. Příklady: -->
<!-- - Kontrola změn na konkrétní URL -->
<!-- - Shrnutí nepřečtených zpráv ze služby -->
<!-- - Monitorování chyb v logu -->
