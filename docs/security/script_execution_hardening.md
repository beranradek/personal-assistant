# Script execution hardening

This project already enforces a **command allowlist** + **filesystem path validation** before shell commands execute.
To reduce “script smuggling” risks (where a single allowlisted command runs an unvalidated script that performs sensitive operations),
PA also supports **script content scanning** for common sensitive-file reads and hardcoded secrets.

## Script content scanning

When enabled, PA blocks Bash tool / exec-tool commands that execute scripts via:
- `bash|sh|zsh|dash <script>`
- `bash -c "<inline>"`
- stdin-fed shells like `curl ... | bash` (by default)

The scan is intentionally **high-confidence**:
- it blocks scripts that reference common sensitive files (e.g. `/etc/shadow`, `~/.ssh/id_*`, `~/.aws/credentials`)
- it blocks scripts that appear to contain hardcoded secrets (API keys / tokens / private key blocks)

### Configuration

`settings.json`:

```json
{
  "security": {
    "scriptContentPolicy": {
      "enabled": true,
      "maxBytes": 200000,
      "denyStdinExecution": true,
      "denyMissingScriptFile": true,
      "scanInline": true
    }
  }
}
```

Notes:
- `denyMissingScriptFile: true` forces “create script first, execute later” so the pre-exec hook can validate a stable file.
- `denyStdinExecution: true` blocks `curl|bash` style execution which cannot be validated pre-run.

## Recommended defense-in-depth (beyond scanning)

Content scanning is a guardrail, not a sandbox. For stronger isolation:

1. **OS-level sandboxing**
   - Run PA in a container (rootless Docker/Podman) or bubblewrap.
   - Consider a read-only root filesystem + a single writable workspace mount.

2. **systemd hardening (user service)**
   - Use `NoNewPrivileges=true`, `PrivateTmp=true`, `ProtectSystem=strict`, `ProtectHome=true` (or `read-only`),
     `ReadWritePaths=` (workspace only), `RestrictAddressFamilies=`, `SystemCallFilter=`, and disable device access.

3. **Egress/network controls**
   - If feasible, restrict outbound traffic to only required endpoints (Telegram/Slack/OpenAI, etc.).
   - This limits “exfiltration” even if a prompt injection slips through.

4. **Secrets hygiene**
   - Prefer environment-only secrets (systemd `EnvironmentFile=`) and keep them out of the workspace.
   - Minimize scopes (OAuth least privilege), rotate tokens, and separate “integration” tokens per environment.

5. **Stricter exec policy (OpenClaw-inspired)**
   - Treat inline evaluation forms as higher risk (`bash -c`, `node -e`, `python -c`) and either block them or require explicit approval.
   - Prefer “file binding”: only execute a single concrete file operand that exists and can be hashed/validated before run.

