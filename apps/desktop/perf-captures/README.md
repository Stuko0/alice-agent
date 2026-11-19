# Interaction captures

Drop latency captures here (one JSON per capture) to have CI compare them
against `../perf-baseline.json` and publish them as a workflow artifact.

Capture on the real shell (no Electron/CDP needed):

1. `cd apps/desktop-wails && wails dev`
2. Use the app (git pane, terminal, browser tabs, graphify, session switch).
3. Settings → About → **Interaction latency** → **Copy JSON**
4. Save the clipboard as `perf-captures/<machine>-<date>.json`

Then: `node apps/desktop/scripts/measure-interactions.mjs --import=<file> --baseline=apps/desktop/perf-baseline.json`
