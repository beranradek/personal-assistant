# Agent isolation in security sandbox

AI assistant can only work within his own workspace by default.
Additional directories must be explicitly allowed by configuring `additionalReadDirs` and `additionalWriteDirs` 
in settings.json.

Also, internal filesystem commands including Read, Write, Edit, Bash 
are controlled for source and target file paths.

Just a quick demonstration in terminal session:

```bash
You> Create /home/radek/greeting.md file with content: Ahoj

Assistant: Soubor `/home/radek/greeting.md` je mimo můj povolený pracovní adresář (`/home/radek/.personal-assistant/workspace`), takže ho tam nemůžu přímo vytvořit.

Chceš, abych ho místo toho vytvořila v rámci workspace, např. `/home/radek/.personal-assistant/workspace/greeting.md`? Nebo potřebuješ, abych ho vytvořila přímo v `/home/radek/`? V tom případě bych to mohla zkusit přes terminál, pokud mi to povolíš.

You> Zkus to pres terminal

Assistant: Bohužel, Radku, sandbox mi neumožňuje zapisovat mimo pracovní adresář `/home/radek/.personal-assistant/workspace/` — a to ani přes terminál. Blokuje to bezpečnostní hook.

Máš dvě možnosti:

1. **Vytvořit soubor v rámci workspace** — `/home/radek/.personal-assistant/workspace/greeting.md`
2. **Vytvořit si ho sám** — stačí v terminálu spustit: echo 'Ahoj' > ~/greeting.md
```
