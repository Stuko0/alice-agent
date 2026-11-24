import { useStore } from '@nanostores/react'
import { atom, computed, type ReadableAtom } from 'nanostores'
import {
  Children,
  type CSSProperties,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'

import { PANE_TOGGLE_REVEAL_EVENT } from '@/lib/pane-events'
import { cn } from '@/lib/utils'
import { $paneStates, ensurePaneRegistered, setPaneHeightOverride, setPaneOpen, setPaneWidthOverride } from '@/store/panes'

import { PaneShellContext, type PaneShellContextValue, type PaneSlot } from './context'

type PaneSide = 'left' | 'right'
type WidthValue = string | number

interface PaneRoleMarker {
  __paneShellRole?: 'pane' | 'main'
}

export interface PaneProps {
  children?: ReactNode
  className?: string
  /**
   * Declarative visibility gate. When set, this atom is the pane's open state
   * (instead of `$paneStates[id].open`), and `<PaneShell>` subscribes to it
   * directly. That keeps the composition root from subscribing to feature state:
   * toggling a pane re-renders the shell grid + that pane, not the whole app.
   */
  openAtom?: ReadableAtom<boolean>
  /**
   * Declarative "this pane is the bottom row" gate (e.g. the terminal moves to a
   * row when another rail column opens). Follows the same rule as `openAtom`.
   */
  bottomRowAtom?: ReadableAtom<boolean>
  defaultOpen?: boolean
  /** Paints a persistent hairline on the resize edge (not just the hover sash) so the pane boundary is always visible. */
  divider?: boolean
  /** Forces the pane closed (track→0, aria-hidden) without writing to the store — for transient route gates. */
  disabled?: boolean
  /** Like disabled, but keeps hoverReveal alive — collapses the track without writing to the store (e.g. narrow window). */
  forceCollapsed?: boolean
  /** When collapsed, float the contents over the main column on hover/focus instead of hiding them (track stays 0px). */
  hoverReveal?: boolean
  /**
   * Lay the pane out as a horizontal row beneath its rail (spanning every column on
   * its `side`) instead of as a vertical column. The pane then resizes on the Y axis.
   * Used to drop the terminal under a crowded rail rather than squeezing another column in.
   */
  bottomRow?: boolean
  /** Default height of a `bottomRow` pane. */
  height?: WidthValue
  /** Min/max height clamps for a `bottomRow` pane's vertical resize. */
  maxHeight?: WidthValue
  minHeight?: WidthValue
  /** Width of the collapsed-overlay panel. Defaults to the docked width (or its resize override); set this to render a narrower overlay than the docked pane (e.g. min width on mobile). */
  overlayWidth?: WidthValue
  /**
   * Study drawer: render this pane as a floating overlay panel (right edge for
   * `side="right"`, after the spine for `side="left"`) instead of a docked
   * column. The content stays mounted, so previews/terminals survive toggles.
   */
  drawer?: boolean
  /** Drawer width. Defaults to 390px. */
  drawerWidth?: WidthValue
  /** Actions rendered in the drawer header, before the close button. */
  drawerActions?: ReactNode
  /** Mount the drawer (hidden) once the app goes idle, so its first open is a
   *  paint instead of a mount. Off by default: boot stays cheap. */
  warmOnIdle?: boolean
  /** Dock this drawer beside the chat (grid column) instead of floating it. */
  pinned?: boolean
  /** Pin/unpin control in the drawer header. Omit to hide the control. */
  onTogglePin?: () => void
  /** Called with true while the pane is a collapsed hover-reveal overlay, so the consumer can keep contents mounted (ready to slide). */
  onOverlayActiveChange?: (overlayActive: boolean) => void
  id: string
  maxWidth?: WidthValue
  minWidth?: WidthValue
  resizable?: boolean
  side: PaneSide
  width?: WidthValue
}

export interface PaneMainProps {
  children?: ReactNode
  className?: string
}

export interface PaneShellProps {
  children?: ReactNode
  className?: string
  style?: CSSProperties
}

interface CollectedPane {
  bottomRow: boolean
  drawer: boolean
  drawerWidth: string
  pinned: boolean
  /** Index into the combined gate subscription, when `openAtom`/`bottomRowAtom` are used. */
  bottomRowAtomIndex?: number
  openAtomIndex?: number
  defaultOpen: boolean
  disabled: boolean
  forceCollapsed: boolean
  height: string
  id: string
  resizable: boolean
  side: PaneSide
  width: string
}

const DEFAULT_WIDTH = '16rem'
const DEFAULT_HEIGHT = '18rem'
const DEFAULT_RESIZE_MIN_WIDTH = 160
const DEFAULT_RESIZE_MIN_HEIGHT = 120

// Resize-sash geometry per axis: `x` is a vertical bar on the inner edge of a
// column; `y` is a horizontal bar on the top edge of a bottom row.
const SASH = {
  x: {
    orientation: 'vertical',
    bar: 'bottom-0 top-0 w-1 cursor-col-resize',
    line: 'inset-y-0 left-1/2 w-px -translate-x-1/2',
    hover: 'inset-y-0 left-1/2 w-(--vscode-sash-hover-size,0.25rem) -translate-x-1/2'
  },
  y: {
    orientation: 'horizontal',
    bar: 'inset-x-0 top-0 h-1 -translate-y-1/2 cursor-row-resize',
    line: 'inset-x-0 top-1/2 h-px -translate-y-1/2',
    hover: 'inset-x-0 top-1/2 h-(--vscode-sash-hover-size,0.25rem) -translate-y-1/2'
  }
} as const

// Hover-reveal slide. The enter delay is a pure-CSS hover-intent gate: a fast
// pass-by doesn't dwell on the trigger long enough for the delay to elapse.
const HOVER_REVEAL_SLIDE_MS = 220
const HOVER_REVEAL_ENTER_DELAY_MS = 130
const HOVER_REVEAL_EASE = 'cubic-bezier(0.32,0.72,0,1)'
// Offset shadow lifting the revealed panel off the content (same both sides;
// the mirror axis is offset-x, which is 0). Same color on light + dark.
const HOVER_REVEAL_SHADOW = '0px -18px 18px -5px #00000012'
// Edge trigger strip, inset past the OS window-resize grab area AND the
// adjacent pane's scrollbar (0.5rem, .scrollbar-dt) — the strip overlays the
// neighboring scroller's edge, so any overlap makes the scrollbar reveal the
// pane on hover and swallow its clicks (#44140).
const HOVER_REVEAL_TRIGGER_WIDTH = 14
const HOVER_REVEAL_EDGE_GUTTER = 'calc(0.5rem + 2px)'

// Re-exported for existing call sites; the definition lives in `lib/` so the
// data layer can dispatch it without importing this component module.
export { PANE_TOGGLE_REVEAL_EVENT }

const widthToCss = (value: WidthValue | undefined, fallback: string) =>
  value === undefined ? fallback : typeof value === 'number' ? `${value}px` : value

const remPx = () =>
  typeof window === 'undefined'
    ? 16
    : Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16

const viewportPx = () => (typeof window === 'undefined' ? 1280 : window.innerWidth)
const viewportHeightPx = () => (typeof window === 'undefined' ? 800 : window.innerHeight)

// Resolves PaneProps min/max (number | "Npx" | "Nrem" | "Nvw" | "Nvh" | "N%") to
// pixels for drag clamping. vw/% resolve against window width, vh against height.
function widthToPx(value: WidthValue | undefined) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined
  }

  const match = value?.trim().match(/^(-?\d*\.?\d+)(px|rem|vw|vh|%)?$/)

  if (!match) {
    return undefined
  }

  const n = Number.parseFloat(match[1])

  switch (match[2]) {
    case 'rem':
      return n * remPx()

    case 'vh':
      return (n * viewportHeightPx()) / 100

    case 'vw':

    case '%':
      return (n * viewportPx()) / 100

    default:
      return n
  }
}

function isRole(child: unknown, role: 'pane' | 'main'): child is ReactElement {
  return isValidElement(child) && (child.type as PaneRoleMarker)?.__paneShellRole === role
}

function collectPanes(children: ReactNode) {
  const left: CollectedPane[] = []
  const right: CollectedPane[] = []
  const gateAtoms: ReadableAtom<boolean>[] = []
  let mainCount = 0

  Children.forEach(children, child => {
    if (isRole(child, 'main')) {
      mainCount++

      return
    }

    if (!isRole(child, 'pane')) {
      return
    }

    const props = child.props as PaneProps

    const openAtomIndex = props.openAtom ? gateAtoms.push(props.openAtom) - 1 : undefined
    const bottomRowAtomIndex = props.bottomRowAtom ? gateAtoms.push(props.bottomRowAtom) - 1 : undefined

    const entry: CollectedPane = {
      bottomRow: props.bottomRow ?? false,
      drawer: props.drawer ?? false,
      // Docked drawers keep the floating width budget: never more than
      // ~half the window, even when pinned.
      drawerWidth: `min(${widthToCss(props.drawerWidth, '390px')}, 48vw)`,
      pinned: props.pinned ?? false,
      bottomRowAtomIndex,
      openAtomIndex,
      defaultOpen: props.defaultOpen ?? true,
      disabled: props.disabled ?? false,
      forceCollapsed: props.forceCollapsed ?? false,
      height: widthToCss(props.height, DEFAULT_HEIGHT),
      id: props.id,
      resizable: props.resizable ?? false,
      side: props.side,
      width: widthToCss(props.width, DEFAULT_WIDTH)
    }

    ;(props.side === 'left' ? left : right).push(entry)
  })

  return { gateAtoms, left, mainCount, right }
}

type PaneStoreState = Record<string, { open: boolean; widthOverride?: number; heightOverride?: number }>

function paneIsOpen(pane: CollectedPane, states: PaneStoreState, gates: readonly boolean[]) {
  // An explicit gate atom replaces the pane-store open flag (the store still
  // carries width/height overrides and the default for non-gated panes).
  const stateOpen =
    pane.openAtomIndex === undefined
      ? (states[pane.id]?.open ?? pane.defaultOpen)
      : gates[pane.openAtomIndex] === true

  return !pane.disabled && !pane.forceCollapsed && stateOpen
}

function paneIsBottomRow(pane: CollectedPane, gates: readonly boolean[]) {
  if (pane.bottomRow) {
    return true
  }

  return pane.bottomRowAtomIndex !== undefined && gates[pane.bottomRowAtomIndex] === true
}

function trackForPane(pane: CollectedPane, states: PaneStoreState, gates: readonly boolean[]) {
  // A floating drawer owns no grid track; a pinned one is a real column.
  if (pane.drawer && !pane.pinned) {
    return { open: false, track: '0px' }
  }

  const open = paneIsOpen(pane, states, gates)

  if (!open) {
    return { open: false, track: '0px' }
  }

  const override = pane.resizable ? states[pane.id]?.widthOverride : undefined

  return { open: true, track: override !== undefined ? `${override}px` : (pane.drawer ? pane.drawerWidth : pane.width) }
}

function heightTrackForPane(pane: CollectedPane, states: PaneStoreState) {
  const override = pane.resizable ? states[pane.id]?.heightOverride : undefined

  return override !== undefined ? `${override}px` : pane.height
}

const DRAWER_SUITS: Record<string, string> = {
  browser: '✦',
  'chat-sidebar': '♠',
  review: '♥',
  preview: '♦',
  'terminal-sidebar': '♣',
  'file-browser': '♠'
}

const DRAWER_LABELS: Record<string, string> = {
  browser: 'Browser',
  'chat-sidebar': 'Index',
  review: 'Review',
  preview: 'Preview',
  'terminal-sidebar': 'Terminal',
  'file-browser': 'Files'
}

function DrawerHeader({
  actions,
  id,
  onClose,
  onTogglePin,
  pinned = false
}: {
  actions?: ReactNode
  id: string
  onClose: () => void
  onTogglePin?: () => void
  pinned?: boolean
}) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-(--ui-stroke-tertiary) px-3">
      <span aria-hidden="true" className="font-serif text-[0.95rem] text-(--accent-text)">
        {DRAWER_SUITS[id] ?? '♥'}
      </span>
      <span className="font-display text-[0.72rem] uppercase tracking-[0.16em] text-foreground">
        {DRAWER_LABELS[id] ?? id}
      </span>
      <span className="flex-1" />
      {actions}
      {onTogglePin ? (
        <button
          aria-label={pinned ? 'Unpin drawer' : 'Pin drawer'}
          aria-pressed={pinned}
          className={cn(
            'grid size-6 place-items-center rounded-sm text-[0.9rem] hover:bg-(--ui-control-hover-background) hover:text-foreground',
            pinned ? 'text-(--accent-text)' : 'text-muted-foreground'
          )}
          onClick={onTogglePin}
          title={pinned ? 'Unpin (dock beside chat off)' : 'Pin (dock beside chat)'}
          type="button"
        >
          ⌖
        </button>
      ) : null}
      <button
        aria-label="Close drawer"
        className="grid size-6 place-items-center rounded-sm text-muted-foreground hover:bg-(--ui-control-hover-background) hover:text-foreground"
        onClick={onClose}
        type="button"
      >
        ×
      </button>
    </div>
  )
}

const $NO_GATES = atom<readonly boolean[]>([])
const $NO_DRAWER_GATE = atom(false)

export function PaneShell({ children, className, style }: PaneShellProps) {
  const paneStates = useStore($paneStates)
  const { gateAtoms, left, mainCount, right } = useMemo(() => collectPanes(children), [children])

  // One subscription for every pane gate. Recomputed only when the atom list
  // changes (i.e. the pane elements are rebuilt), not on every render.
  const $gates = useMemo(
    () => (gateAtoms.length ? computed(gateAtoms, (...values: boolean[]) => values) : $NO_GATES),
    [gateAtoms]
  )

  const gates = useStore($gates)

  if (import.meta.env.DEV && mainCount > 1) {
    console.warn('[PaneShell] expected at most one <PaneMain>, got', mainCount)
  }

  const ctxValue = useMemo(() => {
    const paneById = new Map<string, PaneSlot>()
    const tracks: string[] = []
    const cssVars: Record<string, string> = {}
    let column = 1

    // A bottom-row pane drops out of its rail's column flow and instead spans
    // every column on its side as a new row below them. The first open one wins
    // and decides which rail gets split into two rows.
    //
    // The row decision is DYNAMIC (`bottomRowAtom`) for panes like the terminal:
    // when the atom is false the pane is a normal column, so it must not also be
    // registered as a bottom-row candidate (that produced a phantom track and
    // two panes in one grid cell).
    const isBottomRow = (pane: CollectedPane) => paneIsBottomRow(pane, gates)
    const leftCols = left.filter(pane => !isBottomRow(pane))
    const rightCols = right.filter(pane => !isBottomRow(pane))
    const bottomRowPanes = [...left, ...right].filter(isBottomRow)
    const activeBottomRow = bottomRowPanes.find(pane => paneIsOpen(pane, paneStates, gates)) ?? null
    const bottomRailSide = activeBottomRow?.side ?? null

    // Open column panes on the bottom row's side shrink to the top row; everything
    // else (main, the other rail, closed / hover-reveal panes) stays full height.
    const addColumn = (pane: CollectedPane, paneSide: PaneSide) => {
      const { open, track } = trackForPane(pane, paneStates, gates)
      tracks.push(track)
      cssVars[`--pane-${pane.id}-width`] = track
      const gridRow = open && paneSide === bottomRailSide ? '1 / 2' : '1 / -1'
      paneById.set(pane.id, {
        open,
        side: paneSide,
        gridColumn: `${column} / ${column + 1}`,
        gridRow,
        bottomRow: false
      })
      column++
    }

    for (const pane of leftCols) {
      addColumn(pane, 'left')
    }

    tracks.push('minmax(0,1fr)')
    const mainColumn = column++

    for (const pane of rightCols) {
      addColumn(pane, 'right')
    }

    // Place every bottom-row pane: span its rail's columns on the second row.
    for (const pane of bottomRowPanes) {
      const gridColumn = pane.side === 'left' ? `1 / ${mainColumn}` : `${mainColumn + 1} / -1`
      paneById.set(pane.id, {
        open: pane === activeBottomRow,
        side: pane.side,
        gridColumn,
        gridRow: '2 / 3',
        bottomRow: true
      })
    }

    // Always emit explicit rows so `grid-row: 1 / -1` (full-height) resolves
    // against a known last line. With a bottom row active there are two tracks;
    // otherwise a single 1fr track behaves exactly like the old single-row grid.
    const gridTemplateRows = activeBottomRow
      ? `minmax(0,1fr) ${heightTrackForPane(activeBottomRow, paneStates)}`
      : 'minmax(0,1fr)'

    return {
      cssVars,
      gridTemplate: tracks.join(' '),
      gridTemplateRows,
      mainColumn,
      paneById
    } satisfies PaneShellContextValue & {
      cssVars: Record<string, string>
      gridTemplate: string
      gridTemplateRows: string
    }
  }, [gates, left, paneStates, right])

  const composedStyle = useMemo<CSSProperties>(
    () => ({
      ...ctxValue.cssVars,
      ...style,
      gridTemplateColumns: ctxValue.gridTemplate,
      gridTemplateRows: ctxValue.gridTemplateRows
    }),
    [ctxValue.cssVars, ctxValue.gridTemplate, ctxValue.gridTemplateRows, style]
  )

  return (
    <PaneShellContext.Provider value={{ mainColumn: ctxValue.mainColumn, paneById: ctxValue.paneById }}>
      <div className={cn('relative grid h-full min-h-0', className)} data-pane-shell="" style={composedStyle}>
        {children}
      </div>
    </PaneShellContext.Provider>
  )
}

export function Pane({
  children,
  className,
  defaultOpen = true,
  divider = false,
  disabled = false,
  drawer = false,
  drawerActions,
  drawerWidth = 390,
  warmOnIdle = false,
  forceCollapsed = false,
  hoverReveal = false,
  maxHeight,
  minHeight,
  overlayWidth: overlayWidthProp,
  id,
  onTogglePin,
  pinned = false,
  maxWidth,
  minWidth,
  onOverlayActiveChange,
  openAtom,
  resizable = false,
  width
}: PaneProps) {
  const ctx = useContext(PaneShellContext)
  const paneStates = useStore($paneStates)
  const registered = useRef(false)
  const paneRef = useRef<HTMLDivElement | null>(null)
  // Keyboard (mod+b / mod+j) pins the reveal open while collapsed; hover is CSS.
  const [forced, setForced] = useState(false)

  const slot = ctx?.paneById.get(id)
  const open = Boolean(slot?.open && !disabled)
  const side = slot?.side ?? 'left'
  // Collapsed + hoverReveal: float the pane contents over the main column on
  // hover/focus instead of hiding them. Honors any persisted resize width.
  //
  // Atom-gated panes only float while FORCE-COLLAPSED (narrow window). Without
  // this, a closed pane (gate=false) in a wide window rendered its 237px overlay
  // over the neighbouring rail pane — the "closed git pane covers the worktree"
  // bug. Non-gated panes (chat sidebar, file browser) keep the old behavior.
  const overlayActive = !open && hoverReveal && !disabled && (forceCollapsed || !openAtom)
  const atomOpen = useStore(openAtom ?? $NO_DRAWER_GATE)
  const drawerOpen = drawer && Boolean(openAtom ? atomOpen : (paneStates[id]?.open ?? defaultOpen)) && !disabled
  // Keep-alive: mount a drawer the first time it opens, then keep it mounted
  // (hidden) so reopening is instant and preserves scroll/filter state. Boot
  // stays cheap because nothing mounts until the user asks for it.
  const [drawerActivated, setDrawerActivated] = useState(drawerOpen)
  const drawerRef = useRef<HTMLElement | null>(null)

  const closeDrawer = useCallback(() => {
    const writable = openAtom as unknown as { set?: (value: boolean) => void } | undefined

    if (writable?.set) {
      writable.set(false)
    } else {
      setPaneOpen(id, false)
    }
  }, [id, openAtom])

  useEffect(() => {
    if (drawerOpen) {
      setDrawerActivated(true)
    }
  }, [drawerOpen])

  useEffect(() => {
    // `drawerActivated` is in the deps because the aside only exists after the
    // activation render; without it the first open would never move focus.
    if (!drawerOpen || !drawerActivated || pinned) {
      return
    }

    const node = drawerRef.current

    if (!node) {
      return
    }

    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null

    const selector =
      'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

    const focusables = () => Array.from(node.querySelectorAll<HTMLElement>(selector))

    // Initial focus goes to the first control in the BODY (search field, tree,
    // diff list), not the header's Close button: landing on "Close" makes Enter
    // dismiss the drawer instead of acting on its content.
    const content = node.querySelector<HTMLElement>('[data-drawer-content]')

    const frame = window.requestAnimationFrame(() => {
      const first = content?.querySelector<HTMLElement>(selector) ?? focusables()[0]

      if (first) {
        first.focus()
      } else {
        node.focus()
      }
    })

    const onKeyDown = (event: KeyboardEvent) => {
      // A root overlay (Settings, command palette, …) sits above the drawer and
      // owns Escape while it is open.
      if (event.key === 'Escape' && !document.querySelector('[data-overlay-root]')) {
        event.preventDefault()
        event.stopPropagation()
        closeDrawer()

        return
      }

      if (event.key !== 'Tab') {
        return
      }

      const items = focusables()

      if (!items.length) {
        event.preventDefault()

        return
      }

      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      const outside = !node.contains(active)

      if (event.shiftKey && (active === first || outside)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || outside)) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)

    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('keydown', onKeyDown, true)

      // Hand focus back to the control that opened the drawer (the spine suit).
      if (previous?.isConnected) {
        previous.focus()
      }
    }
  }, [closeDrawer, drawerActivated, drawerOpen, pinned])

  // Warm-up: after the first paint settles, mount the drawer hidden so the
  // first real open costs a paint rather than a mount (the catalog's list is
  // the expensive one). Idle-scheduled, so it never competes with boot.
  useEffect(() => {
    if (!warmOnIdle || drawerActivated || typeof window === 'undefined') {
      return
    }

    const activate = () => setDrawerActivated(true)

    // Optional API: not every WebKit build ships requestIdleCallback.
    const scheduler = window as Window & {
      cancelIdleCallback?: (handle: number) => void
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
    }

    const usedIdle = typeof scheduler.requestIdleCallback === 'function'

    const idleHandle = usedIdle
      ? scheduler.requestIdleCallback!(activate, { timeout: 2_500 })
      : window.setTimeout(activate, 1_200)

    return () => {
      if (usedIdle) {
        scheduler.cancelIdleCallback?.(idleHandle)
      } else {
        window.clearTimeout(idleHandle)
      }
    }
  }, [drawerActivated, warmOnIdle])

  // Perf probe: click → first painted frame for this drawer. Only writes when
  // the app is launched with `alice.perf=1` (QA harness), so it costs a flag
  // check at runtime and nothing in normal use.
  useEffect(() => {
    if (!drawerOpen || typeof window === 'undefined') {
      return
    }

    const frame = window.requestAnimationFrame(() => {
      const start = (window as unknown as { __aliceDrawerClickAt?: number }).__aliceDrawerClickAt

      if (!start) {
        return
      }

      const ms = Math.round((performance.now() - start) * 10) / 10

      try {
        if (window.localStorage.getItem('alice.perf') === '1') {
          window.localStorage.setItem('drawer.perf', JSON.stringify({ id, ms }))
        }
      } catch {
        // Perf probe is best-effort; storage may be unavailable.
      }

      performance.mark(`drawer:${id}:painted`)
    })

    return () => window.cancelAnimationFrame(frame)
  }, [drawerOpen, id])
  const override = resizable ? paneStates[id]?.widthOverride : undefined


  // Overlay width: an explicit `overlayWidth` (e.g. min width on mobile) wins,
  // else the persisted resize override, else the docked width.
  const overlayWidth =
    overlayWidthProp !== undefined
      ? widthToCss(overlayWidthProp, DEFAULT_WIDTH)
      : override !== undefined
        ? `${override}px`
        : widthToCss(width, DEFAULT_WIDTH)

  useEffect(() => {
    if (registered.current) {
      return
    }

    registered.current = true
    ensurePaneRegistered(id, { open: defaultOpen })
  }, [defaultOpen, id])

  // Keyboard toggle pins/unpins the reveal while collapsed; clear when no longer
  // a collapsed overlay (reopened / widened).
  useEffect(() => {
    if (typeof window === 'undefined' || !overlayActive) {
      setForced(false)

      return
    }

    const onToggle = (e: Event) => {
      if ((e as CustomEvent<{ id: string }>).detail?.id === id) {
        setForced(v => !v)
      }
    }

    window.addEventListener(PANE_TOGGLE_REVEAL_EVENT, onToggle)

    return () => window.removeEventListener(PANE_TOGGLE_REVEAL_EVENT, onToggle)
  }, [id, overlayActive])

  // Keep contents mounted while collapsed so reveal is a pure CSS transform.
  useEffect(() => {
    onOverlayActiveChange?.(overlayActive)
  }, [onOverlayActiveChange, overlayActive])

  const isBottomRow = Boolean(slot?.bottomRow)
  const axis = isBottomRow ? 'y' : 'x'
  const sash = SASH[axis]
  const canResize = open && resizable
  const lo = widthToPx(minWidth) ?? DEFAULT_RESIZE_MIN_WIDTH
  const hi = widthToPx(maxWidth) ?? Number.POSITIVE_INFINITY
  const loH = widthToPx(minHeight) ?? DEFAULT_RESIZE_MIN_HEIGHT
  const hiH = widthToPx(maxHeight) ?? Number.POSITIVE_INFINITY

  // One pointer-drag for both axes. Columns grow toward the main column (left
  // rail → right, right rail → left); the bottom row grows up from its top edge.
  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, axis: 'x' | 'y') => {
      const rect = paneRef.current?.getBoundingClientRect()
      const base = (axis === 'x' ? rect?.width : rect?.height) ?? 0

      if (!canResize || base <= 0) {
        return
      }

      event.preventDefault()

      const handle = event.currentTarget
      const { pointerId } = event
      const start = axis === 'x' ? event.clientX : event.clientY
      const dir = axis === 'x' ? (side === 'left' ? 1 : -1) : -1
      const [min, max] = axis === 'x' ? [lo, hi] : [loH, hiH]
      const apply = axis === 'x' ? setPaneWidthOverride : setPaneHeightOverride
      const restoreCursor = document.body.style.cursor
      const restoreSelect = document.body.style.userSelect

      handle.setPointerCapture?.(pointerId)
      document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize'
      document.body.style.userSelect = 'none'

      const onMove = (e: PointerEvent) => {
        const next = base + ((axis === 'x' ? e.clientX : e.clientY) - start) * dir
        apply(id, Math.round(Math.min(max, Math.max(min, next))))
      }

      const cleanup = () => {
        document.body.style.cursor = restoreCursor
        document.body.style.userSelect = restoreSelect
        handle.releasePointerCapture?.(pointerId)
        window.removeEventListener('pointermove', onMove, true)
        window.removeEventListener('pointerup', cleanup, true)
        window.removeEventListener('pointercancel', cleanup, true)
        window.removeEventListener('blur', cleanup)
      }

      window.addEventListener('pointermove', onMove, true)
      window.addEventListener('pointerup', cleanup, true)
      window.addEventListener('pointercancel', cleanup, true)
      window.addEventListener('blur', cleanup)
    },
    [canResize, hi, hiH, id, lo, loH, side]
  )

  if (!ctx) {
    if (import.meta.env.DEV) {
      console.warn(`[Pane:${id}] must be rendered inside <PaneShell>`)
    }

    return null
  }

  if (!slot) {
    return null
  }

  if (drawer && !pinned) {
    // Never opened yet → render nothing at all (no zero-width grid cell, no
    // mounted children behind the chat).
    if (!drawerActivated) {
      return null
    }

    const drawerCssWidth = widthToCss(drawerWidth, '390px')

    return (
      <>
        {drawerOpen && (
          <div
            aria-hidden="true"
            className="fixed bottom-0 left-(--spine-width,72px) right-0 top-(--titlebar-height) z-30 bg-black/35"
            onClick={closeDrawer}
          />
        )}
        <aside
          aria-label={DRAWER_LABELS[id] ?? id}
          aria-modal={drawerOpen || undefined}
          className={cn(
            'pane-drawer fixed bottom-0 top-(--titlebar-height) z-35 flex flex-col bg-(--ui-sidebar-surface-background) shadow-[-24px_0_48px_-24px_rgba(0,0,0,0.45)]',
            side === 'left'
              ? 'left-(--spine-width,72px) border-r border-(--ui-stroke-secondary)'
              : 'right-0 border-l border-(--ui-stroke-secondary)'
          )}
          hidden={!drawerOpen}
          ref={drawerRef}
          role="dialog"
          style={{ width: `min(${drawerCssWidth}, 48vw)`, '--sidebar-width': '100%' } as CSSProperties}
          tabIndex={-1}
        >
          <DrawerHeader
            actions={drawerActions}
            id={id}
            onClose={closeDrawer}
            onTogglePin={onTogglePin}
          />
          <div className="flex min-h-0 flex-1 flex-col" data-drawer-content="">
            {children}
          </div>
        </aside>
      </>
    )
  }

  // Collapsed hover-reveal track: a 0px, pointer-transparent grid cell holding a
  // thin edge trigger + the floating panel (both absolute, escaping the zero
  // box). group-hover (or data-forced from the keyboard) drives the slide; the
  // enter-delay is the hover-intent gate. No JS pointer math.
  if (overlayActive) {
    const edge = side === 'left' ? 'left' : 'right'
    const offscreen = side === 'left' ? '-translate-x-[calc(100%+1rem)]' : 'translate-x-[calc(100%+1rem)]'

    return (
      <div
        className={cn('group/reveal pointer-events-none relative min-w-0', className)}
        data-forced={forced ? '' : undefined}
        data-pane-hover-reveal={forced ? 'open' : 'closed'}
        data-pane-id={id}
        data-pane-open="false"
        data-pane-side={side}
        ref={paneRef}
        style={{ gridColumn: slot.gridColumn, gridRow: slot.gridRow }}
      >
        <div
          aria-hidden="true"
          className="pointer-events-auto absolute inset-y-0 z-30 [-webkit-app-region:no-drag]"
          data-pane-reveal-trigger=""
          style={{ [edge]: HOVER_REVEAL_EDGE_GUTTER, width: HOVER_REVEAL_TRIGGER_WIDTH }}
        />

        {/* Keyed on side so flipping panes remounts off-screen on the new edge
            instead of transitioning the transform across the viewport. */}
        <div
          className={cn(
            'pointer-events-none absolute inset-y-0 z-30 overflow-hidden transition-transform delay-0',
            offscreen,
            'group-hover/reveal:pointer-events-auto group-hover/reveal:translate-x-0 group-hover/reveal:delay-[var(--reveal-enter-delay)] group-hover/reveal:shadow-[var(--reveal-shadow)]',
            'group-data-[forced]/reveal:pointer-events-auto group-data-[forced]/reveal:translate-x-0 group-data-[forced]/reveal:delay-0 group-data-[forced]/reveal:shadow-[var(--reveal-shadow)]'
          )}
          key={edge}
          style={
            {
              [edge]: 0,
              width: overlayWidth,
              '--reveal-shadow': HOVER_REVEAL_SHADOW,
              transitionDuration: `${HOVER_REVEAL_SLIDE_MS}ms`,
              transitionTimingFunction: HOVER_REVEAL_EASE,
              '--reveal-enter-delay': `${HOVER_REVEAL_ENTER_DELAY_MS}ms`
            } as CSSProperties
          }
        >
          <div className="flex h-full w-full flex-col">{children}</div>
        </div>
      </div>
    )
  }

  return (
    <div
      aria-hidden={!open}
      className={cn('relative min-h-0 min-w-0 overflow-hidden', !open && 'pointer-events-none', className)}
      data-pane-id={id}
      data-pane-open={open ? 'true' : 'false'}
      data-pane-side={slot.side}
      ref={paneRef}
      style={{ gridColumn: slot.gridColumn, gridRow: slot.gridRow }}
    >
      {canResize && (
        <div
          aria-label={`Resize ${id}`}
          aria-orientation={sash.orientation}
          className={cn(
            'group absolute z-20 [-webkit-app-region:no-drag]',
            sash.bar,
            !isBottomRow && (slot.side === 'left' ? 'right-0 translate-x-1/2' : 'left-0 -translate-x-1/2')
          )}
          onPointerDown={e => startResize(e, axis)}
          role="separator"
          tabIndex={0}
        >
          {divider && <span className={cn('absolute bg-(--ui-stroke-secondary)', sash.line)} />}
          <span
            className={cn(
              'absolute bg-(--ui-sash-hover-border) opacity-0 transition-opacity duration-100 group-hover:opacity-100 group-focus-visible:opacity-100',
              sash.hover
            )}
          />
        </div>
      )}
      {pinned ? (
        <div className="flex h-full min-h-0 flex-col">
          <DrawerHeader id={id} onClose={closeDrawer} onTogglePin={onTogglePin} pinned />
          <div className="flex min-h-0 flex-1 flex-col" data-drawer-content="">
            {children}
          </div>
        </div>
      ) : (
        children
      )}
    </div>
  )
}

;(Pane as unknown as PaneRoleMarker).__paneShellRole = 'pane'

export function PaneMain({ children, className }: PaneMainProps) {
  const ctx = useContext(PaneShellContext)

  if (!ctx) {
    if (import.meta.env.DEV) {
      console.warn('[PaneMain] must be rendered inside <PaneShell>')
    }

    return null
  }

  return (
    <div
      className={cn('flex min-h-0 min-w-0 flex-col overflow-hidden', className)}
      data-pane-main="true"
      style={{ gridColumn: `${ctx.mainColumn} / ${ctx.mainColumn + 1}`, gridRow: '1 / -1' }}
    >
      {children}
    </div>
  )
}

;(PaneMain as unknown as PaneRoleMarker).__paneShellRole = 'main'
