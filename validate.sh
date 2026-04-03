#!/bin/bash
# Validation gates for merge orchestrator.
# Each gate runs independently — do NOT use set -e.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "::gate::build"
npm run build 2>&1
echo "::endgate::$?"

echo "::gate::test"
npx vitest run 2>&1
echo "::endgate::$?"
