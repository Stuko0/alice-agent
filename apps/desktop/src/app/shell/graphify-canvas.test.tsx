import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { clearGraphifyHtmlCache } from '@/lib/graphify-html-cache'
import { $currentCwd } from '@/store/session'

import { GraphifyCanvas } from './graphify-canvas'

let wails = true

vi.mock('@/lib/desktop-capabilities', () => ({
  // The component probes the loopback-server capability, never the shell name.
  desktopSupports: (capability: string) => (capability === 'previewLocalServer' ? wails : true)
}))

interface Bridge {
  previewStartForFile?: (path: string) => Promise<{ id: string; path: string; url: string } | undefined>
  previewStop?: (id: string) => Promise<boolean>
  readFileText?: (path: string) => Promise<{ path: string; text: string; truncated: boolean } | undefined>
  statFile?: (path: string) => Promise<{ byteSize: number; isDir: boolean; mtimeMs: number; path: string }>
}

function installBridge(bridge: Bridge): Bridge {
  const previous = window.aliceDesktop as unknown as Bridge | undefined

  ;(window as unknown as { aliceDesktop: Bridge }).aliceDesktop = bridge

  return previous ?? {}
}

function renderCanvas() {
  return render(
    <I18nProvider configClient={{ getConfig: async () => ({}), saveConfig: async () => ({ ok: true }) }}>
      <GraphifyCanvas onClose={() => undefined} />
    </I18nProvider>
  )
}

const STAT = { byteSize: 20_000_000, isDir: false, mtimeMs: 1234, path: '/work/repo/graphify-out/graph.html' }

describe('GraphifyCanvas (Wails)', () => {
  let previous: Bridge

  beforeEach(() => {
    clearGraphifyHtmlCache()
    wails = true
    $currentCwd.set('/work/repo')
    previous = installBridge({})
  })

  afterEach(() => {
    cleanup()
    $currentCwd.set('')
    ;(window as unknown as { aliceDesktop: Bridge }).aliceDesktop = previous
    vi.clearAllMocks()
  })

  it('serves the document from the loopback preview origin (no size cap)', async () => {
    const previewStartForFile = vi.fn(async () => ({
      id: 'preview-1',
      path: STAT.path,
      url: 'http://127.0.0.1:1234/p/token/'
    }))

    const readFileText = vi.fn()
    installBridge({ previewStartForFile, statFile: async () => STAT })

    const { container } = renderCanvas()

    const iframe = await waitFor(() => {
      const found = container.querySelector('iframe')

      expect(found).not.toBeNull()

      return found as HTMLIFrameElement
    })

    expect(previewStartForFile).toHaveBeenCalledWith(STAT.path)
    expect(iframe.getAttribute('src')).toBe('http://127.0.0.1:1234/p/token/')
    expect(iframe.getAttribute('srcdoc')).toBeNull()
    expect(readFileText).not.toHaveBeenCalled()
  })

  it('falls back to a bounded read, flags truncation, and caches by mtime+size', async () => {
    const readFileText = vi.fn(async () => ({ path: STAT.path, text: '<html>graph</html>', truncated: true }))
    installBridge({ readFileText, statFile: async () => STAT })

    const first = renderCanvas()

    await screen.findByRole('status')
    expect(readFileText).toHaveBeenCalledTimes(1)

    first.unmount()
    renderCanvas()

    await waitFor(() => expect(readFileText).toHaveBeenCalledTimes(1))
    expect(document.querySelector('iframe')?.getAttribute('srcdoc')).toBe('<html>graph</html>')
  })

  it('renders the empty state when the graph file is missing', async () => {
    // Loopback refuses (nothing to serve) → the bounded-read fallback reports a
    // missing file.
    installBridge({
      previewStartForFile: async () => {
        throw new Error('not a file')
      },
      statFile: async () => ({ ...STAT, byteSize: 0, isDir: true })
    })

    renderCanvas()

    expect(await screen.findByText(/No graph yet/)).toBeTruthy()
  })

  it('stops the preview origin when the view unmounts', async () => {
    const previewStop = vi.fn(async () => true)
    installBridge({
      previewStartForFile: async () => ({ id: 'preview-9', path: STAT.path, url: 'http://127.0.0.1:1/p/t/' }),
      previewStop,
      statFile: async () => STAT
    })

    const { unmount } = renderCanvas()

    await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull())

    unmount()

    expect(previewStop).toHaveBeenCalledWith('preview-9')
  })
})

describe('GraphifyCanvas (Electron)', () => {
  beforeEach(() => {
    clearGraphifyHtmlCache()
    wails = false
    $currentCwd.set('/work/repo')
    installBridge({})
  })

  afterEach(() => {
    cleanup()
    $currentCwd.set('')
  })

  it('keeps the native file:// iframe', () => {
    const { container } = renderCanvas()

    expect(container.querySelector('iframe')?.getAttribute('src')).toBe('file:///work/repo/graphify-out/graph.html')
  })
})
