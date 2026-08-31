#!/usr/bin/env bash
# Endpoint parity check: Electron preload vs Wails bridge.
# Usage: endpoint-parity-check.sh [repo-root]   (defaults to ~/Projects/alice-agent)
# Exit 0 = full parity; 1 = missing methods; 2 = source files not found.
set -u
ROOT="${1:-$HOME/Projects/alice-agent}"
PRELOAD="$ROOT/apps/desktop/electron/preload.cjs"
BRIDGE="$ROOT/apps/desktop/src/lib/wails-bridge.ts"

[ -f "$PRELOAD" ] || { echo "preload not found: $PRELOAD"; exit 2; }
[ -f "$BRIDGE" ] || { echo "bridge not found: $BRIDGE"; exit 2; }

# -- Top-level surface: window.aliceDesktop.* -------------------------------
# Electron preload: two-space-indented keys inside exposeInMainWorld({ ... })
grep -oP "^  \w+:" "$PRELOAD" | tr -d ' :' | sort -u > /tmp/ele_top.txt
# Wails bridge: four-space-indented keys inside `window.aliceDesktop = { ... }`
sed -n '/window\.aliceDesktop = {/,/^  };$/p' "$BRIDGE" \
  | grep -oP "^    \w+:" | tr -d ' :' | sort -u > /tmp/wails_top.txt

MISSING=$(comm -23 /tmp/ele_top.txt /tmp/wails_top.txt)
EXTRA=$(comm -13 /tmp/ele_top.txt /tmp/wails_top.txt)

FAIL=0
if [ -n "$MISSING" ]; then
  echo "MISSING in Wails bridge:"
  printf '  %s\n' $MISSING
  FAIL=1
else
  echo "Top-level parity: $(wc -l < /tmp/wails_top.txt)/$(wc -l < /tmp/ele_top.txt) OK"
fi
[ -n "$EXTRA" ] && echo "Wails-only extras (fine): $(echo $EXTRA | tr '\n' ' ')"

# -- git.review completeness (11 methods per the preload contract) ----------
# review methods are indented 8 spaces inside the 6-space `review: {` block
GITBLOCK=$(sed -n '/git: {/,/terminal: {/p' "$BRIDGE")
for m in list diff stage unstage revert revParse commit commitContext push shipInfo createPr; do
  echo "$GITBLOCK" | grep -q "        $m:" || { echo "MISSING git.review.$m"; FAIL=1; }
done
if [ "$FAIL" -eq 0 ]; then echo "git.review: 11/11 OK"; fi

exit $FAIL
