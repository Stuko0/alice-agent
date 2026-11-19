import { type MutableRefObject, useEffect } from 'react'

import { getSession } from '@/alice'
import { $awaitingResponse, $busy, $sessions, setAwaitingResponse, setBusy } from '@/store/session'

/**
 * Keeps the open session in sync with work that happens outside this window.
 *
 * A desktop window only receives live `message.*` / `tool.*` events for turns
 * its own backend runs. Sessions running in the messaging gateway (WhatsApp,
 * Telegram, …) live in another process and only reach this window through
 * SQLite, so before this hook the transcript looked frozen until the user
 * switched away and back (the switch re-read the persisted transcript).
 *
 * While the window is visible it polls two cheap things:
 *   1. the selected session row (`message_count`) — grow-only, so a sibling
 *      process's progress re-hydrates the transcript without a switch;
 *   2. `session.active_list` — this backend's own live status. If it reports
 *      the session idle while the UI still shows "Thinking", the terminal
 *      event was missed (e.g. the window reloaded mid-turn) and the busy flags
 *      are healed here instead of waiting for the next session switch.
 *
 * A genuinely running local turn is left alone: the WS stream owns the view,
 * and re-hydrating under it would clobber the in-flight assistant bubble.
 */

const FOLLOW_INTERVAL_MS = 2_000

interface ActiveSessionRow {
  id?: string
  session_key?: string
  status?: string
}

interface SessionFollowOptions {
  activeSessionIdRef: MutableRefObject<string | null>
  busyRef: MutableRefObject<boolean>
  hydrateFromStoredSession: (
    attempts?: number,
    storedSessionId?: string | null,
    runtimeSessionId?: string | null
  ) => Promise<void>
  /** Delta fetch (``since_id``) when the renderer already holds a cursor for
   *  this session. Falls back to the full hydrate when absent. */
  hydrateTail?: (storedSessionId: string, runtimeSessionId: null | string) => Promise<void>
  requestGateway: <T>(method: string, params?: Record<string, unknown>) => Promise<T>
  sessionStateByRuntimeIdRef: MutableRefObject<Map<string, { messages: unknown[] }>>
  selectedStoredSessionId: null | string
}

export function useSessionFollow({
  activeSessionIdRef,
  busyRef,
  hydrateFromStoredSession,
  hydrateTail,
  requestGateway,
  sessionStateByRuntimeIdRef,
  selectedStoredSessionId
}: SessionFollowOptions) {
  useEffect(() => {
    if (!selectedStoredSessionId) {
      return
    }

    let cancelled = false
    let hydrating = false

    const loadTail = async (runtimeId: null | string) => {
      if (hydrateTail) {
        await hydrateTail(selectedStoredSessionId, runtimeId)

        return
      }

      await hydrateFromStoredSession(1, selectedStoredSessionId, runtimeId)
    }

    const healStaleBusy = async (runtimeId: null | string) => {
      setBusy(false)
      setAwaitingResponse(false)
      busyRef.current = false
      // Full replace: the local view may carry a pending bubble that never
      // resolved, and appending a delta would leave it stranded.
      await hydrateFromStoredSession(1, selectedStoredSessionId, runtimeId)
    }

    const tick = async () => {
      if (cancelled || hydrating || typeof document === 'undefined' || document.visibilityState !== 'visible') {
        return
      }

      const runtimeId = activeSessionIdRef.current

      let backendRunning: boolean | null = null

      try {
        const active = await requestGateway<{ sessions?: ActiveSessionRow[] }>('session.active_list', {
          current_session_id: selectedStoredSessionId
        })

        const live = (active.sessions || []).find(
          entry => entry.session_key === selectedStoredSessionId || (runtimeId && entry.id === runtimeId)
        )

        // `active_list` only knows this backend's sessions. A session owned by
        // the gateway process won't be listed — treat that as unknown so we
        // never clear a real turn.
        backendRunning = live ? live.status !== 'idle' : null
      } catch {
        backendRunning = null
      }

      if (cancelled) {
        return
      }

      if (backendRunning === false) {
        // The backend says idle but the UI is stuck busy: a terminal event was
        // missed. Heal it and pull the persisted tail.
        if ($busy.get() || $awaitingResponse.get()) {
          hydrating = true

          try {
            await healStaleBusy(runtimeId)
          } finally {
            hydrating = false
          }

          return
        }
      } else if (backendRunning === true) {
        // Live local turn — the WS stream owns the transcript.
        return
      }

      const stored = $sessions
        .get()
        .find(s => s.id === selectedStoredSessionId || s._lineage_root_id === selectedStoredSessionId)

      const profile = stored?.profile

      let row

      try {
        row = await getSession(selectedStoredSessionId, profile)
      } catch {
        return
      }

      if (cancelled || !row) {
        return
      }

      const state = runtimeId ? sessionStateByRuntimeIdRef.current.get(runtimeId) : null
      const cachedCount = state?.messages.length ?? 0

      // Only grow, never shrink: a shorter count means a compression/rotation
      // is in progress and the full resume path owns that transition.
      if (typeof row.message_count !== 'number' || row.message_count <= cachedCount) {
        return
      }

      hydrating = true

      try {
        await loadTail(runtimeId)
      } finally {
        hydrating = false
      }
    }

    const handle = window.setInterval(() => void tick(), FOLLOW_INTERVAL_MS)

    void tick()

    return () => {
      cancelled = true
      window.clearInterval(handle)
    }
  }, [
    activeSessionIdRef,
    busyRef,
    hydrateFromStoredSession,
    hydrateTail,
    requestGateway,
    selectedStoredSessionId,
    sessionStateByRuntimeIdRef
  ])
}
