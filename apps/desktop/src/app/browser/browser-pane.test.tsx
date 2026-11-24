import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { comboFromEvent } from '@/lib/keybinds/combo'
import {
  $browserConsole,
  $browserOpen,
  $browserState,
  EMPTY_BROWSER_STATE,
  setBrowserOpen,
  setBrowserState
} from '@/store/browser'
import {
  activateBrowserTab,
  clearBrowserTabs,
  closeBrowserTab,
  openFileTab,
  openWebTab
} from '@/store/browser-tabs'

// The rail's rich previewer is what a file tab renders now; stub it so these
// tests stay about tabs/chrome, and assert the target handed to it.
vi.mock('@/app/chat/right-rail/preview-file', () => ({
  LocalFilePreview: ({ target }: { target: { path?: string; dataUrl?: string; label: string } }) => (
    <div data-data-url={target.dataUrl ?? ''} data-path={target.path ?? ''} data-testid="file-preview">
      {target.label}
    </div>
  )
}))

import { BrowserPane, FALLBACK_AFTER_MS } from './index'

type FakeBrowser = {
  blur: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  mount: ReturnType<typeof vi.fn>
  navigate: ReturnType<typeof vi.fn>
  onConsoleError: ReturnType<typeof vi.fn>
  onShortcut: ReturnType<typeof vi.fn>
  setBounds: ReturnType<typeof vi.fn>
  setVisible: ReturnType<typeof vi.fn>
  status: ReturnType<typeof vi.fn>
  onState: ReturnType<typeof vi.fn>
}

function installBridge(overrides: Partial<FakeBrowser> = {}): FakeBrowser {
  const browser: FakeBrowser = {
    blur: vi.fn(),
    close: vi.fn(),
    mount: vi.fn().mockResolvedValue({ ...EMPTY_BROWSER_STATE, ready: false }),
    onConsoleError: vi.fn().mockReturnValue(() => {}),
    onShortcut: vi.fn().mockReturnValue(() => {}),
    navigate: vi.fn().mockResolvedValue(true),
    setBounds: vi.fn(),
    setVisible: vi.fn(),
    status: vi.fn().mockResolvedValue(null),
    onState: vi.fn().mockReturnValue(() => {}),
    ...overrides
  }

  Object.defineProperty(window, 'aliceDesktop', {
    configurable: true,
    value: { browser }
  })

  return browser
}

describe('BrowserPane', () => {
  beforeEach(() => {
    clearBrowserTabs()
    setBrowserOpen(true)
    $browserState.set(EMPTY_BROWSER_STATE)
    $browserConsole.set({ count: 0, last: null })
    vi.useFakeTimers()
    // jsdom has no layout loop; run rAF callbacks inline so the mount effect
    // (which waits one frame for the drawer to lay out) is observable.
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      callback(0)

      return 1
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
    Reflect.deleteProperty(window, 'aliceDesktop')
  })

  it('falls back to an iframe when the shell has no native browser', () => {
    render(<BrowserPane visible />)

    expect(screen.getByTitle('Browser (iframe fallback)')).toBeTruthy()
  })

  it('falls back after the mount grace period when the engine never becomes ready', async () => {
    const browser = installBridge()

    render(<BrowserPane visible />)

    await act(async () => {
      await Promise.resolve()
    })

    expect(browser.mount).toHaveBeenCalled()
    expect(screen.queryByTitle('Browser (iframe fallback)')).toBeNull()

    await act(async () => {
      vi.advanceTimersByTime(FALLBACK_AFTER_MS + 1)
    })

    expect(screen.getByTitle('Browser (iframe fallback)')).toBeTruthy()
  })

  it('surfaces console errors from the page shim', async () => {
    let onError: ((error: unknown) => void) | undefined

    installBridge({
      onConsoleError: vi.fn((callback: (error: unknown) => void) => {
        onError = callback

        return () => {}
      })
    })

    render(<BrowserPane visible />)

    await act(async () => {
      onError?.({ level: 'error', line: 12, message: 'boom', source: 'console' })
    })

    expect(screen.getByText('⚠ 1')).toBeTruthy()
    expect(screen.getByTitle('boom')).toBeTruthy()
  })

  it('navigates the shared engine when switching web tabs', async () => {
    const browser = installBridge({ mount: vi.fn().mockResolvedValue({ ...EMPTY_BROWSER_STATE, ready: true }) })
    setBrowserState({ ready: true })

    const first = openWebTab('https://a.example')
    openWebTab('https://b.example')

    render(<BrowserPane visible />)
    browser.navigate.mockClear()

    await act(async () => {
      activateBrowserTab(first)
    })

    expect(browser.navigate).toHaveBeenCalledWith('https://a.example')
  })

  it('renders file tabs with the rich previewer and hides the native view', () => {
    const browser = installBridge({ mount: vi.fn().mockResolvedValue({ ...EMPTY_BROWSER_STATE, ready: true }) })
    setBrowserState({ ready: true })
    openFileTab('/work/notes.md', { title: 'notes.md' })

    render(<BrowserPane visible />)

    expect(screen.getByTestId('file-preview').getAttribute('data-path')).toBe('/work/notes.md')
    expect(browser.setVisible).toHaveBeenCalledWith(false)
  })

  it('forwards inline image bytes to the previewer', () => {
    installBridge({ mount: vi.fn().mockResolvedValue({ ...EMPTY_BROWSER_STATE, ready: true }) })
    setBrowserState({ ready: true })
    openFileTab('/work/shot.png', { dataUrl: 'data:image/png;base64,AAAA', title: 'shot.png' })

    render(<BrowserPane visible />)

    expect(screen.getByTestId('file-preview').getAttribute('data-data-url')).toBe('data:image/png;base64,AAAA')
  })

  it('shows an empty address bar for a blank tab, not the previous page url', async () => {
    installBridge({ mount: vi.fn().mockResolvedValue({ ...EMPTY_BROWSER_STATE, ready: true }) })
    setBrowserState({ ready: true, url: 'https://example.com/' })
    openWebTab('https://example.com')
    render(<BrowserPane visible />)

    const address = screen.getByLabelText('Address') as HTMLInputElement

    expect(address.value).toBe('https://example.com/')

    await act(async () => {
      openWebTab('')
    })

    expect((screen.getByLabelText('Address') as HTMLInputElement).value).toBe('')
  })

  it('opens a local path from the address bar as a file tab', async () => {
    installBridge({ mount: vi.fn().mockResolvedValue({ ...EMPTY_BROWSER_STATE, ready: true }) })
    setBrowserState({ ready: true })

    render(<BrowserPane visible />)

    const address = screen.getByLabelText('Address')

    await act(async () => {
      fireEvent.change(address, { target: { value: '/work/notes.md' } })
      fireEvent.submit(address.closest('form') as HTMLFormElement)
    })

    expect(screen.getByTestId('file-preview').getAttribute('data-path')).toBe('/work/notes.md')
  })

  it('closes the drawer when the last tab is closed', () => {
    installBridge({ mount: vi.fn().mockResolvedValue({ ...EMPTY_BROWSER_STATE, ready: true }) })
    setBrowserState({ ready: true })
    setBrowserOpen(true)

    const only = openWebTab('https://only.example')

    render(<BrowserPane visible />)

    act(() => {
      closeBrowserTab(only)
    })

    expect($browserOpen.get()).toBe(false)
  })

  it('hides the native view while a dialog/menu/palette is on screen', async () => {
    const browser = installBridge({ mount: vi.fn().mockResolvedValue({ ...EMPTY_BROWSER_STATE, ready: true }) })
    setBrowserState({ ready: true })
    openWebTab('https://example.com')

    render(<BrowserPane visible />)

    browser.setVisible.mockClear()

    const layer = document.createElement('div')
    layer.setAttribute('data-slot', 'dialog-content')
    layer.setAttribute('data-state', 'open')

    await act(async () => {
      document.body.appendChild(layer)
      await new Promise(resolve => requestAnimationFrame(() => resolve(null)))
    })

    expect(browser.setVisible).toHaveBeenLastCalledWith(false)

    await act(async () => {
      layer.remove()
      await new Promise(resolve => requestAnimationFrame(() => resolve(null)))
      // MutationObserver delivers on a microtask; give React a beat to commit
      // the visibility flip before asserting.
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(browser.setVisible).toHaveBeenLastCalledWith(true)
  })

  it('re-dispatches native shortcuts as keydowns the app keybinds understand', () => {
    let onShortcut: ((shortcut: string) => void) | undefined

    const browser = installBridge({
      mount: vi.fn().mockResolvedValue({ ...EMPTY_BROWSER_STATE, ready: true }),
      onShortcut: vi.fn((callback: (shortcut: string) => void) => {
        onShortcut = callback

        return () => {}
      })
    })

    setBrowserState({ ready: true })
    openWebTab('https://example.com')

    render(<BrowserPane visible />)

    const combos: Array<string | null> = []
    const listener = (event: Event) => combos.push(comboFromEvent(event as KeyboardEvent))
    window.addEventListener('keydown', listener)

    try {
      act(() => {
        onShortcut?.('palette')
        onShortcut?.('escape')
      })
    } finally {
      window.removeEventListener('keydown', listener)
    }

    // mod+K is replayed as a real DOM keydown (the palette keybind consumes
    // it); Escape only hands focus back and is NOT replayed (it would close the
    // whole drawer through the pane's Escape handler).
    expect(combos).toEqual(['mod+k'])
    expect(browser.blur).toHaveBeenCalled()
  })

  it('releases the native surface on unmount', () => {
    const browser = installBridge()

    const rendered = render(<BrowserPane visible />)
    rendered.unmount()

    expect(browser.close).toHaveBeenCalled()
  })

  it('never shows the iframe once the native engine is ready', () => {
    installBridge()
    setBrowserState({ ready: true })

    render(<BrowserPane visible />)

    expect(screen.queryByTitle('Browser (iframe fallback)')).toBeNull()
  })
})
