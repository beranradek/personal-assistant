#!/bin/bash
# Start the personal assistant development environment.
# Can be run from any worktree directory.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== Personal Assistant — Development Start ==="

# Install dependencies if node_modules is missing or stale
if [ ! -d "$SCRIPT_DIR/node_modules" ] || [ "$SCRIPT_DIR/package.json" -nt "$SCRIPT_DIR/node_modules/.package-lock.json" ]; then
  echo "Installing dependencies..."
  cd "$SCRIPT_DIR" && npm install
fi

# Build TypeScript
echo "Building TypeScript..."
cd "$SCRIPT_DIR" && npm run build

echo ""
echo "Development environment ready."
echo "  Terminal mode:  cd $SCRIPT_DIR && npm run terminal"
echo "  Daemon mode:    cd $SCRIPT_DIR && npm run daemon"
echo "  Run tests:      cd $SCRIPT_DIR && npm test"
echo ""
echo "No long-running servers to start — the PA runs on-demand via CLI."
