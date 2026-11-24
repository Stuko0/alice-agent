import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setTerminalTakeover } from '../store'

import { PersistentTerminal, TerminalSlot } from './persistent'

vi.mock('./workspace', () => ({
  TerminalWorkspace: () => <div data-testid="terminal-workspace" />
}))

vi.mock('./terminals', () => ({ ensureTerminal: vi.fn() }))

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []

  readonly callback: ResizeObserverCallback
  observed: Element[] = []

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    FakeResizeObserver.instances.push(this)
  }

  disconnect() {
    this.observed = []
  }

  observe(target: Element) {
    this.observed.push(target)
  }

  unobserve() {}

  trigger() {
    this.callback([], this as unknown as ResizeObserver)
  }
}

let slotRect = { height: 120, left: 20, top: 10, width: 200 }

const rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect')

function overlay(container: HTMLElement): HTMLElement {
  const found = Array.from(container.querySelectorAll<HTMLElement>('div')).find(
    node => node.style.position === 'fixed'
  )

  if (!found) {
    throw new Error('overlay not found')
  }

  return found
}

function renderTerminal() {
  return render(
    <>
      <TerminalSlot />
      <PersistentTerminal onAddSelectionToChat={() => undefined} />
    </>
  )
}

const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => resolve(null)))

describe('PersistentTerminal rect tracking', () => {
  beforeEach(() => {
    FakeResizeObserver.instances = []
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    slotRect = { height: 120, left: 20, top: 10, width: 200 }
    rectSpy.mockImplementation(
      () =>
        ({
          bottom: slotRect.top + slotRect.height,
          height: slotRect.height,
          left: slotRect.left,
          right: slotRect.left + slotRect.width,
          top: slotRect.top,
          width: slotRect.width,
          x: slotRect.left,
          y: slotRect.top,
          toJSON: () => ({})
        }) as DOMRect
    )
    setTerminalTakeover(false)
  })

  afterEach(() => {
    cleanup()
    rectSpy.mockReset()
    vi.unstubAllGlobals()
  })

  it('does not poll the slot with a perpetual rAF loop', async () => {
    // Regression: the overlay used to schedule `requestAnimationFrame` from
    // inside its own frame callback, forever. The terminal pane is always
    // mounted, so that was a layout read on every frame for the app's lifetime.
    const raf = vi.spyOn(window, 'requestAnimationFrame')

    renderTerminal()

    // Let the initial measurement settle.
    await act(async () => {
      await nextFrame()
    })

    const afterMount = raf.mock.calls.length

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 60))
    })

    expect(raf.mock.calls.length).toBe(afterMount)
    expect(afterMount).toBeLessThanOrEqual(2)

    raf.mockRestore()
  })

  it('follows the slot rect through ResizeObserver', async () => {
    const { container } = renderTerminal()

    await waitFor(() => expect(overlay(container).style.width).toBe('200px'))

    slotRect = { height: 340, left: 48, top: 96, width: 640 }

    act(() => {
      FakeResizeObserver.instances[0]?.trigger()
    })

    await act(async () => {
      await nextFrame()
    })

    const style = overlay(container).style

    expect(style.top).toBe('96px')
    expect(style.left).toBe('48px')
    expect(style.width).toBe('640px')
    expect(style.height).toBe('340px')
    expect(style.visibility).toBe('visible')
  })

  it('hides the overlay when the slot collapses to zero', async () => {
    const { container } = renderTerminal()

    await waitFor(() => expect(overlay(container).style.visibility).toBe('visible'))

    slotRect = { height: 0, left: 0, top: 0, width: 0 }

    act(() => {
      FakeResizeObserver.instances[0]?.trigger()
    })

    await act(async () => {
      await nextFrame()
    })

    const style = overlay(container).style

    expect(style.visibility).toBe('hidden')
    expect(style.pointerEvents).toBe('none')
  })

  it('keeps the workspace mounted after the first open', async () => {
    setTerminalTakeover(true)

    const { getByTestId, queryByTestId } = renderTerminal()

    await waitFor(() => expect(queryByTestId('terminal-workspace')).not.toBeNull())

    act(() => {
      setTerminalTakeover(false)
    })

    expect(getByTestId('terminal-workspace')).toBeTruthy()
  })
})
