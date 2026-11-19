// Dev-only interaction timing. Mirrors lib/preview-telemetry.ts: a bounded
// in-memory buffer plus a `window` handle the latency harness can read.
//
// Why: the interaction budget (P0/P1) needs numbers, not impressions. The
// renderer marks the commit (state flipped) and the next paint for the paths the
// user reported as slow, so `scripts/measure-interactions.mjs` can compare them
// with the baseline without instrumenting each component.

export interface InteractionSample {
  at: number
  /** Milliseconds from start to stop. */
  ms: number
  name: string
  /** Milliseconds from start to the next animation frame, when measured. */
  paintMs: null | number
}

const MAX_SAMPLES = 200

const samples: InteractionSample[] = []

const g = globalThis as {
  __aliceInteractionStats?: readonly InteractionSample[]
  __aliceInteractionMark?: (name: string) => void
}

// `import.meta.env.DEV` is replaced by a literal at build time, so a production
// bundle drops this module's body entirely. The override exists only so tests
// can exercise the disabled branch.
let forcedOff = false

/** Test seam: force telemetry off regardless of the build flag. */
export function setInteractionTelemetryEnabled(value: boolean): void {
  forcedOff = !value
}

const enabled = (): boolean => {
  if (forcedOff) {
    return false
  }

  try {
    // MODE, not DEV: this Vite setup reports PROD=true even under `vite dev`
    // (see main.tsx's perf-probe gate), so DEV would disable the panel in the
    // one place we need it — a `wails dev` session.
    return import.meta.env.MODE !== 'production'
  } catch {
    return false
  }
}

/** Whether the dev-only latency panel/telemetry is active in this build. */
export function isInteractionTelemetryEnabled(): boolean {
  return enabled()
}

function publish(): void {
  if (typeof window !== 'undefined') {
    g.__aliceInteractionStats = samples
  }
}

/** Start a measurement. Returns a `stop()` that records commit + paint. */
export function startInteraction(name: string): (extra?: { paint?: boolean }) => void {
  if (!enabled()) {
    return () => undefined
  }

  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()

  return (extra?: { paint?: boolean }) => {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()

    const sample: InteractionSample = {
      at: Date.now(),
      ms: Number((now - startedAt).toFixed(2)),
      name,
      paintMs: null
    }

    samples.push(sample)

    if (samples.length > MAX_SAMPLES) {
      samples.splice(0, samples.length - MAX_SAMPLES)
    }

    publish()

    if (extra?.paint && typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        sample.paintMs = Number(
          ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt).toFixed(2)
        )
        publish()
      })
    }
  }
}

/** Record a finished measurement directly (used by event-driven call sites). */
export function recordInteraction(name: string, ms: number): void {
  if (!enabled()) {
    return
  }

  samples.push({ at: Date.now(), ms: Number(ms.toFixed(2)), name, paintMs: null })

  if (samples.length > MAX_SAMPLES) {
    samples.splice(0, samples.length - MAX_SAMPLES)
  }

  publish()
}

/** Read the buffer (dev only; empty in production). */
export function interactionSamples(): readonly InteractionSample[] {
  return samples
}

export function clearInteractionSamples(): void {
  samples.length = 0
  publish()
}

/** Upper bound, exported so the invariant test does not hardcode it. */
export const INTERACTION_SAMPLE_LIMIT = MAX_SAMPLES

export interface InteractionSummary {
  max: number
  name: string
  p50: number
  p95: number
  samples: number
}

const percentile = (sorted: number[], q: number): number => {
  if (sorted.length === 0) {
    return 0
  }

  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * q))

  return Number(sorted[index].toFixed(1))
}

/** Per-interaction p50/p95/max, for the dev diagnostics panel. */
export function summarizeInteractionSamples(samples: readonly InteractionSample[]): InteractionSummary[] {
  const byName = new Map<string, number[]>()

  for (const sample of samples) {
    const list = byName.get(sample.name) ?? []
    list.push(sample.ms)
    byName.set(sample.name, list)
  }

  return [...byName.entries()]
    .map(([name, values]) => {
      const sorted = [...values].sort((a, b) => a - b)

      return {
        max: Number(sorted[sorted.length - 1].toFixed(1)),
        name,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        samples: sorted.length
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** JSON export for the latency harness (`measure-interactions.mjs --import`). */
export function exportInteractionSamplesJson(): string {
  return JSON.stringify({ samples, version: 1 })
}
