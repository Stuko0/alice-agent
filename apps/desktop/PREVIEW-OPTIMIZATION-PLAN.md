# Plan: Optimización de recursos y renderizado del Preview en Alice Desktop (Wails + Electron)

> Estado: **implementado P0–P3** (2026-11-14). Ver "Estado de implementación" abajo para el
> mapeo fase → archivos → pruebas. Alcance: `apps/desktop/src` (renderer compartido),
> `apps/desktop-wails/*` (shell Wails en Go), `apps/desktop/electron/*` (solo cambios de paridad).
> Restricciones del repo que aplican: sin nuevas `ALICE_*` env vars para config no-secreta
> (todo en config/bridge, no `.env`); dependencias nuevas con pin de versión/supply-chain policy;
> TypeScript style del repo (nanostores, hooks pequeños, `interface` para props); tests nunca
> escriben en `~/.alice` real (temp dirs). Servidor HTTP local de preview: solo `127.0.0.1`,
> token efímero en memoria, nunca bind a `0.0.0.0`.

## Estado de implementación

| Fase | Estado | Archivos principales | Evidencia |
|---|---|---|---|
| P0.1 origen HTTP local | ✅ | `apps/desktop-wails/preview_server.go`, `main.go`, `lib/wails-bridge.ts`, `lib/desktop-fs.ts`, `lib/local-preview.ts`, `preview-pane.tsx` | `preview_server_test.go`, `preview_server_fixtures_test.go`, `preview-pane.wails.test.tsx` |
| P0.2 sandbox + CSP | ✅ | `preview-pane.tsx` (`WAILS_PREVIEW_SANDBOX`), `preview_server.go` (`previewCSP`) | `preview-pane.wails.test.tsx`, `TestPreviewServerHeaders` |
| P0.3 diagnóstico/fallback | ✅ | `preview-pane.tsx` (`forceSource`, timeout 15s, retry con `__alice_preview_reload`, "View source"), i18n ×4 | `preview-pane.fallback.test.tsx` (overlay, retry, open-external, source sin segundo origen, timeout), `preview-pane.wails.test.tsx` (source mode) |
| P0.4 normalización Go | ✅ | `preview_normalize.go`, `wails-bridge.ts`, `App.d.ts`/`App.js`/`models.ts` | `preview_normalize_test.go` |
| P1.1 stat + lectura acotada | ✅ | `fs_service.go` (`StatFile`, `ReadFileTextLimit…`, cap de escritura), `desktop-fs.ts` | `fs_service_test.go` |
| P1.2 imágenes por URL + thumbnails | ✅ | `preview_server.go` (`StartForImage`, caché LRU, downscale stdlib), `preview-file.tsx` | `TestPreviewServerImageThumbnailAndCache`, `TestPreviewServerThumbnailsGeneratedFixture`, `preview-file.resources.test.tsx` |
| P1.3 diff perezoso | ✅ | `preview-file.tsx` (fetch al abrir DIFF, memoizado) | `preview-file.resources.test.tsx` |
| P1.4 markdown/highlight perezosos | ✅ | `lazy-sections.tsx`, `lib/shiki-cache.ts`, `preview-file.tsx` (plain mode >1MB/20k líneas) | `lazy-sections.test.tsx`, `shiki-cache.test.ts` |
| P2.1 working set de tabs | ✅ | `store/preview.ts` (tope 12, reapertura = MRU) | `preview-lru.test.ts` |
| P2.2 descarga de estado | ✅ | `preview-file.tsx` (stop del origen al desmontar, caché por path+mtime), `preview-text-cache.ts` | `preview-file.resources.test.tsx` (cache hit, image stop) |
| P2.3 watch selectivo | ✅ | `preview-pane.tsx` (`isActive`), `preview.tsx` (solo monta el tab activo) | `preview-pane.watch.test.tsx` |
| P3.1 telemetría dev-only | ✅ | `lib/preview-telemetry.ts`, `preview-pane.tsx`, `preview-file.tsx`, panel "Preview stats" en `preview-console.tsx` | `preview-telemetry.test.ts` |
| P3.2 fixtures + matriz | ✅ | `apps/desktop/preview-fixtures/**`, `scripts/gen-preview-fixtures.mjs`, `scripts/e2e-preview-wails.mjs`, `apps/desktop-wails/preview_e2e_test.go` | harness 15/15 (`TestPreviewE2E`), `preview_server_fixtures_test.go` + checklist/resultados en `preview-fixtures/README.md` |
| P3.3 hardening | ✅ | `preview_server.go` (denylist dotfiles/claves, traversal), `fs_service.go` (cap 10MB escritura) | `TestPreviewPathDenied`, `TestPreviewServerRejectsTraversal`, `TestWriteTextFileSizeCap` |
| P3.4 paridad + CI | ✅ | `lib/desktop-capabilities.ts` (`previewConsole`/`previewDevTools`/`previewLocalServer`), `.github/workflows/typecheck.yml`, `build-desktop-windows.yml` | `desktop-capabilities.test.ts`, `preview-pane.wails.test.tsx` (titlebar) |

### Desviaciones conscientes

- **P1.3 cap de diff a 256 KB**: no implementado (era "recomendado"). El fetch ya es perezoso y memoizado; un cap puede añadirse cuando haya evidencia de diffs patológicos.
- **P2.2 coalescing global de workspace ticks**: no se añadió un debounce global (afectaría a otros consumidores de `notifyWorkspaceChanged`); el doble trabajo se evita con la caché `path+mtime` y el debounce de 200 ms del watcher (Go + renderer).
- **P3.2 automatización GUI**: Wails/WebKitGTK no expone CDP, así que la matriz visual es manual. La parte automatizable está cubierta por `TestPreviewE2E` (15 casos, invocado por `scripts/e2e-preview-wails.mjs`) y por vitest para el wiring del renderer; las filas visuales quedan documentadas con su estado en `preview-fixtures/README.md`.
- **P0.2 `frame-ancestors`**: omitido a propósito — el documento vive en un origen loopback distinto del shell, así que `'self'` rompería el iframe. La contención real es el origen aislado + token + CSP de red.

---


## 0. Resumen del plan

| Fase | Tema | Riesgo resuelto | Tamaño |
|---|---|---|---|
| **P0** | HTML local renderizado por origen HTTP local + sandbox del iframe + diagnóstico/fallback | Fallos de HTML en Wails (assets relativos, ES modules, CORS `file://`); falta de contención | Mediano |
| **P1** | I/O escalonado (stat/rangos), imágenes sin base64, diff/markdown/highlight perezosos | Picos de RAM/CPU/IO en archivos grandes e imágenes | Grande |
| **P2** | LRU de pestañas, descarga de buffers inactivas, watch selectivo, cache por versión | Crecimiento sostenido de memoria en sesiones largas | Mediano |
| **P3** | Observabilidad, matriz E2E WebKit, hardening, paridad Electron/Wails | Regresiones silenciosas, divergence entre shells | Mediano |

Cada fase es mergible de forma independiente y deja el árbol verde (typecheck + lint + tests).

---

## P0 — Renderizado HTML local correcto y contenido

### P0.1 — Servidor HTTP local de preview (Go, Wails)

**Problema.** `PreviewPane` (rama Wails) monta `<iframe src="file://...">` para HTML local en
modo `renderMode:'preview'`. WebKit con origen `file://` bloquea/rompe assets relativos,
ES modules y `fetch` locales → HTML se ve vacío/roto. Electron lo enmascara con `<webview>`.

**Cambio.** Nuevo servicio Go `preview_server.go` en `apps/desktop-wails`:

- `PreviewServerService` con `StartForFile(path) -> {url}`:
  - Escucha en `127.0.0.1:<puerto efímero>` (solo loopback; error si no puede).
  - Genera un **token efímero por sesión de preview** (128-bit, aleatorio, en memoria; nunca
    persistido ni logueado).
  - Sirve el directorio del archivo HTML con `net/http` + `http.FileServer` custom:
    - MIME correcto por extensión (mapa completo, fallback `application/octet-stream`).
    - `index` del propio archivo HTML servido en `/p/<token>/` (ruta raíz del mount).
    - Cabeceras: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`,
      `Content-Security-Policy` razonable (ver P0.2).
  - `resolveSafe(baseDir, name)`: limpieza de path traversal (`..`), symlinks resueltos y
    **confinados a `baseDir`** (`filepath.EvalSymlinks` + `strings.HasPrefix`); fuera del
    base dir → 403.
  - `Stop(id)`: apaga el listener cuando el preview cierra; `Shutdown()` para todos.
- Binding `App.PreviewStartForFile(path) string` y `App.PreviewStop(id)` en `main.go`.
- Bridge (`wails-bridge.ts`): `previewServerForFile(path)` devuelve `http://127.0.0.1:port/p/<token>/`.
- `local-preview.ts`/`store/preview.ts`: cuando `kind:'file' && previewKind:'html' &&
  renderMode!=='source'` y shell Wails → el target de web-preview usa la URL del servidor
  local (el `path`/`source` originales se conservan para watch/edición). Electron mantiene
  `file://` + `<webview>` (sin cambio).

**Archivos.**
- Nuevo: `apps/desktop-wails/preview_server.go`, `apps/desktop-wails/preview_server_test.go`
- `apps/desktop-wails/main.go` (bindings + `Shutdown`)
- `apps/desktop/src/lib/wails-bridge.ts`, `apps/desktop/src/lib/local-preview.ts`,
  `apps/desktop/src/app/chat/right-rail/preview-pane.tsx` (selección de URL)

**Criterios de aceptación.**
- AC1: HTML local con `<link rel="stylesheet" href="./style.css">`, `<img src="./a.png">`,
  `<script type="module" src="./app.js">` y `fetch('./data.json')` renderiza **completo** en
  Wails (WebKitGTK) sin errores de CORS en consola.
- AC2: La URL servida solo es accesible desde `127.0.0.1`; desde otra interfaz el puerto
  rechaza (no bind externo).
- AC3: `GET /p/<token-incorrecto>/` → 404/403; `GET /p/<token>/../../../../etc/passwd` → 403;
  symlink que apunta fuera del base dir → 403.
- AC4: Al cerrar la pestaña de preview (o `closeRightRail`), el listener se detiene
  (puerto liberado, verificado con `net.Listen` posterior en el mismo puerto).
- AC5: El HTML en modo `source` (file-browser/manual) **no** arranca el servidor (comportamiento
  actual se conserva) y Electron no cambia de ruta de render.

**Pruebas específicas.**
- Go unit (`preview_server_test.go`, `go test ./...`):
  - `TestPreviewServerServesFileAndRelativeAssets` — temp dir con `index.html`, `style.css`,
    `app.js`, `data.json`; `httptest`-style request al handler → 200 + MIME correcto.
  - `TestPreviewServerRejectsTraversal` — `..%2f`, `..\\`, symlink externo → 403.
  - `TestPreviewServerTokenRequired` — path sin token / token inválido → 403/404.
  - `TestPreviewServerLoopbackOnly` — assert listener addr es `127.0.0.1`.
  - `TestPreviewServerStopReleasesPort` — stop + dial al puerto → conexión rechazada.
  - `TestPreviewServerNoStoreHeaders` — assert cabeceras.
- Renderer (vitest, `npm run test:ui`):
  - `preview-pane.wails-html.test.tsx`: dado target `kind:'file', previewKind:'html',
    renderMode:'preview'` en shell Wails (mock `isWailsShell()` y bridge), el iframe `src`
    apunta a la URL del servidor local (no `file://`); en modo `source` no se llama al bridge.
  - `local-preview.test.ts` (extensión del existente): target HTML preview conserva
    `path`/`source` originales y `url` resuelta vía bridge mock.
- E2E manual (Wails, ver matriz P3.2): caso AC1 en Linux.

### P0.2 — Endurecer el iframe (Wails) y CSP

**Cambio.** En `preview-pane.tsx` (rama Wails):
- `iframe.setAttribute('sandbox', PREVIEW_IFRAME_SANDBOX)` con tokens mínimos:
  `allow-scripts allow-forms allow-modals allow-popups allow-downloads` (constante exportada
  y comentada). **No** `allow-same-origin` (el servidor local ya da origen propio al contenido;
  el documento carga en origen distinto del app shell).
- Añadir `referrerpolicy="no-referrer"` y `credentialless` (si WebKit lo soporta; degradar sin error).
- CSP servida por `preview_server.go` para HTML/inline: `default-src 'self'; img-src 'self'
  data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors
  'self' http://127.0.0.1:*` (ajustable; objetivo: bloquear fetch a hosts remotos no pedidos
  explícitamente por el HTML). Los HTML quenecesiten red remota siguen abribles con
  "Abrir en navegador".

**Archivos.** `preview-pane.tsx`, `preview_server.go`, `i18n` (nuevas strings si aplica).

**Criterios de aceptación.**
- AC6: Un HTML con `fetch('https://example.com')` en preview local recibe la petición
  bloqueada por CSP (consola del preview lo registra si la superficie lo permite) y la UI
  no se rompe.
- AC7: El iframe no puede remover su sandbox por script del contenido (comportamiento del
  navegador; verificado en revisión de código + prueba manual de `top.location`).
- AC8: Formularios/modales/popups/download básicos del HTML demo siguen funcionando (tokens
  de sandbox correctos).

**Pruebas específicas.**
- Go: `TestPreviewServerCSPHeaders` (assert header `Content-Security-Policy` en respuestas HTML).
- Vitest: `preview-pane.sandbox.test.tsx` — iframe creado con atributo `sandbox` exacto
  (snapshot de atributos, no snapshot de DOM completo) y `referrerpolicy`.
- E2E manual: HTML demo con form/modal/download (asset en `apps/desktop/preview-fixtures/`).

### P0.3 — Diagnóstico y fallback de carga (Wails)

**Problema.** En Wails, `error` del iframe es genérico; el usuario ve "No se pudo cargar" sin causa.

**Cambio.**
- `preview-pane.tsx` (Wails): `onload` + sondeo ligero post-carga — si tras N ms no hay `load`,
  mostrar error con la URL efectiva; detectar página en blanco básica (document accesible por
  same-origin no lo es con sandbox, así que limitar a "timeout sin load").
- Acciones en `PreviewLoadError`: "Ver código fuente" (`renderMode:'source'` vía
  `previewTargetForSource`), "Abrir en navegador" (`openExternal`), "Reintentar". Textos i18n.
- Añadir entrada en consola de preview con la URL del servidor y hora de arranque/parada.

**Archivos.** `preview-pane.tsx`, `store/preview.ts` (helper para forzar `source`),
`src/i18n/**` (keys nuevas), tests.

**Criterios de aceptación.**
- AC9: HTML con recurso inexistente/timeout muestra el error con URL efectiva y las 3 acciones
  funcionan: source muestra el archivo, abrir externo lanza el navegador, retry re-carga.
- AC10: Cambiar a `source` y volver a `preview` no duplica servidores (mismo `id`/reuso).

**Pruebas específicas.**
- Vitest `preview-pane.fallback.test.tsx`: simula iframe sin `load` → overlay con acciones;
  click en "Ver código fuente" dispara la transición de `renderMode` en el store (mock).
- Vitest `store/preview.test.ts` (extensión): helper de cambio de renderMode respeta
  `isFilePreviewSource` y no pierde el tab activo.

### P0.4 — `normalizePreviewTarget` real en Wails (paridad)

**Cambio.** Implementar en Go (`fs_service.go` o nuevo `preview_normalize.go`) y exponer por
bridge: dado `rawTarget` + `cwd`, devuelve `{kind, path, url, previewKind, language, mimeType,
byteSize, binary, large}` con la MISMA semántica que el clasificador renderer (`local-preview.ts`)
para que ambos shells converjan. `wails-bridge.ts` deja de devolver `null`.

**Criterios de aceptación.**
- AC11: Targets con `file://` + espacios/unicode, rutas relativas con `./`/`../`, backslashes
  en Windows, y extensiones mayúsculas (`README.MD`) normalizan idéntico en Electron y Wails
  (misma clasificación de `previewKind`/`language`).
- AC12: Archivo binario/large (>512KB) llega marcado `binary`/`large` desde el bridge → UI
  muestra refusal **sin haber leído el contenido** (fin de la lectura inútil previa).

**Pruebas específicas.**
- Go `preview_normalize_test.go`: tabla de casos (espacios, unicode, relativa, `file://`,
  extensiones case-insensitive, binario por null-byte sniff, size>512KB).
- Vitest `wails-bridge.normalize.test.ts`: bridge usa el binding cuando existe; fallback
  renderer intacto si el binding falla (regresión back-compat).
- Vitest `local-preview.test.ts`: paridad de resultados entre mock de bridge y clasificador local.

---

## P1 — I/O y render perezosos (memoria/CPU/IO)

### P1.1 — `StatFile` + lectura acotada en Go

**Cambio.**
- Nuevo `FSService.StatFile(path) {size, mtimeMs, isDir, binary?}` (binary por sniff de
  primeros 8KB: null-byte + ratio de control chars — misma heurística que `looksBinaryBytes`,
  movida a Go como única fuente de verdad).
- `ReadFileText` gana parámetro `maxBytes` (0 = completo, default 512KB desde bridge):
  `os.Open` + `io.LimitReader`; devuelve `{text, byteSize, truncated, binary, mimeType}`.
  **Ya no** `os.ReadFile` completo por defecto.
- `ReadFileDataUrl` idem `maxBytes` (default 8MB para imágenes de preview; rechazar con
  error estructurado si excede).
- Bridge (`desktop-fs.ts`): `readDesktopFileText(path, {maxBytes})` propaga; `enrichPreviewTarget`
  usa `StatFile` (elimina la lectura completa actual solo para metadata).

**Archivos.** `fs_service.go` (+tests), `main.go` (binding firma), `wails-bridge.ts`,
`desktop-fs.ts`, `local-preview.ts`, `preview-file.tsx`.

**Criterios de aceptación.**
- AC13: Abrir preview de un archivo de 50MB en modo por defecto: Go lee ≤512KB (+8KB sniff);
  verificado con instrumentación/log o contador de bytes leídos en test.
- AC14: Archivo binario de 10MB con "Preview anyway": solo se leen 512KB y la UI muestra
  `truncated` (el buffer completo nunca cruza el bridge).
- AC15: Imagen de 12MB: UI muestra estado "imagen demasiado grande para preview inline" con
  acción "Abrir externo" (nuevo estado), sin construir data URL.
- AC16: `enrichPreviewTarget` en modo remoto deja de leer texto completo (usa `StatFile`).

**Pruebas específicas.**
- Go `fs_stat_test.go`: `TestStatFileSizeMtime`, `TestStatFileBinarySniff` (null-byte,
  control-chars ratio, texto con acentos no es binario), `TestReadFileTextLimit` (truncated
  flag + byteSize real), `TestReadFileDataUrlLimit`.
- Vitest `preview-file.limits.test.tsx`: given state `{truncated:true}` → banner truncado;
  given byteSize>8MB imagen → estado de "demasiado grande" con acción externa.
- Vitest `desktop-fs.test.ts` (nuevo): `readDesktopFileText` pasa `maxBytes`; `enrichPreviewTarget`
  llama `StatFile` y no `ReadFileText` (mock asserts).

### P1.2 — Imágenes por URL local (no base64) + thumbnails

**Cambio.**
- Reusar el `PreviewServerService` de P0: `PreviewStartForImage(path) -> {url}` que sirve el
  **archivo de imagen** (no el directorio) con token, o ruta dedicada `/img/<token>`.
- `LocalFilePreview` (imagen): `state.url` en vez de `dataUrl` cuando el tamaño > 1MB o shell
  Wails; `<img src={url}>` con `loading="eager"` y `decoding="async"`. `dataUrl` se reserva
  para imágenes pequeñas/inline ya en memoria (pasted screenshots).
- Thumbnail: `image_service.go` (Go stdlib `image/png`, `image/jpeg`, `image/gif`): genera
  preview máx 1024px si el original > 2048px, cacheado en `os.TempDir()/alice-previews/`
  (no en `~/.alice`) con key `sha256(path+mtime)`. Sin dependencias nuevas.

**Archivos.** `preview_server.go` o `image_service.go` (+tests), `wails-bridge.ts`,
`preview-file.tsx`, `store/preview.ts` (strip `dataUrl` ya existe; no persistir `url` efímera
→ regenerar al restaurar tabs).

**Criterios de aceptación.**
- AC17: PNG de 6MB se muestra con thumbnail (≤1024px) y memoria del renderer estable
  (snapshot de heap en devtools antes/después en la sesión de profiling).
- AC18: Tabs restauradas tras relanzamiento con imagen grande no rompen (URL efímera
  regenerada on-demand; nunca persistida).
- AC19: GIF animado renderiza (mime correcto, sin thumbnail que lo aplane → decidir: si es
  GIF, servir original).

**Pruebas específicas.**
- Go `image_service_test.go`: `TestThumbnailGeneration` (png grande → out ≤1024, cache hit
  segunda llamada), `TestThumbnailCacheKeyMtime` (mtime cambia → regenera), `TestImageMimeRouting`
  (gif → original).
- Vitest `preview-file.image.test.tsx`: >1MB → `<img src>` del servidor local (mock bridge);
  ≤1MB y `target.dataUrl` presente → data URL (no servidor).

### P1.3 — Diff git perezoso + cacheado

**Cambio.** En `preview-file.tsx`:
- Eliminar la llamada eager a `desktopGitRoot`/`desktopFileDiff` dentro de `load()`.
- Calcular diff **solo** al seleccionar vista `diff` (o al entrar al modo auto-diff si el
  watcher ya lo pidió), con cache en un `WeakMap`/store por `(path, mtime)` y TTL de sesión.
- El toggle muestra el modo `diff` como opción solo tras comprobar barato `StatFile + gitRoot`
  (o se muestra siempre y al entrar hace el fetch con spinner).

**Archivos.** `preview-file.tsx` (+ `preview-file.test.tsx`), posible `store/preview-diff.ts`
(nuevo nanostore con cache).

**Criterios de aceptación.**
- AC20: Abrir un archivo limpio en repo no genera ninguna llamada a `file-diff` (mock bridge:
  0 llamadas). Cambiar a vista diff → 1 llamada; volver a abrir/vista → 0 (cache).
- AC21: Archivo modificado (dirty) en repo: auto-mode `diff` hace el fetch una vez y cachea.

**Pruebas específicas.**
- Vitest `preview-file.diff.test.tsx`: asserts de nº de llamadas `desktopFileDiff` por escenario
  (limpio / dirty / cache hit / cambio de mtime).
- Go (ya existe `git_service_test.go`): añadir `TestFileDiffLargeFileCap` si se añade cap de
  tamaño de diff (recomendado: cap 256KB con flag `truncatedDiff`).

### P1.4 — Markdown y highlight bajo demanda

**Cambio.**
- `MarkdownPreview`: render por secciones (split por `^## ` o cada N chars) con
  `IntersectionObserver`-style lazy mount (reusar patrón `useFixedRowWindow` o un hook nuevo
  `useLazySections`); bloques de código fuera de viewport no se highlightean hasta entrar.
- `SourceView`: cachear resultado de Shiki por chunk en un `Map` LRU (max ~50 chunks) en el
  componente/store, keyed por `(filePath, mtime, chunkIndex)`.
- Umbral de degradación: `text.length > 1MB` (o >20k líneas) → por defecto vista `source`
  plain (sin Shiki), con botón "Resaltar de todos modos" (opt-in).

**Archivos.** `preview-file.tsx` (o split en `markdown-preview.tsx`), nuevo hook
`use-lazy-sections.ts` (pequeño, un trabajo), `markdown-code.ts`/`shikiLanguageForFilename`
ya existen.

**Criterios de aceptación.**
- AC22: `.md` de 2MB abre en <300ms percibidos (interacción inmediata; profiling con
  `profile-typing-lag` harness adaptado o Performance.mark en dev build).
- AC23: Scroll por `.md` largo no re-highlightea secciones ya vistas (cache hit) y la memoria
  no crece linealmente con el scroll (LRU bound).
- AC24: `.py` de 30k líneas abre en modo plain por defecto (sin Shiki), opt-in a resaltado.

**Pruebas específicas.**
- Vitest `markdown-preview.lazy.test.tsx`: mount de `.md` largo → nº de secciones montadas
  inicial ≤ K; `source` plain sobre umbral → 0 ShikiHighlighter mounts hasta click.
- Vitest `source-view.shiki-cache.test.tsx`: scroll simulado → cache hits (mock de Shiki
  contador de renders por chunk).
- Perf smoke (manual/scripted): script `scripts/profile-preview-perf.mjs` (CDP, mismo patrón
  que `profile-typing.mjs`) que abre fixture grande y mide `performance.now()` hasta
  primer paint interactivo; umbral documentado en el test output (no assert duro en CI).

---

## P2 — Ciclo de vida, pestañas y memoria sostenida

### P2.1 — LRU de pestañas de archivo

**Cambio.** En `store/preview.ts` + `ChatPreviewRail`:
- Máx **6** pestañas de archivo montadas con contenido vivo; al abrir la 7ª, la menos
  recientemente usada (por `lastActiveAt` en el tab) pasa a "cold" (solo metadata; su
  `LocalFilePreview` se desmonta y su estado se descarta). Reactivación = relectura (barata
  gracias a P1).
- `activeTabId` nunca se auto-recierra por LRU si es el visible.
- Persistencia (`TABS_STORAGE_KEY`): mantener lista completa (hasta 12) pero marcando
  `cold:true`; al restaurar, cold tabs cargan lazy.

**Archivos.** `store/preview.ts`, `preview.tsx`, `preview-file.tsx` (props `cold`), tests.

**Criterios de aceptación.**
- AC25: Abrir 8 archivos → solo 6 retienen buffers; la 8ª apertura no incrementa memoria
  más allá del techo (verificable con heap snapshot en dev).
- AC26: Volver a una tab cold la reactiva leyendo de disco (contenido correcto, dirty dot
  limpiado si el archivo no cambió).
- AC27: La tab activa nunca se expulsa por LRU.

**Pruebas específicas.**
- Vitest `store/preview.lru.test.ts`: secuencia de 8 `openFilePreviewTarget` → states
  (cold/hot) correctos; `selectRightRailTab` protege la activa.
- Vitest `preview-file.cold.test.tsx`: tab cold renderiza placeholder ligero y no llama
  `readDesktopFileText` hasta activarse.

### P2.2 — Descarga de estado de tabs ocultas / pane cerrado

**Cambio.**
- `PreviewPane` (web): al desmontar/ocultar, destruir iframe/webview (ya ocurre) **y** detener
  el servidor local de ese target (P0) — binding `PreviewStop`.
- `LocalFilePreview`: al perder visibilidad (tab no activa), conservar solo `{path, mtime,
  language}`; soltar `text/diff/dataUrl` (P1.2 evita data URLs grandes igualmente).
- `notifyWorkspaceChanged` y recargas: coalescing por `(path, 250ms)` para no disparar
  relecturas dobles watcher+workspace tick.

**Archivos.** `preview-pane.tsx`, `preview-file.tsx`, `wails-bridge.ts` (`previewServerStop`),
`store/workspace-events.ts` (coalesce), tests.

**Criterios de aceptación.**
- AC28: Cerrar la pestaña/derecha del preview de HTML local libera el servidor (puerto
  cerrado) — combinación con AC4.
- AC29: Cambiar entre 2 tabs alternando no relee cada vez si `mtime` no cambió (cache por
  `(path, mtime)` en store).
- AC30: Watcher de archivo + workspace tick simultáneos → 1 sola relectura (debounce/coalesce).

**Pruebas específicas.**
- Vitest `preview-pane.teardown.test.tsx`: unmount → `PreviewStop` llamado 1 vez por target.
- Vitest `preview-file.mtime-cache.test.ts`: 2 lecturas seguidas sin cambio de mtime → 1
  llamada real al bridge.
- Vitest `workspace-events.coalesce.test.ts`: 3 señales en <250ms → 1 notificación.

### P2.3 — Watch selectivo

**Cambio.** Watch activo **solo** para el target visible (ya es 1 por preview; extender a:
detener watch cuando la tab deja de estar activa y reanudar al activarse). Limpieza en
`closeRightRailTabsToRight/closeOthers`.

**Archivos.** `preview-pane.tsx` (props `isActive`), `preview.tsx` (pasa prop), tests.

**Criterios de aceptación.**
- AC31: Con 3 tabs abiertas, `StartFileWatch` activo solo para la visible (mock asserts);
  cambiar tab → stop anterior + start nuevo.

**Pruebas específicas.**
- Vitest `preview-pane.watch-active.test.tsx`: secuencia de activaciones → pairing
  start/stop correcto, 0 watchers huérfanos al desmontar.

---

## P3 — Observabilidad, E2E WebKit, hardening y paridad

### P3.1 — Instrumentación ligera

**Cambio.**
- En dev builds (`import.meta.env.DEV`), `performance.mark/measure` + log estructurado por
  evento de preview: `preview.open {kind, previewKind, bytes, ms}`, `preview.read {path,
  bytes, truncated}`, `preview.render {mode, ms}`, `preview.server.start/stop`.
- Nueva vista mínima en `PreviewConsolePanel`: panel "Stats" plegable con los últimos
  N eventos (dev only). Sin telemetría saliente (policy del repo).

**Archivos.** `preview-pane.tsx`, `preview-file.tsx`, `preview-console*.tsx`,
`lib/preview-telemetry.ts` (nuevo, dev-only noop en prod).

**Criterios de aceptación.**
- AC32: En dev, abrir HTML local / imagen grande / md grande produce eventos con ms y bytes;
  en prod build no hay console.log de telemetría (verificado con grep del bundle o flag).

**Pruebas específicas.**
- Vitest `preview-telemetry.test.ts`: eventos emitidos en dev; noop en prod (mock de env).

### P3.2 — Matriz E2E Wails WebKit (manual + script)

**Fixtures** (`apps/desktop/preview-fixtures/`, añadidas al repo, pequeñas):
`html-rel-assets/` (html+css+js module+json+png), `md-large.md` (~2MB), `py-large.py` (30k
líneas), `img-huge.png` (6MB, generada on-demand por script para no versionar), `gif-anim.gif`,
`html-form-demo.html`.

**Script** `scripts/e2e-preview-wails.mjs` (patrón CDP de `scripts/probe-renderer.mjs`):
abre cada fixture vía preview, asserts de DOM/estado (content visible, sin overlay de error),
mide ms de apertura.

**Checklist manual (WebKitGTK Linux + Electron Linux/macOS para comparación):**

| Caso | Esperado |
|---|---|
| HTML con assets relativos | Render completo, sin CORS (Wails) |
| HTML ES module + fetch json | Ejecuta y muestra data |
| HTML con form/modal/download | Funciona (sandbox tokens) |
| HTML con `fetch` remoto | CSP bloquea; UI no se rompe |
| HTML con path traversal en asset | 403 del servidor local |
| PNG 6MB | Thumbnail, sin pico de memoria |
| GIF animado | Animado |
| `.md` 2MB | Abre <300ms, scroll fluido |
| `.py` 30k líneas | Plain source por defecto, opt-in highlight |
| Binario 10MB | Refusal sin lectura completa (telemetry lo confirma) |
| Archivo 50MB texto | ≤512KB leídos, banner truncado |
| Editar + guardar con conflicto simulado | Banner conflicto, overwrite/discard ok |
| Live-reload (touch del archivo) | Recarga única coalesced |
| Cerrar tab | Servidor/watch liberados (puerto libre) |
| 8 tabs abiertas | Techo LRU respetado |

**Criterios de aceptación.** Todos los casos de la tabla pasan en Wails (WebKitGTK) y no
regresan en Electron. El script E2E corre localmente; si algún assert es automatizable
(DOM visible/overlay), queda en el script con exit code.

### P3.3 — Hardening

**Cambio.**
- `preview_server.go`: allowlist de extensiones servibles desde el mount (denegar
  ejecutables/`*.so`/dotfiles sensibles por defecto, configurable en código con comentario).
- Path allowlist: solo directorio del HTML objetivo (P0) — no workspace entero salvo decisión
  explícita documentada.
- `WriteTextFile`: tamaño máximo de contenido (p.ej. 10MB) + rechazo de symlink-write fuera
  de carpeta esperada (documentar límite actual; mejora mínima sin romper usos).
- Auditoría de headers del servidor: `X-Frame-Options` no necesario (es nuestro iframe),
  pero `Frame-ancestors` en CSP ya cubre.

**Criterios de aceptación.**
- AC33: Servir `index.html` + assets del mount funciona; pedir `../../etc/passwd`,
  `~/.alice/.env`, o `node_modules/.bin/*` (si existiera en el dir) → 403.
- AC34: `WriteTextFile` con payload 20MB → error claro, sin escritura parcial.

**Pruebas específicas.**
- Go `preview_server_allowlist_test.go`: tabla de rutas denegadas/permitidas.
- Go `fs_service_write_test.go` (nuevo): límite de tamaño, error estructurado.

### P3.4 — Paridad y CI

**Cambio.**
- Constante compartida de capacidades de preview en `desktop-capabilities.ts`
  (`previewConsoleSupported`, `previewDevToolsSupported`, `previewLocalServerSupported`) —
  UI (titlebar tools) deriva de ahí en vez de chequear `webviewRef.current?.openDevTools`.
- CI (typecheck.yml `desktop-parity` ya existe): añadir `go test ./...` de `apps/desktop-wails`
  si no corre (verificar) y `npm run test:ui` de `apps/desktop` en el job existente.

**Criterios de aceptación.**
- AC35: Sin webview (Wails) no se muestran botones de DevTools en titlebar; con webview sí
  (regresión visual cubierta por test de componentes).
- AC36: CI verde con los nuevos tests Go + vitest incluidos.

**Pruebas específicas.**
- Vitest `preview-pane.titlebar.test.tsx`: toolset derivado de capabilities (mock Wails vs
  Electron).

---

## Orden de implementación y entregables

1. **P0.1 + P0.2** (servidor + sandbox) — un PR. Incluye fixtures mínimos para AC1/AC6.
2. **P0.3 + P0.4** — un PR (diagnóstico + normalización Go).
3. **P1.1** — un PR (stat/read acotado; tocará `fs_service.go` + bridge; actualizar tests
   existentes de `ReadFileText`).
4. **P1.2** — un PR (imágenes por URL + thumbnails).
5. **P1.3 + P1.4** — un PR (diff perezoso + lazy render/cache).
6. **P2.1–P2.3** — un PR (LRU + teardown + watch selectivo).
7. **P3.1–P3.4** — uno o dos PRs (telemetry dev-only, E2E script + fixtures, hardening,
   capabilities/CI).

**Definición de Done por PR.** `npm run typecheck && npm run lint && npm run test:ui` en
`apps/desktop`; `go test ./...` en `apps/desktop-wails`; matriz manual de P3.2 ejecutada para
los casos afectados por el PR; sin nuevas dependencias sin pin (supply-chain policy del repo);
ninguna escritura a `~/.alice` en tests.

## Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| WebKitGTK CSP/sandbox behavior distinto por distro | Fixtures E2E + degradar CSP solo a headers informativos si rompe casos legítimos; registrar distro en checklist |
| Regresión en flujo de edición (P2 descarga de buffers) | AC26/AC29 + tests de mtime-cache; editor draft siempre protegido (patrón actual de refs se conserva) |
| Puerto efímero ocupado / firewall de loopback | Reintento con 3 puertos, error claro en UI, fallback a `source` |
| Telemetría percibida como tracking | Dev-only, noop en prod, cero outbound (policy) |
| `ReadFileText` cambio de firma rompe otros call-sites | Grep de call-sites previo (compositor/inline-refs usan `readDesktopFileText` también) — migración con default compatible |
