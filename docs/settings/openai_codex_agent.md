# OpenAI Codex agent backend (alternative to Claude Code)

This project supports two agent backends:

- **Claude** (`agent.backend = "claude"`) — uses the Claude Agent SDK (commonly paired with Claude Code CLI).
- **OpenAI Codex** (`agent.backend = "codex"`) — uses `@openai/codex-sdk`, which spawns the Codex CLI (`codex exec`) and relies on Codex sandboxing + approval policy.

## Prerequisites

- Node.js 22+
- `pa` installed (`npm run build && npm link`)
- **Codex CLI available on PATH** (or set `codex.codexPath` to its absolute path)
- OpenAI API key available as **`OPENAI_API_KEY`** in the environment (or set `codex.apiKey` in `settings.json`)

## Configure `settings.json`

Edit `~/.personal-assistant/settings.json`:

```json
{
  "agent": {
    "backend": "codex",
    "model": null,
    "maxTurns": 200
  },
  "codex": {
    "codexPath": null,
    "apiKey": null,
    "baseUrl": null,
    "sandboxMode": "workspace-write",
    "approvalPolicy": "never",
    "networkAccess": true,
    "reasoningEffort": null,
    "skipGitRepoCheck": true,
    "configOverrides": {}
  }
}
```

Notes:

- `codex.apiKey` is optional if `OPENAI_API_KEY` is set in the environment.
- `codex.baseUrl` is optional (useful for proxies / OpenAI-compatible endpoints).
- In daemon mode, using `approvalPolicy: "untrusted"` will typically block execution waiting for approvals. If you want autonomous operation, keep `approvalPolicy: "never"` and rely on sandboxing.

## How MCP tools work with Codex

When running the Codex backend, the assistant automatically injects its built-in MCP tools by letting Codex CLI spawn:

`pa mcp-server [--config <configDir>]`

You do not need to manually edit `~/.codex/config.toml` just to get PA’s MCP tools.

## Run

```bash
pa terminal
# or
pa daemon
```

If you run as a systemd user service, set secrets in `~/.personal-assistant/.env`:

```bash
OPENAI_API_KEY=...
```

