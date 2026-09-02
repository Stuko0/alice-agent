#!/bin/bash
# Package the built Wails binary as an AppImage.
#
# Assembles a minimal AppDir (binary + .desktop entry + icon) using runtime
# AppImage tooling conventions, then runs appimagetool to produce the .AppImage.
# appimagetool is fetched on demand (official GitHub release) so the packaging
# host needs no preinstalled tooling.
#
# Usage:
#   ./package-appimage.sh [path-to-alice-desktop-binary] [version]
#   defaults: build/bin/alice-desktop, from wails.json productVersion

set -euo pipefail

cd "$(dirname "$0")/.."

BIN="${1:-$(pwd)/build/bin/alice-desktop}"
VERSION="${2:-0.23.1}"
ARCH=$(uname -m)
case "$ARCH" in
  x86_64) APPIMAGE_ARCH="x86_64" ;;
  aarch64|arm64) APPIMAGE_ARCH="aarch64" ;;
  *) echo "unsupported arch: $ARCH" >&2; exit 1 ;;
esac

if [ ! -x "$BIN" ]; then
  echo "binary not found: $BIN (run ./build.sh first)" >&2
  exit 1
fi

STAGING="$(mktemp -d)"
APP_DIR="$STAGING/AliceAgent.AppDir"
OUT="$(pwd)/build/bin/alice-desktop-${VERSION}-${APPIMAGE_ARCH}.AppImage"
ICON_SRC="$(pwd)/../desktop/assets/icon.png"

cleanup() { rm -rf "$STAGING"; }
trap cleanup EXIT

mkdir -p "$APP_DIR/usr/bin" "$APP_DIR/usr/share/applications" "$APP_DIR/usr/share/icons/hicolor/256x256/apps"

# RPM/AppImage launch entry
cp "$BIN" "$APP_DIR/usr/bin/alice-desktop"

[ -f "$ICON_SRC" ] && cp "$ICON_SRC" "$APP_DIR/usr/share/icons/hicolor/256x256/apps/alice-desktop.png"

cat > "$APP_DIR/AliceAgent.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Alice Agent Desktop
Comment=Native desktop shell for Alice Agent
Exec=alice-desktop
Icon=alice-desktop
Terminal=false
Categories=Utility;Development;
StartupWMClass=alice-desktop
EOF
cp "$APP_DIR/AliceAgent.desktop" "$APP_DIR/usr/share/applications/alice-desktop.desktop"

cat > "$APP_DIR/AppRun" <<EOF
#!/bin/sh
HERE="\$(dirname "\$(readlink -f "\$0")")"
export ALICE_DESKTOP_HOME="\$HERE"
exec "\$HERE/usr/bin/alice-desktop" "\$@"
EOF
chmod +x "$APP_DIR/AppRun"

# appimagetool (official release; skip if already installed on PATH).
if ! command -v appimagetool >/dev/null 2>&1; then
  TOOL="$STAGING/appimagetool-${APPIMAGE_ARCH}.AppImage"
  URL="https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-${APPIMAGE_ARCH}.AppImage"
  echo "downloading appimagetool from $URL ..."
  curl -fsSL -o "$TOOL" "$URL"
  chmod +x "$TOOL"
  APPIMAGETOOL="$TOOL"
else
  APPIMAGETOOL="appimagetool"
fi

echo "Building AppImage -> $OUT"
"$APPIMAGETOOL" --appimage-extract-and-run "$APP_DIR" "$OUT" \
  || "$APPIMAGETOOL" "$APP_DIR" "$OUT"

echo "AppImage: $OUT"