import { beforeEach, describe, expect, it } from 'vitest'

import { setBrowserOpen } from './browser'
import {
  $activeBrowserTabId,
  $browserTabs,
  $browserUnread,
  activateBrowserTab,
  clearBrowserTabs,
  closeBrowserTab,
  openFileTab,
  openWebTab,
  upsertBrowserTab
} from './browser-tabs'

describe('browser tabs', () => {
  beforeEach(() => {
    clearBrowserTabs()
    $browserUnread.set(0)
    setBrowserOpen(false)
  })

  it('opens web tabs and focuses the new one', () => {
    setBrowserOpen(true)
    const id = openWebTab('https://example.com')

    expect($browserTabs.get().map(tab => tab.url)).toEqual(['https://example.com'])
    expect($activeBrowserTabId.get()).toBe(id)
    expect($browserUnread.get()).toBe(0)
  })

  it('dedupes web tabs by url', () => {
    setBrowserOpen(true)
    const first = openWebTab('https://example.com')
    const second = openWebTab('https://example.com')

    expect(second).toBe(first)
    expect($browserTabs.get()).toHaveLength(1)
  })

  it('opens file tabs separately from web tabs', () => {
    setBrowserOpen(true)
    openWebTab('/same/path')
    const file = openFileTab('/same/path')

    expect($browserTabs.get()).toHaveLength(2)
    expect($browserTabs.get().find(tab => tab.id === file)?.kind).toBe('file')
  })

  it('badges background arrivals without stealing focus or opening the pane', () => {
    setBrowserOpen(false)
    const first = upsertBrowserTab('https://agent.example/one')

    expect($browserUnread.get()).toBe(1)
    expect($activeBrowserTabId.get()).toBeNull()
    expect($browserTabs.get()[0]?.id).toBe(first)
  })

  it('clears the badge when the pane opens', () => {
    setBrowserOpen(false)
    upsertBrowserTab('https://agent.example/one')
    upsertBrowserTab('https://agent.example/two')

    expect($browserUnread.get()).toBe(2)

    setBrowserOpen(true)

    expect($browserUnread.get()).toBe(0)
  })

  it('closes the active tab and focuses a neighbour', () => {
    setBrowserOpen(true)
    const a = openWebTab('https://a.example')
    const b = openWebTab('https://b.example')

    closeBrowserTab(b)

    expect($browserTabs.get().map(tab => tab.id)).toEqual([a])
    expect($activeBrowserTabId.get()).toBe(a)
  })

  it('activates an existing tab', () => {
    setBrowserOpen(true)
    const a = openWebTab('https://a.example')
    openWebTab('https://b.example')

    activateBrowserTab(a)

    expect($activeBrowserTabId.get()).toBe(a)
  })
})
