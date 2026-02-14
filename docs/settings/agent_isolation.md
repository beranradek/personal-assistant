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

## Personal Assistant does not suffer from the attack vectors possible with OpenClaw

### Attack vectors relevant for OpenClaw

Now here’s where I put on my serious face, because this matters.

Last week, SecurityScorecard’s STRIKE team discovered over 135,000 internet-exposed OpenClaw instances.
That number was 40,000 when they published their report and it skyrocketed within hours. Over 50,000 were vulnerable     
to a known remote code execution bug that was already patched. Over 12,000 instances had public exploit code available.

The headline from The Register didn’t mince words: “Another OpenClaw cybersecurity disaster.”

Here’s what’s happening: OpenClaw, by default, binds to 0.0.0.0:18789 — meaning it listens on all network interfaces, 
including the public internet. People are deploying it, not changing that default, and walking away. When     
someone compromises your OpenClaw instance, they get access to everything it can access: 
your credential store, filesystem, messaging platforms, browser, and personal data cache.

On top of that, Bitdefender found nearly 900 malicious skills on ClawHub (roughly 20% of all packages). 
VirusTotal has since partnered with OpenClaw to scan skills automatically, but the supply chain risk is real.

Reference: https://medium.com/@rentierdigital/i-deployed-my-own-openclaw-ai-agent-in-4-minutes-it-now-runs-my-life-from-a-5-server-8159e6cb41cc

### Good news with Personal Assistant

**Our personal assistant is architecturally immune to the headline OpenClaw vulnerabilities.** 
Here's the point-by-point breakdown:

#### 1. Network binding (0.0.0.0) — Not applicable

Our app **opens zero listening ports**. There is no HTTP server, no web UI, no control panel. All network communication is outbound-only:
- Telegram adapter uses **long-polling** (outbound HTTP to Telegram API)
- Slack adapter uses **Socket Mode** (outbound WebSocket to Slack)
- MCP servers use **stdio** transport (no network)
- Terminal mode uses **stdin/stdout**

There is nothing to bind to 0.0.0.0 because there is no server to expose.

#### 2. Web UI authentication — Not applicable

No web UI exists. No dashboard, no admin panel, no HTTP endpoint of any kind.

#### 3. Firewall / SSH tunnel — Not applicable

With no listening ports, there's nothing to firewall or tunnel to. The attack surface from a network perspective is effectively zero.

#### 4. Skill supply chain risk — Mitigated differently

We don't have a marketplace like ClawHub. MCP servers are configured explicitly in `settings.json` 
and run locally via stdio. The security model uses three layers:
- SDK sandbox
- Filesystem path validation
- Bash command allowlist (PreToolUse hook)

That said, any user-configured `mcpServers` in settings.json are trusted — so vetting MCP servers 
before adding them is still good practice.

#### 5. Remote code execution — Minimal surface

No exposed ports means no remote attack vector. The only entry points are authenticated platform APIs 
(Telegram bot token with `allowedUserIds` filtering, Slack with `allowedUserIds` filtering).

**Bottom line:** The OpenClaw disaster is a cautionary tale about exposing management interfaces 
to the internet with no auth. Our architecture sidesteps this entirely — we have no management interface, no listening ports, and no plugin marketplace.
