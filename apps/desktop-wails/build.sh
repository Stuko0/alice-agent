#!/bin/bash
# Build script for Wails desktop app
# Builds frontend, copies Wails bindings, then builds the binary
#
# Usage:
#   ./build.sh                 # binary only -> build/bin/alice-desktop
#   ./build.sh deb|rpm|apk     # binary + native package via Wails/nfpm
#   ./build.sh appimage        # binary + AppImage via scripts/package-appimage.sh
#
# By default it also bundles a self-contained Python backend beside the binary
# (build/bin/resources/python) so the desktop does not depend on a system venv.
# Set ALICE_SKIP_PYTHON_BUNDLE=1 to skip (faster local iteration; the backend
# then falls back to a system venv).

set -e

cd "$(dirname "$0")"

PACKAGE="${1:-}"

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
if [ -n "$PACKAGE" ] && [ "$PACKAGE" != "appimage" ]; then
  wails build -package "$PACKAGE"
  echo "=== Package produced in build/bin/ ==="
  ls -1 build/bin/ | grep -Ei "\.(deb|rpm|apk)$" || true
elif [ "$PACKAGE" == "appimage" ]; then
  wails build
  ./scripts/package-appimage.sh
else
  wails build
fi

# Bundle a self-contained Python backend beside the binary (resources/python)
# so the desktop does not depend on a system venv. Takes minutes (PyPI pull);
# skip when the env var is set or when uv is absent.
if [ "${ALICE_SKIP_PYTHON_BUNDLE:-0}" != "1" ] && command -v uv >/dev/null 2>&1; then
  echo "=== Bundling embedded Python backend ==="
  ./scripts/bundle-python.sh "build/bin/resources/python" || \
    echo "!! python bundle failed (build continues; desktop needs a system venv)"
fi

echo "=== Done ==="
echo "Binary: build/bin/alice-desktop"