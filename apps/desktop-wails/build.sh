#!/bin/bash
# Build script for Wails desktop app
# Builds frontend, copies Wails bindings, then builds the binary

set -e

cd "$(dirname "$0")"

echo "=== Building Wails bindings first ==="
wails generate bindings 2>/dev/null || true

echo "=== Copying bindings to desktop source ==="
mkdir -p ../desktop/src/lib/wailsjs/go/main
cp frontend/wailsjs/go/main/*.js ../desktop/src/lib/wailsjs/go/main/ 2>/dev/null || true
cp frontend/wailsjs/go/main/*.d.ts ../desktop/src/lib/wailsjs/go/main/ 2>/dev/null || true
cp frontend/wailsjs/go/models.ts ../desktop/src/lib/wailsjs/go/ 2>/dev/null || true

echo "=== Building frontend ==="
cd ../desktop
npm run build

echo "=== Copying frontend to Wails ==="
cd ../desktop-wails
rm -rf frontend/dist
cp -r ../desktop/dist frontend/dist

echo "=== Copying bindings to frontend dist ==="
mkdir -p frontend/dist/assets/wailsjs/go/main
cp frontend/wailsjs/go/main/*.js frontend/dist/assets/wailsjs/go/main/ 2>/dev/null || true
cp frontend/wailsjs/go/main/*.d.ts frontend/dist/assets/wailsjs/go/main/ 2>/dev/null || true
cp frontend/wailsjs/go/models.ts frontend/dist/assets/wailsjs/go/ 2>/dev/null || true

echo "=== Building Wails binary ==="
wails build

echo "=== Done ==="
echo "Binary: build/bin/alice-desktop"
