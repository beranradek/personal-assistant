# Install Script Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create `install.sh` at the repo root that installs all prerequisites (git, Node.js 22+ via nvm, Claude Code) and then builds + links the `pa` CLI on Ubuntu/Debian Linux.

**Architecture:** Single Bash script with idempotent `ensure_*` functions, colored output (`✓`/`→`/`✗`), and a final summary. Each function is a no-op if the requirement is already satisfied — safe to re-run.

**Tech Stack:** Bash, apt, nvm, Claude Code native installer (`curl -fsSL https://claude.ai/install.sh | bash`), npm

**Design doc:** `docs/plans/2026-02-25-install-script-design.md`

---

### Task 1: Write install.sh

**Files:**
- Create: `install.sh`

**Step 1: Write the script**

Create `install.sh` with the following content:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

ok()   { echo -e "  ${GREEN}✓${NC} $*"; }
info() { echo -e "  ${YELLOW}→${NC} $*"; }
fail() { echo -e "  ${RED}✗${NC} $*"; exit 1; }

echo ""
echo "[personal-assistant installer]"
echo ""

# ── 1. git ───────────────────────────────────────────────────────────────────

ensure_git() {
  if command -v git &>/dev/null; then
    ok "git $(git --version | awk '{print $3}') found"
    return
  fi
  info "git not found, installing..."
  sudo apt-get update -qq && sudo apt-get install -y git || fail "Failed to install git"
  ok "git $(git --version | awk '{print $3}') installed"
}

# ── 2. Node.js 22+ via nvm ───────────────────────────────────────────────────

NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

source_nvm() {
  # shellcheck source=/dev/null
  [ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
}

node_version_ok() {
  command -v node &>/dev/null || return 1
  local major
  major=$(node --version | sed 's/v//' | cut -d. -f1)
  [ "$major" -ge 22 ]
}

ensure_node() {
  source_nvm
  if node_version_ok; then
    ok "node $(node --version) found"
    return
  fi

  info "node 22+ not found, installing via nvm..."

  if ! command -v nvm &>/dev/null && [ ! -s "$NVM_DIR/nvm.sh" ]; then
    info "installing nvm..."
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/HEAD/install.sh | bash \
      || fail "Failed to install nvm"
    source_nvm
  else
    source_nvm
  fi

  nvm install 22 || fail "Failed to install Node.js 22 via nvm"
  nvm use 22
  nvm alias default 22

  ok "node $(node --version) installed"
}

# ── 3. Claude Code ───────────────────────────────────────────────────────────

ensure_claude_code() {
  if command -v claude &>/dev/null; then
    ok "claude $(claude --version 2>/dev/null || echo 'found') found"
    return
  fi
  info "claude not found, installing via official installer..."
  curl -fsSL https://claude.ai/install.sh | bash \
    || fail "Failed to install Claude Code"
  ok "claude installed"
}

# ── 4. Build personal-assistant ──────────────────────────────────────────────

build_pa() {
  info "installing npm dependencies..."
  npm install || fail "npm install failed"

  info "building personal-assistant..."
  npm run build || fail "npm run build failed"

  info "linking pa globally..."
  npm link || fail "npm link failed"

  ok "pa linked globally"
}

# ── 5. Initialize config ─────────────────────────────────────────────────────

init_pa() {
  if [ -f "$HOME/.personal-assistant/settings.json" ]; then
    ok "pa already initialized (~/.personal-assistant/settings.json exists)"
    return
  fi
  info "running pa init..."
  pa init || fail "pa init failed"
  ok "pa init done"
}

# ── Run all steps ─────────────────────────────────────────────────────────────

ensure_git
ensure_node
ensure_claude_code
build_pa
init_pa

echo ""
echo "Done! Run: pa terminal"
echo ""
```

**Step 2: Make it executable**

```bash
chmod +x install.sh
```

**Step 3: Verify the script is syntactically valid**

```bash
bash -n install.sh
```
Expected: no output (success).

**Step 4: Do a dry-run smoke test on a machine with all prereqs already installed**

```bash
./install.sh
```
Expected output (all items already installed):
```
[personal-assistant installer]

  ✓ git 2.x.x found
  ✓ node vXX.x.x found
  ✓ claude X.x.x found
  → installing npm dependencies...
  → building personal-assistant...
  → linking pa globally...
  ✓ pa linked globally
  ✓ pa already initialized (~/.personal-assistant/settings.json exists)

Done! Run: pa terminal
```

**Step 5: Commit**

```bash
git add install.sh docs/plans/2026-02-25-install-script-design.md docs/plans/2026-02-25-install-script.md
git commit -m "feat: add install.sh for prerequisites and pa setup"
```
