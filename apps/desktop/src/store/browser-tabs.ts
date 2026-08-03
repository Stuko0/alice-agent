import { atom } from 'nanostores'

/**
 * A tab representing a web page that Alice is browsing or rendering.
 * Updated by the gateway event handler when browser_navigate or
 * browser_* tools are called.
 */
export interface BrowserTab {
  /** Unique id (incremental or uuid) */
  id: string
  /** Page URL */
  url: string
  /** Page title (set from browser_snapshot or meta) */
  title: string
  /** ISO timestamp of when this tab was created */
  createdAt: string
  /** ISO timestamp of last activity (navigate, click, scroll) */
  lastActiveAt: string
}

export type BrowserTabsState = BrowserTab[]

export const $browserTabs = atom<BrowserTabsState>([])

let _nextId = 0

function nextId(): string {
  _nextId++
  return `browser-${_nextId}`
}

/** Add or update a browser tab. If a tab with the same URL exists,
 *  it's updated instead of duplicated. */
export function upsertBrowserTab(url: string, title?: string): string {
  const tabs = $browserTabs.get()
  const now = new Date().toISOString()
  const existing = tabs.find(t => t.url === url)

  if (existing) {
    const updated = tabs.map(t =>
      t.id === existing.id ? { ...t, title: title || t.title, lastActiveAt: now } : t
    )
    $browserTabs.set(updated)
    return existing.id
  }

  const tab: BrowserTab = {
    id: nextId(),
    url,
    title: title || url,
    createdAt: now,
    lastActiveAt: now,
  }

  $browserTabs.set([tab, ...tabs])
  return tab.id
}

/** Remove a browser tab by id. */
export function closeBrowserTab(id: string): void {
  $browserTabs.set($browserTabs.get().filter(t => t.id !== id))
}

/** Remove all browser tabs. */
export function clearBrowserTabs(): void {
  $browserTabs.set([])
}

/** Update a tab's title from a snapshot or page event. */
export function updateBrowserTabTitle(id: string, title: string): void {
  $browserTabs.set(
    $browserTabs.get().map(t => (t.id === id ? { ...t, title, lastActiveAt: new Date().toISOString() } : t))
  )
}

/** Update last active timestamp (browser_navigate, browser_click, etc.) */
export function touchBrowserTab(id: string): void {
  $browserTabs.set(
    $browserTabs.get().map(t => (t.id === id ? { ...t, lastActiveAt: new Date().toISOString() } : t))
  )
}
