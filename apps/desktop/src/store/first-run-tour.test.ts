import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  $firstRunTour,
  closeFirstRunTour,
  FIRST_RUN_TOUR_KEY,
  openFirstRunTour,
  replayFirstRunTour,
  setFirstRunTourStep,
  shouldAutoOpenFirstRunTour,
  TOUR_STEPS
} from './first-run-tour'

const reset = () => {
  $firstRunTour.set({ completedAt: null, open: false, skippedAt: null, step: 0 })
}

beforeEach(() => {
  reset()

  try {
    window.localStorage.removeItem(FIRST_RUN_TOUR_KEY)
  } catch {
    // jsdom always has storage; ignore if not.
  }
})

afterEach(() => {
  reset()
})

describe('first-run tour', () => {
  it('opens by itself only on a configured install that has not seen it', () => {
    expect(shouldAutoOpenFirstRunTour($firstRunTour.get(), { configured: false })).toBe(false)
    expect(shouldAutoOpenFirstRunTour($firstRunTour.get(), { configured: true })).toBe(true)

    openFirstRunTour()
    expect(shouldAutoOpenFirstRunTour($firstRunTour.get(), { configured: true })).toBe(false)
  })

  it('never reopens once finished or skipped', () => {
    closeFirstRunTour({ completed: true })
    expect(shouldAutoOpenFirstRunTour($firstRunTour.get(), { configured: true })).toBe(false)

    reset()
    closeFirstRunTour({ skipped: true })
    expect(shouldAutoOpenFirstRunTour($firstRunTour.get(), { configured: true })).toBe(false)
  })

  it('persists the decision so the next launch is quiet', () => {
    closeFirstRunTour({ completed: true })

    const stored = JSON.parse(window.localStorage.getItem(FIRST_RUN_TOUR_KEY) ?? '{}')

    expect(typeof stored.completedAt).toBe('number')
    expect(stored.completedAt).toBe($firstRunTour.get().completedAt)
  })

  it('clamps the step to the tour length', () => {
    setFirstRunTourStep(-3)
    expect($firstRunTour.get().step).toBe(0)

    setFirstRunTourStep(99)
    expect($firstRunTour.get().step).toBe(TOUR_STEPS.length - 1)
  })

  it('replays from the beginning, ignoring a previous finish', () => {
    closeFirstRunTour({ completed: true })
    setFirstRunTourStep(3)

    replayFirstRunTour()

    const state = $firstRunTour.get()
    expect(state.open).toBe(true)
    expect(state.step).toBe(0)
    expect(state.completedAt).toBeNull()
    expect(state.skippedAt).toBeNull()
  })
})
