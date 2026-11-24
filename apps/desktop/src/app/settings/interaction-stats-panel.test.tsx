import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import {
  clearInteractionSamples,
  recordInteraction,
  setInteractionTelemetryEnabled,
  summarizeInteractionSamples
} from '@/lib/interaction-telemetry'

import { InteractionStatsPanel } from './interaction-stats-panel'

function renderPanel() {
  return render(
    <I18nProvider configClient={{ getConfig: async () => ({}), saveConfig: async () => ({ ok: true }) }}>
      <InteractionStatsPanel />
    </I18nProvider>
  )
}

describe('InteractionStatsPanel', () => {
  beforeEach(() => {
    setInteractionTelemetryEnabled(true)
    clearInteractionSamples()
  })

  afterEach(() => {
    cleanup()
    setInteractionTelemetryEnabled(true)
    clearInteractionSamples()
  })

  it('summarizes samples per interaction (p50/p95/max)', () => {
    for (const ms of [10, 20, 30, 40, 100]) {
      recordInteraction('toggle-git', ms)
    }

    const [row] = summarizeInteractionSamples([
      { at: 0, ms: 10, name: 'toggle-git', paintMs: null },
      { at: 0, ms: 100, name: 'toggle-git', paintMs: null }
    ])

    expect(row.name).toBe('toggle-git')
    expect(row.samples).toBe(2)
    expect(row.max).toBe(100)
    expect(row.p50).toBe(100)
  })

  it('renders one row per interaction with ms values', () => {
    recordInteraction('toggle-graph', 12.5)
    recordInteraction('toggle-graph', 30)

    renderPanel()

    const row = document.querySelector('[data-interaction="toggle-graph"]')

    expect(row).not.toBeNull()
    expect(row?.textContent).toContain('toggle-graph')
    expect(row?.textContent).toContain('2')
    expect(row?.textContent).toContain('30 ms')
  })

  it('clears the buffer from the panel', () => {
    recordInteraction('close-modal', 5)

    renderPanel()

    expect(document.querySelector('[data-interaction="close-modal"]')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))

    expect(document.querySelector('[data-interaction="close-modal"]')).toBeNull()
  })

  it('copies the raw samples so a Wails capture can be compared offline', () => {
    const writeText = vi.fn<(value: string) => Promise<void>>(async () => undefined)

    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })

    recordInteraction('toggle-git', 25)

    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Copy JSON' }))

    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText.mock.calls[0][0]).toContain('toggle-git')
    expect(writeText.mock.calls[0][0]).toContain('"ms":25')
  })

  it('renders nothing when telemetry is disabled (production build)', () => {
    setInteractionTelemetryEnabled(false)

    const { container } = renderPanel()

    expect(container.querySelector('[data-slot="interaction-stats"]')).toBeNull()
  })
})
