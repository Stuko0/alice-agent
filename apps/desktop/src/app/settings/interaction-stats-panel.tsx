import { useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import {
  clearInteractionSamples,
  exportInteractionSamplesJson,
  interactionSamples,
  isInteractionTelemetryEnabled,
  summarizeInteractionSamples
} from '@/lib/interaction-telemetry'

/**
 * Dev-only latency panel (P2.2). It reads the in-app telemetry buffer, so it
 * works in the real WebKit shell — the only place where p95 numbers are
 * meaningful. No Electron/CDP involved: run `wails dev`, use the app, read here.
 */
export function InteractionStatsPanel() {
  const { t } = useI18n()
  const copy = t.settings.interactionStats
  const [version, setVersion] = useState(0)

  useEffect(() => {
    if (!isInteractionTelemetryEnabled()) {
      return
    }

    const id = window.setInterval(() => setVersion(value => value + 1), 1500)

    return () => window.clearInterval(id)
  }, [])

  const rows = useMemo(
    () => summarizeInteractionSamples(interactionSamples()),
    // `version` is the refresh tick; the buffer itself is mutable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version]
  )

  if (!isInteractionTelemetryEnabled()) {
    return null
  }

  return (
    <div className="grid gap-2 rounded-lg border border-(--ui-stroke-tertiary) p-3" data-slot="interaction-stats">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-medium">{copy.title}</div>
          <p className="mt-0.5 text-[0.7rem] text-muted-foreground">{copy.description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            onClick={() => {
              void navigator.clipboard?.writeText(exportInteractionSamplesJson())
            }}
            size="xs"
            type="button"
            variant="text"
          >
            {copy.copy}
          </Button>
          <Button
            onClick={() => {
              clearInteractionSamples()
              setVersion(value => value + 1)
            }}
            size="xs"
            type="button"
            variant="text"
          >
            {copy.clear}
          </Button>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="text-[0.7rem] text-muted-foreground">{copy.empty}</p>
      ) : (
        <table className="w-full text-left font-mono text-[0.7rem]">
          <thead className="text-muted-foreground">
            <tr>
              <th className="font-normal">{copy.name}</th>
              <th className="font-normal">{copy.samples}</th>
              <th className="font-normal">{copy.p50}</th>
              <th className="font-normal">{copy.p95}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr data-interaction={row.name} key={row.name}>
                <td className="pr-2">{row.name}</td>
                <td className="pr-2 tabular-nums">{row.samples}</td>
                <td className="pr-2 tabular-nums">{row.p50} ms</td>
                <td className="tabular-nums">{row.p95} ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
