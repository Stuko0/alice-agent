#!/bin/bash
# Verify and run the Wails desktop app
# Usage: ./run.sh

set -e

cd "$(dirname "$0")"

echo "=== Alice Desktop Launcher ==="
echo ""

# Kill existing processes
echo "→ Killing existing processes..."
pkill -f "alice-desktop" 2>/dev/null || true
pkill -f "alice_cli.main serve" 2>/dev/null || true
sleep 2

# Check if build exists
if [ ! -f "build/bin/alice-desktop" ]; then
    echo "→ No build found. Building..."
    ./build.sh
else
    echo "→ Build found: build/bin/alice-desktop"
    echo "→ Build time: $(stat -c '%y' build/bin/alice-desktop)"
fi

# Clean old logs
rm -f /tmp/wails-debug.log /tmp/wails-errors.log

echo ""
echo "=== Starting Alice Desktop ==="
echo "→ Logs: /tmp/wails-debug.log"
echo "→ Errors: /tmp/wails-errors.log"
echo "→ Press Ctrl+C to stop"
echo ""

# Run the app
./build/bin/alice-desktop

echo ""
echo "=== App exited ==="
echo ""

# Show errors if any
if [ -f /tmp/wails-errors.log ]; then
    echo "=== Errors detected ==="
    cat /tmp/wails-errors.log
fi

echo ""
echo "=== Last 30 lines of debug log ==="
tail -30 /tmp/wails-debug.log 2>/dev/null || echo "No debug log"
