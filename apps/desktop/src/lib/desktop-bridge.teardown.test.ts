// @vitest-environment node
//
// Regression (intermittent unhandled rejection, 1 in ~4 full-suite runs): a
// debounced git probe can fire AFTER jsdom tears the environment down. The probe
// must degrade to "no bridge", not throw `ReferenceError: window is not defined`
// from inside a timer where nothing can catch it.
import { describe, expect, it } from 'vitest'

import { desktopGit } from './desktop-git'

describe('desktop bridge without a DOM', () => {
  it('reports no git bridge instead of throwing', () => {
    expect(typeof window).toBe('undefined')
    expect(desktopGit()).toBeUndefined()
  })
})
