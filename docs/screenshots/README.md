# Desktop screenshots

Captured by the `build-desktop-windows.yml` smoke job on a GitHub `windows-latest`
runner (Windows 11), after installing the NSIS package silently and launching the
real app:

- `windows11-boot.png` — first launch, boot overlay reporting the backend port.
- `windows11-first-run-tour.png` — the first-run tour on a configured install
  (provider connected via OpenCode Go).
- `windows11-chat-reply.png` — the app answering through `hy4-flash-free`
  ("Hola, responde solo OK" → "OK"), model chip and gateway status visible.

The job takes the screenshots itself (see the "Launch and wait for the backend
to announce a port" step) and uploads them as the `alice-windows-desktop`
artifact, so they track the shipped binary instead of going stale.
