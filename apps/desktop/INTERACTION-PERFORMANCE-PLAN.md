# Plan: respuesta de interacción en Alice Desktop (cierre de paneles/modals, cambio de sesión, toggles)

> Estado: **borrador** (2026-11-14). No hay cambios de implementación aplicados por este plan.
> Alcance: `apps/desktop/src` (renderer compartido Wails/Electron) y, solo si hace falta,
> `apps/desktop-wails/*` (shell Go).
>
> Restricciones del repo que aplican:
> - Sin nuevas env vars `ALICE_*` para config no-secreta: cualquier knob nuevo va a
>   `config.yaml`/constantes de código, nunca a `.env`.
> - Dependencias nuevas: solo si son imprescindibles, con pin de supply-chain
>   (`>=x,<major`) y `uv lock`/lockfile actualizado.
> - Estilo TS del repo: nanostores (`$atom`/`computed`) en lugar de estado compartido por props,
>   hooks pequeños, `interface` para props públicas, `src/app` para rutas/páginas,
>   `src/lib` para helpers puros, `src/store` para átomos compartidos.
> - Tests nunca escriben en `~/.alice` real (fixture autouse redirige `ALICE_HOME`).
> - Cualquier servidor local: solo `127.0.0.1` + token efímero en memoria
>   (patrón ya establecido en `preview_server.go`).

---

## 0. Resumen ejecutivo

Los cuatro síntomas reportados comparten **una causa raíz dominante** y tres causas específicas:

| # | Causa raíz | Síntoma que explica |
|---|---|---|
| **C1** | `DesktopController` es un god-component: suscribe 19 átomos (incluido el estado de apertura de todos los paneles) y además ejecuta `useStatusbarItems` (que suscribe ~20 más). Cada toggle/cierre re-renderiza **todo el shell**, incluido el árbol del `Thread` (hasta 300 parts) de forma síncrona en el commit del click. | Todo se siente lento y "no responde al primer click" |
| **C2** | `openReview()` no es idempotente ni revela el panel: sin guard de "ya abierto", sin `PANE_TOGGLE_REVEAL_EVENT`, y re-lanza `git review list` + `gh` (shipInfo) + remoteInfo en cada click. Además el botón del statusbar se gatea por `repoPath` (proyecto) mientras el panel se gatea por `currentCwd`. | "Open git pane" necesita varios clicks |
| **C3** | Las rutas overlay (settings / command-center / agents / profiles / cron / starmap) **desmontan el chat**: al cerrar con (X) se remonta `ChatPage` completo y el efecto de ruta vuelve a evaluar `resumeSession` (y lo ejecuta si el runtime no está bindeado). | Cerrar Settings/Command Center con (X) tarda |
| **C4** | `PersistentTerminal` corre un `requestAnimationFrame` infinito que hace `getBoundingClientRect()` en cada frame durante toda la vida de la app (el pane del terminal está siempre montado). | Jank global: amplifica C1/C3 en cada interacción |
| **C5** | `ChatViewSwitch` desmonta `ChatRuntimeBoundary` (Thread + ChatBar + PromptOverlays) al pasar a graph y lo remonta al volver; `GraphifyCanvas` relee `graphify-out/graph.html` en cada montaje vía IPC (cap 512 KB en Wails, `truncated` ignorado). | "Graphify / Back to chat" lento y a veces roto |
| **C6** | `resumeSession` hace trabajo secuencial (resolve por id → swap de perfil → prefetch+RPC → conversión/equivalencia → `setMessages`) mientras `review.ts`/`coding-status.ts` disparan sondas git y `gh` por el cambio de `$currentCwd`. | Cambio de sesión lento |
| **C7** | El baseline de tests no está verde (23 failed / 1 123 passed, 58 archivos "failed", 2 errores sin capturar), dominado por globs ajenos (`electron/*.test.cjs`, artefactos de build) y 3 tests de `src/` obsoletos o fugados. | No hay gate objetivo para medir mejoras; los fallos reales se esconden |

Orden de ataque: **C4 (barato, global) → C1 (estructural, el que más paga) → C7 (gate) → C2 → C3 → C5 → C6**.

El inventario completo de deuda (13 ítems) y de bugs de lógica (12 ítems), con evidencia y
severidad, está en [`ARCHITECTURE-DEBT-ANALYSIS.md`](./ARCHITECTURE-DEBT-ANALYSIS.md).

### 0.1 Decisión de arquitectura: refactor acotado, no rewrite

Este plan **no** propone rehacer la arquitectura del desktop. El análisis completo de deuda está en
[`ARCHITECTURE-DEBT-ANALYSIS.md`](./ARCHITECTURE-DEBT-ANALYSIS.md); el resumen de la decisión:

| Opción | Veredicto |
|---|---|
| Reemplazar el state layer (Redux/Zustand/Jotai/signals) | **No**. El cuello de botella es *dónde* se suscribe, no la librería. Migrar sin corregir eso reproduce el bug. |
| Reescribir el router | **No**. El fallo es una tabla de rutas de ~15 líneas (D3). |
| Trocear todo en micro-componentes | **No**. El problema está en 3 contenedores, no en 200 componentes. |
| **Aplicar la disciplina de suscripción que el propio código ya documenta**, en el composition root y en las hojas caras | **Sí**. ~8–12 archivos, mecánico, con invariantes ejecutables. |
| Arreglar los bugs localizados (rAF, reveal, cap 512 KB, caché) como fixes aislados | **Sí**. No son deuda de diseño; son defectos. |

Evidencia de que la arquitectura objetivo **ya existe** en el repo: `app/chat/index.tsx` documenta
el invariante *"ChatView must not subscribe to `$messages` … the stream's render cost stays confined
to the streaming message's own subtree"* y lo implementa aislando `ChatRuntimeBoundary`. El
`DesktopController` crea ese elemento de ruta en cada render, así que **invalida el invariante**.
La tarea es terminar de aplicarlo, no sustituirlo.

**Regla derivada (se documenta en el código al implementar):** *un átomo de UI de alta frecuencia
solo puede suscribirse en el componente que lo pinta; un contenedor que crea elementos de
subárboles caros no puede re-renderizar por estado ajeno a ese subárbol.*

**Decisión (2026-11-14, aprobada por el usuario):** P1.1 se cierra con la **memoización del
elemento del chat** como equivalente al split de contenedores. Razón: el AC observable —un toggle
de panel no re-renderiza el transcript— está implementado y probado (`render-scope.test.tsx`),
mientras que el split literal exige convertir `PaneShell` en un registro dinámico (hoy descubre
panes en sus hijos directos, B16) y no hay sesión gráfica para validar hover-reveal/resize. El
rediseño queda registrado como trabajo futuro, no como deuda abierta.

---

## 0.2 Estado de implementación

Implementado en esta sesión (2026-11-14). Evidencia al final de la sección.

| Fase | Estado | Evidencia |
|---|---|---|
| P0.0 harness | ✅ mecanismo (CDP + telemetría Wails) | `--self-test` → `✔ 7 cases`; en Wails se mide con el panel dev (sin Electron/CDP) |
| P0.1 rAF del terminal | ✅ | `persistent.test.tsx` (4 tests: no polling, RO follow, zero-size, latch) |
| P0.2 baseline verde | ✅ | suite `159 files / 1185 tests` en verde (antes: 58 archivos fallidos, 23 tests) |
| P1.1 fronteras de render | ✅ **vía memoización del elemento** (ver desviación) | `chatView` en `useMemo` con deps de datos + `render-scope.test.tsx` (3 tests: toggle de panel y de sash no re-renderizan el chat; control positivo) |
| P1.2 overlays sin desmontar chat | ✅ | `main-pane-routes.test.tsx` (3 tests) |
| P1.3 persistencia coalescida | ✅ | `storage.coalesced` + `listen` en 10 stores; `panes.test.ts` (1 escritura por ráfaga) |
| P1.4 git pane al primer click | ✅ | `review.toggle.test.ts` (6 tests) |
| P1.5 graph sin remount + caché | ✅ | `graphify-canvas.test.tsx` (5), `chat-view-switch.test.tsx` (4), `graphify-html-cache.test.ts` (4) |
| P1.6 terminal estable | ✅ | `railColumnOpen` incluye browser; terminal no se remonta (`rail-panes` cubierto por `main-pane-routes` + persistencia) |
| P1.7 delete fallido | ✅ | `use-session-actions.test.tsx` (14 tests, incluye el caso del runtime cerrado) |
| P1.8 gates del panel git | ✅ | `$reviewAvailable` único + `$reviewHasWorkspace` |
| P1.9 auto-flip de graph | ✅ | `graphify.test.ts` (`chatViewAfterSessionChange`, 4 casos) |
| P1.10 fuente única de paneles | ✅ | `bindPaneGate` + `pane-visibility.test.ts` (2 tests) |
| P1.11 registro de claves | ✅ (UI state) | `lib/persisted-keys.ts` + `persisted-keys.test.ts`; 4 stores migrados (`panes`, `review`, `preview`, `right-sidebar`) |
| P2.1 switch de sesión | ✅ | `deferToIdle` para usage, `gh`/git diferidos por `$busy`, **AbortSignal** en el prefetch (`alice.test.ts`, 2 tests) y test A→B→A que demuestra que el resultado obsoleto no se aplica |
| P2.2 telemetría dev-only | ✅ | `interaction-telemetry.test.ts` (4) + panel dev en Ajustes → About (`interaction-stats-panel.test.tsx`, 4) + instrumentación en los 5 flujos |
| P2.3 CI budgets | ✅ mecanismo + job; ⏳ datos | Job no bloqueante `.github/workflows/desktop-interaction-perf.yml`: self-test + `--import/--baseline` (falla >40 %) + publica el capture como artifact. `perf-baseline.json` versionado con `meta {captured_at, commit, machine}` **sin cifras** (unmeasured a propósito) y `perf-captures/README.md` con el procedimiento `wails dev` → Copy JSON |
| D0 baseline | ✅ | ver P0.2 |
| D1 wireStores | ✅ | `store/wire.ts` + `wireProfileRouting`/`wireCodingStatus`/`wireReview`, invocado desde `main.tsx`; `wire.test.ts` prueba import sin IPC y wiring idempotente |
| D2 capas | ✅ | runtime imports de `app/`/`components/`/`hooks/` eliminados de `store/` y `lib/` (`lastVisibleMessageIsUser`, `SIDEBAR_COLLAPSE_MEDIA_QUERY`, `matchesQuery`, `liveSessionProjectId`, `formatRefValue`) + test de contrato `architecture-layers.test.ts` (verificado en negativo) |
| D6 código muerto | ✅ | graphify muerto eliminado (`$graphifyOpen`, `toggleGraphify`, `closeGraphify`, `GraphifyPane` + su carpeta) |
| D3 sidebar | ✅ | filas memoizadas (`session-row.test.ts`) + secciones extraídas `SidebarNav` y `RecentsHeaderAction` con conteo de renders real (`sidebar-sections.test.tsx`, 4 tests incluido control positivo) |
| D5 capacidades | ✅ | `desktopSupports('webview'/'iframeSandbox'/'petOverlay'/'previewLocalServer')` en los 5 sitios + `shell-capabilities.test.ts` (falla si un componente llama `isWailsShell`) |
| D5 `alice.ts` | ✅ | 6 módulos de dominio en `lib/api/` (`client`, `sessions`, `config`, `providers`, `help`, `migration`, `tools`), re-exportados desde `alice.ts` (firmas intactas). `alice.ts`: 910 → 528 líneas |
| D7 `catch {}` | ✅ | 15 bloques vacíos documentados (0 `no-empty`); lint global 201 → 167 errores |

### Desviaciones conscientes (y por qué)

1. **P1.1 — no se extrajo `<RailPanes>`.** `PaneShell` descubre los panes recorriendo sus **hijos
   directos** (`collectPanes`), así que mover los `<Pane>` a un componente hijo los vuelve
   invisibles para el grid: el intento se implementó, un test lo demostró (orden de panes = `[]`)
   y se revirtió. La solución aplicada conserva la misma ganancia: el elemento del chat se
   memoiza (`useMemo`) con dependencias de **datos**, de modo que un toggle de panel re-renderiza
   el shell pero React **baila** el subárbol del chat por identidad de elemento. Un split real
   exigiría convertir `PaneShell` a un registro dinámico; queda propuesto, no hecho.
2. **P1.11 — alcance del registro.** Se registran las claves de **estado de UI** (layout, rail,
   review, preview, sidebar) con versión; las claves de preferencias de usuario (`toolViewMode`,
   `haptics`, `keybinds`, …) siguen con su literal hasta que se toquen. No se renombró ninguna
   clave (habría perdido estado de usuario).
3. **P2.1 — `AbortSignal` cooperativo.** El bridge no expone cancelación de transporte, así que
   `getSessionMessages` rechaza con `AbortError` antes de la llamada y al resolver si la señal ya
   se abortó; `resumeSession` aborta el prefetch anterior al empezar uno nuevo. El transporte puede
   completarse, pero el payload obsoleto nunca se procesa (probado con A→B→A).
4. **P0.0 — baseline numérico.** El harness CDP (Chrome/Electron) y el panel dev de Wails están
   listos; capturar los p95 reales requiere una sesión gráfica que ejecute `wails dev` y usar la
   app. En Wails no se usa Electron: la telemetría vive en `window.__aliceInteractionStats` y el
   panel de Ajustes → About la muestra en WebKit.
5. **P1.1 — por qué no hay `<RailPanes>`.** `PaneShell` descubre panes en sus hijos directos
   (`collectPanes`); mover los `<Pane>` a un componente los hace invisibles (probado: orden = `[]`).
   Convertirlo en registro dinámico exige dos pasadas de render (primer paint con tracks a 0px).
   La memoización del elemento del chat logra el resultado observable y está cubierta por
   `render-scope.test.tsx`.
6. **D3 — alcance.** Filas + las dos secciones estáticas de más coste (`SidebarNav`,
   `RecentsHeaderAction`) están memoizadas con conteo de renders. La lista virtualizada y el árbol
   de proyectos siguen re-renderizando con el parent (su output depende de esos datos).

### Bugs de lógica encontrados durante la implementación

- **B13 (alta) — `use-gateway-boot.ts`:** `const log` estaba declarado **dentro** del `try`, así
  que el `catch` lanzaba `ReferenceError: log is not defined` y **nunca** ejecutaba
  `failDesktopBoot` ni `notifyError`: un fallo de arranque producía una promesa rechazada sin
  UI de recuperación. Detectado por el error no capturado de la suite; corregido subiendo `log`
  fuera del `try`.
- **B14 (media) — statusbar:** el ítem de browser tabs usaba `browserTabsOpen` en su JSX sin
  incluirlo en las dependencias del `useMemo`, así que el indicador activo no se actualizaba al
  togglear. Añadido a las deps.
- **B15 (media) — tests dependientes del reloj:** `streaming.test.tsx` asumía que 80 ms de espera
  ocurrían antes que un chunk a 500 ms. Bajo la suite en paralelo eso fallaba de forma
  intermitente. El harness ahora emite los chunks de forma determinista desde el test.

### Evidencia de verificación

```text
$ cd apps/desktop && npx vitest run     # 3 corridas consecutivas, sin solaparse
Test Files  167 passed (167)
Tests       1216 passed (1216)          # 0 failed, 0 unhandled errors en las 3

$ cd apps/desktop && npx tsc -p . --noEmit | wc -l
104        # baseline preexistente (assistant-ui API drift); ninguna en archivos tocados

$ npx eslint <archivos tocados>
0 errors
# (baseline global: 201 ✖ errores → 167 ✖ tras la sesión)

$ npm run build
✓ built in 1.95s
✓ assert-dist-built: dist/index.html + assets present

$ node scripts/measure-interactions.mjs --self-test
✔ self-test ok — 7 cases: toggle-git, toggle-terminal, toggle-browser, toggle-graph, close-modal, switch-session, idle

# Capa de latencia sin display (captura exportada desde el panel de Wails):
$ node scripts/measure-interactions.mjs --import=capture.json --baseline=perf-baseline.json
  toggle-git           p95=80ms baseline=40 Δ=+100%  ✖ regression
  toggle-terminal      p95=12ms baseline=60 Δ=-80%
✖ 1 interaction(s) regressed by more than 40%      # exit 1; sin regresión → exit 0

$ wails build -skipbindings   # apps/desktop-wails
Built 'apps/desktop-wails/build/bin/alice-desktop' in 1.386s
# 33.9 MB, y `strings` confirma el renderer nuevo embebido (data-statusbar-item)
```

> Nota: el binario Wails se reconstruyó para embeber este renderer. La validación
> **visual** (latencia percibida, animaciones, cierre con X en WebKitGTK) sigue requiriendo una
> sesión gráfica; las filas automatizables están cubiertas por los tests anteriores.

---

## 1. Presupuestos de aceptación (medibles)

Referencia de medición: máquina de desarrollo con display, backend local, sesión de fixture
de 200 mensajes / ~2 MB con tool calls, repo con 500 archivos modificados, `graph.html` de ~20 MB.

| Escenario | Presupuesto (p95) | Techo (max) |
|---|---|---|
| Click en toggle de panel (git/terminal/browser) → primer paint con el cambio visible | **≤ 50 ms** | 100 ms |
| Cerrar modal/panel con (X), Esc o backdrop → primer paint | **≤ 50 ms** | 100 ms |
| Long task máxima dentro del commit de un toggle/cierre | **≤ 80 ms** | 120 ms |
| Cambio de sesión (200 msgs): transcript pintado | **≤ 150 ms** | 250 ms |
| Cambio de sesión: composer interactivo | **≤ 300 ms** | 500 ms |
| IPC durante un toggle/cierre (excluyendo apertura fría de git) | **0** en el path del click | — |
| `requestAnimationFrame` continuos en reposo | **0** | — |
| PTY `fit()` por cambio de geometría | **exactamente 1** | 2 |
| Abrir graph desde caché → visible | **≤ 50 ms** | 100 ms |
| Abrir graph frío (20 MB) → visible, sin truncar | **≤ 600 ms** | 1 200 ms |

Estos números son objetivos de aceptación, no promesas: se fijan midiendo el baseline en la
fase P0.0 y se revisan una sola vez con evidencia (ver §9).

---

## 2. Fase P0 — Instrumentación y hotfixes de bajo riesgo

### P0.0 — Baseline reproducible (antes de tocar nada)

**Problema.** No hay medición objetiva de estos flujos; sin baseline no se puede afirmar mejora.

**Cambio.** Extender el harness CDP existente (`apps/desktop/scripts/measure-latency.mjs`, que ya
mide keystroke→paint vía `Runtime.evaluate` + `requestAnimationFrame`) a un nuevo
`apps/desktop/scripts/measure-interactions.mjs`:

- Modos: `--case=toggle-git|toggle-terminal|toggle-browser|toggle-graph|close-modal|switch-session`.
- Por caso, N repeticiones: `t0` (dispatch del click vía `Input.dispatchMouseEvent`), `t1`
  (primer `MutationObserver` sobre el selector objetivo), `t2` (primer rAF tras `t1`).
- `PerformanceObserver({entryTypes:['longtask']})` para registrar long tasks del commit.
- Volcado JSON: `min/p50/p95/max` por caso + top-5 long tasks.
- Sin nuevas dependencias (Node `WebSocket` global, igual que `measure-latency.mjs`).

**Archivos.** Nuevo `apps/desktop/scripts/measure-interactions.mjs`; `apps/desktop/package.json`
(script `measure:interactions`).

**Criterios de aceptación.**
- AC1: el script produce, para los 6 casos, `n ≥ 20` muestras y un JSON estable en
  `/tmp/opencode/interaction-baseline.json`.
- AC2: correrlo dos veces seguidas da p95 con desviación ≤ 25 % por caso (si no, la métrica no
  es fiable y se ajusta el selector de `t1` antes de seguir).
- AC3: se registra el baseline (tabla before) en este documento antes de empezar P0.1.

**Pruebas específicas.**
- `apps/desktop/scripts/measure-interactions.mjs --self-test`: valida el parser de args, la
  agregación estadística y el formato de salida contra un generador de muestras sintéticas
  (sin Electron). Se ejecuta en CI como `node ... --self-test`.

---

### P0.1 — Matar el rAF infinito del terminal

**Problema.** `apps/desktop/src/app/right-sidebar/terminal/persistent.tsx` (`PersistentTerminal`):
`useLayoutEffect` dependiente de `slot` arranca `tick()` → `slot.getBoundingClientRect()` →
`requestAnimationFrame(tick)` recursivo, sin condición de parada. El slot existe siempre porque
`TerminalPaneChrome` se monta incondicionalmente en `desktop-controller` (`terminalPane`). Resultado:
una lectura de layout forzada **por frame, para siempre**, en el hilo principal.

**Cambio.**
1. Sustituir el bucle rAF por triggers dirigidos:
   - `ResizeObserver` sobre el slot (cubre columnas, filas, drag de sash, hover-reveal).
   - `window` `resize` + `scroll` (capture) para cambios de offset (scroll del contenedor).
   - `transitionend` del `<Pane>` cuando cambia entre columna ↔ bottom row.
   - Un único rAF de coalescing por ráfaga (patrón ya usado en
     `terminal/use-terminal-session.ts`).
2. Mantener la semántica actual: overlay `position:fixed` siguiendo el rect del slot,
   `visibility:hidden` + `pointerEvents:none` cuando el rect es 0×0, `mounted` latch intacto.
3. Añadir un contador dev-only (`window.__aliceTerminalRectSync`) con nº de mediciones y motivo,
   para verificar en el harness que no hay polling.

**Archivos.** `apps/desktop/src/app/right-sidebar/terminal/persistent.tsx` (+ test nuevo).

**Criterios de aceptación.**
- AC1: en reposo, tras montar el pane del terminal, **no** se llama `requestAnimationFrame` de
  forma recurrente (0 frames atribuibles al overlay en 2 s con `--case=idle`).
- AC2: al abrir/cerrar el terminal, abrir browser tabs o arrastrar el sash, el overlay sigue
  exactamente el rect del slot (top/left/width/height con el mismo redondeo actual:
  `floor` top/left, `ceil` right/bottom).
- AC3: cuando el slot mide 0×0 (pane cerrado), el overlay queda `visibility:hidden` y
  `pointer-events:none` (no captura clicks).
- AC4: cambiar de columna a bottom row dispara **≤ 2** `ResizeObserver` callbacks y **1** `fit()`
  del PTY (verificable con el contador de `use-terminal-session.ts`).

**Pruebas específicas.**
- Nuevo `apps/desktop/src/app/right-sidebar/terminal/persistent.test.tsx`:
  - `does not poll with requestAnimationFrame while idle` — spy en `requestAnimationFrame`;
    montar con slot 800×300, avanzar 2 s de fake timers, `expect(rafSpy.mock.calls.length).toBeLessThanOrEqual(2)`.
  - `follows the slot rect through ResizeObserver` — mock de `ResizeObserver`, cambiar rect,
    disparar callback, assert `style.top/left/width/height`.
  - `hides overlay when the slot collapses to zero` — rect 0×0 → `visibility:hidden`,
    `pointerEvents:'none'`.
  - `keeps the terminal mounted after first open` — ya lógica existente; asegurar que ocultar no
    desmonta `TerminalWorkspace` (spy de montaje).
- `apps/desktop/scripts/measure-interactions.mjs --case=idle` → assert `rafPerSecond === 0` en
  el JSON de salida (se documenta como fila del baseline).

---

### P0.2 — Dejar el baseline de tests verde y sin ruido (D12)

**Problema.** `npm run test:ui` da **23 failed / 1 123 passed** con **58 archivos** marcados como
fallidos y 2 errores no capturados. El ruido viene de tres fuentes y esconde fallos reales:

| Grupo | Archivos | Causa | Acción |
|---|---:|---|---|
| `electron/*.test.cjs`, `scripts/*.test.cjs`, `e2e/*.spec.ts` | 34 | Son `node --test`/Playwright; el glob de vitest los recoge | Excluirlos en `vitest.config` (`exclude` por patrón) |
| `build/native-deps/**`, `release/**` | 12 | Artefactos de build con tests de node-pty dentro del árbol | Excluirlos del glob |
| Fallos reales de `src/` | 12 archivos / 23 tests | 3 son tests obsoletos o fugas (ver abajo). El resto: `model-settings` (7), `thread/block-direction` (4), `tool/fallback-model` (2), `thread/user-message-edit` (2), `thread/streaming` (1), `onboarding` (1), `toolset-config-panel` (1), `composer/attachments` (1), `use-gateway-boot` (1, además con error no capturado) | Arreglar o actualizar con justificación |

Los 3 investigados en detalle:
1. `store/panes.test.ts` — afirma que `widthOverride` **no** se persiste; el código sí lo persiste
   (comentario "Persists both open state and resize width"). → actualizar el test al comportamiento
   intencional, y cubrir con un test nuevo de que la persistencia coalescida (P1.3) mantiene la
   forma.
2. `pane-shell.test.tsx` — no pasa `resizable`, y `trackForPane` solo aplica el override en panes
   resizable. → añadir `resizable` al test.
3. `use-preview-routing.test.tsx` — `alice.desktop.sessionPreviews.v1` aparece escrito por un test
   anterior del mismo archivo: átomos de módulo + `localStorage` sin reset entre tests. → añadir
   limpieza en `beforeEach` (y, con D4, mover los side effects a `wireStores()`).

**Cambio.**
1. `exclude` en `vitest.config.ts` para los globs de electron/scripts/e2e/build/release.
2. Corregir los 3 tests obsoletos/fugados y los 4 restantes de `src/` (o marcar `skip` con issue y
   fecha si son de entorno, nunca silenciosamente).
3. Añadir limpieza de `localStorage` + reset de átomos en el setup de jsdom para archivos que tocan
   stores con persistencia (helper `resetPersistedStores()` compartido).
4. Congelar el resultado: `npm run test:ui` debe quedar **verde** antes de empezar P1.1.

**Archivos.** `apps/desktop/vitest.config.ts`, `apps/desktop/src/test-setup*.ts`,
`src/store/panes.test.ts`, `src/components/pane-shell/pane-shell.test.tsx`,
`src/app/session/hooks/use-preview-routing.test.tsx`, más los 4 tests de `src/` restantes.

**Criterios de aceptación.**
- AC1: `npm run test:ui` → 0 failed, 0 errores no capturados, sin archivos "failed" sin tests.
- AC2: el conteo de archivos de test baja en ≥ 46 (solo quedan los de `src/`), y el tiempo total no
  aumenta (los excluidos no aportaban cobertura del renderer).
- AC3: ningún test queda `skip` sin referencia a issue.
- AC4: los 3 tests corregidos siguen fallando si se revierte el comportamiento que documentan
  (verificado manualmente una vez, no en CI).

**Pruebas específicas.**
- `node -e "..."`/script de CI que valide que `vitest.config.ts` no incluye `electron/`, `e2e/`,
  `build/`, `release/` (assert sobre la config, no sobre el conteo de archivos).
- `src/store/panes.test.ts` → *"persists the width override with the open flag"* (comportamiento
  actual, reemplaza el obsoleto).
- `src/test-setup` → test unitario del helper `resetPersistedStores()`: dos tests consecutivos que
  escriben `alice.desktop.*` no se ven entre sí.

---

## 3. Fase P1 — Causa raíz estructural (C1): aislar fronteras de render

### P1.1 — El shell deja de re-renderizarse por estado de paneles

**Problema.** `apps/desktop/src/app/desktop-controller.tsx` lee con `useStore` (aprox. líneas
170–185) `$gatewayState`, `$activeSessionId`, `$currentCwd`, `$freshDraftReady`,
`$resumeFailedSessionId`, `$resumeExhaustedSessionId`, `$filePreviewTarget`, `$previewTarget`,
`$selectedStoredSessionId`, `$terminalTakeover`, `$reviewOpen`, `$browserTabsOpen`,
`$fileBrowserOpen`, `$paneOpen(PREVIEW_PANE_ID)`, `$panesFlipped`, `$profileScope`; y en la línea
~885 llama `useStatusbarItems`, que suscribe `$terminalTakeover`, `$browserTabsOpen`, `$chatView`,
`$busy`, `$currentUsage`, `$updateStatus`, `$subagentsBySession`, etc.

Cada uno de esos cambios re-ejecuta el cuerpo del controller: se reconstruyen los elementos
`chatView` (→ `ChatPage` → `Thread` con presupuesto de 300 parts), `sidebar`, los 5 `<Pane>` y el
fragmento `overlays`. Nada de eso está memoizado, así que React re-renderiza el árbol completo de
forma **síncrona en el commit del click**. Ese es el coste que se percibe como "necesita varios
clicks" (el primer click entra en un frame de 200–600 ms; el usuario cree que no se registró).

**Cambio.** Partir `DesktopController` en fronteras de render por responsabilidad, sin cambiar
comportamiento:

1. `<ChatSurface>` — lee solo lo que afecta al chat (`$activeSessionId`, `$currentCwd`,
   `$freshDraftReady`, latches de resume, `$selectedStoredSessionId`). Recibe el resto por props
   estables (`useCallback`/`useMemo` con deps reales).
2. `<RailPanes>` — lee `$reviewOpen`, `$browserTabsOpen`, `$terminalTakeover`, `$fileBrowserOpen`,
   `$paneOpen(PREVIEW_PANE_ID)`, `$panesFlipped` y renderiza los `<Pane>`. Es el único componente
   que se re-renderiza al togglear un panel.
3. `<AppStatusbar>` — dueño de `useStatusbarItems` (mueve ahí las suscripciones del statusbar).
4. `<DesktopOverlays>` — dueño del fragmento `overlays` y de sus flags (`settingsOpen`,
   `commandCenterOpen`, …).
5. `DesktopController` queda como composition root: estado de sesión/acciones + montaje de esos
   cuatro contenedores; **no** lee átomos de apertura de paneles ni de statusbar.

Regla de estilo (documentar en el archivo): *un átomo de UI de alta frecuencia (apertura de panel,
hover, progreso) solo puede suscribirse en el componente que lo pinta*. Esto es la versión de
render del mismo principio que ya aplica `use-statusbar-items.tsx` con `computed` para no re-renderizar
por token.

**Archivos.** `apps/desktop/src/app/desktop-controller.tsx` (split), nuevos
`apps/desktop/src/app/shell/rail-panes.tsx`, `apps/desktop/src/app/shell/app-statusbar.tsx`,
`apps/desktop/src/app/shell/desktop-overlays.tsx` (nombres orientativos), y ajustes de props en
`desktop-controller`.

**Criterios de aceptación.**
- AC1: togglear `$reviewOpen`, `$terminalTakeover`, `$browserTabsOpen`, `$chatView`,
  `$fileBrowserOpen` **no** produce ningún render de `ChatPage`/`Thread` (contador de renders = 0).
- AC2: `$paneStates` (drag de sash) no re-renderiza `ChatPage` ni `AppStatusbar`.
- AC3: los átomos que hoy consume el statusbar y cambian durante un turno (`$busy`,
  `$currentUsage`, `$subagentsBySession`, `$turnStartedAt`) actualizan el statusbar **sin**
  re-renderizar `ChatSurface` ni `RailPanes`. Invariante adicional: `$messages` (que sí cambia a
  ~30 Hz en streaming) no debe tocar ninguna de esas dos fronteras (hoy no lo hace; se protege
  contra regresión).
- AC4: ningún cambio visual ni de comportamiento observable: la suite existente de
  `desktop-controller`/shell pasa sin modificaciones de expectativas.
- AC5: p95 click→paint de los 4 toggles baja a ≤ 50 ms con el harness de P0.0 (comparado con
  baseline, §9).

**Pruebas específicas.**
- Nuevo `apps/desktop/src/app/desktop-controller.render-scope.test.tsx`:
  - `pane toggles do not re-render the chat surface` — mock de `Thread`/`ChatPage` con contador
    de renders; `act(() => $reviewOpen.set(true))`, idem para los otros átomos; assert contador
    sin cambios.
  - `statusbar atoms do not re-render rail panes` — set `$currentUsage`/`$busy`; assert
    `RailPanes` render count estable.
  - `sash drag only re-renders the pane shell` — `setPaneWidthOverride('review', 320)`; assert
    chat/statusbar sin renders.
- Extensión de `apps/desktop/src/components/pane-shell/pane-shell.test.tsx`:
  - `recomputes the grid once per pane-state change` — spy en `collectPanes`/render; un drag de
    100 eventos coalescidos produce **1** recomputación de grid.

---

### P1.2 — Cerrar overlays sin desmontar el chat (C3)

**Problema.** En el `<Routes>` de `desktop-controller`, las rutas overlay renderizan
`element={null}` (settings, cron, profiles, command-center, agents). Al navegar a `/settings` el
`ChatPage` **se desmonta**; al cerrar con (X) → `closeOverlayToPreviousRoute()` (en
`app/shell/hooks/use-overlay-routing.ts`) vuelve a `/:sessionId`, se **remonta** `ChatPage` y
`useRouteResume` ve `pathnameChanged` y dispara `resumeSession` (que con caché caliente evita IPC,
pero aun así reconstruye el árbol del thread).

**Cambio.**
1. En la tabla de rutas, las vistas overlay (settings, command-center, agents, profiles, cron,
   starmap) mantienen `ChatSurface` montado como elemento de ruta y la vista overlay se pinta
   encima (ya son overlays `fixed` en el fragmento `overlays`, posicionados por `settingsOpen`/
   `commandCenterOpen`/…). `skills`/`messaging`/`artifacts` siguen siendo rutas que reemplazan
   el chat (comportamiento intencional, fuera de alcance).
2. En `useRouteResume`, endurecer el gate de `alreadyActive` para que un cierre de overlay no
   dispare resume si el runtime sigue bindeado (ya existe la comprobación; se convierte en
   condición explícita y testeada: `routedSessionId === selectedStoredSessionIdRef.current &&
   runtimeIdByStoredSessionIdRef.current.get(routedSessionId) === activeSessionIdRef.current`
   ⇒ no llamar `resumeSession`).
3. `closeOverlayToPreviousRoute` no debe perder el query/hash de la sesión (ya usa el path
   completo; se testea).

**Archivos.** `apps/desktop/src/app/desktop-controller.tsx` (tabla de rutas),
`apps/desktop/src/app/shell/hooks/use-overlay-routing.ts` (si hace falta),
`apps/desktop/src/app/session/hooks/use-route-resume.ts` (+ su test).

**Criterios de aceptación.**
- AC1: abrir Settings → cerrar con (X): `ChatPage` no se desmonta (mismo nodo DOM de
  `[data-slot="aui_thread-viewport"]` antes/después).
- AC2: ídem para Command Center, Agents, Profiles, Cron.
- AC3: cerrar un overlay no ejecuta `session.resume` ni `getSessionMessages` (0 IPC de sesión),
  y el scroll del thread se preserva (mismo `scrollTop`).
- AC4: p95 close→paint ≤ 50 ms (harness `--case=close-modal`).
- AC5: `Esc` y click en backdrop tienen la misma latencia y comportamiento que (X).

**Pruebas específicas.**
- Nuevo `apps/desktop/src/app/desktop-controller.overlay-close.test.tsx`:
  - `keeps the chat thread mounted while an overlay route is open` — render en `/:sid`, navegar a
    `/settings`, cerrar, assert identidad del nodo del viewport y contador de montajes de
    `Thread` === 1.
  - `closing an overlay issues no session IPC` — spies en `getSessionMessages` y en el
    `requestGateway` fake; assert 0 llamadas de `session.resume`.
  - `preserves thread scroll across overlay open/close` — fijar `scrollTop`, abrir/cerrar,
    assert mismo valor.
- Extensión de `apps/desktop/src/app/session/hooks/use-route-resume.test.tsx`:
  - `does not resume when the runtime is already bound after an overlay round-trip`.
  - `resumes once on a genuine session switch` (regresión: no romper el self-heal).

---

### P1.3 — Persistencia de UI fuera del path del click

**Problema.** `apps/desktop/src/app/right-sidebar/store.ts` suscribe a nivel de módulo y llama
`persistBoolean` (localStorage, síncrono) en **cada** flip de `$terminalTakeover` y
`$browserTabsOpen`. `store/panes.ts` hace lo mismo con `$paneStates` en cada drag de sash (100+
escrituras por arrastre).

**Cambio.** Helper `persistCoalesced(key, value, {idleMs})` en `src/lib/persisted.ts` o
`src/lib/storage.ts`: memoria inmediata, escritura agrupada en `requestIdleCallback` (fallback
`setTimeout 200`) + flush en `visibilitychange:hidden` y `beforeunload`. Aplicarlo a
`$terminalTakeover`, `$browserTabsOpen`, `$reviewOpen`, `$graphifyOpen`, `$paneStates`.
No cambia la API pública de los stores.

**Archivos.** `apps/desktop/src/lib/storage.ts` (o `persisted.ts`), `app/right-sidebar/store.ts`,
`store/panes.ts`, `store/review.ts`, `store/graphify.ts`.

**Criterios de aceptación.**
- AC1: un toggle escribe localStorage **0** veces de forma síncrona en el handler; como máximo
  una escritura por clave en la ventana idle.
- AC2: el valor se rehidrata correctamente tras `pagehide` (flush) — un toggle seguido de cierre
  inmediato persiste el último valor.
- AC3: un drag de sash de 200 eventos produce **1** escritura de `paneStates` (no 200).
- AC4: sin cambios de comportamiento en el arranque (los valores persistidos mandan igual).

**Pruebas específicas.**
- Nuevo `apps/desktop/src/lib/storage.coalesced.test.ts`:
  - `writes once per burst`, `flushes on pagehide`, `keeps in-memory value immediate`,
    `falls back to setTimeout when requestIdleCallback is absent`.
- Extensión de `apps/desktop/src/store/panes.test.ts`: `a 200-event drag persists paneStates once`.
- Nuevo `apps/desktop/src/store/review.persistence.test.ts`:
  `toggling review does not write localStorage inline`.

---

## 4. Fase P1 — Toggles correctos al primer click (C2, C5)

### P1.4 — `openReview` idempotente, con reveal y sin IPC redundante

**Problema** (todo en `apps/desktop/src/store/review.ts`):
- `openReview()` hace `$reviewOpen.set(true)` + `refreshReview()` + `refreshShipInfo()` +
  `refreshReviewRemoteInfo()` **sin** comprobar si ya está abierto ni si hay refresco en vuelo.
  `refreshShipInfo` ejecuta `gh` (proceso externo) en cada click.
- No despacha `PANE_TOGGLE_REVEAL_EVENT`, a diferencia de `toggleReview()`. Con ventana estrecha
  (`narrowViewport` ⇒ `forceCollapsed`) o pane cerrado por store, `openReview()` no produce ningún
  cambio visible → el usuario vuelve a clickear.
- El botón del statusbar (`use-statusbar-items.tsx`, id `git-provider`) se gatea por `repoPath`
  (carpetas del proyecto activo) mientras el `<Pane>` se gatea por `currentCwd`
  (`disabled={!chatOpen || !currentCwd.trim() || (!narrowViewport && !reviewOpen)}`). Puede haber
  botón visible con pane imposible de abrir.

**Cambio.**
1. `openReview()`:
   - Si ya está abierto y no forzado a colapsado → solo `reveal` (evento) y salir; **no** refetch.
   - Si el pane está forzado a colapsado → `reveal` (mismo camino que `toggleReview`).
   - Si está cerrado → `open` + `reveal` + refrescos.
   - Coalescer: `refreshReview`/`refreshShipInfo`/`refreshReviewRemoteInfo` respetan
     `staleMs` (ya existen `SHIP_INFO_STALE_MS`, `REMOTE_INFO_STALE_MS`; añadir el equivalente al
     listado) y una única sonda en vuelo por recurso (ya hay `seq`, falta el corto-circuito).
2. Nuevo `toggleReviewFromStatusbar()` (o reutilizar `toggleReview`): un solo punto de entrada
   con semántica toggle + reveal, usado por el statusbar y por el keybind, para que el botón
   "Open git pane" cierre/abra como el resto de toggles.
3. Unificar el gate: exponer `reviewAvailable = chatOpen && Boolean($currentCwd.get().trim()) &&
   Boolean(desktopGit()?.review)` como `computed`, y usar **ese** átomo tanto para `hidden` del
   item del statusbar como para `disabled` del `<Pane>`.

**Archivos.** `apps/desktop/src/store/review.ts`,
`apps/desktop/src/app/shell/hooks/use-statusbar-items.tsx`,
`apps/desktop/src/app/desktop-controller.tsx` (gate del `<Pane>`),
`apps/desktop/src/app/hooks/use-keybinds.ts` (si comparte entrada).

**Criterios de aceptación.**
- AC1: con el pane abierto, un click en el botón git lo cierra (comportamiento toggle) — o, si se
  decide "solo abrir", no produce ningún IPC y no cambia nada (decisión explícita y testeada).
- AC2: con `narrowViewport`, un click en el botón git deja el pane visible al primer intento.
- AC3: dos clicks en < 250 ms producen **como máximo** 1 `review.list` y 0 `shipInfo` extra.
- AC4: reabrir el pane tras cerrarlo, dentro de la ventana de staleness, muestra los archivos
  cacheados al instante y refresca en background (sin skeleton).
- AC5: el botón git **no** se muestra si `currentCwd` está vacío, y el `<Pane>` no se puede abrir
  en ese estado (mismo predicado, un solo átomo).
- AC6: p95 click→paint ≤ 50 ms (harness `--case=toggle-git`).

**Pruebas específicas.**
- Nuevo `apps/desktop/src/store/review.toggle.test.ts` (mock de `lib/desktop-git`):
  - `opens once and reveals the pane` — assert `$reviewOpen === true` y
    `PANE_TOGGLE_REVEAL_EVENT` despachado con `detail.id === REVIEW_PANE_ID`.
  - `a second call while open issues no list/shipInfo` — contadores a 1 y 0.
  - `coalesces rapid calls into one in-flight probe`.
  - `reuses the cached file list within the staleness window`.
  - `preserve selection across close/reopen`.
- Nuevo `apps/desktop/src/app/shell/hooks/use-statusbar-items.review.test.tsx`:
  - `hides the git item when no cwd` / `shows it when a cwd exists` (invariante, no snapshot).
  - `clicking the git item toggles instead of only opening`.
- Extensión de `apps/desktop/src/app/right-sidebar/review/index.test.tsx` (si no existe, crear):
  - `(X) closes without issuing git IPC`.

---

### P1.5 — Graphify/Back to chat sin remontar el chat y con caché

**Problema.**
- `apps/desktop/src/app/chat/index.tsx` (`ChatViewSwitch`): en `view === 'graph'` devuelve
  `<GraphifyCanvas/>` y deja de renderizar `children` ⇒ se desmonta `ChatRuntimeBoundary`
  (Thread, composer, PromptOverlays). Al volver se remonta y se re-renderiza el transcript.
- `apps/desktop/src/app/shell/graphify-canvas.tsx`: en Wails hace
  `window.aliceDesktop.readFileText(graphFilePath)` en **cada montaje**, sin caché; ese binding usa
  `defaultPreviewTextLimit = 512 * 1024` y el componente ignora el flag `truncated`, así que un
  `graph.html` real (varios MB) se pinta truncado y se paga la lectura cada toggle.
- El botón de cerrar llama `setChatView('chat')` y además `onClose()` (`setChatView('chat')`):
  doble set (inocuo, pero a limpiar).

**Cambio.**
1. `ChatViewSwitch`: mantener ambos árboles montados y alternar visibilidad (`hidden` /
   `inert`-like) en lugar de desmontar. El chat conserva scroll, composer y drafts; el canvas
   conserva el iframe ya cargado. `aria-hidden` + `pointer-events:none` en el oculto.
2. `GraphifyCanvas`:
   - Caché por `(path, mtimeMs, size)` en un módulo (`lib/graphify-html-cache.ts`) con tope de
     entradas (LRU de 2) y TTL; invalidación por mtime.
   - En Wails, servir el HTML por el **servidor de preview loopback ya existente**
     (`apps/desktop-wails/preview_server.go`, binding `App.PreviewStartForFile` expuesto en el
     bridge como `window.aliceDesktop.previewStartForFile(path) → {id, url, path}`) y apuntar el
     `src` del iframe a `http://127.0.0.1:<port>/p/<token>/` en vez de leerlo y volcarlo a
     `srcDoc`. Elimina el cap de 512 KB, evita la copia a JS y permite streaming. Al desmontar /
     cambiar de cwd, `previewStop(id)`. Fallback a `srcDoc` **solo** si el archivo es < 512 KB y
     el server no está disponible.
   - Estado de carga con el mismo patrón de diagnóstico/retry del preview (banner si
     `truncated` en el fallback o si el server falla).
3. Limpiar el doble `setChatView` y el prop `onClose` redundante.

**Archivos.** `apps/desktop/src/app/chat/index.tsx`,
`apps/desktop/src/app/shell/graphify-canvas.tsx`, nuevo `apps/desktop/src/lib/graphify-html-cache.ts`,
`apps/desktop/src/global.d.ts` (tipos de `previewStartForFile`/`previewStop` ya existentes en
`lib/wails-bridge.ts`), `apps/desktop/src/i18n/*` (mensajes nuevos, ×4 idiomas).

**Criterios de aceptación.**
- AC1: alternar chat↔graph 10 veces no desmonta `Thread` ni `ChatBar` (contador de montajes = 1)
  y el `scrollTop` del thread se preserva.
- AC2: la segunda entrada a graph (mismo cwd, mismo mtime) es visible en ≤ 50 ms y **no** hace
  ninguna lectura de archivo.
- AC3: un `graph.html` de 20 MB se renderiza completo en Wails (sin banner de truncado) y la
  lectura no bloquea el hilo del renderer (el coste está en Go).
- AC4: si `graph.html` no existe → empty state actual ("No graph yet…"), sin error en consola.
- AC5: el cambio de sesión estando en graph sigue volviendo a chat automáticamente.
- AC6: no se introduce ningún `readFileText` sin límite ni `srcDoc` de varios MB en el renderer.

**Pruebas específicas.**
- Nuevo `apps/desktop/src/app/shell/graphify-canvas.test.tsx`:
  - `reads the html once per cwd+mtime` — mock de `readFileText`; remount → `toHaveBeenCalledTimes(1)`.
  - `uses the loopback preview origin in Wails` — mock `isWailsShell` + `previewStartForFile`
    (y `previewStop` en el cleanup); assert `iframe.src` es `http://127.0.0.1:<port>/p/<token>/`
    y **no** hay `srcDoc`; assert `previewStop` llamado al desmontar.
  - `falls back to srcDoc for small files when the server is unavailable`.
  - `shows the empty state when the graph file is missing`.
  - `surfaces a truncation banner when the fallback read is truncated` (regresión del cap 512 KB).
- Nuevo `apps/desktop/src/app/chat/chat-view-switch.test.tsx`:
  - `keeps the chat runtime mounted while graph view is active` — spy de montaje/desmontaje de
    `Thread`; `toggleChatView()` dos veces → 1 mount, 0 unmount.
  - `preserves thread scroll across toggles`.
  - `auto-flips to chat on session change` (regresión).
- `apps/desktop/scripts/measure-interactions.mjs --case=toggle-graph` → p95 ≤ 50 ms con caché.

---

### P1.6 — Terminal y browser tabs sin relayout sorpresa

**Problema.** `terminalAsRow = terminalSidebarOpen && railColumnOpen`, donde `railColumnOpen`
incluye preview/file-browser/review. Abrir browser tabs o el review pane mientras el terminal
está abierto **mueve el terminal de columna a fila inferior**, lo que cambia su geometría y fuerza
un `fit()` del PTY y un repintado de xterm en el mismo commit del click.

**Cambio.**
1. Estabilizar la decisión de layout: mantener el terminal en su modo (columna/fila) durante la
   sesión de uso y recalcular solo en cambios de viewport (`narrowViewport`) o al abrir/cerrar el
   terminal, no al togglear paneles secundarios. Introducir `railLayoutMode` derivado con
   histéresis (evita el flip-flop).
2. Si el cambio de modo es inevitable, mover el trabajo caro fuera del commit: aplicar el cambio
   de grid primero y el `fit()` en `requestIdleCallback`/rAF posterior (coalescido), sin desmontar
   `TerminalWorkspace` (ya se conserva).
3. Browser pane: no montar el iframe hasta que el panel esté visible (hoy `BrowserPane` se monta
   siempre con el `<Pane>`; el iframe solo existe si `activeUrl`, que es estado local, así que el
   montaje inicial es barato — verificar y no regresar).

**Archivos.** `apps/desktop/src/app/desktop-controller.tsx`,
`apps/desktop/src/app/shell/rail-panes.tsx` (nuevo de P1.1),
`apps/desktop/src/app/right-sidebar/terminal/use-terminal-session.ts` (fit diferido).

**Criterios de aceptación.** (Resolución tras implementar B8: el terminal **sí** baja a fila
cuando el rail acumula columnas — el invariante correcto es que la decisión coincida con las
columnas reales, no que nunca cambie.)
- AC1: la decisión fila/columna del terminal coincide con el número real de columnas del rail
  (browser incluido); nunca queda una cuarta columna exprimida.
- AC2: si el modo cambia, hay exactamente 1 `fit()` por transición (coalescido por rAF).
- AC3: `TerminalWorkspace` nunca se desmonta por un toggle de panel.
- AC4: p95 click→paint de `toggle-browser` y `toggle-terminal` ≤ 50 ms.

**Pruebas específicas.**
- Nuevo `apps/desktop/src/app/shell/rail-panes.test.tsx`:
  - `toggling browser tabs does not move the terminal to a bottom row`.
  - `the terminal keeps its mode across secondary pane toggles`.
- Extensión de `apps/desktop/src/store/graphify.test.ts`:
  `the chat view toggle does not mutate the graph source` (invariante de que el toggle es puro estado).
- Nuevo `apps/desktop/src/app/right-sidebar/terminal/fit.test.ts`:
  `fits once per geometry change` con `ResizeObserver` simulado y `fit` espiado.

---

### P1.7 — Bug: `removeSession` restaura un runtime ya cerrado (B1)

**Problema.** En `app/session/hooks/use-session-actions/index.ts`, el camino de fallo de
`removeSession` ejecuta `setActiveSessionId(closingRuntimeId)` **después** de haber cerrado ese
runtime con `session.close`. El hilo se ve restaurado pero `$activeSessionId` apunta a una sesión
muerta: el siguiente envío falla (y bajo gateways pooled el id podría reutilizarse).

**Cambio.** No re-bindear el runtime cerrado:
- Opción A (preferida): mover `session.close` a **después** de que `deleteSession` tenga éxito; en
  el `catch` no hay nada cerrado que restaurar.
- Opción B: en el `catch`, dejar `activeSessionId = null` y confiar en `useRouteResume` para
  re-resolver.

Además, usar `selectedStoredSessionIdRef`/`activeSessionIdRef` para `wasSelected`/`closingRuntimeId`
(hoy lee props, inconsistente con el resto del hook — B10).

**Archivos.** `app/session/hooks/use-session-actions/index.ts`.

**Criterios de aceptación.**
- AC1: un delete que falla deja el transcript restaurado y `$activeSessionId === null` (o un runtime
  vivo re-resuelto), nunca el id cerrado.
- AC2: tras el fallo, un envío inmediato funciona (o reintenta resume) sin "session not found".
- AC3: un delete que falla mientras el usuario ya cambió de sesión no navega ni restaura el hilo
  ajeno (objetivo calculado con refs).

**Pruebas.**
- Extensión de `use-session-actions.test.tsx`:
  - `a failed delete does not leave a closed runtime bound` — assert `$activeSessionId` no es
    `closingRuntimeId` y que se pidió `session.resume` (o `null`).
  - `a failed delete after a session switch does not navigate back`.
  - `a successful delete still tears down the runtime` (regresión).

---

### P1.8 — Bugs de gate del panel git (B3, B4, B11)

**Problema.**
- `openReview()` sin `currentCwd` arma `$reviewOpen` persistido → el panel aparece solo más tarde.
- El botón del statusbar se gatea por `repoPath` (carpeta del proyecto) mientras el `<Pane>` se
  gatea por `currentCwd` → botón muerto / botón ausente.
- `refreshReview` marca `$reviewIsRepo = false` cuando no hay workspace (mensaje "no es un repo"
  incorrecto si el gate cambia).

**Cambio.**
1. `computed` `reviewAvailable = chatOpen && Boolean($currentCwd.get().trim()) &&
   Boolean(desktopGit()?.review)`; usarlo en `hidden` del item y en `disabled` del `<Pane>`, y como
   guard en `openReview()` (no arma el flag si no está disponible).
2. `refreshReview` distingue `no-workspace` de `not-a-repo` (nuevo estado o `null` en
   `$reviewIsRepo`), y el panel muestra el mensaje correcto.
3. Test de invariante: **botón visible ⇔ panel abrible**.

**Archivos.** `store/review.ts`, `app/shell/hooks/use-statusbar-items.tsx`,
`app/desktop-controller.tsx` (gate del `<Pane>`), i18n ×4 si hay mensaje nuevo.

**Criterios de aceptación.**
- AC1: sin cwd, el botón git no se muestra y `$reviewOpen` no cambia si algo lo invoca.
- AC2: con cwd en repo fuera de proyecto, el botón se muestra y abre el panel.
- AC3: el mensaje de "sin workspace" y el de "no es un repo" son distintos y correctos.
- AC4: el invariante botón⇔panel se cumple para las 4 combinaciones (proyecto sí/no × cwd repo sí/no).

**Pruebas.**
- `use-statusbar-items.review.test.tsx`: tabla de 4 casos del invariante.
- `store/review.toggle.test.ts`: *"opening without workspace does not arm the persisted flag"*.
- `app/right-sidebar/review/index.test.tsx`: *"distinguishes no-workspace from not-a-repo"*.

---

### P1.9 — Bug: auto-flip de graph durante el resume (B6)

**Problema.** `ChatViewSwitch` (`app/chat/index.tsx`) ejecuta `if (view === 'graph')
setChatView('chat')` en un efecto con deps `[activeSessionId]`, que corre también en el montaje y
en la transición `null → id` del propio resume. Entrar a una sesión y pulsar "Show graphify" durante
el loader devuelve al usuario a chat en cuanto resuelve el resume.

**Cambio.** Auto-flip solo ante un **cambio real** de sesión ya cargada:
`prevSessionIdRef` + `if (prev !== activeSessionId && activeSessionId !== null && view === 'graph')`.
Se mantiene el comportamiento en un cambio de sesión legítimo.

**Archivos.** `app/chat/index.tsx`.

**Criterios de aceptación.**
- AC1: togglear a graph durante un resume (`activeSessionId` null → id) **no** devuelve a chat.
- AC2: cambiar de sesión estando en graph sí devuelve a chat.
- AC3: entrar a graph en una sesión ya cargada y quedarse (sin cambios de id) no dispara el flip.

**Pruebas.**
- `app/chat/chat-view-switch.test.tsx`: *"does not flip back when the routed session id resolves"*,
  *"flips back on a genuine session switch"* (regresión).

---

### P1.10 — Bug: tres paneles fuera del registro y cálculo del rail (B7, B8)

**Problema.**
- `terminal-sidebar`, `browser-tabs` y `review` no se registran en `$paneStates`; su visibilidad
  depende solo de `disabled`. `togglePane()`/`$paneOpen()` mienten para ellos (latente).
- `railColumnOpen` no incluye `browserTabsOpen`, así que con terminal + browser + review el rail
  queda con 4 columnas en vez de mandar el terminal a fila inferior.

**Cambio.**
1. Decidir y documentar **una** fuente de verdad por panel: recomendar `$paneStates.open` como
   dueño único y derivar `disabled` de la disponibilidad (no de la apertura). Registrar los tres
   paneles en `store/layout.ts` (o en su store) y escribir su visibilidad con `setPaneOpen`.
   `$reviewOpen`/`$browserTabsOpen`/`$terminalTakeover` pasan a ser `computed` o setters que
   escriben el pane store (una sola escritura, sin doble estado).
2. Incluir browser en `railColumnOpen` (o sustituir el cálculo por un `railLayoutMode` con
   histéresis, ver P1.6).

**Archivos.** `store/layout.ts`, `store/review.ts`, `app/right-sidebar/store.ts`,
`app/desktop-controller.tsx`, `components/pane-shell/pane-shell.tsx` (si cambia el contrato).

**Criterios de aceptación.**
- AC1: para cada panel, `$paneStates[id].open` refleja si está visible (invariante testeable).
- AC2: `togglePane('browser-tabs')` oculta/muestra el panel (deja de ser un no-op).
- AC3: no hay dos átomos que puedan discrepar sobre "está abierto" (test: escribir por cualquiera de
  las dos vías converge al mismo estado).
- AC4: con terminal + browser + review abiertos, el terminal pasa a fila inferior (o el rail no
  supera 3 columnas), según el modo elegido.

**Pruebas.**
- Extensión de `store/panes.test.ts` + nuevo `store/pane-visibility.test.ts` con el invariante
  "una sola fuente" (set por vía A ⇒ vía B coincide).
- `app/shell/rail-panes.test.tsx`: *"terminal drops to a row when browser tabs are open"*.

---

### P1.11 — Deuda de persistencia: helper único y coalescido (D8, B12)

**Problema.** 44 claves `alice.desktop.*` con tres mecanismos distintos y escritura síncrona en el
path del click. `$sessionPreviewRegistry` y `$filePreviewTabs` reescriben el objeto completo en cada
cambio.

**Cambio.** Registro central `lib/persisted-keys.ts` (clave + versión + códec + política) y helper
`persistCoalesced` (ya introducido en P1.3). Migrar las claves de estado de UI (paneles, right rail,
preview) al registro; dejar intactas las de configuración de usuario que ya usan `persistentAtom`
(no se toca el formato de datos).

**Archivos.** `lib/persisted.ts`, nuevo `lib/persisted-keys.ts`, stores de UI.

**Criterios de aceptación.**
- AC1: todas las claves de estado de UI aparecen en el registro; un test falla si un store escribe
  una clave no registrada (chequeo estático por lista).
- AC2: ninguna escritura síncrona en el handler de un click (verificado en P1.3).
- AC3: los formatos persistidos existentes se leen sin migración (compatibilidad hacia atrás).

**Pruebas.** `lib/persisted-keys.test.ts` (unicidad, versiones), y el test de invariantes de P1.3.

---

## 4.1. Extensiones al registro de bugs (trazabilidad)

Los bugs B1–B12 del análisis se cubren así: **B1 → P1.7**, **B2 → P1.4**, **B3/B4/B11 → P1.8**,
**B5 → P1.5**, **B6 → P1.9**, **B7/B8 → P1.10**, **B9 → decisión de producto (sin cambio de código
por defecto)**, **B10 → P1.7**, **B12 → P1.3/P1.11**.

---

## 5. Fase P2 — Cambio de sesión (C6)

### P2.1 — Pintar primero, completar después

**Problema.** `apps/desktop/src/app/session/hooks/use-session-actions/index.ts`
(`resumeSession`) hace, en orden y con awaits: `resolveStoredSession` (consulta por id; si falla,
bucle por perfiles) → `ensureGatewayProfile` (puede respawnear un gateway pooled) → `Promise.all`
[`getSessionMessages(stored, profile, 200)`, `session.resume`] → conversión
(`toChatMessages` + `preserveLocalAssistantErrors` + `reconcileResumeMessages` +
`chatMessageArraysEquivalent`) → `setMessages` → `updateSessionState`. Además, en targets fríos,
`setMessages([])` al entrar y `setBusy(true)` durante todo el cambio.

En paralelo, `store/review.ts` y `store/coding-status.ts` reaccionan a `$currentCwd` con sondas
git, y `review.ts` dispara `refreshShipInfo` (proceso `gh`) en el cambio de cwd.

**Cambio.**
1. **Fast path de caché primero:** si `takeWarmCache()` acierta y el runtime está vivo, pintar el
   estado cacheado (`syncSessionStateToView`) *antes* de `session.usage`; hoy ya ocurre, pero se
   debe garantizar que `setBusy(true)` **no** se aplique en ese camino (ya es así) y que el
   `setMessages([])` de entrada ocurra solo si no hay caché (ya es así) — se formaliza con test de
   orden de efectos.
2. **Diferir el trabajo no crítico** con `startTransition` (o `requestIdleCallback`):
   `applyStoredSessionPreviewRuntimeInfo`, `setCurrentUsage` desde `stored`, `refreshShipInfo`,
   `refreshReviewRemoteInfo`. El transcript y el id de runtime van en el commit urgente.
3. **Evitar conversiones duplicadas:** cuando el prefetch hidrata, no convertir el payload de
   `resume` (ya está implementado: se conserva y se testea como invariante); añadir un contador
   dev-only `__aliceResumeStats` (llamadas a `toChatMessages`, longitud del payload, ms por fase)
   para el harness.
4. **Cancelación real:** mantener `resumeRequestRef` (ya existe) y añadir `AbortController` al
   fetch REST de prefetch (`getSessionMessages` acepta señal o se descarta por `seq`), para que
   un switch rápido no procese 200 mensajes que ya no se van a mostrar.
5. **No sondear git durante el switch:** en `coding-status.ts`/`review.ts`, incrementar el debounce
   cuando `$busy` está activo por resume, o pausar las suscripciones de `$currentCwd` mientras
   `$activeSessionId === null` (estado transitorio del switch). El probe corre al asentarse.
6. **Presupuesto de IPC:** el switch debe hacer ≤ 3 llamadas (`getSession`/`resolve`, 
   `getSessionMessages`, `session.resume`) y 0 `gh`.

**Archivos.** `apps/desktop/src/app/session/hooks/use-session-actions/index.ts` (+ `utils.ts`),
`apps/desktop/src/app/session/hooks/use-route-resume.ts`,
`apps/desktop/src/store/coding-status.ts`, `apps/desktop/src/store/review.ts`,
`apps/desktop/src/alice.ts` (solo si hace falta señal de abort).

**Criterios de aceptación.**
- AC1: con caché caliente, el cambio de sesión no emite llamadas de red/IPC y el primer paint es
  ≤ 50 ms.
- AC2: con caché fría, el transcript aparece ≤ 150 ms p95 y `setMessages` se llama **como máximo
  2 veces** por switch (clear + hydrate, o solo hydrate si hay prefetch).
- AC3: un switch rápido A→B→A no aplica el resultado de B (invariante con `resumeRequestRef`),
  ni convierte el payload de B.
- AC4: durante el switch no se ejecuta `gh` (`refreshShipInfo`) ni `review.list`; corren al
  asentarse o al abrir el pane.
- AC5: composer interactivo ≤ 300 ms p95.
- AC6: `session.resume` rechazado sigue cayendo al fallback REST y armando
  `$resumeFailedSessionId` exactamente como hoy (no romper el self-heal).

**Pruebas específicas.**
- Extensión de `apps/desktop/src/app/session/hooks/use-session-actions.test.tsx`:
  - `warm cache paints without any gateway or REST call`.
  - `cold switch hydrates the transcript from the prefetch and skips resume conversion`
    (spy en la conversión: 1 llamada, no 2).
  - `a newer resume supersedes an older one` — resolver B después de A; assert `$messages`
    corresponde a A y no se aplicaron efectos de B.
  - `does not run gh ship-info during a switch` — mock de `desktopGit().review.shipInfo`; assert
    0 llamadas.
  - `keeps the REST fallback + failed latch on resume rejection` (regresión).
- Extensión de `apps/desktop/src/store/coding-status.test.ts`:
  - `defers the repo probe while a session switch is in flight`.
- `apps/desktop/scripts/measure-interactions.mjs --case=switch-session` contra la fixture de 200
  mensajes → p95 de transcript visible y de composer interactivo dentro de presupuesto.

---

## 6. Fase P2 — Observabilidad y prevención de regresiones

### P2.2 — Telemetría dev-only de interacción

Reutilizar el patrón ya existente (`apps/desktop/src/lib/preview-telemetry.ts`): nuevo
`apps/desktop/src/lib/interaction-telemetry.ts` con buffer circular de N=200 eventos
(`toggle-git`, `close-modal`, `switch-session`, `toggle-graph`, …) que registra
`performance.mark`/`measure`, y un panel dev en Settings → Diagnóstico (solo `import.meta.env.DEV`).

**Criterios de aceptación.**
- AC1: en producción (`import.meta.env.PROD`) el módulo es no-op y no se incluye el panel.
- AC2: el buffer está acotado (≤ 200 eventos, sin crecimiento).
- AC3: cada caso del harness puede leer `window.__aliceInteractionStats` para el assert.

**Pruebas.** Nuevo `apps/desktop/src/lib/interaction-telemetry.test.ts`: `no-op in production`,
`bounded buffer`, `records marks with the expected names`.

### P2.3 — Presupuestos en CI (no change-detector)

Dos capas, ninguna congelando valores de datos:

1. **Invariantes de trabajo** (vitest, deterministas): nº de IPC por interacción, nº de renders por
   toggle, nº de `fit()`, nº de escrituras a localStorage, nº de conversiones por switch. Son
   contratos ("un click ⇒ un probe"), no snapshots.
2. **Presupuesto de latencia** (`measure-interactions.mjs`), en dos transportes:
   - **Chromium/Electron:** `--case=all` conduce la UI por CDP y escribe el artefacto.
   - **Wails (sin CDP):** Ajustes → About → *Interaction latency* → **Copy JSON** exporta
     `{samples:[{name,ms}]}`; después
     `node scripts/measure-interactions.mjs --import=capture.json --baseline=perf-baseline.json`
     agrega p95 por interacción y falla solo si alguna se degrada > 40 %. El mismo comando sin
     `--baseline` imprime el resumen.
   Bloqueante en CI solo con un baseline real versionado; sin captura no se inventa.
   `--self-test` cubre `baselineFrom`, `compareToBaseline` y la tabla de casos sin display.

**Criterios de aceptación.**
- AC1: el job de invariantes corre en < 60 s y es determinista (3 ejecuciones → mismo resultado).
- AC2: el job de latencia publica el JSON como artefacto y no rompe el build salvo degradación
  > 40 %.
- AC3: `perf-baseline.json` incluye fecha, commit y máquina (no se actualiza automáticamente).

---

## 7. Deuda arquitectónica — plan de pago (fases D)

El registro completo, con evidencia y severidad, está en
[`ARCHITECTURE-DEBT-ANALYSIS.md`](./ARCHITECTURE-DEBT-ANALYSIS.md) (§2). Aquí solo se fija el
**orden de pago** y el criterio de "cuándo sí".

Distinción importante:
- **D0 (P0.2) es requisito duro**: sin baseline verde no hay gate para los presupuestos.
- **D1 y D2 se recomiendan durante P1** (comparten archivos con el refactor de render).
- **D3–D7 son condicionales**: entran si la medición demuestra ganancia o si el archivo se va a
  tocar de todas formas. No son un prerrequisito para cerrar P0–P2.

| Fase | Deuda | Contenido | Cuándo |
|---|---|---|---|
| **D0** | D12 | Baseline verde + exclusión de globs ajenos (P0.2) | **Antes de P1.1** |
| **D1** | D4 | `wireStores()` explícito: mover las 19 suscripciones de módulo a un único punto invocado desde `main.tsx`. Los stores exportan `wireX()` idempotente; la lectura de persistencia sigue en el constructor del átomo. | Después de P1.1 |
| **D2** | D5 | Sanear capas: mover `PANE_TOGGLE_REVEAL_EVENT`, `SIDEBAR_COLLAPSE_MEDIA_QUERY` y `matchesQuery` a `lib/`; sacar `lastVisibleMessageIsUser` de `app/` a `lib/`; prohibir `store/`/`lib/` → `app/`/`components/` con un test de imports. | Después de P1.1 |
| **D3** | D6, D7 | Partir `ChatSidebar` (37 átomos, 12 efectos) en lista + filas memoizadas + secciones; medir antes y después. `use-session-actions`/`use-prompt-actions` solo si la medición lo justifica (no trocear por trocear). | Después de P2.1 |
| **D4** | D8 | Registro de claves persistidas + versión + escritura coalescida (P1.11 lo introduce). | Junto a P1.11 |
| **D5** | D9 | Adoptar `desktop-capabilities` en los 5 componentes con `isWailsShell()` directo; tipar los bindings por capacidad; bajar `alice.ts` a módulos de dominio (sessions/fs/git/preview) sin cambiar firmas públicas. | Después de P1.5 |
| **D6** | D10, D11 | Borrar el graphify muerto (`$graphifyOpen`, `toggleGraphify`, `closeGraphify`, `GraphifyPane`) y `clearSessionPreviewRegistry` si no se usa. **Sin cablear** código muerto. | PR aparte, cuando P1.5 esté estable |
| **D7** | D13 | Auditar los 17 `catch {}`: exigir comentario de intención o `notifyError`. | Oportunista, no bloqueante |

### Criterios de aceptación transversales de las fases D

- AC-D1: importar cualquier módulo de `store/` no ejecuta IPC, red ni git (test: importar en un
  entorno node sin `window` y assert 0 llamadas a los bridges mockeados).
- AC-D2: test de arquitectura que falla si un archivo de `store/` o `lib/` importa de `app/` o
  `components/` (lista blanca explícita y decreciente).
- AC-D3: `ChatSidebar` re-renderiza solo la fila afectada cuando cambia `$workingSessionIds` de una
  sesión (test de conteo de renders por fila).
- AC-D5: ningún componente llama `isWailsShell()` directamente (test de imports), y las capacidades
  usadas en graphify/preview salen de `desktop-capabilities`.
- AC-D6: cero exportaciones muertas en `store/graphify.ts` y `right-sidebar/graphify/` (el módulo
  desaparece o queda referenciado por producción y con test).

> Regla de oro para estas fases: **cada una entra con un invariante ejecutable** (imports, conteo
> de renders, número de llamadas), nunca con "quedó más limpio".

---

## 7.1 Refactor de arquitectura (fases 1–4, implementadas)

Motivo: aun con las fronteras de P1.1, el composition root seguía suscribiendo
estado de features, así que cada toggle re-renderizaba el shell completo. Se
ejecutaron las cuatro fases acordadas con el usuario.

| Fase | Estado | Qué cambió | Evidencia |
|---|---|---|---|
| **1. Gates declarativos** | ✅ | `<Pane openAtom>` / `bottomRowAtom`; `PaneShell` combina esos átomos en **una** suscripción (`computed`). El controller ya no lee `$reviewOpen`, `$browserTabsOpen`, `$terminalTakeover`, `$previewTarget`, `$filePreviewTarget`, `$fileBrowserOpen`, `$paneOpen`. Derivados en atoms: `$previewRailActive`, `$terminalAsRow`. | `pane-shell.test.tsx` (+3 tests de gates) |
| **2. Hosts independientes** | ✅ | `StatusbarHost` (posee ~20 suscripciones) y `OverlaysHost` (overlays + settings/command-center/cron/profiles/starmap) salen del controller; `TerminalPaneBody` posee `$terminalAsRow`. | `statusbar-host.tsx`, `overlays-host.tsx`, `terminal/pane-body.tsx` |
| **3. Contrato ejecutable** | ✅ | `app/composition-root.test.ts`: falla si el controller vuelve a suscribir átomos de paneles/statusbar/thread; exige los gates declarativos y los hosts. | test (3 casos) |
| **4. Registro dinámico de `PaneShell`** | ✅ **cerrada como innecesaria** | El registro dinámico existía para poder mover los `<Pane>` a `<RailPanes>`. Con la Fase 1 los panes siguen siendo hijos directos **pero** el controller ya no se suscribe a su estado, que era el objetivo. Convertir un primitivo de layout (con hover-reveal/resize) añadiría riesgo de primer paint sin ganancia medible. | `pane-shell.tsx` (gates) + `composition-root.test.ts` |

Resultado observable: un toggle de panel ya no re-renderiza el composition root;
solo el grid de `PaneShell` y el panel afectado. El statusbar y los overlays
tampoco se re-renderizan con eventos de token/uso.

## 8. Relación entre deuda, bugs y los síntomas reportados

| Síntoma | Deuda que lo causa | Bugs implicados | Fase que lo cierra |
|---|---|---|---|
| Toggles lentos / varios clicks | D1, D2, D8 | B2, B4, B7, B8 | P1.1, P1.4, P1.8, P1.10 |
| Cerrar (X) lento | D1, D3 | — | P1.1, P1.2 |
| Cambio de sesión lento | D1, D2, D4 | B1 (fallo), B6 | P2.1, P1.7, P1.9 |
| Graphify lento / roto | D9, D10 | B5, B6 | P1.5, P1.9 |

---

## 9. Matriz de verificación y orden de entrega

| Fase | Entregable | Gate de salida |
|---|---|---|
| P0.0 | `measure-interactions.mjs` + baseline | JSON con n≥20 por caso, estabilidad ≤ 25 % |
| P0.1 | rAF del terminal eliminado | tests `persistent.test.tsx` + `--case=idle` con 0 rAF/s |
| P0.2 / D0 | baseline de tests verde | 3 corridas completas limpias: 167 archivos / 1216 tests, 0 failed, 0 unhandled (B17: guarda de entorno en `desktopGit`; B18: drenaje del scheduler en tests de React; timeouts globales 20 s) |
| P1.1 | render boundaries | `render-scope.test.tsx` verde + p95 toggles ≤ 50 ms |
| P1.2 | overlays sin desmontar chat | `overlay-close.test.tsx` + 0 IPC de sesión al cerrar |
| P1.3 | persistencia coalescida | tests de `storage.coalesced` + 1 escritura por ráfaga |
| P1.4 | git pane al primer click | `review.toggle.test.ts` + `--case=toggle-git` ≤ 50 ms |
| P1.5 | graph sin remount + caché | `graphify-canvas.test.tsx` + `chat-view-switch.test.tsx` |
| P1.6 | terminal estable | `rail-panes.test.tsx` + `fit` 1× por geometría |
| P1.7 | delete fallido sin runtime cerrado (B1) | `use-session-actions` extendido |
| P1.8 | gates del panel git (B3/B4/B11) | `use-statusbar-items.review.test.tsx` |
| P1.9 | auto-flip de graph (B6) | `chat-view-switch.test.tsx` |
| P1.10 | paneles fuera del registro (B7/B8) | `pane-visibility.test.ts` + `rail-panes.test.tsx` |
| P1.11 | registro de persistencia (D8) | `persisted-keys.test.ts` |
| P2.1 | switch de sesión | `use-session-actions` extendido + `--case=switch-session` |
| P2.2/2.3 | telemetría + CI | `interaction-telemetry.test.ts` + job de invariantes |
| D1 | stores sin side effects en import | test de import sin `window` |
| D2 | capas saneadas | test de imports `store/lib → app/components` |
| D3 | sidebar sin re-render global | test de renders por fila |
| D5 | capacidades unificadas | test de imports de `isWailsShell` |
| D6 | código muerto borrado | módulo eliminado o referenciado por producción |

Orden recomendado:
**P0.0 → P0.1 → P0.2/D0 → P1.1 → P1.2 → P1.3 → P1.4 → P1.5 → P1.6 → P1.7 → P1.8 → P1.9 → P1.10 →
P1.11 → P2.1 → P2.2/2.3**, con **D1/D2 en paralelo tras P1.1** (tocan los mismos archivos y
conviene hacerlas antes de P1.4, mientras `store/` está estable) y **D3/D5/D6 después** de P2.1.

Razones del orden:
- **P0.2/D0 antes de P1.1**: sin baseline verde, los invariantes de render y de IPC no tienen gate.
- **P0.1 antes de todo lo medible**: elimina una fuente de jank que contamina cualquier medición.
- **P1.1/P1.2 antes de los bugs de toggles**: ambos cambian `desktop-controller.tsx`; hacer los
  fixes primero obliga a resolver conflictos en el mismo archivo.
- **D1/D2 tras P1.1**: al mover suscripciones ya se tocan los stores; hacerlo con el shell estable es
  mecánico.
- **D6 al final**: borrar el graphify muerto es trivial pero conviene que P1.5 haya fijado la
  implementación viva.

### Comandos de verificación

```bash
# typecheck + lint del renderer
cd apps/desktop && npm run typecheck && npm run lint

# suites nuevas/tocadas (jsdom)
cd apps/desktop && npx vitest run --environment jsdom \
  src/app/desktop-controller.render-scope.test.tsx \
  src/app/desktop-controller.overlay-close.test.tsx \
  src/app/shell/rail-panes.test.tsx \
  src/app/shell/graphify-canvas.test.tsx \
  src/app/chat/chat-view-switch.test.tsx \
  src/app/shell/hooks/use-statusbar-items.review.test.tsx \
  src/store/review.toggle.test.ts \
  src/store/pane-visibility.test.ts \
  src/store/panes.test.ts \
  src/lib/storage.coalesced.test.ts \
  src/lib/persisted-keys.test.ts \
  src/app/right-sidebar/terminal/persistent.test.tsx \
  src/app/right-sidebar/terminal/fit.test.ts \
  src/app/session/hooks/use-session-actions.test.tsx \
  src/app/session/hooks/use-route-resume.test.tsx \
  src/lib/interaction-telemetry.test.ts

# suite completa del renderer (debe estar VERDE tras P0.2 y seguir verde)
cd apps/desktop && npm run test:ui

# si se toca Go (solo si P1.5 usa el preview server para graph.html)
cd apps/desktop-wails && go vet ./... && go test ./...

# medición (requiere display + Electron con --inspect=9222)
cd apps/desktop && npm run profile:main &   # en otra terminal
node apps/desktop/scripts/measure-interactions.mjs --case=all --reps=20
```

---

## 10. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| P1.1 (split del controller) rompe wiring de props/acciones | Cambio mecánico sin alterar comportamiento; la suite existente de shell/controller debe pasar **sin** modificar expectativas; se hace en un commit aislado y revertible |
| P1.2 deja el chat montado bajo overlays y duplica atajos/foco | Los overlays ya son modales; verificar que los keybinds del chat respetan `currentView !== 'chat'` (test de regresión de atajos mientras Settings está abierto) |
| P1.4 cambia semántica del botón git (toggle vs solo abrir) | Decisión explícita documentada en el AC1 + test; si se prefiere "solo abrir", el segundo click debe ser un no-op sin IPC |
| P1.5 mete el preview server en el path de graphify | Reutiliza infraestructura ya endurecida (loopback+token, `TestPreviewPathDenied`, `TestPreviewServerRejectsTraversal`); fallback a `srcDoc` si el server no arranca; no cambia Electron |
| P1.6 histéresis de layout se siente "pegajosa" | Se limita a paneles secundarios; el resize de ventana siempre re-evalúa; test de comportamiento |
| P2.1 diferir `refreshShipInfo` puede mostrar el chip desactualizado | Se refresca al abrir el pane y al asentar el turno (ya existen ambos edges); TTL de 30 s se mantiene |
| Los presupuestos de latencia son sensibles a la máquina | Job no bloqueante + baseline versionado con fecha/commit; bloqueo solo ante degradación > 40 % |
| Código muerto de graphify (`toggleGraphify`, `$graphifyOpen`, `GraphifyPane`) | **No** se cablea (política del repo: no wiring sin E2E). Se poda en D6, en un PR aparte |
| P0.2 excluye tests del glob y eso "esconde" cobertura | Se excluyen solo archivos que vitest **no puede** ejecutar (`node --test`, Playwright, artefactos de build). Los de `src/` se arreglan, no se excluyen; el gate es 0 failed, no "menos archivos" |
| P1.7 cambia el orden de `session.close` vs `deleteSession` | Si el backend depende de cerrar el runtime antes de borrar, se usa la opción B (dejar `activeSessionId = null`); ambas están cubiertas por el mismo AC y test |
| P1.10 unifica la fuente de verdad de paneles y puede romper persistencia previa | El test de P1.11 exige compatibilidad de lectura hacia atrás; los tres paneles afectados no tenían `open` persistido, así que no hay migración de datos |
| D1 (`wireStores()`) puede cambiar el orden de inicialización | El orden se fija explícitamente en `main.tsx` antes del render; test de import sin `window` garantiza que importar un store no ejecuta side effects |
| D2 (capas) obliga a mover constantes/eventos | Movimiento mecánico con re-export temporal para no romper imports; el test de arquitectura se introduce con lista blanca decreciente |
| D3 (partir `ChatSidebar`) es el mayor diff de UI | Se hace al final y con medición por fila; si no hay ganancia demostrable, no se hace (D3 es condicional, no obligatoria) |

---

## 11. Anexo — Hallazgos con referencia de código

### 11.1 Hallazgos de los síntomas (C)

| ID | Archivo | Hecho |
|---|---|---|
| C1 | `apps/desktop/src/app/desktop-controller.tsx` | 19 `useStore` + `useStatusbarItems` en el mismo componente que renderiza `Thread`, sidebar, 5 `<Pane>` y `overlays` |
| C2 | `apps/desktop/src/store/review.ts` (`openReview`) | sin guard de apertura, sin `PANE_TOGGLE_REVEAL_EVENT`, 3 refrescos por click (uno lanza `gh`) |
| C2b | `apps/desktop/src/app/shell/hooks/use-statusbar-items.tsx` (`git-provider`) | gate por `repoPath` (proyecto) ≠ gate del `<Pane>` por `currentCwd` |
| C3 | `apps/desktop/src/app/desktop-controller.tsx` (tabla de rutas) + `use-overlay-routing.ts` | rutas overlay con `element={null}` desmontan el chat; cerrar remonta `ChatPage` y el efecto de ruta vuelve a evaluar `resumeSession` |
| C4 | `apps/desktop/src/app/right-sidebar/terminal/persistent.tsx` | `requestAnimationFrame` recursivo + `getBoundingClientRect()` por frame, sin condición de parada |
| C5 | `apps/desktop/src/app/chat/index.tsx` (`ChatViewSwitch`) | desmonta `ChatRuntimeBoundary` al entrar en graph |
| C5b | `apps/desktop/src/app/shell/graphify-canvas.tsx` + `apps/desktop-wails/fs_service.go` | `readFileText` por montaje, cap `defaultPreviewTextLimit = 512*1024`, `truncated` ignorado |
| C6 | `apps/desktop/src/app/session/hooks/use-session-actions/index.ts` (`resumeSession`) | cadena secuencial resolve→perfil→prefetch+RPC→conversión→estado; `setBusy` durante todo el switch |
| C6b | `apps/desktop/src/store/review.ts`, `apps/desktop/src/store/coding-status.ts` | suscripciones a `$currentCwd` disparan sondas git + `gh` durante el switch |

### 11.2 Deuda arquitectónica (D) — resumen

`D1` fronteras de render · `D2` visibilidad de paneles con 3 mecanismos · `D3` rutas overlay
desmontan el chat · `D4` 19 suscripciones de módulo · `D5` violaciones de capas · `D6` god hooks ·
`D7` mega-pantallas con exceso de suscripciones · `D8` persistencia ad-hoc (44 claves) · `D9` IPC
monolítico y bypass de capacidades · `D10` implementaciones duplicadas · `D11` código muerto ·
`D12` baseline de tests rojo · `D13` errores silenciados.

Detalle, evidencia y severidad: [`ARCHITECTURE-DEBT-ANALYSIS.md`](./ARCHITECTURE-DEBT-ANALYSIS.md) §2.

### 11.3 Bugs de lógica (B) — resumen

`B1` delete fallido re-bindea runtime cerrado · `B2` "open git pane" no-op (ya abierto/estrecho) ·
`B3` `$reviewOpen` armado sin cwd · `B4` gate botón ≠ gate panel · `B5` graph truncado a 512 KB ·
`B6` auto-flip de graph durante resume · `B7` tres paneles fuera de `$paneStates` · `B8`
`railColumnOpen` ignora browser · `B9` `closeRightRail` descarta tabs (decisión) · `B10`
`removeSession` usa props en vez de refs · `B11` "no es repo" cuando no hay workspace · `B12`
persistencia sin coalescer.

Detalle, repro y test propuesto: [`ARCHITECTURE-DEBT-ANALYSIS.md`](./ARCHITECTURE-DEBT-ANALYSIS.md) §4.
