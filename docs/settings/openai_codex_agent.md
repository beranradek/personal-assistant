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
    "configOverrides": {},
    "turnTimeoutMs": 1800000
  }
}
```

Notes:

- `codex.apiKey` is optional if `OPENAI_API_KEY` is set in the environment.
- `codex.baseUrl` is optional (useful for proxies / OpenAI-compatible endpoints).
- In daemon mode, using `approvalPolicy: "untrusted"` will typically block execution waiting for approvals. If you want autonomous operation, keep `approvalPolicy: "never"` and rely on sandboxing.
- `codex.turnTimeoutMs` bounds the total wall-clock time of a single turn (across all internal retries), applied uniformly to every turn regardless of source (heartbeat, Telegram, Slack, terminal). Once exceeded, the turn is aborted via `AbortSignal` and the turn fails with a timeout error instead of running indefinitely. Defaults to 1,800,000ms (30 minutes); set to `null` to disable.
- Because `turnTimeoutMs` is a timer inside pa-daemon's own event loop, it can itself be delayed by the exact RAM/CPU exhaustion it's meant to guard against. `scripts/codex-watchdog.sh` is an OS-level backstop that doesn't depend on pa-daemon being responsive — see "Codex watchdog (stale process reaper)" below.

## Codex watchdog (stale process reaper)

`scripts/codex-watchdog.sh` periodically reaps two things `turnTimeoutMs` can miss, entirely from `/proc` — it never touches the pa-daemon Node process, so it keeps working even if that process is wedged:

1. A `codex exec` process tree (and everything spawned under it — sandboxes, bwrap, MCP servers) older than `STALE_SECONDS`. Default is derived at runtime from this deployment's own `codex.turnTimeoutMs` (read from `settings.json`) plus `GRACE_SECONDS` (default 900s = 15min) — e.g. `turnTimeoutMs: 3600000` gives a default threshold of 4500s (75min). Raising `turnTimeoutMs` for legitimately longer turns automatically raises this backstop too; no manual sync needed. Set `STALE_SECONDS` explicitly to override. This is a pure backstop for when the in-process timeout should have fired already and didn't.
2. A process tree matching one of this deployment's configured `mcpServers` (read from `settings.json`, e.g. `chrome-devtools-mcp`/`context7-mcp` today) whose `codex exec` parent is already gone, and which is older than `ORPHAN_MIN_AGE_SECONDS` (default 120s). This does not cover PA's own stdio `pa mcp-server` orphan case, which isn't declared in `mcpServers` — that one stays mitigated via `httpMcpPort` (see above). It's also not airtight for `mcpServers` itself: each entry launches through an intermediate `npx` process, and if that `npx` exits early while the turn is still using the actual MCP server, the server gets reparented and looks orphaned even though it's still in use. `ORPHAN_MIN_AGE_SECONDS` only guards the common case (a reparent moments before the watchdog runs); this is a bounded, documented residual risk, not a fully closed gap — see the comment in `scripts/codex-watchdog.sh`.

It's scoped to `pa-daemon.service`'s own cgroup (via `systemctl --user show pa-daemon.service -p ControlGroup`), so it can never touch a codex/claude session run manually in an interactive terminal.

Install a stable copy plus the systemd `--user` timer — run from `~/.personal-assistant/bin`, not the mutable dev git checkout, so a rebase/branch-switch/move of the checkout can't silently break the timer-triggered oneshot unit:

```bash
mkdir -p ~/.personal-assistant/bin
cp scripts/codex-watchdog.sh ~/.personal-assistant/bin/
cp deploy/systemd/codex-watchdog.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now codex-watchdog.timer
```

Re-run the `cp scripts/codex-watchdog.sh ...` step after pulling any future change to the script.

Dry-run (logs what it would kill without killing anything):

```bash
scripts/codex-watchdog.sh --dry-run
```

Logs go to `~/.personal-assistant/data/logs/codex-watchdog.log` and the user journal (`journalctl --user -t codex-watchdog`).

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
