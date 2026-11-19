import { beforeEach, describe, expect, it } from 'vitest'

import { flushCoalescedPersistence } from '@/lib/storage'

import { $displayScale, setDisplayScale } from './display-scale'

// The scale is applied as CSS `zoom` on <html> and persisted per install. The
// contract: a known scale round-trips, and 100% clears the inline zoom instead
// of pinning `zoom: 1` (which would still create a stacking context).

const KEY = 'alice.desktop.display-scale.v1'

describe('display scale', () => {
  beforeEach(() => {
    window.localStorage.clear()
    setDisplayScale(1)
  })

  it('applies and persists a known scale', () => {
    setDisplayScale(1.25)
    flushCoalescedPersistence()

    expect($displayScale.get()).toBe(1.25)
    expect(window.localStorage.getItem(KEY)).toBe('1.25')
    expect(document.documentElement.style.zoom).toBe('1.25')
    expect(document.documentElement.dataset.displayScale).toBe('1.25')
  })

  it('clears the inline zoom at 100%', () => {
    setDisplayScale(1.5)
    setDisplayScale(1)
    flushCoalescedPersistence()

    expect(document.documentElement.style.zoom).toBe('')
    expect(document.documentElement.dataset.displayScale).toBeUndefined()
    expect(window.localStorage.getItem(KEY)).toBe('1')
  })

  it('falls back to 100% for an unsupported value', () => {
    setDisplayScale(1.37)

    expect($displayScale.get()).toBe(1)
  })
})
