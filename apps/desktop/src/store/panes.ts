import { atom, computed, type ReadableAtom, type WritableAtom } from 'nanostores'

import { persistedKey } from '@/lib/persisted-keys'
import { persistCoalesced } from '@/lib/storage'

export interface PaneStateSnapshot {
  open: boolean
  widthOverride?: number
  /** Vertical size override (px) for panes that resize on the Y axis (e.g. the bottom-row terminal). */
  heightOverride?: number
}

export interface PaneRegisterDefaults {
  open: boolean
  widthOverride?: number
}

const STORAGE_KEY = persistedKey('paneStates')

function isSnapshot(value: unknown): value is PaneStateSnapshot {
  if (!value || typeof value !== 'object') {
    return false
  }

  const r = value as Record<string, unknown>

  if (typeof r.open !== 'boolean') {
    return false
  }

  const widthOk =
    r.widthOverride === undefined || (typeof r.widthOverride === 'number' && Number.isFinite(r.widthOverride))

  const heightOk =
    r.heightOverride === undefined || (typeof r.heightOverride === 'number' && Number.isFinite(r.heightOverride))

  return widthOk && heightOk
}

function load(): Record<string, PaneStateSnapshot> {
  if (typeof window === 'undefined') {
    return {}
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)

    if (raw) {
      const parsed = JSON.parse(raw) as unknown

      if (parsed && typeof parsed === 'object') {
        const out: Record<string, PaneStateSnapshot> = {}

        for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (isSnapshot(value)) {
            out[id] = { open: value.open, widthOverride: value.widthOverride, heightOverride: value.heightOverride }
          }
        }

        return out
      }
    }
  } catch {
    // Treat unparseable persisted state as missing.
  }

  return {}
}

// Persists both open state and resize width; load() validates each snapshot.
// Coalesced: a sash drag emits a state per pointermove, and a synchronous
// localStorage write in that loop is main-thread work on the drag path.
export const $paneStates = atom<Record<string, PaneStateSnapshot>>(load())


// `listen`, not `subscribe`: subscribing fires immediately and would rewrite the
// loaded state on import for no reason.
$paneStates.listen(states => persistCoalesced(STORAGE_KEY, JSON.stringify(states)))

// Cached per-pane derived atoms keep useStore subscriptions referentially stable.
function memoized<T>(
  cache: Map<string, ReadableAtom<T>>,
  id: string,
  selector: (s: PaneStateSnapshot | undefined) => T
) {
  let cached = cache.get(id)

  if (!cached) {
    cached = computed($paneStates, states => selector(states[id]))
    cache.set(id, cached)
  }

  return cached
}

const openCache = new Map<string, ReadableAtom<boolean>>()
const stateCache = new Map<string, ReadableAtom<PaneStateSnapshot | undefined>>()
const widthCache = new Map<string, ReadableAtom<number | undefined>>()
const heightCache = new Map<string, ReadableAtom<number | undefined>>()

export const $paneOpen = (id: string) => memoized(openCache, id, s => s?.open ?? false)
export const $paneState = (id: string) => memoized(stateCache, id, s => s)
export const $paneWidthOverride = (id: string) => memoized(widthCache, id, s => s?.widthOverride)
export const $paneHeightOverride = (id: string) => memoized(heightCache, id, s => s?.heightOverride)

export function ensurePaneRegistered(id: string, defaults: PaneRegisterDefaults) {
  const current = $paneStates.get()

  if (current[id] !== undefined) {
    return
  }

  $paneStates.set({ ...current, [id]: { open: defaults.open, widthOverride: defaults.widthOverride } })
}

export function setPaneOpen(id: string, open: boolean) {
  const current = $paneStates.get()
  const existing = current[id]

  if (existing?.open === open) {
    return
  }

  $paneStates.set({ ...current, [id]: { ...existing, open } })
}

/**
 * Drop a pane id from the persisted state. Used when a pane is retired: a stale
 * `{open:true}` row would otherwise keep describing a view that no longer
 * exists (and reappear if the id is ever reused).
 */
export function forgetPane(id: string) {
  const current = $paneStates.get()

  if (current[id] === undefined) {
    return
  }

  const { [id]: _removed, ...rest } = current
  $paneStates.set(rest)
}

export function togglePane(id: string) {
  const current = $paneStates.get()
  const existing = current[id]
  $paneStates.set({ ...current, [id]: { ...existing, open: !(existing?.open ?? false) } })
}

export function setPaneWidthOverride(id: string, width: number | undefined) {
  const current = $paneStates.get()
  const existing = current[id] ?? { open: false }

  if (existing.widthOverride === width) {
    return
  }

  $paneStates.set({ ...current, [id]: { ...existing, widthOverride: width } })
}

export function setPaneHeightOverride(id: string, height: number | undefined) {
  const current = $paneStates.get()
  const existing = current[id] ?? { open: false }

  if (existing.heightOverride === height) {
    return
  }

  $paneStates.set({ ...current, [id]: { ...existing, heightOverride: height } })
}

/**
 * Two-way bridge between a pane's "gate" atom and the pane store.
 *
 * Some panes (terminal, browser tabs, review) historically expressed visibility
 * only through a `disabled` prop fed by their own atom, never through
 * `$paneStates`. That left `$paneOpen(id)` lying and made `togglePane(id)` a
 * no-op for them. Binding the gate into the store gives one observable open
 * state per pane while keeping the existing atom as the public API.
 */
export function bindPaneGate(id: string, gate: WritableAtom<boolean>): void {
  // Reconcile (not "register if missing"): the pane store is persisted, so a
  // stale `open:true` from a previous run would otherwise contradict a gate that
  // is now false — and every consumer reading `$paneStates` would be wrong.
  setPaneOpen(id, gate.get())

  // gate → store
  gate.listen(open => setPaneOpen(id, open))

  // store → gate (keybinds / togglePane / future callers)
  $paneOpen(id).listen(open => {
    if (gate.get() !== open) {
      gate.set(open)
    }
  })
}

export const clearPaneWidthOverride = (id: string) => setPaneWidthOverride(id, undefined)
export const clearPaneHeightOverride = (id: string) => setPaneHeightOverride(id, undefined)
export const getPaneStateSnapshot = (id: string) => $paneStates.get()[id]
