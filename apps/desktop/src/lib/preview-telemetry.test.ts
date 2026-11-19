import { beforeEach, describe, expect, it } from 'vitest'

import { clearPreviewTelemetry, previewTelemetryEvents, recordPreviewEvent } from './preview-telemetry'

describe('preview telemetry', () => {
  beforeEach(() => clearPreviewTelemetry())

  it('records bounded timing events in dev builds', () => {
    recordPreviewEvent('preview.read', { bytes: 512, ms: 12, path: '/work/a.ts' })

    const events = previewTelemetryEvents()

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ bytes: 512, event: 'preview.read', ms: 12, path: '/work/a.ts' })
    expect(typeof events[0].at).toBe('number')
  })

  it('caps the ring so a long session cannot grow memory', () => {
    for (let index = 0; index < 500; index += 1) {
      recordPreviewEvent('preview.render', { index })
    }

    const events = previewTelemetryEvents()

    expect(events).toHaveLength(200)
    expect(events.at(-1)).toMatchObject({ index: 499 })
    expect(events[0]).toMatchObject({ index: 300 })
  })

  it('returns a copy so callers cannot mutate the buffer', () => {
    recordPreviewEvent('preview.open', {})
    previewTelemetryEvents().length = 0

    expect(previewTelemetryEvents()).toHaveLength(1)
  })
})
