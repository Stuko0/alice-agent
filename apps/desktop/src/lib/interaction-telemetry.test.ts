import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  INTERACTION_SAMPLE_LIMIT,
  clearInteractionSamples,
  interactionSamples,
  recordInteraction,
  setInteractionTelemetryEnabled,
  startInteraction
} from './interaction-telemetry'

describe('interaction telemetry', () => {
  beforeEach(() => {
    setInteractionTelemetryEnabled(true)
    clearInteractionSamples()
  })

  afterEach(() => {
    setInteractionTelemetryEnabled(true)
    clearInteractionSamples()
  })

  it('records a completed interaction with a duration', () => {
    const stop = startInteraction('toggle-git')
    stop()

    const samples = interactionSamples()

    expect(samples).toHaveLength(1)
    expect(samples[0].name).toBe('toggle-git')
    expect(samples[0].ms).toBeGreaterThanOrEqual(0)
  })

  it('exposes the buffer on window for the latency harness', () => {
    recordInteraction('close-modal', 12.5)

    const stats = (window as unknown as { __aliceInteractionStats?: readonly { ms: number; name: string }[] })
      .__aliceInteractionStats

    expect(stats?.[0]).toMatchObject({ ms: 12.5, name: 'close-modal' })
  })

  it('is bounded — the buffer never grows past the limit', () => {
    for (let index = 0; index < INTERACTION_SAMPLE_LIMIT + 40; index += 1) {
      recordInteraction('switch-session', index)
    }

    const samples = interactionSamples()

    expect(samples).toHaveLength(INTERACTION_SAMPLE_LIMIT)
    // The newest sample survives, the oldest are dropped.
    expect(samples[samples.length - 1].ms).toBe(INTERACTION_SAMPLE_LIMIT + 39)
  })

  it('is a no-op when telemetry is disabled (production build)', () => {
    setInteractionTelemetryEnabled(false)

    startInteraction('toggle-graph')()
    recordInteraction('toggle-graph', 99)

    expect(interactionSamples()).toHaveLength(0)
  })
})
