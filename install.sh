#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

ok()   { printf "  ${GREEN}✓${NC} %s\n" "$*"; }
info() { printf "  ${YELLOW}→${NC} %s\n" "$*"; }
fail() { printf "  ${RED}✗${NC} %s\n" "$*"; exit 1; }

printf "\n"
printf "[personal-assistant installer]\n"
printf "\n"

# ── 0. Platform check ────────────────────────────────────────────────────────

check_platform() {
  if [ ! -f /etc/os-release ]; then
    fail "This installer only supports Ubuntu/Debian Linux"
  fi
  # shellcheck source=/dev/null
  source /etc/os-release
  case "${ID:-}" in
    ubuntu|debian) ;;
    *) fail "This installer only supports Ubuntu/Debian (detected: ${ID:-unknown})" ;;
  esac
}

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
NVM_VERSION="v0.40.1"

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

  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    info "installing nvm..."
    curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" | bash \
      || fail "Failed to install nvm"
  fi
  source_nvm

  nvm install 22 || fail "Failed to install Node.js 22 via nvm"
  nvm use 22
  nvm alias default 22
  node_version_ok || fail "Node.js 22+ still not available after nvm install"

  ok "node $(node --version) installed"
}

# ── 3. Claude Code ───────────────────────────────────────────────────────────

ensure_claude_code() {
  if command -v claude &>/dev/null; then
    ok "claude $(claude --version 2>/dev/null || echo 'found') found"
    return
  fi
  info "claude not found, installing via official installer..."
  local _installer
  _installer="$(mktemp)"
  curl -fsSL https://claude.ai/install.sh -o "$_installer" \
    || fail "Failed to download Claude Code installer"
  bash "$_installer"
  rm -f "$_installer"
  ok "claude installed"
}

# ── 4. Build personal-assistant ──────────────────────────────────────────────

build_pa() {
  cd "$SCRIPT_DIR"
  info "installing npm dependencies..."
  npm install || fail "npm install failed"

  info "building personal-assistant..."
  npm run build || fail "npm run build failed"

  info "linking pa globally..."
  npm link || fail "npm link failed"
  hash -r 2>/dev/null || true   # refresh command hash so 'pa' is found immediately

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

check_platform
ensure_git
ensure_node
ensure_claude_code
build_pa
init_pa

printf "\n"
printf "Done! Run: pa terminal\n"
printf "\n"
