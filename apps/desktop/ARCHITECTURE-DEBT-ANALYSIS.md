# Análisis de deuda arquitectónica y bugs de lógica — Alice Desktop

> Fecha: 2026-11-14. Alcance: `apps/desktop/src` (renderer Wails/Electron).
> Método: lectura dirigida de los caminos críticos (shell, panes, sesión, chat, right-rail,
> stores), métricas estáticas sobre el árbol y ejecución de la suite del renderer.
> **Confianza**: cada hallazgo se marca `[V]` verificado leyendo el código citado, `[I]`
> inferido (requiere medición o repro en GUI).
> Nada de lo aquí descrito está implementado; el plan de acción vive en
> `INTERACTION-PERFORMANCE-PLAN.md`.

---

## 1. Métricas del estado actual

| Capa | Archivos (sin tests) | Líneas |
|---|---:|---:|
| `app/` | 234 | 56 972 |
| `components/` | 159 | 23 232 |
| `store/` | 56 | 11 141 |
| `lib/` | 76 | 10 937 |
| `hooks/` | 6 | 217 |
| `i18n/` | 11 | 11 989 |
| `types/` | 1 | 893 |

| Métrica | Valor | Lectura |
|---|---:|---|
| Átomos exportados en `store/` | 221 | Superficie de estado amplia pero acotada |
| Átomos en `store/session.ts` | 40 | Un solo módulo para todo el dominio de sesión |
| Usos de `memo()` en `app/` + `components/` | 8 (de 393 archivos) | No hay disciplina de memoización |
| `useStore` en `app/chat/sidebar/index.tsx` | 37 | Contenedor-lista que re-renderiza todo el árbol |
| `useStore` en `app/chat/index.tsx` | 20 | Contenedor de `Thread` |
| `useStore` en `app/shell/hooks/use-statusbar-items.tsx` | 19 | Suscripciones del statusbar |
| `useStore` en `app/desktop-controller.tsx` | 19 | Composition root |
| `useEffect` en `desktop-controller.tsx` | 18 (1 282 líneas) | Cableado de ciclo de vida en un solo sitio |
| `useEffect` en `app/chat/sidebar/index.tsx` | 12 (1 414 líneas) | Ídem |
| Suscripciones a nivel de módulo en `store/` | 19 en 10 archivos | Side effects en import |
| Claves de `localStorage` | 44 | Persistencia ad-hoc |
| `window.aliceDesktop` en `lib/alice.ts` | 87 (1 046 líneas) | Capa IPC monolítica |
| Usos directos de `isWailsShell()` en componentes | 5 | Bypass del módulo de capacidades |
| `catch {}` vacíos (sin intención documentada) | 17 | Errores silenciados |

**Conclusión de las métricas.** El problema no es el tamaño total (~116 k líneas de producción es razonable para
esta superficie), sino la **distribución**: 5 archivos concentran el estado de UI de toda la app y
solo 8 componentes están memoizados. La consecuencia es que un cambio de estado hoja (abrir un
panel) recorre el árbol completo.

---

## 2. Registro de deuda arquitectónica

### D1 — Sin fronteras de render: 3 contenedores absorben el estado de sus hojas `[V]`

**Evidencia.**
- `app/desktop-controller.tsx` suscribe 19 átomos (líneas ~170–185) + `useStatusbarItems` (línea
  ~885, que suscribe 19 más). Renderiza `ChatView`, sidebar, 5 `<Pane>` y el fragmento `overlays`.
- `app/chat/index.tsx` (`ChatView`) suscribe 20 átomos y renderiza `Thread` y `ChatBar`.
- `app/chat/sidebar/index.tsx` suscribe 37 átomos y renderiza la lista completa.

**Impacto.** Cada toggle de panel re-renderiza el shell entero y **anula el bailout por identidad
de elemento** que el propio código documenta como invariante:

```
// PERF: ChatView must not subscribe to $messages … the stream's render cost stays
// confined to the streaming message's own subtree.
```
(`app/chat/index.tsx`, docblock de `ChatRuntimeBoundary` y comentario en `ChatView`)

Ese invariante solo se cumple si `ChatView` **no** re-renderiza. Hoy re-renderiza por (a) estado de
paneles en el controller y (b) `$busy`/`$awaitingResponse`/`$contextSuggestions`, que sí cambian
durante un turno.

**Severidad:** alta (es la causa raíz de los 4 síntomas reportados).
**Acción:** P1.1 del plan (partir en `ChatSurface` / `RailPanes` / `AppStatusbar` /
`DesktopOverlays`).

---

### D2 — Visibilidad de paneles con 3 mecanismos y 2 fuentes de verdad `[V]`

**Evidencia.** Un `<Pane>` está abierto si `!disabled && !forceCollapsed && stateOpen`
(`components/pane-shell/pane-shell.tsx`, `paneIsOpen`). Los tres mecanismos coexisten:
1. `$paneStates[id].open` (store `panes.ts`, persistido).
2. `disabled={…}` (flag por átomo: `$reviewOpen`, `$browserTabsOpen`, `$terminalTakeover`).
3. `forceCollapsed` (ancho de ventana) + `forced` local (reveal por evento).

Además, **tres paneles nunca se registran en `$paneStates`**: `terminal-sidebar`, `browser-tabs` y
`review` (solo `chat-sidebar`, `file-browser` y `preview` lo hacen en `store/layout.ts`). Su `Pane`
los registra on-mount con `defaultOpen`, así que su `stateOpen` es siempre `true` y no participa.

**Impacto.**
- `togglePane('terminal-sidebar')` / `$paneOpen('browser-tabs')` son semánticamente falsos (latente:
  cualquier consumidor futuro leerá estado incorrecto).
- `openReview()` no puede "revelar" en modo estrecho (ver B2): el mecanismo 3 exige un evento que
  ese camino no despacha.
- El estado de apertura de estos paneles no se persiste con el resto (usa claves propias).

**Severidad:** media-alta (bug latente + causa del síntoma "varios clicks").
**Acción:** P1.4 (unificar el gate) + D2 en la fase de deuda (un solo dueño por panel).

---

### D3 — Las rutas overlay desmontan el chat `[V]`

**Evidencia.** `app/desktop-controller.tsx`, tabla de rutas: `settings`, `command-center`, `agents`,
`profiles`, `cron` → `element={null}`. Al navegar, `<Route element={chatView}>` deja de matchear y
`ChatView` se desmonta. `closeOverlayToPreviousRoute` (`app/shell/hooks/use-overlay-routing.ts`)
vuelve a `/:sessionId` → remonta `ChatView` y `useRouteResume` reevalúa la ruta.

**Impacto.** Cerrar Settings/Command Center cuesta un remontaje completo del hilo (hasta 300 parts)
y, si el runtime no está bindeado, un `resumeSession`.

**Severidad:** alta (síntoma "cerrar con (X) tarda").
**Acción:** P1.2.

---

### D4 — Side effects a nivel de módulo en los stores `[V]`

**Evidencia.** 19 suscripciones en 10 archivos, de las cuales 8 disparan IPC, red o git:

| Archivo | Suscripción | Efecto |
|---|---|---|
| `store/profile.ts:165` | `$activeGatewayProfile` | `setApiRequestProfile` + `queryClient.invalidateQueries()` global + `resetStarmapGraph()` |
| `store/coding-status.ts:140,144,148,154` | cwd / worktree / tick / busy | 1 `git status` (debounced 100 ms) por edge |
| `store/review.ts:511,520,532` | tick / busy / cwd | `git review list` + `gh` shipInfo |
| `store/panes.ts:82`, `store/preview.ts:104`, `store/keybinds.ts:55`, `store/pet-overlay.ts:68`, `store/haptics.ts:9`, `store/tool-view.ts:19-20`, `store/completion-sound.ts:28`, `store/profile.ts:49,81,278` | varios | escritura síncrona de `localStorage` |

**Impacto.**
- Importar un store puede ejecutar IPC/red (efecto no obvio para tests y para el arranque).
- Imposible razonar sobre orden de inicialización entre módulos.
- Fugas entre tests (ver §4): los átomos son globales de módulo y `localStorage` no se limpia.
- Persistencia síncrona en el path de clicks (ver D8).

**Severidad:** media-alta.
**Acción:** fase D1 del plan (mover los side effects a un `wireStores()` explícito invocado desde
`main.tsx`; persistencia coalescida en P1.3).

---

### D5 — Violaciones de capas `[V]`

**Evidencia.**
- `store → app`: `session.ts` importa `lastVisibleMessageIsUser` de `@/app/chat/thread-loading`;
  `review.ts` importa `SIDEBAR_COLLAPSE_MEDIA_QUERY` de `@/app/layout-constants` y `matchesQuery`
  de `@/hooks/use-media-query`; `projects.ts` importa de `app/`.
- `store/lib → components`: `graphify.ts` y `review.ts` importan `PANE_TOGGLE_REVEAL_EVENT` de
  `@/components/pane-shell`; `lib/chat-runtime.ts` importa de `components/`.
- `lib → app`: `lib/gateway-events.ts`, `lib/chat-runtime.ts`.

**Impacto.** La capa de datos depende de la de UI: importar un store arrastra React y módulos de
página. Riesgo de ciclos, tests que necesitan jsdom para probar lógica pura, y refactors de UI que
obligan a tocar stores.

**Severidad:** media.
**Acción:** ✅ **fase D2 completada.** Movidos a `lib/`: `PANE_TOGGLE_REVEAL_EVENT`
(`lib/pane-events.ts`), `SIDEBAR_COLLAPSE_MEDIA_QUERY` (`lib/layout-constants.ts`),
`matchesQuery` (`lib/media-query.ts`), `lastVisibleMessageIsUser` (`lib/chat-messages.ts`),
`liveSessionProjectId`/`kanbanWorktreeDir` (`lib/session-projects.ts`) y `formatRefValue`
(`lib/directive-text.ts`). Los módulos originales los re-exportan, así que no cambió ninguna
firma. `architecture-layers.test.ts` prohíbe imports **de valor** desde `store/`/`lib/` a
`app/`/`components/`/`hooks/` (los `import type` siguen permitidos: se borran en build y no crean
ciclo); verificado en negativo inyectando una violación temporal.

---

### D6 — God hooks `[V]`

| Archivo | Líneas |
|---|---:|
| `app/session/hooks/use-session-actions/index.ts` | 960 |
| `app/session/hooks/use-prompt-actions/index.ts` | 937 |
| `app/right-sidebar/terminal/use-terminal-session.ts` | 863 |
| `app/chat/composer/index.tsx` | 1 012 |
| `app/chat/right-rail/preview-file.tsx` | 1 139 |

Contrapeso: `use-session-actions` ya se partió en `utils.ts` y `use-prompt-actions` en
`submit.ts`/`slash.ts`/`utils.ts`, y el estado de sesión tiene un cache con concurrencia bien
resuelta (`use-session-state-cache.ts`: `resumeRequestRef`, coalescing por rAF, `sameMessageList`).
No es un desastre: es deuda de tamaño, no de diseño.

**Severidad:** media.
**Acción:** fase D3, solo con coste justificado (no trocear por trocear).

---

### D7 — Mega-pantallas con demasiadas suscripciones `[V]`

`chat/sidebar` (1 414 líneas, 37 átomos, 12 efectos), `desktop-controller` (1 282, 19, 18),
`settings/model-settings` (990), `cron` (922), `artifacts` (906), `starmap/star-map` (974).

**Impacto.** La sidebar es el caso más claro: cualquier cambio en cualquiera de sus 37 átomos
re-renderiza la lista completa. Con 50 sesiones visibles es tolerable; con `Load more` acumulado y
filas con menús contextuales, no.

**Severidad:** media.
**Acción:** fase D3; medir antes de tocar (no está en el camino de los síntomas reportados).

---

### D8 — Persistencia ad-hoc `[V]`

44 claves `alice.desktop.*`, tres mecanismos (`persistentAtom` con códec, `atom` + `subscribe` +
`persist*`, y escrituras manuales), sin esquema ni versión salvo `.v1` en tres de ellas, y con
escritura síncrona en cada cambio (`$paneStates` durante el drag del sash, `$terminalTakeover` y
`$browserTabsOpen` en cada toggle).

**Impacto.** Coste en el path del click; imposible auditar retención; migraciones futuras sin red.

**Severidad:** media.
**Acción:** P1.3 (coalescing) + fase D4 (registro único de claves versionadas).

---

### D9 — Capa IPC monolítica y bypass de capacidades `[V]`

`lib/alice.ts` 1 046 líneas con 87 usos directos de `window.aliceDesktop`; `lib/wails-bridge.ts`
926 líneas; 5 componentes llaman `isWailsShell()` por su cuenta en vez de usar
`lib/desktop-capabilities.ts`.

**Impacto.** La paridad Wails/Electron se decide en sitios dispersos (el bug de `readFileText`
truncado en graphify es exactamente eso). No hay un punto único donde verificar "qué puede hacer
este shell".

**Severidad:** media.
**Acción:** P1.5 (usar capacidades + preview server) y fase D5 (adoptar `desktop-capabilities` en
los 5 sitios y tipar los bindings por capacidad).

---

### D10 — Implementaciones duplicadas `[V]`

- **Graphify**: `app/shell/graphify-canvas.tsx` (vista fullscreen, viva) y
  `app/right-sidebar/graphify/index.tsx` (`GraphifyPane`, **muerto**) duplican la derivación de ruta
  y la lectura del HTML.
- **Preview**: dos caminos de apertura (`setSessionPreviewTarget` y `openFilePreviewTarget`) con
  semántica distinta de persistencia.
- **Repo gate**: `repoPath` (proyectos) vs `$currentCwd` (sesión) para "¿hay repo?".

**Severidad:** baja-media (la duplicación muerta es la que más engaña).
**Acción:** B6/B10 y fase D6 (borrar, no cablear).

---

### D11 — Código muerto `[V]`

`$graphifyOpen`, `toggleGraphify`, `closeGraphify`, `GraphifyPane` no tienen consumidores fuera de
sus propios módulos y tests. `clearSessionPreviewRegistry()` no se llama desde producción.

**Severidad:** baja (mantenimiento y confusión).
**Acción:** fase D6, en un PR separado (política del repo: no cablear código muerto sin E2E).

---

### D12 — El baseline de tests no está verde `[V]`

Ejecución del 2026-11-14 (`npm run test:ui`): **1 146 tests / 197 archivos → 23 failed, 1 123
passed; 58 archivos marcados como fallidos, 2 errores no capturados.** Clasificación:

| Grupo | Nº | Diagnóstico |
|---|---:|---|
| `electron/*.test.cjs`, `scripts/*.test.cjs`, `e2e/*.spec.ts` | 34 archivos | Los recoge el glob de vitest pero son `node --test`/Playwright: fallan siempre. Ruido estructural. |
| `build/native-deps/**`, `release/**` | 12 archivos | Artefactos de build con tests de node-pty dentro del árbol. Ruido. |
| Fallos reales de `src/` | 12 archivos / 23 tests | 3 investigados (abajo); el resto se reparte entre `model-settings` (7), `thread/block-direction` (4), `fallback-model` (2), `user-message-edit` (2), `streaming`, `onboarding`, `toolset-config-panel`, `composer/attachments`, `use-gateway-boot` |

Los 3 fallos de `src/` investigados:

1. `store/panes.test.ts` → *"width override is in-memory only — not persisted"*: el código **sí**
   persiste `widthOverride` (`panes.ts`, comentario "Persists both open state and resize width").
   **Test obsoleto** respecto a un cambio de comportamiento intencional.
2. `pane-shell.test.tsx` → *"uses widthOverride from the store when set"*: el test no pasa
   `resizable`, y `trackForPane` solo aplica el override si `pane.resizable`. **Test obsoleto.**
3. `use-preview-routing.test.tsx` → *"does not auto-open a preview from tool results"*: la clave
   `alice.desktop.sessionPreviews.v1` aparece escrita. El hook **no** auto-registra previews; la
   escritura viene de un test anterior del mismo archivo (átomos de módulo + `localStorage` sin
   reset entre tests). **Fuga de aislamiento**, no bug de producto.

**Impacto.** Es la deuda más cara de todas: mientras el baseline esté rojo no se puede usar la
suite como gate de los presupuestos de latencia, y los fallos reales se esconden entre 46 archivos
de ruido. Además la fuga entre tests demuestra el coste de D4.

**Severidad:** alta (bloquea P2.3).
**Acción:** P0.2 del plan (dejar el baseline verde y clasificado).

---

### D13 — Errores silenciados `[V]`

17 `catch {}` vacíos sin comentario de intención, además de decenas de `catch(() => undefined)`.
Algunos son correctos (teardown best-effort), otros ocultan fallos de UI que el usuario ve como
"no pasó nada" — el mismo síntoma que estamos persiguiendo.

**Severidad:** baja-media.
**Acción:** fase D7 (auditar y exigir comentario o `notifyError`), sin cambio masivo.

---

## 3. Cómo se relaciona la deuda con los síntomas reportados

| Síntoma | D1 | D2 | D3 | D4 | D8 | D9 | D12 |
|---|---|---|---|---|---|---|---|
| Toggles lentos / varios clicks | ●●● | ●● | | | ● | ● | |
| Cerrar (X) lento | ●●● | | ●●● | | ● | | |
| Cambio de sesión lento | ●● | ● | ● | ●● | | | |
| Graphify lento / roto | ●● | | | | | ●●● | |

---

## 4. Registro de bugs de lógica

Severidad: **alta** = corrompe estado o rompe una feature; **media** = comportamiento incorrecto
observable; **baja** = cosmético o latente.

### B1 — `removeSession` restaura un runtime ya cerrado `[V]` — alta

**Dónde.** `app/session/hooks/use-session-actions/index.ts` (`removeSession`).
**Secuencia.** `wasSelected` → `closingRuntimeId = activeSessionId` → `startFreshSessionDraft(true)`
(navega a `/`) → `await session.close({session_id: closingRuntimeId})` → `await deleteSession(...)`
falla → `catch`: restaura `$messages`, navega de vuelta y `setActiveSessionId(closingRuntimeId)`.
**Por qué es bug.** El runtime se cerró unas líneas antes. El hilo se ve restaurado pero
`$activeSessionId` apunta a una sesión muerta: el siguiente envío falla con "session not found"
(recuperable solo por el retry de `submit.ts`), y con gateways pooled el id podría reutilizarse.
**Fix.** En el `catch`, no re-bindear: dejar `activeSessionId = null` y permitir que
`useRouteResume` re-resuelva, o mover el `session.close` a después del `deleteSession` exitoso.
**Test.** Extender `use-session-actions.test.tsx`: *"a failed delete re-opens the session with no
runtime id bound"* — assert `$activeSessionId === null` y que `session.resume` se vuelve a pedir.

### B2 — "Open git pane" es un no-op cuando ya está abierto o en ventana estrecha `[V]` — alta

**Dónde.** `store/review.ts` (`openReview`) + `app/shell/hooks/use-statusbar-items.tsx`
(`git-provider`).
**Por qué.** `openReview()` hace `$reviewOpen.set(true)` + 3 refrescos, sin comprobar si ya está
abierto y **sin** `PANE_TOGGLE_REVEAL_EVENT` (que `toggleReview()` sí despacha para el modo
`forceCollapsed`). Con el panel ya visible, el click no produce cambio; con ventana estrecha, el
panel es un overlay colapsado y tampoco aparece.
**Fix.** Guard de idempotencia + reveal + coalescing (P1.4).
**Test.** `review.toggle.test.ts`: *"reveals the pane"*, *"a second call issues no list/shipInfo"*.

### B3 — `openReview()` sin cwd deja `$reviewOpen` persistido en `true` `[V]` — media

**Dónde.** `store/review.ts` (`$reviewOpen` es `persistentAtom`; el `<Pane>` está `disabled` sin
cwd). Abrir git desde una sesión detached activa el flag, no muestra nada, y el panel aparecerá
solo al entrar después en una sesión con repo.
**Fix.** No abrir sin cwd (el gate unificado de P1.4 hace que el botón no exista), o abrir y
revertir el flag si el pane no puede mostrarse.
**Test.** *"opening review without a cwd does not arm the persisted open flag"*.

### B4 — Gate del botón git ≠ gate del panel `[V]` — media

**Dónde.** statusbar usa `repoPath` (primera carpeta del proyecto activo); el `<Pane>` usa
`currentCwd`. Resultado: botón visible en proyectos sin repo (click muerto) y botón ausente en
sesiones con repo fuera de proyecto (no se puede abrir desde el statusbar).
**Fix.** Un `computed` `reviewAvailable` compartido.
**Test.** `use-statusbar-items.review.test.tsx`: invariante "botón visible ⇔ panel abrible".

### B5 — `GraphifyCanvas` ignora `truncated` (cap 512 KB en Wails) `[V]` — alta

**Dónde.** `app/shell/graphify-canvas.tsx` usa `readFileText(...).text` sin mirar `truncated`;
`apps/desktop-wails/fs_service.go` limita a `defaultPreviewTextLimit = 512 * 1024`.
**Por qué.** Un `graph.html` real supera el cap: el iframe recibe HTML cortado (JS incompleto) y
el usuario ve un grafo vacío o a medias, sin diagnóstico.
**Fix.** Servir por el preview server loopback + caché por mtime + banner de truncado en el
fallback (P1.5).
**Test.** `graphify-canvas.test.tsx`: *"surfaces a truncation banner when the fallback read is
truncated"*, *"uses the loopback preview origin in Wails"*.

### B6 — El auto-flip a chat expulsa al usuario de graph durante un resume `[V]` — media

**Dónde.** `app/chat/index.tsx` (`ChatViewSwitch`): `useEffect(() => { if (view === 'graph')
setChatView('chat') }, [activeSessionId])`. Corre también en el montaje y en la transición
`null → id` que produce el propio resume.
**Repro.** Entrar a una sesión y pulsar "Show graphify" mientras el loader aún está: al resolver
el resume, el efecto devuelve a chat.
**Fix.** Recordar el id anterior y solo auto-flip cuando **cambia** con una sesión distinta ya
cargada; o mover la decisión al store junto al cambio de sesión.
**Test.** `chat-view-switch.test.tsx`: *"does not flip back when the routed session id resolves"*.

### B7 — Tres paneles fuera del registro de panes `[V]` — media (latente)

`terminal-sidebar`, `browser-tabs`, `review` no se registran en `$paneStates` (ver D2). El store
reporta `open: false` para paneles visibles y `togglePane()` no tiene efecto sobre ellos.
**Fix.** Registrar los tres con `open` gobernado por su átomo, o eliminar el `disabled` y usar solo
el store (una fuente). Decisión de diseño; AC explícito en la fase D2.

### B8 — `railColumnOpen` ignora el panel de browser `[V]` — media

**Dónde.** `desktop-controller.tsx`: `terminalAsRow = terminalSidebarOpen && railColumnOpen`, y
`railColumnOpen` cuenta preview, file-browser y review pero **no** `browserTabsOpen`. Con terminal +
browser + review abiertos, el rail queda con 4 columnas en vez de mandar el terminal a fila.
**Fix.** Incluir browser en el cálculo o cambiar el modelo a "modo del rail" con histéresis (P1.6).

### B9 — `closeRightRail()` descarta todas las pestañas de archivo `[V]` — baja (decisión)

**Dónde.** `store/preview.ts` (`closeRightRail`). Cerrar el preview vivo borra también las pestañas
`file:` abiertas. Está documentado como intencional, pero es una pérdida de contexto silenciosa.
**Acción.** Confirmar con producto; si se mantiene, decirlo en la UI.

### B10 — `removeSession` usa estado en vez de refs `[V]` — baja

`wasSelected` se calcula con `selectedStoredSessionId` (prop) y `closingRuntimeId` con
`activeSessionId` (prop), mientras el resto del hook usa `*Ref`. Una eliminación disparada desde un
menú abierto antes de un cambio de sesión puede operar sobre el objetivo equivocado.
**Fix.** Usar `selectedStoredSessionIdRef`/`activeSessionIdRef` (consistencia con el resto).

### B11 — `refreshReview` marca "no es un repo" cuando en realidad no hay workspace `[V]` — baja

`$reviewIsRepo.set(Boolean(ctx))` con `ctx === null` por falta de cwd. Cosmético (el panel está
disabled en ese estado), pero el mensaje sería incorrecto si el gate cambia (B4).

### B12 — Persistencia en cada set, sin coalescer `[V]` — baja (rendimiento)

`$sessionPreviewRegistry` y `$filePreviewTabs` se reescriben completos en cada cambio;
`$terminalTakeover`/`$browserTabsOpen` en cada toggle; `$paneStates` en cada evento de drag.
**Fix.** P1.3.

### B13 — `use-gateway-boot` no podía manejar su propio fallo `[V]` — alta

**Dónde.** `app/gateway/hooks/use-gateway-boot.ts`, `boot()`.
**Qué.** `const log = …` se declaraba **dentro** del `try`; el `catch` lo usaba, así que cualquier
fallo de arranque lanzaba `ReferenceError: log is not defined` en lugar de ejecutar
`failDesktopBoot()` + `notifyError()`. El usuario se quedaba con una promesa rechazada y sin UI de
recuperación (lo detectó el error no capturado de la suite, no un test).
**Fix.** Declarar `log` antes del `try` (hecho).
**Test.** La suite deja de registrar el `unhandledRejection`; conviene añadir un caso que simule
un fallo de boot y verifique `$desktopBoot.error`.

### B14 — El indicador de browser tabs no se refrescaba `[V]` — media

**Dónde.** `app/shell/hooks/use-statusbar-items.tsx`, `coreRightStatusbarItems`.
**Qué.** El ítem usa `browserTabsOpen` (clase activa, tooltip) pero el array de dependencias del
`useMemo` no lo incluía: el icono no cambiaba de estado hasta que otro átomo forzaba el recálculo.
**Fix.** Añadido a las dependencias (hecho).

### B15 — Tests dependientes del reloj `[V]` — media (deuda de test)

`components/assistant-ui/thread/streaming.test.tsx` asumía que 80 ms de espera precedían a un
chunk programado a 500 ms. Con la suite en paralelo (160 archivos jsdom) el sleep real superaba
los 500 ms y el test fallaba de forma intermitente. **Fix:** el harness expone `emitStreamStage()`
y el test conduce los chunks de forma determinista. El mismo patrón se aplicó a
`toolset-config-panel.test.tsx` (el panel carga toolsets por IPC y `findByRole` con el
timeout por defecto de 1 s fallaba bajo carga: ahora 8 s + timeout de test de 20 s).

### B17 — Un timer de sondeo sobrevivía al teardown del entorno `[V]` — alta

**Dónde.** `lib/desktop-git.ts` (`desktopGit`), alcanzado desde el debounce de
`store/coding-status.ts` / `store/review.ts`.
**Qué.** El sondeo de git se programa con `setTimeout` (100 ms). En tests, jsdom se destruye al
terminar el archivo: si el timer dispara después, `desktopGit()` evaluaba `window.aliceDesktop` con
`window` indefinido → `ReferenceError` dentro del timer, sin nadie que capture la promesa. Se
manifestaba como **1 error no capturado cada ~4 corridas completas** (contradecía el baseline verde
de P0.2/D12).
**Fix.** `desktopGit()` devuelve `undefined` si `typeof window === 'undefined'`; `desktop-fs.bridge()`
lanza el error controlado de siempre en ese caso. Test en entorno `node`
(`lib/desktop-bridge.teardown.test.ts`) que llama `desktopGit()` sin DOM y exige `undefined` sin
lanzar.

### B18 — Deuda de baseline: timeouts por defecto y scheduler sin drenar `[V]` — media (test)

Dos fuentes de falsos rojos bajo carga de la suite (167 archivos jsdom en paralelo):

- El `testTimeout` por defecto (5 s) es insuficiente para paneles que importan medio app y cargan
  por IPC. Varios "fallos" (`model-settings`, `providers-settings`, `wire`) eran timeouts, no bugs.
  **Fix:** `testTimeout`/`hookTimeout` = 20 s en `vitest.config.ts`.
- `user-message-edit.test.tsx` no hacía `cleanup()`; una actualización de React programada al
  teardown disparaba con `window` ya destruido (`ReferenceError` no capturado, 1 de cada ~4
  corridas). **Fix:** `afterEach(cleanup)` + un macrotask para drenar el scheduler antes del
  teardown.

Tras ambos fixes: **3 corridas completas consecutivas limpias** (1216 tests, 0 errores).

### B16 — Extraer los `<Pane>` a un componente hijo rompe el grid `[V]` — alta (restricción)

`components/pane-shell/pane-shell.tsx` (`collectPanes`) descubre los panes recorriendo los **hijos
directos** de `<PaneShell>`. Un componente intermedio (`<RailPanes>`) que devuelve los `<Pane>`
los hace invisibles: `paneById` queda vacío y todos los tracks caen a `0px`. Comprobado con un
test antes de revertir la extracción. Cualquier intento futuro de dividir el composition root debe
**no** mover los `<Pane>` fuera del árbol directo (o convertir `PaneShell` en un registro
dinámico vía contexto).

---

## 5. Lo que está bien y no hay que tocar

Es importante para no sobre-refactorizar:

- **Cache de estado de sesión** (`use-session-state-cache.ts`): `resumeRequestRef`, coalescing por
  rAF, `sameMessageList` shallow, `pendingViewStateRef`. Concurrencia resuelta con criterio.
- **`resumeSession`**: prefetch REST y RPC en paralelo, fast-path de caché caliente con validación
  de pertenencia, fallback REST con latch de fallo separado del fallo terminal, y comentarios que
  explican cada decisión.
- **`PaneShell`**: grid CSS puro, sin medición JS, con `disabled`/`forceCollapsed` bien separados.
- **`Thread`**: presupuesto de parts (300) en vez de virtualizador, respetando `use-stick-to-bottom`
  como único dueño del scroll.
- **Cola de composer y drafts** (`use-composer-draft.ts`): swap por sesión con flush en `pagehide`.
- **El patrón de preview** (loopback + token + caps + telemetría dev-only) es la plantilla correcta
  para el resto de I/O nativo.

---

## 6. Reglas para no volver a acumular esta deuda

1. **Un átomo de UI de alta frecuencia solo se suscribe en el componente que lo pinta.** Los
   contenedores (shell, página) no leen estado de paneles, overlays ni progreso.
2. **Un contenedor no crea elementos de subárboles caros si puede evitarlo**: si los crea, cualquier
   re-render propio invalida los bailouts de sus hijos (lección de D1).
3. **Todo store con side effect expone `wireX()`** y no ejecuta nada al importar (excepto lectura de
   persistencia). Los tests ganan aislamiento gratis.
4. **`store/` y `lib/` no importan de `app/` ni de `components/`.** Constantes y eventos compartidos
   viven en `lib/`.
5. **Persistencia a través de un único helper** con clave registrada, versión y escritura
   coalescida.
6. **Un panel = una fuente de verdad** de su visibilidad.
7. **El baseline de tests debe estar verde y sin ruido**; si un comportamiento cambia a propósito,
   el test se actualiza en el mismo commit.
8. **Cada fix de rendimiento entra con un invariante ejecutable** (nº de renders, nº de IPC, nº de
   `fit()`, nº de escrituras), no con un umbral de milisegundos solamente.
