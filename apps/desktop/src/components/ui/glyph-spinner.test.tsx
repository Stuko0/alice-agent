import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GlyphSpinner } from './glyph-spinner'

const originalMatchMedia = window.matchMedia

function stubReducedMotion(matches: boolean) {
  window.matchMedia = vi.fn().mockReturnValue({
    matches,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  }) as unknown as typeof window.matchMedia
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  window.matchMedia = originalMatchMedia
  cleanup()
})

describe('GlyphSpinner reduced motion', () => {
  it('freezes on the first frame when the OS asks for reduced motion', () => {
    stubReducedMotion(true)
    const { getByRole } = render(<GlyphSpinner />)
    const first = getByRole('status').textContent

    act(() => vi.advanceTimersByTime(5_000))

    expect(getByRole('status').textContent).toBe(first)
  })

  it('animates when motion is allowed', () => {
    stubReducedMotion(false)
    const { getByRole } = render(<GlyphSpinner />)
    const first = getByRole('status').textContent

    act(() => vi.advanceTimersByTime(2_000))

    expect(getByRole('status').textContent).not.toBe(first)
  })
})
