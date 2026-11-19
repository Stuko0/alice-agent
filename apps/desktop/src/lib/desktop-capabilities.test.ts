import { afterEach, describe, expect, it } from 'vitest'

import { desktopSupports, isWailsShell } from './desktop-capabilities'

describe('desktop capabilities', () => {
  afterEach(() => {
    delete (window as unknown as { go?: unknown }).go
  })

  it('reports the Electron shell as supporting every capability', () => {
    expect(isWailsShell()).toBe(false)

    for (const capability of ['previewConsole', 'previewDevTools', 'previewLocalServer'] as const) {
      expect(desktopSupports(capability)).toBe(true)
    }
  })

  it('reports the Wails shell preview limits', () => {
    ;(window as unknown as { go?: unknown }).go = { main: { PythonManager: {} } }

    expect(isWailsShell()).toBe(true)
    expect(desktopSupports('previewLocalServer')).toBe(true)
    expect(desktopSupports('previewConsole')).toBe(false)
    expect(desktopSupports('previewDevTools')).toBe(false)
  })
})
