import { beforeEach, describe, expect, it } from 'vitest'

import { $reduceMotion, setReduceMotion } from './reduce-motion'

// The switch is only useful if it survives a relaunch AND actually reaches the
// stylesheet. The CSS keys off `data-reduce-motion` on <html>, so that attribute
// is the contract worth pinning.

const KEY = 'alice.desktop.reduce-motion.v1'

describe('reduce motion', () => {
  beforeEach(() => {
    window.localStorage.clear()
    setReduceMotion(false)
  })

  it('persists the choice and mirrors it onto <html>', () => {
    setReduceMotion(true)

    expect($reduceMotion.get()).toBe(true)
    expect(window.localStorage.getItem(KEY)).toBe('true')
    expect(document.documentElement.dataset.reduceMotion).toBe('true')

    setReduceMotion(false)

    expect($reduceMotion.get()).toBe(false)
    expect(window.localStorage.getItem(KEY)).toBe('false')
    expect(document.documentElement.dataset.reduceMotion).toBe('false')
  })
})
