import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { clearPreviewTextCache } from '@/lib/preview-text-cache'
import type { PreviewTarget } from '@/store/preview'

import { LocalFilePreview } from './preview-file'

vi.mock('@/lib/shiki-cache', () => ({
  clearHighlightCache: () => {},
  escapeHtml: (value: string) => value,
  highlightCacheSize: () => 0,
  highlightCode: async (code: string) => `<pre class="shiki">${code}</pre>`
}))

const textTarget: PreviewTarget = {
  kind: 'file',
  label: 'a.ts',
  language: 'typescript',
  path: '/work/a.ts',
  previewKind: 'text',
  source: '/work/a.ts',
  url: 'file:///work/a.ts'
}

function installBridge(overrides: Record<string, unknown>) {
  ;(window as unknown as { aliceDesktop?: unknown }).aliceDesktop = overrides
}

describe('LocalFilePreview resource behaviour', () => {
  beforeEach(() => clearPreviewTextCache())

  afterEach(() => {
    cleanup()
    delete (window as unknown as { aliceDesktop?: unknown }).aliceDesktop
  })

  it('does not fetch a git diff until the DIFF view is opened, then caches it', async () => {
    const readFileText = vi.fn(async () => ({
      path: '/work/a.ts',
      text: 'const answer = 42\n',
      byteSize: 18,
      language: 'typescript'
    }))

    const statFile = vi.fn(async () => ({
      path: '/work/a.ts',
      byteSize: 18,
      mtimeMs: 111,
      isDir: false,
      binary: false,
      mimeType: 'text/plain',
      language: 'typescript'
    }))

    const fileDiff = vi.fn(async () => 'diff --git a/a.ts b/a.ts\n+const answer = 42')

    installBridge({ git: { fileDiff }, gitRoot: vi.fn(async () => '/work'), readFileText, statFile })

    render(<LocalFilePreview reloadKey={0} target={textTarget} />)

    await waitFor(() => expect(readFileText).toHaveBeenCalled())
    expect(screen.getByText(/const answer = 42/)).toBeTruthy()
    expect(fileDiff).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('DIFF'))

    await waitFor(() => expect(fileDiff).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByText('SOURCE'))
    fireEvent.click(screen.getByText('DIFF'))

    await waitFor(() => expect(fileDiff).toHaveBeenCalledTimes(1))
  })

  it('renders markdown through the lazy section renderer', async () => {
    const readFileText = vi.fn(async () => ({
      path: '/work/notes.md',
      text: '# Title\n\n## First\n\nhello **world**\n\n## Second\n\nbye',
      byteSize: 48,
      language: 'markdown'
    }))

    const statFile = vi.fn(async () => ({
      path: '/work/notes.md',
      byteSize: 48,
      mtimeMs: 9,
      isDir: false,
      binary: false,
      mimeType: 'text/markdown',
      language: 'markdown'
    }))

    installBridge({ readFileText, statFile })

    render(
      <LocalFilePreview
        reloadKey={0}
        target={{
          kind: 'file',
          label: 'notes.md',
          language: 'markdown',
          path: '/work/notes.md',
          previewKind: 'text',
          source: '/work/notes.md',
          url: 'file:///work/notes.md'
        }}
      />
    )

    await waitFor(() => expect(screen.getByText('Title')).toBeTruthy())
    await waitFor(() => expect(screen.getByText(/hello/)).toBeTruthy())
    await waitFor(() => expect(screen.getByText(/bye/)).toBeTruthy())
  })

  it('reuses a cached read when the file mtime has not changed', async () => {
    const readFileText = vi.fn(async () => ({
      path: '/work/a.ts',
      text: 'const answer = 42\n',
      byteSize: 18,
      language: 'typescript'
    }))

    const statFile = vi.fn(async () => ({
      path: '/work/a.ts',
      byteSize: 18,
      mtimeMs: 4242,
      isDir: false,
      binary: false,
      mimeType: 'text/plain',
      language: 'typescript'
    }))

    installBridge({ readFileText, statFile })

    const first = render(<LocalFilePreview reloadKey={0} target={textTarget} />)

    await waitFor(() => expect(readFileText).toHaveBeenCalledTimes(1))
    first.unmount()

    render(<LocalFilePreview reloadKey={0} target={textTarget} />)

    await waitFor(() => expect(statFile).toHaveBeenCalledTimes(2))
    expect(readFileText).toHaveBeenCalledTimes(1)
  })

  it('shows the truncation banner after forcing a large text file', async () => {
    const readFileText = vi.fn(async () => ({
      path: '/work/a.ts',
      text: 'x'.repeat(512 * 1024),
      byteSize: 900 * 1024,
      language: 'typescript',
      truncated: true
    }))

    const statFile = vi.fn(async () => ({
      path: '/work/a.ts',
      byteSize: 900 * 1024,
      mtimeMs: 7,
      isDir: false,
      binary: false,
      mimeType: 'text/plain',
      language: 'typescript'
    }))

    installBridge({ readFileText, statFile })

    render(<LocalFilePreview reloadKey={0} target={{ ...textTarget, large: true }} />)

    await waitFor(() => expect(screen.getByText('Preview anyway')).toBeTruthy())

    fireEvent.click(screen.getByText('Preview anyway'))

    await waitFor(() => expect(screen.getByText('Showing first 512 KB.')).toBeTruthy())
  })

  it('refuses an oversized image without base64-ing it through the bridge', async () => {
    const readFileDataUrl = vi.fn(async () => 'data:image/png;base64,AAAA')

    const statFile = vi.fn(async () => ({
      path: '/work/pic.png',
      byteSize: 20 * 1024 * 1024,
      mtimeMs: 5,
      isDir: false,
      binary: true,
      mimeType: 'image/png'
    }))

    const openExternal = vi.fn(async () => {})

    installBridge({ openExternal, readFileDataUrl, statFile })

    render(
      <LocalFilePreview
        reloadKey={0}
        target={{
          kind: 'file',
          label: 'pic.png',
          path: '/work/pic.png',
          previewKind: 'image',
          source: '/work/pic.png',
          url: 'file:///work/pic.png'
        }}
      />
    )

    await waitFor(() => expect(screen.getByText('This image is too large')).toBeTruthy())
    expect(readFileDataUrl).not.toHaveBeenCalled()
  })

  it('streams an image from the loopback server in the Wails shell', async () => {
    ;(window as unknown as { go?: unknown }).go = { main: { PythonManager: {} } }

    const previewStartForImage = vi.fn(async () => ({
      id: 'img-1',
      url: 'http://127.0.0.1:40999/p/imgtoken/',
      path: '/work/pic.png'
    }))

    const previewStop = vi.fn(async () => true)
    const readFileDataUrl = vi.fn(async () => 'data:image/png;base64,AAAA')

    const statFile = vi.fn(async () => ({
      path: '/work/pic.png',
      byteSize: 6 * 1024 * 1024,
      mtimeMs: 6,
      isDir: false,
      binary: true,
      mimeType: 'image/png'
    }))

    installBridge({ previewStartForImage, previewStop, readFileDataUrl, statFile })

    const view = render(
      <LocalFilePreview
        reloadKey={0}
        target={{
          kind: 'file',
          label: 'pic.png',
          path: '/work/pic.png',
          previewKind: 'image',
          source: '/work/pic.png',
          url: 'file:///work/pic.png'
        }}
      />
    )

    await waitFor(() => expect(previewStartForImage).toHaveBeenCalledWith('/work/pic.png'))

    const image = view.container.querySelector('img')

    expect(image?.getAttribute('src')).toBe('http://127.0.0.1:40999/p/imgtoken/')
    expect(readFileDataUrl).not.toHaveBeenCalled()

    view.unmount()

    await waitFor(() => expect(previewStop).toHaveBeenCalledWith('img-1'))
    delete (window as unknown as { go?: unknown }).go
  })
})
