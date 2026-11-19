import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $paneStates, setPaneOpen, setPaneWidthOverride } from '@/store/panes'

import { Pane, PaneMain, PaneShell } from './pane-shell'

function gridContainer(rendered: ReturnType<typeof render>): HTMLElement {
  const root = rendered.container.firstElementChild

  if (!(root instanceof HTMLElement)) {
    throw new Error('PaneShell did not render a root element')
  }

  return root
}

function getColumnTemplate(container: HTMLElement): string[] {
  return (container.style.gridTemplateColumns ?? '').split(/\s+/).filter(Boolean)
}

function mockWidth(element: HTMLElement, width: number) {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      bottom: 0,
      height: 0,
      left: 0,
      right: width,
      top: 0,
      width,
      x: 0,
      y: 0,
      toJSON: () => ({})
    })
  })
}

describe('Pane drawers', () => {
  beforeEach(() => {
    $paneStates.set({})
    window.localStorage.clear()
  })

  afterEach(() => {
    cleanup()
    $paneStates.set({})
    window.localStorage.clear()
  })

  function drawerShell(gate: ReturnType<typeof atom<boolean>>) {
    return (
      <PaneShell>
        <Pane drawer id="drawer-one" openAtom={gate} side="right">
          drawer body
        </Pane>
        <PaneMain>main</PaneMain>
      </PaneShell>
    )
  }

  it('mounts lazily and stays mounted (hidden) after closing', () => {
    const gate = atom(false)
    const rendered = render(drawerShell(gate))

    // Never opened → never mounted: boot stays cheap.
    expect(screen.queryByText('drawer body')).toBeNull()

    act(() => gate.set(true))
    expect(screen.getByText('drawer body')).toBeTruthy()

    act(() => gate.set(false))
    const body = screen.getByText('drawer body')
    const drawer = body.closest('[hidden]')

    // Kept in the DOM (scroll/filter state survives) but out of the a11y tree.
    expect(drawer).not.toBeNull()
    expect((drawer as HTMLElement).hidden).toBe(true)

    rendered.unmount()
  })

  it('warms a drawer on idle so the first open only paints', async () => {
    vi.useFakeTimers()
    const gate = atom(false)

    render(
      <PaneShell>
        <Pane drawer id="warm" openAtom={gate} side="right" warmOnIdle>
          warm body
        </Pane>
        <PaneMain>main</PaneMain>
      </PaneShell>
    )

    expect(screen.queryByText('warm body')).toBeNull()

    await act(async () => {
      vi.advanceTimersByTime(1_500)
    })

    const body = screen.getByText('warm body')
    const drawer = body.closest('[hidden]')

    expect(drawer).not.toBeNull()
    expect((drawer as HTMLElement).hidden).toBe(true)

    vi.useRealTimers()
  })

  it('moves focus into the drawer, traps Tab, and closes on Escape', async () => {
    const gate = atom(false)
    render(
      <PaneShell>
        <Pane drawer id="focus-drawer" openAtom={gate} side="right">
          <button type="button">first action</button>
          <button type="button">second action</button>
          <button type="button">last action</button>
        </Pane>
        <PaneMain>main</PaneMain>
      </PaneShell>
    )

    act(() => gate.set(true))
    await act(async () => {
      await new Promise(resolve => requestAnimationFrame(resolve))
    })

    const first = screen.getByRole('button', { name: 'first action' })
    const last = screen.getByRole('button', { name: 'last action' })

    expect(document.activeElement).toBe(first)

    last.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    // Wraps to the drawer's first focusable (the header Close button).
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close drawer' }))

    // Shift-Tab from the drawer's first focusable (header Close) wraps to the end.
    screen.getByRole('button', { name: 'Close drawer' }).focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(gate.get()).toBe(false)
  })

  it('ignores Escape while a root overlay owns the window', () => {
    const gate = atom(true)
    const marker = document.createElement('div')
    marker.setAttribute('data-overlay-root', '')
    document.body.appendChild(marker)

    render(
      <PaneShell>
        <Pane drawer id="esc-drawer" openAtom={gate} side="right">
          drawer
        </Pane>
        <PaneMain>main</PaneMain>
      </PaneShell>
    )

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(gate.get()).toBe(true)

    marker.remove()
  })

  it('docks a pinned drawer as a column with its own header', () => {
    const gate = atom(true)

    render(
      <PaneShell>
        <Pane drawer id="pinned-one" onTogglePin={() => undefined} openAtom={gate} pinned side="right">
          pinned body
        </Pane>
        <PaneMain>main</PaneMain>
      </PaneShell>
    )

    // No floating drawer / scrim: it is a real grid column.
    expect(document.querySelector('.pane-drawer')).toBeNull()
    expect(document.querySelector('[aria-hidden="true"].z-30')).toBeNull()

    const pane = document.querySelector('[data-pane-id="pinned-one"]')

    expect(pane).not.toBeNull()
    expect((pane as HTMLElement).getAttribute('data-pane-open')).toBe('true')
    expect(screen.getByRole('button', { name: 'Unpin drawer' })).toBeTruthy()
    expect(screen.getByText('pinned body')).toBeTruthy()
  })

  it('drops the scrim the moment the drawer closes', () => {
    const gate = atom(true)
    render(drawerShell(gate))

    expect(document.querySelector('[aria-hidden="true"].z-30')).not.toBeNull()

    act(() => gate.set(false))
    expect(document.querySelector('[aria-hidden="true"].z-30')).toBeNull()
  })
})

describe('PaneShell composition', () => {
  beforeEach(() => {
    $paneStates.set({})
    window.localStorage.clear()
  })

  afterEach(() => {
    cleanup()
    $paneStates.set({})
    window.localStorage.clear()
  })

  it('builds a 2-column grid for one left pane + main', () => {
    const rendered = render(
      <PaneShell>
        <Pane id="files" side="left" width="240px">
          files
        </Pane>
        <PaneMain>main</PaneMain>
      </PaneShell>
    )

    const tracks = getColumnTemplate(gridContainer(rendered))

    expect(tracks).toEqual(['240px', 'minmax(0,1fr)'])
  })

  it('orders panes left-to-right by side, preserving source order within a side', () => {
    const rendered = render(
      <PaneShell>
        <Pane id="files" side="left" width="240px">
          files
        </Pane>
        <Pane id="sessions" side="left" width="200px">
          sessions
        </Pane>
        <PaneMain>main</PaneMain>
        <Pane id="preview" side="right" width="320px">
          preview
        </Pane>
        <Pane id="inspector" side="right" width="280px">
          inspector
        </Pane>
      </PaneShell>
    )

    const tracks = getColumnTemplate(gridContainer(rendered))

    expect(tracks).toEqual(['240px', '200px', 'minmax(0,1fr)', '320px', '280px'])
  })

  it('collapses a closed pane to 0px', () => {
    const rendered = render(
      <PaneShell>
        <Pane defaultOpen={false} id="files" side="left" width="240px">
          files
        </Pane>
        <PaneMain>main</PaneMain>
      </PaneShell>
    )

    const tracks = getColumnTemplate(gridContainer(rendered))

    expect(tracks).toEqual(['0px', 'minmax(0,1fr)'])
  })

  it('reads open state from the panes store', () => {
    setPaneOpen('files', false)

    const rendered = render(
      <PaneShell>
        <Pane id="files" side="left" width="240px">
          files
        </Pane>
        <PaneMain>main</PaneMain>
      </PaneShell>
    )

    expect(getColumnTemplate(gridContainer(rendered))).toEqual(['0px', 'minmax(0,1fr)'])
  })

  it('disabled forces the track to 0px even when the store says open', () => {
    setPaneOpen('files', true)

    const rendered = render(
      <PaneShell>
        <Pane disabled={true} id="files" side="left" width="240px">
          files
        </Pane>
        <PaneMain>main</PaneMain>
      </PaneShell>
    )

    expect(getColumnTemplate(gridContainer(rendered))).toEqual(['0px', 'minmax(0,1fr)'])
  })

  it('disabled does NOT mutate the store-persisted open state', () => {
    setPaneOpen('files', true)

    render(
      <PaneShell>
        <Pane disabled={true} id="files" side="left" width="240px">
          files
        </Pane>
        <PaneMain>main</PaneMain>
      </PaneShell>
    )

    expect($paneStates.get().files?.open).toBe(true)
  })

  it('uses widthOverride from the store when set', () => {
    setPaneOpen('files', true)
    setPaneWidthOverride('files', 320)

    const rendered = render(
      <PaneShell>
        <Pane id="files" resizable side="left" width="240px">
          files
        </Pane>
        <PaneMain>main</PaneMain>
      </PaneShell>
    )

    expect(getColumnTemplate(gridContainer(rendered))).toEqual(['320px', 'minmax(0,1fr)'])
  })

  it('preserves CSS-string widths verbatim (clamp, var, etc.)', () => {
    const rendered = render(
      <PaneShell>
        <Pane id="inspector" side="right" width="clamp(13.5rem,21vw,20rem)">
          inspector
        </Pane>
        <PaneMain>main</PaneMain>
      </PaneShell>
    )

    const template = gridContainer(rendered).style.gridTemplateColumns

    expect(template).toContain('clamp(13.5rem,21vw,20rem)')
  })

  it('coerces numeric widths to px', () => {
    const rendered = render(
      <PaneShell>
        <Pane id="files" side="left" width={224}>
          files
        </Pane>
        <PaneMain>main</PaneMain>
      </PaneShell>
    )

    expect(getColumnTemplate(gridContainer(rendered))).toEqual(['224px', 'minmax(0,1fr)'])
  })

  it('emits per-pane width as a CSS variable', () => {
    const rendered = render(
      <PaneShell>
        <Pane id="files" side="left" width="240px">
          files
        </Pane>
        <PaneMain>main</PaneMain>
      </PaneShell>
    )

    const root = gridContainer(rendered)

    expect(root.style.getPropertyValue('--pane-files-width').trim()).toBe('240px')
  })

  it('places a Pane in the correct grid column via inline style', () => {
    const rendered = render(
      <PaneShell>
        <Pane id="files" side="left" width="240px">
          <span data-testid="files-content">files</span>
        </Pane>
        <PaneMain>
          <span data-testid="main-content">main</span>
        </PaneMain>
        <Pane id="preview" side="right" width="320px">
          <span data-testid="preview-content">preview</span>
        </Pane>
      </PaneShell>
    )

    const filesCell = rendered.getByTestId('files-content').parentElement!
    const mainCell = rendered.getByTestId('main-content').parentElement!
    const previewCell = rendered.getByTestId('preview-content').parentElement!

    expect(filesCell.style.gridColumn).toBe('1 / 2')
    expect(mainCell.style.gridColumn).toBe('2 / 3')
    expect(previewCell.style.gridColumn).toBe('3 / 4')
  })

  it('marks closed panes aria-hidden', () => {
    const rendered = render(
      <PaneShell>
        <Pane defaultOpen={false} id="files" side="left" width="240px">
          <span data-testid="files-content">files</span>
        </Pane>
        <PaneMain>main</PaneMain>
      </PaneShell>
    )

    const cell = rendered.getByTestId('files-content').parentElement!

    expect(cell.getAttribute('aria-hidden')).toBe('true')
    expect(cell.getAttribute('data-pane-open')).toBe('false')
  })

  it('passes through arbitrary non-Pane children for self-placement', () => {
    const rendered = render(
      <PaneShell>
        <Pane id="files" side="left" width="240px">
          files
        </Pane>
        <PaneMain>main</PaneMain>
        <div data-testid="floating-overlay" style={{ position: 'absolute' }}>
          overlay
        </div>
      </PaneShell>
    )

    expect(rendered.getByTestId('floating-overlay')).toBeDefined()
  })

  it('shows a resize handle only when resizable', () => {
    const rendered = render(
      <PaneShell>
        <Pane id="files" side="left" width="240px">
          files
        </Pane>
        <Pane id="preview" resizable side="right" width="320px">
          preview
        </Pane>
        <PaneMain>main</PaneMain>
      </PaneShell>
    )

    expect(rendered.queryByLabelText('Resize files')).toBeNull()
    expect(rendered.getByLabelText('Resize preview')).toBeDefined()
  })

  it('dragging a left-pane separator stores a wider width override', () => {
    const rendered = render(
      <PaneShell>
        <Pane id="files" maxWidth={360} minWidth={200} resizable side="left" width="240px">
          <span data-testid="files-content">files</span>
        </Pane>
        <PaneMain>main</PaneMain>
      </PaneShell>
    )

    const paneCell = rendered.getByTestId('files-content').parentElement

    if (!(paneCell instanceof HTMLElement)) {
      throw new Error('Expected pane cell element')
    }

    mockWidth(paneCell, 240)
    const separator = rendered.getByLabelText('Resize files')

    fireEvent.pointerDown(separator, { clientX: 240, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 300 })
    fireEvent.pointerUp(window, { clientX: 300 })

    expect($paneStates.get().files?.widthOverride).toBe(300)
  })

  it('dragging a right-pane separator clamps to max width', () => {
    const rendered = render(
      <PaneShell>
        <PaneMain>main</PaneMain>
        <Pane id="preview" maxWidth={340} minWidth={220} resizable side="right" width="320px">
          <span data-testid="preview-content">preview</span>
        </Pane>
      </PaneShell>
    )

    const paneCell = rendered.getByTestId('preview-content').parentElement

    if (!(paneCell instanceof HTMLElement)) {
      throw new Error('Expected pane cell element')
    }

    mockWidth(paneCell, 320)
    const separator = rendered.getByLabelText('Resize preview')

    fireEvent.pointerDown(separator, { clientX: 900, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 760 })
    fireEvent.pointerUp(window, { clientX: 760 })

    expect($paneStates.get().preview?.widthOverride).toBe(340)
  })
})

describe('PaneShell declarative gates (Phase 1)', () => {
  beforeEach(() => {
    $paneStates.set({})
    window.localStorage.clear()
  })

  afterEach(() => {
    cleanup()
    $paneStates.set({})
    window.localStorage.clear()
  })

  const gridRows = (container: HTMLElement) => (container.style.gridTemplateRows ?? '').split(/\s+/).filter(Boolean)

  it('openAtom drives the track instead of $paneStates', () => {
    const $open = atom(false)

    const rendered = render(
      <PaneShell>
        <Pane id="review" openAtom={$open} side="right" width="300px">
          review
        </Pane>
        <PaneMain>main</PaneMain>
      </PaneShell>
    )

    expect(getColumnTemplate(gridContainer(rendered))).toEqual(['minmax(0,1fr)', '0px'])
  })

  it('follows openAtom changes without a parent re-render', async () => {
    const $open = atom(false)

    const rendered = render(
      <PaneShell>
        <Pane id="review" openAtom={$open} side="right" width="300px">
          review
        </Pane>
        <PaneMain>main</PaneMain>
      </PaneShell>
    )

    $open.set(true)

    await Promise.resolve()

    expect(getColumnTemplate(gridContainer(rendered))).toEqual(['minmax(0,1fr)', '300px'])
  })

  it('bottomRowAtom moves a pane into the bottom row', async () => {
    const $open = atom(true)
    const $row = atom(false)

    const rendered = render(
      <PaneShell>
        <Pane bottomRowAtom={$row} id="terminal" openAtom={$open} side="right" width="400px">
          terminal
        </Pane>
        <PaneMain>main</PaneMain>
      </PaneShell>
    )

    // As a column: one row, two columns.
    expect(gridRows(gridContainer(rendered))).toEqual(['minmax(0,1fr)'])

    $row.set(true)
    await Promise.resolve()

    // As a row: two grid rows, and the pane is placed on the second one.
    const rows = gridRows(gridContainer(rendered))
    const pane = rendered.container.querySelector<HTMLElement>('[data-pane-id="terminal"]')

    expect(rows).toHaveLength(2)
    expect(pane?.style.gridRow).toBe('2 / 3')
  })
})

describe('PaneShell bottomRowAtom placement', () => {
  beforeEach(() => {
    $paneStates.set({})
  })

  afterEach(() => {
    cleanup()
    $paneStates.set({})
  })

  it('keeps a row-capable pane in the column flow until its atom fires', async () => {
    const $open = atom(true)
    const $row = atom(false)

    const rendered = render(
      <PaneShell>
        <Pane bottomRowAtom={$row} id="terminal" openAtom={$open} side="right" width="400px">
          terminal
        </Pane>
        <Pane id="review" openAtom={$open} side="right" width="240px">
          review
        </Pane>
        <PaneMain>main</PaneMain>
      </PaneShell>
    )

    const root = gridContainer(rendered)

    // Column mode: both rail panes own a track, one row.
    expect(getColumnTemplate(root)).toEqual(['minmax(0,1fr)', '400px', '240px'])
    expect((root.style.gridTemplateRows ?? '').split(/\s+/).filter(Boolean)).toHaveLength(1)

    $row.set(true)
    await Promise.resolve()

    // Row mode: the terminal leaves the column flow (no phantom 400px track).
    expect(getColumnTemplate(root)).toEqual(['minmax(0,1fr)', '240px'])

    const pane = rendered.container.querySelector<HTMLElement>('[data-pane-id="terminal"]')

    expect(pane?.style.gridRow).toBe('2 / 3')
    expect(pane?.style.gridColumn).toBe('2 / -1')
  })
})

describe('PaneShell closed hover-reveal panes', () => {
  beforeEach(() => {
    $paneStates.set({})
  })

  afterEach(() => {
    cleanup()
    $paneStates.set({})
  })

  it('a closed atom-gated pane does not float over its neighbour in a wide layout', () => {
    // Regression: a closed review pane (gate=false) with hoverReveal rendered its
    // 237px overlay on top of the file browser / worktree.
    const $review = atom(false)
    const $files = atom(true)

    const rendered = render(
      <PaneShell>
        <Pane hoverReveal id="review" openAtom={$review} side="right" width="240px">
          review
        </Pane>
        <Pane id="files" openAtom={$files} side="right" width="240px">
          files
        </Pane>
        <PaneMain>main</PaneMain>
      </PaneShell>
    )

    const review = rendered.container.querySelector<HTMLElement>('[data-pane-id="review"]')

    expect(review?.getAttribute('data-pane-open')).toBe('false')
    expect(review?.hasAttribute('data-pane-hover-reveal')).toBe(false)
    // Its neighbour keeps its own column.
    expect(getColumnTemplate(gridContainer(rendered))).toEqual(['minmax(0,1fr)', '0px', '240px'])
  })

  it('keeps the hover reveal for a force-collapsed (narrow) pane', () => {
    const $review = atom(false)

    const rendered = render(
      <PaneShell>
        <Pane forceCollapsed hoverReveal id="review" openAtom={$review} side="right" width="240px">
          review
        </Pane>
        <PaneMain>main</PaneMain>
      </PaneShell>
    )

    const review = rendered.container.querySelector<HTMLElement>('[data-pane-id="review"]')

    expect(review?.getAttribute('data-pane-hover-reveal')).toBe('closed')
  })
})
