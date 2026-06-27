# Obsloužení periodicky prováděných činností (heartbeat)

Heartbeat kontroly se spouští každou celou pracovní hodinu. Na důležité události upozorni uživatele.
A předtím vždy pracuj sama proaktivně na svých úkolech. Pokud nic nevyžaduje pozornost uživatele, odpověz jen: HEARTBEAT_OK

## Co a jak kontrolovat

### Úvodní krok - sync úkolů a dokumentů:
- Vždy napulluj změny z origin GITu pro tvůj pracovní adresář (`git pull`)
- Zkontroluj tvé poslední vzpomínky v MEMORY.md a memory/* souborech

### Pravidelně:
- Zkontroluj všechny cron úlohy, které byly spuštěny od posledního heartbeatu. Zkontroluj, zda jsou nějaké upomínky aktuální nebo po termínu.
- Zkontroluj stav spuštěných procesů na pozadí (nástrojem `exec`) a upozorni na dokončené nebo neúspěšné.
- Zkontroluj evidenci tvých úkolů - jobů na filesystému - PROAKTIVNĚ SAMA řeš dle zadání aktivní úkoly, posuň čekající, pokud to lze. Eviduj jejich progress v memory/<job-title>.md souboru odkazovaném ze zadání (odkaz doplň na konec zadání). Memory soubor si vždy znovu přečti (proaktivně tam eviduj hotové, in-progress, následující kroky, reviduj je vůči zadání, doplňuj nové). Nečekej na rozhodnutí uživatele - řeš sama další možné kroky, dokud nebude úkol kompletně splněný. Reportuj uživateli kritické chyby/nálezy a potřebná důležitá rozhodnutí blokující další práci - ale ne vícekrát než jednou (ne když už to máš z minula zapsané v memory). Reportuj kompletní dokončení úkolu se všemi kontrolami. Při omezeních pracuj dále na tom, na čem pokračovat lze. Před skončením své session MUSÍŠ do memory souboru zapsat velmi stručné shrnutí, co bylo uděláno a kde a s čím pokračovat dále - pro svou další session.

### Finální krok - push změn do GITu:
- Pokud se objeví **nečekané unstaged změny** (`git status`), ověř je proti předchozí komunikaci (typicky `daily/*.jsonl`) a teprve pak rozhodni: (a) vynechat je jako omyl/ignorovat, nebo (b) **přidat + commitnout + pushnout**, pokud neobsahují citlivé údaje.
- Přidání změn do GITu a commit změn s vhodnou commit message (pozor, ať necommituješ žádné secrety nebo klíče!)
- `git pull` z origin GITu, vyřeš případné konflikty (se zachováním slučitelných úprav, pokud je to možné)
- pushni změny do vzdálené větve

## Kdy upozornit uživatele

- Něco neodkladného vyžaduje pozornost nebo akci uživatele
- Významný posun nebo dokončení (úspěšné nebo neúspěšné) naplánovaného úkolu, nebo vyvstaly nové závažné komplikace (neopakuj už známé)
- U upomínky nadešel její čas

## Kdy zůstat zticha a nic uživateli neodpovídat

- Všechno je normální a není co hlásit. Odpověz jen: HEARTBEAT_OK
- Neupozorňuj na rutinní, očekávané události
- Komplikace už jsi jednou reportovala
