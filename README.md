# Personal Assistant

A secure, sandboxed personal assistant powered by the Claude Agent SDK for TypeScript. Runs as a standalone terminal REPL or as a headless daemon with Telegram and Slack adapters.

## Prerequisites

- **Node.js 22+**
- **Claude Code CLI** authenticated via `claude login` or with an API key configured

## Installation

```bash
git clone <repo-url> personal-assistant
cd personal-assistant
npm install
```

## Quick Start

### Terminal Mode

Interactive REPL for direct conversation:

```bash
npm run terminal
```

Type messages and get responses. Press `Ctrl+C` to exit.

### Daemon Mode

Headless mode with adapters and heartbeat:

```bash
npm run daemon
```

The daemon starts enabled adapters (Telegram/Slack), the heartbeat scheduler, and processes messages through a serialized queue.

## Configuration

Edit `settings.json` in the project root. The file is loaded at startup and not hot-reloaded.

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

**adapters.telegram** - Telegram bot configuration:
```json
{
  "adapters": {
    "telegram": {
      "enabled": true,
      "botToken": "YOUR_BOT_TOKEN",
      "allowedUserIds": [123456789],
      "mode": "polling"
    }
  }
}
```

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
3. **Bash Command Hook** - Every shell command is validated against the allowlist in `settings.json`, with path validation ensuring all file operations stay within allowed directories

The agent cannot modify its own source code or configuration.

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

The agent can create and use `.claude/skills/` in its workspace. Skills are markdown files that describe reusable workflows. The agent can create new skills when it discovers useful patterns.

## Development

```bash
npm test              # Run tests (vitest watch mode)
npm run test:coverage # Run tests with coverage
npm run build         # TypeScript compilation
```

## License

MIT
