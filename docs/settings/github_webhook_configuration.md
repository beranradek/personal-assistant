# How to set up the GitHub Webhook adapter

The GitHub Webhook adapter lets GitHub trigger the assistant when:

- an issue is **assigned** to your bot user, or
- someone **mentions** your bot user in an issue body, or
- someone **mentions** your bot user in an issue comment.

The adapter verifies requests using the GitHub webhook secret (`X-Hub-Signature-256`) and posts replies back to the originating issue via the GitHub CLI (`gh`).

## 0. Prerequisites

- A publicly reachable **HTTPS** URL (recommended: reverse proxy)
- GitHub webhook secret (random string)
- `gh` CLI installed and authenticated as a GitHub user that can comment on issues/PRs in the target repo

### Authenticate `gh`

Either:

- Interactive login: `gh auth login`
- Or provide a token via env: set `GH_TOKEN=...` (recommended for headless/systemd)

## 1. Configure settings.json

Edit `~/.personal-assistant/settings.json`:

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

Notes:
- Keep `bind` on `127.0.0.1` and put the endpoint behind a reverse proxy.
- `botLogin` must match the GitHub username that will be mentioned (without `@`).

## 2. Configure secrets for the daemon

If you run via systemd user service, store secrets in `~/.personal-assistant/.env`:

```bash
PA_GITHUB_WEBHOOK_SECRET=...
GH_TOKEN=...
```

Permissions:

```bash
chmod 600 ~/.personal-assistant/.env
```

## 3. Expose the webhook endpoint (reverse proxy)

You need a public HTTPS URL that forwards to `http://127.0.0.1:19210/personal-assistant/github/webhook`.

Example (conceptually):

- Public URL: `https://your-domain.example/personal-assistant/github/webhook`
- Local target: `http://127.0.0.1:19210/personal-assistant/github/webhook`

## 4. Create a webhook in the GitHub repository

In your GitHub repo:

1. Settings → Webhooks → Add webhook
2. Payload URL: your public HTTPS URL (same path as `settings.json:path`)
3. Content type: `application/json`
4. Secret: the same value as `PA_GITHUB_WEBHOOK_SECRET`
5. Events: enable at least:
   - Issues
   - Issue comments

Then click “Add webhook” and use “Recent Deliveries” to verify that you get `202` responses.

## 5. How to trigger the assistant

- Assign the issue to `@your-bot-login`, or
- Mention it:
  - `@your-bot-login implement`
  - `@your-bot-login fix`
  - `@your-bot-login rebase`
  - `@your-bot-login continue`

If a mention has no recognized command (or an unknown one), the webhook still triggers, but no command hint is attached.

## 6. Repository checkout (recommended)

The assistant will typically work inside its workspace (default: `~/.personal-assistant/workspace/`).
For GitHub issue work, keep your target repositories checked out under:

- `~/.personal-assistant/workspace/dev/<repo-name>/`

If the repository is not present yet, the assistant can clone it (via `gh`):

```bash
cd ~/.personal-assistant/workspace/dev
gh repo clone OWNER/REPO
```

Notes:
- For **private** repositories, ensure `gh` is authenticated with access (recommended for headless/systemd: set `GH_TOKEN=...`).
- Make sure the repo’s toolchain is installed (Node/pnpm, Python, etc.) so the assistant can run tests/builds.
