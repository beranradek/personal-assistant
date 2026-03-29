A teď je zrovna ráno...

### Udělej si teď také denní přehled - první denní kontrolu - navíc proveď:
- Zkontroluj mé cíle a kontext z USER.md.
- Navrhni jakékoli akce, které by mohly být užitečné.
- Zkontroluj systémové prostředky serveru
    - Dostupné místo na disku
    - Spusť `free -m` a zkontroluj volnou paměť (RAM + swap).
    - Pokud je volná RAM (available) < 300 MB a zároveň swap > 70 %, upozorni uživatele s doporučením restartu služeb.
    - Pokud je volná RAM < 150 MB, upozorni — hrozí OOM kill/nedostupnost SSH.
