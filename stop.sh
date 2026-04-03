#!/bin/bash
# Stop any running personal assistant processes.

echo "=== Personal Assistant — Stop ==="

# Find and stop any running daemon processes
PIDS=$(pgrep -f "personal-assistant.*daemon" 2>/dev/null || true)
if [ -n "$PIDS" ]; then
  echo "Stopping daemon processes: $PIDS"
  kill $PIDS 2>/dev/null || true
  sleep 1
  # Force kill if still running
  kill -9 $PIDS 2>/dev/null || true
  echo "Daemon stopped."
else
  echo "No running daemon found."
fi

# Stop any integ-api processes (future feature)
INTEG_PIDS=$(pgrep -f "integ-api.*serve" 2>/dev/null || true)
if [ -n "$INTEG_PIDS" ]; then
  echo "Stopping integ-api processes: $INTEG_PIDS"
  kill $INTEG_PIDS 2>/dev/null || true
  echo "Integ-api stopped."
fi

echo "All services stopped."
