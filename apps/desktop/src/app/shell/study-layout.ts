import { setTerminalTakeover } from '@/app/right-sidebar/store'
import { persistentAtom } from '@/lib/persisted'
import { persistedKey } from '@/lib/persisted-keys'
import { setBrowserOpen } from '@/store/browser'
import { setFileBrowserOpen, setSidebarOpen } from '@/store/layout'
import { setPaneOpen } from '@/store/panes'
import { $reviewOpen } from '@/store/review'

/**
 * The Study shell replaces the old IDE layout where the sessions sidebar, file
 * browser and review pane could all be docked at once. One-time migration:
 * close every persisted drawer so the chat is the landing surface, then leave
 * the user's choices alone from then on.
 */
export function migrateStudyLayoutOnce(): void {
  if (typeof window === 'undefined') {
    return
  }

  const key = 'alice-desktop-study-layout-v1'

  try {
    if (window.localStorage.getItem(key)) {
      return
    }

    window.localStorage.setItem(key, '1')
    setPaneOpen('chat-sidebar', false)
    setPaneOpen('file-browser', false)
    setPaneOpen('preview', false)
    setPaneOpen('review', false)
    setPaneOpen('terminal-sidebar', false)
    $reviewOpen.set(false)
    setTerminalTakeover(false)
  } catch {
    // localStorage unavailable — the defaults are already closed enough.
  }
}

export type StudyDrawer = 'browser' | 'files' | 'review' | 'sessions' | 'terminal'

/**
 * Pinned drawers dock beside the chat instead of floating over it. They are
 * also exempt from the one-at-a-time rule, which is what makes "catalog +
 * terminal side by side" possible without covering the transcript.
 */
export const $pinnedDrawers = persistentAtom<StudyDrawer[]>(persistedKey('pinnedDrawers'), [])

const OPEN_SETTERS: Record<StudyDrawer, (open: boolean) => void> = {
  browser: setBrowserOpen,
  files: setFileBrowserOpen,
  review: open => $reviewOpen.set(open),
  sessions: setSidebarOpen,
  terminal: setTerminalTakeover
}

/**
 * Boot lands on the chat, not on a restored drawer. Floating drawers are
 * transient surfaces (the catalogue is a lookup, not a workspace); only pinned
 * ones — which the user explicitly docked — come back open.
 */
export function reconcileStudyDrawersOnce(): void {
  if (typeof window === 'undefined') {
    return
  }

  for (const drawer of ['browser', 'files', 'review', 'sessions', 'terminal'] as const) {
    if (!isDrawerPinned(drawer)) {
      OPEN_SETTERS[drawer](false)
    }
  }
}

/** A pinned drawer must also be open, or it would dock into a 0px column. */
export function openPinnedDrawersOnce(): void {
  for (const drawer of $pinnedDrawers.get()) {
    OPEN_SETTERS[drawer](true)
  }
}

export function isDrawerPinned(drawer: StudyDrawer): boolean {
  return $pinnedDrawers.get().includes(drawer)
}

export function toggleDrawerPin(drawer: StudyDrawer): void {
  const current = $pinnedDrawers.get()
  const pinned = !current.includes(drawer)

  $pinnedDrawers.set(pinned ? [...current, drawer] : current.filter(id => id !== drawer))

  if (pinned) {
    OPEN_SETTERS[drawer](true)
  }
}

const PANE_ID_FOR: Record<StudyDrawer, string> = {
  browser: 'browser',
  files: 'file-browser',
  review: 'review',
  sessions: 'chat-sidebar',
  terminal: 'terminal-sidebar'
}

/** The pane id a drawer maps to, for wiring `<Pane pinned>`. */
export function drawerPaneId(drawer: StudyDrawer): string {
  return PANE_ID_FOR[drawer]
}

/** Drawers are mutually exclusive — except the pinned ones, which stay docked. */
export function closeOtherStudyDrawers(keep: StudyDrawer): void {
  const pinned = $pinnedDrawers.get()

  if (keep !== 'browser' && !pinned.includes('browser')) {
    setBrowserOpen(false)
  }

  if (keep !== 'sessions' && !pinned.includes('sessions')) {
    setSidebarOpen(false)
  }

  if (keep !== 'files' && !pinned.includes('files')) {
    setFileBrowserOpen(false)
  }

  if (keep !== 'review' && !pinned.includes('review')) {
    $reviewOpen.set(false)
  }

  if (keep !== 'terminal' && !pinned.includes('terminal')) {
    setTerminalTakeover(false)
  }
}
