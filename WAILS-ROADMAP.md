# Wails Roadmap — cómo aprovechar mejor el shell Wails

Estado al 2026-08-31. Wails v2.15 es el runtime por defecto del desktop; este
reporte ordena por prioridad lo que falta para que Wails reemplace a Electron
por completo y saque partido de lo que un shell nativo Go ofrece.

---

## P0 — Bloqueantes para deprecar Electron

### 1. Self-update en Go (`UpdateService`) — ✅ HECHO (2026-08-31)
`apps/desktop-wails/update_service.go` implementa el flujo completo:
- `Check()` — distancia vs la rama configurada (ls-remote, sin fetch).
- `Apply()` — `alice update --yes --branch <pin>` → `alice desktop --build-only`
  (rebuild del binario Wails) → watcher detached (bash/PowerShell) que
  re-exec el binario fresco cuando el proceso viejo sale.
- Branch pin persistido (`~/.alice/desktop-update-config.json`), env
  `ALICE_DESKTOP_CHILD_PID` para que `alice update` no mate el backend propio,
  progreso vía `runtime.EventsEmit("alice:updates:progress")`.
- Wireado al bridge (`wails-bridge.ts` updates.* real + `onProgress` vía
  `window.runtime.EventsOn`) y al `Bind` de main.go. Tests Go: 5 tests
  (check up-to-date / behind / no-git, shell quoting, venv bin, CLI resolution).

### 2. Deprecar electron-builder Windows — ✅ HECHO (2026-08-31)
- `dist:win*` eliminados de `apps/desktop/package.json`.
- Job `build` (NSIS/MSI) + `smoke-test` eliminados del workflow; queda solo
  `wails-build` (binario + checksum).
- `install.ps1`: eliminado el fallback Electron de `Install-Desktop` y todos
  los helpers de Electron (cache/dist); sin binario Wails → mensaje accionable.
- `resolve_alice_desktop_exe` (bootstrap Tauri) resuelve SOLO el binario Wails
  (+ bundle .app en macOS); tests actualizados.
- Docs: nota "Electron es EOL en Windows" en `website/docs/user-guide/desktop.md`.

## P1 — Paridad de producto con Electron

### 3. Remote gateway (`ConnectionService`)
Conectarse a un `alice serve` remoto: ProxyApi routing + URL WS remota.
Hoy el bridge solo soporta backend local (`127.0.0.1`). Es lo que permite el
modo "lite client" (GUI sin agente local).

### 4. Deep links (`alice://`)
Electron registra el protocolo `alice` (NSIS/plist). Wails v2 no lo maneja
nativo: hay que registrar el protocolo en Windows (registro) / macOS
(LSSetDefaultHandlerForURLScheme) / Linux (xdg-mime) y pasar la URL al
frontend. Incluye single-instance lock para rutear el link a la ventana activa.

### 5. Tray + notificaciones
- Tray: Wails v2 no trae systray; integrar `getlantern/systray` (o migrar a
  v3 que lo trae nativo). Menú rápido: nuevo chat, gateway on/off, quit.
- Notificaciones: `go-toast` ya está en go.mod (Windows) — wire a los eventos
  de gateway (mensaje recibido con la ventana minimizada).

### 6. Menús nativos + dialogs vía runtime
- Reemplazar los probes PowerShell/zenity/kdialog de `fs_service.go` por
  `runtime.OpenFileDialog/SaveFileDialog/MessageDialog` (menos subprocesos,
  mejor integración).
- Menú de aplicación nativo (Wails v2 `runtime.Menu`).

### 7. Persistencia de estado de ventana
Guardar/restaurar tamaño+posición (y maximizado) por perfil. Electron ya lo
hace (`window-state`); el shell Go no.

## P2 — Calidad y experiencia

### 8. PTY real en Windows (ConPTY)
El terminal integrado en Windows usa pipes (sin resize). Migrar a ConPTY
(`github.com/UserExistsError/conpty` o `microsoft/go-winio`) para resize y
ANSI correctos. Hoy degrada a no-interactivo.

### 9. E2E del shell Wails
El side Electron tiene suites `node --test` (~300 tests). El Go necesita:
- Tests unitarios de servicios (PythonManager, FSService, PTYService, GitService).
- Test E2E de boot: `WaitForHealthy` → WS conectado → overlay desaparece
  (hay scripts y el diagnóstico del skill para esto).
- `scripts/endpoint-parity-check.sh` ya cubre el bridge — correrlo en CI.

### 10. Firma Authenticode en CI (Windows)
El `alice-desktop.exe` publicado por `wails-build` no está firmado. Firma con
el certificado existente para evitar SmartScreen. (Linux/macOS: AppImage/deb
y notarización cuando haya target macOS.)

### 11. Distribución Linux del binario Wails
Hoy solo existe build manual (`build.sh`). Empaquetar AppImage/deb/rpm del
binario Wails para el `alice desktop` instalado por el usuario.

## P3 — Estratégico

### 12. Migrar a Wails v3
v3 trae tray nativo, menus, single-instance, mejor webview (webkitgtk-6.0).
**Bloqueante hoy:** Fedora 43 tiene webkit2gtk-4.0; v3 necesita 6.0. Migrar
cuando las distros lo tengan. La arquitectura actual (servicios Go + bridge)
está preparada: solo cambiaría `main.go` + runtime.

### 13. Backend embebido en el binario
Hoy el Go spawna `alice serve` (venv + PYTHONPATH). Opción a futuro: embeber
el Python (embed bundle + site-packages) como extraResource del binario Wails
— elimina la dependencia del venv del sistema y acerca el instalador a
"un solo archivo". Costo alto (tamaño); evaluar después del UpdateService.

### 14. Telemetría de uso local
Métricas locales (boot time, WS reconnect, errores de bridge) a
`~/.alice/logs/` para diagnosticar sin DevTools (el webview no tiene
DevTools en producción; hoy se usa el overlay + localStorage `wail-logs`).

---

## Orden sugerido de ejecución

1. **UpdateService** (P0-1) → habilita la deprecación de Electron (P0-2).
2. **Deep links + single-instance** (P1-4) y **tray** (P1-5) — el mayor gap
   visible de UX vs Electron.
3. **Dialogs nativos** (P1-6) — quita los subprocesos PowerShell/zenity.
4. **ConPTY** (P2-8) — calidad del terminal en Windows.
5. **Firma + distribución Linux** (P2-10/11) — publicación real del binario.
6. **E2E shell** (P2-9) — antes de tocar más features.
7. **Wails v3** (P3-12) — planificar cuando webkitgtk-6.0 esté disponible.

Cada ítem tiene su blueprint/patrón en
`~/.alice/skills/software-development/alice-desktop-wails/`
(`references/wails-unsupportable-features.md`, `references/electron-wails-endpoint-parity.md`,
`references/wails-performance.md`).
