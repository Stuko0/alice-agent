import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $browserUnread } from '@/store/browser-tabs'
import { setSidebarOpen } from '@/store/layout'

import { Spine } from './spine'

const HINT_KEY = 'alice.desktop.spine-hint.v1'

function renderSpine() {
  return render(
    <MemoryRouter>
      <Spine
        onBrowser={vi.fn()}
        onCatalog={vi.fn()}
        onFiles={vi.fn()}
        onNewSession={vi.fn()}
        onProfiles={vi.fn()}
        onReview={vi.fn()}
        onSettings={vi.fn()}
        onTerminal={vi.fn()}
      />
    </MemoryRouter>
  )
}

describe('spine', () => {
  beforeEach(() => {
    window.localStorage.clear()
    $browserUnread.set(0)
  })

  afterEach(() => {
    cleanup()
    window.localStorage.clear()
  })

  it('names the suits once and remembers that it did', () => {
    vi.useFakeTimers()
    renderSpine()

    const label = screen.getByText('Sessions')

    expect(label.className).toContain('opacity-100')

    act(() => {
      vi.advanceTimersByTime(12_000)
    })

    expect(screen.getByText('Sessions').className).toContain('opacity-0')
    expect(window.localStorage.getItem(HINT_KEY)).toBe('1')
    vi.useRealTimers()
  })

  it('hides the coach mark as soon as a drawer opens', () => {
    renderSpine()

    expect(screen.getByText('Sessions').className).toContain('opacity-100')

    act(() => {
      setSidebarOpen(true)
    })

    expect(screen.getByText('Sessions').className).toContain('opacity-0')
  })

  it('does not show the coach mark again', () => {
    window.localStorage.setItem(HINT_KEY, '1')
    renderSpine()

    expect(screen.getByText('Sessions').className).toContain('opacity-0')
  })

  it('badges the browser suit for background pages', () => {
    $browserUnread.set(3)
    renderSpine()

    expect(screen.getByLabelText('3 new browser pages')).toBeTruthy()
  })

  it('exposes the application menu on the gear', () => {
    renderSpine()

    const gear = screen.getByRole('button', { name: 'Application menu' })

    act(() => {
      fireEvent.pointerDown(gear, { button: 0, ctrlKey: false })
    })

    expect(screen.getByText('Settings')).toBeTruthy()
    expect(screen.getByText('Keyboard shortcuts')).toBeTruthy()
  })
})
