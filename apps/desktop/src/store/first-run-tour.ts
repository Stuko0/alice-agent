import { atom } from 'nanostores'

/**
 * First-run tour: the guided pass over the settings a desktop install needs
 * (provider → model → terminal → tools → gateway).
 *
 * The onboarding picker already forces a provider, and Settings has every
 * panel — but nothing walked a fresh install through the rest, so the app
 * either dead-ended on "no provider" or dropped people into a chat with no
 * terminal backend and a stock toolset. This is the tour, persisted so it
 * shows once and can be replayed from Settings.
 */

export const FIRST_RUN_TOUR_KEY = 'alice.desktop.firstRunTour.v1'

export const TOUR_STEPS = ['provider', 'model', 'terminal', 'tools', 'gateway'] as const

export type FirstRunTourStepId = (typeof TOUR_STEPS)[number]

export interface FirstRunTourRecord {
  completedAt: null | number
  skippedAt: null | number
  step: number
}

export interface FirstRunTourState extends FirstRunTourRecord {
  open: boolean
}

const EMPTY: FirstRunTourRecord = { completedAt: null, skippedAt: null, step: 0 }

function readRecord(): FirstRunTourRecord {
  if (typeof window === 'undefined') {
    return { ...EMPTY }
  }

  try {
    const raw = window.localStorage.getItem(FIRST_RUN_TOUR_KEY)

    if (!raw) {
      return { ...EMPTY }
    }

    const parsed = JSON.parse(raw) as Partial<FirstRunTourRecord>

    return {
      completedAt: typeof parsed.completedAt === 'number' ? parsed.completedAt : null,
      skippedAt: typeof parsed.skippedAt === 'number' ? parsed.skippedAt : null,
      step: typeof parsed.step === 'number' && parsed.step >= 0 && parsed.step < TOUR_STEPS.length ? parsed.step : 0
    }
  } catch {
    return { ...EMPTY }
  }
}

function persist(state: FirstRunTourRecord): void {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.setItem(
      FIRST_RUN_TOUR_KEY,
      JSON.stringify({ completedAt: state.completedAt, skippedAt: state.skippedAt, step: state.step })
    )
  } catch {
    // Storage unavailable (private mode) — the tour degrades to per-session.
  }
}

export const $firstRunTour = atom<FirstRunTourState>({ ...readRecord(), open: false })

const patch = (update: Partial<FirstRunTourState>) => {
  const next = { ...$firstRunTour.get(), ...update }

  $firstRunTour.set(next)

  if ('completedAt' in update || 'skippedAt' in update || 'step' in update) {
    persist(next)
  }
}

/** Has the user already finished or dismissed the tour? */
export function isFirstRunTourSettled(record: FirstRunTourRecord): boolean {
  return Boolean(record.completedAt || record.skippedAt)
}

/**
 * Open the tour automatically once: it must never fight the onboarding
 * (provider first) nor reopen after the user finished or skipped it.
 */
export function shouldAutoOpenFirstRunTour(state: FirstRunTourState, opts: { configured: boolean }): boolean {
  if (state.open || !opts.configured) {
    return false
  }

  return !isFirstRunTourSettled(state)
}

export function openFirstRunTour(step = 0): void {
  patch({ open: true, step: Math.max(0, Math.min(step, TOUR_STEPS.length - 1)) })
}

export function closeFirstRunTour(opts: { completed?: boolean; skipped?: boolean } = {}): void {
  const now = Date.now()

  patch({
    open: false,
    ...(opts.completed ? { completedAt: now } : {}),
    ...(opts.skipped ? { skippedAt: now } : {})
  })
}

export function setFirstRunTourStep(step: number): void {
  patch({ step: Math.max(0, Math.min(step, TOUR_STEPS.length - 1)) })
}

/** Replay from Settings → About, ignoring the persisted settled state. */
export function replayFirstRunTour(): void {
  patch({ open: true, step: 0, completedAt: null, skippedAt: null })
}
