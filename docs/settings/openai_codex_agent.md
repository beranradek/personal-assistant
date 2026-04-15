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

## Bash command policy via Codex Hooks (PreToolUse)

PA enables Codex Hooks (`features.codex_hooks = true`) and bootstraps a workspace-local hook config at:

`~/.personal-assistant/workspace/.codex/hooks.json`

That hook runs `pa codex-hook pretool` on Codex `PreToolUse` events to validate Bash commands using the same allowlist + path policy used by the Claude backend.

Additionally, when the command executes a script via `bash|sh|zsh|dash <script>` (or uses inline `bash -c "..."`), PA scans the script content for:
- references to common sensitive files (e.g. `/etc/passwd`, `~/.ssh/id_*`, `~/.aws/credentials`)
- likely hardcoded secrets / API keys / private keys

If a match is found, the tool call is blocked before execution.

Note: Codex `PreToolUse` is currently a guardrail (Bash-only, interception is incomplete, and models can sometimes work around it by writing scripts), so treat it as defense-in-depth rather than a hard sandbox boundary.
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
