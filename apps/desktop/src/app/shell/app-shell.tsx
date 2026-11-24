import { useStore } from '@nanostores/react'
import { type CSSProperties, lazy, type ReactNode, Suspense } from 'react'
import { useSyncExternalStore } from 'react'
import { useLocation } from 'react-router-dom'

import { NotificationStack } from '@/components/notifications'
import { PaneShell } from '@/components/pane-shell'
import { SidebarProvider } from '@/components/ui/sidebar'
import { useMediaQuery } from '@/hooks/use-media-query'
import { desktopSupports } from '@/lib/desktop-capabilities'
import {
  $fileBrowserOpen,
  $panesFlipped,
  $sidebarOpen,
  FILE_BROWSER_PANE_ID,
  setSidebarOpen
} from '@/store/layout'
import { $paneWidthOverride } from '@/store/panes'
import { $connection } from '@/store/session'
import { isSecondaryWindow } from '@/store/windows'

import { SIDEBAR_COLLAPSE_MEDIA_QUERY } from '../layout-constants'
import { $terminalTakeover } from '../right-sidebar/store'
import { appViewForPath } from '../routes'

import { useWindowControlsOverlayWidth } from './hooks/use-window-controls-overlay-width'
import { KeybindPanel } from './keybind-panel'
import { TITLEBAR_HEIGHT, titlebarControlsPosition } from './titlebar'

// FloatingPet is only mounted in shells with overlay support (Electron). Load
// it lazily so the Wails bundle never even downloads the pet chunk — a static
// import would pull the pet zoom-gesture + spritesheet modules into every boot
// and surface spurious React concurrent-render errors in the error log.
const FloatingPet = desktopSupports('petOverlay')
  ? lazy(() => import('@/components/pet/floating-pet').then(m => ({ default: m.FloatingPet })))
  : null

interface AppShellProps {
  children: ReactNode
  // Fixed-position overlays that must share <main>'s stacking context so pane
  // resize handles (z-20) paint above them. The persistent terminal lives here:
  // hoisting it to the root `overlays` layer (sibling of <main>, z above z-3)
  // would cover every pane's drag handle.
  mainOverlays?: ReactNode
  onOpenSettings: () => void
  overlays?: ReactNode
  /** Pre-rendered running head (wordmark, title, model chip). */
  runningHead?: ReactNode
  /** Pre-rendered navigation spine. */
  spine?: ReactNode
}

// Renderer-side fallback so layout snaps even when the main-process fullscreen event
// hasn't landed yet (e.g. dev reloads, before the IPC bridge is wired).
function subscribeWindowSize(cb: () => void) {
  window.addEventListener('resize', cb)
  window.addEventListener('fullscreenchange', cb)

  return () => {
    window.removeEventListener('resize', cb)
    window.removeEventListener('fullscreenchange', cb)
  }
}

const viewportIsFullscreen = () =>
  window.innerWidth >= window.screen.width && window.innerHeight >= window.screen.height

export function AppShell({
  children,
  mainOverlays,
  onOpenSettings,
  overlays,
  runningHead,
  spine
}: AppShellProps) {
  const sidebarOpen = useStore($sidebarOpen)
  const fileBrowserOpen = useStore($fileBrowserOpen)
  const panesFlipped = useStore($panesFlipped)
  // Rail-open state lives here (not in the composition root) so toggling a
  // pane re-renders the shell chrome only. `children` keeps its element
  // identity, so React bails out before touching the chat subtree.
  const currentView = appViewForPath(useLocation().pathname)
  const chatOpen = currentView === 'chat'
  const terminalTakeover = useStore($terminalTakeover)
  const terminalPaneOpen = chatOpen && terminalTakeover
  const narrowViewport = useMediaQuery(SIDEBAR_COLLAPSE_MEDIA_QUERY)
  const fileBrowserWidthOverride = useStore($paneWidthOverride(FILE_BROWSER_PANE_ID))
  const connection = useStore($connection)
  const viewportFullscreen = useSyncExternalStore(subscribeWindowSize, viewportIsFullscreen, () => false)
  const isFullscreen = Boolean(connection?.isFullscreen) || viewportFullscreen
  // Every secondary window (new-session scratch, subagent watch, cmd-click
  // pop-out) is a compact side panel — none of them carry the full titlebar
  // tool cluster. Gate on isSecondaryWindow, never the narrower new-session flag.
  const hideTitlebarControls = isSecondaryWindow()
  const titlebarControls = titlebarControlsPosition(connection?.windowButtonPosition, isFullscreen)
  // Width Windows/WSLg reserve for the native min/max/close overlay (zero on
  // macOS, where window controls sit on the left and are reported via
  // windowButtonPosition instead). The right tool cluster has to clear them.
  // Prefer the EXACT width measured from the live Window Controls Overlay
  // (precise + self-correcting across DPI/host themes); fall back to the static
  // reservation the main process sends when the WCO API isn't available.
  const measuredOverlayWidth = useWindowControlsOverlayWidth()
  const staticOverlayWidth = connection?.nativeOverlayWidth ?? 0
  const nativeOverlayWidth = measuredOverlayWidth ?? staticOverlayWidth
  const titlebarToolsRight = nativeOverlayWidth > 0 ? `${nativeOverlayWidth}px` : '0.75rem'

  // When the native window controls overlay our titlebar band — Windows and
  // WSLg both paint Electron's Window Controls Overlay and report
  // nativeOverlayWidth > 0 — the right rail's editor-style tab strip (which
  // normally lives IN that band) would render at y=0 under the fixed titlebar
  // tool cluster and collide with it. Drop the right rail one titlebar-height so
  // it opens BELOW the band. macOS / plain Linux paint no overlay → 0 inset,
  // layout byte-for-byte unchanged. Consumed as --right-rail-top-inset.
  const rightRailTopInset = nativeOverlayWidth > 0 ? 'var(--titlebar-height)' : '0px'

  // The inset clears the top-left titlebar buttons when nothing covers the
  // window's left edge. Default layout: the sessions sidebar sits there.
  // Flipped layout: the file browser does instead. Both force-collapse to a
  // hover-reveal overlay (0px track) below the collapse breakpoint, so the edge
  // is uncovered there regardless of their stored open state. A standalone
  // session window renders no sidebar at all, so its edge is always uncovered.
  const collapsibleLeftPaneOpen = panesFlipped ? fileBrowserOpen : sidebarOpen
  // The terminal never force-collapses, so when it's the leftmost open pane
  // (flipped layout) it covers the edge even when narrow. (The preview rail
  // that used to sit here is now the browser drawer, which lives on the left.)
  const persistentLeftPaneOpen = panesFlipped && terminalPaneOpen

  const leftEdgePaneOpen =
    !isSecondaryWindow() && ((!narrowViewport && collapsibleLeftPaneOpen) || persistentLeftPaneOpen)

  // The running head lives above the spine, so its left content always has to
  // clear the native window controls (macOS traffic lights / Windows overlay).
  const titlebarContentInset = titlebarControls.left

  return (
    <SidebarProvider
      className="h-full min-h-0 flex-col bg-background"
      onOpenChange={setSidebarOpen}
      open={sidebarOpen}
      style={
        {
          // Alias for shadcn <Sidebar> descendants. Resolves to the chat-sidebar
          // pane track via PaneShell's emitted --pane-chat-sidebar-width.
          '--sidebar-width': 'var(--pane-chat-sidebar-width)',
          '--spine-width': '72px',
          '--titlebar-height': `${TITLEBAR_HEIGHT}px`,
          '--titlebar-content-inset': `${titlebarContentInset}px`,
          '--titlebar-controls-left': `${titlebarControls.left}px`,
          '--titlebar-controls-top': `${titlebarControls.top}px`,
          '--titlebar-tools-right': titlebarToolsRight,
          // Drops the right rail below the titlebar band when the OS/host paints
          // window controls over it (Windows/WSLg); 0px elsewhere.
          '--right-rail-top-inset': '0px' 
        } as CSSProperties
      }
    >
      {runningHead}

      <div className="flex min-h-0 w-full flex-1 overflow-hidden">
        {spine}

        <main className="relative z-3 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden transition-none">
          <PaneShell className="min-h-0 flex-1">{children}</PaneShell>

        {/* Fixed overlays scoped to main's stacking context (terminal). Rendered
            after PaneShell so it paints over pane content, but its z stays under
            the panes' z-20 resize handles, keeping every pane resizable. */}
          {mainOverlays}
        </main>
      </div>

      {overlays}

      {/* Keybind map dialog (titlebar ⌨ button / ⌘/). */}
      <KeybindPanel />

      {/* Mounted at the shell root (after overlays) so success/error toasts
          surface above every route and overlay — not just the chat view. */}
      <NotificationStack />

      {/* Petdex floating mascot — in-window, always-on-top, reactive to agent
          activity. Renders nothing unless a pet is installed + enabled.
          Lazily loaded and only mounted in shells with overlay support. */}
      {FloatingPet && (
        <Suspense fallback={null}>
          <FloatingPet />
        </Suspense>
      )}
    </SidebarProvider>
  )
}
