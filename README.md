# Personal Assistant

A secured, sandboxed personal assistant with pluggable agent backends:

- **Claude** via the Claude Agent SDK (commonly paired with Claude Code CLI)
- **OpenAI Codex** via `@openai/codex-sdk` (alternative to Claude Code)

Runs as a standalone terminal or as a headless daemon with Telegram and Slack adapters.

## Prerequisites

- **Node.js 22+**
- Choose an agent backend:
  - **Claude backend:** Claude Code CLI authenticated via `claude login` or an Anthropic API key
  - **Codex backend:** OpenAI API key + Codex CLI (see `docs/settings/openai_codex_agent.md`)

### Anthropic usage note (third-party harnesses)

Anthropic does not support using monthly Claude subscription limits for third-party harnesses that heavily and regularly use their servers (this project falls into that category when used as an always-on assistant). Use an **Anthropic API key** or enable **token extra usage** for your account.

Anthropic's official statement:

> You’ll no longer be able to use your Claude subscription limits for third-party harnesses including OpenClaw. Instead, using these harnesses will require extra usage. Your subscription usage still covers all Claude products, including Claude Code and Claude Cowork (their usage is preferred). To keep using third-party harnesses with your Claude login, an admin/you will need to enable extra usage for your account.

## Installation

```bash
git clone <repo-url> personal-assistant
cd personal-assistant
npm install
npm run build
npm link
```

This installs the `pa` command globally.

To uninstall:

```bash
npm unlink -g personal-assistant
```

## Quick Start

```bash
pa init                  # Create default config at ~/.personal-assistant/settings.json
pa terminal              # Start interactive terminal mode
pa daemon                # Start headless daemon mode
pa --config <path> ...   # Use a custom settings.json location
```

#### Running as a systemd user service

Create the service unit:

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/pa-daemon.service << 'EOF'
[Unit]
Description=Personal Assistant Daemon
After=network.target

[Service]
Environment=PATH=/home/<user>/.nvm/versions/node/v24.14.0/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=-%h/.personal-assistant/.env
ExecStart=/home/<user>/.nvm/versions/node/v24.14.0/bin/pa daemon
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
EOF
```

Adjust the `PATH` and `ExecStart` paths to match your Node.js installation. The `EnvironmentFile` line loads API keys from `~/.personal-assistant/.env` (the `-` prefix means the service still starts if the file is missing).

Create the env file for secrets that the daemon needs at runtime:

```bash
cat > ~/.personal-assistant/.env << 'EOF'
# Format: KEY=value (no quotes, no "export" prefix)
OPENAI_API_KEY=sk-...
EOF
chmod 600 ~/.personal-assistant/.env
```

Enable and start:

```bash
systemctl --user daemon-reload
systemctl --user enable --now pa-daemon
```

Logs can be observed via `journalctl --user -u pa-daemon -n 100 --no-pager`

### Terminal Mode

Interactive terminal for direct conversation. Type messages and get responses. Press `Ctrl+C` to exit.

### Daemon Mode

Headless mode with adapters and heartbeats (periodic checking of reminders, processes, tasks to be completed etc.). The daemon starts enabled adapters (Telegram/Slack), the heartbeat scheduler, and processes messages through a serialized queue.

## Configuration

Run `pa init` to create a default `~/.personal-assistant/settings.json`. Edit it to customize your setup. The file is loaded at startup and not hot-reloaded. Override the location with `--config <path>` or the `PA_CONFIG` env var.

### Setup guides

- OpenAI Codex agent backend (alternative to Claude Code): `docs/settings/openai_codex_agent.md`
- Google integrations (Gmail + Calendar): `docs/settings/google_integrations.md`
  - Gmail unreads: categorized unread email overview with multi-account support
- Slack integration (unread messages feed): `docs/settings/slack_integration.md`
  - Copy and use src/templates/skills/integrations/SKILL.md so the assistant knows how to use these services 
- Telegram adapter: `docs/settings/telegram_configuration.md`
- Slack adapter (bidirectional chat): `docs/settings/slack_configuration.md`
- GitHub Webhook adapter: `docs/settings/github_webhook_configuration.md`

### Key Sections

**security** - Command allowlist, workspace path, allowed directories:
```json
{
  "security": {
    "allowedCommands": ["ls", "cat", "grep", "node", "npm", "git"],
    "workspace": "~/.personal-assistant/workspace",
    "dataDir": "~/.personal-assistant/data"
  }
}
```

**profiles + routing** - Optional profile-based routing (disabled by default). Supports deterministic bindings (e.g. `/code`) and an opt-in heuristic fallback when no bindings match:
```json
{
  "routing": {
    "enabled": true,
    "routerProfile": "router",
    "defaultProfile": "research",
    "useRouter": true,
    "candidateProfiles": ["research", "coding_strong"],
    "bindings": [
      { "when": { "source": "telegram", "prefix": "/code" }, "profile": "coding_strong" }
    ]
  },
  "profiles": {
    "router": { "backend": "local_llama", "model": { "type": "gguf", "path": "/path/to/router.gguf" } },
    "research": { "backend": "claude", "model": "anthropic/claude-haiku" },
    "coding_strong": { "backend": "codex", "model": "openai/gpt-5" }
  }
}
```

**adapters.telegram** - Telegram bot configuration:
```json
{
  "adapters": {
    "telegram": {
      "enabled": true,
      "botToken": "YOUR_BOT_TOKEN",
      "allowedUserIds": [123456789],
      "mode": "polling",
      "audio": {
        "enabled": true,
        "sttModel": "whisper-1",
        "sttLanguage": "cs",
        "ttsModel": "gpt-4o-mini-tts",
        "ttsVoice": "nova",
        "ttsFormat": "opus",
        "ttsSpeed": 1.0
      }
    }
  }
}
```
Audio messages require `OPENAI_API_KEY` in the environment. Voice options include `alloy`, `ash`, `echo`, `fable`, `onyx`, `nova`, `shimmer`.

**adapters.slack** - Slack bot configuration (socket mode):
```json
{
  "adapters": {
    "slack": {
      "enabled": true,
      "botToken": "xoxb-...",
      "appToken": "xapp-...",
      "socketMode": true
    }
  }
}
```

**adapters.githubWebhook** - GitHub Webhook trigger (recommended behind HTTPS reverse proxy):
```json
{
  "adapters": {
    "githubWebhook": {
      "enabled": true,
      "bind": "127.0.0.1",
      "port": 19210,
      "path": "/personal-assistant/github/webhook",
      "botLogin": "your-bot-login",
      "secretEnvVar": "PA_GITHUB_WEBHOOK_SECRET"
    }
  }
}
```
Set the secret in `~/.personal-assistant/.env`:
```bash
PA_GITHUB_WEBHOOK_SECRET=...
```
See `docs/settings/github_webhook_configuration.md` for full setup (reverse proxy, webhook events, and `gh` authentication).

**heartbeat** - Periodic check schedule:
```json
{
  "heartbeat": {
    "enabled": true,
    "intervalMinutes": 30,
    "activeHours": "8-21",
    "deliverTo": "last"
  }
}
```

**mcpServers** - Additional MCP servers to make available to the agent:
```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["path/to/server.js"]
    }
  }
}
```

## Workspace Files

The agent's workspace lives at `~/.personal-assistant/workspace/` and contains:

| File | Purpose |
|------|---------|
| `AGENTS.md` | Agent behavior rules and tool instructions |
| `SOUL.md` | Personality and identity |
| `USER.md` | User profile and preferences |
| `MEMORY.md` | Long-term memory (indexed for search) |
| `HEARTBEAT.md` | Periodic check instructions |
| `daily/` | Audit logs (YYYY-MM-DD.jsonl) |
| `.claude/skills/` | Agent-created skills |

These files are seeded from templates on first run. Edit them to customize the assistant's behavior.

## Security Model

Three layers of defense:

1. **SDK Sandbox** - Claude Agent SDK sandbox mode restricts the agent's environment
2. **Filesystem Permissions** - Agent restricted to workspace directory, with configurable additional read/write directories
3. **Bash Command Hook** - Every shell command is validated against the allowlist in `settings.json`, with path validation ensuring all file operations stay within the allowed directories

The agent cannot modify its own source code or configuration.

## Conversation History

The assistant remembers previous messages within a session using the SDK's built-in session resumption.
Each adapter/user/thread gets an independent conversation.
The SDK auto-compacts old context when the context window fills up.

Type `/clear` (in terminal, Telegram, or Slack) to reset the conversation and start fresh.

## Agent Tools

Built-in tools available to the agent:

| Tool | Description |
|------|-------------|
| `memory_search` | Hybrid search (vector + keyword) over workspace memory files |
| `cron` | Schedule one-shot or recurring reminders |
| `exec` | Run background shell commands with completion notifications |
| `process` | Check status of background processes |

Plus standard Claude Code tools: Read, Write, Edit, Glob, Grep, Bash, WebFetch, WebSearch.

## Skills

The agent can create and use `.claude/skills/` in its workspace.
Skills are markdown files that describe reusable workflows (know-hows). 
The agent can create new skills when it discovers useful patterns.

## Development

```bash
npm run terminal      # Run terminal mode directly (via tsx, no build needed)
npm run daemon        # Run daemon mode directly (via tsx)
npm test              # Run tests (vitest watch mode)
npm run test:coverage # Run tests with coverage
npm run build         # TypeScript compilation + template copy
```

## License

MIT
