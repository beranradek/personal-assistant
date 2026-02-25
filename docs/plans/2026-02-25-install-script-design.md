# Install Script Design

## Goal

A single `install.sh` at the repo root that checks and installs all prerequisites for the personal-assistant on Ubuntu/Debian Linux, then builds and links the `pa` CLI globally.

## Target Platform

Ubuntu 20.04+ / Debian 10+. No macOS or Windows support.

## Architecture

A modular Bash script with idempotent `ensure_*` functions, colored status output, and a summary at the end. Re-running is always safe.

## Steps

1. **`ensure_git`** — check `git --version`; if missing, `apt-get install git`
2. **`ensure_node`** — check `node --version` ≥ 22; if missing or outdated, install nvm via its official curl installer then `nvm install 22 && nvm use 22`; source `~/.nvm/nvm.sh` after install
3. **`ensure_claude_code`** — check `claude --version`; if missing, use the official native installer: `curl -fsSL https://claude.ai/install.sh | bash`
4. **`build_pa`** — `npm install && npm run build && npm link`
5. **`init_pa`** — `pa init` (skips silently if `~/.personal-assistant/settings.json` already exists)

## Output Format

```
[personal-assistant installer]

  ✓ git 2.43.0 found
  → node not found, installing via nvm...
  ✓ node 22.x installed
  ✓ claude 1.x found
  → building personal-assistant...
  ✓ pa linked globally
  ✓ pa init done

Done! Run: pa terminal
```

Green `✓` for already satisfied, yellow `→` for in-progress, red `✗` for errors.

## Error Handling

- Any step failure prints a red error message and exits with code 1
- nvm sourcing: after install, script sources `~/.nvm/nvm.sh` so subsequent node/npm calls work in the same process
- Each `ensure_*` function is a no-op if the requirement is already met

## Constraints

- No Windows support
- No uninstall target
- Claude Code installed at latest version (no pinning)
- `pa init` is idempotent — safe to re-run
