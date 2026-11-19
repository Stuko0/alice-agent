// Dev-only preview telemetry.
//
// The preview pane has no way to tell whether a slow open came from the file
// read, the syntax highlighter or the loopback server. In dev builds we record
// a bounded ring of timing/byte events so the profile harness and the console
// can attribute the cost. Production builds compile the body away: nothing is
// logged and nothing leaves the machine (no network, no analytics).

export interface PreviewTelemetryEvent {
  at: number
  event: string
  [key: string]: unknown
}

const MAX_EVENTS = 200

const events: PreviewTelemetryEvent[] = []

export function recordPreviewEvent(event: string, payload: Record<string, unknown> = {}): void {
  if (!import.meta.env.DEV) {
    return
  }

  events.push({ at: Date.now(), event, ...payload })

  while (events.length > MAX_EVENTS) {
    events.shift()
  }
}

export function previewTelemetryEvents(): PreviewTelemetryEvent[] {
  return [...events]
}

export function clearPreviewTelemetry(): void {
  events.length = 0
}
