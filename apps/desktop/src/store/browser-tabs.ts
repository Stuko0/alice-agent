import { atom } from 'nanostores'

import { $browserOpen } from './browser'

/**
 * Tabs of the native browser pane.
 *
 * One WebKitGTK view is shared by every `web` tab: switching tabs navigates
 * that view (per-tab back/forward history is not preserved — a deliberate
 * Fase 2 trade-off). `file` tabs render in React with the existing local-file
 * previewer instead of touching the native surface.
 */
export type BrowserTabKind = 'file' | 'web'

export interface BrowserTab {
  /** Unique id (incremental). */
  id: string
  /** `web` = URL in the native engine; `file` = path in the React viewer. */
  kind: BrowserTabKind
  /** Page URL for web tabs, absolute path for file tabs. */
  url: string
  /** Inline bytes for an image tab whose on-disk copy may be transient. */
  dataUrl?: string
  title: string
  /** ISO timestamp of when this tab was created */
  createdAt: string
  /** ISO timestamp of last activity (navigate, click, scroll) */
  lastActiveAt: string
}

export type BrowserTabsState = BrowserTab[]

export const $browserTabs = atom<BrowserTabsState>([])
export const $activeBrowserTabId = atom<null | string>(null)

/** New URLs that arrived while the pane was closed. Cleared when it opens. */
export const $browserUnread = atom(0)

let _nextId = 0

function nextId(): string {
  _nextId++

  return `browser-${_nextId}`
}

function now(): string {
  return new Date().toISOString()
}

function setTabs(tabs: BrowserTabsState): void {
  $browserTabs.set(tabs)
}

function badge(): void {
  if (!$browserOpen.get()) {
    $browserUnread.set($browserUnread.get() + 1)
  }
}

/** Open (or focus) a web tab. */
export function openWebTab(url: string, options: { activate?: boolean; title?: string } = {}): string {
  const { activate = true, title } = options
  const existing = $browserTabs.get().find(tab => tab.kind === 'web' && tab.url === url)

  if (existing) {
    setTabs(
      $browserTabs.get().map(tab => (tab.id === existing.id ? { ...tab, lastActiveAt: now() } : tab))
    )

    if (activate) {
      $activeBrowserTabId.set(existing.id)
    }

    return existing.id
  }

  const tab: BrowserTab = {
    createdAt: now(),
    id: nextId(),
    kind: 'web',
    lastActiveAt: now(),
    title: title || url || 'New tab',
    url
  }

  setTabs([...$browserTabs.get(), tab])

  if (activate) {
    $activeBrowserTabId.set(tab.id)
  }

  return tab.id
}

/** Open (or focus) a file tab rendered by the React previewer. */
export function openFileTab(
  path: string,
  options: { activate?: boolean; dataUrl?: string; title?: string } = {}
): string {
  const { activate = true, dataUrl, title } = options
  const existing = $browserTabs.get().find(tab => tab.kind === 'file' && tab.url === path)

  if (existing) {
    if (dataUrl && dataUrl !== existing.dataUrl) {
      setTabs($browserTabs.get().map(tab => (tab.id === existing.id ? { ...tab, dataUrl } : tab)))
    }

    if (activate) {
      $activeBrowserTabId.set(existing.id)
    }

    return existing.id
  }

  const tab: BrowserTab = {
    createdAt: now(),
    dataUrl,
    id: nextId(),
    kind: 'file',
    lastActiveAt: now(),
    title: title || path.split('/').pop() || path,
    url: path
  }

  setTabs([...$browserTabs.get(), tab])

  if (activate) {
    $activeBrowserTabId.set(tab.id)
  }

  return tab.id
}

/**
 * Background arrival (agent navigation, preview target): never steals focus and
 * never opens the pane — it only badges. Opening is the user's call.
 */
export function upsertBrowserTab(url: string, title?: string): string {
  const existing = $browserTabs.get().find(tab => tab.kind === 'web' && tab.url === url)

  if (existing) {
    setTabs(
      $browserTabs.get().map(tab =>
        tab.id === existing.id ? { ...tab, lastActiveAt: now(), title: title || tab.title } : tab
      )
    )
    badge()

    return existing.id
  }

  const tab: BrowserTab = {
    createdAt: now(),
    id: nextId(),
    kind: 'web',
    lastActiveAt: now(),
    title: title || url,
    url
  }

  setTabs([...$browserTabs.get(), tab])
  badge()

  return tab.id
}

export function activateBrowserTab(id: string): void {
  if ($browserTabs.get().some(tab => tab.id === id)) {
    $activeBrowserTabId.set(id)
  }
}

export function closeBrowserTab(id: string): void {
  const tabs = $browserTabs.get()
  const index = tabs.findIndex(tab => tab.id === id)

  if (index === -1) {
    return
  }

  const next = tabs.filter(tab => tab.id !== id)
  setTabs(next)

  if ($activeBrowserTabId.get() === id) {
    const neighbour = next[Math.min(index, next.length - 1)]
    $activeBrowserTabId.set(neighbour?.id ?? null)
  }
}

export function clearBrowserTabs(): void {
  $browserTabs.set([])
  $activeBrowserTabId.set(null)
}

export function updateBrowserTabTitle(id: string, title: string): void {
  setTabs(
    $browserTabs.get().map(tab =>
      tab.id === id ? { ...tab, lastActiveAt: now(), title: title || tab.title } : tab
    )
  )
}

export function updateBrowserTabUrl(id: string, url: string): void {
  setTabs($browserTabs.get().map(tab => (tab.id === id ? { ...tab, lastActiveAt: now(), url } : tab)))
}

export function touchBrowserTab(id: string): void {
  setTabs($browserTabs.get().map(tab => (tab.id === id ? { ...tab, lastActiveAt: now() } : tab)))
}

$browserOpen.listen(open => {
  if (open) {
    $browserUnread.set(0)
  }
})
