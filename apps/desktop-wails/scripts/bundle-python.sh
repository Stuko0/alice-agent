#!/bin/bash
# bundle-python.sh — assemble a self-contained Python backend beside the Wails
# binary (resources/python) so the desktop does not depend on a system venv.
#
# The bundle is a uv-managed CPython (python-build-standalone) — a fully
# self-contained runtime with its own stdlib and pip — with the alice-agent
# project and its dependencies installed into its site-packages. Layout matches
# the POSIX fallbacks in python_manager.go (findPythonForRoot / findVenvRoot /
# getVenvSitePackages):
#   resources/python/bin/python3
#   resources/python/lib/python3.X/site-packages/
#
# Usage:
#   ./bundle-python.sh [python-version] [dest]
#     python-version  default 3.14 (must match what alice supports)
#     dest            default build/bin/resources/python
#
# Requires: uv (provisions the standalone CPython). The project+deps install
# pulls from PyPI and can take several minutes — run it in the background.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

PYVER="${1:-3.14}"
DEST="${2:-$SCRIPT_DIR/../build/bin/resources/python}"

command -v uv >/dev/null 2>&1 || { echo "uv not found (needed to provision the standalone CPython)" >&2; exit 1; }

# 1. Provision the STANDALONE CPython into a fresh staging dir. --install-dir
#    guarantees we get the python-build-standalone (self-contained) rather than
#    resolving the project's .venv, which `uv python find` would happily return.
STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT
uv python install --install-dir "$STAGING" "$PYVER" >&2

SRC_ROOT="$(find "$STAGING" -maxdepth 1 -type d -name 'cpython-*' | head -1)"
[ -n "$SRC_ROOT" ] || { echo "could not locate standalone CPython in $STAGING" >&2; exit 1; }
echo "standalone cpython source: $SRC_ROOT" >&2

# 2. Copy the self-contained runtime into the bundle. cp -a preserves the
#    relative bin->lib symlinks (python3 -> python3.14), keeping it relocatable.
rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
cp -a "$SRC_ROOT"/. "$DEST"/

# 3. Install alice-agent + deps into the bundle. Use the bundle's own pip
#    (python-build-standalone ships it) and run from the repo root so `pip
#    install .` finds pyproject.toml.
cd "$REPO_ROOT"
echo "installing alice-agent (+deps) into $DEST ... (this pulls from PyPI)" >&2
# --break-system-packages: python-build-standalone ships PEP 668
# EXTERNALLY-MANAGED; this bundle IS the managed package, so bypass it.
"$DEST/bin/python3" -m pip install --break-system-packages --no-input --quiet . 

# 4. Smoke test: the bundled python must import alice_cli.
echo "smoke test: importing alice_cli from the bundle ..." >&2
ALICE_HOME="$(mktemp -d)" "$DEST/bin/python3" -c "import alice_cli; print('alice_cli OK, version', alice_cli.__version__)"

# 5. Package a distributable tar.gz of the bundle beside it, so installers can
#    ship it as a release artifact instead of rebuilding it on the user's
#    machine. Produces <parent>/python.tar.gz (contains resources/python/...).
BUNDLE_PARENT="$(dirname "$DEST")"
echo "packaging $BUNDLE_PARENT/python.tar.gz ..." >&2
tar -czf "$BUNDLE_PARENT/python.tar.gz" -C "$BUNDLE_PARENT" python

echo "bundle ready: $DEST"
echo "  python: $DEST/bin/python3"
echo "  distributable: $BUNDLE_PARENT/python.tar.gz"
du -sh "$DEST" 2>/dev/null || true