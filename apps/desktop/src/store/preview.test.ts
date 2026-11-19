import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as desktopFs from '@/lib/desktop-fs'
import { flushCoalescedPersistence } from '@/lib/storage'

import { $browserOpen, setBrowserOpen } from './browser'
import { $browserTabs, clearBrowserTabs, closeBrowserTab, openWebTab } from './browser-tabs'
import {
  $previewTabOpen,
  $previewTabUrl,
  $previewTarget,
  $sessionPreviewRegistry,
  clearSessionPreviewRegistry,
  dismissPreviewTarget,
  getSessionPreviewRecord,
  type PreviewTarget,
  setCurrentSessionPreviewTarget,
  setSessionPreviewTarget
} from './preview'
import { $activeSessionId, $selectedStoredSessionId } from './session'

vi.mock('@/lib/desktop-fs', async importOriginal => {
  const actual = await importOriginal<typeof desktopFs>()

  return { ...actual, startDesktopPreviewServer: vi.fn(async () => null) }
})

const startDesktopPreviewServer = () => desktopFs.startDesktopPreviewServer

function previewTarget(source: string): PreviewTarget {
  return {
    kind: 'file',
    label: source,
    path: source,
    previewKind: 'html',
    source,
    url: `file://${source}`
  }
}

function urlTarget(url: string): PreviewTarget {
  return { kind: 'url', label: url, source: url, url }
}

function codeTarget(path: string): PreviewTarget {
  return { kind: 'file', label: path.split('/').pop() ?? path, path, previewKind: 'text', source: path, url: `file://${path}` }
}

describe('preview store', () => {
  beforeEach(() => {
    setBrowserOpen(false)
    clearBrowserTabs()
    $previewTabUrl.set(null)
    $activeSessionId.set('session-1')
    $selectedStoredSessionId.set(null)
    window.localStorage.clear()
    clearSessionPreviewRegistry()
    vi.mocked(startDesktopPreviewServer()).mockResolvedValue(null)
  })

  afterEach(() => {
    setBrowserOpen(false)
    clearBrowserTabs()
    $previewTabUrl.set(null)
    $activeSessionId.set(null)
    $selectedStoredSessionId.set(null)
    window.localStorage.clear()
    clearSessionPreviewRegistry()
    vi.mocked(startDesktopPreviewServer()).mockReset()
  })

  it('opens a url preview as a web tab and opens the browser drawer', async () => {
    const target = urlTarget('https://example.com/report')

    setCurrentSessionPreviewTarget(target, 'explicit-link')
    await vi.waitFor(() => expect($browserTabs.get()).toHaveLength(1))

    expect($browserTabs.get()[0]?.kind).toBe('web')
    expect($browserTabs.get()[0]?.url).toBe('https://example.com/report')
    expect($previewTabUrl.get()).toBe('https://example.com/report')
    expect($browserOpen.get()).toBe(true)
    expect($previewTabOpen.get()).toBe(true)
    expect($previewTarget.get()).toEqual(target)
  })

  it('serves an html artifact from the loopback preview server in the native engine', async () => {
    vi.mocked(startDesktopPreviewServer()).mockResolvedValue({
      id: 'preview-1',
      url: 'http://127.0.0.1:41234/__preview/demo.html'
    })

    await setSessionPreviewTarget('session-1', previewTarget('/work/demo.html'), 'tool-result')

    await vi.waitFor(() => expect($browserTabs.get()).toHaveLength(1))

    expect(vi.mocked(startDesktopPreviewServer())).toHaveBeenCalledWith('/work/demo.html', 'file')
    expect($browserTabs.get()[0]?.kind).toBe('web')
    expect($browserTabs.get()[0]?.url).toContain('127.0.0.1:41234')
    expect($previewTabUrl.get()).toContain('127.0.0.1:41234')
  })

  it('falls back to a file tab when the loopback server is unavailable', async () => {
    await setSessionPreviewTarget('session-1', previewTarget('/work/demo.html'), 'tool-result')

    await vi.waitFor(() => expect($browserTabs.get()).toHaveLength(1))

    expect($browserTabs.get()[0]?.kind).toBe('file')
    expect($browserTabs.get()[0]?.url).toBe('/work/demo.html')
  })

  it('opens code files as file tabs rendered by the local previewer', async () => {
    await setSessionPreviewTarget('session-1', codeTarget('/work/notes.md'), 'file-browser')

    await vi.waitFor(() => expect($browserTabs.get()).toHaveLength(1))

    expect($browserTabs.get()[0]?.kind).toBe('file')
    expect($browserTabs.get()[0]?.title).toBe('notes.md')
    expect($previewTabUrl.get()).toBe('/work/notes.md')
  })

  it('persists registered previews and dismissal per session', async () => {
    const target = previewTarget('/work/demo.html')

    setCurrentSessionPreviewTarget(target, 'tool-result')
    await vi.waitFor(() => expect(getSessionPreviewRecord('session-1')).not.toBeNull())

    expect(getSessionPreviewRecord('session-1')?.normalized).toEqual({ ...target, renderMode: 'preview' })
    // Persistence is coalesced: flush before reading storage.
    flushCoalescedPersistence()
    expect(window.localStorage.getItem('alice.desktop.sessionPreviews.v1')).toContain('/work/demo.html')

    dismissPreviewTarget()

    expect($previewTarget.get()).toBeNull()
    expect(getSessionPreviewRecord('session-1')).toBeNull()
    expect($sessionPreviewRegistry.get()['session-1']?.[0]?.dismissedAt).toEqual(expect.any(Number))
  })

  it('closes the preview tab when the preview is dismissed', async () => {
    await setSessionPreviewTarget('session-1', codeTarget('/work/notes.md'), 'file-browser')
    await vi.waitFor(() => expect($browserTabs.get()).toHaveLength(1))

    dismissPreviewTarget()

    expect($browserTabs.get()).toHaveLength(0)
    expect($previewTabUrl.get()).toBeNull()
    expect($previewTabOpen.get()).toBe(false)
  })

  it('reports the preview as closed once its tab is closed by hand', async () => {
    await setSessionPreviewTarget('session-1', codeTarget('/work/notes.md'), 'file-browser')
    await vi.waitFor(() => expect($browserTabs.get()).toHaveLength(1))

    closeBrowserTab($browserTabs.get()[0]!.id)

    expect($previewTabOpen.get()).toBe(false)
  })

  it('replaces the session preview instead of keeping a back stack', async () => {
    await setSessionPreviewTarget('session-1', previewTarget('/work/first.html'), 'tool-result')
    await setSessionPreviewTarget('session-1', previewTarget('/work/second.html'), 'tool-result')

    expect($sessionPreviewRegistry.get()['session-1']).toHaveLength(1)
    expect(getSessionPreviewRecord('session-1')?.normalized.url).toBe('file:///work/second.html')
  })

  it('does not take over an existing web tab', async () => {
    setBrowserOpen(true)
    openWebTab('https://example.com/keep')

    await setSessionPreviewTarget('session-1', codeTarget('/work/notes.md'), 'manual')
    await vi.waitFor(() => expect($browserTabs.get()).toHaveLength(2))

    expect($browserTabs.get().map(tab => tab.url)).toEqual(['https://example.com/keep', '/work/notes.md'])
  })
})
