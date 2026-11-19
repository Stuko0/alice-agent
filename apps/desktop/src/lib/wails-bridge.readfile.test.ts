// @vitest-environment jsdom
//
// Regression: the Wails bridge used to treat `App.ReadFileText` as a bare
// string, but it returns a `ReadTextResult` object (path/text/byteSize/
// truncated/binary/mimeType/language). That object flowed into React as a
// child and crashed the file pane with "Minified React error #31" (it also
// broke the right-rail local preview).
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./wailsjs/go/main/App', () => ({
  GetConnectionInfo: vi.fn(async () => null),
  ReadFileDataUrl: vi.fn(async () => 'data:text/plain;base64,AAAA'),
  ReadFileText: vi.fn()
}))

import { initWailsBridge } from './wails-bridge'
import * as App from './wailsjs/go/main/App'

const readFileText = () => {
  initWailsBridge()

  return window.aliceDesktop!.readFileText
}

describe('wails bridge readFileText', () => {
  beforeEach(() => {
    Reflect.deleteProperty(window, 'aliceDesktop')
    vi.mocked(App.ReadFileText).mockReset()
  })

  it('unwraps the ReadTextResult object into a string body', async () => {
    vi.mocked(App.ReadFileText).mockResolvedValue({
      binary: false,
      byteSize: 12,
      language: 'markdown',
      mimeType: 'text/markdown',
      path: '/work/notes.md',
      text: '# hello',
      truncated: false
    } as never)

    const result = await readFileText()('/work/notes.md')

    expect(result.text).toBe('# hello')
    expect(result.byteSize).toBe(12)
    expect(result.truncated).toBe(false)
    expect(typeof result.text).toBe('string')
  })

  it('still accepts a bare string return (older shells)', async () => {
    vi.mocked(App.ReadFileText).mockResolvedValue('# legacy' as never)

    const result = await readFileText()('/work/notes.md')

    expect(result).toEqual({ path: '/work/notes.md', text: '# legacy' })
  })

  it('degrades to empty text on a read error', async () => {
    vi.mocked(App.ReadFileText).mockRejectedValue(new Error('ENOENT'))

    const result = await readFileText()('/missing.md')

    expect(result).toEqual({ path: '/missing.md', text: '' })
  })
})
