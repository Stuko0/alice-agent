// ── Persistence choke point ─────────────────────────────────────────────────
// Every persisted read/write in the app funnels through readKey/writeKey, so a
// single subscriber (telemetry, cross-window sync, an audit log) can observe all
// of it without instrumenting each call site. No listeners by default → no cost.

export interface PersistenceEvent {
  key: string
  op: 'read' | 'remove' | 'write'
  value: null | string
}

type PersistenceListener = (event: PersistenceEvent) => void

const persistenceListeners = new Set<PersistenceListener>()

/** Observe every persisted get/set (e.g. pipe into telemetry/sync). */
export function onPersistenceEvent(listener: PersistenceListener): () => void {
  persistenceListeners.add(listener)

  return () => void persistenceListeners.delete(listener)
}

function emitPersistence(event: PersistenceEvent) {
  for (const listener of persistenceListeners) {
    listener(event)
  }
}

/** Raw read. Returns null when absent or storage is unavailable. */
export function readKey(key: string): null | string {
  let value: null | string = null

  try {
    value = window.localStorage.getItem(key)
  } catch {
    // Restricted contexts (private mode, disabled storage) read as absent.
  }

  emitPersistence({ key, op: 'read', value })

  return value
}

/** Raw write. A null value removes the key. Best-effort. */
export function writeKey(key: string, value: null | string) {
  try {
    if (value === null) {
      window.localStorage.removeItem(key)
    } else {
      window.localStorage.setItem(key, value)
    }
  } catch {
    // Storage is best-effort; never let a quota/permission error break the UI.
  }

  emitPersistence({ key, op: value === null ? 'remove' : 'write', value })
}

export function storedBoolean(key: string, fallback: boolean): boolean {
  const value = readKey(key)

  return value === null ? fallback : value === 'true'
}

export function persistBoolean(key: string, value: boolean) {
  writeKey(key, String(value))
}

export function storedString(key: string): null | string {
  return readKey(key)
}

export function persistString(key: string, value: null | string) {
  writeKey(key, value)
}

export function storedStringArray(key: string): string[] {
  const value = readKey(key)

  if (!value) {
    return []
  }

  try {
    const parsed = JSON.parse(value)

    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0)
  } catch {
    return []
  }
}

export function persistStringArray(key: string, value: string[]) {
  writeKey(key, value.length === 0 ? null : JSON.stringify(value))
}

export function storedStringRecord(key: string): Record<string, string> {
  const value = readKey(key)

  if (!value) {
    return {}
  }

  try {
    const parsed = JSON.parse(value)

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }

    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    )
  } catch {
    return {}
  }
}

export function persistStringRecord(key: string, value: Record<string, string>) {
  writeKey(key, JSON.stringify(value))
}

// ── Coalesced writes ────────────────────────────────────────────────────────
// UI state changes many times per interaction: a sash drag rewrites the whole
// pane-state map on every pointermove, a toggle rewrites its key on every
// click, and `atom.subscribe()` also fired once at import so a cold start wrote
// every seed value synchronously. Buffer the latest value per key and flush it
// once — in the idle slice when available, otherwise on a short timer — plus
// flush before the page goes away so a reload never loses the last value.

const pendingCoalesced = new Map<string, null | string>()
let coalescedTimer: ReturnType<typeof setTimeout> | null = null
let coalescedListenersBound = false

/** Upper bound between a coalesced write and it reaching localStorage. */
export const COALESCED_FLUSH_MS = 200

function clearCoalescedTimer() {
  if (coalescedTimer !== null) {
    clearTimeout(coalescedTimer)
    coalescedTimer = null
  }
}

/** Flush every buffered value now (pagehide, tests, explicit sync points). */
export function flushCoalescedPersistence(): void {
  clearCoalescedTimer()

  if (pendingCoalesced.size === 0) {
    return
  }

  const entries = [...pendingCoalesced.entries()]
  pendingCoalesced.clear()

  for (const [key, value] of entries) {
    writeKey(key, value)
  }
}

/** Inspect (do not consume) a buffered value. Used by tests and diagnostics. */
export function pendingCoalescedValue(key: string): null | string | undefined {
  return pendingCoalesced.get(key)
}

function bindCoalescedFlushListeners() {
  if (coalescedListenersBound || typeof window === 'undefined') {
    return
  }

  coalescedListenersBound = true
  window.addEventListener('pagehide', flushCoalescedPersistence)
  window.addEventListener('beforeunload', flushCoalescedPersistence)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushCoalescedPersistence()
    }
  })
}

/** Persist `value` under `key`, coalescing bursts into a single write. */
export function persistCoalesced(key: string, value: null | string): void {
  bindCoalescedFlushListeners()

  pendingCoalesced.set(key, value)

  if (coalescedTimer !== null) {
    return
  }

  const idle = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => unknown })
    .requestIdleCallback

  if (typeof idle === 'function') {
    idle(() => flushCoalescedPersistence(), { timeout: COALESCED_FLUSH_MS })

    return
  }

  coalescedTimer = setTimeout(() => {
    coalescedTimer = null
    flushCoalescedPersistence()
  }, COALESCED_FLUSH_MS)
}

export function arraysEqual(left: string[], right: string[]) {
  return left.length === right.length && left.every((item, index) => item === right[index])
}

export function insertUniqueId(ids: string[], id: string, index: number) {
  const next = ids.filter(item => item !== id)
  const boundedIndex = Math.min(Math.max(index, 0), next.length)
  next.splice(boundedIndex, 0, id)

  return next
}
